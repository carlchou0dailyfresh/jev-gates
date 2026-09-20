import { gunzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { checkLocalRequest, readApiBody } from './api.mjs';
import { pointToRouteDistanceMeters } from './route-events.mjs';

export const TRAFFIC_SOURCE_URL = 'https://tcgbusfs.blob.core.windows.net/blobtisv/GetVD.xml.gz';
const DATASET_URL = 'https://data.taipei/dataset/detail?id=b5aaf33a-a6dc-4836-bce6-09986241fe11';
const MAX_COMPRESSED = 512 * 1024, MAX_XML = 2 * 1024 * 1024, MAX_RECORDS = 2000;
const MAX_AGE_SECONDS = 120, CACHE_MS = 30_000, MATCH_METERS = 300;
const MATCH_LABEL = '候選路線附近，非確認同一路段';
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const validPoint = point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)
  && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90;
class TrafficError extends Error {
  constructor(code, message, status = 502) { super(message); this.code = code; this.status = status; }
}
const requireValue = (condition, message, status = 400) => { if (!condition) throw new TrafficError('invalid_input', message, status); };
const malformed = () => new TrafficError('invalid_source', '官方道路速度資料格式無效，暫不顯示觀測值。');

function sourceTime(value) {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(value ?? '');
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return new Date(date.getTime() - 8 * 3600_000).toISOString();
}
function field(body, key) {
  const matches = [...body.matchAll(new RegExp(`<vd:${key}>([^<>]*)</vd:${key}>`, 'g'))];
  return matches.length === 1 ? matches[0][1].trim() : null;
}
function xmlText(value) {
  if (value === null || /&(?!amp;|lt;|gt;|quot;|apos;)/.test(value)) return null;
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity]);
}
function numeric(value) { return value !== null && /^-?\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : null; }

/** Deliberately accepts only this official fixed XML structure; no DTD, entities, or arbitrary nested markup. */
export function parseTrafficObservationsXml(xml) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > MAX_XML || /<!|<\?(?!xml\s)/i.test(xml)
    || !/^\s*(?:<\?xml[^?]*\?>\s*)?<vd:ExchangeData\b[^>]*>/.test(xml) || !/<\/vd:ExchangeData>\s*$/.test(xml)) throw malformed();
  const sourceUpdatedAt = sourceTime(field(xml, 'ExchangeTime'));
  const blocks = [...xml.matchAll(/<vd:SectionData>([\s\S]*?)<\/vd:SectionData>/g)];
  if (!blocks.length || blocks.length > MAX_RECORDS || (xml.match(/<vd:SectionData>/g) ?? []).length !== blocks.length) throw malformed();
  const observations = [], ids = new Set();
  for (const [, body] of blocks) {
    const id = xmlText(field(body, 'SectionId')), name = xmlText(field(body, 'SectionName'));
    const start = [numeric(field(body, 'StartWgsX')), numeric(field(body, 'StartWgsY'))];
    const end = [numeric(field(body, 'EndWgsX')), numeric(field(body, 'EndWgsY'))];
    if (!id || id.length > 100 || !name || name.length > 300 || !validPoint(start) || !validPoint(end)) continue;
    if (ids.has(id)) throw malformed();
    ids.add(id);
    const speed = numeric(field(body, 'AvgSpd')), moe = numeric(field(body, 'MOELevel'));
    // MOE -1 is the publisher's missing-data state even when AvgSpd contains a number.
    const usable = speed !== null && speed >= 0 && speed <= 250 && [0, 1, 2].includes(moe);
    observations.push({ id, name, speedKph: usable ? speed : null,
      congestionLabel: usable ? ['順暢', '車多', '壅塞'][moe] : '無可用觀測', start, end });
  }
  if (!observations.length) throw malformed();
  return { sourceUpdatedAt, observations, recordsReceived: blocks.length, excludedRecords: blocks.length - observations.length };
}
function freshness(sourceUpdatedAt, now) {
  const age = sourceUpdatedAt === null ? NaN : (now - Date.parse(sourceUpdatedAt)) / 1000;
  return { state: !Number.isFinite(age) || age < 0 ? 'unknown' : age > MAX_AGE_SECONDS ? 'stale' : 'fresh',
    sourceUpdatedAt, ageSeconds: Number.isFinite(age) ? age : null, maxAgeSeconds: MAX_AGE_SECONDS };
}
async function readSource(fetchImpl, signal, timeoutMs) {
  const controller = new AbortController(); let timer;
  const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
  const cancelled = () => new TrafficError('cancelled', '道路速度查詢已取消。', 499);
  const task = (async () => {
    if (signal?.aborted) throw cancelled();
    const response = await fetchImpl(TRAFFIC_SOURCE_URL, { signal: controller.signal, redirect: 'error',
      headers: { accept: 'application/gzip, application/octet-stream', 'accept-encoding': 'identity', 'user-agent': 'JEV-Route-Studio/0.1 (+https://github.com/carlchou0dailyfresh/jev-gates)' } });
    if (!response.ok) throw new TrafficError('source_http', '官方道路速度來源暫時無法回應。');
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_COMPRESSED)) throw malformed();
    if (!response.body?.getReader) throw malformed();
    const reader = response.body.getReader(), chunks = []; let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        total += value.byteLength;
        if (total > MAX_COMPRESSED) { await reader.cancel(); throw malformed(); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    try {
      const bytes = gunzipSync(Buffer.concat(chunks), { maxOutputLength: MAX_XML });
      return parseTrafficObservationsXml(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (error) { if (error instanceof TrafficError) throw error; throw malformed(); }
  })();
  let cancelledListener;
  try {
    return await Promise.race([task,
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new TrafficError('source_timeout', '道路速度來源超過 10 秒仍未回應。')); }, timeoutMs); }),
      new Promise((_, reject) => { cancelledListener = () => reject(cancelled()); signal?.addEventListener('abort', cancelledListener, { once: true }); if (signal?.aborted) cancelledListener(); }),
    ]);
  } catch (error) {
    if (error instanceof TrafficError) throw error;
    throw signal?.aborted ? cancelled() : new TrafficError('source_unavailable', '無法取得官方道路速度資料。');
  } finally { clearTimeout(timer); controller.abort(); signal?.removeEventListener('abort', abort); signal?.removeEventListener('abort', cancelledListener); }
}

export function createTrafficObservations({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 10_000 } = {}) {
  requireValue(typeof fetchImpl === 'function' && typeof now === 'function' && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10_000, '道路速度服務設定無效。');
  let cache = null, active = false;
  const clock = () => { const value = now(); requireValue(Number.isFinite(value), '服務時間無效。', 500); return value; };
  return { async nearby(body, signal) {
    requireValue(plain(body) && Object.keys(body).length === 1 && Array.isArray(body.coordinates)
      && body.coordinates.length >= 2 && body.coordinates.length <= 2000 && body.coordinates.every(validPoint), '請提供 2–2000 個有效的道路經緯度座標。');
    requireValue(!active, '正在取得道路速度資料，請稍後再試。', 429);
    active = true; const started = performance.now(); let requests = 0, cached = false, entry;
    try {
      const current = clock();
      if (signal?.aborted) entry = { snapshot: null, error: { code: 'cancelled', message: '道路速度查詢已取消。' }, fetchedAt: null };
      else if (cache && current >= cache.savedAt && current - cache.savedAt < CACHE_MS) { entry = clone(cache); cached = true; }
      else {
        cache = null; requests = 1;
        try { entry = { snapshot: await readSource(fetchImpl, signal, timeoutMs), fetchedAt: new Date(clock()).toISOString() }; }
        catch (error) { entry = { snapshot: null, fetchedAt: null, error: { code: error.code, message: error.message } }; }
        if (entry.error?.code !== 'cancelled') cache = { ...clone(entry), savedAt: clock() };
      }
      const snapshot = entry.snapshot, state = freshness(snapshot?.sourceUpdatedAt ?? null, clock());
      let observations = [];
      if (state.state === 'fresh') observations = snapshot.observations.map(observation => {
        const midpoint = [(observation.start[0] + observation.end[0]) / 2, (observation.start[1] + observation.end[1]) / 2];
        const matches = [observation.start, midpoint, observation.end].map(point => ({ point, distance: pointToRouteDistanceMeters(point, body.coordinates) })).sort((a, b) => a.distance - b.distance);
        const nearest = matches[0];
        return { id: observation.id, name: observation.name, speedKph: observation.speedKph, congestionLabel: observation.congestionLabel,
          lat: nearest.point[1], lng: nearest.point[0], distanceMeters: Math.round(nearest.distance), matchLabel: MATCH_LABEL, approximateDistance: nearest.distance };
      }).filter(observation => observation.approximateDistance <= MATCH_METERS).sort((a, b) => a.approximateDistance - b.approximateDistance || a.id.localeCompare(b.id));
      const nearbyCount = observations.length;
      // Recheck after spatial work: no speed crosses the age boundary while this request is being computed.
      const finalFreshness = freshness(snapshot?.sourceUpdatedAt ?? null, clock());
      if (finalFreshness.state !== 'fresh') observations = [];
      return { status: finalFreshness.state === 'fresh' ? 'available' : finalFreshness.state === 'stale' ? 'stale' : 'unavailable',
        observations: observations.slice(0, 5).map(({ approximateDistance, ...observation }) => observation), freshness: finalFreshness,
        provenance: { provider: 'taipei-road-speed', sourceUrl: TRAFFIC_SOURCE_URL, referenceUrl: DATASET_URL, fetchedAt: entry.fetchedAt,
          cached, measurement: '5分鐘平滑平均', timeBasis: 'feed_exchange_not_sensor_observation', matchRadiusMeters: MATCH_METERS,
          maxObservations: 5, license: 'Open Government Data License 1.0' },
        metrics: { requests, elapsedMs: performance.now() - started, recordsReceived: snapshot?.recordsReceived ?? 0, excludedRecords: snapshot?.excludedRecords ?? 0, nearbyCount: finalFreshness.state === 'fresh' ? nearbyCount : 0 },
        ...(entry.error ? { error: entry.error } : {}),
        message: finalFreshness.state === 'fresh' ? (observations.length ? '附近路段的官方平均車速；不代表同一路段、行車方向或公車到站時間。' : '沒有符合距離條件的路段觀測，不代表道路暢通。') : '來源時間過期、未知或資料無法取得；目前不顯示車速。' };
    } finally { active = false; }
  } };
}

export function createTrafficObservationsApi(options = {}) {
  const service = createTrafficObservations(options);
  return async (req, res) => {
    const controller = new AbortController(); const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', onClose);
    const send = (status, body) => { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(body)); };
    try {
      checkLocalRequest(req);
      requireValue(req.url?.split('?')[0] === '/api/traffic/nearby', '找不到道路速度端點。', 404);
      requireValue(req.method === 'POST', '道路速度查詢僅接受 POST。', 405);
      const body = await readApiBody(req, 5000, 128 * 1024);
      send(200, await service.nearby(body, controller.signal));
    } catch (error) { send(error.status ?? 500, { error: error.status ? error.message : '道路速度查詢無法完成。' }); }
    finally { res.off('close', onClose); }
  };
}
