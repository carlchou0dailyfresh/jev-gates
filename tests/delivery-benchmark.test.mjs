import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { compareDelivery, validateComparison, verifyDeliveryComparison } from '../workbench/server/delivery-benchmark.mjs';
import { fixtureMatrix, solveDelivery } from '../workbench/server/delivery-core.mjs';
import { evaluateDraft } from '../workbench/server/api.mjs';
import { createDeliveryService } from '../workbench/server/delivery-api.mjs';

const copy = value => structuredClone(value);
const scenario = {
  draft: {
    depot: { id: 'depot', name: '演練出發地', lat: 25.05, lng: 121.52 },
    stops: [
      { id: 'a', name: '甲地', lat: 25.06, lng: 121.53, earliest: 540, latest: 900, serviceMinutes: 5, demand: 1 },
      { id: 'b', name: '乙地', lat: 25.04, lng: 121.55, earliest: 540, latest: 900, serviceMinutes: 5, demand: 1 },
    ],
    departureMinutes: 540, capacity: 3, returnToDepot: true,
  },
  events: [
    { id: 'thanks', kind: 'note', text: '謝謝，辛苦了。', expectedRefresh: false },
    { id: 'duplicate', kind: 'note', text: '謝謝，辛苦了。', expectedRefresh: false, duplicateOf: 'thanks' },
    { id: 'entrance', kind: 'note', text: '甲地入口臨時關閉，尚未確認新座標；請先確認。', expectedRefresh: true },
    { id: 'window', kind: 'structured', text: '甲地最晚服務時間調整為 10:00。', expectedRefresh: true, patch: { stopId: 'a', latest: 600 } },
  ],
};

function snapshot(draft = scenario.draft) {
  const matrix = { ...fixtureMatrix(draft), metrics: { requests: 0, elements: 0, elapsedMs: 0 } };
  return { id: 'saved-plan', draft: copy(draft), matrix, plan: solveDelivery(draft, matrix), createdAt: '2026-09-20T00:00:00.000Z' };
}
function body(patch = {}) {
  return { planId: 'saved-plan', events: copy(scenario.events), mode: 'fixture', thresholds: { falseAt: 0.2, trueAt: 0.8 }, prices: {}, ...patch };
}
const policy = (report, id) => report.strategies.find(strategy => strategy.id === id);
const outcomes = report => report.strategies.map(strategy => ({ id: strategy.id, steps: strategy.steps.map(({ eventId, decision, truth }) => ({ eventId, decision, truth })), order: strategy.finalPlan.order, feasible: strategy.finalPlan.feasible }));
const ready = async () => Response.json({ ready: true, upstreamModel: 'bounded-test-provider' });
function provider(score, onCall = () => {}) {
  return { name: 'local-test', model: 'test-model', async evaluate(_state, questions) {
    onCall(questions);
    return { model: 'test-model', answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'noul', noul: score }])) };
  } };
}

test('delivery benchmark shares a matrix, isolates real map calls, and deduplicates every non-always policy', async () => {
  const saved = snapshot(); const before = JSON.stringify(saved);
  const report = await compareDelivery(saved, body(), { scenario, semanticOrder: ['single', 'stacked'] });
  assert.equal(report.actual.mapRequests, 0);
  assert.equal(report.actual.modelRequests, 0);
  assert.equal(report.actual.modelQuestions, 0);
  assert.equal(policy(report, 'always').replans, 5);
  assert.equal(policy(report, 'rules').replans, 4);
  assert.equal(policy(report, 'single').replans, 3);
  assert.equal(policy(report, 'stacked').replans, 3);
  for (const id of ['rules', 'single', 'stacked']) {
    const duplicate = policy(report, id).steps.find(step => step.eventId === 'duplicate');
    assert.equal(duplicate.decision, 'skip');
    assert.equal(duplicate.semanticRecord, null);
  }
  for (const strategy of report.strategies) assert.equal(strategy.mapRefreshDecisions, strategy.replans);
  assert.equal(JSON.stringify(saved), before);
  assert.match(report.warnings.join('\n'), /Fixture.*教學標記/);
  assert.match(report.warnings.join('\n'), /不是.*標籤/);
  assert.match(report.warnings.join('\n'), /不是帳單/);
  assert.equal(policy(report, 'single').estimatedCostUsd, null);
});

test('delivery structured changes bypass semantic veto and free text never changes coordinates or windows', async () => {
  const saved = snapshot(); let requestCount = 0;
  const report = await compareDelivery(saved, body({ mode: 'localjev' }), {
    scenario, semanticOrder: ['single', 'stacked'],
    evaluatorOptions: { fetch: ready, makeProvider: () => provider(0.05, () => { requestCount++; }) },
  });
  assert.equal(requestCount, 4);
  assert.equal(report.actual.modelRequests, 4);
  assert.equal(report.actual.modelQuestions, 6);
  const updated = copy(saved.draft); updated.stops[0].latest = 600;
  const expected = solveDelivery(updated, saved.matrix);
  for (const strategy of report.strategies) {
    const update = strategy.steps.find(step => step.eventId === 'window');
    assert.equal(update.decision, 'refresh');
    assert.equal(update.semanticRecord, null);
    assert.deepEqual(strategy.finalPlan.order, expected.order);
    assert.equal(strategy.finalPlan.totalMinutes, expected.totalMinutes);
  }
  assert.equal(policy(report, 'single').steps.find(step => step.eventId === 'entrance').truth, 'FALSE');
  assert.equal(policy(report, 'single').missedRefreshes, 1);
  assert.deepEqual(report.draft, scenario.draft);
});

test('delivery UNKNOWN triggers conservative replanning without being called a provider failure', async () => {
  const report = await compareDelivery(snapshot(), body({ mode: 'localjev' }), {
    scenario, evaluatorOptions: { fetch: ready, makeProvider: () => provider(0.5) },
  });
  for (const id of ['single', 'stacked']) {
    const strategy = policy(report, id);
    assert.equal(strategy.errors, 0);
    for (const eventId of ['thanks', 'entrance']) {
      const step = strategy.steps.find(item => item.eventId === eventId);
      assert.equal(step.truth, 'UNKNOWN');
      assert.equal(step.decision, 'refresh');
      assert.equal(step.evaluationStatus, 'evaluated');
    }
  }
});

test('delivery provider not-ready does not claim a model request, and later notes stop calling it', async () => {
  let madeProviders = 0;
  const report = await compareDelivery(snapshot(), body({ mode: 'localjev' }), {
    scenario, evaluatorOptions: { fetch: async () => Response.json({ ready: false }), makeProvider: () => { madeProviders++; return provider(0.05); } },
  });
  assert.equal(madeProviders, 0);
  assert.equal(report.actual.modelRequests, 0);
  assert.equal(report.actual.modelQuestions, 0);
  for (const id of ['single', 'stacked']) {
    const strategy = policy(report, id);
    assert.equal(strategy.steps[0].evaluationStatus, 'failed');
    assert.equal(strategy.steps[0].decision, 'refresh');
    assert.equal(strategy.steps[1].decision, 'skip');
    assert.equal(strategy.steps[2].evaluationStatus, 'not_run');
    assert.equal(strategy.steps[2].decision, 'refresh');
    assert.equal(strategy.steps[3].decision, 'refresh');
    assert.equal(strategy.modelRequests, 0);
  }
});

test('delivery attempted provider calls that fail are counted once, with conservative fallback', async () => {
  let attempts = 0;
  const report = await compareDelivery(snapshot(), body({ mode: 'localjev' }), {
    scenario, evaluatorOptions: { fetch: ready, makeProvider: () => ({ name: 'test-failure', model: 'test', async evaluate() { attempts++; throw new Error('transport unavailable'); } }) },
  });
  assert.equal(attempts, 2);
  assert.equal(report.actual.modelRequests, 2);
  assert.equal(report.actual.modelQuestions, 3);
  for (const id of ['single', 'stacked']) {
    assert.equal(policy(report, id).modelRequests, 1);
    assert.equal(policy(report, id).steps[2].evaluationStatus, 'not_run');
  }
});

test('delivery edited full draft drops teaching labels, including a newly no-op structured event', async () => {
  const changed = copy(scenario.draft); changed.stops[0].latest = 600;
  const report = await compareDelivery(snapshot(changed), body(), { scenario });
  for (const strategy of report.strategies) {
    assert.equal(strategy.labelledEvents, 0);
    assert.equal(strategy.unlabelledEvents, 4);
    assert.equal(strategy.missedRefreshes, null);
    assert.equal(strategy.falseRefreshes, null);
    assert.ok(strategy.steps.every(step => step.expectedRefresh === null));
  }
  for (const id of ['rules', 'single', 'stacked']) assert.equal(policy(report, id).steps[3].decision, 'skip');
});

test('delivery cannot turn edited event wording into labelled quality evidence by setting expectedRefresh', async () => {
  const events = [{ ...scenario.events[0], text: '甲地地址改變，請確認。', expectedRefresh: false }];
  const report = await compareDelivery(snapshot(), body({ events }), { scenario });
  for (const strategy of report.strategies) {
    assert.equal(strategy.labelledEvents, 0);
    assert.equal(strategy.steps[0].expectedRefresh, null);
  }
  assert.equal(policy(report, 'single').steps[0].truth, 'UNKNOWN');
  assert.equal(policy(report, 'single').steps[0].decision, 'refresh');
});

test('delivery exact duplicate content is recognized without trusting duplicateOf metadata', async () => {
  const events = [scenario.events[0], { ...scenario.events[1], duplicateOf: 'not-an-event' }];
  const report = await compareDelivery(snapshot(), body({ events }), { scenario });
  for (const id of ['rules', 'single', 'stacked']) assert.equal(policy(report, id).steps[1].decision, 'skip');
  assert.equal(policy(report, 'always').steps[1].decision, 'refresh');
});

test('delivery counterfactual cost uses solver time, not model/network waiting time', async () => {
  const prices = { mapRequestUsd: 0, mapElementUsd: 0, semanticQuestionUsd: 0, cpuSecondUsd: 1000 };
  const report = await compareDelivery(snapshot(), body({ events: [scenario.events[0]], prices }), {
    scenario,
    evaluate: async (draft, mode) => { await new Promise(resolve => setTimeout(resolve, 18)); return evaluateDraft(draft, mode); },
  });
  for (const strategy of report.strategies) assert.ok(Math.abs(strategy.estimatedCostUsd - strategy.solverMs) < 1e-9);
  for (const id of ['single', 'stacked']) {
    const strategy = policy(report, id);
    assert.ok(strategy.semanticMs >= 12);
    assert.ok(strategy.estimatedCostUsd < strategy.totalMs);
  }
  assert.match(report.warnings.join('\n'), /不是CPU用量/);
});

test('delivery model policy evaluation order does not change deterministic decisions or final plans', async () => {
  const first = await compareDelivery(snapshot(), body(), { scenario, semanticOrder: ['single', 'stacked'] });
  const second = await compareDelivery(snapshot(), body(), { scenario, semanticOrder: ['stacked', 'single'] });
  assert.deepEqual(outcomes(first), outcomes(second));
  assert.deepEqual(first.semanticOrder, ['single', 'stacked']);
  assert.deepEqual(second.semanticOrder, ['stacked', 'single']);
});

test('delivery cancellation or expired budget prevents starting model work', async () => {
  let evaluations = 0;
  const evaluate = async () => { evaluations++; throw new Error('should not execute'); };
  const controller = new AbortController(); controller.abort();
  await assert.rejects(compareDelivery(snapshot(), body(), { scenario, evaluate, signal: controller.signal }), /取消/);
  await assert.rejects(compareDelivery(snapshot(), body(), { scenario, evaluate, now: () => 1000, deadlineMs: 0 }), /總時限/);
  assert.equal(evaluations, 0);
});

test('delivery rejects free-text coordinate patches and invalid structural updates', async () => {
  assert.throws(() => validateComparison(body({ events: [{ id: 'bad', kind: 'note', text: '請改位置', patch: { stopId: 'a', latest: 600 } }] }), scenario.draft));
  assert.throws(() => validateComparison(body({ events: [{ id: 'bad', kind: 'structured', text: '請改位置', patch: { stopId: 'a', latest: 600, lat: 26 } }] }), scenario.draft));
  await assert.rejects(compareDelivery(snapshot(), body({ events: [{ id: 'bad', kind: 'structured', text: '時間變更', patch: { stopId: 'a', latest: 500 } }] }), { scenario }), /時間窗/);
});

test('delivery valid report replays offline and a changed checksum is rejected', async () => {
  const productionSample = JSON.parse(await readFile(new URL('../workbench/delivery-scenario.json', import.meta.url), 'utf8'));
  const report = await compareDelivery(snapshot(productionSample.draft), body({ events: productionSample.events }));
  const originalFetch = globalThis.fetch; let networkCalls = 0;
  try {
    globalThis.fetch = async () => { networkCalls++; throw new Error('Replay must be offline'); };
    const result = await verifyDeliveryComparison(report);
    assert.equal(result.valid, true);
    assert.equal(result.offline, true);
    assert.equal(networkCalls, 0);
  } finally { globalThis.fetch = originalFetch; }
  const tampered = copy(report); tampered.prices.cpuSecondUsd = 99;
  await assert.rejects(verifyDeliveryComparison(tampered), /checksum/);
  const changedDecision = copy(report);
  changedDecision.strategies[0].steps[0].decision = 'skip';
  delete changedDecision.checksum;
  changedDecision.checksum = createHash('sha256').update(JSON.stringify(changedDecision)).digest('hex');
  await assert.rejects(verifyDeliveryComparison(changedDecision), /分流|不一致/);
  const changedPlan = copy(report);
  changedPlan.strategies[0].finalPlan.order.reverse();
  delete changedPlan.checksum;
  changedPlan.checksum = createHash('sha256').update(JSON.stringify(changedPlan)).digest('hex');
  await assert.rejects(verifyDeliveryComparison(changedPlan), /路線|不一致/);
});

test('delivery API snapshots remain independent of caller mutation and expire without map refresh during comparison', async () => {
  let clock = 0; let matrices = 0, geometries = 0;
  const maps = {
    health: () => ({ osrm: true, googleConfigured: false }),
    async matrix(draft) { matrices++; return { ...fixtureMatrix(draft), metrics: { requests: 0, elements: 0, elapsedMs: 0 } }; },
    async geometry() { geometries++; return { coordinates: [], provenance: { provider: 'fixture' }, metrics: { requests: 0, elements: 0, elapsedMs: 0 } }; },
  };
  const service = createDeliveryService({ maps, scenario, now: () => clock });
  const input = copy(scenario.draft);
  const planned = await service.plan({ draft: input, provider: 'fixture' });
  input.stops[0].latest = 550; planned.draft.stops[0].latest = 551;
  const report = await service.compare(body({ planId: planned.id }));
  assert.equal(report.draft.stops[0].latest, 900);
  assert.equal(report.actual.mapRequests, 0);
  assert.equal(matrices, 1); assert.equal(geometries, 1);
  clock = 600_001;
  await assert.rejects(service.compare(body({ planId: planned.id })), /過期/);
});
