import { gunzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { runCircuit } from '../../dist/index.js';
import { checkLocalRequest, readApiBody } from './api.mjs';

export const BUS_SOURCES = {
  stops: 'https://tcgbusfs.blob.core.windows.net/blobbus/GetStop.gz',
  routes: 'https://tcgbusfs.blob.core.windows.net/blobbus/GetRoute.gz',
  estimates: 'https://tcgbusfs.blob.core.windows.net/blobbus/GetEstimateTime.gz',
};
export const BUS_DATASET = 'https://data.taipei/dataset/detail?id=f11a5af0-7b37-48ef-98cc-f6f102ed43c6';
const DOC = 'https://www-ws.gov.taipei/001/Upload/458/relfile/22545/6554360/a8aabcb9-8dfb-4812-9a37-83fb9a03c471.pdf';
const MAX_COMPRESSED = 3 * 1024 * 1024, MAX_INFLATED = 16 * 1024 * 1024;
const STATIC_TTL = 24 * 3600_000, ETA_TTL = 15_000, MAX_FRESH_SECONDS = 120;
const EXAMPLES = [
  { id: 'taipei-station', title: '台北車站候車', description: '搜尋站牌，選擇公車路線與行車方向', query: '臺北車站' },
  { id: 'city-hall', title: '市政府站出發', description: '查看忠孝東路沿線不同方向的站牌', query: '捷運市政府站' },
  { id: 'palace-museum', title: '故宮參觀後搭車', description: '分清正館與山下站牌，選對返程方向', query: '故宮博物院' },
];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const clean = (value, n = 160) => typeof value === 'string' ? value.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, n) : '';
const id = value => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) || (typeof value === 'string' && /^\d{1,12}$/.test(value)) ? String(value) : null;
const normalizeName = value => value.normalize('NFKC').replaceAll('臺', '台').replace(/\s/g, '').toLowerCase();
function need(value, message, status = 400) { if (!value) { const e = new Error(message); e.status = status; throw e; } }
function fields(value, names) { need(plain(value) && Object.keys(value).every(k => names.includes(k)), '公車查詢含不支援的欄位。'); }
const inside = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && lat >= 24.95 && lat <= 25.22 && lng >= 121.45 && lng <= 121.67;

/** The source's slash-form UpdateTime has no zone. It is Taiwan local time, never host local time. */
export function parseBusSourceTime(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/); if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  if (year < 2000 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const valueMs = Date.UTC(year, month - 1, day, hour, minute, second), d = new Date(valueMs);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return new Date(valueMs - 8 * 3600_000).toISOString();
}
export function busFreshness(sourceUpdatedAt, at = Date.now(), maxAgeSeconds = MAX_FRESH_SECONDS) {
  const stamp = Date.parse(sourceUpdatedAt); const ageSeconds = Number.isFinite(stamp) ? (at - stamp) / 1000 : null;
  return { state: ageSeconds === null ? 'unknown' : ageSeconds < 0 ? 'future' : ageSeconds <= maxAgeSeconds ? 'fresh' : 'stale', ageSeconds, maxAgeSeconds, sourceUpdatedAt: Number.isFinite(stamp) ? sourceUpdatedAt : null };
}
const negativeStatus = { '-1': ['not_departed', '尚未發車'], '-2': ['not_stopping', '交管不停靠'], '-3': ['last_bus_passed', '末班車已過'], '-4': ['not_running_today', '今日未營運'] };
export function parseBusEstimate(value) {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return { seconds: null, status: 'unknown', label: '來源預估格式待確認' };
  if (Object.hasOwn(negativeStatus, value)) return { seconds: null, status: negativeStatus[value][0], label: negativeStatus[value][1], code: Number(value) };
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 24 * 3600) return { seconds: null, status: 'unknown', label: '來源預估數值待確認' };
  return { seconds, status: 'estimated', label: seconds === 0 ? '即將到站（來源預估）' : `約 ${Math.max(1, Math.ceil(seconds / 60))} 分鐘（來源預估）`, code: seconds };
}

function table(payload, kind) {
  const cap = kind === 'routes' ? 5000 : 60000;
  need(plain(payload) && plain(payload.EssentialInfo) && Array.isArray(payload.BusInfo) && payload.BusInfo.length > 0 && payload.BusInfo.length <= cap, '官方公車資料格式不符或為空。', 502);
  return { rows: payload.BusInfo, sourceUpdatedAt: parseBusSourceTime(payload.EssentialInfo.UpdateTime) };
}
function mapRouteRows(rows) {
  const map = new Map(), conflicts = new Set();
  for (const row of rows) {
    const routeId = id(row?.Id), name = clean(row?.nameZh); if (!routeId || !name) continue;
    const value = { id: routeId, name, departure: clean(row.departureZh), destination: clean(row.destinationZh) };
    const prior = map.get(routeId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(value)) conflicts.add(routeId); else map.set(routeId, value);
  }
  for (const key of conflicts) map.delete(key); return map;
}
function mapStopRows(rows, routes) {
  const map = new Map(), conflicts = new Set();
  for (const row of rows) {
    const stopId = id(row?.Id), routeId = id(row?.routeId), direction = String(row?.goBack), name = clean(row?.nameZh), lat = Number(row?.latitude), lng = Number(row?.longitude);
    const route = routes.get(routeId);
    if (!stopId || !route || !name || !['0', '1'].includes(direction) || !inside(lat, lng)) continue;
    const value = { id: stopId, name, lat, lng, routeId, routeName: route.name, direction, destination: direction === '0' ? route.destination : route.departure, address: clean(row.address, 240), stopLocationId: id(row.stopLocationId) };
    const prior = map.get(stopId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(value)) conflicts.add(stopId); else map.set(stopId, value);
  }
  for (const key of conflicts) map.delete(key); return map;
}
function distanceMeters(a, b) {
  const rad = n => n * Math.PI / 180, dlat = rad(b.lat - a.lat), dlng = rad(b.lng - a.lng);
  return 6371008.8 * 2 * Math.asin(Math.min(1, Math.sqrt(Math.sin(dlat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dlng / 2) ** 2)));
}
async function fetchTable(fetchImpl, kind, { signal, timeoutMs }) {
  const controller = new AbortController(); let timer, cancel;
  const operation = (async () => {
    const response = await fetchImpl(BUS_SOURCES[kind], { method: 'GET', redirect: 'error', signal: controller.signal, headers: { accept: 'application/octet-stream, application/json', 'user-agent': 'JEV-Bus-Studio/0.1 (+https://github.com/carlchou0dailyfresh/jev-gates)' } });
    need(response.ok, '官方公車來源暫時無法回應。', 502);
    const declared = response.headers.get('content-length');
    need(declared === null || /^\d+$/.test(declared) && Number(declared) <= MAX_COMPRESSED, '官方公車壓縮資料超過上限。', 502);
    need(response.body?.getReader, '官方公車來源沒有有效內容。', 502);
    const reader = response.body.getReader(), chunks = []; let bytes = 0;
    try { while (true) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > MAX_COMPRESSED) { await reader.cancel(); need(false, '官方公車資料超過讀取上限。', 502); } chunks.push(Buffer.from(value)); } }
    finally { reader.releaseLock(); }
    need(!signal?.aborted, '公車查詢已取消。', 499);
    const raw = Buffer.concat(chunks);
    const decoded = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw, { maxOutputLength: MAX_INFLATED }) : raw;
    need(decoded.length <= MAX_INFLATED, '官方公車解壓資料超過上限。', 502);
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded));
    return { ...table(payload, kind), lastModified: response.headers.get('last-modified') };
  })();
  try {
    return await Promise.race([operation,
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs); }),
      new Promise((_, reject) => { cancel = () => { controller.abort(); const e = new Error('公車查詢已取消。'); e.status = 499; reject(e); }; signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel(); }),
    ]);
  } catch (error) { const e = new Error(error.status ? error.message : '官方公車資料連線失敗、逾時或格式無效；未以示範值替代。'); e.status = error.status ?? 502; throw e; }
  finally { clearTimeout(timer); controller.abort(); signal?.removeEventListener('abort', cancel); }
}
async function gateArrival(input) {
  const nodes = [
    { id: 'sourceRecent', kind: 'rule', path: '/sourceAge', op: 'lte', value: 120 },
    { id: 'sourceNotFuture', kind: 'rule', path: '/sourceAge', op: 'gte', value: 0 },
    { id: 'catalogCurrent', kind: 'rule', path: '/catalogCurrent', op: 'eq', value: true },
    { id: 'stationMatched', kind: 'rule', path: '/stationMatched', op: 'eq', value: true },
    { id: 'directionMatched', kind: 'rule', path: '/directionMatched', op: 'eq', value: true },
    { id: 'estimateUsable', kind: 'rule', path: '/estimateUsable', op: 'eq', value: true },
    { id: 'showEstimate', kind: 'logic', op: 'and', inputs: ['sourceRecent', 'sourceNotFuture', 'catalogCurrent', 'stationMatched', 'directionMatched', 'estimateUsable'] },
  ];
  return runCircuit({ version: 1, name: 'bus-provider-eta-v1', nodes, outputs: ['showEstimate'] }, input);
}
const gateLabels = { sourceRecent: '來源快照不超過 120 秒', sourceNotFuture: '來源時間沒有異常超前', catalogCurrent: '站牌與路線資料仍有效', stationMatched: '官方站牌與路線代碼相符', directionMatched: '供應者去返程與選站方向相符', estimateUsable: '供應者有有效預估秒數', showEstimate: 'AND：顯示來源預估' };

export function createBusArrivalsService(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch, now = options.now ?? Date.now, timeoutMs = options.timeoutMs ?? 10000;
  const cache = new Map(), inFlight = new Map(); let queue = Promise.resolve(), lastStart = -Infinity;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  async function acquire(signal) {
    const next = queue.then(async () => { need(!signal?.aborted, '公車查詢已取消。', 499); const wait = Math.max(0, 1000 - (now() - lastStart)); if (wait) await sleep(wait); need(!signal?.aborted, '公車查詢已取消。', 499); lastStart = now(); }); queue = next.catch(() => {}); return next;
  }
  async function load(kind, signal, metrics) {
    need(!signal?.aborted, '公車查詢已取消。', 499);
    const prior = cache.get(kind), ttl = kind === 'estimates' ? ETA_TTL : STATIC_TTL;
    if (prior && now() >= prior.savedAt && now() - prior.savedAt < ttl) { metrics.cacheHits++; return { ...prior.value, cached: true }; }
    if (inFlight.has(kind)) { metrics.cacheHits++; return { ...await inFlight.get(kind), cached: true, sharedRequest: true }; }
    cache.delete(kind);
    const operation = (async () => { await acquire(signal); metrics.requests++; const value = await fetchTable(fetchImpl, kind, { signal, timeoutMs }); const result = { ...value, fetchedAt: new Date(now()).toISOString(), cached: false, sourceUrl: BUS_SOURCES[kind] }; need(!signal?.aborted, '公車查詢已取消。', 499); cache.set(kind, { savedAt: now(), value: result }); return result; })();
    inFlight.set(kind, operation);
    try { return await operation; } finally { inFlight.delete(kind); }
  }
  async function catalog(signal, metrics) {
    // Finish both bounded source attempts before reporting their counters, including failure paths.
    const results = await Promise.allSettled([load('stops', signal, metrics), load('routes', signal, metrics)]);
    const failure = results.find(result => result.status === 'rejected'); if (failure) throw failure.reason;
    const [stops, routes] = results.map(result => result.value); const routeMap = mapRouteRows(routes.rows);
    return { stops, routes, stopMap: mapStopRows(stops.rows, routeMap), routeMap };
  }
  const provenance = item => ({ provider: 'taipei-bus-open-data', sourceUrl: item.sourceUrl, sourceUpdatedAt: item.sourceUpdatedAt, fetchedAt: item.fetchedAt, httpLastModified: item.lastModified, cached: item.cached, timestampMeaning: 'EssentialInfo.UpdateTime is feed snapshot time; individual ETA measurement time is not provided' });
  return {
    config() { return { configured: true, provider: 'taipei-bus-open-data', requiresKey: false, examples: clone(EXAMPLES), defaults: { query: EXAMPLES[0].query }, sourceUrl: BUS_DATASET, documentationUrl: DOC, limits: { maxFreshSeconds: 120, maxStops: 24, nearbyMeters: 1000, refreshSeconds: 30, maxAutoRefreshes: 10 }, label: '臺北市官方公車預估 · 不是保證到站時間', modelRequests: 0 }; },
    async stops(body, signal) {
      fields(body, ['query', 'lat', 'lng']);
      const hasQuery = body.query !== undefined; need(hasQuery !== (body.lat !== undefined || body.lng !== undefined), '請用站名／站址文字，或一組位置查詢附近站牌。');
      if (hasQuery) need(typeof body.query === 'string' && body.query.trim().length >= 2 && body.query.length <= 100, '站名或站址請輸入 2–100 字。');
      else need(typeof body.lat === 'number' && typeof body.lng === 'number' && inside(body.lat, body.lng), '目前僅支援台北市區附近站牌。');
      const metrics = { requests: 0, cacheHits: 0, modelRequests: 0 }; const started = performance.now();
      try {
        const data = await catalog(signal, metrics); need(!signal?.aborted, '公車查詢已取消。', 499);
        const tokens = hasQuery ? body.query.normalize('NFKC').trim().split(/\s+/).map(normalizeName) : null;
        const rows = [...data.stopMap.values()].map(stop => ({ ...stop, ...(!hasQuery ? { distanceMeters: distanceMeters(body, stop) } : {}) })).filter(stop => hasQuery ? tokens.every(token => normalizeName(`${stop.name} ${stop.address} ${stop.routeName}`).includes(token)) : stop.distanceMeters <= 1000);
        rows.sort((a, b) => hasQuery ? a.name.localeCompare(b.name, 'zh-TW') || a.routeName.localeCompare(b.routeName, 'zh-TW', { numeric: true }) || a.direction.localeCompare(b.direction) : a.distanceMeters - b.distanceMeters || a.routeName.localeCompare(b.routeName, 'zh-TW', { numeric: true }));
        metrics.elapsedMs = performance.now() - started;
        return { stops: clone(rows.slice(0, 24)), total: rows.length, omitted: Math.max(0, rows.length - 24), summary: { state: 'ready', title: rows.length ? '請選擇路線與行車方向' : '這個範圍沒有找到站牌', detail: '每個選項是官方獨立站牌代碼，同名站牌的去返程不會合併。' }, provenance: { stops: provenance(data.stops), routes: provenance(data.routes) }, metrics };
      } catch (error) { if (error.status === 499) throw error; metrics.elapsedMs = performance.now() - started; return { stops: [], total: 0, omitted: 0, summary: { state: 'unavailable', title: '暫時無法取得官方站牌', detail: error.message }, provenance: { provider: 'taipei-bus-open-data', sourceUrl: BUS_DATASET }, metrics }; }
    },
    async arrivals(body, signal) {
      fields(body, ['stopId', 'routeId', 'direction']); const stopId = id(body.stopId), routeId = id(body.routeId);
      need(stopId && routeId && ['0', '1'].includes(body.direction), '請從官方查詢結果選擇站牌、路線與方向。');
      const metrics = { requests: 0, cacheHits: 0, modelRequests: 0 }; const started = performance.now();
      let stop = null;
      try {
        const data = await catalog(signal, metrics); stop = data.stopMap.get(stopId);
        need(stop && stop.routeId === routeId && stop.direction === body.direction, '站牌、路線或方向與官方資料不符，請重新選擇。');
        const estimates = await load('estimates', signal, metrics); need(!signal?.aborted, '公車查詢已取消。', 499);
        const selected = estimates.rows.filter(row => id(row?.StopID) === stopId && id(row?.RouteID) === routeId);
        const unique = [...new Map(selected.map(row => [JSON.stringify([row.EstimateTime, row.GoBack]), row])).values()];
        const raw = unique.length === 1 ? unique[0] : null, parsed = raw ? parseBusEstimate(raw.EstimateTime) : { seconds: null, status: 'unknown', label: unique.length > 1 ? '來源有互相衝突的預估' : '來源沒有這個站牌的預估' };
        let fresh = busFreshness(estimates.sourceUpdatedAt, now());
        const catalogStates = [data.stops, data.routes].map(x => busFreshness(x.sourceUpdatedAt, now(), 48 * 3600));
        const rawDirection = raw ? String(raw.GoBack) : null;
        const directionKnown = ['0', '1'].includes(rawDirection);
        const input = { ...(!catalogStates.some(x => x.state === 'unknown') ? { catalogCurrent: catalogStates.every(x => x.state === 'fresh') } : {}), stationMatched: Boolean(raw), ...(fresh.ageSeconds !== null ? { sourceAge: fresh.ageSeconds } : {}), ...(directionKnown ? { directionMatched: rawDirection === stop.direction } : {}), ...(parsed.status !== 'unknown' ? { estimateUsable: parsed.seconds !== null } : {}) };
        let circuit = await gateArrival(input);
        // The exact-only circuit performs no network work, but recheck a boundary crossed during its microtask.
        const afterCircuit = busFreshness(estimates.sourceUpdatedAt, now());
        if (fresh.state !== afterCircuit.state) {
          if (afterCircuit.ageSeconds === null) delete input.sourceAge; else input.sourceAge = afterCircuit.ageSeconds;
          circuit = await gateArrival(input);
        }
        fresh = afterCircuit;
        const truth = circuit.outputs.showEstimate.truth;
        const allowed = truth === 'TRUE'; let label = parsed.label; let status = parsed.status;
        if (fresh.state !== 'fresh') { label = fresh.state === 'stale' ? '資料已過期，暫不顯示到站分鐘' : '來源時間待確認，暫不顯示到站分鐘'; status = 'unavailable'; }
        else if (!input.catalogCurrent) { label = '站牌資料較舊，請重新核對'; status = 'unknown'; }
        else if (parsed.seconds !== null && !allowed) { label = directionKnown ? '來源去返程資料不一致，暫不顯示到站分鐘' : rawDirection === '2' ? '來源標記尚未發車，暫不採用另附的預估分鐘' : '來源方向或行車狀態待確認'; status = 'unknown'; }
        const arrivals = [{ stopId, routeId, direction: stop.direction, etaSeconds: allowed ? parsed.seconds : null, status, label, sourceUpdatedAt: estimates.sourceUpdatedAt }];
        const gates = Object.entries(circuit.signals).map(([key, value]) => ({ id: key, label: gateLabels[key] ?? key, truth: value.truth, reason: value.reason, detail: key === 'sourceRecent' ? '以官方 EssentialInfo.UpdateTime 計算，並非本次抓取時間。' : value.truth === 'UNKNOWN' ? '所需資料不足，保留 UNKNOWN。' : '由 jev-gates 確定性規則與 AND 電路執行，沒有模型推測。' }));
        metrics.elapsedMs = performance.now() - started;
        return { stop: clone(stop), route: clone(data.routeMap.get(routeId)), direction: stop.direction, arrivals, freshness: fresh, gates, truth,
          summary: { state: allowed ? 'ready' : 'review', title: label, detail: '這是官方來源在更新時刻提供的預估，不是 AI 推算或保證到站時間；未自行扣秒或延伸成即時倒數。' },
          provenance: { sourceUpdatedAt: estimates.sourceUpdatedAt, fetchedAt: estimates.fetchedAt, sourceUrl: BUS_SOURCES.estimates, estimates: provenance(estimates), stops: provenance(data.stops), routes: provenance(data.routes), engine: 'jev-gates rule + AND circuit', semanticModelUsed: false },
          evidence: { estimateCode: raw?.EstimateTime ?? null, sourceDirection: rawDirection, matchedRows: selected.length, uniqueRows: unique.length, timestampScope: 'feed_snapshot_only' }, metrics };
      } catch (error) { if (error.status === 400 || error.status === 499) throw error; metrics.elapsedMs = performance.now() - started; const circuit = await gateArrival({}); return { stop: stop ? clone(stop) : null, arrivals: [], freshness: busFreshness(null, now()), gates: Object.entries(circuit.signals).map(([key, value]) => ({ id: key, label: gateLabels[key] ?? key, truth: value.truth, reason: value.reason })), truth: 'UNKNOWN', summary: { state: 'unavailable', title: '暫時無法取得官方預估', detail: error.message }, provenance: { provider: 'taipei-bus-open-data', sourceUrl: BUS_DATASET, semanticModelUsed: false }, metrics }; }
    },
  };
}

export function createBusArrivalsApi(options = {}) {
  const service = createBusArrivalsService(options); let active = false;
  return async (req, res) => {
    const send = (status, body) => { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(body)); };
    const controller = new AbortController(), close = () => { if (!res.writableEnded) controller.abort(); }; res.on('close', close); let occupied = false;
    try { checkLocalRequest(req); const path = req.url?.split('?')[0];
      if (path === '/api/bus/config') { need(req.method === 'GET', '僅接受 GET。', 405); send(200, service.config()); return; }
      need(['/api/bus/stops', '/api/bus/arrivals'].includes(path), '找不到公車端點。', 404); need(req.method === 'POST', '僅接受 POST。', 405);
      const body = await readApiBody(req, 5000, 8 * 1024); need(!active, '正在處理公車查詢，請稍後再試。', 429); active = true; occupied = true;
      send(200, await (path === '/api/bus/stops' ? service.stops(body, controller.signal) : service.arrivals(body, controller.signal)));
    } catch (error) { send(error.status ?? 500, { error: error.status ? error.message : '公車查詢暫時無法完成。' }); }
    finally { if (occupied) active = false; res.off('close', close); }
  };
}
