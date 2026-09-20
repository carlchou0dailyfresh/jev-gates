import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { createDeliveryService, createDeliveryApi } from '../workbench/server/delivery-api.mjs';
import { fixtureMatrix } from '../workbench/server/delivery-core.mjs';
const scenario = JSON.parse(await fs.readFile(new URL('../workbench/delivery-scenario.json', import.meta.url), 'utf8'));
const health = async () => ({ localjev: { available: false }, typesafe: { configured: false } });
function maps(overrides = {}) { return { health: () => ({ osrm: true, googleConfigured: false }), matrix: async draft => ({ ...fixtureMatrix(draft), provenance: { provider: 'fixture', traffic: false, label: 'test' }, metrics: { requests: 1, elements: 49, elapsedMs: 2 } }), geometry: async () => ({ coordinates: [], provenance: { provider: 'fixture' }, metrics: { requests: 1, elements: 0, elapsedMs: 1 } }), ...overrides }; }
const request = planId => ({ planId, events: scenario.events, mode: 'fixture', thresholds: { falseAt: .2, trueAt: .8 }, prices: {} });

test('delivery API preserves an immutable matrix/draft for comparison and totals actual map metrics', async () => {
  const service = createDeliveryService({ maps: maps(), health });
  const draft = structuredClone(scenario.draft);
  const plan = await service.plan({ draft, provider: 'fixture' });
  assert.equal(plan.metrics.requests, 2); assert.equal(plan.metrics.elements, 49);
  assert.equal(plan.plan.feasible, true); assert.equal(plan.comparisonAllowed, true);
  assert.equal(plan.matrix.durations, undefined);
  draft.capacity = 1; plan.draft.capacity = 2;
  const report = await service.compare(request(plan.id));
  assert.equal(report.draft.capacity, scenario.draft.capacity);
  assert.equal(report.actual.mapRequests, 0);
  assert.equal(report.strategies.find(s => s.id === 'stacked').replans, 4);
});
test('delivery invalid coordinates/provider/unknown input cannot make map calls', async () => {
  let calls = 0; const service = createDeliveryService({ maps: maps({ matrix: () => { calls++; throw new Error('unexpected'); } }) });
  const draft = structuredClone(scenario.draft); draft.stops[0].lat = 100;
  await assert.rejects(service.plan({ draft, provider: 'osrm' }), /緯度/);
  await assert.rejects(service.plan({ draft: scenario.draft, provider: 'https://internal/' }), /來源/);
  await assert.rejects(service.plan({ draft: scenario.draft, provider: 'fixture', url: 'http://private' }), /欄位/);
  assert.equal(calls, 0);
});
test('Google response is for immediate display and has no replay snapshot', async () => {
  const service = createDeliveryService({ maps: maps() });
  const plan = await service.plan({ draft: scenario.draft, provider: 'google' });
  assert.equal(plan.comparisonAllowed, false);
  await assert.rejects(service.compare(request(plan.id)), /不支援保存比較/);
});
test('expired snapshot fails instead of comparing new data to old route', async () => {
  let now = 0; const service = createDeliveryService({ maps: maps(), now: () => now });
  const plan = await service.plan({ draft: scenario.draft, provider: 'fixture' }); now = 600001;
  await assert.rejects(service.compare(request(plan.id)), /過期/);
});
test('failed geometry preserves attempted requests without inventing a straight road', async () => {
  const service = createDeliveryService({ maps: maps({ geometry: async () => { const e = new Error('network failed'); e.metrics = { requests: 1, elements: 0, elapsedMs: 100 }; throw e; } }) });
  const plan = await service.plan({ draft: scenario.draft, provider: 'osrm' });
  assert.equal(plan.metrics.requests, 2); assert.deepEqual(plan.geometry.coordinates, []);
  assert.match(plan.geometryError, /形狀抓取失敗/); assert.equal(plan.plan.feasible, true);
});
test('unreachable plan never asks for a nonexistent route geometry', async () => {
  let called = false;
  const service = createDeliveryService({ maps: maps({ matrix: async draft => { const m = fixtureMatrix(draft); m.durations[0] = m.durations[0].map((_, i) => i === 0 ? 0 : null); return { ...m, metrics: { requests: 1, elements: 49, elapsedMs: 1 } }; }, geometry: async () => { called = true; } }) });
  const plan = await service.plan({ draft: scenario.draft, provider: 'osrm' });
  assert.equal(plan.plan.feasible, false); assert.equal(plan.plan.distanceMeters, null); assert.equal(called, false);
});
test('delivery HTTP boundary rejects cross-origin, oversized bodies and wrong methods', async t => {
  const server = http.createServer(createDeliveryApi({ maps: maps(), health }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/delivery/config`)).status, 200);
  assert.equal((await fetch(`${base}/api/delivery/config`, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/delivery/plan`)).status, 405);
  assert.equal((await fetch(`${base}/api/delivery/plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ oversized: 'x'.repeat(70000) }) })).status, 413);
});
