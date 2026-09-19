import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouteEvents, createRouteEventsProvider, normalizePbsEvents, parsePbsTime, PBS_EVENTS_URL, filterEventsNearRoute, pointToRouteDistanceMeters } from '../workbench/server/route-events.mjs';

const NOW = Date.parse('2026-09-19T23:30:00.000Z');
const row = (extra = {}) => ({ UID: 'example-1', srcdetail: '測試來源', happendate: '2026-09-20', happentime: '07:00:00.0000000',
  modDttm: '2026-09-20 07:20:28.447', roadtype: '交通管制', road: '測試道路', areaNm: '臺北', y1: '25.046', x1: '121.517',
  comment: '合成測試通報，不是現場路況。', direction: '東向', region: 'N', ...extra });
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
const payload = (rows = [row()]) => ({ result: rows, count: rows.length, version: '1.0' });

test('PBS timestamp parsing is Taiwan-time explicit and rejects invalid dates rather than rolling over', () => {
  assert.equal(parsePbsTime('2026-09-20 07:20:28.447'), '2026-09-19T23:20:28.447Z');
  assert.equal(parsePbsTime('2026-09-20T07:00:00.1234567'), '2026-09-19T23:00:00.123Z');
  for (const value of ['2026-02-30 10:00:00', '2026-09-20 24:00:00', '2026-09-20 07:61:00', '2026-09-20', null, '2026-09-20 07:20:28Z']) assert.equal(parsePbsTime(value), null);
});

test('PBS normalizer preserves reports without inventing active closure windows or credibility', () => {
  const { events, recordsReceived } = normalizePbsEvents(payload(), NOW);
  assert.equal(recordsReceived, 1);
  const event = events[0];
  assert.equal(event.lat, 25.046); assert.equal(event.lng, 121.517);
  assert.equal(event.startAt, '2026-09-19T23:00:00.000Z'); assert.equal(event.endAt, null);
  assert.equal(event.active, 'unknown'); assert.equal(event.blocking, 'unknown');
  assert.equal(event.credibility, 'reported'); assert.equal(event.freshness, 'recent');
  assert.equal(event.locationQuality, 'reported_point'); assert.equal(event.kind, 'control');
  assert.equal(event.sourceUrl, PBS_EVENTS_URL); assert.match(event.timeBasis, /not_verified/);
});

test('PBS missing, zero, outlier and partially invalid coordinates remain unlocated', () => {
  const result = normalizePbsEvents(payload([
    row({ UID: 'blank', x1: '' }), row({ UID: 'zero', x1: '0', y1: '0' }),
    row({ UID: 'partial', x1: '121.5junk' }), row({ UID: 'foreign', x1: '180' }),
    row({ UID: 'valid-number', x1: 121.517, y1: 25.046 }),
  ]), NOW);
  assert.equal(result.unlocatedCount, 4);
  for (const event of result.events.slice(0, 4)) { assert.equal(event.lat, null); assert.equal(event.lng, null); assert.equal(event.locationQuality, 'unlocated'); }
});

test('shared coordinates with distinct messages are marked uncertain instead of precise road closures', () => {
  const result = normalizePbsEvents(payload([1, 2, 3].map(i => row({ UID: `event-${i}`, comment: `合成路段 ${i} 通報` }))), NOW);
  assert.equal(result.sharedPointCount, 3);
  assert.ok(result.events.every(event => event.locationQuality === 'shared_point' && event.reportsAtSamePoint === 3));
  const exactCopies = normalizePbsEvents(payload([1, 2, 3].map(i => row({ UID: `event-${i}` }))), NOW);
  assert.equal(exactCopies.sharedPointCount, 0, 'exact message copies do not imply distinct place reports');
});

test('PBS deduplicates IDs by newest source update and accounts for malformed records', () => {
  const result = normalizePbsEvents(payload([row(), row({ comment: '最新的合成描述', modDttm: '2026-09-20 07:29:00' }), null, { UID: 'invalid' }]), NOW);
  assert.equal(result.events.length, 1); assert.equal(result.events[0].text, '最新的合成描述');
  assert.equal(result.duplicateCount, 1); assert.equal(result.malformedCount, 2);
  assert.throws(() => normalizePbsEvents(payload([null]), NOW), /無法判定/);
  assert.throws(() => normalizePbsEvents({ result: 'not-an-array' }, NOW), /資料格式/);
  assert.throws(() => normalizePbsEvents(payload(Array(2001).fill(row())), NOW), /資料格式/);
});

test('source freshness is based on source update, never fetch time or an inferred expiry', () => {
  const result = normalizePbsEvents(payload([
    row({ UID: 'old', modDttm: '2026-09-19 23:00:00' }), row({ UID: 'missing', modDttm: '' }),
    row({ UID: 'future', modDttm: '2026-09-21 07:00:00' }),
  ]), NOW);
  assert.deepEqual(result.events.map(event => event.freshness), ['older', 'unknown', 'unknown']);
  assert.equal(result.events[0].active, 'unknown');
  assert.equal(result.events[1].ageMinutes, null); assert.equal(result.events[2].ageMinutes, null);
});

test('event provider uses only the fixed official endpoint with bounded fetch settings', async () => {
  let requested;
  const provider = createRouteEventsProvider({ fetchImpl: async (url, init) => { requested = { url, init }; return response(payload()); }, now: () => NOW });
  assert.equal(createRouteEventsProvider, createRouteEvents);
  assert.equal(provider.health().requiresKey, false);
  const result = await provider.fetch({ url: 'https://example.invalid/private' });
  assert.equal(requested.url, PBS_EVENTS_URL); assert.equal(requested.init.redirect, 'error');
  assert.equal(requested.init.method, 'GET'); assert.match(requested.init.headers['User-Agent'], /JEV-Delivery-Studio/);
  assert.equal(result.status, 'available'); assert.equal(result.metrics.requests, 1);
  assert.equal(result.provenance.fetchedAt, '2026-09-19T23:30:00.000Z');
  assert.equal(result.provenance.coverage, 'reported_incidents_only');
  assert.match(result.warnings.join(' '), /不代表道路暢通/);
});

test('60-second TTL preserves original fetchedAt and callers cannot mutate the cache', async () => {
  let time = NOW, requests = 0;
  const provider = createRouteEvents({ now: () => time, fetchImpl: async () => { requests++; return response(payload()); } });
  const first = await provider.fetch(); first.events[0].text = 'changed by caller';
  time += 59_999;
  const cached = await provider.fetch();
  assert.equal(requests, 1); assert.equal(cached.metrics.requests, 0); assert.equal(cached.provenance.cached, true);
  assert.equal(cached.provenance.fetchedAt, '2026-09-19T23:30:00.000Z'); assert.notEqual(cached.events[0].text, first.events[0].text);
  time++;
  assert.equal((await provider.fetch()).metrics.requests, 1); assert.equal(requests, 2);
});

test('failed refresh returns unavailable, never a stale list; repeated failure is cooled down', async () => {
  let fail = false, requests = 0;
  const provider = createRouteEvents({ now: () => NOW, fetchImpl: async () => { requests++; return response(payload(), fail ? 503 : 200); } });
  assert.equal((await provider.fetch()).events.length, 1); fail = true;
  const failed = await provider.fetch({ force: true });
  assert.equal(failed.status, 'unavailable'); assert.deepEqual(failed.events, []);
  assert.equal(failed.provenance.fetchedAt, null); assert.equal(failed.provenance.recordsReceived, null);
  assert.match(failed.warnings[0], /不能解讀/);
  assert.equal((await provider.fetch()).metrics.requests, 0); assert.equal(requests, 2);
});

test('an empty but valid feed is distinct from source failure and still does not promise safe passage', async () => {
  const result = await createRouteEvents({ fetchImpl: async () => response(payload([])), now: () => NOW }).fetch();
  assert.equal(result.status, 'available'); assert.equal(result.events.length, 0);
  assert.equal(result.provenance.recordsReceived, 0); assert.match(result.warnings.join(' '), /不代表道路暢通/);
});

test('unusable responses and transport errors are bounded and do not leak response bodies or URLs', async () => {
  const responses = [
    () => new Response('<html>private response body</html>'),
    () => new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }),
    () => new Response('x'.repeat(2 * 1024 * 1024 + 1)),
    () => { throw new Error('https://secret.invalid/?key=private-secret'); },
  ];
  for (const make of responses) {
    const result = await createRouteEvents({ fetchImpl: async () => make(), now: () => NOW }).fetch();
    assert.equal(result.status, 'unavailable'); assert.equal(result.metrics.requests, 1);
    assert.doesNotMatch(JSON.stringify(result), /private-secret|private response body/);
  }
});

test('pre-aborted event requests make no network call', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await createRouteEvents({ fetchImpl: () => { throw new Error('should not call'); }, now: () => NOW }).fetch({ signal: controller.signal });
  assert.equal(result.status, 'unavailable'); assert.equal(result.error.code, 'event_cancelled'); assert.equal(result.metrics.requests, 0);
});

test('source deadlines complete even when a transport ignores its abort signal', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = createRouteEvents({ fetchImpl: () => new Promise(() => {}), now: () => NOW }).fetch();
  context.mock.timers.tick(10_000);
  const result = await pending;
  assert.equal(result.status, 'unavailable'); assert.equal(result.error.code, 'event_timeout');
  assert.equal(result.metrics.requests, 1); assert.deepEqual(result.events, []);
});

test('cancellation covers response body reads and does not cache a cancelled request', async () => {
  const controller = new AbortController(); let requests = 0;
  const provider = createRouteEvents({ fetchImpl: async () => {
    requests++;
    if (requests === 1) return new Response(new ReadableStream({ start() { setTimeout(() => controller.abort(), 5); } }));
    return response(payload());
  }, now: () => NOW });
  assert.equal((await provider.fetch({ signal: controller.signal })).error.code, 'event_cancelled');
  assert.equal((await provider.fetch()).status, 'available'); assert.equal(requests, 2);
});

test('simultaneous event requests share one bounded source call and count it once', async () => {
  let resolve, requests = 0;
  const provider = createRouteEvents({ fetchImpl: () => { requests++; return new Promise(done => { resolve = done; }); }, now: () => NOW });
  const a = provider.fetch(), b = provider.fetch(); resolve(response(payload()));
  const results = await Promise.all([a, b]);
  assert.equal(requests, 1); assert.equal(results.reduce((sum, result) => sum + result.metrics.requests, 0), 1);
  assert.equal(results[1].provenance.sharedRequest, true);
});

test('route distance projects onto a segment, endpoints and repeated points with metre units', () => {
  const equator = [[0, 0], [1, 0]];
  assert.ok(Math.abs(pointToRouteDistanceMeters([0.5, 1], equator) - 111_195.08) < 1);
  assert.ok(pointToRouteDistanceMeters([0.5, 0], equator) < 0.001);
  assert.ok(Math.abs(pointToRouteDistanceMeters([2, 0], equator) - 111_195.08) < 1);
  assert.ok(Math.abs(pointToRouteDistanceMeters([-1, 0], equator) - 111_195.08) < 1);
  assert.ok(Math.abs(pointToRouteDistanceMeters([0, 1], [[0, 0], [0, 0]]) - 111_195.08) < 1);
  assert.ok(pointToRouteDistanceMeters([180, 0], [[179, 0], [-179, 0]]) < 0.01);
});

test('corridor filtering keeps uncertain nearby reports labelled and counts unmappable reports separately', () => {
  const route = [[121.51, 25.04], [121.52, 25.04]];
  const events = [
    { id: 'near', lat: 25.041, lng: 121.515, locationQuality: 'reported_point' },
    { id: 'shared', lat: 25.04, lng: 121.515, locationQuality: 'shared_point' },
    { id: 'away', lat: 25.05, lng: 121.515, locationQuality: 'reported_point' },
    { id: 'missing', lat: null, lng: null, locationQuality: 'unlocated' },
  ];
  const filtered = filterEventsNearRoute(events, route, 200);
  assert.deepEqual(filtered.events.map(event => event.id), ['shared', 'near']);
  assert.equal(filtered.unlocatedCount, 1); assert.equal(filtered.excludedCount, 1); assert.equal(filtered.locationUncertainCount, 1);
  assert.ok(Math.abs(filtered.events[1].distanceMeters - 111.2) < 1);
  assert.match(filtered.interpretation, /not_confirmed/);
  assert.equal(events[0].distanceMeters, undefined);
});

test('corridor filtering rejects invalid and unbounded route geometry', () => {
  for (const route of [[], [[121, 25]], [[NaN, 25], [121, 25]], [[121, 95], [121, 25]], Array(20001).fill([121, 25])]) assert.throws(() => filterEventsNearRoute([], route), /coordinates/);
  assert.throws(() => filterEventsNearRoute([], [[121, 25], [121.1, 25]], 5001), /radius/);
});
