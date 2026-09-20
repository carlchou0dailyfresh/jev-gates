import { performance } from 'node:perf_hooks';

export const PBS_EVENTS_URL = 'https://rtr.pbs.gov.tw/NMP103_PbsWS/resources/roadData/opendata';
export const PBS_DATASET_URL = 'https://data.gov.tw/dataset/15221';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS = 2000;
const TTL_MS = 60_000;
const TIMEOUT_MS = 10_000;
const EARTH_METERS = 6_371_008.8;
export const CURRENT_EVENT_MAX_AGE_SECONDS = 15 * 60;
const RECENT_MS = CURRENT_EVENT_MAX_AGE_SECONDS * 1000;
const USER_AGENT = 'JEV-Delivery-Studio/0.1 (+https://github.com/carlchou0dailyfresh/jev-gates)';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clean = (value, limit = 4096) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, limit) : '';
const clone = value => structuredClone(value);

class EventsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function sourceTime(value) {
  if (typeof value !== 'string') return NaN;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/);
  if (!match) return NaN;
  const [, yy, mo, dd, hh, mm, ss, , zoneHour = '0', zoneMinute = '0'] = match;
  const [year, month, day, hour, minute, second] = [yy, mo, dd, hh, mm, ss].map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 2000 || year > 2200 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59
    || Number(zoneHour) > 14 || Number(zoneMinute) > 59 || (Number(zoneHour) === 14 && Number(zoneMinute) !== 0)
    || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return NaN;
  return Date.parse(value);
}

/** Product display criterion only: a recent source update does not prove an incident is still active. */
export function classifyEventFreshness(updatedAt, at = Date.now()) {
  if (!Number.isFinite(Number(at))) throw new TypeError('The freshness clock must be finite.');
  const sourceUpdatedMs = sourceTime(updatedAt), ageMs = Number(at) - sourceUpdatedMs;
  const reason = !Number.isFinite(sourceUpdatedMs) ? 'unknown' : ageMs < 0 ? 'future' : ageMs > RECENT_MS ? 'stale' : 'current';
  return { reason, ageMinutes: Number.isFinite(ageMs) && ageMs >= 0 ? ageMs / 60_000 : null, sourceUpdatedMs };
}

/** Keep history in process-local source cache only, never in the current-events API payload. */
export function projectCurrentEventFeed(feed, at = Date.now()) {
  if (!object(feed) || !Number.isFinite(Number(at))) throw new TypeError('Invalid event feed or freshness clock.');
  const result = clone(feed), evaluatedAt = new Date(Number(at)).toISOString();
  const provenance = object(result.provenance) ? result.provenance : {};
  const policy = { scope: 'source_feed', policy: 'source_updated_within_15_minutes', maxAgeSeconds: CURRENT_EVENT_MAX_AGE_SECONDS, evaluatedAt };
  if (result.status !== 'available') {
    result.events = [];
    result.provenance = { ...provenance, freshness: { ...policy, status: 'unavailable', eligibleCount: null, parsedCount: null,
      excluded: { stale: null, unknown: null, future: null, total: null }, sourceLatestUpdatedAt: null, sourceOldestUpdatedAt: null,
      newestEligibleUpdatedAt: null, oldestEligibleUpdatedAt: null } };
    return result;
  }
  if (!Array.isArray(result.events) || result.events.length > MAX_RECORDS) throw new TypeError('Invalid event list.');
  const prior = provenance.freshness?.policy === policy.policy && provenance.freshness?.scope === policy.scope ? provenance.freshness : null;
  const excluded = { stale: prior?.excluded?.stale ?? 0, unknown: prior?.excluded?.unknown ?? 0, future: prior?.excluded?.future ?? 0, total: 0 };
  const events = [], sourceTimes = [];
  for (const event of result.events) {
    const age = classifyEventFreshness(event?.updatedAt, at);
    if (Number.isFinite(age.sourceUpdatedMs)) sourceTimes.push(age.sourceUpdatedMs);
    if (age.reason !== 'current') { excluded[age.reason]++; continue; }
    events.push({ ...event, ageMinutes: age.ageMinutes, freshness: 'recent' });
  }
  excluded.total = excluded.stale + excluded.unknown + excluded.future;
  const eligibleTimes = events.map(event => sourceTime(event.updatedAt));
  const earliest = times => times.length ? new Date(Math.min(...times)).toISOString() : null;
  const latest = times => times.length ? new Date(Math.max(...times)).toISOString() : null;
  result.events = events;
  result.provenance = { ...provenance,
    sourceUnlocatedCount: provenance.sourceUnlocatedCount ?? provenance.unlocatedCount ?? 0,
    sourceSharedPointCount: provenance.sourceSharedPointCount ?? provenance.sharedPointCount ?? 0,
    unlocatedCount: events.filter(event => event.locationQuality === 'unlocated').length,
    sharedPointCount: events.filter(event => event.locationQuality === 'shared_point').length,
    freshness: { ...policy, status: events.length ? 'current' : 'no_recent_events', eligibleCount: events.length,
      parsedCount: prior?.parsedCount ?? feed.events.length, excluded,
      sourceLatestUpdatedAt: prior?.sourceLatestUpdatedAt ?? latest(sourceTimes), sourceOldestUpdatedAt: prior?.sourceOldestUpdatedAt ?? earliest(sourceTimes),
      newestEligibleUpdatedAt: latest(eligibleTimes), oldestEligibleUpdatedAt: earliest(eligibleTimes) },
  };
  return result;
}

/** PBS dates have no offset. Interpret documented Taiwan local times without host timezone dependence. */
export function parsePbsTime(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?$/);
  if (!match) return null;
  const [, yy, mo, dd, hh, mm, ss, fraction = ''] = match;
  const parts = [yy, mo, dd, hh, mm, ss].map(Number);
  const [year, month, day, hour, minute, second] = parts;
  if (year < 2000 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second, Number(fraction.padEnd(3, '0').slice(0, 3))));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return null;
  return new Date(utc.getTime() - 8 * 60 * 60_000).toISOString();
}

function reportedCoordinate(value, min, max) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && !/^[+-]?\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

const kinds = { '交通管制': 'control', '道路施工': 'construction', '事故': 'accident', '阻塞': 'congestion', '交通障礙': 'obstruction', '號誌故障': 'signal', '正常': 'normal' };

/** Normalize source reports, never infer a closure's end time, precise location, or active status from prose. */
export function normalizePbsEvents(payload, fetchedAt = Date.now()) {
  if (!object(payload) || !Array.isArray(payload.result) || payload.result.length > MAX_RECORDS) throw new EventsError('event_schema_error', '警廣資料格式不符，無法判定沿線事件。');
  if (!Number.isFinite(Number(fetchedAt))) throw new TypeError('fetchedAt must be a finite timestamp.');
  const byId = new Map(); let malformedCount = 0, duplicateCount = 0;
  for (const raw of payload.result) {
    if (!object(raw) || typeof raw.UID !== 'string' || !raw.UID.trim() || raw.UID.length > 128 || typeof raw.comment !== 'string' || !raw.comment.trim()) { malformedCount++; continue; }
    const text = clean(raw.comment), road = clean(raw.road, 200), area = clean(raw.areaNm, 200), category = clean(raw.roadtype, 80);
    const latValue = reportedCoordinate(raw.y1, 20, 27), lngValue = reportedCoordinate(raw.x1, 117, 124);
    const located = latValue !== null && lngValue !== null;
    const updatedAt = parsePbsTime(raw.modDttm);
    const age = classifyEventFreshness(updatedAt, fetchedAt);
    const ageMinutes = age.ageMinutes;
    const event = {
      id: `pbs:${clean(raw.UID, 128)}`,
      title: [category, road || area || text.split('\n')[0]].filter(Boolean).join(' · ').slice(0, 140),
      text, lat: located ? latValue : null, lng: located ? lngValue : null,
      startAt: parsePbsTime(`${clean(raw.happendate, 10)} ${clean(raw.happentime, 30)}`),
      endAt: null, updatedAt, ageMinutes,
      // happendate/happentime describe the report's occurrence, not a verified closure interval.
      timeBasis: 'reported_occurrence_not_verified_closure_window',
      sourceUrl: PBS_EVENTS_URL, referenceUrl: PBS_DATASET_URL,
      sourceName: '警察廣播電臺', reporter: clean(raw.srcdetail, 200),
      road, area, direction: clean(raw.direction, 80), region: clean(raw.region, 8),
      kind: kinds[category] || 'other', sourceCategory: category,
      credibility: 'reported', active: 'unknown', blocking: 'unknown',
      locationQuality: located ? 'reported_point' : 'unlocated',
      freshness: age.reason === 'current' ? 'recent' : age.reason === 'stale' ? 'older' : 'unknown',
      textTruncated: raw.comment.length > 4096,
    };
    const previous = byId.get(event.id);
    if (previous) {
      duplicateCount++;
      if ((Date.parse(previous.updatedAt) || 0) >= (Date.parse(updatedAt) || 0)) continue;
    }
    byId.set(event.id, event);
  }
  if (payload.result.length > 0 && byId.size === 0) throw new EventsError('event_schema_error', '警廣回應沒有可解析事件，無法判定路況。');
  const events = [...byId.values()];
  const points = new Map();
  for (const event of events) {
    if (event.lat === null) continue;
    const key = `${event.lat.toFixed(5)},${event.lng.toFixed(5)}`;
    const signatures = points.get(key) || new Set();
    signatures.add(`${event.road}|${event.area}|${event.text}`); points.set(key, signatures);
  }
  for (const event of events) {
    if (event.lat === null) continue;
    const count = points.get(`${event.lat.toFixed(5)},${event.lng.toFixed(5)}`).size;
    if (count >= 3) event.locationQuality = 'shared_point';
    event.reportsAtSamePoint = count;
  }
  return {
    events,
    recordsReceived: payload.result.length,
    malformedCount, duplicateCount,
    unlocatedCount: events.filter(event => event.locationQuality === 'unlocated').length,
    sharedPointCount: events.filter(event => event.locationQuality === 'shared_point').length,
  };
}

async function requestFeed(fetchImpl, signal) {
  const controller = new AbortController(); let timer;
  const abort = () => controller.abort();
  if (signal?.aborted) throw new EventsError('event_cancelled', '事件查詢已取消。');
  signal?.addEventListener('abort', abort, { once: true });
  const task = (async () => {
    const response = await fetchImpl(PBS_EVENTS_URL, {
      method: 'GET', redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/json, text/plain;q=0.9', 'User-Agent': USER_AGENT },
    });
    if (!response.ok) throw new EventsError('event_http_error', '警廣事件來源暫時無法回應，路況仍待確認。');
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw new EventsError('event_response_too_large', '警廣事件回應超過讀取上限。');
    if (!response.body?.getReader) throw new EventsError('event_schema_error', '警廣事件回應為空。');
    const reader = response.body.getReader(); const chunks = []; let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) { await reader.cancel(); throw new EventsError('event_response_too_large', '警廣事件回應超過讀取上限。'); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new EventsError('event_schema_error', '警廣事件回應不是有效 JSON。'); }
  })();
  let cancelListener;
  try {
    return await Promise.race([
      task,
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new EventsError('event_timeout', '事件來源超過 10 秒仍未回應，路況仍待確認。')); }, TIMEOUT_MS); }),
      new Promise((_, reject) => {
        cancelListener = () => reject(new EventsError('event_cancelled', '事件查詢已取消。'));
        signal?.addEventListener('abort', cancelListener, { once: true });
        if (signal?.aborted) cancelListener();
      }),
    ]);
  } catch (error) {
    if (error instanceof EventsError) throw error;
    if (signal?.aborted) throw new EventsError('event_cancelled', '事件查詢已取消。');
    throw new EventsError('event_transport_error', '無法連線到警廣事件來源，路況仍待確認。');
  } finally {
    clearTimeout(timer); controller.abort();
    signal?.removeEventListener('abort', abort);
    if (cancelListener) signal?.removeEventListener('abort', cancelListener);
  }
}

/** One fixed official endpoint; no caller-controlled URL, geolocation, geocoding, retries or fabricated live events. */
export function createRouteEvents({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') throw new TypeError('Invalid event provider configuration.');
  let cache = null, inFlight = null;
  function timestamp() {
    const value = Number(now()); if (!Number.isFinite(value)) throw new TypeError('Invalid event provider clock.'); return value;
  }
  function health() {
    return { provider: 'pbs', configured: true, sourceUrl: PBS_EVENTS_URL, referenceUrl: PBS_DATASET_URL,
      label: '警廣公開事件通報', requiresKey: false, coverage: 'reported_incidents_only', currentEventMaxAgeSeconds: CURRENT_EVENT_MAX_AGE_SECONDS };
  }
  async function fetchEvents({ force = false, signal } = {}) {
    if (typeof force !== 'boolean') throw new TypeError('force must be a boolean.');
    if (signal?.aborted) return projectCurrentEventFeed(unavailable(new EventsError('event_cancelled', '事件查詢已取消。'), timestamp(), 0, 0), timestamp());
    const startedAt = timestamp();
    if (!force && cache && startedAt >= cache.savedAt && startedAt - cache.savedAt < TTL_MS) {
      return projectCurrentEventFeed({ ...clone(cache.result), provenance: { ...clone(cache.result.provenance), cached: true }, metrics: { requests: 0, elapsedMs: 0 } }, startedAt);
    }
    if (inFlight) {
      const shared = await inFlight;
      return projectCurrentEventFeed({ ...clone(shared), provenance: { ...clone(shared.provenance), sharedRequest: true }, metrics: { requests: 0, elapsedMs: 0 } }, timestamp());
    }
    cache = null;
    const operation = (async () => {
      const elapsed = performance.now(); let result;
      try {
        const payload = await requestFeed(fetchImpl, signal), fetchedAt = timestamp();
        const normalized = normalizePbsEvents(payload, fetchedAt);
        const { events, ...counts } = normalized;
        const warnings = ['公開通報並非完整路況；未找到沿線通報不代表道路暢通。', '事件時間是來源通報時間，沒有確認的封路結束時間。'];
        if (counts.sharedPointCount) warnings.push('多筆不同通報共用同一座標，位置不能作為精確封路證據。');
        if (counts.unlocatedCount) warnings.push('部分通報缺少可用座標，不能納入沿線距離篩選。');
        if (counts.malformedCount) warnings.push('部分來源紀錄無法解析，未納入事件清單。');
        result = { status: 'available', events, warnings,
          provenance: { ...health(), fetchedAt: new Date(fetchedAt).toISOString(), cached: false,
            latestUpdatedAt: events.map(event => event.updatedAt).filter(Boolean).sort().at(-1) ?? null,
            ...counts, sourceVersion: clean(payload.version, 80) || null, maximumFeedRecords: 1000,
            license: 'Open Government Data License 1.0', reportedCoordinatesOnly: true },
          metrics: { requests: 1, elapsedMs: performance.now() - elapsed } };
      } catch (error) {
        result = unavailable(error, timestamp(), 1, performance.now() - elapsed);
      }
      // A failed refresh never surfaces an earlier successful list. Cool down repeated failures, too.
      if (result.error?.code !== 'event_cancelled') cache = { savedAt: timestamp(), result: clone(result) };
      return result;
    })();
    inFlight = operation;
    try { return projectCurrentEventFeed(await operation, timestamp()); }
    finally { if (inFlight === operation) inFlight = null; }
  }
  function unavailable(error, time, requests, elapsedMs) {
    return { status: 'unavailable', events: [],
      error: { code: error instanceof EventsError ? error.code : 'event_source_error', message: error instanceof EventsError ? error.message : '事件來源暫時無法使用，路況仍待確認。' },
      warnings: ['沒有取得可用事件資料；不能解讀為沿線沒有事件。'],
      provenance: { ...health(), fetchedAt: null, attemptedAt: new Date(time).toISOString(), cached: false,
        recordsReceived: null, unlocatedCount: null, sharedPointCount: null, reportedCoordinatesOnly: true },
      metrics: { requests, elapsedMs } };
  }
  return { health, fetch: fetchEvents };
}

export const createRouteEventsProvider = createRouteEvents;

const radians = degrees => degrees * Math.PI / 180;
const clamp = value => Math.max(-1, Math.min(1, value));
function validLngLat(point) {
  return Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)
    && point[0] >= -180 && point[0] <= 180 && point[1] >= -90 && point[1] <= 90;
}
function angle(a, b) {
  const dlat = radians(b[1] - a[1]), dlng = radians(b[0] - a[0]);
  return 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, Math.sin(dlat / 2) ** 2 + Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(dlng / 2) ** 2))));
}
function bearing(a, b) {
  const lat1 = radians(a[1]), lat2 = radians(b[1]), dlng = radians(b[0] - a[0]);
  return Math.atan2(Math.sin(dlng) * Math.cos(lat2), Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dlng));
}
function segmentDistance(point, start, end) {
  const length = angle(start, end), toPoint = angle(start, point);
  if (length < 1e-12 || Math.abs(length - Math.PI) < 1e-8) return Math.min(toPoint, angle(end, point)) * EARTH_METERS;
  const difference = bearing(start, point) - bearing(start, end);
  const along = Math.atan2(Math.sin(toPoint) * Math.cos(difference), Math.cos(toPoint));
  if (along < 0) return toPoint * EARTH_METERS;
  if (along > length) return angle(end, point) * EARTH_METERS;
  return Math.abs(Math.asin(clamp(Math.sin(toPoint) * Math.sin(difference)))) * EARTH_METERS;
}

/** Distance to the minor great-circle segments of a GeoJSON [longitude, latitude] line. */
export function pointToRouteDistanceMeters(point, coordinates) {
  if (!validLngLat(point) || !Array.isArray(coordinates) || coordinates.length < 2 || coordinates.length > 20_000 || !coordinates.every(validLngLat)) throw new TypeError('Valid GeoJSON coordinates with 2–20000 route points are required.');
  let distance = Infinity;
  for (let i = 1; i < coordinates.length; i++) distance = Math.min(distance, segmentDistance(point, coordinates[i - 1], coordinates[i]));
  return distance;
}

/** Nearby means proximity to a reported point, not that the road or travel direction is blocked. */
export function filterEventsNearRoute(events, coordinates, radiusMeters = 500) {
  if (!Array.isArray(events) || events.length > MAX_RECORDS || !Number.isFinite(radiusMeters) || radiusMeters < 0 || radiusMeters > 5000) throw new TypeError('Events or route corridor radius are invalid.');
  pointToRouteDistanceMeters(coordinates?.[0], coordinates);
  const nearby = []; let unlocatedCount = 0, excludedCount = 0, locationUncertainCount = 0;
  for (const event of events) {
    if (!object(event) || !validLngLat([event.lng, event.lat])) { unlocatedCount++; continue; }
    let distanceMeters = Infinity;
    for (let i = 1; i < coordinates.length; i++) distanceMeters = Math.min(distanceMeters, segmentDistance([event.lng, event.lat], coordinates[i - 1], coordinates[i]));
    if (distanceMeters > radiusMeters) { excludedCount++; continue; }
    if (event.locationQuality !== 'reported_point') locationUncertainCount++;
    nearby.push({ ...clone(event), distanceMeters });
  }
  nearby.sort((a, b) => a.distanceMeters - b.distanceMeters || String(a.id).localeCompare(String(b.id)));
  return { events: nearby, unlocatedCount, excludedCount, locationUncertainCount, radiusMeters, interpretation: 'reported_point_proximity_not_confirmed_road_overlap' };
}
