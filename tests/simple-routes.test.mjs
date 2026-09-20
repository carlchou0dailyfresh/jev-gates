import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSimpleRoutesService, createSimpleRoutesApi } from '../workbench/server/simple-routes.mjs';

const NOW = Date.parse('2026-09-20T03:00:00Z');
const origin = { name: '台北車站', lat: 25.0468, lng: 121.5172 };
const destination = { name: '台北 101', lat: 25.033, lng: 121.5654 };
const baseCoordinates = [[121.5172, 25.0468], [121.54, 25.0468], [121.5654, 25.033]];
const alternateCoordinates = [[121.5172, 25.0468], [121.54, 25.035], [121.5654, 25.033]];
const mapPayload = { code: 'Ok', routes: [
  { distance: 7000, duration: 900, geometry: { type: 'LineString', coordinates: baseCoordinates } },
  { distance: 7800, duration: 1100, geometry: { type: 'LineString', coordinates: alternateCoordinates } },
] };
const liveEvent = (id = 'road-event') => ({ id, title: '路線車道管制', text: '這段路線車道管制，請注意。', lat: 25.0468, lng: 121.54, sourceUrl: 'https://rtr.pbs.gov.tw/', updatedAt: new Date(NOW - 1000).toISOString(), startAt: new Date(NOW - 1000).toISOString(), endAt: new Date(NOW + 3600000).toISOString(), freshness: 'recent', locationQuality: 'reported_point', credibility: 'reported', active: 'active' });
function eventsProvider(events = [], overrides = {}) { return { health: () => ({ provider: 'test' }), fetch: async () => ({ status: 'available', events, provenance: { provider: 'test', fetchedAt: new Date(NOW).toISOString() }, metrics: { requests: 1 }, warnings: [], ...overrides }) }; }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function service(options = {}) { return createSimpleRoutesService({ fetchImpl: async () => json(mapPayload), now: () => NOW, env: {}, eventsProvider: eventsProvider(), health: async () => ({ available: true, model: 'test-local', upstreamModel: 'test' }), ...options }); }
const truth = value => async (_input, config) => { config.onRequest(2); return { truth: value, model: 'test-local' }; };

test('minimal config has six public landmarks and route defaults without model network calls', () => {
  const value = service({ fetchImpl: () => { throw new Error('not expected'); } }).config();
  assert.equal(value.presets.length, 6); assert.equal(value.defaults.origin.name, origin.name); assert.equal(value.defaults.destination.name, destination.name);
  assert.equal(value.sources.search.provider, 'photon'); assert.equal(value.limits.searchManualOnly, true);
});
test('route input rejects unknown fields, foreign coordinates and identical endpoints before networking', async () => {
  let calls = 0; const s = service({ fetchImpl: () => { calls++; throw new Error('unexpected'); } });
  await assert.rejects(s.plan({ origin, destination, endpoint: 'https://evil.example' }), /欄位/);
  await assert.rejects(s.plan({ origin, destination: { ...destination, lat: 48.85 } }), /台北/);
  await assert.rejects(s.plan({ origin, destination: origin }), /相同/);
  await assert.rejects(s.plan({ origin, destination, mode: 'untrusted' }), /模式/);
  assert.equal(calls, 0);
});
test('OSRM alternatives and cache preserve actual geometry, original fetch time and request counts', async () => {
  let clock = NOW, calls = 0; const s = service({ now: () => clock, fetchImpl: async url => { calls++; assert.match(String(url), /alternatives=3&geometries=geojson/); return json({ ...mapPayload, routes: [...mapPayload.routes, ...mapPayload.routes] }); } });
  const first = await s.plan({ origin, destination }); assert.equal(first.routes.length, 3); assert.equal(first.metrics.mapRequests, 1);
  clock += 1000; const second = await s.plan({ origin, destination }); assert.equal(second.metrics.mapRequests, 0); assert.equal(second.provenance.maps.cached, true);
  assert.equal(second.provenance.maps.fetchedAt, first.provenance.maps.fetchedAt); assert.equal(calls, 1); assert.deepEqual(second.routes[0].coordinates, baseCoordinates);
});
test('failed route fetch never invents geometry or retains stale cache', async () => {
  let clock = NOW, failing = false; const s = service({ now: () => clock, fetchImpl: async () => { if (failing) throw new Error('secret upstream'); return json(mapPayload); } });
  await s.plan({ origin, destination }); clock += 61000; failing = true;
  const failed = await s.plan({ origin, destination }); assert.equal(failed.summary.state, 'unavailable'); assert.deepEqual(failed.routes, []); assert.equal(failed.metrics.mapRequests, 1); assert.doesNotMatch(JSON.stringify(failed), /secret upstream/);
});
test('live missing feed or incomplete event validity preserves baseline and UNKNOWN rather than safe', async () => {
  const missing = await service({ eventsProvider: eventsProvider([], { status: 'unavailable' }) }).plan({ origin, destination });
  assert.equal(missing.summary.state, 'review'); assert.equal(missing.routes[0].selected, true);
  const event = { ...liveEvent(), endAt: null, active: 'unknown' };
  const unknownTime = await service({ eventsProvider: eventsProvider([event]), semantic: truth('TRUE') }).plan({ origin, destination });
  assert.equal(unknownTime.events[0].truth, 'TRUE'); assert.equal(unknownTime.events[0].status, 'review'); assert.match(unknownTime.events[0].reason, /結束時間/);
  assert.equal(unknownTime.summary.state, 'review'); assert.equal(unknownTime.routes[0].selected, true);
});
test('stale, unknown and future source updates are excluded before route display, health or model work', async () => {
  const events = [
    { ...liveEvent('yesterday'), updatedAt: new Date(NOW - 86400_000).toISOString() },
    { ...liveEvent('stale'), updatedAt: new Date(NOW - 900_001).toISOString() },
    { ...liveEvent('future'), updatedAt: new Date(NOW + 1).toISOString() },
    { ...liveEvent('unknown'), updatedAt: null },
  ];
  const result = await service({ eventsProvider: eventsProvider(events), health: () => { throw new Error('health must not run'); }, semantic: () => { throw new Error('model must not run'); } }).plan({ origin, destination });
  assert.deepEqual(result.events, []); assert.equal(result.metrics.modelRequests, 0); assert.equal(result.summary.state, 'review');
  assert.match(result.summary.title, /沒有符合時效/); assert.match(result.summary.detail, /不代表/);
  assert.deepEqual(result.provenance.events.freshness.excluded, { stale: 2, unknown: 1, future: 1, total: 4 });
  assert.equal(result.provenance.events.routeFreshness.eligibleCount, 0);
});
test('stale history cannot consume the display or model quota ahead of a recent event', async () => {
  const events = [...Array.from({ length: 30 }, (_, i) => ({ ...liveEvent(`old-${i}`), updatedAt: new Date(NOW - 86400_000).toISOString() })), liveEvent('current')];
  const result = await service({ eventsProvider: eventsProvider(events), semantic: truth('UNKNOWN') }).plan({ origin, destination });
  assert.deepEqual(result.events.map(event => event.id), ['current']); assert.equal(result.events[0].truth, 'UNKNOWN');
  assert.equal(result.metrics.modelRequests, 1); assert.equal(result.metrics.omittedEvents, 0);
  assert.equal(result.provenance.events.freshness.excluded.stale, 30); assert.equal(result.provenance.events.freshness.scope, 'source_feed');
  assert.equal(result.provenance.events.routeFreshness.scope, 'candidate_routes');
});
test('event expiry while a model runs removes its result and affected route IDs before response', async () => {
  let clock = NOW;
  const result = await service({ now: () => clock, eventsProvider: eventsProvider([{ ...liveEvent(), updatedAt: new Date(NOW - 899_000).toISOString() }]), semantic: async (_input, config) => {
    config.onRequest(2); clock += 1001; return { truth: 'TRUE', model: 'test' };
  } }).plan({ origin, destination });
  assert.deepEqual(result.events, []); assert.equal(result.metrics.modelRequests, 1);
  assert.equal(result.routes[0].selected, true); assert.ok(result.routes.every(route => route.affectedEventIds.length === 0));
  assert.equal(result.summary.state, 'review'); assert.equal(result.provenance.events.freshness.excluded.stale, 1);
  assert.equal(result.provenance.events.routeFreshness.expiredDuringEvaluationCount, 1);
});
test('event expiry during readiness skips inference and never returns the now-stale report', async () => {
  let clock = NOW, inferred = 0;
  const result = await service({ now: () => clock, eventsProvider: eventsProvider([{ ...liveEvent(), updatedAt: new Date(NOW - 899_000).toISOString() }]),
    health: async () => { clock += 1001; return { available: true }; }, semantic: () => { inferred++; throw new Error('must not infer'); },
  }).plan({ origin, destination });
  assert.equal(inferred, 0); assert.equal(result.metrics.modelRequests, 0); assert.deepEqual(result.events, []);
});
test('a cached semantic answer cannot keep an event current beyond the source cutoff', async () => {
  let clock = NOW, inferred = 0;
  const s = service({ now: () => clock, eventsProvider: eventsProvider([{ ...liveEvent(), updatedAt: new Date(NOW - 899_000).toISOString() }]), semantic: async (_input, config) => { inferred++; config.onRequest(2); return { truth: 'TRUE' }; } });
  const first = await s.plan({ origin, destination }); assert.equal(first.events.length, 1); assert.equal(inferred, 1);
  clock += 1001; const next = await s.plan({ origin, destination });
  assert.deepEqual(next.events, []); assert.equal(inferred, 1); assert.equal(next.metrics.cachedSemantic, 0); assert.equal(next.summary.state, 'review');
});
test('an empty valid source feed stays review and does not promise clear roads', async () => {
  const result = await service().plan({ origin, destination });
  assert.equal(result.provenance.events.status, 'available'); assert.equal(result.provenance.events.freshness.status, 'no_recent_events');
  assert.equal(result.summary.state, 'review'); assert.match(result.summary.detail, /不代表/);
});
test('precise current event and TRUE select only a less affected acquired route', async () => {
  const value = await service({ eventsProvider: eventsProvider([liveEvent()]), semantic: truth('TRUE') }).plan({ origin, destination });
  assert.equal(value.summary.state, 'adjusted'); assert.equal(value.routes[1].selected, true); assert.deepEqual(value.routes[1].coordinates, alternateCoordinates);
  assert.deepEqual(value.routes[0].affectedEventIds, ['road-event']); assert.equal(value.metrics.modelRequests, 1); assert.equal(value.metrics.modelQuestions, 2);
});
test('UNKNOWN, FALSE and shared report points do not auto-route', async () => {
  for (const answer of ['UNKNOWN', 'FALSE']) {
    const result = await service({ eventsProvider: eventsProvider([liveEvent()]), semantic: truth(answer) }).plan({ origin, destination });
    assert.equal(result.routes[0].selected, true); assert.equal(result.events[0].truth, answer);
  }
  const result = await service({ eventsProvider: eventsProvider([{ ...liveEvent(), locationQuality: 'shared_point' }]), semantic: () => { throw new Error('must not infer'); } }).plan({ origin, destination });
  assert.equal(result.events[0].truth, 'UNKNOWN'); assert.equal(result.metrics.modelRequests, 0); assert.match(result.events[0].reason, /位置/);
});
test('an affected baseline with no unaffected acquired alternative stays review', async () => {
  const one = { ...mapPayload, routes: [mapPayload.routes[0]] };
  const result = await service({ fetchImpl: async () => json(one), eventsProvider: eventsProvider([liveEvent()]), semantic: truth('TRUE') }).plan({ origin, destination });
  assert.equal(result.routes.length, 1); assert.equal(result.routes[0].selected, true); assert.equal(result.summary.state, 'review'); assert.match(result.summary.detail, /不代表可以通行/);
});
test('one event is assessed against its nearest candidate only; parallel nearby candidates stay uncertain', async () => {
  const close = { ...mapPayload, routes: [mapPayload.routes[0], { ...mapPayload.routes[1], geometry: { type: 'LineString', coordinates: baseCoordinates.map(([lng, lat]) => [lng, lat + .0001]) } }] };
  const result = await service({ fetchImpl: async () => json(close), eventsProvider: eventsProvider([liveEvent()]), semantic: async (input, config) => {
    assert.equal(input.routes.length, 1); assert.equal(input.routes[0].id, 'route-1'); config.onRequest(2); return { truth: 'TRUE', model: 'test' };
  } }).plan({ origin, destination });
  assert.equal(result.events[0].matchedRouteId, 'route-1'); assert.equal(result.events[0].ambiguousRouteMatch, true);
  assert.deepEqual(result.routes[1].affectedEventIds, []); assert.equal(result.routes[0].selected, true); assert.equal(result.summary.state, 'review');
});
test('all candidates affected, omitted nearby events and future events cannot produce a ready detour', async () => {
  const second = { ...liveEvent('alternate-event'), lat: 25.035 };
  const allAffected = await service({ eventsProvider: eventsProvider([liveEvent(), second]), semantic: truth('TRUE') }).plan({ origin, destination });
  assert.equal(allAffected.routes.every(r => r.affectedEventIds.length > 0), true); assert.equal(allAffected.summary.state, 'review'); assert.equal(allAffected.routes[0].selected, true);
  const omitted = await service({ eventsProvider: eventsProvider(Array.from({ length: 21 }, (_, i) => liveEvent(`many-${i}`))), semantic: truth('FALSE') }).plan({ origin, destination });
  assert.equal(omitted.events.length, 20); assert.equal(omitted.metrics.omittedEvents, 1); assert.equal(omitted.summary.state, 'review'); assert.match(omitted.warnings.at(-1), /1 則/);
  const future = await service({ eventsProvider: eventsProvider([{ ...liveEvent(), startAt: new Date(NOW + 60000).toISOString() }]), semantic: () => { throw new Error('future must not reach inference'); } }).plan({ origin, destination });
  assert.equal(future.metrics.modelRequests, 0); assert.equal(future.events[0].truth, 'UNKNOWN');
});
test('semantic work is bounded to three changed events; changing observed age does not repeat inference', async () => {
  let clock = NOW; const items = [0, 1, 2, 3].map(i => ({ ...liveEvent(`event-${i}`), ageMinutes: 1 }));
  const s = service({ now: () => clock, eventsProvider: eventsProvider(items), semantic: truth('TRUE') });
  const first = await s.plan({ origin, destination }); assert.equal(first.metrics.modelRequests, 3); assert.equal(first.metrics.modelQuestions, 6); assert.equal(first.events[3].truth, 'UNKNOWN');
  // Make only the observational age change: the first three content hashes remain equal.
  items.forEach(item => { item.ageMinutes = 2; }); clock += 120000;
  const next = await s.plan({ origin, destination }); assert.equal(next.metrics.cachedSemantic, 3); assert.equal(next.metrics.modelRequests, 1);
  items[0].text = '新報告內容'; clock += 120000; const changed = await s.plan({ origin, destination }); assert.equal(changed.metrics.modelRequests, 1); assert.equal(changed.metrics.cachedSemantic, 3);
});
test('local health failure and inference failure have correct attempted counts and no cloud fallback', async () => {
  const items = [liveEvent('one'), liveEvent('two')];
  const unavailable = await service({ eventsProvider: eventsProvider(items), health: async () => ({ available: false }), semantic: () => { throw new Error('must not run'); } }).plan({ origin, destination });
  assert.equal(unavailable.metrics.modelRequests, 0); assert.equal(unavailable.summary.state, 'review');
  let attempts = 0; const failed = await service({ eventsProvider: eventsProvider(items), semantic: async (_, config) => { attempts++; config.onRequest(2); throw new Error('secret failure'); } }).plan({ origin, destination });
  assert.equal(attempts, 1); assert.equal(failed.metrics.modelRequests, 1); assert.equal(failed.metrics.modelQuestions, 2); assert.equal(failed.events.every(e => e.truth === 'UNKNOWN'), true); assert.doesNotMatch(JSON.stringify(failed), /secret failure/);
});
test('demo has explicit synthetic events and zero model/feed calls but never synthetic roads', async () => {
  const result = await service({ eventsProvider: { health: () => ({}), fetch: () => { throw new Error('no feed'); } }, semantic: () => { throw new Error('no inference'); } }).plan({ origin, destination, mode: 'demo' });
  assert.equal(result.summary.state, 'adjusted'); assert.equal(result.routes[1].selected, true); assert.deepEqual(result.routes[1].coordinates, alternateCoordinates);
  assert.equal(result.metrics.eventRequests, 0); assert.equal(result.metrics.modelRequests, 0); assert.equal(result.provenance.events.synthetic, true); assert.match(result.summary.detail, /不是即時/);
});
test('manual Photon searches use TW bbox, safe shape, at most five results and cache', async () => {
  let count = 0; const feature = (lat = 25.1015744, code = 'TW') => ({ geometry: { type: 'Point', coordinates: [121.5488623, lat] }, properties: { countrycode: code, osm_type: 'W', osm_id: '827791918', name: '國立故宮博物院', city: '臺北市', district: '士林區', street: '至善路二段', housenumber: '221' } });
  const s = service({ fetchImpl: async raw => { const url = new URL(raw); count++; assert.equal(url.hostname, 'photon.komoot.io'); assert.equal(url.searchParams.get('countrycode'), 'TW'); assert.equal(url.searchParams.get('limit'), '5'); assert.equal(url.searchParams.get('bbox'), '121.45,24.95,121.67,25.22'); return json({ type: 'FeatureCollection', features: [feature(48), feature(25, 'DE'), ...Array.from({ length: 7 }, () => feature())] }); } });
  const first = await s.search({ query: '國立故宮博物院' }); assert.equal(first.places.length, 5); assert.equal(first.places[0].lat, 25.1015744);
  const second = await s.search({ query: '國立故宮博物院' }); assert.equal(second.metrics.requests, 0); assert.equal(second.provenance.cached, true); assert.equal(count, 1);
  const preset = await s.search({ query: '台北車站' }); assert.equal(preset.provenance.provider, 'presets'); assert.equal(count, 1);
  await assert.rejects(s.search({ query: '故宮', url: 'http://private' }), /欄位/);
});
test('public place searches are limited to one start per second', async () => {
  let clock = NOW; const times = []; const s = service({ now: () => clock, sleep: async ms => { clock += ms; }, fetchImpl: async () => { times.push(clock); return json({ type: 'FeatureCollection', features: [] }); } });
  await s.search({ query: '第一地點' }); await s.search({ query: '第二地點' }); assert.equal(times[1] - times[0], 1000);
});
test('HTTP boundary rejects foreign origin, methods and oversized bodies', async t => {
  const server = http.createServer(createSimpleRoutesApi({ eventsProvider: eventsProvider(), env: {} }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/routes/config`)).status, 200);
  assert.equal((await fetch(`${base}/api/routes/config`, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/routes/plan`)).status, 405);
  assert.equal((await fetch(`${base}/api/routes/plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: 'a'.repeat(18000) }) })).status, 413);
});
