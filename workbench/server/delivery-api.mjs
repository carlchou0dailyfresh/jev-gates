import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { validateDeliveryDraft, solveDelivery } from './delivery-core.mjs';
import { createDeliveryMaps } from './delivery-maps.mjs';
import { compareDelivery, verifyDeliveryComparison } from './delivery-benchmark.mjs';
import { checkLocalRequest, readApiBody, workbenchHealth } from './api.mjs';
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const requireValue = (value, message, status = 400) => { if (!value) { const error = new Error(message); error.status = status; throw error; } };

export function createDeliveryService(options = {}) {
  const maps = options.maps ?? createDeliveryMaps();
  const snapshots = new Map();
  const scenario = async () => options.scenario ?? JSON.parse(await readFile(new URL('../delivery-scenario.json', import.meta.url), 'utf8'));
  const now = options.now ?? Date.now;
  function expire() { for (const [id, record] of snapshots) if (now() - record.savedAt > 600_000) snapshots.delete(id); }
  return {
    async config() { return { scenario: await scenario(), maps: maps.health(), health: await (options.health ?? workbenchHealth)() }; },
    async plan(body) {
      requireValue(plain(body) && Object.keys(body).every(key => ['draft', 'provider'].includes(key)), '規劃輸入欄位無效。');
      requireValue(['fixture', 'osrm', 'google'].includes(body.provider), '地圖來源無效。');
      const draft = validateDeliveryDraft(body.draft); const started = performance.now();
      const matrix = await maps.matrix(draft, body.provider);
      const plan = solveDelivery(draft, matrix);
      let geometry = { coordinates: [], provenance: { provider: body.provider, label: '沒有完整可達路線', traffic: body.provider === 'google', fetchedAt: new Date().toISOString(), cached: false }, metrics: { requests: 0, elements: 0, elapsedMs: 0 } };
      let geometryError = null;
      if (body.provider === 'google') geometry.provenance.label = 'Google Maps · 以路線列表顯示，未另行要求幾何';
      if (plan.order.length && body.provider !== 'google') {
        try { geometry = await maps.geometry(draft, plan.order, body.provider); }
        catch (error) { if (error.metrics) geometry.metrics = error.metrics; geometryError = '路線估時已取得，但路線形狀抓取失敗；沒有用直線冒充道路路線。'; }
      }
      const id = randomUUID(); const createdAt = new Date().toISOString();
      // Google results are only used for the immediate display, never exported or put in the replay store.
      if (body.provider !== 'google') {
        expire(); snapshots.set(id, { savedAt: now(), snapshot: structuredClone({ id, draft, matrix, plan, createdAt }) });
        while (snapshots.size > 12) snapshots.delete(snapshots.keys().next().value);
      }
      return { id, draft, plan, matrix: { provenance: matrix.provenance, metrics: matrix.metrics }, geometry, geometryError, comparisonAllowed: body.provider !== 'google', metrics: { requests: matrix.metrics.requests + geometry.metrics.requests, elements: matrix.metrics.elements + geometry.metrics.elements, elapsedMs: performance.now() - started }, createdAt };
    },
    async compare(body, signal) {
      requireValue(plain(body) && typeof body.planId === 'string', '請先產生一份路線計畫。');
      expire(); const record = snapshots.get(body.planId);
      requireValue(record, '計畫快照已過期，或此資料來源不支援保存比較；請使用示範或 OSRM 重新規劃。', 404);
      return compareDelivery(record.snapshot, body, { scenario: await scenario(), signal, ...(options.comparisonOptions ?? {}) });
    },
    async verify(body) { requireValue(plain(body) && Object.keys(body).length === 1 && body.report, '請提供一份配送比較報告。'); return verifyDeliveryComparison(body.report); },
  };
}

export function createDeliveryApi(options = {}) {
  const service = createDeliveryService(options); let active = false;
  return async (req, res) => {
    const send = (status, body) => { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(body)); };
    let occupied = false; const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); }; res.on('close', onClose);
    try {
      checkLocalRequest(req); const pathname = req.url?.split('?')[0];
      if (pathname === '/api/delivery/config') { requireValue(req.method === 'GET', '僅接受 GET。', 405); send(200, await service.config()); return; }
      requireValue(['/api/delivery/plan', '/api/delivery/compare', '/api/delivery/verify'].includes(pathname), '找不到配送端點。', 404);
      requireValue(req.method === 'POST', '僅接受 POST。', 405);
      const body = await readApiBody(req, 5000, pathname === '/api/delivery/verify' ? 1024 * 1024 : 64 * 1024);
      requireValue(!active, '正在處理另一份配送計算，請完成或取消後再試。', 429);
      active = true; occupied = true;
      const value = pathname === '/api/delivery/plan' ? await service.plan(body) : pathname === '/api/delivery/compare' ? await service.compare(body, controller.signal) : await service.verify(body);
      send(200, value);
    } catch (error) { send(error.status ?? 400, { error: error.message ?? '配送研究無法完成。', ...(error.metrics ? { metrics: Object.fromEntries(['requests', 'elements', 'elapsedMs'].filter(key => Number.isFinite(error.metrics[key]) && error.metrics[key] >= 0).map(key => [key, error.metrics[key]])) } : {}) }); }
    finally { res.off('close', onClose); if (occupied) active = false; }
  };
}
