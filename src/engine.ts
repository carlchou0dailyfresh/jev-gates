import { performance } from 'node:perf_hooks';
import { canonical, digest, jsonCopy, pointer } from './json.js';
import { logic, applyPolicy } from './logic.js';
import { validateCircuit, dependencies } from './validation.js';
import { validateResponse } from './providers/index.js';
import { ProviderFailure } from './providers/http.js';
import type { RunEvent, RequestRecord } from './workbench-types.js';
import type { Circuit, GateNode, Json, Provider, ProviderResponse, Question, RuleNode, RunResult, SemanticNode, Signal } from './types.js';

export interface RunOptions {
  provider?: Provider; maxCalls?: number; timeoutMs?: number; signal?: AbortSignal;
  maxNodes?: number; maxTimeMs?: number; maxTokens?: number; maxCostUsd?: number;
  onEvent?: (event: RunEvent) => void;
  onRequest?: (request: Omit<RequestRecord, 'index' | 'provenance'>) => void;
}
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

class EvaluationStopped extends Error { constructor(readonly reason: 'aborted' | 'timeout') { super(reason); } }

/** Enforces a deadline even when a third-party Provider ignores AbortSignal. */
async function boundedCall(provider: Provider, state: Json, questions: Record<string, Question>, timeoutMs: number, signal?: AbortSignal, onTransport?: (capture: { request: Json; response: Json }) => void): Promise<ProviderResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    const stop = (reason: 'aborted' | 'timeout') => { controller.abort(); reject(new EvaluationStopped(reason)); };
    onAbort = () => stop('aborted');
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => stop('timeout'), Math.ceil(timeoutMs));
  });
  try {
    if (controller.signal.aborted) return await stopped;
    return await Promise.race([provider.evaluate(state, questions, { signal: controller.signal, ...(onTransport ? { onTransport } : {}) }), stopped]);
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
  const maxNodes = options.maxNodes ?? 256, maxTimeMs = options.maxTimeMs ?? 120_000;
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 0 || maxNodes > 256) throw new Error('maxNodes must be in [0, 256]');
  if (!Number.isFinite(maxTimeMs) || maxTimeMs <= 0 || maxTimeMs > 3_600_000) throw new Error('maxTimeMs must be in (0, 3600000]');
  if (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 0)) throw new Error('maxTokens must be a nonnegative integer');
  if (options.maxCostUsd !== undefined && (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd < 0)) throw new Error('maxCostUsd must be nonnegative');
  const runStarted = performance.now(); let evaluatedNodes = 0, usedTokens = 0, unknownTokens = false, sequence = 0, runTimedOut = false;
  // Observers are not part of provider semantics and cannot turn a successful call into an error.
  const emit = (event: Omit<RunEvent, 'sequence' | 'at'>) => { const copy = jsonCopy({ ...event, sequence: sequence++, at: new Date().toISOString() }); try { options.onEvent?.(copy); } catch { /* An observer cannot mutate/interrupt execution. */ } };
  const captureRequest = (request: Omit<RequestRecord, 'index' | 'provenance'>) => { try { options.onRequest?.(jsonCopy(request)); } catch { /* Transport observers cannot alter provider status. */ } };
  emit({ type: 'run_started' });
  const stopReason = (): string | undefined => options.signal?.aborted ? 'aborted'
    : runTimedOut || performance.now() - runStarted >= maxTimeMs ? 'time_budget_exhausted'
    : evaluatedNodes >= maxNodes ? 'node_budget_exhausted' : undefined;
  const callStopReason = (): string | undefined => stopReason()
    ?? (result.calls.length >= maxCalls ? 'call_budget_exhausted'
      : options.maxTokens !== undefined && (usedTokens >= options.maxTokens || unknownTokens) ? (unknownTokens ? 'token_usage_unknown' : 'token_budget_exhausted')
      : options.maxCostUsd !== undefined && (options.maxCostUsd === 0 || result.calls.length > 0) ? (options.maxCostUsd === 0 ? 'cost_budget_exhausted' : 'cost_usage_unknown') : undefined);
  const signals: Record<string, Signal> = Object.create(null);
  const result: RunResult = { circuit: circuit.name, circuitDigest: digest(circuit), inputDigest: digest(input), status: 'evaluated', signals, outputs: Object.create(null), nodes: [], calls: [] };
  const pending = new Map(circuit.nodes.map(node => [node.id, node]));
  function record(node: GateNode, signal: Signal, elapsedMs: number, requestDigest?: string) {
    if (!['aborted', 'time_budget_exhausted', 'node_budget_exhausted'].includes(signal.reason)) evaluatedNodes++;
    signals[node.id] = signal; pending.delete(node.id);
    result.nodes.push({ id: node.id, kind: node.kind, signal, elapsedMs, ...(requestDigest ? { requestDigest } : {}) });
    emit({ type: 'node_completed', nodeId: node.id, signal, ...(requestDigest ? { requestDigest } : {}) });
  }
  while (pending.size) {
    const ready = [...pending.values()].filter(node => dependencies(node).every(id => Object.hasOwn(signals, id)));
    if (!ready.length) throw new Error('Circuit cannot make progress');
    const groups = new Map<string, { state: Json; nodes: SemanticNode[] }>();
    for (const node of ready) {
      const start = performance.now();
      const stopped = stopReason();
      if (stopped) { record(node, unknown(stopped), 0); continue; }
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
      for (const originalNodes of batches) {
        const available = Math.max(0, maxNodes - evaluatedNodes);
        const nodes = originalNodes.slice(0, available);
        const skipped = originalNodes.slice(available);
        if (!nodes.length) { for (const node of skipped) record(node, unknown(stopReason() ?? 'node_budget_exhausted'), 0); continue; }
        const stopped = callStopReason();
        if (!options.provider || stopped) {
          const reason = stopped ?? 'provider_missing';
          for (const node of nodes) record(node, unknown(reason), 0);
          for (const node of skipped) record(node, unknown(stopReason() ?? 'node_budget_exhausted'), 0);
          continue;
        }
        const provider = options.provider;
        const questions = Object.fromEntries(nodes.map(node => [node.id, node.question]));
        const requestDigest = digest({ provider: provider.name, model: provider.model, state: group.state, questions });
        const started = performance.now();
        emit({ type: 'provider_started', requestDigest, detail: { provider: provider.name, requestedModel: provider.model, questionIds: nodes.map(n => n.id) } });
        let rawResponse: ProviderResponse | undefined;
        let transport: { request: Json; response: Json } | undefined;
        const remainingMs = Math.max(1, maxTimeMs - (performance.now() - runStarted));
        try {
          rawResponse = await boundedCall(provider, jsonCopy(group.state), jsonCopy(questions), Math.min(timeoutMs, remainingMs), options.signal, capture => { transport = jsonCopy(capture); });
          const response = validateResponse(rawResponse, questions);
          const elapsedMs = performance.now() - started;
          result.calls.push({ provider: provider.name, requestedModel: provider.model, model: response.model, ...(response.upstreamModel ? { upstreamModel: response.upstreamModel } : {}), questionIds: nodes.map(n => n.id), requestDigest, elapsedMs, status: 'ok', ...(response.usage ? { usage: response.usage } : {}) });
          if (response.usage) usedTokens += response.usage.input_tokens + response.usage.output_tokens; else unknownTokens = true;
          captureRequest({ provider: provider.name, requestedModel: provider.model, state: jsonCopy(group.state), questions: jsonCopy(questions), requestDigest, status: 'ok', response: jsonCopy(response), rawResponse: jsonCopy(rawResponse) as unknown as Json, ...(transport ? { transport } : {}), elapsedMs });
          emit({ type: 'provider_completed', requestDigest, detail: { model: response.model, ...(response.upstreamModel ? { upstreamModel: response.upstreamModel } : {}) } });
          for (const node of nodes) record(node, applyPolicy(response.answers[node.id]!, node.policy), elapsedMs, requestDigest);
        } catch (error) {
          if (error instanceof EvaluationStopped && error.reason === 'timeout' && remainingMs <= timeoutMs) runTimedOut = true;
          const elapsedMs = performance.now() - started;
          const safeError = error instanceof ProviderFailure ? error.message : error instanceof EvaluationStopped ? error.reason === 'aborted' ? 'Provider request aborted' : runTimedOut ? 'Run time budget exhausted' : 'Provider request timed out' : rawResponse !== undefined ? 'Invalid provider response' : 'Provider failed, timed out, was aborted, or returned an invalid response';
          result.calls.push({ provider: provider.name, requestedModel: provider.model, questionIds: nodes.map(n => n.id), requestDigest, elapsedMs, status: 'error', error: safeError });
          unknownTokens = true;
          let raw: Json | undefined;
          try { if (rawResponse !== undefined) raw = jsonCopy(rawResponse) as unknown as Json; } catch { /* Non-JSON provider output cannot enter an artifact. */ }
          captureRequest({ provider: provider.name, requestedModel: provider.model, state: jsonCopy(group.state), questions: jsonCopy(questions), requestDigest, status: 'error', error: safeError, ...(raw !== undefined ? { rawResponse: raw } : {}), ...(transport ? { transport } : {}), elapsedMs });
          emit({ type: 'provider_failed', requestDigest, detail: { failureKind: error instanceof EvaluationStopped ? error.reason === 'aborted' ? 'aborted' : runTimedOut ? 'run_timeout' : 'gate_timeout' : error instanceof ProviderFailure ? error.code : rawResponse !== undefined ? 'invalid_response' : 'provider_error', ...(error instanceof ProviderFailure && error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}) } });
          const failureReason = options.signal?.aborted ? 'aborted' : runTimedOut || performance.now() - runStarted >= maxTimeMs ? 'time_budget_exhausted' : 'provider_error';
          for (const node of nodes) record(node, unknown(failureReason), elapsedMs, requestDigest);
        }
        for (const node of skipped) record(node, unknown(stopReason() ?? 'node_budget_exhausted'), 0);
      }
    }
  }
  for (const id of circuit.outputs) result.outputs[id] = signals[id]!;
  if (Object.values(result.outputs).some(signal => signal.truth === 'UNKNOWN')) result.status = 'abstained';
  emit({ type: 'run_completed', detail: { elapsedMs: performance.now() - runStarted, evaluatedNodes } });
  return result;
}
