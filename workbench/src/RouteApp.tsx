import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { ArrowDownUp, ArrowUpRight, BusFront, CarFront, Check, ChevronDown, ChevronRight, GitBranch, Info, LocateFixed, MapPin, Navigation, Pause, Play, Radio, RefreshCw, Search, TriangleAlert, X } from 'lucide-react';
import './route.css';
import TrafficPanel from './TrafficPanel';

type Place = { id?: string; name: string; lat: number; lng: number; address?: string };
type Road = { id: string; coordinates: [number, number][]; distanceMeters: number; durationSeconds: number; selected: boolean; reason?: string; affectedEventIds?: string[] };
type RoadEvent = { id: string; title: string; text: string; lat: number | null; lng: number | null; sourceUrl?: string; updatedAt?: string; status?: string; truth?: string; reason?: string; locationQuality?: string };
type Plan = { origin: Place; destination: Place; routes: Road[]; events: RoadEvent[]; summary: { title: string; detail: string; state: string }; provenance: Record<string, unknown>; metrics: Record<string, unknown>; createdAt?: string; mode?: string };
type Config = { presets: Place[]; defaults: { origin: Place; destination: Place }; sources?: Record<string, unknown> };
const stamp = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
const mins = (n: number) => Math.max(1, Math.round(n / 60));
const km = (n: number) => (n / 1000).toFixed(1);
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown) => typeof v === 'string' ? v : '—';
const safeLink = (url?: string) => { try { return url && new URL(url).protocol === 'https:' ? url : undefined; } catch { return undefined; } };
async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`/api/routes/${path}`, { ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), signal });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '暫時無法完成，請稍後再試。');
  return data;
}

function PlaceInput({ label, value, place, presets, disabled, onEdit, onPick }: { label: string; value: string; place: Place | null; presets: Place[]; disabled: boolean; onEdit: (v: string) => void; onPick: (p: Place) => void }) {
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Place[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { const close = (e: PointerEvent) => { if (!host.current?.contains(e.target as Node)) setOpen(false); }; document.addEventListener('pointerdown', close); return () => document.removeEventListener('pointerdown', close); }, []);
  const pick = (p: Place) => { generation.current++; controller.current?.abort(); setLoading(false); onPick(p); setOpen(false); setResults(null); setMessage(''); };
  async function search() {
    if (!value.trim() || disabled) return;
    controller.current?.abort(); const c = new AbortController(); controller.current = c; const id = ++generation.current;
    setLoading(true); setOpen(true); setMessage('');
    try { const r = await api<{ places: Place[]; message?: string }>('search', { query: value.trim() }, c.signal); if (generation.current !== id) return; setResults(r.places); setMessage(r.message || (r.places.length ? '選擇正確的地點' : '沒有找到地點，請補上區域或試試公開地標。')); }
    catch (e) { if (!c.signal.aborted) { setResults([]); setMessage((e as Error).message); } }
    finally { if (generation.current === id) setLoading(false); }
  }
  const options = results ?? presets.filter(p => !value || place || p.name.replaceAll('臺', '台').includes(value.replaceAll('臺', '台'))).slice(0, 6);
  return <div className="rm-place" ref={host}>
    <div className="rm-input-row"><span className={`rm-point ${label === '出發地' ? 'origin' : 'destination'}`} aria-hidden="true" />
      <input aria-label={label} placeholder={label === '出發地' ? '輸入出發地' : '想去哪裡？'} value={value} autoComplete="off" maxLength={120} disabled={disabled} onFocus={() => { setOpen(true); setResults(null); }} onChange={e => { generation.current++; controller.current?.abort(); setLoading(false); onEdit(e.target.value); setResults(null); setMessage(''); setOpen(true); }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void search(); } if (e.key === 'Escape') setOpen(false); }} />
      <button type="button" className="rm-icon-button" aria-label={`搜尋${label}`} title={`搜尋${label}`} disabled={disabled || loading || !value.trim()} onClick={() => void search()}>{loading ? <RefreshCw className="rm-spin" size={17} /> : place ? <Check size={17} /> : <Search size={17} />}</button>
    </div>
    {open && !disabled && <div className="rm-place-results"><p>{loading ? '正在尋找地點…' : message || (place ? '換一個地點' : '公開地標 · 台北與周邊')}</p><ul aria-label={`${label}搜尋結果`}>{!loading && options.map((p, i) => <li key={`${p.id || p.name}-${i}`}><button type="button" onClick={() => pick(p)}><MapPin size={17} /><span><strong>{p.name}</strong>{p.address && <small>{p.address}</small>}</span></button></li>)}</ul>{!loading && !place && <button type="button" className="rm-search-more" disabled={!value.trim()} onClick={() => void search()}><Search size={15} />搜尋「{value || '地點'}」</button>}</div>}
  </div>;
}

function RouteMap({ origin, destination, plan, selectedId, showEvents, stale, focusEvent, onEvent, fitCount }: { origin: Place | null; destination: Place | null; plan: Plan | null; selectedId: string | null; showEvents: boolean; stale: boolean; focusEvent: string | null; onEvent: (id: string) => void; fitCount: number }) {
  const root = useRef<HTMLDivElement>(null); const map = useRef<L.Map | null>(null); const layers = useRef<L.LayerGroup | null>(null); const fitRef = useRef<() => void>(() => {}); const [tileError, setTileError] = useState(false);
  useEffect(() => {
    if (!root.current) return;
    const m = L.map(root.current, { zoomControl: false, scrollWheelZoom: true }).setView([25.044, 121.545], 13); map.current = m;
    L.control.zoom({ position: 'bottomright' }).addTo(m);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, keepBuffer: 0, updateWhenIdle: true, updateWhenZooming: false, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors' }).on('tileerror', () => setTileError(true)).addTo(m);
    layers.current = L.layerGroup().addTo(m);
    const ro = new ResizeObserver(() => { m.invalidateSize({ animate: false }); fitRef.current(); }); ro.observe(root.current);
    return () => { ro.disconnect(); m.remove(); map.current = null; layers.current = null; };
  }, []);
  const fit = useCallback(() => {
    const m = map.current; if (!m) return;
    const road = plan?.routes.find(r => r.id === selectedId);
    const pts: L.LatLngTuple[] = road?.coordinates.map(([lng, lat]) => [lat, lng]) || [origin, destination].filter((p): p is Place => !!p).map(p => [p.lat, p.lng]);
    if (pts.length) { const mobile = m.getSize().x < 720; m.fitBounds(pts, { paddingTopLeft: mobile ? [38, 272] : [440, 70], paddingBottomRight: mobile ? [38, plan ? 234 : 90] : [75, 85], maxZoom: 14, animate: false }); }
  }, [origin, destination, plan, selectedId]);
  fitRef.current = fit;
  useEffect(() => {
    const group = layers.current; if (!group) return; group.clearLayers();
    const routes = [...(plan?.routes || [])].sort((a, b) => Number(a.id === selectedId) - Number(b.id === selectedId));
    for (const route of routes) {
      const chosen = route.id === selectedId; const coordinates = route.coordinates.map(([lng, lat]): L.LatLngTuple => [lat, lng]);
      L.polyline(coordinates, { color: chosen ? '#fff' : '#9daebc', weight: chosen ? 10 : 6, opacity: stale ? .4 : .9, interactive: false }).addTo(group);
      if (chosen) L.polyline(coordinates, { color: '#2878db', weight: 6, opacity: stale ? .35 : 1, lineCap: 'round', interactive: false }).addTo(group);
    }
    for (const [index, point] of [origin, destination].entries()) {
      if (!point) continue;
      const el = document.createElement('span'); el.className = `rm-map-pin ${index ? 'end' : 'start'}`; el.textContent = ''; el.setAttribute('aria-hidden', 'true');
      const popup = document.createElement('div'); popup.textContent = `${index ? '目的地' : '出發地'} · ${point.name}`;
      L.marker([point.lat, point.lng], { icon: L.divIcon({ html: el, className: 'rm-pin-shell', iconSize: [34, 38], iconAnchor: [17, 34] }), title: point.name, keyboard: true }).bindPopup(popup).addTo(group).getElement()?.setAttribute('aria-label', `${index ? '目的地' : '出發地'}：${point.name}`);
    }
    if (showEvents) for (const event of (plan?.events || []).slice(0, 20)) {
      if (!Number.isFinite(event.lat) || !Number.isFinite(event.lng) || event.locationQuality !== 'reported_point') continue;
      const el = document.createElement('span'); el.className = `rm-map-event ${focusEvent === event.id ? 'focused' : ''}`; el.textContent = '!';
      const popup = document.createElement('div'); popup.textContent = `${event.title} · 通報位置`;
      L.marker([event.lat!, event.lng!], { icon: L.divIcon({ html: el, className: 'rm-pin-shell', iconSize: [30, 30] }), title: `路況事件：${event.title}`, keyboard: true }).bindTooltip(popup).on('click', () => onEvent(event.id)).addTo(group);
    }
    fit();
  }, [origin, destination, plan, selectedId, showEvents, stale, focusEvent, onEvent, fit]);
  useEffect(() => { fitRef.current(); }, [fitCount]);
  return <><div className="rm-map" ref={root} aria-label="台北汽車路線地圖，起終點與路況事件另有文字清單" />{tileError && <div className="rm-tile-error">部分底圖暫時無法載入，路線摘要仍可使用。</div>}</>;
}

export default function RouteApp() {
  const [config, setConfig] = useState<Config | null>(null); const [origin, setOrigin] = useState<Place | null>(null); const [destination, setDestination] = useState<Place | null>(null);
  const [originText, setOriginText] = useState(''); const [destinationText, setDestinationText] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null); const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [stale, setStale] = useState(false); const [fitCount, setFitCount] = useState(0);
  const [watching, setWatching] = useState(false); const [ticks, setTicks] = useState(0); const [showEvents, setShowEvents] = useState(true); const [focusEvent, setFocusEvent] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | undefined>(); const dialog = useRef<HTMLDialogElement>(null); const active = useRef<AbortController | null>(null); const generation = useRef(0); const busyRef = useRef(false);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => { const update = () => setClock(Date.now()); const timer = setInterval(update, 5000); document.addEventListener('visibilitychange', update); return () => { clearInterval(timer); document.removeEventListener('visibilitychange', update); }; }, []);
  const [mode, setMode] = useState<'live' | 'demo'>('live');
  useEffect(() => { document.title = 'JEV Maps · 路線與沿途事件'; const c = new AbortController(); api<Config>('config', undefined, c.signal).then(r => { setConfig(r); setOrigin(r.defaults.origin); setDestination(r.defaults.destination); setOriginText(r.defaults.origin.name); setDestinationText(r.defaults.destination.name); }).catch(e => { if (!c.signal.aborted) setError(e.message); }); return () => { c.abort(); active.current?.abort(); }; }, []);
  const invalidate = () => { generation.current++; active.current?.abort(); busyRef.current = false; setBusy(false); setWatching(false); setStale(!!plan); setError(''); };
  const run = useCallback(async (nextMode: 'live' | 'demo' = 'live', background = false) => {
    if (!origin || !destination || busyRef.current) return;
    if (origin.lat === destination.lat && origin.lng === destination.lng) { setError('出發地與目的地相同，請選擇另一個地點。'); return; }
    active.current?.abort(); const c = new AbortController(); active.current = c; const id = ++generation.current; busyRef.current = true; setBusy(true); setError('');
    if (!background) { setTicks(0); setWatching(false); }
    const timeout = setTimeout(() => c.abort(), 100_000);
    try { const r = await api<Plan>('plan', { origin: { name: origin.name, lat: origin.lat, lng: origin.lng }, destination: { name: destination.name, lat: destination.lat, lng: destination.lng }, mode: nextMode }, c.signal); if (generation.current !== id) return; if (!r.routes.length) throw new Error(`${r.summary.title}。${r.summary.detail}`); setPlan(r); setSelectedId(r.routes.find(x => x.selected)?.id || r.routes[0]?.id || null); setStale(false); setMode(nextMode); setCheckedAt(new Date().toISOString()); setFocusEvent(null); if (!background) setWatching(nextMode === 'live'); }
    catch (e) { if (generation.current === id) { setError(c.signal.aborted ? '規劃已停止，請再試一次。' : (e as Error).message); setStale(!!plan); setWatching(false); } }
    finally { clearTimeout(timeout); if (generation.current === id) { busyRef.current = false; setBusy(false); } }
  }, [origin, destination, plan]);
  useEffect(() => {
    if (!watching || stale || mode !== 'live') return;
    const timer = setInterval(() => { if (document.visibilityState !== 'visible' || busyRef.current) return; if (ticks >= 5) { setWatching(false); return; } if (ticks === 4) setWatching(false); setTicks(t => t + 1); void run('live', true); }, 120_000);
    return () => clearInterval(timer);
  }, [watching, stale, mode, ticks, run]);
  const openEvents = useCallback((id?: string) => { setFocusEvent(id || null); if (!dialog.current?.open) dialog.current?.showModal(); }, []);
  const road = plan?.routes.find(r => r.id === selectedId);
  const source = object(plan?.provenance.events); const freshness = object(source.freshness); const excluded = object(freshness.excluded);
  const maxEventAge = Number(freshness.maxAgeSeconds) || 900;
  const visibleIds = (plan?.events || []).filter(e => { const at = Date.parse(e.updatedAt || ''); return mode === 'demo' || Number.isFinite(at) && clock >= at && clock - at <= maxEventAge * 1000; }).map(e => e.id);
  const eventSignature = JSON.stringify(visibleIds);
  const expiredCount = (plan?.events.length || 0) - visibleIds.length;
  // Rebuild map data only when a record expires; the age clock must not reset map zoom.
  const displayPlan = useMemo(() => plan ? { ...plan, events: mode === 'demo' ? plan.events : plan.events.filter(e => { const at = Date.parse(e.updatedAt || ''); return Number.isFinite(at) && clock >= at && clock - at <= maxEventAge * 1000; }) } : null, [plan, eventSignature, mode, maxEventAge]);
  const events = displayPlan?.events || [];
  const fetchedMs = Date.parse(text(source.fetchedAt));
  const checkExpired = mode === 'live' && !!plan && (!Number.isFinite(fetchedMs) || clock < fetchedMs || clock - fetchedMs > 150_000);
  const timeReview = mode === 'live' && !!plan && (expiredCount > 0 || checkExpired);

  const locatedCount = events.filter(e => e.locationQuality === 'reported_point').length;
  const manual = !!road && !road.selected;
  const severity = timeReview || manual || plan?.summary.state === 'review' || plan?.summary.state === 'unavailable';
  const model = object(plan?.provenance.semantic);
  const cancel = () => { generation.current++; active.current?.abort(); busyRef.current = false; setBusy(false); setWatching(false); setError('已停止本次規劃。'); };
  return <main className="rm-app">
    <h1 className="sr-only">JEV Maps 路線規劃</h1>
    <a href="#route-inputs" className="rm-skip">跳至起終點輸入</a>
    <RouteMap origin={stale && plan ? plan.origin : origin} destination={stale && plan ? plan.destination : destination} plan={displayPlan} selectedId={selectedId} stale={stale} showEvents={showEvents} focusEvent={focusEvent} onEvent={openEvents} fitCount={fitCount} />
    <aside className="rm-panel" aria-label="路線規劃">
      <section className="rm-search-card" id="route-inputs">
        <header className="rm-header"><a href="/" aria-label="返回 JEV Studio"><span className="rm-logo"><GitBranch size={22} /></span><strong>JEV <span>Maps</span></strong></a><a className="rm-mode-link" href="/delivery/bus"><BusFront size={15} />公車何時來</a></header>
        <div className="rm-fields">
          <div className="rm-field-line" aria-hidden="true" />
          <PlaceInput label="出發地" value={originText} place={origin} presets={config?.presets || []} disabled={busy} onEdit={v => { invalidate(); setOriginText(v); setOrigin(null); }} onPick={p => { invalidate(); setOrigin(p); setOriginText(p.name); }} />
          <PlaceInput label="目的地" value={destinationText} place={destination} presets={config?.presets || []} disabled={busy} onEdit={v => { invalidate(); setDestinationText(v); setDestination(null); }} onPick={p => { invalidate(); setDestination(p); setDestinationText(p.name); }} />
          <button className="rm-swap" type="button" aria-label="交換起終點" title="交換起終點" disabled={busy} onClick={() => { invalidate(); setOrigin(destination); setDestination(origin); setOriginText(destinationText); setDestinationText(originText); }}><ArrowDownUp size={18} /></button>
        </div>
        <button className="rm-primary" disabled={busy || !origin || !destination} onClick={() => void run()}>{busy ? <RefreshCw className="rm-spin" size={18} /> : <Navigation size={18} />}{busy ? '正在查看路線與沿途事件…' : plan ? '重新規劃路線' : '規劃路線'}{!busy && <ChevronRight size={18} />}</button>
        {busy ? <button className="rm-cancel" onClick={cancel}>取消等待</button> : <p className="rm-form-note">近期通報與官方路段速度，規劃後自動查看。</p>}
        {error && <p className="rm-error" role="alert"><TriangleAlert size={16} />{error}</p>}
      </section>

      {plan && road && <section className={`rm-trip-card ${stale ? 'stale' : ''}`} aria-label="本趟路線摘要">
        <div className="rm-trip-heading"><span><CarFront size={18} />{mode === 'demo' ? '事件演練' : '汽車路線'}</span>{stale ? <span className="rm-stale-tag">待重新規劃</span> : <span className="rm-route-tag">{plan.routes.find(r => r.selected)?.id === selectedId ? '建議路線' : '自行選擇'}</span>}</div>
        <div className="rm-trip-time"><strong>{mins(road.durationSeconds)}</strong><span>分鐘</span><i />{km(road.distanceMeters)} 公里</div>
        <p className="rm-time-note">道路行車估時・不含即時車流</p>
        {stale ? <div className="rm-assistant warning"><Info size={19} /><div><strong>起終點已更新</strong><p>地圖保留前一條路線，請重新規劃。</p></div></div> : <div className={`rm-assistant ${severity ? 'warning' : ''}`} role="status"><span className="rm-assistant-icon">{severity ? <Info size={19} /> : <GitBranch size={19} />}</span><div><strong>{timeReview ? '通報資訊待更新' : manual ? '已自行選擇路線' : plan.summary.title}</strong><p>{timeReview ? '上次通報查詢或判斷已過時，請重新規劃以查看新資料。目前路線不代表已避開即時事件。' : manual ? `${road.reason || '已切換到所選道路候選'}。自動查看已暫停，這不代表已避開所有事件。` : plan.summary.detail}</p></div></div>}
        <TrafficPanel coordinates={road.coordinates} version={plan.createdAt} mode={mode} stale={stale} /><button className="rm-events-row" onClick={() => openEvents()}><span><Radio size={17} />{locatedCount ? '近期通報' : events.length ? '通報待核實' : '沒有近期通報'} {events.length > 0 && <b>{events.length}</b>}</span><span>查看通報<ChevronRight size={16} /></span></button>
        {plan.routes.length > 1 && <details className="rm-alternatives"><summary>其他路線 <ChevronDown size={15} /></summary><div>{plan.routes.map((r, index) => <button key={r.id} className={r.id === selectedId ? 'selected' : ''} onClick={() => { setSelectedId(r.id); setWatching(false); }} disabled={stale || busy}><span>{r.id === selectedId ? <Check size={15} /> : <span className="rm-radio" />}路線 {index + 1}</span><strong>{mins(r.durationSeconds)} 分 <small>· {km(r.distanceMeters)} km</small></strong></button>)}</div></details>}
        <p className="rm-freshness-note">{mode === 'demo' ? '合成演練，非即時事件' : `通報只採近 ${Math.round(maxEventAge / 60)} 分鐘更新・不等於完整即時路況`}</p><div className="rm-watch"><span><span className={watching ? 'rm-pulse' : 'rm-idle-dot'} />{busy ? '正在更新…' : watching ? '每 2 分鐘查看新通報' : '自動查看已暫停'}<small>查詢 {stamp(checkedAt)}</small></span><button aria-label={watching ? '暫停自動查看' : '恢復自動查看'} title={watching ? '暫停自動查看' : '最多再查看五次'} disabled={busy || stale || mode === 'demo'} onClick={() => { setTicks(0); setWatching(v => !v); }}>{watching ? <Pause size={15} /> : <Play size={15} />}</button></div>
      </section>}
    </aside>
    <div className="rm-map-tools"><button aria-label="顯示完整路線" title="顯示完整路線" onClick={() => setFitCount(v => v + 1)}><LocateFixed size={21} /></button><button aria-label={showEvents ? '隱藏地圖事件標記' : '顯示地圖事件標記'} aria-pressed={showEvents} title="沿途事件標記" onClick={() => setShowEvents(v => !v)}><Radio size={20} /></button></div>
    <div className="rm-map-badge"><span className={busy ? 'rm-pulse' : 'rm-idle-dot'} />{busy ? '路線助理處理中' : mode === 'demo' ? '演練模式・合成事件' : '台北與周邊・公開道路資料'}</div>
    <footer className="rm-footer"><details><summary><Info size={14} />資料與說明</summary><div className="rm-about"><strong>JEV Maps 路線助理</strong><p>道路：OSRM / OpenStreetMap；地點搜尋：Photon；事件：警廣公開通報。無通報不代表道路暢通，概略定位不代表精確封路。</p><p>只列出來源在15分鐘內更新的通報；15分鐘是本展示的篩選門檻，不是來源即時性保證。規劃後每 2 分鐘查看，最多五次；離開分頁暫停。資料不足會保留不確定，不會自行補出事故或繞路。</p><p>JEV 只評估少量沿線文字；道路與距離由程式計算。這是路線建議，沒有定位追蹤或逐向導航。</p><a href="/delivery/bus">試試官方公車到站範例 <ArrowUpRight size={13} /></a><a href="/delivery/lab">開啟進階配送實驗 <ArrowUpRight size={13} /></a><button disabled={busy || !origin || !destination} onClick={() => { void run('demo'); }}>體驗合成事件演練</button></div></details><a href="/">返回 Studio <ArrowUpRight size={12} /></a></footer>
    <dialog className="rm-dialog" ref={dialog} aria-labelledby="rm-events-title" onClick={e => { if (e.target === dialog.current) dialog.current.close(); }}>
      <header><div><span className="rm-eyebrow">ROUTE REPORTS</span><h2 id="rm-events-title">通報與事件</h2></div><button className="rm-icon-button" aria-label="關閉沿途事件" onClick={() => dialog.current?.close()}><X size={22} /></button></header>
      <div className="rm-dialog-body"><p className="rm-event-intro">{stale && "以下保留前一次計畫的通報，請重新規劃以更新。"}{mode === 'demo' ? '以下是合成演練事件，用於展示判斷與路線變化。' : '僅列來源更新在15分鐘內、且接近候選路線的通報。超過15分鐘未更新、時間不明或更新時間在未來的內容已排除；近期更新不代表事件仍有效。定位不明的資料可能不在本趟路線上，因此不會標在地圖，也不會據此改道。'}</p>{events.length === 0 ? <div className="rm-events-empty"><Radio size={29} /><strong>{source.status === 'unavailable' ? '暫時無法取得通報' : '目前沒有可列出的沿途通報'}</strong><p>這不代表路段沒有事故或管制。<br />請依現場標誌與交通指揮通行。</p></div> : events.map(event => <article className={`rm-event ${focusEvent === event.id ? 'focused' : ''}`} key={event.id}><div className="rm-event-top"><span><TriangleAlert size={15} />{event.locationQuality !== 'reported_point' ? '定位待核實・不標在地圖' : event.truth === 'TRUE' ? '可能影響路線' : event.truth === 'FALSE' ? '未觸發調整' : '待確認通報'}</span><time dateTime={event.updatedAt}>來源更新 {event.updatedAt && Number.isFinite(Date.parse(event.updatedAt)) ? new Date(event.updatedAt).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "時間待確認"}</time></div><h3>{event.title}</h3><p>{event.text}</p>{event.reason && <div className="rm-event-reason"><GitBranch size={15} />{event.reason}</div>}{safeLink(event.sourceUrl) && <a href={safeLink(event.sourceUrl)} target="_blank" rel="noreferrer">查看原始來源<ArrowUpRight size={13} /></a>}</article>)}
        <details className="rm-evidence"><summary>資料與判斷紀錄 <ChevronDown size={14} /></summary><dl><dt>事件來源</dt><dd>{text(source.label || source.provider || source.status)}</dd><dt>本系統取得時間</dt><dd>{stamp(text(source.fetchedAt))}</dd><dt>來源最近更新</dt><dd>{text(freshness.sourceLatestUpdatedAt) === '—' ? '未提供' : new Date(text(freshness.sourceLatestUpdatedAt)).toLocaleString('zh-TW', { hour12: false })}</dd><dt>時效篩選</dt><dd>全來源排除 {Number(excluded.total || 0)} 筆過期或時間不明通報；本頁另到期 {expiredCount} 筆。</dd><dt>模型</dt><dd>{text(model.upstreamModel || model.model || model.provider)}</dd><dt>實際請求</dt><dd>{Number(plan?.metrics.modelRequests || 0)} 次模型 · {Number(plan?.metrics.mapRequests || 0)} 次道路</dd></dl><p>UNKNOWN 代表資訊不足；較少呼叫不等於更準確或更省錢。</p></details>
      </div>
    </dialog>
  </main>;
}
