import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createEtaComparisonService, createEtaComparisonApi } from '../workbench/server/eta-comparison-api.mjs';
const NOW = Date.parse('2026-09-20T02:00:00Z');
const response = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const osrm = { code: 'Ok', routes: [{ duration: 555.5, distance: 7463.4 }] };
const google = { routes: [{ duration: '680.25s', distanceMeters: 7600 }] };
const car = { scenarioId: 'car-station-101' };
const outbound = { id: '10175', name: '臺北車站(忠孝)', lat: 25.04625, lng: 121.517, routeId: '11411', routeName: '299', direction: '0', destination: '永春高中' };
const inbound = { ...outbound, id: '10242', direction: '1', destination: '新莊' };
const cityhall = { id: '10923', name: '捷運市政府站', lat: 25.040991, lng: 121.565249, routeId: '10292', routeName: '藍10', direction: '0', destination: '南港花園社區' };
function busService(overrides = {}) {
  return { stops: async ({ query }) => ({ summary: { state: 'ready' }, stops: query.includes('藍10') ? [cityhall] : [outbound, inbound], omitted: 0, metrics: { requests: 2 } }),
    arrivals: async selection => ({ truth: 'TRUE', arrivals: [{ ...selection, etaSeconds: 450 }], freshness: { state: 'fresh', sourceUpdatedAt: new Date(NOW - 4000).toISOString() }, provenance: { fetchedAt: new Date(NOW).toISOString(), sourceUpdatedAt: new Date(NOW - 4000).toISOString() }, gates: [], metrics: { requests: 1 }, summary: { title: '約 8 分鐘（來源預估）' } }), ...overrides };
}
function service(options = {}) { let clock = NOW; return createEtaComparisonService({ now: () => clock, sleep: async ms => { clock += ms; }, env: {}, busService: busService(), fetchImpl: async () => response(osrm), ...options }); }

test('comparison config is network-free, has three car/three waiting cases and exposes only key presence', () => {
  const s = service({ env: { GOOGLE_MAPS_API_KEY: 'test-hidden-key' }, fetchImpl: () => { throw new Error('must not fetch'); } }); const config = s.config();
  assert.equal(config.scenarios.filter(s => s.kind === 'car').length, 3); assert.equal(config.scenarios.filter(s => s.kind === 'bus_wait').length, 3);
  assert.equal(config.google.configured, true); assert.equal(config.google.automaticCalls, false); assert.equal(config.google.maxRequestsPerObservation, 1); assert.doesNotMatch(JSON.stringify(config), /test-hidden-key/);
});
test('missing Google key still obtains OSRM, with honest unavailable and a driving Maps URL', async () => {
  let calls = 0; const result = await service({ fetchImpl: async url => { calls++; assert.equal(new URL(url).hostname, 'router.project-osrm.org'); return response(osrm); } }).observe(car);
  assert.equal(calls, 1); assert.equal(result.metrics.googleRequests, 0); assert.equal(result.observations[0].valueSeconds, 555.5);
  const missing = result.observations[1]; assert.equal(missing.status, 'unavailable'); assert.equal(missing.reasonCode, 'not_configured'); assert.equal(missing.valueSeconds, null);
  const link = new URL(result.googleMapsUrl); assert.equal(link.searchParams.get('origin'), '25.0468,121.5172'); assert.equal(link.searchParams.get('travelmode'), 'driving');
  assert.equal(result.pairing.accuracyMeasured, false); assert.equal(result.pairing.samePathVerified, false);
});
test('one explicit car observation pairs same endpoints and requests only Google duration/distance/fallback', async () => {
  const calls = []; const result = await service({ env: { GOOGLE_MAPS_API_KEY: 'test-hidden-key' }, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (String(url).includes('googleapis')) {
      assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error'); assert.equal(init.headers['X-Goog-Api-Key'], 'test-hidden-key');
      assert.equal(init.headers['X-Goog-FieldMask'], 'routes.duration,routes.distanceMeters,fallbackInfo');
      const body = JSON.parse(init.body); assert.equal(body.travelMode, 'DRIVE'); assert.equal(body.routingPreference, 'TRAFFIC_AWARE_OPTIMAL'); assert.equal(body.computeAlternativeRoutes, false);
      assert.deepEqual(body.origin.location.latLng, { latitude: 25.0468, longitude: 121.5172 }); assert.equal(body.departureTime, undefined);
      return response({ ...google, polyline: 'must-not-forward' });
    }
    assert.match(String(url), /overview=false&steps=false&alternatives=false/); return response(osrm);
  } }).observe(car);
  assert.equal(calls.length, 2); assert.equal(result.metrics.googleRequests, 1); assert.equal(result.metrics.osrmRequests, 1); assert.equal(result.metrics.modelRequests, 0);
  assert.equal(result.observations[1].valueSeconds, 680.25); assert.equal(result.observations[1].trafficAware, true); assert.equal(result.observations[0].trafficAware, false);
  assert.equal(result.observations[1].sourceUpdatedAt, null); assert.equal(result.pairing.startSkewMs, 0);
  assert.doesNotMatch(JSON.stringify(result), /test-hidden-key|must-not-forward|encodedPolyline/);
});
test('Google observations are not cached or written by the service, and every new explicit action counts', async () => {
  let googleCalls = 0; const s = service({ env: { GOOGLE_MAPS_API_KEY: 'test' }, fetchImpl: async url => { if (String(url).includes('googleapis')) { googleCalls++; return response(google); } return response(osrm); } });
  const first = await s.observe(car), second = await s.observe(car);
  assert.equal(googleCalls, 2); assert.equal(first.metrics.googleRequests, 1); assert.equal(second.metrics.googleRequests, 1);
  assert.equal(second.observations[1].retention, 'display_only_no_cache_or_export');
});
test('fallback, missing route, invalid duration and HTTP failures never become accepted Google values', async () => {
  for (const body of [{ ...google, fallbackInfo: { reason: 'LATENCY_EXCEEDED' } }, { routes: [] }, { routes: [{ duration: '-1s', distanceMeters: 1 }] }, { routes: [{ duration: '4s', distanceMeters: '5' }] }]) {
    const result = await service({ env: { GOOGLE_MAPS_API_KEY: 'test' }, fetchImpl: async url => response(String(url).includes('googleapis') ? body : osrm) }).observe(car);
    assert.equal(result.observations[1].status, 'unavailable'); assert.equal(result.observations[1].valueSeconds, null); assert.equal(result.metrics.googleRequests, 1); assert.equal(result.observations[0].status, 'available');
  }
  let calls = 0; const failed = await service({ env: { GOOGLE_MAPS_API_KEY: 'private' }, fetchImpl: async url => { if (String(url).includes('googleapis')) { calls++; throw new Error('private secret endpoint'); } return response(osrm); } }).observe(car);
  assert.equal(calls, 1); assert.doesNotMatch(JSON.stringify(failed), /private secret/);
});
test('OSRM invalid response leaves its estimate unknown without suppressing independent Google result', async () => {
  const result = await service({ env: { GOOGLE_MAPS_API_KEY: 'test' }, fetchImpl: async url => response(String(url).includes('googleapis') ? google : { code: 'NoRoute' }) }).observe(car);
  assert.equal(result.observations[0].valueSeconds, null); assert.equal(result.observations[1].valueSeconds, 680.25); assert.equal(result.metrics.osrmRequests, 1);
});
test('bus cases resolve current official IDs by exact name, route and direction then fetch waiting ETA', async () => {
  for (const [scenarioId, expected] of [['bus-station-299-outbound', outbound], ['bus-station-299-inbound', inbound], ['bus-cityhall-blue10-outbound', cityhall]]) {
    let selection;
    const bus = busService(); const original = bus.arrivals; bus.arrivals = async value => { selection = value; return original(value); };
    const result = await service({ env: { GOOGLE_MAPS_API_KEY: 'test-key-must-not-be-used' }, busService: bus, fetchImpl: () => { throw new Error('no Google or OSRM in bus wait'); } }).observe({ scenarioId });
    assert.deepEqual(selection, { stopId: expected.id, routeId: expected.routeId, direction: expected.direction });
    assert.equal(result.observations.length, 1); assert.equal(result.observations[0].quantity, 'bus_wait'); assert.equal(result.observations[0].valueSeconds, 450);
    assert.equal(result.metrics.googleRequests, 0); assert.equal(result.metrics.busRequests, 3); assert.equal(result.manualReference.stopId, expected.id);
    assert.ok(result.manualReference.requiredConfirmations.includes('waiting_time_only')); assert.equal(new URL(result.googleMapsUrl).pathname, '/maps/search/');
  }
});
test('ambiguous, missing or truncated official station matches never guess an ID', async () => {
  for (const found of [{ stops: [] }, { stops: [outbound, { ...outbound, id: '99999' }] }, { stops: [outbound], omitted: 1 }]) {
    let arrivalsCalls = 0; const result = await service({ busService: busService({ stops: async () => ({ summary: { state: 'ready' }, metrics: { requests: 2 }, ...found }), arrivals: async () => { arrivalsCalls++; throw new Error('must not call'); } }) }).observe({ scenarioId: 'bus-station-299-outbound' });
    assert.equal(arrivalsCalls, 0); assert.equal(result.observations[0].valueSeconds, null); assert.equal(result.metrics.busRequests, 2);
  }
});
test('bus stale timestamp or identity mismatch is withheld even if injected upstream says TRUE', async () => {
  for (const change of [value => { value.freshness.sourceUpdatedAt = new Date(NOW - 121000).toISOString(); }, value => { value.arrivals[0].direction = '1'; }, value => { value.arrivals[0].routeId = 'wrong'; }, value => { value.freshness.sourceUpdatedAt = new Date(NOW + 1000).toISOString(); }]) {
    const original = busService(); const bus = busService({ arrivals: async selection => { const value = await original.arrivals(selection); change(value); return value; } });
    const result = await service({ busService: bus }).observe({ scenarioId: 'bus-station-299-outbound' }); assert.equal(result.observations[0].valueSeconds, null);
  }
});
test('invalid selections, arbitrary URLs and pre-cancelled observations do not make network requests', async () => {
  let calls = 0; const s = service({ fetchImpl: () => { calls++; throw new Error('unexpected'); } });
  await assert.rejects(s.observe({ scenarioId: 'not-a-scenario' }), /找不到/); await assert.rejects(s.observe({ ...car, url: 'https://internal.example' }), /欄位/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(s.observe(car, controller.signal), /取消/); assert.equal(calls, 0);
});
test('bounded response and timeout errors cannot forward bodies or synthesize estimates', async () => {
  const oversized = await service({ fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1)) }).observe(car); assert.equal(oversized.observations[0].valueSeconds, null);
  const timeout = await service({ timeoutMs: 10, fetchImpl: () => new Promise(() => {}) }).observe(car); assert.equal(timeout.observations[0].status, 'unavailable'); assert.equal(timeout.metrics.osrmRequests, 1);
});
test('HTTP comparison boundary is same-origin, POST-only, bounded and never polls on config', async t => {
  let calls = 0; const api = createEtaComparisonApi({ env: {}, fetchImpl: async () => { calls++; return response(osrm); }, busService: busService() }); const server = http.createServer(api);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/compare/config`)).status, 200); assert.equal(calls, 0);
  assert.equal((await fetch(`${base}/api/compare/config`, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/compare/observe`)).status, 405);
  assert.equal((await fetch(`${base}/api/compare/observe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenarioId: 'a'.repeat(5000) }) })).status, 413);
  const observed = await fetch(`${base}/api/compare/observe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(car) }); assert.equal(observed.status, 200); assert.equal(calls, 1); assert.equal(observed.headers.get('cache-control'), 'no-store');
});
