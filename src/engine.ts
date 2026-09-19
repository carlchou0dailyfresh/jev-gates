import { performance } from 'node:perf_hooks';
import { canonical, digest, jsonCopy, pointer } from './json.js';
import { logic, applyPolicy } from './logic.js';
import { validateCircuit, dependencies } from './validation.js';
import { validateResponse } from './providers/index.js';
import type { Circuit, GateNode, Json, Provider, ProviderResponse, Question, RuleNode, RunResult, SemanticNode, Signal } from './types.js';

export interface RunOptions { provider?: Provider; maxCalls?: number; timeoutMs?: number; signal?: AbortSignal }
const unknown = (reason: string): Signal => ({ truth: 'UNKNOWN', reason });

function exact(node: RuleNode, input: Json): Signal {
  const selected = pointer(input, node.path);
  if (node.op === 'exists') return { truth: selected.found ? 'TRUE' : 'FALSE', reason: 'exact_rule' };
  if (!selected.found) return unknown('missing_input');
  let result: boolean;
  if (node.op === 'eq' || node.op === 'neq') {
    result = canonical(selected.value) === canonical(node.value);
    if (node.op === 'neq') result = !result;
  } else {
    if (typeof selected.value !== 'number') return unknown('numeric_type_mismatch');
    const rhs = node.value as number;
    result = node.op === 'gt' ? selected.value > rhs : node.op === 'gte' ? selected.value >= rhs : node.op === 'lt' ? selected.value < rhs : selected.value <= rhs;
  }
  return { truth: result ? 'TRUE' : 'FALSE', reason: 'exact_rule' };
}

/** Enforces a deadline even when a third-party Provider ignores AbortSignal. */
async function boundedCall(provider: Provider, state: Json, questions: Record<string, Question>, timeoutMs: number, signal?: AbortSignal): Promise<ProviderResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    const stop = () => { controller.abort(); reject(new Error('Evaluation stopped')); };
    onAbort = stop;
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
    timer = setTimeout(stop, timeoutMs);
  });
  try {
    if (controller.signal.aborted) return await stopped;
    return await Promise.race([provider.evaluate(state, questions, { signal: controller.signal }), stopped]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

/** Evaluates one immutable input snapshot; results are never cached across runs. */
export async function runCircuit(raw: Circuit | unknown, originalInput: Json, options: RunOptions = {}): Promise<RunResult> {
  const circuit = validateCircuit(raw), input = jsonCopy(originalInput);
  const maxCalls = options.maxCalls ?? 16, timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(maxCalls) || maxCalls < 0 || maxCalls > 1024) throw new Error('maxCalls must be an integer in [0, 1024]');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) throw new Error('timeoutMs must be in (0, 300000]');
  const signals: Record<string, Signal> = Object.create(null);
  const result: RunResult = { circuit: circuit.name, circuitDigest: digest(circuit), inputDigest: digest(input), status: 'evaluated', signals, outputs: Object.create(null), nodes: [], calls: [] };
  const pending = new Map(circuit.nodes.map(node => [node.id, node]));
  function record(node: GateNode, signal: Signal, elapsedMs: number, requestDigest?: string) {
    signals[node.id] = signal; pending.delete(node.id);
    result.nodes.push({ id: node.id, kind: node.kind, signal, elapsedMs, ...(requestDigest ? { requestDigest } : {}) });
  }
  while (pending.size) {
    const ready = [...pending.values()].filter(node => dependencies(node).every(id => Object.hasOwn(signals, id)));
    if (!ready.length) throw new Error('Circuit cannot make progress');
    const groups = new Map<string, { state: Json; nodes: SemanticNode[] }>();
    for (const node of ready) {
      const start = performance.now();
      if (options.signal?.aborted) { record(node, unknown('aborted'), 0); continue; }
      if (node.kind === 'constant') record(node, { truth: node.value, reason: 'constant' }, 0);
      else if (node.kind === 'rule') record(node, exact(node, input), performance.now() - start);
      else if (node.kind === 'logic') record(node, { truth: logic(node.op, node.inputs.map(id => signals[id]!.truth), node.k), reason: 'logic_' + node.op }, performance.now() - start);
      else {
        if (node.when && signals[node.when]!.truth !== 'TRUE') { record(node, unknown(signals[node.when]!.truth === 'FALSE' ? 'condition_false' : 'condition_unknown'), 0); continue; }
        if (node.context?.some(id => signals[id]!.truth === 'UNKNOWN')) { record(node, unknown('context_unknown'), 0); continue; }
        const selected = pointer(input, node.input ?? '');
        if (!selected.found) { record(node, unknown('missing_input'), 0); continue; }
        const state: Json = node.context?.length
          ? { observation: selected.value!, signals: Object.fromEntries(node.context.map(id => [id, jsonCopy(signals[id]!)])) as unknown as Json }
          : selected.value!;
        const key = canonical(state);
        if (!groups.has(key)) groups.set(key, { state, nodes: [] });
        groups.get(key)!.nodes.push(node);
      }
    }
    for (const group of groups.values()) {
      const batches: SemanticNode[][] = []; let batch: SemanticNode[] = [], outcomes = 0;
      for (const node of group.nodes) {
        const count = node.question.type === 'noul' ? 2 : Object.keys(node.question.criteria).length;
        if (batch.length && (batch.length >= 16 || outcomes + count > 128)) { batches.push(batch); batch = []; outcomes = 0; }
        batch.push(node); outcomes += count;
      }
      if (batch.length) batches.push(batch);
      for (const nodes of batches) {
        if (!options.provider || result.calls.length >= maxCalls || options.signal?.aborted) {
          const reason = options.signal?.aborted ? 'aborted' : !options.provider ? 'provider_missing' : 'call_budget_exhausted';
          for (const node of nodes) record(node, unknown(reason), 0);
          continue;
        }
        const provider = options.provider;
        const questions = Object.fromEntries(nodes.map(node => [node.id, node.question]));
        const requestDigest = digest({ provider: provider.name, model: provider.model, state: group.state, questions });
        const started = performance.now();
        try {
          const rawResponse = await boundedCall(provider, jsonCopy(group.state), jsonCopy(questions), timeoutMs, options.signal);
          const response = validateResponse(rawResponse, questions);
          const elapsedMs = performance.now() - started;
          result.calls.push({ provider: provider.name, requestedModel: provider.model, model: response.model, ...(response.upstreamModel ? { upstreamModel: response.upstreamModel } : {}), questionIds: nodes.map(n => n.id), requestDigest, elapsedMs, status: 'ok', ...(response.usage ? { usage: response.usage } : {}) });
          for (const node of nodes) record(node, applyPolicy(response.answers[node.id]!, node.policy), elapsedMs, requestDigest);
        } catch {
          const elapsedMs = performance.now() - started;
          result.calls.push({ provider: provider.name, requestedModel: provider.model, questionIds: nodes.map(n => n.id), requestDigest, elapsedMs, status: 'error', error: 'Provider failed, timed out, was aborted, or returned an invalid response' });
          for (const node of nodes) record(node, unknown(options.signal?.aborted ? 'aborted' : 'provider_error'), elapsedMs, requestDigest);
        }
      }
    }
  }
  for (const id of circuit.outputs) result.outputs[id] = signals[id]!;
  if (Object.values(result.outputs).some(signal => signal.truth === 'UNKNOWN')) result.status = 'abstained';
  return result;
}
