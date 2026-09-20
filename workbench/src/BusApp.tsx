import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { ArrowLeft, ArrowUpRight, BusFront, Check, ChevronRight, Clock3, GitBranch, Info, MapPin, Pause, Play, RefreshCw, Search } from 'lucide-react';
import './bus.css';

type Stop = { id: string; name: string; lat: number; lng: number; routeId: string; routeName: string; direction: string; destination?: string };
type Example = { id: string; title: string; description: string; query: string };
type Arrival = { etaSeconds: number | null; label: string; status: string; sourceUpdatedAt?: string };
type Result = { stop: Stop; arrivals: Arrival[]; freshness: { state: string; ageSeconds: number | null; maxAgeSeconds: number }; gates: { id: string; label: string; truth: string; detail: string }[]; summary: { state?: string; title: string; detail: string }; provenance: { sourceUpdatedAt?: string; fetchedAt?: string; sourceUrl?: string }; metrics?: { modelRequests?: number } };
type Configuration = { examples: Example[]; configured?: boolean; source?: { label?: string; url?: string }; limits?: Record<string, number> };
async function busApi<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/bus/${path}`, { ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), signal });
  const data = await response.json(); if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || '公車資料暫時無法取得。'); return data;
}
const time = (v?: string) => v && Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '未提供';
const key = (s: Stop) => `${s.id}:${s.routeId}:${s.direction}`;
function BusMap({ stops, selected, onPick }: { stops: Stop[]; selected: Stop | null; onPick: (s: Stop) => void }) {
  const root = useRef<HTMLDivElement>(null); const map = useRef<L.Map | null>(null); const group = useRef<L.LayerGroup | null>(null); const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!root.current) return; const m = L.map(root.current, { zoomControl: false }).setView([25.048, 121.531], 14); map.current = m;
    L.control.zoom({ position: 'bottomright' }).addTo(m);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, keepBuffer: 0, updateWhenIdle: true, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).on('tileerror', () => setFailed(true)).addTo(m); group.current = L.layerGroup().addTo(m);
    const observer = new ResizeObserver(() => m.invalidateSize({ animate: false })); observer.observe(root.current);
    return () => { observer.disconnect(); m.remove(); map.current = null; group.current = null; };
  }, []);
  useEffect(() => {
    if (!group.current || !map.current) return; group.current.clearLayers();
    const points = selected ? [selected] : stops; const visible = points.filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lng));
    const seen = new Set<string>(); for (const stop of visible) {
      const position = `${stop.lat},${stop.lng}`; if (seen.has(position)) continue; seen.add(position);
      const span = document.createElement('span'); span.className = 'bm-map-marker'; span.textContent = '站';
      const label = document.createElement('span'); label.textContent = `${stop.name} · ${stop.routeName}`;
      L.marker([stop.lat, stop.lng], { title: stop.name, icon: L.divIcon({ html: span, className: 'bm-pin', iconSize: [34, 40], iconAnchor: [17, 36] }) }).bindTooltip(label).on('click', () => onPick(stop)).addTo(group.current).getElement()?.setAttribute('aria-label', `${stop.name}，${stop.routeName}，往${stop.destination || '所選方向'}`);
    }
    if (visible.length) { const mobile = map.current.getSize().x < 760; const panelBottom = document.querySelector('.bm-panel')?.getBoundingClientRect().bottom || 430; map.current.fitBounds(visible.map(s => [s.lat, s.lng] as L.LatLngTuple), { maxZoom: 16, paddingTopLeft: mobile ? [30, Math.min(map.current.getSize().y - 130, panelBottom + 18)] : [440, 60], paddingBottomRight: mobile ? [30, 60] : [70, 60], animate: false }); }
  }, [stops, selected, onPick]);
  return <><div className="bm-map" ref={root} aria-label="公車站牌地圖；未顯示車輛即時GPS位置" />{failed && <p className="bm-map-failure">部分底圖載入失敗，仍可使用站牌清單。</p>}</>;
}

export default function BusApp() {
  const [config, setConfig] = useState<Configuration | null>(null); const [query, setQuery] = useState(''); const [stops, setStops] = useState<Stop[]>([]); const [selected, setSelected] = useState<Stop | null>(null); const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [total, setTotal] = useState(0); const [searched, setSearched] = useState(false); const [watching, setWatching] = useState(false); const [ticks, setTicks] = useState(0); const [clock, setClock] = useState(Date.now());
  const active = useRef<AbortController | null>(null); const generation = useRef(0); const busyRef = useRef(false);
  useEffect(() => { document.title = '公車何時來 · JEV Maps'; const c = new AbortController(); busApi<Configuration>('config', undefined, c.signal).then(setConfig).catch(e => { if (!c.signal.aborted) setError(e.message); }); const update = () => setClock(Date.now()); const timer = setInterval(update, 1000); document.addEventListener('visibilitychange', update); return () => { c.abort(); active.current?.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', update); }; }, []);
  const reset = () => { generation.current++; active.current?.abort(); busyRef.current = false; setBusy(false); setWatching(false); setResult(null); setSelected(null); setError(''); };
  async function search(value: string) {
    if (!value.trim()) return; reset(); setQuery(value); setStops([]); setSearched(true); const c = new AbortController(); active.current = c; const id = ++generation.current; setBusy(true); busyRef.current = true; const timeout = setTimeout(() => c.abort(), 25000);
    try { const r = await busApi<{ stops: Stop[]; total?: number; omitted?: number; message?: string; summary?: {state: string; detail: string} }>('stops', { query: value.trim() }, c.signal); if (id !== generation.current) return; setStops(r.stops); setTotal(r.total || r.stops.length); if (!r.stops.length) setError(r.summary?.state === 'unavailable' ? r.summary.detail : r.message || '沒有符合的站牌，請試試站牌名稱，例如「臺北車站」或「故宮」。'); }
    catch (e) { if (id === generation.current) setError(c.signal.aborted ? '查詢已停止，請稍後重試。' : (e as Error).message); }
    finally { clearTimeout(timeout); if (id === generation.current) { setBusy(false); busyRef.current = false; } }
  }
  const load = useCallback(async (stop: Stop, background = false) => {
    if (busyRef.current) return; active.current?.abort(); const c = new AbortController(); active.current = c; const id = ++generation.current; setSelected(stop); setBusy(true); busyRef.current = true; setError(''); if (!background) { setResult(null); setTicks(0); setWatching(false); } const timeout = setTimeout(() => c.abort(), 20000);
    try { const r = await busApi<Result>('arrivals', { stopId: stop.id, routeId: stop.routeId, direction: stop.direction }, c.signal); if (id !== generation.current) return; setResult(r); setClock(Date.now()); if (r.summary.state === 'unavailable') setWatching(false); else if (!background) setWatching(true); }
    catch (e) { if (id === generation.current) { setResult(null); setError(c.signal.aborted ? '更新逾時，尚未取得新資料。' : (e as Error).message); setWatching(false); } }
    finally { clearTimeout(timeout); if (id === generation.current) { setBusy(false); busyRef.current = false; } }
  }, []);
  const pick = useCallback((s: Stop) => { void load(s); }, [load]);
  useEffect(() => { if (!watching || !selected) return; const timer = setInterval(() => { if (document.visibilityState !== 'visible' || busyRef.current) return; if (ticks >= 9) setWatching(false); setTicks(t => t + 1); void load(selected, true); }, 30000); return () => clearInterval(timer); }, [watching, ticks, selected, load]);
  const updatedAt = result?.provenance.sourceUpdatedAt || result?.arrivals[0]?.sourceUpdatedAt;
  const age = updatedAt ? (clock - Date.parse(updatedAt)) / 1000 : NaN;
  const fresh = result?.freshness.state === 'fresh' && Number.isFinite(age) && age >= 0 && age <= (result?.freshness.maxAgeSeconds || 120);
  const arrival = result?.arrivals[0]; const usable = fresh && typeof arrival?.etaSeconds === 'number' && arrival.etaSeconds >= 0;
  const gateTruth = (gate: Result['gates'][number]) => { if (gate.id === 'sourceRecent') return Number.isFinite(age) ? age <= 120 ? 'TRUE' : 'FALSE' : 'UNKNOWN'; if (gate.id === 'sourceNotFuture') return Number.isFinite(age) ? age >= 0 ? 'TRUE' : 'FALSE' : 'UNKNOWN'; if (gate.id === 'showEstimate' && !fresh) return Number.isFinite(age) ? 'FALSE' : 'UNKNOWN'; return gate.truth; };
  return <main className="bm-app"><a href="#bm-search" className="bm-skip">跳至站牌搜尋</a><BusMap stops={stops} selected={selected} onPick={pick} />
    <aside className="bm-panel"><header className="bm-header"><a href="/delivery" aria-label="返回汽車路線"><ArrowLeft size={19} /></a><span className="bm-brand"><GitBranch size={18} /><strong>JEV Maps</strong></span><span className="bm-city">台北公車</span></header>
      <section className="bm-search-section"><h1>公車何時來</h1><p>選站牌、看方向，等車不用猜。</p><form id="bm-search" onSubmit={e => { e.preventDefault(); void search(query); }}><label className="bm-input"><MapPin size={18} /><input value={query} maxLength={80} placeholder="站牌、站址，例如臺北車站" aria-label="站牌或站址" onChange={e => { reset(); setQuery(e.target.value); setStops([]); setSearched(false); }} /><button aria-label="搜尋公車站牌" disabled={busy || !query.trim()}>{busy ? <RefreshCw size={19} className="bm-spin" /> : <Search size={19} />}</button></label></form>
        {error && <p className="bm-error" role="alert"><Info size={17} />{error}</p>}
        {busy && !selected && <p className="bm-status" role="status">正在取得官方站牌資料…</p>}
      </section>
      {!searched && <section className="bm-examples"><span className="bm-overline">從這些地方試試</span>{(config?.examples || []).map((example, i) => <button key={example.id} disabled={busy} onClick={() => void search(example.query)}><span className="bm-example-icon">{String(i + 1).padStart(2, '0')}</span><span><strong>{example.title}</strong><small>{example.description}</small></span><ChevronRight size={17} /></button>)}<div className="bm-how"><BusFront size={23} /><strong>用官方預估，先檢查時效。</strong><p>昨天的資料不會拿來報到站時間。來源超過2分鐘未更新，就顯示待更新。</p></div></section>}
      {searched && !selected && stops.length > 0 && <section className="bm-stops"><div className="bm-list-title"><strong>選擇路線與方向</strong><span>{total > stops.length ? `顯示 ${stops.length} / ${total}` : `${stops.length} 個候選`}</span></div><ul>{stops.map(s => <li key={key(s)}><button disabled={busy} onClick={() => pick(s)}><span className="bm-route-number">{s.routeName}</span><span><strong>{s.name}</strong><small>往 {s.destination || (s.direction === '0' ? '去程方向' : '返程方向')}</small></span><ChevronRight size={17} /></button></li>)}</ul><p className="bm-source-note">同名站牌可能分布在不同路口，請對照地圖與現場方向。{total > stops.length && ' 候選較多，可搜尋「臺北車站 299」等站名加路線縮小範圍。'}</p></section>}
      {selected && <section className="bm-result" aria-label="公車到站結果"><button className="bm-back" onClick={() => { reset(); }}><ArrowLeft size={14} />其他路線與方向</button><div className="bm-selected"><span className="bm-route-number">{selected.routeName}</span><div><h2>{selected.name}</h2><p>往 {selected.destination || (selected.direction === '0' ? '去程方向' : '返程方向')}</p></div></div>
        <div className={`bm-eta ${usable ? 'ready' : ''}`} role="status">{busy && !result ? <><RefreshCw className="bm-spin" size={28} /><strong>查看到站資料中</strong></> : usable ? <><span className="bm-overline">官方到站預估</span><div><strong>{arrival.etaSeconds! < 60 ? '即將' : Math.ceil(arrival.etaSeconds! / 60)}</strong><span>{arrival.etaSeconds! < 60 ? '到站' : '分鐘'}</span></div><p>來源更新時的預估，非精確抵達保證</p></> : <><Clock3 size={28} /><strong>{result && !fresh ? '資料待更新' : arrival?.label || '暫無到站預估'}</strong><p>{result && !fresh ? '資訊超時或缺少時間，已隱藏舊的到站數字。' : '沒有有效到站預估，不代表沒有公車服務。'}</p></>}</div>
        {result && <><div className={`bm-freshness ${fresh ? '' : 'warning'}`}><span className="bm-dot" /><strong>{fresh ? `快照 ${Math.floor(age)} 秒前發布` : '來源尚未符合時效要求'}</strong><span>上限 120 秒</span></div><p className="bm-source-time">快照 {time(updatedAt)}<br />取得 {time(result.provenance.fetchedAt)}</p><details className="bm-gates"><summary><GitBranch size={16} />如何決定顯示到站時間<ChevronRight size={15} /></summary><p>資料新鮮、站牌方向一致、預估有效，三個條件都通過才顯示數字。</p><ul>{result.gates.map((gate, i) => <li key={`${gate.label}-${i}`}><span>{gate.label}</span><b className={gateTruth(gate) === 'TRUE' ? 'yes' : ''}>{gateTruth(gate)}</b><small>{gate.detail}</small></li>)}</ul><p>使用 JEV 邏輯電路的明確規則；這裡不呼叫語言模型，也不自行編造到站時間。</p></details></>}
        <div className="bm-refresh"><button className="bm-refresh-main" disabled={busy} onClick={() => void load(selected, true)}><RefreshCw className={busy ? 'bm-spin' : ''} size={16} />{busy ? '正在更新' : '更新到站資訊'}</button><button disabled={busy} aria-label={watching ? '暫停公車自動更新' : '開始公車自動更新'} onClick={() => { setTicks(0); setWatching(v => !v); }}>{watching ? <Pause size={17} /> : <Play size={17} />}</button></div><p className="bm-auto-note">{watching ? '每30秒更新，最多10次；隱藏分頁暫停。' : '自動更新已暫停；過期數字仍會自動隱藏。'}</p>
      </section>}
      <footer className="bm-footer"><details><summary><Info size={14} />資料與應用範例</summary><p>這張地圖顯示站牌位置，沒有車輛即時GPS；更新時間是官方整份快照的發布時間，並非個別車輛的觀測時間。到站預估來自台北市官方資料，尚未額外整合即時路段車速。</p><ul><li><strong>候車：</strong>先查是否有新鮮、方向正確的到站預估。</li><li><strong>轉乘：</strong>可再加入步行時間與緩衝，提示是否值得等下一班。</li><li><strong>事故提醒：</strong>可用語意閘核對公告是否影響這條公車；無可靠證據就維持待確認。</li></ul><p>目前完成候車查詢。轉乘與事故影響為後續應用構想；邏輯閘不會讓預估自動變成精確時間。</p><a href="https://data.taipei/dataset/detail?id=f11a5af0-7b37-48ef-98cc-f6f102ed43c6" target="_blank" rel="noreferrer">臺北市預估到站資料<ArrowUpRight size={12} /></a></details></footer>
    </aside><div className="bm-map-label"><BusFront size={16} />站牌位置・非車輛追蹤</div>
  </main>;
}
