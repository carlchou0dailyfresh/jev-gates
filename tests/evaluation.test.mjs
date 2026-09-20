import test from 'node:test';
import assert from 'node:assert/strict';
import { runEngineeringEvaluation, evaluateComparisons, comparisonFixture, wilsonInterval, summarizeEvaluation, validateBoundedPlan, createChoicePlanner, PlannerFailure, calibrateChoicePolicy, EVAL_PROTOCOL_DIGEST, evaluateWorldHeldout, admitWorldSubcircuit } from '../dist/evaluation.js';
import { getScenario } from '../dist/scenarios.js';
import { generateWorldDataset, executeWorld } from '../dist/mini-world.js';
import { MockProvider } from '../dist/providers/mock.js';
import { ProviderFailure } from '../dist/providers/http.js';

test('engineering evaluation never labels fixture pipelines as model quality', async () => {
  const report = await runEngineeringEvaluation(); assert.equal(report.status, 'passed'); assert.equal(report.cases.length, 49); assert.equal(report.modelQuality, 'not_evaluated');
  const compared = await evaluateComparisons({ maxCases: 2, scenarioIds: ['world'], variants: ['normal', 'missing'], ablations: ['none', 'no-second-layer', 'no-memory', 'no-counterexample'] });
  assert.equal(compared.modelQuality, 'not_run'); assert.equal(compared.rows.length, 32); assert.equal(compared.metrics.brier, null); assert.equal(compared.rows.every(r => r.provenance === 'fixture'), true);
});
test('aggregate call budget stops comparisons; provider errors are never successful UNKNOWN answers', async () => {
  const report = await evaluateComparisons({ scenarioIds: ['world'], variants: ['fault'], maxCases: 1, totalMaxCalls: 2 });
  assert.ok(report.rows.reduce((n, r) => n + r.calls, 0) <= 2); assert.ok(report.rows.every(r => r.failed)); assert.equal(report.metrics.correctKnown, 0); assert.equal(report.metrics.abstentions, 0);
});
test('counterexample ablation removes derived conflict state and archived source registry', () => {
  const scenario = getScenario('research', 'counterexample'), fixture = comparisonFixture(scenario, 'atomic-program', 'no-counterexample');
  assert.equal(fixture.input.gates.conflictResolved, true);
  assert.deepEqual(fixture.input.gateDecisions.conflict.metadata.refute ?? [], []);
  assert.equal(fixture.evidence.some(e => e.sourceId === 'synthetic-counterexample'), false);
  assert.equal(JSON.stringify(fixture.input).includes('synthetic-counterexample'), false);
});
test('Wilson bounds and proper scoring require explicit live binary probability contract', () => {
  assert.equal(wilsonInterval(0, 0), null); assert.ok(wilsonInterval(10, 10)[0] < 1); assert.throws(() => wilsonInterval(2, 1));
  const base = { caseId: 'x', scenario: 'world', variant: 'normal', arm: 'single-llm', ablation: 'none', actual: 'TRUE', expected: 'TRUE', failed: false, elapsedMs: 5, calls: 1, provider: 'test', model: 'test', language: 'zh-TW', provenance: 'live', tokens: 1, costUsd: 0, probabilityTrue: 0.8, probabilityContract: 'binary-event-v1' };
  const metrics = summarizeEvaluation([base]); assert.ok(Math.abs(metrics.brier - 0.04) < 1e-10); assert.ok(Math.abs(metrics.nll + Math.log(0.8)) < 1e-10);
  assert.equal(summarizeEvaluation([{ ...base, provenance: 'fixture' }]).brier, null);
});
test('bounded planner cannot remove constraints, rewrite output logic, introduce commands or omit outputs', async () => {
  const original = getScenario('planning').circuit;
  const changed = structuredClone(original); changed.nodes.find(n => n.kind === 'logic').op = 'or'; assert.throws(() => validateBoundedPlan(changed, original), /unapproved/);
  assert.throws(() => validateBoundedPlan({ ...original, outputs: [original.outputs[0]] }, original), /outputs/);
  const provider = new MockProvider({ plan: { type: 'choice', choice: 'reverse', probabilities: { preserve: 0, reverse: 1, unknown: 0 }, confidence: 1 } });
  const result = await createChoicePlanner(provider).propose({ question: 'plan', input: {}, approvedCircuit: original, evidenceIds: [], budget: { maxCalls: 1, maxNodes: 256, timeoutMs: 100 } });
  assert.equal(result.calls, 1); assert.deepEqual(result.circuit.nodes.map(n => n.id), original.nodes.map(n => n.id).reverse());
});
test('planner abstention retains request, questions, normalized and transport responses without counting an API fault', async () => {
  let calls = 0;
  const response = { model: 'bridge-fixture', upstreamModel: 'upstream-fixture', usage: { input_tokens: 10, output_tokens: 2 }, answers: { plan: { type: 'choice', choice: 'unknown', probabilities: { preserve: 0, reverse: 0, unknown: 1 }, confidence: 1 } } };
  const provider = { name: 'fixture-planner', model: 'requested-fixture', async evaluate(state, questions, options) { calls++; options.onTransport?.({ request: { state, questions, model: 'requested-fixture' }, response: { ...response, fixtureWireMarker: 'retained' } }); return response; } };
  const request = { question: 'world', input: {}, approvedCircuit: getScenario('world').circuit, evidenceIds: [], budget: { maxCalls: 1, maxNodes: 256, timeoutMs: 100 } };
  await assert.rejects(createChoicePlanner(provider).propose(request), error => error instanceof PlannerFailure && error.record.code === 'abstained' && error.record.response.answers.plan.choice === 'unknown' && error.record.transport.response.fixtureWireMarker === 'retained');
  const report = await evaluateComparisons({ providerFactory: () => provider, scenarioIds: ['world'], variants: ['blocked'], maxCases: 1, arms: ['bounded-planner'], totalMaxCalls: 1 });
  assert.equal(calls, 2); assert.equal(report.rows[0].calls, 1); assert.equal(report.rows[0].failed, false); assert.equal(report.rows[0].failureReason, null); assert.equal(report.rows[0].actual, 'UNKNOWN');
  assert.equal(report.rows[0].decisionSource, 'planner-abstention'); assert.equal(report.rows[0].model, 'bridge-fixture'); assert.deepEqual(report.rows[0].upstreamModels, ['upstream-fixture']); assert.equal(report.rows[0].tokens, 12);
  assert.equal(report.metrics.abstentions, 1); assert.equal(report.metrics.failures, 0); assert.equal(report.artifacts[0].requests.length, 0);
  const record = report.plannerRecords[0]; assert.equal(record.status, 'abstained'); assert.ok(record.questions.plan); assert.equal(record.response.answers.plan.choice, 'unknown'); assert.equal(record.transport.response.fixtureWireMarker, 'retained');
});
test('planner transport failure, timeout and malformed proposal retain distinct safe diagnoses', async () => {
  const throwing = { name: 'fixture-planner', model: 'fixture', async evaluate() { throw new ProviderFailure('sensitive arbitrary diagnostic must not appear', 'http_error', 503); } };
  const failed = await evaluateComparisons({ providerFactory: () => throwing, scenarioIds: ['world'], variants: ['normal'], maxCases: 1, arms: ['bounded-planner'], totalMaxCalls: 1 });
  assert.equal(failed.rows[0].failed, true); assert.equal(failed.rows[0].failureReason, 'planner_provider_failed'); assert.equal(failed.plannerRecords[0].providerFailureCode, 'http_error'); assert.equal(failed.plannerRecords[0].httpStatus, 503); assert.ok(failed.plannerRecords[0].questions.plan); assert.equal(JSON.stringify(failed).includes('sensitive arbitrary'), false);
  const stalled = { name: 'fixture-stall', model: 'fixture', async evaluate() { return new Promise(() => {}); } };
  await assert.rejects(createChoicePlanner(stalled).propose({ question: 'world', input: {}, approvedCircuit: getScenario('world').circuit, evidenceIds: [], budget: { maxCalls: 1, maxNodes: 256, timeoutMs: 2 } }), error => error instanceof PlannerFailure && error.record.code === 'deadline_exceeded' && error.record.calls === 1);
  const invalidPlanner = { async propose(request) { const circuit = structuredClone(request.approvedCircuit); circuit.nodes.find(n => n.kind === 'logic').op = 'or'; return { circuit, calls: 0, request: { proposed: 'weakened constraints' }, response: { model: 'fixture-proposal', upstreamModel: 'fixture-upstream', answers: {} } }; } };
  const invalid = await evaluateComparisons({ planner: invalidPlanner, scenarioIds: ['world'], variants: ['normal'], maxCases: 1, arms: ['bounded-planner'] });
  assert.equal(invalid.rows[0].failureReason, 'planner_invalid_plan'); assert.equal(invalid.plannerRecords[0].request.proposed, 'weakened constraints'); assert.equal(invalid.plannerRecords[0].response.model, 'fixture-proposal'); assert.equal(invalid.artifacts[0].requests.length, 0);
});
test('calibration refuses mixed routes and heldout data, with insufficient samples honestly recorded', () => {
  const datum = { split: 'calibration', provider: 'localjev', model: 'm', language: 'zh-TW', scenario: 'world', expected: 'TRUE', supportProbability: 0.9, refuteProbability: 0.1 };
  assert.equal(calibrateChoicePolicy([datum]).status, 'not_evaluated');
  assert.throws(() => calibrateChoicePolicy([{ ...datum, split: 'test' }]), /split/);
  assert.throws(() => calibrateChoicePolicy([datum, { ...datum, model: 'other' }]), /independently/);
  assert.equal(calibrateChoicePolicy(Array.from({ length: 30 }, () => datum)).status, 'candidate_requires_frozen_holdout');
});
test('heldout enforces frozen protocol, excludes answers, and uses only train examples', async () => {
  const seen = [];
  const provider = { name: 'test', model: 'test', async evaluate(input, questions) { seen.push(input); return { model: 'test', answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'choice', choice: 'insufficient', probabilities: { support: 0, refute: 0, insufficient: 1, mixed: 0 }, confidence: 1 }])) }; } };
  const records = generateWorldDataset(); await assert.rejects(evaluateWorldHeldout(provider, records, 'wrong'), /frozen/);
  const result = await evaluateWorldHeldout(provider, records, EVAL_PROTOCOL_DIGEST, 2, 1); assert.equal(result.shots, 1); assert.equal(result.sampleCount, 2);
  assert.equal(seen[0].examples.length, 1); assert.equal('label' in seen[0], false); assert.equal('expected' in seen[0], false);
});
test('subcircuit admission is dev-only and changes require a new version', async () => {
  const candidate = { id: 'world_candidate', version: '1.0.0', circuit: getScenario('world').circuit }, records = generateWorldDataset();
  await assert.rejects(admitWorldSubcircuit(candidate, records.filter(c => c.split === 'test').slice(0, 1), async () => 'TRUE'), /development/);
  const dev = records.filter(c => c.split === 'dev');
  const oracle = async input => executeWorld({ ...input, hidden: input.hiddenFacts, id: 'dev-check', family: 'conjunction', seed: 0, generatorVersion: 'world-v1', distractors: [] }).truth;
  const admitted = await admitWorldSubcircuit(candidate, dev, oracle); assert.equal(admitted.status, 'admitted_on_development_only');
  const changed = structuredClone(candidate); changed.circuit.name = 'changed'; await assert.rejects(admitWorldSubcircuit(changed, dev, oracle, admitted.subcircuit), /new version/);
});
