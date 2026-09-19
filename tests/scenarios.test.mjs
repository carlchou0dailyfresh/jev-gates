import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCircuit } from '../dist/engine.js';
import { listScenarios, getScenario, normalizeScenarioInput, createPerformanceFixture } from '../dist/scenarios.js';
import { scenarioProvider } from '../dist/evaluation.js';
import { solveStation, verifyStationPlan, stationFixture } from '../dist/planning.js';
import { generateWorld, executeWorld, generateWorldDataset, assertFamilyIsolation, worldPlannerInput } from '../dist/mini-world.js';
import { SandboxService } from '../dist/sandbox.js';
import { digest } from '../dist/json.js';

for (const scenario of listScenarios()) test(`${scenario.id}: every declared variant executes actual core and checks expected outputs`, async () => {
  assert.ok(scenario.variants.length >= 12);
  for (const variant of scenario.variants) {
    const instance = getScenario(scenario.id, variant), result = await runCircuit(instance.circuit, instance.input, { provider: scenarioProvider(instance) });
    for (const [id, expected] of Object.entries(instance.expected ?? {})) assert.equal(result.outputs[id].truth, expected, `${variant}/${id}`);
    if (instance.providerFault) assert.ok(result.calls.some(c => c.status === 'error'));
    assert.deepEqual(getScenario(scenario.id, variant, 17), getScenario(scenario.id, variant, 17));
  }
});
test('public source mode has traceable versions and no independently asserted labels', () => {
  const s = getScenario('research', 'public-source'); assert.equal(s.sourceKind, 'source-backed'); assert.equal(s.labelsVersion, null); assert.equal(s.expected, undefined);
  for (const e of s.evidence) { assert.equal(e.kind, 'public-source'); assert.match(e.locator, /^https:\/\/arxiv.org\/abs\/.+v[0-9]+$/); assert.ok(e.content.split(/\s+/).length <= 25); }
});
test('exact feasibility cannot be forged through derived UI fields', () => {
  const input = getScenario('planning').input; input.problem.energy = 0; input.verified.feasible = true;
  const checked = normalizeScenarioInput('planning', input); assert.equal(checked.verified.feasible, false);
  const research = getScenario('research').input; research.task = 'clinical-diagnosis'; research.scopeMatches = true;
  assert.equal(normalizeScenarioInput('research', research).scopeMatches, false);
});
test('evidence editor replacement and removal reaches every semantic request source', async () => {
  const s = getScenario('research'), updated = structuredClone(s.evidence);
  updated[0].content = 'USER-REPLACEMENT: bounded claim is contradicted.';
  updated[0].contentDigest = digest(updated[0].content);
  updated[0].citations = [{ start: 0, end: updated[0].content.length, quote: updated[0].content }];
  const normalized = normalizeScenarioInput('research', s.input, updated);
  assert.deepEqual(normalized.evidence, updated);
  for (const claim of Object.values(normalized.claims)) assert.deepEqual(claim.evidence, updated);
  const seen = [];
  const provider = { name: 'inspection', model: 'inspection', async evaluate(state, questions) { seen.push(state); return { model: 'inspection', answers: Object.fromEntries(Object.keys(questions).map(id => [id, s.answers[id]])) }; } };
  await runCircuit(s.circuit, normalized, { provider });
  assert.ok(seen.length); assert.ok(seen.every(state => state.evidence[0].content.startsWith('USER-REPLACEMENT')));
  const removed = normalizeScenarioInput('research', s.input, []);
  for (const claim of Object.values(removed.claims)) assert.deepEqual(claim.evidence, []);
  assert.equal(removed.gateDecisions.evidenceRequired.truth, 'UNKNOWN');
  for (const id of ['incident', 'planning', 'world']) assert.deepEqual(normalizeScenarioInput(id, getScenario(id).input, updated).evidence, updated);
});
test('exact solver finds alternative when spectrometer closes and rejects impossible resources', () => {
  const alternate = solveStation(stationFixture('instrument-off')); assert.equal(alternate.feasible, true); assert.ok(alternate.steps.includes('photo-sample'));
  assert.equal(solveStation(stationFixture('low-energy')).feasible, false);
  assert.equal(verifyStationPlan(stationFixture(), ['transmit']).reason, 'prerequisite_missing');
  assert.throws(() => solveStation({ ...stationFixture(), energy: NaN }), /resource/);
});
test('world executor handles consumed facts, inhibited rules, observation uncertainty and isolated families', () => {
  assert.equal(executeWorld(generateWorld(42, 'reversible')).truth, 'TRUE');
  assert.equal(executeWorld(generateWorld(43, 'inhibitor')).truth, 'FALSE');
  assert.equal(executeWorld(generateWorld(42, 'chain', { hidden: true })).truth, 'UNKNOWN');
  assert.equal(executeWorld(generateWorld(42, 'chain', { contradiction: true })).truth, 'UNKNOWN');
  const cases = generateWorldDataset(); assert.equal(cases.filter(c => c.split === 'test').length, 120); assertFamilyIsolation(cases);
  const tampered = structuredClone(cases); tampered[0].split = 'test'; assert.throws(() => assertFamilyIsolation(tampered), /family|leakage/);
  assert.equal('label' in worldPlannerInput(cases[0].world), false); assert.equal('plan' in worldPlannerInput(cases[0].world), false);
});
test('timeout after destination apply survives reload and never applies repair twice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-sandbox-'));
  try {
    const path = join(dir, 'service.json'), service = new SandboxService(path);
    await assert.rejects(service.repair({ operationId: 'op-timeout', fault: 'timeout-after-applied' }), /timeout/);
    const reloaded = new SandboxService(path), receipt = await reloaded.query('op-timeout');
    assert.equal(receipt.applied, true); assert.equal(await reloaded.verify(receipt), true); assert.equal(await reloaded.executionCount(), 1);
    await reloaded.repair({ operationId: 'op-timeout' }); await reloaded.query('op-timeout'); assert.equal(await reloaded.executionCount(), 1);
    assert.equal(await reloaded.verify({ ...receipt, healthy: false }), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('failed health verification does not become a repair success', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-health-'));
  try { const service = new SandboxService(join(dir, 'service.json')); const receipt = await service.repair({ operationId: 'op-fail', fault: 'verification-failed' }); assert.equal(receipt.applied, true); assert.equal(await service.verify(receipt), false); }
  finally { await rm(dir, { recursive: true, force: true }); }
});
test('20,100,256 node rendering fixtures retain engine validation and semantics', async () => {
  for (const count of [20, 100, 256]) { const fixture = createPerformanceFixture(count); const result = await runCircuit(fixture.circuit, fixture.input); assert.equal(result.nodes.length, count); assert.equal(result.outputs[`node-${count - 1}`].truth, 'TRUE'); }
});
