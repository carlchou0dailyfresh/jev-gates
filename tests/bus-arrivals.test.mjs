import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import http from 'node:http';
import { createBusArrivalsService, createBusArrivalsApi, parseBusSourceTime, parseBusEstimate, busFreshness, BUS_SOURCES } from '../workbench/server/bus-arrivals.mjs';
const NOW = Date.parse('2026-09-20T00:40:50Z');
const stamp = '2026/09/20 08:40:45';
const wrap = (rows, time = stamp) => ({ EssentialInfo: { UpdateTime: time }, BusInfo: rows });
const route = { Id: 11411, nameZh: '299', departureZh: '新莊', destinationZh: '永春高中' };
const outbound = { Id: 10175, routeId: 11411, nameZh: '臺北車站(忠孝)', latitude: '25.04625', longitude: '121.517', goBack: '0', address: '捷運臺北車站M6出口(向東)' };
const inbound = { ...outbound, Id: 10242, goBack: '1', longitude: '121.514', address: '忠孝西路1段72號對面(向西)' };
const estimate = { RouteID: 11411, StopID: 10175, EstimateTime: '450', GoBack: '0' };
const selection = { stopId: '10175', routeId: '11411', direction: '0' };
const datasets = overrides => ({ stops: wrap([outbound, inbound]), routes: wrap([route]), estimates: wrap([estimate]), ...overrides });
const response = body => new Response(gzipSync(Buffer.from(JSON.stringify(body))), { headers: { 'content-type': 'application/octet-stream', 'last-modified': 'Sun, 20 Sep 2026 00:40:46 GMT' } });
function setup(overrides = {}, options = {}) {
  let clock = NOW; const calls = []; const data = datasets(overrides);
  const service = createBusArrivalsService({ now: () => clock, sleep: async ms => { clock += ms; }, fetchImpl: async (url, init) => { calls.push(url); assert.equal(init.redirect, 'error'); assert.match(init.headers['user-agent'], /JEV-Bus-Studio/); const kind = Object.keys(BUS_SOURCES).find(k => BUS_SOURCES[k] === url); assert.ok(kind); return response(data[kind]); }, ...options });
  return { service, data, calls, advance: ms => { clock += ms; } };
}

test('bus timestamps use Taiwan time and reject calendar rollover, malformed and absent time', () => {
  assert.equal(parseBusSourceTime(stamp), '2026-09-20T00:40:45.000Z');
  for (const value of ['2026/02/30 12:00:00', '2026/09/20 24:00:00', '2026-09-20 08:40:45', null]) assert.equal(parseBusSourceTime(value), null);
  assert.equal(busFreshness(parseBusSourceTime(stamp), NOW).state, 'fresh');
  assert.equal(busFreshness(parseBusSourceTime(stamp), NOW + 120000).state, 'stale');
  assert.equal(busFreshness(new Date(NOW + 6000).toISOString(), NOW).state, 'future');
  assert.equal(busFreshness(new Date(NOW + 1).toISOString(), NOW).state, 'future');
  assert.equal(busFreshness(new Date(NOW).toISOString(), NOW).state, 'fresh');
  assert.equal(busFreshness(null, NOW).state, 'unknown');
});
test('provider ETA seconds, zero and all four negative status codes retain distinct meaning', () => {
  assert.equal(parseBusEstimate('450').seconds, 450); assert.equal(parseBusEstimate('0').seconds, 0);
  const labels = ['尚未發車', '交管不停靠', '末班車已過', '今日未營運'];
  for (let i = 1; i <= 4; i++) { const result = parseBusEstimate(String(-i)); assert.equal(result.seconds, null); assert.equal(result.label, labels[i - 1]); }
  for (const invalid of ['abc', '', '-5', 'Infinity', 450, '90000']) assert.equal(parseBusEstimate(invalid).status, 'unknown');
});
test('config is network-free and manual stop lookup keeps official stop/route/direction identifiers', async () => {
  const { service, calls } = setup(); const config = service.config(); assert.equal(calls.length, 0); assert.equal(config.requiresKey, false); assert.equal(config.examples.length, 3); assert.equal(config.limits.maxAutoRefreshes, 10);
  const found = await service.stops({ query: '台北車站' }); assert.equal(found.stops.length, 2); assert.deepEqual(found.stops.map(x => x.direction), ['0', '1']);
  assert.equal(found.stops[0].routeId, '11411'); assert.equal(found.stops[0].destination, '永春高中'); assert.equal(found.stops[1].destination, '新莊'); assert.equal(calls.length, 2);
  assert.equal((await service.stops({ query: 'M6出口' })).stops[0].id, '10175'); assert.equal(calls.length, 2);
});
test('nearby station search is geographic and rejects invalid/private endpoint inputs before network', async () => {
  const { service, calls } = setup();
  await assert.rejects(service.stops({ query: '台北', url: 'https://example.com' }), /欄位/); await assert.rejects(service.stops({ lat: 48, lng: 2 }), /台北/); assert.equal(calls.length, 0);
  const result = await service.stops({ lat: 25.04625, lng: 121.517 }); assert.equal(result.stops[0].id, '10175'); assert.equal(result.stops[0].distanceMeters, 0);
});
test('space-separated station and route tokens narrow official results without changing literal matching', async () => {
  const extraRoute = { ...route, Id: 22222, nameZh: '22' };
  const { service } = setup({ routes: wrap([route, extraRoute]), stops: wrap([outbound, inbound, { ...outbound, Id: 33333, routeId: 22222 }]) });
  assert.equal((await service.stops({ query: '台北車站' })).stops.length, 3);
  const filtered = await service.stops({ query: '臺北車站　２９９' });
  assert.equal(filtered.total, 2); assert.equal(filtered.stops.every(stop => stop.routeName === '299'), true);
  const specific = await service.stops({ query: '臺北車站(忠孝) 299 M6出口' });
  assert.equal(specific.stops.length, 1); assert.equal(specific.stops[0].id, '10175');
  assert.equal((await service.stops({ query: '臺北車站 999' })).total, 0);
});
test('fresh matching source estimate passes real jev-gates rules and AND with no model requests', async () => {
  const { service } = setup(); const result = await service.arrivals(selection);
  assert.equal(result.arrivals[0].etaSeconds, 450); assert.equal(result.truth, 'TRUE'); assert.equal(result.gates.every(g => g.truth === 'TRUE'), true); assert.equal(result.metrics.modelRequests, 0);
  assert.equal(result.provenance.sourceUpdatedAt, '2026-09-20T00:40:45.000Z'); assert.equal(result.provenance.semanticModelUsed, false); assert.equal(result.evidence.timestampScope, 'feed_snapshot_only');
});
test('stale, future or absent source time never passes an ETA, even with a fresh fetch timestamp', async () => {
  for (const time of ['2026/09/20 08:30:00', '2026/09/20 08:50:00', undefined]) {
    const value = wrap([estimate]); value.EssentialInfo.UpdateTime = time;
    const { service } = setup({ estimates: value }); const result = await service.arrivals(selection);
    assert.equal(result.arrivals[0].etaSeconds, null); assert.notEqual(result.truth, 'TRUE'); assert.notEqual(result.freshness.state, 'fresh');
  }
});
test('ETA GoBack must agree with selected official station direction, not merely share its name', async () => {
  const { service } = setup({ estimates: wrap([{ ...estimate, GoBack: '1' }]) });
  const result = await service.arrivals(selection); assert.equal(result.arrivals[0].etaSeconds, null); assert.equal(result.truth, 'FALSE'); assert.match(result.arrivals[0].label, /不一致/);
  await assert.rejects(service.arrivals({ ...selection, direction: '1' }), /不符/);
  await assert.rejects(service.arrivals({ ...selection, routeId: '999' }), /不符/);
});
test('special GoBack and negative estimates are not converted to live arrival minutes', async () => {
  for (const code of ['-1', '-2', '-3', '-4']) {
    const { service } = setup({ estimates: wrap([{ ...estimate, EstimateTime: code, GoBack: '2' }]) }); const result = await service.arrivals(selection);
    assert.equal(result.arrivals[0].etaSeconds, null); assert.equal(result.arrivals[0].label, parseBusEstimate(code).label);
  }
  const result = await setup({ estimates: wrap([{ ...estimate, GoBack: '2' }]) }).service.arrivals(selection);
  assert.equal(result.arrivals[0].etaSeconds, null); assert.equal(result.gates.find(g => g.id === 'directionMatched').truth, 'UNKNOWN');
});
test('missing and conflicting arrival records remain unknown; identical duplicates are harmless', async () => {
  const conflict = await setup({ estimates: wrap([estimate, { ...estimate, EstimateTime: '600' }]) }).service.arrivals(selection);
  assert.equal(conflict.arrivals[0].etaSeconds, null); assert.match(conflict.arrivals[0].label, /衝突/);
  const absent = await setup({ estimates: wrap([{ ...estimate, StopID: 999 }]) }).service.arrivals(selection); assert.equal(absent.arrivals[0].etaSeconds, null); assert.match(absent.arrivals[0].label, /沒有/);
  const duplicate = await setup({ estimates: wrap([estimate, estimate]) }).service.arrivals(selection); assert.equal(duplicate.arrivals[0].etaSeconds, 450); assert.equal(duplicate.evidence.uniqueRows, 1);
});
test('static and ETA caches preserve source and fetched timestamps; source age is recomputed', async () => {
  const { service, calls, advance } = setup(); const first = await service.arrivals(selection); advance(1000); const second = await service.arrivals(selection);
  assert.equal(calls.length, 3); assert.equal(second.metrics.requests, 0); assert.equal(second.provenance.fetchedAt, first.provenance.fetchedAt); assert.ok(second.freshness.ageSeconds > first.freshness.ageSeconds);
  advance(16000); const third = await service.arrivals(selection); assert.equal(third.metrics.requests, 1); assert.equal(calls.length, 4); assert.equal(third.provenance.sourceUpdatedAt, first.provenance.sourceUpdatedAt);
});
test('old or unknown station catalogue cannot authorize ETA despite a fresh estimate', async () => {
  const old = await setup({ stops: wrap([outbound], '2026/09/16 08:00:00') }).service.arrivals(selection); assert.equal(old.arrivals[0].etaSeconds, null);
  const missing = wrap([outbound]); missing.EssentialInfo.UpdateTime = null;
  const unknown = await setup({ stops: missing }).service.arrivals(selection); assert.equal(unknown.gates.find(g => g.id === 'catalogCurrent').truth, 'UNKNOWN'); assert.equal(unknown.arrivals[0].etaSeconds, null);
});
test('gzip body/decompression limits, malformed schema and transport errors never create mock arrivals', async () => {
  for (const responseFn of [() => { throw new Error('secret token'); }, () => new Response('oops'), () => response({ BusInfo: [] }), () => new Response(gzipSync(Buffer.alloc(17 * 1024 * 1024, 65)))]) {
    const { service } = setup({}, { fetchImpl: async () => responseFn() }); const result = await service.arrivals(selection);
    assert.equal(result.summary.state, 'unavailable'); assert.deepEqual(result.arrivals, []); assert.equal(result.truth, 'UNKNOWN'); assert.doesNotMatch(JSON.stringify(result), /secret token/);
  }
});
test('cancellation and deadlines complete even when transport ignores abort', async () => {
  const pre = new AbortController(); pre.abort(); let calls = 0;
  const s = createBusArrivalsService({ fetchImpl: () => { calls++; return new Promise(() => {}); }, timeoutMs: 10 });
  await assert.rejects(s.stops({ query: '台北車站' }, pre.signal), /取消/); assert.equal(calls, 0);
  const { service } = setup({}, { timeoutMs: 10, fetchImpl: () => new Promise(() => {}) }); const result = await service.arrivals(selection); assert.equal(result.summary.state, 'unavailable');
});
test('bus API enforces loopback origin, methods and body limit', async t => {
  const server = http.createServer(createBusArrivalsApi()); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/bus/config`)).status, 200); assert.equal((await fetch(`${base}/api/bus/config`, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/bus/arrivals`)).status, 405);
  assert.equal((await fetch(`${base}/api/bus/stops`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'a'.repeat(9000) }) })).status, 413);
});
