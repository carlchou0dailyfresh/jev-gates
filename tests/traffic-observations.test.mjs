import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { createTrafficObservations, createTrafficObservationsApi, parseTrafficObservationsXml, TRAFFIC_SOURCE_URL } from '../workbench/server/traffic-observations.mjs';

const NOW = Date.parse('2026-09-20T08:40:00+08:00');
const body = { coordinates: [[121.51, 25.04], [121.53, 25.04]] };
const section = (extra = {}) => {
  const fields = { SectionId: 'S1', SectionName: '測試道路 A&amp;B', AvgSpd: '35.5', MOELevel: '0', StartWgsX: '121.515', StartWgsY: '25.04', EndWgsX: '121.525', EndWgsY: '25.04', ...extra };
  return `<vd:SectionData>${Object.entries(fields).filter(([, value]) => value !== null).map(([key, value]) => `<vd:${key}>${value}</vd:${key}>`).join('')}</vd:SectionData>`;
};
const xml = (time = '2026/09/20T08:39:30', sections = [section()]) => `<?xml version="1.0" encoding="UTF-8"?><vd:ExchangeData xmlns:vd="http://www.iii.org.tw/dax/vd"><vd:ExchangeTime>${time}</vd:ExchangeTime><vd:SectionDataSet>${sections.join('')}</vd:SectionDataSet></vd:ExchangeData>`;
const response = value => new Response(gzipSync(value), { headers: { 'content-type': 'application/gzip' } });
const service = (value = xml(), extra = {}) => createTrafficObservations({ now: () => NOW, fetchImpl: async () => response(value), ...extra });

test('official section fields retain zero speed and missing-data states without inventing values', () => {
  const parsed = parseTrafficObservationsXml(xml(undefined, [section(), section({ SectionId: 'zero', AvgSpd: '0', MOELevel: '2' }), section({ SectionId: 'missing', AvgSpd: null }), section({ SectionId: 'negative', AvgSpd: '-1' }), section({ SectionId: 'invalid-status', MOELevel: '-1' })]));
  assert.equal(parsed.sourceUpdatedAt, '2026-09-20T00:39:30.000Z');
  assert.equal(parsed.observations[0].name, '測試道路 A&B');
  assert.deepEqual(parsed.observations.map(item => item.speedKph), [35.5, 0, null, null, null]);
  assert.deepEqual(parsed.observations.map(item => item.congestionLabel), ['順暢', '壅塞', '無可用觀測', '無可用觀測', '無可用觀測']);
});
test('fixed source, approximate route proximity, at most five and no ETA/model output', async () => {
  let calls = 0;
  const app = service(xml(undefined, Array.from({ length: 7 }, (_, index) => section({ SectionId: `S${index}`, StartWgsY: String(25.04 + index * .0001), EndWgsY: String(25.04 + index * .0001) }))), { fetchImpl: async (url, init) => {
    calls++; assert.equal(url, TRAFFIC_SOURCE_URL); assert.equal(init.redirect, 'error'); assert.equal(init.headers['accept-encoding'], 'identity');
    return response(xml(undefined, Array.from({ length: 7 }, (_, index) => section({ SectionId: `S${index}` }))));
  } });
  const result = await app.nearby(body);
  assert.equal(calls, 1); assert.equal(result.status, 'available'); assert.equal(result.observations.length, 5);
  assert.equal(result.metrics.nearbyCount, 7); assert.equal(result.freshness.ageSeconds, 30);
  assert.equal(result.provenance.timeBasis, 'feed_exchange_not_sensor_observation');
  assert.equal(result.observations[0].matchLabel, '候選路線附近，非確認同一路段');
  assert.ok(!JSON.stringify(result).includes('durationSeconds')); assert.equal(result.eta, undefined);
});
test('no nearby sections is empty availability, not a free-flowing assertion', async () => {
  const result = await service().nearby({ coordinates: [[121.7, 25.2], [121.71, 25.21]] });
  assert.equal(result.status, 'available'); assert.deepEqual(result.observations, []); assert.match(result.message, /不代表道路暢通/);
});
test('invalid route geometry and unknown input fields make no network request', async () => {
  let calls = 0; const app = service(undefined, { fetchImpl: () => { calls++; } });
  for (const request of [{ coordinates: [[0, 0]] }, { coordinates: [[NaN, 25], [121, 25]] }, { coordinates: [[121, 91], [121, 25]] }, { coordinates: Array(2001).fill([121, 25]) }, { ...body, sourceUrl: 'https://evil.example' }]) await assert.rejects(app.nearby(request), /2–2000/);
  assert.equal(calls, 0);
});
test('source-time age boundary is strict and old/future/invalid time never exposes speed', async () => {
  for (const [time, expected] of [['2026/09/20T08:38:00', 'fresh'], ['2026/09/20T08:37:59', 'stale'], ['2026/09/20T08:40:01', 'unknown'], ['2026/02/30T08:40:00', 'unknown'], ['', 'unknown']]) {
    const result = await service(xml(time)).nearby(body);
    assert.equal(result.freshness.state, expected);
    assert.equal(result.observations.length, expected === 'fresh' ? 1 : 0);
    if (expected !== 'fresh') assert.ok(!JSON.stringify(result).includes('speedKph'));
  }
});
test('30-second cache preserves fetch time and rechecks source age on every read', async () => {
  let now = NOW, calls = 0;
  const app = service(undefined, { now: () => now, fetchImpl: async () => { calls++; return response(xml('2026/09/20T08:38:10')); } });
  const first = await app.nearby(body); assert.equal(first.freshness.state, 'fresh');
  now += 20_000;
  const second = await app.nearby(body);
  assert.equal(calls, 1); assert.equal(second.provenance.cached, true); assert.equal(second.metrics.requests, 0);
  assert.equal(second.provenance.fetchedAt, first.provenance.fetchedAt); assert.equal(second.freshness.ageSeconds, 130);
  assert.equal(second.status, 'stale'); assert.deepEqual(second.observations, []);
});
test('failed refresh drops earlier successful observations and failure cooldown makes no new request', async () => {
  let now = NOW, calls = 0;
  const app = service(undefined, { now: () => now, fetchImpl: async () => { if (++calls === 1) return response(xml()); throw new Error('sensitive upstream internals'); } });
  assert.equal((await app.nearby(body)).observations.length, 1); now += 31_000;
  const failed = await app.nearby(body), cached = await app.nearby(body);
  assert.equal(failed.status, 'unavailable'); assert.deepEqual(failed.observations, []); assert.equal(failed.metrics.requests, 1);
  assert.equal(cached.metrics.requests, 0); assert.equal(cached.provenance.cached, true); assert.equal(calls, 2);
  assert.ok(!JSON.stringify(failed).includes('sensitive'));
});
test('empty, duplicate, entity declarations, malformed and excessive sections fail closed', async () => {
  for (const value of [xml(undefined, []), xml(undefined, [section(), section()]), '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>' + xml(), xml().replace('測試道路 A&amp;B', '&unknown;'), xml().replace('<vd:EndWgsY>25.04</vd:EndWgsY>', ''), xml(undefined, Array.from({ length: 2001 }, (_, i) => section({ SectionId: `S${i}` })))]) {
    assert.throws(() => parseTrafficObservationsXml(value));
  }
  const result = await service(xml(undefined, [])).nearby(body);
  assert.equal(result.status, 'unavailable'); assert.deepEqual(result.observations, []);
});
test('invalid section is excluded while valid independent section remains available', () => {
  const result = parseTrafficObservationsXml(xml(undefined, [section(), section({ SectionId: 'bad', StartWgsX: 'invalid' })]));
  assert.equal(result.observations.length, 1); assert.equal(result.recordsReceived, 2); assert.equal(result.excludedRecords, 1);
});
test('compressed, decompressed and HTTP source errors remain bounded and empty', async () => {
  for (const fetchImpl of [async () => new Response('no', { status: 503 }), async () => new Response('x', { headers: { 'content-length': String(600 * 1024) } }), async () => new Response(Buffer.alloc(513 * 1024)), async () => response('x'.repeat(2 * 1024 * 1024 + 1)), async () => new Response('not gzip')]) {
    const result = await service(undefined, { fetchImpl }).nearby(body);
    assert.equal(result.status, 'unavailable'); assert.deepEqual(result.observations, []); assert.equal(result.metrics.requests, 1);
  }
});
test('pre-abort makes no request, active request cancellation frees service, timeout is bounded', async () => {
  let calls = 0; const controller = new AbortController(); controller.abort();
  const app = service(undefined, { fetchImpl: async () => { calls++; return response(xml()); } });
  const before = await app.nearby(body, controller.signal); assert.equal(calls, 0); assert.equal(before.error.code, 'cancelled');
  const active = new AbortController(); const waiting = service(undefined, { fetchImpl: async () => new Promise(() => {}), timeoutMs: 25 });
  const pending = waiting.nearby(body, active.signal); active.abort();
  assert.equal((await pending).error.code, 'cancelled');
  const timeout = await waiting.nearby(body); assert.equal(timeout.error.code, 'source_timeout');
});
test('concurrent service requests reject rather than duplicating source requests', async () => {
  let finish, calls = 0;
  const app = service(undefined, { fetchImpl: async () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const pending = app.nearby(body);
  await assert.rejects(app.nearby(body), error => error.status === 429);
  finish(response(xml())); assert.equal((await pending).status, 'available'); assert.equal(calls, 1);
});
test('HTTP endpoint enforces same origin, POST, bounded JSON and returns a fixture source response', async t => {
  let calls = 0;
  const server = http.createServer(createTrafficObservationsApi({ now: () => NOW, fetchImpl: async () => { calls++; return response(xml()); } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (payload = body, headers = {}) => fetch(origin + '/api/traffic/nearby', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });
  assert.equal((await fetch(origin + '/api/traffic/nearby')).status, 405);
  assert.equal((await post(body, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ coordinates: [], extra: 'x'.repeat(132000) })).status, 413);
  const res = await post(body, { origin }); const value = await res.json();
  assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store'); assert.equal(value.status, 'available'); assert.equal(calls, 1);
});
