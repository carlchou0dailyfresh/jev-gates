import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createDeliveryMaps } from '../workbench/server/delivery-maps.mjs';

const draft = () => ({
  depot: { id: 'depot', name: '配送站', lat: 25.0478, lng: 121.517 },
  stops: [
    { id: 'A', name: '合成站點 A', lat: 25.041, lng: 121.532, earliest: 480, latest: 720, serviceMinutes: 5, demand: 1 },
    { id: 'B', name: '合成站點 B', lat: 25.034, lng: 121.564, earliest: 480, latest: 720, serviceMinutes: 5, demand: 1 },
  ], departureMinutes: 480, capacity: 10, returnToDepot: true,
});
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const table = () => ({ code: 'Ok', data_version: '2026-09-01T00:00:00Z', durations: [[0, 40.5, 80], [35, 0, 20], [70, 25, 0]], distances: [[0, 500, 900], [450, 0, 300], [880, 320, 0]] });
const route = () => ({ code: 'Ok', routes: [{ geometry: { type: 'LineString', coordinates: [[121.517, 25.0478], [121.532, 25.041], [121.564, 25.034], [121.517, 25.0478]] } }] });
function googleCells() {
  return Array.from({ length: 3 }, (_, i) => Array.from({ length: 3 }, (_, j) => ({ originIndex: i, destinationIndex: j, status: {}, condition: 'ROUTE_EXISTS', distanceMeters: i === j ? 0 : 100, duration: i === j ? '0s' : '45.123s' }))).flat().reverse();
}
async function withGoogle(fn) {
  const previous = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = 'test-key-never-return';
  try { await fn(); }
  finally { if (previous === undefined) delete process.env.GOOGLE_MAPS_API_KEY; else process.env.GOOGLE_MAPS_API_KEY = previous; }
}

test('delivery fixtures use zero network and state that geometry is a straight-line demonstration', async () => {
  const maps = createDeliveryMaps({ fetchImpl: () => { throw new Error('network forbidden'); }, now: () => 1_700_000_000_000 });
  const matrix = await maps.matrix(draft(), 'fixture');
  assert.equal(matrix.durations.length, 3);
  assert.equal(matrix.durations[0][0], 0);
  assert.equal(matrix.provenance.traffic, false);
  assert.equal(matrix.metrics.requests, 0);
  const geometry = await maps.geometry(draft(), ['B', 'A'], 'fixture');
  assert.deepEqual(geometry.coordinates, [[121.517, 25.0478], [121.564, 25.034], [121.532, 25.041], [121.517, 25.0478]]);
  assert.match(geometry.provenance.label, /直線/);
});

test('OSRM matrix preserves asymmetric seconds/metres and sends only fixed-origin coordinates', async () => {
  let request;
  const maps = createDeliveryMaps({ fetchImpl: async (url, init) => { request = { url, init }; return response(table()); } });
  const result = await maps.matrix(draft(), 'osrm');
  const url = new URL(request.url);
  assert.equal(url.origin, 'https://router.project-osrm.org');
  assert.equal(url.pathname, '/table/v1/driving/121.517,25.0478;121.532,25.041;121.564,25.034');
  assert.equal(url.searchParams.get('annotations'), 'duration,distance');
  assert.equal(request.init.redirect, 'error');
  assert.match(request.init.headers['User-Agent'], /JEV-Delivery-Studio/);
  assert.equal(result.durations[0][1], 40.5);
  assert.equal(result.durations[1][0], 35);
  assert.equal(result.provenance.traffic, false);
  assert.match(result.provenance.label, /no_live_traffic/);
  assert.equal(result.provenance.dataVersion, '2026-09-01T00:00:00Z');
  assert.deepEqual({ requests: result.metrics.requests, elements: result.metrics.elements }, { requests: 1, elements: 9 });
});

test('OSRM cache has 60-second TTL, immutable values and actual per-operation request counts', async () => {
  let time = 1_700_000_000_000, calls = 0;
  const maps = createDeliveryMaps({ now: () => time, fetchImpl: async () => { calls++; return response(table()); } });
  const first = await maps.matrix(draft(), 'osrm'); first.durations[0][1] = 999;
  time += 59_999;
  const hit = await maps.matrix(draft(), 'osrm');
  assert.equal(calls, 1); assert.equal(hit.durations[0][1], 40.5);
  assert.equal(hit.provenance.cached, true); assert.equal(hit.provenance.fetchedAt, first.provenance.fetchedAt);
  assert.equal(hit.metrics.requests, 0); assert.equal(hit.metrics.elements, 0);
  time++;
  const fresh = await maps.matrix(draft(), 'osrm');
  assert.equal(calls, 2); assert.equal(fresh.provenance.cached, false);
});

test('OSRM keeps at most 32 entries and does not reuse failed or forced stale refreshes', async () => {
  let time = 1_700_000_000_000, calls = 0, fail = false;
  const maps = createDeliveryMaps({ now: () => time, fetchImpl: async () => { calls++; return fail ? response({ error: 'upstream secret' }, 503) : response(table()); } });
  for (let i = 0; i < 33; i++) { const input = draft(); input.depot.lat += i / 1000; time += 1001; await maps.matrix(input, 'osrm'); }
  time += 1001; await maps.matrix(draft(), 'osrm');
  assert.equal(calls, 34, 'the oldest entry must have been evicted');
  fail = true; time += 1001;
  await assert.rejects(maps.matrix(draft(), 'osrm', true), /沒有自動重試/);
  fail = false; time += 1001;
  const retry = await maps.matrix(draft(), 'osrm');
  assert.equal(calls, 36); assert.equal(retry.provenance.cached, false);
});

test('OSRM matrix and route requests start at least one second apart', async () => {
  const starts = [];
  const maps = createDeliveryMaps({ fetchImpl: async url => { starts.push(performance.now()); return response(url.includes('/table/') ? table() : route()); } });
  await Promise.all([maps.matrix(draft(), 'osrm'), maps.geometry(draft(), ['A', 'B'], 'osrm')]);
  assert.equal(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 980, `observed start spacing ${starts[1] - starts[0]}ms`);
});

test('OSRM routing keeps the specified stop order and optional return without an optimizer', async () => {
  let requested;
  const maps = createDeliveryMaps({ fetchImpl: async url => { requested = new URL(url); return response(route()); } });
  const input = draft(); input.returnToDepot = false;
  const result = await maps.geometry(input, ['B', 'A'], 'osrm');
  assert.equal(requested.pathname, '/route/v1/driving/121.517,25.0478;121.564,25.034;121.532,25.041');
  assert.equal(requested.searchParams.get('geometries'), 'geojson');
  assert.equal(result.coordinates.length, 4);
  assert.equal(result.metrics.requests, 1); assert.equal(result.metrics.elements, 1);
});

test('invalid input, incomplete route orders, missing cells and non-finite map values fail explicitly', async t => {
  for (const bad of [-1, '20']) await t.test(`invalid matrix value ${bad}`, async () => {
    const payload = table(); payload.durations[0][1] = bad;
    const maps = createDeliveryMaps({ fetchImpl: async () => response(payload) });
    await assert.rejects(maps.matrix(draft(), 'osrm'), /矩陣/);
  });
  const maps = createDeliveryMaps({ fetchImpl: async () => response({ ...table(), distances: [[0]] }) });
  await assert.rejects(maps.matrix(draft(), 'osrm'), /維度/);
  await assert.rejects(maps.matrix({ ...draft(), depot: { ...draft().depot, lng: 'https://private/' } }, 'osrm'), /座標/);
  await assert.rejects(maps.matrix(draft(), 'https://private/'), /來源/);
  await assert.rejects(maps.geometry(draft(), ['A', 'A'], 'fixture'), /順序/);
  await assert.rejects(maps.geometry(draft(), ['A'], 'fixture'), /順序/);
  await assert.rejects(maps.matrix({ ...draft(), stops: Array(8).fill(draft().stops[0]) }, 'osrm'), /1–7/);
});

test('OSRM null cells remain explicit unreachable edges rather than being guessed or replaced', async () => {
  const payload = table(); payload.durations[0][1] = null; payload.distances[0][1] = null;
  const maps = createDeliveryMaps({ fetchImpl: async () => response(payload) });
  const result = await maps.matrix(draft(), 'osrm');
  assert.equal(result.durations[0][1], null); assert.equal(result.distances[0][1], null);
  assert.equal(result.durations[0][0], 0);
  const invalid = createDeliveryMaps({ fetchImpl: async () => new Response('{"code":"Ok","durations":[[0,NaN]],"distances":[[0,0]]}') });
  await assert.rejects(invalid.matrix(draft(), 'osrm'), /JSON/);
});

test('Google traffic matrix is opt-in, rejects missing keys, uses field masks and never returns a key', async () => {
  const previous = process.env.GOOGLE_MAPS_API_KEY; delete process.env.GOOGLE_MAPS_API_KEY;
  const calls = [];
  const maps = createDeliveryMaps({ now: () => 1_700_000_000_000, fetchImpl: async (url, init) => { calls.push({ url, init }); return response(googleCells()); } });
  try {
    assert.equal(maps.health().googleConfigured, false);
    await assert.rejects(maps.matrix(draft(), 'google'), /未設定|尚未設定/);
    assert.equal(calls.length, 0);
    process.env.GOOGLE_MAPS_API_KEY = 'test-key-never-return';
    assert.equal(maps.health().googleConfigured, true);
    const result = await maps.matrix(draft(), 'google');
    assert.equal(calls[0].url, 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix');
    assert.equal(calls[0].init.headers['X-Goog-Api-Key'], 'test-key-never-return');
    assert.match(calls[0].init.headers['X-Goog-FieldMask'], /status/);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.routingPreference, 'TRAFFIC_AWARE_OPTIMAL');
    assert.equal(body.travelMode, 'DRIVE');
    assert.equal(body.origins.length * body.destinations.length, 9);
    assert.equal(body.departureTime, undefined, 'Google defaults to request time, not the scenario clock');
    assert.equal(result.durations[0][0], 0); assert.equal(result.distances[0][0], 0);
    assert.equal(result.durations[1][2], 45.123);
    assert.equal(result.provenance.traffic, true);
    assert.equal(result.provenance.departureTime, new Date(1_700_000_000_000).toISOString());
    assert.equal(JSON.stringify(result).includes('test-key'), false);
    assert.equal(result.metrics.elements, 9);
    await maps.matrix(draft(), 'google'); assert.equal(calls.length, 2, 'Google results must not enter the OSRM cache');
  } finally { if (previous === undefined) delete process.env.GOOGLE_MAPS_API_KEY; else process.env.GOOGLE_MAPS_API_KEY = previous; }
});

test('Google matrix rejects missing/duplicate cells, status errors and traffic fallback', async t => {
  await withGoogle(async () => {
    const cases = [
      ['missing', cells => cells.slice(1)],
      ['duplicate', cells => { cells[0] = cells[1]; return cells; }],
      ['status', cells => { cells[0].status = { code: 7, message: 'test-key-never-return' }; return cells; }],
      ['missing status', cells => { delete cells[0].status; return cells; }],
      ['not found', cells => { cells[0].condition = 'ROUTE_NOT_FOUND'; return cells; }],
      ['fallback', cells => { cells[0].fallbackInfo = { routingMode: 'FALLBACK_TRAFFIC_UNAWARE' }; return cells; }],
      ['duration', cells => { cells[0].duration = '-1s'; return cells; }],
      ['index', cells => { cells[0].originIndex = 3; return cells; }],
    ];
    for (const [label, change] of cases) await t.test(label, async () => {
      const maps = createDeliveryMaps({ fetchImpl: async () => response(change(googleCells())) });
      await assert.rejects(maps.matrix(draft(), 'google'), error => error.name === 'DeliveryMapsError' && !error.message.includes('test-key'));
    });
  });
});

test('Google geometry is an additional request, preserves fixed ordering and uses GeoJSON', async () => {
  await withGoogle(async () => {
    let request;
    const maps = createDeliveryMaps({ fetchImpl: async (url, init) => { request = { url, init }; return response({ routes: [{ polyline: { geoJsonLinestring: route().routes[0].geometry } }] }); } });
    const result = await maps.geometry(draft(), ['B', 'A'], 'google');
    const body = JSON.parse(request.init.body);
    assert.equal(request.url, 'https://routes.googleapis.com/directions/v2:computeRoutes');
    assert.equal(body.optimizeWaypointOrder, false);
    assert.equal(body.polylineEncoding, 'GEO_JSON_LINESTRING');
    assert.equal(body.intermediates[0].location.latLng.longitude, 121.564);
    assert.equal(body.intermediates[1].location.latLng.longitude, 121.532);
    assert.equal(body.destination.location.latLng.longitude, draft().depot.lng);
    assert.equal(result.coordinates.length, 4);
    assert.equal(result.metrics.requests, 1); assert.equal(result.metrics.elements, 1);
    assert.equal(JSON.stringify(result).includes('test-key'), false);
  });
});

test('map transport errors, malformed/oversized bodies and invalid route geometry never trigger fallback or retry', async t => {
  for (const [label, getResponse] of [
    ['HTTP failure', () => response({ key: 'secret' }, 429)],
    ['bad JSON', () => new Response('not JSON')],
    ['declared too large', () => new Response('{}', { headers: { 'content-length': '1048577' } })],
    ['stream too large', () => new Response('x'.repeat(1048577))],
    ['transport', () => { throw new Error('secret credential in upstream error'); }],
  ]) await t.test(label, async () => {
    let requests = 0;
    const maps = createDeliveryMaps({ fetchImpl: async () => { requests++; return getResponse(); } });
    await assert.rejects(maps.matrix(draft(), 'osrm'), error => error.name === 'DeliveryMapsError' && !error.message.includes('secret')
      && error.metrics.requests === 1 && error.metrics.elements === 9 && error.metrics.elapsedMs >= 0);
    assert.equal(requests, 1);
  });
  const maps = createDeliveryMaps({ fetchImpl: async () => response({ code: 'Ok', routes: [{ geometry: { type: 'LineString', coordinates: [[181, 20], [121, 25]] } }] }) });
  await assert.rejects(maps.geometry(draft(), ['A', 'B'], 'osrm'), error => /座標/.test(error.message) && error.metrics.requests === 1 && error.metrics.elements === 1);
  await assert.rejects(maps.geometry(draft(), ['A'], 'osrm'), error => error.metrics.requests === 0 && error.metrics.elements === 0);
});

test('map deadline still rejects a fetch implementation that ignores AbortSignal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const maps = createDeliveryMaps({ fetchImpl: async () => { calls++; return new Promise(() => {}); } });
  const operation = maps.matrix(draft(), 'osrm');
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const rejected = assert.rejects(operation, error => error.code === 'map_timeout' && error.status === 504);
  t.mock.timers.tick(10_001);
  await rejected; assert.equal(calls, 1);
});
