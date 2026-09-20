import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { canonical, digest, jsonCopy, pointer } from './json.js';
import { runCircuit } from './engine.js';
import { applyPolicy, logic } from './logic.js';
import { validateCircuit, dependencies } from './validation.js';
import { validateResponse } from './providers/index.js';
import type { Circuit, Json, Provider, RunResult, Signal } from './types.js';
import type { ActionRecord, Assessment, DecisionSignal, EvidenceRecord, GateSpec, RequestRecord, RunArtifact, RunBudgetLimits, RunEvent, RunMode } from './workbench-types.js';

const SHA = /^[a-f0-9]{64}$/;
const modes = ['fixture', 'recorded-live', 'live-localjev', 'live-typesafe'];
const stopReasons = ['aborted', 'time_budget_exhausted', 'node_budget_exhausted', 'call_budget_exhausted', 'token_budget_exhausted', 'cost_budget_exhausted', 'token_usage_unknown', 'cost_usage_unknown'];
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function object(value: unknown): asserts value is Record<string, any> { assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected object'); }
function fields(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  assert(required.every(k => Object.hasOwn(value, k)), 'Missing required field');
  assert(Object.keys(value).every(k => [...required, ...optional].includes(k)), 'Unexpected field');
}
function text(v: unknown): v is string { return typeof v === 'string' && v.trim().length > 0; }
function strings(v: unknown): v is string[] { return Array.isArray(v) && v.every(text) && new Set(v).size === v.length; }
function date(v: unknown): v is string { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 19) === v.slice(0, 19); }
function nonnegative(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v) && v >= 0; }
function same(a: unknown, b: unknown, message: string): void { assert(canonical(a) === canonical(b), message); }

export function validateEvidenceRecord(raw: unknown): EvidenceRecord {
  canonical(raw); object(raw);
  fields(raw, ['schemaVersion', 'evidenceId', 'sourceId', 'kind', 'locator', 'retrievedAt', 'content', 'contentDigest', 'citations', 'scope', 'freshness']);
  assert(raw.schemaVersion === '1.0' && text(raw.evidenceId) && text(raw.sourceId) && text(raw.locator), 'Invalid evidence identity');
  assert(['synthetic', 'public-source', 'user-provided'].includes(raw.kind) && date(raw.retrievedAt), 'Invalid evidence provenance');
  assert(typeof raw.content === 'string' && raw.contentDigest === digest(raw.content), 'Evidence content digest mismatch');
  assert(Array.isArray(raw.citations), 'Evidence citations required');
  for (const citation of raw.citations) {
    object(citation); fields(citation, ['start', 'end', 'quote']);
    assert(Number.isSafeInteger(citation.start) && Number.isSafeInteger(citation.end) && citation.start >= 0 && citation.end > citation.start && citation.end <= raw.content.length, 'Invalid citation offsets');
    assert(typeof citation.quote === 'string' && raw.content.slice(citation.start, citation.end) === citation.quote, 'Citation does not locate original text');
  }
  object(raw.scope); fields(raw.scope, [], ['task', 'subject', 'conditions', 'metrics']);
  for (const key of ['task', 'subject']) if (raw.scope[key] !== undefined) assert(text(raw.scope[key]), 'Invalid scope');
  for (const key of ['conditions', 'metrics']) if (raw.scope[key] !== undefined) assert(strings(raw.scope[key]), 'Invalid scope list');
  object(raw.freshness); fields(raw.freshness, [], ['observedAt', 'validUntil', 'version']);
  for (const key of ['observedAt', 'validUntil']) if (raw.freshness[key] !== undefined) assert(date(raw.freshness[key]), 'Invalid freshness date');
  if (raw.freshness.version !== undefined) assert(text(raw.freshness.version), 'Invalid source version');
  return jsonCopy(raw) as EvidenceRecord;
}
export function validateGateSpec(raw: unknown): GateSpec {
  canonical(raw); object(raw);
  fields(raw, ['schemaVersion', 'gateId', 'version', 'question', 'inputSchema', 'evidenceIds', 'outputType', 'unknownConditions', 'policy', 'calibrationVersion', 'examples', 'counterexamples']);
  assert(raw.schemaVersion === '1.0' && text(raw.gateId) && text(raw.version) && text(raw.question), 'Invalid gate identity');
  assert(strings(raw.evidenceIds) && strings(raw.unknownConditions) && ['truth', 'support', 'choice', 'score'].includes(raw.outputType), 'Invalid gate contract');
  assert(raw.calibrationVersion === null || text(raw.calibrationVersion), 'Invalid calibration version');
  object(raw.inputSchema); object(raw.policy); assert(Array.isArray(raw.examples) && Array.isArray(raw.counterexamples), 'Gate examples required');
  return jsonCopy(raw) as GateSpec;
}

export function validateDecisionSignal(raw: unknown): DecisionSignal {
  canonical(raw); object(raw);
  fields(raw, ['schemaVersion', 'truth', 'reasonCode', 'inputDigest', 'policyDigest', 'provider', 'model', 'evidenceIds', 'provenance'], ['upstreamModel', 'answer']);
  assert(raw.schemaVersion === '1.0' && ['TRUE', 'FALSE', 'UNKNOWN'].includes(raw.truth) && text(raw.reasonCode), 'Invalid decision truth/reason');
  assert(SHA.test(raw.inputDigest) && SHA.test(raw.policyDigest) && text(raw.provider) && (raw.model === null || text(raw.model)), 'Invalid decision linkage');
  assert(strings(raw.evidenceIds) && [...modes, 'deterministic'].includes(raw.provenance), 'Invalid decision provenance');
  if (raw.upstreamModel !== undefined) assert(text(raw.upstreamModel), 'Invalid upstream model');
  if (raw.answer !== undefined) { object(raw.answer); assert(['noul', 'choice', 'score'].includes(raw.answer.type), 'Invalid raw answer type'); }
  return jsonCopy(raw) as DecisionSignal;
}

export function validateAssessment(raw: unknown): Assessment {
  canonical(raw); object(raw);
  fields(raw, ['schemaVersion', 'status', 'labelsVersion', 'splitVersion', 'applicableData', 'metrics', 'sampleCount', 'independentReview', 'notes']);
  assert(raw.schemaVersion === '1.0' && ['passed', 'failed', 'not_evaluated'].includes(raw.status), 'Invalid assessment status');
  assert((raw.labelsVersion === null || text(raw.labelsVersion)) && (raw.splitVersion === null || text(raw.splitVersion)), 'Invalid assessment versions');
  assert(strings(raw.applicableData) && strings(raw.notes) && Number.isSafeInteger(raw.sampleCount) && raw.sampleCount >= 0 && typeof raw.independentReview === 'boolean', 'Invalid assessment data');
  object(raw.metrics); assert(Object.values(raw.metrics).every(v => v === null || (typeof v === 'number' && Number.isFinite(v))), 'Invalid metrics');
  if (raw.status !== 'not_evaluated') assert(text(raw.labelsVersion) && text(raw.splitVersion) && raw.sampleCount > 0, 'Assessment requires labels, split and samples');
  return jsonCopy(raw) as Assessment;
}
export function validateActionRecord(raw: unknown): ActionRecord {
  canonical(raw); object(raw);
  fields(raw, ['schemaVersion', 'operationId', 'target', 'parametersDigest', 'policyDigest', 'status', 'toolKind'], ['receipt', 'queryResult', 'verification', 'executionCount']);
  assert(raw.schemaVersion === '1.0' && text(raw.operationId) && text(raw.target) && SHA.test(raw.parametersDigest) && SHA.test(raw.policyDigest), 'Invalid action identity');
  assert(['pending', 'executed', 'verified', 'failed'].includes(raw.status) && ['sandbox', 'live'].includes(raw.toolKind), 'Invalid action status');
  if (raw.executionCount !== undefined) assert(Number.isSafeInteger(raw.executionCount) && raw.executionCount >= 0, 'Invalid execution count');
  if (raw.verification !== undefined) { object(raw.verification); fields(raw.verification, ['passed', 'evidence']); assert(typeof raw.verification.passed === 'boolean', 'Invalid action verification'); }
  if (raw.status === 'verified') assert(raw.verification?.passed === true, 'Verified action requires destination evidence');
  for (const receipt of [raw.receipt, raw.queryResult]) if (receipt && typeof receipt === 'object' && !Array.isArray(receipt)) {
    for (const key of ['operationId', 'parametersDigest', 'target']) if (Object.hasOwn(receipt, key)) assert(receipt[key] === raw[key], 'Action receipt linkage mismatch: ' + key);
  }
  return jsonCopy(raw) as ActionRecord;
}
export const unevaluatedAssessment = (): Assessment => ({ schemaVersion: '1.0', status: 'not_evaluated', labelsVersion: null, splitVersion: null, applicableData: [], metrics: {}, sampleCount: 0, independentReview: false, notes: ['No independent model-quality assessment has been performed.'] });
export interface CreateRunOptions {
  circuit: Circuit | unknown; input: Json; evidence?: EvidenceRecord[]; provider?: Provider; mode?: RunMode;
  budget?: Partial<RunBudgetLimits>; parentRunId?: string; changeReason?: string; scenarioId?: string;
  actions?: ActionRecord[]; assessment?: Assessment; signal?: AbortSignal; onEvent?: (event: RunEvent) => void;
}
/** Integrity detects inconsistent content. It does not authenticate the source or signer. */
export function sealArtifact(artifact: RunArtifact): RunArtifact {
  const { integrity: _old, ...content } = artifact;
  artifact.integrity = { algorithm: 'sha256', digest: digest(content) };
  return artifact;
}
function selectedEvidenceIds(state: Json | undefined, evidence: EvidenceRecord[]): string[] {
  const ids = new Set<string>(), registry = new Map(evidence.map(e => [e.evidenceId, e.contentDigest]));
  function visit(value: Json | undefined): void {
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value) && typeof value.evidenceId === 'string' && typeof value.contentDigest === 'string' && registry.get(value.evidenceId) === value.contentDigest) ids.add(value.evidenceId);
    for (const child of Object.values(value)) visit(child);
  }
  visit(state); return [...ids].sort();
}
function decisions(artifact: Pick<RunArtifact, 'circuit' | 'input' | 'evidence' | 'requests' | 'result' | 'mode'>): Record<string, DecisionSignal> {
  return Object.fromEntries(artifact.circuit.nodes.map(node => {
    const signal = artifact.result.signals[node.id]!;
    const request = artifact.requests.find(r => Object.hasOwn(r.questions, node.id));
    return [node.id, validateDecisionSignal({ schemaVersion: '1.0', truth: signal.truth, reasonCode: signal.reason, inputDigest: digest(artifact.input), policyDigest: digest(node.kind === 'semantic' ? node.policy : node), provider: request?.provider ?? 'deterministic', model: request?.response?.model ?? null, ...(request?.response?.upstreamModel ? { upstreamModel: request.response.upstreamModel } : {}), evidenceIds: node.kind === 'semantic' ? selectedEvidenceIds(request?.state ?? pointer(artifact.input, node.input ?? '').value, artifact.evidence) : [], ...(signal.answer ? { answer: signal.answer } : {}), provenance: request?.provenance ?? 'deterministic' })];
  }));
}
export async function createRunArtifact(options: CreateRunOptions): Promise<RunArtifact> {
  const circuit = validateCircuit(options.circuit), input = jsonCopy(options.input);
  const evidence = (options.evidence ?? []).map(validateEvidenceRecord);
  assert(new Set(evidence.map(e => e.evidenceId)).size === evidence.length, 'Duplicate evidence id');
  if (options.parentRunId) assert(text(options.changeReason), 'Child run requires a change reason');
  const mode = options.mode ?? 'fixture'; assert(modes.includes(mode), 'Invalid run mode');
  const limits: RunBudgetLimits = { maxCalls: 16, maxNodes: 256, maxTimeMs: 120_000, gateTimeoutMs: 30_000, ...options.budget };
  const events: RunEvent[] = [], requests: RequestRecord[] = [], start = performance.now();
  const result = await runCircuit(circuit, input, { ...(options.provider ? { provider: options.provider } : {}), maxCalls: limits.maxCalls, maxNodes: limits.maxNodes, maxTimeMs: limits.maxTimeMs, timeoutMs: limits.gateTimeoutMs, ...(limits.maxTokens !== undefined ? { maxTokens: limits.maxTokens } : {}), ...(limits.maxCostUsd !== undefined ? { maxCostUsd: limits.maxCostUsd } : {}), ...(options.signal ? { signal: options.signal } : {}), onEvent: event => { events.push(event); options.onEvent?.(jsonCopy(event)); }, onRequest: request => requests.push({ ...request, index: requests.length, provenance: mode }) });
  const allKnown = requests.every(r => r.status === 'ok' && r.response?.usage);
  const exhausted = [...new Set(result.nodes.map(n => n.signal.reason).filter(r => stopReasons.includes(r) && r !== 'aborted'))];
  const artifact: RunArtifact = {
    schemaVersion: '1.0', runId: randomUUID(), createdAt: new Date().toISOString(), ...(options.parentRunId ? { parentRunId: options.parentRunId, changeReason: options.changeReason! } : {}), ...(options.scenarioId ? { scenarioId: options.scenarioId } : {}),
    mode, circuit, input, evidence, model: { provider: options.provider?.name ?? 'none', requestedModel: options.provider?.model ?? 'none', actualModels: [...new Set(requests.flatMap(r => r.response ? [r.response.model] : []))], upstreamModels: [...new Set(requests.flatMap(r => r.response?.upstreamModel ? [r.response.upstreamModel] : []))] },
    events, result, signals: {}, requests,
    budget: { limits, usage: { calls: requests.length, nodes: result.nodes.filter(n => !['aborted', 'time_budget_exhausted', 'node_budget_exhausted'].includes(n.signal.reason)).length, elapsedMs: performance.now() - start, inputTokens: allKnown ? requests.reduce((s, r) => s + (r.response?.usage?.input_tokens ?? 0), 0) : 'unknown', outputTokens: allKnown ? requests.reduce((s, r) => s + (r.response?.usage?.output_tokens ?? 0), 0) : 'unknown', costUsd: requests.length ? 'unknown' : 0 }, exhausted },
    actions: (options.actions ?? []).map(validateActionRecord), assessment: validateAssessment(options.assessment ?? unevaluatedAssessment()),
    workflow: { status: result.nodes.some(n => n.signal.reason === 'aborted') ? 'cancelled' : exhausted.length ? 'budget_exhausted' : 'completed', errors: requests.filter(r => r.status === 'error').map(r => r.error!) },
    integrity: { algorithm: 'sha256', digest: '' },
  };
  artifact.signals = decisions(artifact); return sealArtifact(artifact);
}

function validateEnvelope(raw: unknown): RunArtifact {
  const serialized = canonical(raw); assert(serialized.length <= 16 * 1024 * 1024, 'Artifact exceeds 16 MiB'); object(raw);
  fields(raw, ['schemaVersion', 'runId', 'createdAt', 'mode', 'circuit', 'input', 'evidence', 'model', 'events', 'result', 'signals', 'requests', 'budget', 'actions', 'assessment', 'workflow', 'integrity'], ['parentRunId', 'changeReason', 'scenarioId']);
  assert(raw.schemaVersion === '1.0' && text(raw.runId) && date(raw.createdAt) && modes.includes(raw.mode), 'Invalid artifact header');
  if (raw.parentRunId !== undefined) assert(text(raw.parentRunId) && raw.parentRunId !== raw.runId && text(raw.changeReason), 'Invalid child run');
  if (raw.scenarioId !== undefined) assert(text(raw.scenarioId), 'Invalid scenario id');
  object(raw.integrity); fields(raw.integrity, ['algorithm', 'digest']);
  const { integrity, ...content } = raw; assert(integrity.algorithm === 'sha256' && SHA.test(integrity.digest) && integrity.digest === digest(content), 'Artifact integrity mismatch');
  validateCircuit(raw.circuit); assert(Array.isArray(raw.evidence) && raw.evidence.length <= 4096, 'Invalid evidence list'); raw.evidence.forEach(validateEvidenceRecord);
  assert(new Set(raw.evidence.map((e: EvidenceRecord) => e.evidenceId)).size === raw.evidence.length, 'Duplicate evidence id');
  assert(Array.isArray(raw.actions) && raw.actions.length <= 4096, 'Invalid action list'); raw.actions.forEach(validateActionRecord); assert(new Set(raw.actions.map((a: ActionRecord) => a.operationId)).size === raw.actions.length, 'Duplicate operation id');
  validateAssessment(raw.assessment);
  object(raw.model); fields(raw.model, ['provider', 'requestedModel', 'actualModels', 'upstreamModels']);
  assert(text(raw.model.provider) && text(raw.model.requestedModel) && strings(raw.model.actualModels) && strings(raw.model.upstreamModels), 'Invalid model metadata');
  object(raw.signals); Object.values(raw.signals).forEach(validateDecisionSignal);
  object(raw.budget); fields(raw.budget, ['limits', 'usage', 'exhausted']); object(raw.budget.limits); fields(raw.budget.limits, ['maxCalls', 'maxNodes', 'maxTimeMs', 'gateTimeoutMs'], ['maxTokens', 'maxCostUsd']);
  const b = raw.budget.limits;
  assert(Number.isSafeInteger(b.maxCalls) && b.maxCalls >= 0 && b.maxCalls <= 1024 && Number.isSafeInteger(b.maxNodes) && b.maxNodes >= 0 && b.maxNodes <= 256 && nonnegative(b.maxTimeMs) && b.maxTimeMs > 0 && b.maxTimeMs <= 3_600_000 && nonnegative(b.gateTimeoutMs) && b.gateTimeoutMs > 0 && b.gateTimeoutMs <= 300_000, 'Invalid budget limits');
  if (b.maxTokens !== undefined) assert(Number.isSafeInteger(b.maxTokens) && b.maxTokens >= 0, 'Invalid token budget');
  if (b.maxCostUsd !== undefined) assert(nonnegative(b.maxCostUsd), 'Invalid cost budget');
  object(raw.budget.usage); fields(raw.budget.usage, ['calls', 'nodes', 'elapsedMs', 'inputTokens', 'outputTokens', 'costUsd']);
  assert(Object.values(raw.budget.usage).every(v => v === 'unknown' || nonnegative(v)) && strings(raw.budget.exhausted), 'Invalid budget accounting');
  object(raw.workflow); fields(raw.workflow, ['status', 'errors']); assert(['completed', 'cancelled', 'budget_exhausted'].includes(raw.workflow.status) && Array.isArray(raw.workflow.errors) && raw.workflow.errors.every(text), 'Invalid workflow');
  assert(Array.isArray(raw.requests) && raw.requests.length <= 1024 && Array.isArray(raw.events) && raw.events.length <= 5000, 'Invalid request/event list');
  object(raw.result); fields(raw.result, ['circuit', 'circuitDigest', 'inputDigest', 'status', 'signals', 'outputs', 'nodes', 'calls']);
  return jsonCopy(raw) as RunArtifact;
}

/** Pure replay: imports no adapter, performs no network request and never executes an action. */
function recompute(artifact: RunArtifact): RunResult {
  const { circuit, input, result, requests } = artifact;
  assert(result.circuit === circuit.name && result.circuitDigest === digest(circuit) && result.inputDigest === digest(input), 'Result input/circuit linkage mismatch');
  assert(Array.isArray(result.nodes) && result.nodes.length === circuit.nodes.length && Array.isArray(result.calls) && result.calls.length === requests.length, 'Incomplete trace');
  const requestMap = new Map<string, RequestRecord>();
  for (const [index, request] of requests.entries()) {
    object(request); fields(request as unknown as Record<string, unknown>, ['index', 'provider', 'requestedModel', 'state', 'questions', 'requestDigest', 'status', 'elapsedMs', 'provenance'], ['response', 'rawResponse', 'error', 'transport']);
    assert(request.index === index && text(request.provider) && text(request.requestedModel) && nonnegative(request.elapsedMs) && modes.includes(request.provenance), 'Invalid request');
    same(request.requestDigest, digest({ provider: request.provider, model: request.requestedModel, state: request.state, questions: request.questions }), 'Request digest mismatch');
    assert(!requestMap.has(request.requestDigest), 'Duplicate request digest'); requestMap.set(request.requestDigest, request);
    assert(request.provenance === artifact.mode, 'Request provenance mismatch');
    assert(request.provider === artifact.model.provider && request.requestedModel === artifact.model.requestedModel, 'Provider/model header mismatch');
    if (request.transport) {
      object(request.transport); fields(request.transport, ['request', 'response']);
      const wireState = request.state === null || typeof request.state === 'boolean' || typeof request.state === 'number' ? { value: request.state } : request.state;
      same(request.transport.request, { state: wireState, model: request.requestedModel, questions: request.questions }, 'Transport request linkage mismatch');
      if (request.status === 'ok') {
        const normalized = validateResponse(request.transport.response, request.questions);
        const { upstreamModel: _upstream, ...base } = request.response!;
        const { upstreamModel: _wireUpstream, ...wire } = normalized;
        same(base, wire, 'Transport response linkage mismatch');
        if (normalized.upstreamModel) same(normalized.upstreamModel, request.response!.upstreamModel, 'Transport upstream mismatch');
      }
    }
    if (request.status === 'ok') { same(validateResponse(request.response, request.questions), request.response, 'Invalid normalized response'); if (request.rawResponse !== undefined) same(validateResponse(request.rawResponse, request.questions), request.response, 'Raw response linkage mismatch'); assert(request.error === undefined, 'Successful request has error'); }
    else assert(request.status === 'error' && text(request.error) && request.response === undefined, 'Invalid failure record');
    const call = result.calls[index]!;
    assert(Array.isArray(call.questionIds) && new Set(call.questionIds).size === call.questionIds.length, 'Invalid call question ids');
    same([...call.questionIds].sort(), Object.keys(request.questions).sort(), 'Call question set mismatch');
    same(call, { provider: request.provider, requestedModel: request.requestedModel, ...(request.response ? { model: request.response.model, ...(request.response.upstreamModel ? { upstreamModel: request.response.upstreamModel } : {}) } : {}), questionIds: call.questionIds, requestDigest: request.requestDigest, elapsedMs: request.elapsedMs, status: request.status, ...(request.error ? { error: request.error } : {}), ...(request.response?.usage ? { usage: request.response.usage } : {}) }, 'Call trace mismatch');
    for (const [id, question] of Object.entries(request.questions)) {
      const node = circuit.nodes.find(n => n.id === id); assert(node?.kind === 'semantic', 'Request references non-semantic node'); same(question, node.question, 'Question linkage mismatch');
    }
  }
  const signals: Record<string, Signal> = Object.create(null), seen = new Set<string>(), usedRequests = new Set<string>();
  let evaluatedCount = 0;
  for (const trace of result.nodes) {
    object(trace); fields(trace as unknown as Record<string, unknown>, ['id', 'kind', 'signal', 'elapsedMs'], ['requestDigest']);
    const node = circuit.nodes.find(n => n.id === trace.id); assert(node && node.kind === trace.kind && !seen.has(trace.id) && nonnegative(trace.elapsedMs), 'Invalid node trace');
    assert(dependencies(node).every(id => seen.has(id)), 'Trace is not topological'); seen.add(node.id);
    let expected: Signal;
    if (stopReasons.includes(trace.signal.reason)) {
      assert(trace.signal.truth === 'UNKNOWN', 'Stopped node must be UNKNOWN');
      if (trace.signal.reason !== 'aborted') assert(artifact.budget.exhausted.includes(trace.signal.reason), 'Missing budget exhaustion');
      const reason = trace.signal.reason, limits = artifact.budget.limits;
      if (reason === 'node_budget_exhausted') assert(evaluatedCount >= limits.maxNodes, 'Node budget not exhausted');
      if (reason === 'time_budget_exhausted') assert(artifact.budget.usage.elapsedMs + 2 >= limits.maxTimeMs, 'Time budget not exhausted');
      if (['call_budget_exhausted', 'token_budget_exhausted', 'cost_budget_exhausted', 'token_usage_unknown', 'cost_usage_unknown'].includes(reason)) {
        assert(node.kind === 'semantic' && !trace.requestDigest, 'Only uncalled semantic nodes can exhaust call/usage budgets');
        const prior = requests.filter(r => usedRequests.has(r.requestDigest));
        if (reason === 'call_budget_exhausted') assert(prior.length >= limits.maxCalls, 'Call budget not exhausted');
        if (reason === 'token_budget_exhausted') assert(limits.maxTokens !== undefined && prior.reduce((sum, r) => sum + (r.response?.usage?.input_tokens ?? 0) + (r.response?.usage?.output_tokens ?? 0), 0) >= limits.maxTokens, 'Token budget not exhausted');
        if (reason === 'token_usage_unknown') assert(limits.maxTokens !== undefined && prior.some(r => r.status === 'error' || !r.response?.usage), 'No unknown token usage');
        if (reason === 'cost_budget_exhausted') assert(limits.maxCostUsd === 0, 'Cost budget not exhausted');
        if (reason === 'cost_usage_unknown') assert(limits.maxCostUsd !== undefined && prior.length > 0, 'No unknown cost usage');
      }
      expected = { truth: 'UNKNOWN', reason };
      if (trace.requestDigest) { const r = requestMap.get(trace.requestDigest); assert(r?.status === 'error' && Object.hasOwn(r.questions, node.id), 'Stopped request mismatch'); usedRequests.add(trace.requestDigest); }
    } else if (node.kind === 'constant') expected = { truth: node.value, reason: 'constant' };
    else if (node.kind === 'logic') expected = { truth: logic(node.op, node.inputs.map(id => signals[id]!.truth), node.k), reason: 'logic_' + node.op };
    else if (node.kind === 'rule') {
      const selected = pointer(input, node.path); let truth: Signal['truth'] = 'UNKNOWN', reason = 'exact_rule';
      if (node.op === 'exists') truth = selected.found ? 'TRUE' : 'FALSE';
      else if (!selected.found) reason = 'missing_input';
      else if (node.op === 'eq' || node.op === 'neq') truth = ((canonical(selected.value) === canonical(node.value)) === (node.op === 'eq')) ? 'TRUE' : 'FALSE';
      else if (typeof selected.value !== 'number') reason = 'numeric_type_mismatch';
      else { const n = selected.value, v = node.value as number; truth = (node.op === 'gt' ? n > v : node.op === 'gte' ? n >= v : node.op === 'lt' ? n < v : n <= v) ? 'TRUE' : 'FALSE'; }
      expected = { truth, reason };
    } else if (node.when && signals[node.when]!.truth !== 'TRUE') expected = { truth: 'UNKNOWN', reason: signals[node.when]!.truth === 'FALSE' ? 'condition_false' : 'condition_unknown' };
    else if (node.context?.some(id => signals[id]!.truth === 'UNKNOWN')) expected = { truth: 'UNKNOWN', reason: 'context_unknown' };
    else if (!pointer(input, node.input ?? '').found) expected = { truth: 'UNKNOWN', reason: 'missing_input' };
    else if (!trace.requestDigest) { assert(artifact.model.provider === 'none', 'Missing semantic request'); expected = { truth: 'UNKNOWN', reason: 'provider_missing' }; }
    else {
      const request = requestMap.get(trace.requestDigest); assert(request && Object.hasOwn(request.questions, node.id), 'Missing node request'); usedRequests.add(trace.requestDigest);
      const selected = pointer(input, node.input ?? '').value!;
      const state = node.context?.length ? { observation: selected, signals: Object.fromEntries(node.context.map(id => [id, signals[id]!])) } : selected;
      same(request.state, state, 'Semantic input linkage mismatch');
      expected = request.status === 'error' ? { truth: 'UNKNOWN', reason: 'provider_error' } : applyPolicy(request.response!.answers[node.id]!, node.policy);
    }
    same(trace.signal, expected, 'Node decision mismatch: ' + node.id); signals[node.id] = expected;
    if (!['aborted', 'time_budget_exhausted', 'node_budget_exhausted'].includes(expected.reason)) evaluatedCount++;
  }
  assert(usedRequests.size === requestMap.size, 'Unused provider request');
  same(result.signals, signals, 'Signals mismatch');
  const outputs = Object.fromEntries(circuit.outputs.map(id => [id, signals[id]!])); same(result.outputs, outputs, 'Output mismatch');
  const status = Object.values(outputs).some(s => s.truth === 'UNKNOWN') ? 'abstained' : 'evaluated'; assert(result.status === status, 'Result status mismatch');
  same(artifact.signals, decisions(artifact), 'Decision signal metadata mismatch');
  const events = artifact.events;
  assert(events.length >= 2 && events[0]?.type === 'run_started' && events.at(-1)?.type === 'run_completed', 'Missing lifecycle events');
  events.forEach((e, index) => { object(e); fields(e as unknown as Record<string, unknown>, ['sequence', 'type', 'at'], ['nodeId', 'requestDigest', 'signal', 'detail']); assert(e.sequence === index && date(e.at) && ['run_started', 'node_completed', 'provider_started', 'provider_completed', 'provider_failed', 'run_completed'].includes(e.type), 'Invalid event'); });
  const completed = events.filter(e => e.type === 'node_completed'); assert(completed.length === result.nodes.length, 'Node event count mismatch');
  completed.forEach((e, index) => { const trace = result.nodes[index]!; same(e.nodeId, trace.id, 'Node event order mismatch'); same(e.signal, trace.signal, 'Event decision mismatch'); same(e.requestDigest ?? null, trace.requestDigest ?? null, 'Event request mismatch'); });
  same(events.filter(e => e.type === 'provider_started').map(e => e.requestDigest), requests.map(r => r.requestDigest), 'Provider start event mismatch');
  same(events.filter(e => ['provider_completed', 'provider_failed'].includes(e.type)).map(e => [e.requestDigest, e.type]), requests.map(r => [r.requestDigest, r.status === 'ok' ? 'provider_completed' : 'provider_failed']), 'Provider completion event mismatch');
  assert(artifact.budget.usage.calls === requests.length && requests.length <= artifact.budget.limits.maxCalls, 'Call accounting mismatch');
  const evaluated = result.nodes.filter(n => !['aborted', 'time_budget_exhausted', 'node_budget_exhausted'].includes(n.signal.reason)).length;
  assert(artifact.budget.usage.nodes === evaluated && evaluated <= artifact.budget.limits.maxNodes, 'Node accounting mismatch');
  const known = requests.every(r => r.status === 'ok' && r.response?.usage);
  same(artifact.budget.usage.inputTokens, known ? requests.reduce((s, r) => s + (r.response?.usage?.input_tokens ?? 0), 0) : 'unknown', 'Input token accounting mismatch');
  same(artifact.budget.usage.outputTokens, known ? requests.reduce((s, r) => s + (r.response?.usage?.output_tokens ?? 0), 0) : 'unknown', 'Output token accounting mismatch');
  same(artifact.budget.usage.costUsd, requests.length ? 'unknown' : 0, 'Cost accounting mismatch');
  same(artifact.budget.exhausted, [...new Set(result.nodes.map(n => n.signal.reason).filter(r => stopReasons.includes(r) && r !== 'aborted'))], 'Exhaustion accounting mismatch');
  same(artifact.workflow.status, result.nodes.some(n => n.signal.reason === 'aborted') ? 'cancelled' : artifact.budget.exhausted.length ? 'budget_exhausted' : 'completed', 'Workflow mismatch');
  same(artifact.workflow.errors, requests.filter(r => r.status === 'error').map(r => r.error), 'Workflow errors mismatch');
  same(artifact.model.actualModels, [...new Set(requests.flatMap(r => r.response ? [r.response.model] : []))], 'Actual model mismatch');
  same(artifact.model.upstreamModels, [...new Set(requests.flatMap(r => r.response?.upstreamModel ? [r.response.upstreamModel] : []))], 'Upstream model mismatch');
  return { ...jsonCopy(result), signals, outputs, status };
}
export async function verifyArtifact(value: unknown): Promise<{ valid: boolean; errors: string[] }> {
  try { recompute(validateEnvelope(value)); return { valid: true, errors: [] }; }
  catch (error) { return { valid: false, errors: [error instanceof Error ? error.message : 'Invalid artifact'] }; }
}
export async function replayArtifact(value: unknown): Promise<{ valid: boolean; errors: string[]; result?: RunResult }> {
  try { return { valid: true, errors: [], result: recompute(validateEnvelope(value)) }; }
  catch (error) { return { valid: false, errors: [error instanceof Error ? error.message : 'Invalid artifact'] }; }
}
