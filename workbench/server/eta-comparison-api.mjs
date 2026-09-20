import { performance } from 'node:perf_hooks';
import { checkLocalRequest, readApiBody } from './api.mjs';
import { createBusArrivalsService, BUS_DATASET } from './bus-arrivals.mjs';

const GOOGLE_ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const GOOGLE_MASK = 'routes.duration,routes.distanceMeters,fallbackInfo';
const OSRM_ENDPOINT = 'https://router.project-osrm.org';
const MAX_BYTES = 1024 * 1024;
const USER_AGENT = 'JEV-ETA-Comparison/0.1 (+https://github.com/carlchou0dailyfresh/jev-gates)';
const station = { name: '台北車站', lat: 25.0468, lng: 121.5172 };
const SCENARIOS = [
  { id: 'car-station-101', kind: 'car', title: '台北車站 → 台北 101', description: '同一組起終點，對照汽車全程估時', origin: station, destination: { name: '台北 101', lat: 25.033, lng: 121.5654 } },
  { id: 'car-station-palace', kind: 'car', title: '台北車站 → 故宮博物院', description: '市區到山麓的汽車估時', origin: station, destination: { name: '國立故宮博物院', lat: 25.1015744, lng: 121.5488623 } },
  { id: 'car-cityhall-arena', kind: 'car', title: '台北市政府 → 台北小巨蛋', description: '市區短程汽車估時', origin: { name: '台北市政府', lat: 25.0375, lng: 121.5637 }, destination: { name: '台北小巨蛋', lat: 25.0515, lng: 121.5498 } },
  { id: 'bus-station-299-outbound', kind: 'bus_wait', title: '台北車站等 299 · 去程', description: '只比站牌等待時間，不含車程', bus: { query: '臺北車站 299', stopName: '臺北車站(忠孝)', routeName: '299', direction: '0' } },
  { id: 'bus-station-299-inbound', kind: 'bus_wait', title: '台北車站等 299 · 返程', description: '同路線另一方向，站牌代碼需另行核對', bus: { query: '臺北車站 299', stopName: '臺北車站(忠孝)', routeName: '299', direction: '1' } },
  { id: 'bus-cityhall-blue10-outbound', kind: 'bus_wait', title: '市政府站等藍10 · 去程', description: '從官方站牌表即時解析路線和方向', bus: { query: '捷運市政府站 藍10', stopName: '捷運市政府站', routeName: '藍10', direction: '0' } },
];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const nonNegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const normalizeName = value => typeof value === 'string' ? value.normalize('NFKC').replaceAll('臺', '台').replace(/\s/g, '') : '';
function need(value, message, status = 400) { if (!value) { const error = new Error(message); error.status = status; throw error; } }
function fields(value, names) { need(plain(value) && Object.keys(value).every(key => names.includes(key)), '比較請求含不支援的欄位。'); }
function abortCheck(signal) { need(!signal?.aborted, '比較已取消，沒有啟動後續請求。', 499); }
function mapsUrl(scenario, stop) {
  const url = new URL(scenario.kind === 'car' ? 'https://www.google.com/maps/dir/' : 'https://www.google.com/maps/search/');
  url.searchParams.set('api', '1');
  if (scenario.kind === 'car') {
    url.searchParams.set('origin', `${scenario.origin.lat},${scenario.origin.lng}`); url.searchParams.set('destination', `${scenario.destination.lat},${scenario.destination.lng}`); url.searchParams.set('travelmode', 'driving');
  } else url.searchParams.set('query', stop ? `${stop.lat},${stop.lng}` : `${scenario.bus.stopName} ${scenario.bus.routeName} 公車`);
  return url.href;
}
function manualReference(scenario, stop) {
  return { provider: 'google_maps_manual', quantity: scenario.kind === 'car' ? 'drive_duration' : 'bus_wait', requiredConfirmations: scenario.kind === 'car' ? ['same_origin_destination', 'driving_mode', 'departure_now', 'observation_time'] : ['same_stop', 'same_route', 'same_direction', 'waiting_time_only', 'observation_time'],
    ...(stop ? { stopId: stop.id, stopName: stop.name, routeId: stop.routeId, routeName: stop.routeName, direction: stop.direction, destination: stop.destination } : {}),
    instruction: scenario.kind === 'car' ? '請核對同一組起終點、汽車模式與現在出發；記錄 Google Maps 畫面顯示分鐘及觀察時間。' : '只記錄這個站牌、路線、方向的下一班等待時間。若 Google Maps 只顯示轉乘或全程時間，請留白，不能拿來比較。' };
}
async function requestJson(fetchImpl, url, init, { signal, timeoutMs }) {
  abortCheck(signal); const controller = new AbortController(); let timer, cancel;
  const operation = (async () => {
    const response = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'error' });
    need(response.ok, '提供者目前無法完成估時請求。', 502);
    const declared = response.headers.get('content-length'); need(declared === null || /^\d+$/.test(declared) && Number(declared) <= MAX_BYTES, '提供者回應超過讀取上限。', 502);
    need(response.body?.getReader, '提供者沒有有效回應。', 502);
    const reader = response.body.getReader(), chunks = []; let bytes = 0;
    try { while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > MAX_BYTES) { await reader.cancel(); need(false, '提供者回應超過讀取上限。', 502); } chunks.push(Buffer.from(value)); } }
    finally { reader.releaseLock(); }
    abortCheck(signal); return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  })();
  try { return await Promise.race([operation,
    new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs); }),
    new Promise((_, reject) => { cancel = () => { controller.abort(); const e = new Error('比較已取消。'); e.status = 499; reject(e); }; signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel(); }),
  ]); }
  catch (error) { if (error.status === 499) throw error; const safe = new Error('提供者連線失敗、逾時或回應無效；沒有重試或製造替代值。'); safe.status = 502; throw safe; }
  finally { clearTimeout(timer); controller.abort(); signal?.removeEventListener('abort', cancel); }
}
function googleSeconds(value) { need(typeof value === 'string' && /^\d+(?:\.\d{1,9})?s$/.test(value), 'Google Routes 回傳的秒數無效。', 502); const seconds = Number(value.slice(0, -1)); need(nonNegative(seconds) && seconds <= 86400, 'Google Routes 秒數超過此市區案例的上限。', 502); return seconds; }
const sourceLabels = { osrm: 'OSRM 道路估時', google_routes: 'Google Maps · Routes API', taipei_bus: '臺北市官方公車預估' };
function unavailable(provider, quantity, reasonCode, detail, requestedAt = null) {
  return { provider, label: sourceLabels[provider], status: 'unavailable', quantity, valueSeconds: null, distanceMeters: null, sourceUpdatedAt: null, requestedAt, fetchedAt: null, reasonCode, detail, trafficAware: provider === 'google_routes', predictionOrigin: 'provider', semanticModelUsed: false };
}

export function createEtaComparisonService(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch, env = options.env ?? process.env, now = options.now ?? Date.now, timeoutMs = options.timeoutMs ?? 10_000;
  const bus = options.busService ?? createBusArrivalsService({ fetchImpl, now });
  const configured = () => typeof env.GOOGLE_MAPS_API_KEY === 'string' && env.GOOGLE_MAPS_API_KEY.trim().length > 0;
  const iso = () => new Date(now()).toISOString(); let lastStart = -Infinity, queue = Promise.resolve();
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  async function slot(signal) { const operation = queue.then(async () => { abortCheck(signal); const wait = Math.max(0, 1000 - (now() - lastStart)); if (wait) await sleep(wait); abortCheck(signal); lastStart = now(); }); queue = operation.catch(() => {}); return operation; }
  async function osrmObservation(scenario, signal, metrics) {
    abortCheck(signal); const requestedAt = iso(); metrics.osrmRequests++;
    try {
      const url = `${OSRM_ENDPOINT}/route/v1/driving/${scenario.origin.lng},${scenario.origin.lat};${scenario.destination.lng},${scenario.destination.lat}?overview=false&steps=false&alternatives=false`;
      const data = await requestJson(fetchImpl, url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT } }, { signal, timeoutMs });
      need(data?.code === 'Ok' && Array.isArray(data.routes) && data.routes.length > 0, 'OSRM 找不到路線。', 502);
      const route = data.routes[0]; need(nonNegative(route.duration) && route.duration <= 86400 && nonNegative(route.distance), 'OSRM 回傳里程或秒數無效。', 502);
      return { provider: 'osrm', label: sourceLabels.osrm, status: 'available', quantity: 'drive_duration', valueSeconds: route.duration, distanceMeters: route.distance, requestedAt, fetchedAt: iso(), sourceUpdatedAt: null, sourceUrl: 'https://project-osrm.org/', timestampMeaning: '取得回應的時間；OSRM 未提供本次道路模型或交通感測器的觀測時間。', trafficAware: false, predictionOrigin: 'provider', semanticModelUsed: false, detail: 'OSRM 的汽車道路估時，不含即時車流；不是 JEV 自行預估。' };
    } catch (error) { if (error.status === 499) throw error; return unavailable('osrm', 'drive_duration', 'provider_failed', 'OSRM 未完成本次道路估時，沒有用固定值替代。', requestedAt); }
  }
  async function googleObservation(scenario, signal, metrics) {
    abortCheck(signal);
    if (!configured()) return unavailable('google_routes', 'drive_duration', 'not_configured', '伺服器尚未設定 Google Maps API key；可開啟 Google Maps 手動觀察，沒有自動取得其預估。');
    const requestedAt = iso(); metrics.googleRequests++;
    try {
      const waypoint = point => ({ location: { latLng: { latitude: point.lat, longitude: point.lng } } });
      const data = await requestJson(fetchImpl, GOOGLE_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY, 'X-Goog-FieldMask': GOOGLE_MASK }, body: JSON.stringify({ origin: waypoint(scenario.origin), destination: waypoint(scenario.destination), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE_OPTIMAL', computeAlternativeRoutes: false, languageCode: 'zh-TW', regionCode: 'TW' }) }, { signal, timeoutMs });
      need(plain(data) && data.fallbackInfo === undefined && Array.isArray(data.routes) && data.routes.length === 1, 'Google Routes 未按要求完成，或使用了替代模式。', 502);
      const route = data.routes[0]; const seconds = googleSeconds(route.duration); need(Number.isSafeInteger(route.distanceMeters) && route.distanceMeters >= 0, 'Google Routes 里程無效。', 502);
      return { provider: 'google_routes', label: sourceLabels.google_routes, status: 'available', quantity: 'drive_duration', valueSeconds: seconds, distanceMeters: route.distanceMeters, requestedAt, fetchedAt: iso(), sourceUpdatedAt: null, sourceUrl: 'https://developers.google.com/maps/documentation/routes', timestampMeaning: '請求與回應時間；Google Routes 未提供此預估使用的個別車流感測器觀測時間。', trafficAware: true, predictionOrigin: 'provider', semanticModelUsed: false, attribution: 'Google Maps', retention: 'display_only_no_cache_or_export', detail: 'Google Routes API 的現在出發汽車預估；不是消費者 Google Maps App 畫面的讀值。' };
    } catch (error) { if (error.status === 499) throw error; return unavailable('google_routes', 'drive_duration', 'provider_failed', 'Google Routes 本次失敗、降級或回應無效，沒有重試；也沒有改用無路況值。', requestedAt); }
  }
  async function busObservation(scenario, signal, metrics) {
    abortCheck(signal); const requestedAt = iso(); let stop = null;
    try {
      const found = await bus.stops({ query: scenario.bus.query }, signal); metrics.busRequests += found.metrics?.requests ?? 0;
      need(found.summary?.state !== 'unavailable' && Array.isArray(found.stops) && !(found.omitted > 0), '官方站牌目前不可用，或查詢結果不完整。', 502);
      const candidates = found.stops.filter(s => normalizeName(s.name) === normalizeName(scenario.bus.stopName) && normalizeName(s.routeName) === normalizeName(scenario.bus.routeName) && s.direction === scenario.bus.direction);
      need(candidates.length === 1, '官方站牌沒有唯一符合的路線與方向，不能自行猜測。', 502);
      stop = candidates[0]; abortCheck(signal);
      const result = await bus.arrivals({ stopId: stop.id, routeId: stop.routeId, direction: stop.direction }, signal); metrics.busRequests += result.metrics?.requests ?? 0;
      const row = result.arrivals?.[0]; const freshStamp = Date.parse(result.freshness?.sourceUpdatedAt ?? result.provenance?.sourceUpdatedAt); const age = (now() - freshStamp) / 1000;
      const valid = result.truth === 'TRUE' && result.freshness?.state === 'fresh' && Number.isFinite(age) && age >= 0 && age <= 120 && row?.stopId === stop.id && row?.routeId === stop.routeId && row?.direction === stop.direction && nonNegative(row?.etaSeconds);
      const observation = { provider: 'taipei_bus', label: sourceLabels.taipei_bus, status: valid ? 'available' : 'unavailable', quantity: 'bus_wait', valueSeconds: valid ? row.etaSeconds : null, distanceMeters: null, requestedAt, fetchedAt: result.provenance?.fetchedAt ?? null, sourceUpdatedAt: result.provenance?.sourceUpdatedAt ?? null, sourceUrl: BUS_DATASET, timestampMeaning: '官方檔案快照 EssentialInfo.UpdateTime；不是每台車的 GPS 回報時間。', predictionOrigin: 'provider', semanticModelUsed: false, detail: valid ? '官方提供者在快照更新時刻的等車秒數；未扣秒倒數。' : result.summary?.title ?? '官方到站值未通過時間、站牌或方向檢查。', freshness: result.freshness, gates: result.gates, bus: { stopId: stop.id, stopName: stop.name, routeId: stop.routeId, routeName: stop.routeName, direction: stop.direction, destination: stop.destination } };
      return { observation, stop: clone(stop) };
    } catch (error) { if (error.status === 499) throw error; return { observation: unavailable('taipei_bus', 'bus_wait', 'not_verified', '找不到唯一的官方站牌，或來源未通過檢查；沒有猜測站牌或等待分鐘。', requestedAt), stop: stop ? clone(stop) : null }; }
  }
  return {
    config() { return { scenarios: SCENARIOS.map(scenario => ({ ...clone(scenario), googleMapsUrl: mapsUrl(scenario) })), google: { configured: configured(), configuredMeans: 'key_present_not_live_access_verified', automaticCalls: false, maxRequestsPerObservation: 1, attribution: 'Google Maps', storage: 'none' }, limits: { automaticPolling: false, maxProviderRequestsPerSecond: 1, maxResponseBytes: MAX_BYTES, timeoutMs }, limitations: ['預估差異不是準確率；需要實際行程或實際到站時間才能測誤差。', 'Google Routes API 和 Google Maps 消費者介面是不同觀察來源。', '公車等待時間不能與 Transit 全程／轉乘時間比較。'] }; },
    async observe(body, signal) {
      fields(body, ['scenarioId']); need(typeof body.scenarioId === 'string', '請選擇比較情境。'); const scenario = SCENARIOS.find(item => item.id === body.scenarioId); need(scenario, '找不到這個比較情境。');
      abortCheck(signal); await slot(signal); const started = performance.now(), observedAt = iso();
      const metrics = { osrmRequests: 0, googleRequests: 0, busRequests: 0, modelRequests: 0, elapsedMs: 0 }; let observations, stop = null;
      if (scenario.kind === 'car') {
        // One explicit observation launches one near-simultaneous pair; there is no batch or timer here.
        const pair = await Promise.allSettled([osrmObservation(scenario, signal, metrics), googleObservation(scenario, signal, metrics)]);
        const failed = pair.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
        observations = pair.map(result => result.value);
      } else { const result = await busObservation(scenario, signal, metrics); observations = [result.observation]; stop = result.stop; }
      abortCheck(signal); metrics.elapsedMs = performance.now() - started;
      const starts = observations.filter(item => item.requestedAt !== null).map(item => Date.parse(item.requestedAt));
      return { scenario: clone(scenario), observedAt, completedAt: iso(), observations, ...(stop ? { stop } : {}), googleMapsUrl: mapsUrl(scenario, stop), manualReference: manualReference(scenario, stop),
        pairing: { quantity: scenario.kind === 'car' ? 'drive_duration' : 'bus_wait', startSkewMs: starts.length > 1 ? Math.max(...starts) - Math.min(...starts) : null, sameEndpointsRequested: scenario.kind === 'car', samePathVerified: false, accuracyMeasured: false },
        summary: { title: scenario.kind === 'car' ? '同一次操作取得提供者估時' : '官方等車預估已檢查', detail: scenario.kind === 'car' ? '相同起終點可能選到不同道路。數值差距只能說明這次預估不同，不能評定誰較準。' : 'Google Maps 需手動核對同站、同路線、同方向的等待時間；全程交通時間不適用。' }, metrics };
    },
  };
}

export function createEtaComparisonApi(options = {}) {
  const service = createEtaComparisonService(options); let active = false;
  return async (req, res) => {
    const send = (status, body) => { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(body)); };
    const controller = new AbortController(), close = () => { if (!res.writableEnded) controller.abort(); }; res.on('close', close); let occupied = false;
    try {
      checkLocalRequest(req); const path = req.url?.split('?')[0];
      if (path === '/api/compare/config') { need(req.method === 'GET', '僅接受 GET。', 405); send(200, service.config()); return; }
      need(path === '/api/compare/observe', '找不到比較端點。', 404); need(req.method === 'POST', '僅接受 POST。', 405);
      const body = await readApiBody(req, 5000, 4 * 1024); need(!active, '這次比較尚未完成，請稍後再試。', 429); active = true; occupied = true; send(200, await service.observe(body, controller.signal));
    } catch (error) { send(error.status ?? 500, { error: error.status ? error.message : '比較服務暫時無法完成請求。' }); }
    finally { if (occupied) active = false; res.off('close', close); }
  };
}
