import { performance } from 'node:perf_hooks';
import { digest, jsonCopy } from './json.js';
import { runCircuit } from './engine.js';
import { MockProvider } from './providers/mock.js';
import { validateResponse } from './providers/validation.js';
import { ProviderFailure } from './providers/http.js';
import { validateCircuit } from './validation.js';
import { assertFamilyIsolation, executeWorld, generateWorldDataset, WORLD_SPLITS, type WorldCase } from './mini-world.js';
import { fixtureAnswer, getScenario, listScenarios, normalizeScenarioInput, type ScenarioInstance } from './scenarios.js';
import { versionedSubcircuit, type VersionedSubcircuit } from './semantic-gates.js';
import { createRunArtifact } from './artifact.js';
import type { EvidenceRecord, RunArtifact } from './workbench-types.js';
import type { Answer, Circuit, GateNode, Json, Provider, ProviderResponse, Question, RunResult, Truth } from './types.js';

export const EVAL_PROTOCOL = Object.freeze({ version: 'eval-v1.1', frozenAt: '2026-09-19T17:38:10.000Z', supersedes: 'eval-v1', reason: 'timestamp_metadata_correction', performanceTuning: false, language: 'zh-TW', maxCalls: 8, gateTimeoutMs: 5000, minimumCoverage: 0.7, maximumKnownErrorRate: 0.1, minimumCasesPerStratum: 30, decision: 'experimental-until-live-heldout', labelsVersion: 'independent-world-executor-v1', splitVersion: 'family-isolated-v1', calibration: 'choice-0.60-margin-0.15-not-empirically-calibrated' });
export const EVAL_PROTOCOL_DIGEST = digest(EVAL_PROTOCOL);
export type ComparisonArm = 'single-llm' | 'atomic-program' | 'fixed-layered' | 'bounded-planner';
export type Ablation = 'none' | 'no-second-layer' | 'no-memory' | 'no-counterexample';
export interface EvaluationRow { caseId: string; scenario: string; variant: string; arm: ComparisonArm; ablation: Ablation; expected: Truth | null; actual: Truth; failed: boolean; failureReason: string | null; elapsedMs: number; calls: number; provider: string; model: string; language: 'zh-TW'; provenance: 'fixture' | 'live'; tokens: number | 'unknown'; costUsd: number | 'unknown'; probabilityTrue?: number; probabilityContract?: 'binary-event-v1'; artifactRunId?: string; upstreamModels?: string[]; decisionSource?: 'circuit' | 'planner-abstention' }
export interface EvaluationMetrics { n: number; labelled: number; knownLabels: number; correctKnown: number; falsePositive: number; falseNegative: number; coverage: number | null; abstentions: number; failures: number; knownAccuracy: number | null; accuracy95: [number, number] | null; p50Ms: number | null; p95Ms: number | null; toolSuccessRate: null; constraintViolations: number; costUsd: number | 'unknown'; brier: number | null; nll: number | null }

export function wilsonInterval(successes: number, n: number): [number, number] | null {
  if (!Number.isInteger(n) || !Number.isInteger(successes) || n < 0 || successes < 0 || successes > n) throw new Error('Invalid binomial counts');
  if (!n) return null;
  const z = 1.959963984540054, p = successes / n, denominator = 1 + z * z / n, centre = (p + z * z / (2 * n)) / denominator, margin = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}
function percentile(values: number[], p: number): number | null { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!; }
export function summarizeEvaluation(rows: EvaluationRow[]): EvaluationMetrics {
  const labelled = rows.filter(r => r.expected !== null), knownLabels = labelled.filter(r => r.expected !== 'UNKNOWN');
  const answered = knownLabels.filter(r => r.actual !== 'UNKNOWN' && !r.failed), correctKnown = answered.filter(r => r.actual === r.expected).length;
  const calibrated = knownLabels.filter(r => !r.failed && r.provenance === 'live' && r.probabilityContract === 'binary-event-v1' && typeof r.probabilityTrue === 'number' && r.probabilityTrue >= 0 && r.probabilityTrue <= 1);
  const brier = calibrated.length ? calibrated.reduce((n, r) => n + (r.probabilityTrue! - (r.expected === 'TRUE' ? 1 : 0)) ** 2, 0) / calibrated.length : null;
  const nll = calibrated.length ? calibrated.reduce((n, r) => n - Math.log(Math.max(1e-15, r.expected === 'TRUE' ? r.probabilityTrue! : 1 - r.probabilityTrue!)), 0) / calibrated.length : null;
  return { n: rows.length, labelled: labelled.length, knownLabels: knownLabels.length, correctKnown, falsePositive: labelled.filter(r => !r.failed && r.expected === 'FALSE' && r.actual === 'TRUE').length, falseNegative: labelled.filter(r => !r.failed && r.expected === 'TRUE' && r.actual === 'FALSE').length, coverage: labelled.length ? labelled.filter(r => !r.failed && r.actual !== 'UNKNOWN').length / labelled.length : null, abstentions: rows.filter(r => !r.failed && r.actual === 'UNKNOWN').length, failures: rows.filter(r => r.failed).length, knownAccuracy: answered.length ? correctKnown / answered.length : null, accuracy95: wilsonInterval(correctKnown, answered.length), p50Ms: percentile(rows.map(r => r.elapsedMs), 0.5), p95Ms: percentile(rows.map(r => r.elapsedMs), 0.95), toolSuccessRate: null, constraintViolations: rows.filter(r => r.scenario === 'planning' && r.expected === 'FALSE' && r.actual === 'TRUE' && !r.failed).length, costUsd: rows.every(r => typeof r.costUsd === 'number') ? rows.reduce((n, r) => n + Number(r.costUsd), 0) : 'unknown', brier, nll };
}
export function scenarioProvider(scenario: ScenarioInstance): Provider {
  if (scenario.providerFault) return { name: 'fixture-fault', model: 'injected-failure-v1', async evaluate() { throw new Error('Injected scenario provider failure'); } };
  return new MockProvider(scenario.answers);
}
function primaryOutput(s: ScenarioInstance): string { return s.id === 'research' ? 'conclusion' : s.circuit.outputs[0] === 'db-exhaustion' ? 'repair-candidate' : s.circuit.outputs[0]!; }
function reviewNode(id: string, instructions: string, context?: string[]): GateNode {
  return { id, kind: 'semantic', ...(context ? { context } : {}), question: { type: 'choice', instructions, criteria: { support: '成立', refute: '不成立', insufficient: '資訊不足', mixed: '衝突' } }, policy: { type: 'choice', trueLabels: ['support'], falseLabels: ['refute'], unknownLabels: ['insufficient', 'mixed'], minProbability: 0.6, minMargin: 0.15 } };
}

/** A planner may only return a bounded DAG using approved atomic questions and known exact rules. */
export function validateBoundedPlan(raw: unknown, approved: Circuit): Circuit {
  const circuit = validateCircuit(raw), originals = new Map(approved.nodes.map(n => [n.id, n]));
  if (circuit.nodes.length !== approved.nodes.length || approved.nodes.some(n => !circuit.nodes.some(c => c.id === n.id))) throw new Error('Planner changed required node coverage');
  for (const node of circuit.nodes) {
    if (digest(node) !== digest(originals.get(node.id) ?? null)) throw new Error('Planner introduced an unapproved question, rule, logic, constant or tool');
  }
  if (digest([...circuit.outputs].sort()) !== digest([...approved.outputs].sort())) throw new Error('Planner changed required outputs');
  return circuit;
}

export interface BoundedPlannerRequest { question: string; input: Json; approvedCircuit: Circuit; evidenceIds: string[]; budget: { maxCalls: number; maxNodes: number; timeoutMs: number } }
export type PlannerCode = 'selected' | 'abstained' | 'deadline_exceeded' | 'provider_failed' | 'invalid_response' | 'invalid_plan' | 'budget_exhausted';
export interface PlannerRecord {
  status: 'selected' | 'abstained' | 'error'; code: PlannerCode; provider: string; requestedModel: string;
  calls: number; elapsedMs: number; request: Json; questions: Record<string, Question>;
  response?: ProviderResponse; transport?: { request: Json; response: Json }; actualModel?: string; upstreamModel?: string;
  providerFailureCode?: string; httpStatus?: number;
}
/** Carries only bounded request data and adapter-sanitized response capture; arbitrary error messages are discarded. */
export class PlannerFailure extends Error {
  readonly record: PlannerRecord;
  constructor(record: PlannerRecord) { super(`Planner ${record.code}`); this.name = 'PlannerFailure'; this.record = jsonCopy(record); }
}
export interface BoundedPlanner { propose(request: BoundedPlannerRequest): Promise<{ circuit: Circuit; calls: number; request?: Json; response?: ProviderResponse; record?: PlannerRecord }> }
/** The first planner version chooses an execution ordering among two reviewed, semantically identical DAGs. */
export function createChoicePlanner(provider: Provider): BoundedPlanner {
  return { async propose(request) {
    const started = performance.now();
    const questions = { plan: { type: 'choice' as const, instructions: 'Select a reviewed bounded execution plan. Only node ordering may change; no tool, evidence, question or constraint may be added or removed. Choose unknown if unsuitable.', criteria: { preserve: 'Preserve reviewed node ordering', reverse: 'Reverse list ordering; engine still uses DAG dependencies', unknown: 'No suitable approved plan' } } };
    const state: Json = { question: request.question, input: request.input, evidenceIds: request.evidenceIds, plans: { preserve: request.approvedCircuit.nodes.map(n => n.id), reverse: [...request.approvedCircuit.nodes].reverse().map(n => n.id) }, budget: request.budget };
    const record: PlannerRecord = { status: 'error', code: 'invalid_plan', provider: provider.name, requestedModel: provider.model, calls: 0, elapsedMs: 0, request: jsonCopy(state), questions: jsonCopy(questions) };
    const fail = (code: PlannerCode, error?: unknown): never => {
      record.status = code === 'abstained' ? 'abstained' : 'error'; record.code = code; record.elapsedMs = performance.now() - started;
      if (error instanceof ProviderFailure) { record.providerFailureCode = error.code; if (error.httpStatus !== undefined) record.httpStatus = error.httpStatus; }
      throw new PlannerFailure(record);
    };
    if (!Number.isSafeInteger(request.budget.maxCalls) || request.budget.maxCalls < 1 || request.budget.maxCalls > 1024 || !Number.isSafeInteger(request.budget.maxNodes) || request.budget.maxNodes < 1 || request.budget.maxNodes > 256 || request.approvedCircuit.nodes.length > request.budget.maxNodes || !Number.isFinite(request.budget.timeoutMs) || request.budget.timeoutMs <= 0 || request.budget.timeoutMs > 300_000) fail('budget_exhausted');
    try { validateBoundedPlan(request.approvedCircuit, request.approvedCircuit); } catch { fail('invalid_plan'); }
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, timedOut = false;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('Planner deadline exceeded')); }, request.budget.timeoutMs); });
    let response: ProviderResponse;
    record.calls = 1;
    try {
      let returned: ProviderResponse;
      try { returned = await Promise.race([provider.evaluate(state, questions, { signal: controller.signal, onTransport: capture => { record.transport = jsonCopy(capture); } }), deadline]); }
      catch (error) { fail(timedOut || error instanceof ProviderFailure && error.code === 'timeout' ? 'deadline_exceeded' : error instanceof ProviderFailure && error.code === 'invalid_response' ? 'invalid_response' : 'provider_failed', error); }
      try { response = validateResponse(returned!, questions); } catch { fail('invalid_response'); }
      record.response = jsonCopy(response!); record.actualModel = response!.model;
      if (response!.upstreamModel !== undefined) record.upstreamModel = response!.upstreamModel;
    } finally { clearTimeout(timer); }
    const answer = response!.answers.plan;
    const choice = answer?.type === 'choice' ? answer.choice : fail('invalid_response');
    if (choice === 'unknown') fail('abstained');
    if (!['preserve', 'reverse'].includes(choice)) fail('invalid_plan');
    const circuit = structuredClone(request.approvedCircuit);
    if (choice === 'reverse') circuit.nodes.reverse();
    let checked: Circuit;
    try { checked = validateBoundedPlan(circuit, request.approvedCircuit); } catch { fail('invalid_plan'); }
    record.status = 'selected'; record.code = 'selected'; record.elapsedMs = performance.now() - started;
    return { circuit: checked!, calls: 1, request: state, response: response!, record: jsonCopy(record) };
  } };
}

export function comparisonFixture(scenario: ScenarioInstance, arm: ComparisonArm, ablation: Ablation = 'none'): { circuit: Circuit; input: Json; answers: Record<string, Answer>; output: string; evidence: EvidenceRecord[] } {
  const expected = scenario.expected?.[primaryOutput(scenario)] ?? 'UNKNOWN', answers = structuredClone(scenario.answers);
  let circuit = structuredClone(scenario.circuit), output = primaryOutput(scenario), input = structuredClone(scenario.input);
  if (arm === 'single-llm') {
    output = 'decision';
    circuit = { version: 1, name: 'single-llm-v1', nodes: [reviewNode(output, `依全部觀察判定 ${scenario.title} 的最終有界結論。原始判斷契約：${JSON.stringify(scenario.circuit)}。精確限制也必須成立。禁止假定操作已完成。`)], outputs: [output] };
    answers[output] = fixtureAnswer(expected);
  } else if (arm === 'fixed-layered' && ablation !== 'no-second-layer') {
    const upstream = output; output = 'layered-review';
    circuit.nodes.push(reviewNode(output, '覆核上游有限結論與原始觀察是否一致；不可擴張適用範圍。', [upstream]));
    circuit.outputs = [output]; answers[output] = fixtureAnswer(expected);
  } else if (arm === 'bounded-planner') circuit = validateBoundedPlan(circuit, scenario.circuit);
  if (ablation === 'no-memory' && input && typeof input === 'object' && !Array.isArray(input)) { delete input.examples; }
  if (ablation === 'no-counterexample' && input && typeof input === 'object' && !Array.isArray(input)) {
    // The ablation changes input evidence, never labels. Fixture answers stay scripted and are not a model experiment.
    const strip = (value: Json): Json => Array.isArray(value) ? value.filter(v => !(v && typeof v === 'object' && !Array.isArray(v) && typeof v.evidenceId === 'string' && /counter/.test(v.evidenceId))).map(strip) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, strip(v)])) : value;
    input = strip(input);
  }
  const evidence = input && typeof input === 'object' && !Array.isArray(input) && Array.isArray(input.evidence) ? input.evidence as unknown as EvidenceRecord[] : scenario.evidence;
  input = normalizeScenarioInput(scenario.id, input, evidence);
  return { circuit: validateCircuit(circuit), input, answers, output, evidence };
}

export interface ComparisonOptions {
  /** No provider means engineering-only scripted fixtures. The factory never receives expected labels. */
  providerFactory?: (context: { scenarioId: string; variant: string; arm: ComparisonArm; ablation: Ablation }) => Provider | Promise<Provider>;
  maxCases?: number;
  maxCalls?: number;
  timeoutMs?: number;
  arms?: ComparisonArm[];
  ablations?: Ablation[];
  planner?: BoundedPlanner;
  scenarioIds?: string[];
  variants?: string[];
  totalMaxCalls?: number;
}
export async function evaluateComparisons(options: ComparisonOptions = {}) {
  const maxCases = options.maxCases ?? 48;
  if (!Number.isInteger(maxCases) || maxCases < 1 || maxCases > 48) throw new Error('Comparison maxCases must be 1–48');
  const totalMaxCalls = options.totalMaxCalls ?? 2048;
  if (!Number.isInteger(totalMaxCalls) || totalMaxCalls < 1 || totalMaxCalls > 4096) throw new Error('Invalid total call budget');
  const rows: EvaluationRow[] = [], artifacts: RunArtifact[] = [], plannerRecords: Array<PlannerRecord & { caseId: string }> = [], cases = listScenarios().filter(s => !options.scenarioIds || options.scenarioIds.includes(s.id)).flatMap(s => s.variants.filter(v => v !== 'public-source' && (!options.variants || options.variants.includes(v))).map(v => getScenario(s.id, v))).slice(0, maxCases);
  evaluationLoop: for (const scenario of cases) for (const arm of options.arms ?? ['single-llm', 'atomic-program', 'fixed-layered', 'bounded-planner'] as ComparisonArm[]) for (const ablation of options.ablations ?? ['none'] as Ablation[]) {
    const remainingCalls = totalMaxCalls - rows.reduce((n, r) => n + r.calls, 0);
    if (remainingCalls <= 0) break evaluationLoop;
    const armMaxCalls = Math.min(options.maxCalls ?? EVAL_PROTOCOL.maxCalls, remainingCalls);
    const fixture = comparisonFixture(scenario, arm, ablation);
    const provider = scenario.providerFault ? scenarioProvider(scenario) : options.providerFactory ? await options.providerFactory({ scenarioId: scenario.id, variant: scenario.variant, arm, ablation }) : new MockProvider(fixture.answers);
    const started = performance.now(); let plannerCalls = 0, plannerFailure = false, plannerAbstained = false, plannerRecord: PlannerRecord | undefined;
    if (arm === 'bounded-planner' && !scenario.providerFault && (options.planner || options.providerFactory)) {
      try {
        const planned = await (options.planner ?? createChoicePlanner(provider)).propose({ question: scenario.title, input: fixture.input, approvedCircuit: scenario.circuit, evidenceIds: fixture.evidence.map(e => e.evidenceId), budget: { maxCalls: armMaxCalls, maxNodes: 256, timeoutMs: options.timeoutMs ?? EVAL_PROTOCOL.gateTimeoutMs } });
        plannerRecord = planned.record ?? { status: 'selected', code: 'selected', provider: provider.name, requestedModel: provider.model, request: planned.request ?? fixture.input, questions: {}, calls: planned.calls, elapsedMs: performance.now() - started, ...(planned.response ? { response: jsonCopy(planned.response), actualModel: planned.response.model, ...(planned.response.upstreamModel ? { upstreamModel: planned.response.upstreamModel } : {}) } : {}) };
        if (!Number.isInteger(planned.calls) || planned.calls < 0 || planned.calls > armMaxCalls || plannerRecord.calls !== planned.calls) throw new PlannerFailure({ ...plannerRecord, status: 'error', code: 'budget_exhausted', calls: Math.min(armMaxCalls, Math.max(1, Number.isInteger(planned.calls) ? planned.calls : 1)) });
        try { fixture.circuit = validateBoundedPlan(planned.circuit, scenario.circuit); }
        catch { throw new PlannerFailure({ ...plannerRecord, status: 'error', code: 'invalid_plan' }); }
        plannerCalls = planned.calls;
      } catch (error) {
        plannerRecord = error instanceof PlannerFailure ? error.record : { status: 'error', code: 'provider_failed', provider: provider.name, requestedModel: provider.model, calls: 1, elapsedMs: performance.now() - started, request: fixture.input, questions: {}, ...(error instanceof ProviderFailure ? { providerFailureCode: error.code, ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}) } : {}) };
        plannerAbstained = plannerRecord.code === 'abstained'; plannerFailure = !plannerAbstained; plannerCalls = plannerRecord.calls;
      }
      plannerRecords.push({ ...jsonCopy(plannerRecord!), caseId: `${scenario.id}-${scenario.variant}` });
    }
    const artifact = await createRunArtifact({ scenarioId: scenario.id, circuit: fixture.circuit, input: fixture.input, evidence: fixture.evidence, provider, mode: options.providerFactory && !scenario.providerFault ? provider.name.toLowerCase().includes('typesafe') ? 'live-typesafe' : 'live-localjev' : 'fixture', budget: { maxCalls: plannerFailure || plannerAbstained ? 0 : Math.max(0, armMaxCalls - plannerCalls), maxTimeMs: Math.min(3_600_000, (options.timeoutMs ?? EVAL_PROTOCOL.gateTimeoutMs) * Math.max(1, armMaxCalls)), gateTimeoutMs: options.timeoutMs ?? EVAL_PROTOCOL.gateTimeoutMs, maxNodes: 256 } });
    artifacts.push(artifact); const result = artifact.result;
    const budgetFailure = !plannerAbstained && Object.values(result.signals).some(s => /budget_exhausted|aborted/.test(s.reason));
    const failed = plannerFailure || budgetFailure || result.calls.some(c => c.status === 'error');
    const usageComplete = result.calls.every(c => c.usage) && (!plannerCalls || plannerRecord?.response?.usage !== undefined);
    const tokens = result.calls.length + plannerCalls > 0 && usageComplete ? result.calls.reduce((n, c) => n + c.usage!.input_tokens + c.usage!.output_tokens, 0) + (plannerRecord?.response?.usage ? plannerRecord.response.usage.input_tokens + plannerRecord.response.usage.output_tokens : 0) : 'unknown';
    rows.push({ caseId: `${scenario.id}-${scenario.variant}-${scenario.seed}`, scenario: scenario.id, variant: scenario.variant, arm, ablation, expected: scenario.expected?.[primaryOutput(scenario)] ?? null, actual: plannerAbstained ? 'UNKNOWN' : result.outputs[fixture.output]!.truth, failed, failureReason: plannerFailure ? `planner_${plannerRecord!.code}` : budgetFailure ? 'budget_exhausted_or_cancelled' : failed ? 'provider_failure' : null, elapsedMs: performance.now() - started, calls: result.calls.length + plannerCalls, provider: provider.name, model: result.calls.find(c => c.model)?.model ?? plannerRecord?.actualModel ?? provider.model, language: 'zh-TW', provenance: options.providerFactory && !scenario.providerFault ? 'live' : 'fixture', tokens, costUsd: options.providerFactory ? 'unknown' : 0, artifactRunId: artifact.runId, upstreamModels: [...new Set([...artifact.model.upstreamModels, ...(plannerRecord?.upstreamModel ? [plannerRecord.upstreamModel] : [])])], decisionSource: plannerAbstained ? 'planner-abstention' : 'circuit' });
  }
  const strata = Object.fromEntries([...new Set(rows.map(r => `${r.provider}/${r.model}/${r.language}/${r.scenario}/${r.arm}/${r.ablation}`))].map(key => [key, summarizeEvaluation(rows.filter(r => `${r.provider}/${r.model}/${r.language}/${r.scenario}/${r.arm}/${r.ablation}` === key))]));
  const metrics = summarizeEvaluation(rows);
  const liveKeys = new Set(rows.filter(r => r.provenance === 'live').map(r => `${r.provider}/${r.model}/${r.language}/${r.scenario}/${r.arm}/${r.ablation}`));
  const liveStrata = Object.entries(strata).filter(([key]) => liveKeys.has(key)).map(([, value]) => value);
  const qualityGate = !liveStrata.length ? 'not_evaluated' : liveStrata.some(s => s.n < EVAL_PROTOCOL.minimumCasesPerStratum) ? 'insufficient_samples' : liveStrata.some(s => (s.coverage ?? 0) < EVAL_PROTOCOL.minimumCoverage || (1 - (s.knownAccuracy ?? 0)) > EVAL_PROTOCOL.maximumKnownErrorRate) ? 'failed' : 'requires_independent_review';
  return { schemaVersion: '1.0', protocol: EVAL_PROTOCOL, protocolDigest: EVAL_PROTOCOL_DIGEST, status: options.providerFactory ? 'experimental' : 'engineering_only', modelQuality: options.providerFactory ? 'not_established' : 'not_run', qualityGate, planner: options.planner || options.providerFactory ? 'bounded-reviewed-order-selection-v1' : 'approved-template-reference; model selection not_run', plannerRecords, artifacts, rows, strata, metrics, notes: ['Fixture arms receive scripted answers; these results only exercise pipelines, not architecture quality.', 'Each arm has a versioned artifact with input, raw responses, policy, actual upstream model and offline replay. Planner selection has a separate raw request/response record and consumes the shared call budget.', 'Planner v1 only chooses among two equivalent reviewed execution orderings; open-ended task decomposition remains unimplemented.', 'An independent live comparison must control provider, actual model, data, tools and budget; fault injection remains a separate fixture stratum.', 'Coverage below 0.70 fails the frozen pilot target; a small smoke batch cannot establish quality even when all its answers are correct.', 'Intervals are descriptive binomial Wilson intervals; family-correlated cases are not independent scientific evidence.', 'Noul, Choice and Score are not merged into a universal probability; Brier/NLL remain null until an appropriate probability contract and calibration data exist.'] };
}

export async function runEngineeringEvaluation() {
  const cases: Array<{ id: string; passed: boolean; checkedOutputs: number; providerFailures: number }> = [];
  for (const s of listScenarios()) for (const variant of s.variants) {
    const scenario = getScenario(s.id, variant), result = await runCircuit(scenario.circuit, scenario.input, { provider: scenarioProvider(scenario) });
    const expected = Object.entries(scenario.expected ?? {});
    cases.push({ id: `${s.id}/${variant}`, passed: expected.every(([id, truth]) => result.outputs[id]?.truth === truth) && (scenario.providerFault ? result.calls.some(c => c.status === 'error') : result.calls.every(c => c.status === 'ok')), checkedOutputs: expected.length, providerFailures: result.calls.filter(c => c.status === 'error').length });
  }
  const worldCases = generateWorldDataset(); assertFamilyIsolation(worldCases);
  return { schemaVersion: '1.0', protocolDigest: EVAL_PROTOCOL_DIGEST, status: cases.every(c => c.passed) ? 'passed' : 'failed', scope: 'deterministic-engineering-only', cases, worldDataset: { generatorVersion: 'world-v1', splitVersion: EVAL_PROTOCOL.splitVersion, total: worldCases.length, heldout: worldCases.filter(c => c.split === 'test').length, families: WORLD_SPLITS, digest: digest(worldCases), labelsVerified: worldCases.every(c => c.label === executeWorld(c.world).truth) }, liveLocaljev: 'not_run', liveTypesafe: 'not_run', modelQuality: 'not_evaluated' };
}

/** Evaluate frozen held-out cases without supplying labels to a provider. */
export async function evaluateWorldHeldout(provider: Provider, records: WorldCase[], protocolDigest: string, maxCases = 12, shots: 0 | 1 | 3 = 0) {
  if (protocolDigest !== EVAL_PROTOCOL_DIGEST) throw new Error('Protocol was not frozen with the expected digest');
  assertFamilyIsolation(records);
  if (!Number.isInteger(maxCases) || maxCases < 1 || maxCases > 120) throw new Error('Heldout maxCases must be 1–120');
  const examples = records.filter(r => r.split === 'train').slice(0, shots).map(r => ({ initial: r.world.initial, rules: r.world.rules, target: r.world.target, maxSteps: r.world.maxSteps, demonstratedOutcome: r.label }));
  const results: Array<{ id: string; family: string; shots: number; expected: Truth; actual: Truth; failed: boolean; result: RunResult }> = [];
  for (const record of records.filter(r => r.split === 'test').slice(0, maxCases)) {
    const template = getScenario('world'), input = { generatorVersion: record.world.generatorVersion, family: record.world.family, initial: record.world.initial, hiddenFacts: record.world.hidden, rules: record.world.rules, target: record.world.target, maxSteps: record.world.maxSteps, contradictory: record.world.contradictory, distractors: record.world.distractors, examples } as unknown as Json;
    const result = await runCircuit(template.circuit, input, { provider, maxCalls: EVAL_PROTOCOL.maxCalls, timeoutMs: EVAL_PROTOCOL.gateTimeoutMs });
    results.push({ id: record.id, family: record.family, shots, expected: record.label, actual: result.outputs.conclusion!.truth, failed: result.calls.some(c => c.status === 'error'), result });
  }
  return { status: 'experimental', protocolDigest, shots, examplesFromSplit: 'train', results, sampleCount: results.length, independentlyReviewed: false, notes: ['Only training demonstrations contain labels; held-out labels and solutions are never sent to the provider. Minimum 30 cases per stratum and frozen targets are required before any passed claim.'] };
}

export interface CalibrationDatum { split: 'calibration'; provider: string; model: string; language: string; scenario: string; expected: 'TRUE' | 'FALSE'; supportProbability: number; refuteProbability: number }
/** Local grid search is confined to calibration data; it never changes EVAL_PROTOCOL or a held-out policy. */
export function calibrateChoicePolicy(data: CalibrationDatum[]) {
  if (data.some(d => d.split !== 'calibration' || !Number.isFinite(d.supportProbability) || !Number.isFinite(d.refuteProbability) || d.supportProbability < 0 || d.refuteProbability < 0 || d.supportProbability + d.refuteProbability > 1.0000001)) throw new Error('Invalid calibration split or probabilities');
  const routes = new Set(data.map(d => `${d.provider}/${d.model}/${d.language}/${d.scenario}`));
  if (routes.size > 1) throw new Error('Calibrate each provider/model/language/scenario independently');
  if (data.length < EVAL_PROTOCOL.minimumCasesPerStratum) return { status: 'not_evaluated', sampleCount: data.length, reason: 'insufficient_calibration_samples', policy: null };
  let best: { minProbability: number; minMargin: number; coverage: number; errors: number } | null = null;
  for (const minProbability of [0.5, 0.6, 0.7, 0.8, 0.9]) for (const minMargin of [0, 0.1, 0.2, 0.3]) {
    const decided = data.filter(d => Math.max(d.supportProbability, d.refuteProbability) >= minProbability && Math.abs(d.supportProbability - d.refuteProbability) >= minMargin && d.supportProbability !== d.refuteProbability);
    const errors = decided.filter(d => (d.supportProbability > d.refuteProbability ? 'TRUE' : 'FALSE') !== d.expected).length, coverage = decided.length / data.length;
    if (coverage >= EVAL_PROTOCOL.minimumCoverage && errors / Math.max(1, decided.length) <= EVAL_PROTOCOL.maximumKnownErrorRate && (!best || coverage > best.coverage || (coverage === best.coverage && errors < best.errors))) best = { minProbability, minMargin, coverage, errors };
  }
  return { status: best ? 'candidate_requires_frozen_holdout' : 'failed', sampleCount: data.length, dataDigest: digest(data), route: [...routes][0], policy: best, notes: ['Training fit is not held-out performance. New policy needs a new version and frozen protocol digest before testing.'] };
}

export async function admitWorldSubcircuit(candidate: { id: string; version: string; circuit: Circuit }, developmentCases: WorldCase[], evaluate: (input: Json, circuit: Circuit) => Promise<Truth>, previous?: VersionedSubcircuit) {
  if (!developmentCases.length || developmentCases.some(c => c.split !== 'dev')) throw new Error('Candidate admission accepts development split only');
  assertFamilyIsolation(developmentCases);
  const checked: Array<{ id: string; expected: Truth; actual: Truth }> = [];
  for (const c of developmentCases) {
    const input: Json = { initial: c.world.initial, hiddenFacts: c.world.hidden, rules: c.world.rules, target: c.world.target, maxSteps: c.world.maxSteps, contradictory: c.world.contradictory } as unknown as Json;
    checked.push({ id: c.id, expected: c.label, actual: await evaluate(input, candidate.circuit) });
  }
  if (checked.some(c => c.actual !== c.expected)) return { status: 'failed' as const, checked, subcircuit: null };
  const subcircuit = versionedSubcircuit({ ...candidate, inputSchema: { type: 'object', required: ['initial', 'rules', 'target', 'maxSteps'] }, outputContract: Object.fromEntries(candidate.circuit.outputs.map(id => [id, 'TRUE|FALSE|UNKNOWN under explicit transition bound'])), testsDigest: digest(checked) }, previous);
  return { status: 'admitted_on_development_only' as const, checked, subcircuit };
}
