import { performance } from 'node:perf_hooks';
import { fixtureMatrix } from './delivery-core.mjs';

const OSRM_ORIGIN = 'https://router.project-osrm.org';
const GOOGLE_MATRIX = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
const GOOGLE_ROUTE = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const CACHE_TTL_MS = 60_000;
const CACHE_ENTRIES = 32;
const USER_AGENT = 'JEV-Delivery-Studio/0.1 (+https://github.com/carlchou0dailyfresh/jev-gates)';
const providers = ['fixture', 'osrm', 'google'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const clone = value => structuredClone(value);

class MapsError extends Error {
  constructor(message, code = 'invalid_map_response', status = 502) {
    super(message); this.name = 'DeliveryMapsError'; this.code = code; this.status = status;
  }
}
function ensure(condition, message, code, status) { if (!condition) throw new MapsError(message, code, status); }
function positions(draft) {
  ensure(object(draft) && object(draft.depot) && Array.isArray(draft.stops) && draft.stops.length >= 1 && draft.stops.length <= 7,
    '地圖請求需要出發地與 1–7 個配送點。', 'invalid_input', 400);
  const points = [draft.depot, ...draft.stops];
  const ids = new Set();
  for (const point of points) {
    ensure(object(point) && typeof point.id === 'string' && point.id.length > 0 && point.id.length <= 64 && !ids.has(point.id), '配送點 ID 無效或重複。', 'invalid_input', 400);
    ensure(typeof point.lat === 'number' && Number.isFinite(point.lat) && point.lat >= -90 && point.lat <= 90
      && typeof point.lng === 'number' && Number.isFinite(point.lng) && point.lng >= -180 && point.lng <= 180, '配送點座標無效。', 'invalid_input', 400);
    ids.add(point.id);
  }
  ensure(typeof draft.returnToDepot === 'boolean', 'returnToDepot 必須是布林值。', 'invalid_input', 400);
  return points.map(({ id, lat, lng }) => ({ id, lat, lng }));
}
function routePositions(draft, order) {
  const points = positions(draft), stops = points.slice(1);
  ensure(Array.isArray(order) && order.length === stops.length && new Set(order).size === order.length
    && order.every(id => typeof id === 'string' && stops.some(stop => stop.id === id)), '路線順序必須完整且不重複地列出配送點 ID。', 'invalid_input', 400);
  return [points[0], ...order.map(id => stops.find(stop => stop.id === id)), ...(draft.returnToDepot ? [points[0]] : [])];
}
function validateMatrix(value, size, allowUnreachable = false) {
  ensure(object(value), '距離矩陣回應無效。');
  for (const field of ['durations', 'distances']) {
    ensure(Array.isArray(value[field]) && value[field].length === size
      && value[field].every(row => Array.isArray(row) && row.length === size && row.every(cell => number(cell) || (allowUnreachable && cell === null))), '距離矩陣缺少路線、維度不符或含無效數值。');
  }
  return { durations: clone(value.durations), distances: clone(value.distances) };
}
function validateGeometry(value) {
  ensure(object(value) && value.type === 'LineString' && Array.isArray(value.coordinates)
    && value.coordinates.length >= 2 && value.coordinates.length <= 20_000, '路線幾何格式無效。');
  ensure(value.coordinates.every(point => Array.isArray(point) && point.length === 2
    && typeof point[0] === 'number' && Number.isFinite(point[0]) && point[0] >= -180 && point[0] <= 180
    && typeof point[1] === 'number' && Number.isFinite(point[1]) && point[1] >= -90 && point[1] <= 90), '路線幾何含無效座標。');
  return clone(value.coordinates);
}
function parseDuration(value) {
  ensure(typeof value === 'string' && /^\d+(?:\.\d{1,9})?s$/.test(value), 'Google 回傳的行車時間無效。');
  const seconds = Number(value.slice(0, -1));
  ensure(number(seconds), 'Google 回傳的行車時間無效。');
  return seconds;
}
function googleMatrix(payload, size) {
  ensure(Array.isArray(payload) && payload.length === size * size, 'Google 回應未包含完整矩陣。');
  const durations = Array.from({ length: size }, () => Array(size));
  const distances = Array.from({ length: size }, () => Array(size));
  const visited = new Set();
  for (const cell of payload) {
    ensure(object(cell) && Number.isInteger(cell.originIndex) && cell.originIndex >= 0 && cell.originIndex < size
      && Number.isInteger(cell.destinationIndex) && cell.destinationIndex >= 0 && cell.destinationIndex < size, 'Google 矩陣索引無效。');
    const key = `${cell.originIndex}:${cell.destinationIndex}`;
    ensure(!visited.has(key), 'Google 矩陣含重複項目。'); visited.add(key);
    ensure(object(cell.status) && (cell.status.code === undefined || cell.status.code === 0)
      && cell.condition === 'ROUTE_EXISTS', 'Google 未能完成所有配送點之間的路線。');
    ensure(cell.fallbackInfo === undefined, 'Google 使用了替代計算模式，無法當作要求的路況估算。');
    ensure(Number.isSafeInteger(cell.distanceMeters) && cell.distanceMeters >= 0, 'Google 回傳的距離無效。');
    durations[cell.originIndex][cell.destinationIndex] = parseDuration(cell.duration);
    distances[cell.originIndex][cell.destinationIndex] = cell.distanceMeters;
  }
  return validateMatrix({ durations, distances }, size);
}
const coordinateString = points => points.map(point => `${point.lng},${point.lat}`).join(';');
const waypoint = point => ({ location: { latLng: { latitude: point.lat, longitude: point.lng } } });

/** Fixed endpoints only. The deadline includes fetch and the complete bounded response body. */
async function requestJson(fetchImpl, url, init) {
  const controller = new AbortController(); let timer;
  const task = (async () => {
    const response = await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal });
    ensure(response.ok, '地圖服務無法完成請求，沒有自動重試或替代資料。', 'map_http_error', 502);
    const declared = response.headers.get('content-length');
    if (declared !== null) ensure(/^\d+$/.test(declared) && Number(declared) <= MAX_RESPONSE_BYTES, '地圖服務回應超過 1 MiB。');
    ensure(response.body && typeof response.body.getReader === 'function', '地圖服務回應為空。');
    const reader = response.body.getReader(); let bytes = 0; const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new MapsError('地圖服務回應超過 1 MiB。'); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new MapsError('地圖服務回應不是有效 JSON。'); }
  })();
  try {
    return await Promise.race([task, new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new MapsError('地圖請求超過 10 秒，沒有自動重試。', 'map_timeout', 504)); }, TIMEOUT_MS);
    })]);
  } catch (error) {
    if (error instanceof MapsError) throw error;
    // Never forward response bodies, request URLs, SDK errors, or credential material.
    throw new MapsError('地圖服務連線失敗，沒有自動切換來源。', 'map_transport_error', 502);
  } finally { clearTimeout(timer); controller.abort(); }
}

/**
 * Matrix units are seconds/metres; index order is [depot, ...stops].
 * OSRM cache is process-local only. Google results are not cached or persisted here.
 */
export function createDeliveryMaps({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  ensure(typeof fetchImpl === 'function' && typeof now === 'function', '地圖介接設定無效。', 'invalid_configuration', 500);
  const cache = new Map(); let osrmGate = Promise.resolve(), lastOsrmStarted = -Infinity;
  const timestamp = () => {
    const value = Number(now()); ensure(Number.isFinite(value), '地圖時鐘設定無效。', 'invalid_configuration', 500); return value;
  };
  const keyConfigured = () => typeof process.env.GOOGLE_MAPS_API_KEY === 'string' && process.env.GOOGLE_MAPS_API_KEY.trim().length > 0;
  function providerAllowed(provider) {
    ensure(providers.includes(provider), '未知的地圖來源。', 'invalid_input', 400);
    if (provider === 'google') ensure(keyConfigured(), 'Google 路況尚未設定伺服器金鑰；未切換到其他來源。', 'google_not_configured', 503);
  }
  function cached(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    const age = timestamp() - entry.savedAt;
    if (age < 0 || age >= CACHE_TTL_MS) { cache.delete(key); return null; }
    cache.delete(key); cache.set(key, entry);
    return { ...clone(entry.value), provenance: { ...clone(entry.value.provenance), cached: true }, metrics: { requests: 0, elements: 0, elapsedMs: 0 } };
  }
  function remember(key, value) {
    cache.delete(key); cache.set(key, { savedAt: timestamp(), value: clone(value) });
    while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  }
  async function osrmSlot() {
    const slot = osrmGate.catch(() => {}).then(async () => {
      const pause = Math.max(0, Math.min(1000, 1000 - (timestamp() - lastOsrmStarted)));
      if (pause) await new Promise(resolve => setTimeout(resolve, pause));
      lastOsrmStarted = timestamp();
    });
    osrmGate = slot; await slot;
  }
  function provenance(provider, fetchedAt, dataVersion, geometry = false) {
    const labels = {
      fixture: geometry ? '固定示範直線；不是道路路線' : '固定示範矩陣；不是道路或即時路況',
      osrm: 'OSRM 道路估算 · no_live_traffic',
      google: 'Google Maps · 抓取當下路況估算；班次時鐘為情境設定',
    };
    return { provider, label: labels[provider], fetchedAt, traffic: provider === 'google', cached: false,
      ...(provider === 'google' ? { departureTime: fetchedAt } : {}),
      ...(typeof dataVersion === 'string' && dataVersion.length <= 160 ? { dataVersion } : {}) };
  }
  function headers(provider, fieldMask) {
    return provider === 'osrm'
      ? { Accept: 'application/json', 'User-Agent': USER_AGENT }
      : { 'Content-Type': 'application/json', 'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY, 'X-Goog-FieldMask': fieldMask };
  }
  async function matrix(draft, provider = 'osrm', force = false, request) {
    providerAllowed(provider); const points = positions(draft); const started = performance.now();
    ensure(typeof force === 'boolean', 'force 必須是布林值。', 'invalid_input', 400);
    const key = `matrix:${coordinateString(points)}`;
    if (provider === 'osrm' && !force) { const hit = cached(key); if (hit) return hit; }
    if (provider === 'osrm') cache.delete(key);
    if (provider === 'fixture') {
      return { ...validateMatrix(fixtureMatrix(draft), points.length), provenance: provenance(provider, new Date(timestamp()).toISOString()), metrics: { requests: 0, elements: 0, elapsedMs: performance.now() - started } };
    }
    if (provider === 'osrm') await osrmSlot();
    const fetchedAt = new Date(timestamp()).toISOString(); let payload, result;
    if (provider === 'osrm') {
      const url = `${OSRM_ORIGIN}/table/v1/driving/${coordinateString(points)}?annotations=duration,distance`;
      payload = await request(url, { method: 'GET', headers: headers(provider) }, points.length * points.length);
      ensure(object(payload) && payload.code === 'Ok' && (!payload.fallback_speed_cells || payload.fallback_speed_cells.length === 0), 'OSRM 無法提供完整道路矩陣。');
      result = validateMatrix(payload, points.length, true);
    } else {
      payload = await request(GOOGLE_MATRIX, { method: 'POST', headers: headers(provider, 'originIndex,destinationIndex,status,condition,distanceMeters,duration,fallbackInfo'),
        body: JSON.stringify({ origins: points.map(point => ({ waypoint: waypoint(point) })), destinations: points.map(point => ({ waypoint: waypoint(point) })), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE_OPTIMAL' }) }, points.length * points.length);
      result = googleMatrix(payload, points.length);
    }
    const value = { ...result, provenance: provenance(provider, fetchedAt, provider === 'osrm' ? payload.data_version : undefined), metrics: { requests: 1, elements: points.length * points.length, elapsedMs: performance.now() - started } };
    if (provider === 'osrm') remember(key, value);
    return value;
  }
  async function geometry(draft, order, provider = 'osrm', request) {
    providerAllowed(provider); const points = routePositions(draft, order); const started = performance.now();
    const key = `geometry:${coordinateString(points)}`;
    if (provider === 'osrm') { const hit = cached(key); if (hit) return hit; }
    if (provider === 'fixture') return { coordinates: points.map(({ lng, lat }) => [lng, lat]), provenance: provenance(provider, new Date(timestamp()).toISOString(), undefined, true), metrics: { requests: 0, elements: 0, elapsedMs: performance.now() - started } };
    if (provider === 'osrm') { cache.delete(key); await osrmSlot(); }
    const fetchedAt = new Date(timestamp()).toISOString(); let payload, coordinates;
    if (provider === 'osrm') {
      payload = await request(`${OSRM_ORIGIN}/route/v1/driving/${coordinateString(points)}?overview=full&geometries=geojson&steps=false&alternatives=false`, { method: 'GET', headers: headers(provider) }, 1);
      ensure(object(payload) && payload.code === 'Ok' && Array.isArray(payload.routes) && payload.routes.length === 1, 'OSRM 無法提供指定順序的道路路線。');
      coordinates = validateGeometry(payload.routes[0].geometry);
    } else {
      payload = await request(GOOGLE_ROUTE, { method: 'POST', headers: headers(provider, 'routes.polyline.geoJsonLinestring,fallbackInfo'),
        body: JSON.stringify({ origin: waypoint(points[0]), destination: waypoint(points.at(-1)), intermediates: points.slice(1, -1).map(waypoint), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE_OPTIMAL', optimizeWaypointOrder: false, computeAlternativeRoutes: false, polylineEncoding: 'GEO_JSON_LINESTRING', polylineQuality: 'OVERVIEW' }) }, 1);
      ensure(object(payload) && payload.fallbackInfo === undefined && Array.isArray(payload.routes) && payload.routes.length === 1, 'Google 無法依要求模式提供指定順序的路線。');
      coordinates = validateGeometry(payload.routes[0].polyline?.geoJsonLinestring);
    }
    const value = { coordinates, provenance: provenance(provider, fetchedAt, provider === 'osrm' ? payload.data_version : undefined, true), metrics: { requests: 1, elements: 1, elapsedMs: performance.now() - started } };
    if (provider === 'osrm') remember(key, value);
    return value;
  }
  async function tracked(operation, args) {
    const started = performance.now(); let requests = 0, elements = 0;
    const request = async (url, init, size) => { requests++; elements += size; return requestJson(fetchImpl, url, init); };
    try { return await operation(...args, request); }
    catch (error) {
      const safe = error instanceof MapsError ? error : new MapsError('配送輸入或地圖回應無效。');
      safe.metrics = { requests, elements, elapsedMs: performance.now() - started };
      throw safe;
    }
  }
  return {
    health: () => ({ osrm: true, googleConfigured: keyConfigured() }),
    matrix: (draft, provider = 'osrm', force = false) => tracked(matrix, [draft, provider, force]),
    geometry: (draft, order, provider = 'osrm') => tracked(geometry, [draft, order, provider]),
  };
}
