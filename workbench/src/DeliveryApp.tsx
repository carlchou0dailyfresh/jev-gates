import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Clock3,
  Download,
  FlaskConical,
  GitBranch,
  Layers3,
  LoaderCircle,
  MapPin,
  Navigation,
  Plus,
  RefreshCw,
  Route,
  Settings2,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import type { Mode } from "./types";
import type {
  DeliveryComparison,
  DeliveryConfig,
  DeliveryDraft,
  DeliveryEvent,
  DeliveryPlan,
  DeliveryPoint,
  DeliveryPrices,
  DeliveryStop,
  MapProvider,
} from "./delivery-types";
import "./delivery.css";

const copy = <T,>(value: T): T => structuredClone(value);
const time = (minutes: number | null | undefined) =>
  typeof minutes === "number" && Number.isFinite(minutes)
    ? `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(Math.floor(minutes) % 60).padStart(2, "0")}${minutes >= 1440 ? ` +${Math.floor(minutes / 1440)}日` : ""}`
    : "—";
const minutes = (value: string) => {
  const [hours, mins] = value.split(":").map(Number);
  return hours * 60 + mins;
};
const fixed = (value: number | null | undefined, digits = 0) =>
  typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("zh-TW", { maximumFractionDigits: digits })
    : "—";
const timing = (value: number | null | undefined) =>
  typeof value !== "number"
    ? "—"
    : value >= 1000
      ? `${(value / 1000).toFixed(2)} s`
      : `${value.toFixed(1)} ms`;
const dataObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const eventNames: Record<string, string> = {
  thanks: "客戶致謝",
  "thanks-copy": "重複致謝",
  "entrance-change": "入口臨時關閉",
  "earlier-deadline": "交期提前",
  "unrelated-region": "無關地區消息",
  "confirmed-window": "確認時間窗變更",
};
const gateNames: Record<string, string> = {
  relevant: "本趟範圍",
  material: "實質變動",
  refresh: "需要重查",
  decision: "組合結果",
};
const providers: Record<MapProvider, string> = {
  fixture: "固定路網",
  osrm: "OSRM 路網",
  google: "Google 路況估時",
};
const modes: Record<Mode, string> = {
  fixture: "固定測試",
  localjev: "LocalJev",
  typesafe: "TypeSafe JEV",
};
const priceLabels: Record<keyof DeliveryPrices, string> = {
  mapRequestUsd: "每次地圖請求",
  mapElementUsd: "每個矩陣元素",
  semanticQuestionUsd: "每道語意問題",
  cpuSecondUsd: "每秒求解時間（假設 USD）",
};
const emptyPrices: DeliveryPrices = {
  mapRequestUsd: null,
  mapElementUsd: null,
  semanticQuestionUsd: null,
  cpuSecondUsd: null,
};

async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
    signal,
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(
      typeof value.error === "string"
        ? value.error +
            (value.metrics && Number.isFinite(value.metrics.requests)
              ? `（本次失敗仍送出 ${value.metrics.requests} 次路由服務請求。）`
              : "")
        : "暫時無法完成，請稍後再試。",
    );
  return value as T;
}

function DeliveryMap({
  draft,
  result,
  stale,
  provider,
}: {
  draft: DeliveryDraft;
  result: DeliveryPlan | null;
  stale: boolean;
  provider: MapProvider;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const overlay = useRef<L.LayerGroup | null>(null);
  const [tileError, setTileError] = useState(false);
  const fit = useCallback(() => {
    const current = map.current;
    if (!current) return;
    const points = [draft.depot, ...draft.stops].filter(
      (point) => Number.isFinite(point.lat) && Number.isFinite(point.lng),
    );
    if (points.length)
      current.fitBounds(
        L.latLngBounds(points.map((point) => [point.lat, point.lng])),
        { padding: [48, 48], maxZoom: 14, animate: false },
      );
  }, [draft]);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  useEffect(() => {
    if (provider === "google" || !container.current) return;
    const current = L.map(container.current, {
      zoomControl: false,
      scrollWheelZoom: false,
      attributionControl: true,
    }).setView([25.04, 121.54], 12);
    map.current = current;
    L.control.zoom({ position: "bottomright" }).addTo(current);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      keepBuffer: 0,
      updateWhenIdle: true,
      updateWhenZooming: false,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
    })
      .on("tileerror", () => setTileError(true))
      .addTo(current);
    overlay.current = L.layerGroup().addTo(current);
    const observer = new ResizeObserver(() => {
      current.invalidateSize({ animate: false });
      fitRef.current();
    });
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      current.remove();
      map.current = null;
      overlay.current = null;
    };
  }, [provider === "google"]);
  useEffect(() => {
    const group = overlay.current;
    if (!group) return;
    group.clearLayers();
    const ordered =
      result?.plan.order?.filter((id) => id !== draft.depot.id) ??
      draft.stops.map((stop) => stop.id);
    for (const point of [draft.depot, ...draft.stops]) {
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) continue;
      const isDepot = point.id === draft.depot.id;
      const label = document.createElement("span");
      label.className = isDepot ? "delivery-marker depot" : "delivery-marker";
      label.textContent = isDepot
        ? "起"
        : String(Math.max(0, ordered.indexOf(point.id)) + 1);
      const popup = document.createElement("div");
      popup.className = "delivery-map-popup";
      popup.textContent = `${isDepot ? "起點" : `第 ${ordered.indexOf(point.id) + 1} 站`} · ${point.name}`;
      L.marker([point.lat, point.lng], {
        icon: L.divIcon({
          html: label,
          className: "delivery-marker-shell",
          iconSize: [34, 34],
          iconAnchor: [17, 17],
        }),
        title: point.name,
        keyboard: true,
      })
        .bindPopup(popup)
        .addTo(group);
    }
    const geometry = result?.geometry.coordinates;
    if (geometry?.length)
      L.polyline(
        geometry.map(([lng, lat]) => [lat, lng]),
        {
          color: stale ? "#977946" : "#2d6b57",
          weight: 4,
          opacity: stale ? 0.5 : 0.9,
          ...(provider === "fixture" ? { dashArray: "8 8" } : {}),
        },
      ).addTo(group);
    fit();
  }, [draft, result, stale, provider, fit]);
  if (provider === "google")
    return (
      <div className="delivery-google-view">
        <Navigation size={36} strokeWidth={1.2} />
        <span className="delivery-eyebrow">GOOGLE MAPS</span>
        <h3>
          Google 路況估時
          <br />
          路線列表
        </h3>
        <p>
          {dataObject(result?.matrix.provenance).provider === "google"
            ? "已取得當下 Google 路況估時，請在右側查看站點順序。"
            : "尚未取得 Google 估時；右側保留上次來源結果，按更新後才能使用新來源。"}{" "}
          此模式不疊加 OpenStreetMap。
        </p>
        <span className="delivery-google-credit">Google Maps</span>
      </div>
    );
  return (
    <div className="delivery-map-wrap">
      <div
        ref={container}
        className="delivery-map"
        aria-label="配送路線地圖。站點與到站時間也列於旁邊的可讀清單。"
      />
      <div className="delivery-map-caption">
        <span
          className={`delivery-map-dot ${provider === "fixture" ? "dashed" : ""}`}
        />
        {stale
          ? "上次完成的快照・待更新"
          : provider === "fixture"
            ? "合成估距・連線示意"
            : dataObject(result?.matrix.provenance).cached
              ? "快取路網・不含即時車流"
              : "道路估時・不含即時車流"}
      </div>
      <button
        className="delivery-map-fit"
        onClick={fit}
        aria-label="顯示所有配送站點"
      >
        <Navigation size={16} />
      </button>
      {tileError && (
        <p className="delivery-tile-error" role="status">
          底圖暫時無法載入，仍可使用右側路線清單。
        </p>
      )}
    </div>
  );
}

function PointFields({
  point,
  onChange,
  prefix,
}: {
  point: DeliveryPoint;
  onChange: (point: DeliveryPoint) => void;
  prefix: string;
}) {
  return (
    <div className="delivery-point-fields">
      <label>
        公開地標名稱
        <input
          value={point.name}
          maxLength={100}
          onChange={(event) => onChange({ ...point, name: event.target.value })}
          aria-label={`${prefix}名稱`}
        />
      </label>
      <label>
        緯度
        <input
          type="number"
          min={-90}
          max={90}
          step="0.00001"
          value={Number.isFinite(point.lat) ? point.lat : ""}
          onChange={(event) =>
            onChange({ ...point, lat: event.target.valueAsNumber })
          }
          aria-label={`${prefix}緯度`}
        />
      </label>
      <label>
        經度
        <input
          type="number"
          min={-180}
          max={180}
          step="0.00001"
          value={Number.isFinite(point.lng) ? point.lng : ""}
          onChange={(event) =>
            onChange({ ...point, lng: event.target.valueAsNumber })
          }
          aria-label={`${prefix}經度`}
        />
      </label>
    </div>
  );
}

export default function DeliveryApp() {
  const [config, setConfig] = useState<DeliveryConfig | null>(null);
  const [draft, setDraft] = useState<DeliveryDraft | null>(null);
  const [provider, setProvider] = useState<MapProvider>("fixture");
  const [plan, setPlan] = useState<DeliveryPlan | null>(null);
  const [planKey, setPlanKey] = useState("");
  const [planProvider, setPlanProvider] = useState<MapProvider>("fixture");
  const [events, setEvents] = useState<DeliveryEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState(0);
  const [mode, setMode] = useState<Mode>("fixture");
  const [thresholds, setThresholds] = useState({ falseAt: 0.2, trueAt: 0.8 });
  const [prices, setPrices] = useState<DeliveryPrices>(emptyPrices);
  const [comparison, setComparison] = useState<DeliveryComparison | null>(null);
  const [comparisonKey, setComparisonKey] = useState("");
  const [busy, setBusy] = useState<"plan" | "compare" | "verify" | null>(null);
  const [verification, setVerification] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [autoCount, setAutoCount] = useState(0);
  const autoCountRef = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const currentKey = JSON.stringify({ draft, provider });
  const stale = Boolean(plan && currentKey !== planKey);
  const compareInputKey = JSON.stringify({
    planId: plan?.id,
    events,
    mode,
    thresholds,
    prices,
  });
  const comparisonStale = Boolean(
    comparison && (stale || compareInputKey !== comparisonKey),
  );

  useEffect(() => {
    let alive = true;
    document.title = "台北配送路線實驗 · JEV Studio";
    const controller = new AbortController();
    pending.current = controller;
    busyRef.current = true;
    setBusy("plan");
    const timer = window.setTimeout(() => controller.abort(), 45000);
    void (async () => {
      try {
        const loaded = await api<DeliveryConfig>(
          "/api/delivery/config",
          undefined,
          controller.signal,
        );
        setConfig(loaded);
        setDraft(copy(loaded.scenario.draft));
        setEvents(copy(loaded.scenario.events));
        const initial = await api<DeliveryPlan>(
          "/api/delivery/plan",
          { draft: loaded.scenario.draft, provider: "fixture" },
          controller.signal,
        );
        setPlan(initial);
        setPlanKey(
          JSON.stringify({ draft: loaded.scenario.draft, provider: "fixture" }),
        );
        setNotice("固定路網已就緒。你可以修改站點，或選擇實際擷取路網。");
      } catch (problem) {
        if (alive)
          setError(
            controller.signal.aborted
              ? "載入已取消或逾時，請重新載入。"
              : problem instanceof Error
                ? problem.message
                : "無法讀取配送情境。",
          );
      } finally {
        clearTimeout(timer);
        if (alive) {
          setBusy(null);
          busyRef.current = false;
        }
      }
    })();
    return () => {
      alive = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  const updateDraft = (next: DeliveryDraft) => {
    setDraft(next);
    setEvents((items) =>
      items.map((item) =>
        item.patch && !next.stops.some((stop) => stop.id === item.patch!.stopId)
          ? {
              id: item.id,
              kind: "note",
              text:
                item.text +
                "（對應站點已移除，本事件僅保留文字，不套用欄位更新。）",
            }
          : item,
      ),
    );
    setAutoRefresh(false);
    setError("");
    if (autoRefresh) setNotice("站點已變更，自動刷新已暫停。");
  };
  const runPlan = useCallback(
    async (automatic = false) => {
      if (!draft || busyRef.current) return;
      if (
        [draft.depot, ...draft.stops].some(
          (point) =>
            !point.name.trim() ||
            !Number.isFinite(point.lat) ||
            !Number.isFinite(point.lng) ||
            Math.abs(point.lat) > 90 ||
            Math.abs(point.lng) > 180,
        )
      ) {
        setError("請填寫站點名稱與有效經緯度。");
        return;
      }
      const submitted = copy(draft),
        chosen = provider,
        key = JSON.stringify({ draft: submitted, provider: chosen });
      const controller = new AbortController();
      pending.current = controller;
      busyRef.current = true;
      setBusy("plan");
      setError("");
      const timer = window.setTimeout(() => controller.abort(), 60000);
      try {
        const result = await api<DeliveryPlan>(
          "/api/delivery/plan",
          { draft: submitted, provider: chosen },
          controller.signal,
        );
        setPlan(result);
        setPlanKey(key);
        setPlanProvider(chosen);
        setNotice(
          `${automatic ? "自動刷新完成。" : "路線已重新規劃。"}${chosen === "fixture" ? "使用固定教學矩陣。" : chosen === "osrm" ? (dataObject(result.matrix.provenance).cached ? "沿用60秒內的路網快照，不含即時車流。" : "已抓取道路資料，不含即時車流。") : "使用當下 Google 路況估時。"}`,
        );
      } catch (problem) {
        setPlanKey("");
        setError(
          controller.signal.aborted
            ? "已停止等待；已送出的服務請求可能仍在完成。"
            : problem instanceof Error
              ? problem.message
              : "路線規劃失敗。",
        );
        if (automatic) setAutoRefresh(false);
      } finally {
        clearTimeout(timer);
        setBusy(null);
        busyRef.current = false;
        pending.current = null;
      }
    },
    [draft, provider],
  );
  const latestRunPlan = useRef(runPlan);
  latestRunPlan.current = runPlan;
  useEffect(() => {
    if (!autoRefresh || provider === "fixture") return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || busyRef.current) return;
      if (autoCountRef.current >= 5) {
        setAutoRefresh(false);
        return;
      }
      autoCountRef.current += 1;
      setAutoCount(autoCountRef.current);
      void latestRunPlan.current(true);
      if (autoCountRef.current >= 5) {
        setAutoRefresh(false);
        setNotice("已達 5 次自動刷新上限；本輪完成後自動停止。");
      }
    }, 60000);
    return () => clearInterval(timer);
  }, [autoRefresh, provider]);

  const runComparison = async () => {
    if (
      !plan ||
      plan.comparisonAllowed === false ||
      provider === "google" ||
      stale ||
      busyRef.current
    )
      return;
    if (!(
      Number.isFinite(thresholds.falseAt) &&
      Number.isFinite(thresholds.trueAt) &&
      thresholds.falseAt >= 0 &&
      thresholds.falseAt < thresholds.trueAt &&
      thresholds.trueAt <= 1
    )) {
      setError("語意門檻須符合 0 ≤ FALSE < TRUE ≤ 1。");
      return;
    }
    if (
      Object.values(prices).some(
        (value) => value !== null && (!Number.isFinite(value) || value < 0),
      )
    ) {
      setError("單價請填零或正數；留空表示不估算。");
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    busyRef.current = true;
    setBusy("compare");
    setComparison(null);
    setVerification("");
    setError("");
    const key = compareInputKey;
    const timer = window.setTimeout(() => controller.abort(), 240000);
    try {
      const result = await api<DeliveryComparison>(
        "/api/delivery/compare",
        { planId: plan.id, events, mode, thresholds, prices },
        controller.signal,
      );
      setComparison(result);
      setComparisonKey(key);
      setNotice("四種策略比較完成，使用同一張路網快照。");
    } catch (problem) {
      setError(
        controller.signal.aborted
          ? "已取消等待。已送出的模型請求可能仍在完成，這次不顯示未完成的比較。"
          : problem instanceof Error
            ? problem.message
            : "策略比較失敗。",
      );
    } finally {
      clearTimeout(timer);
      setBusy(null);
      busyRef.current = false;
      pending.current = null;
    }
  };
  const verifyReport = async () => {
    if (!comparison || busyRef.current) return;
    busyRef.current = true;
    setBusy("verify");
    setVerification("");
    try {
      const result = await api<{ valid: boolean }>("/api/delivery/verify", {
        report: comparison,
      });
      setVerification(
        result.valid
          ? "離線驗證通過：分流、路線與成本公式一致。"
          : "報告驗證未通過。",
      );
    } catch (problem) {
      setVerification(
        problem instanceof Error ? problem.message : "離線驗證失敗。",
      );
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };
  const download = () => {
    if (
      !comparison ||
      !plan ||
      plan.comparisonAllowed === false ||
      provider === "google"
    )
      return;
    const blob = new Blob([JSON.stringify(comparison, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `delivery-experiment-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const displayedDraft = plan?.draft ?? draft;
  const stopOrder = useMemo(() => {
    if (!displayedDraft) return [];
    const stops = new Map(displayedDraft.stops.map((stop) => [stop.id, stop]));
    const order =
      plan?.plan.order?.filter((id) => stops.has(id)) ??
      displayedDraft.stops.map((stop) => stop.id);
    return order.map((id) => stops.get(id)!);
  }, [displayedDraft, plan]);
  const selected = events[selectedEvent];
  const eventEdited =
    selected &&
    config?.scenario.events.find((event) => event.id === selected.id)?.text !==
      selected.text;
  const customDraft = Boolean(
    config && JSON.stringify(draft) !== JSON.stringify(config.scenario.draft),
  );
  const totalDemand =
    draft?.stops.reduce((sum, stop) => sum + stop.demand, 0) ?? 0;

  return (
    <div className="delivery-app">
      <a className="delivery-skip" href="#delivery-main">
        跳至配送實驗
      </a>
      <header className="delivery-topbar">
        <a href="/" className="delivery-brand">
          <span className="delivery-brand-symbol">
            <GitBranch size={21} />
          </span>
          <strong>JEV</strong>
          <span>Semantic Studio</span>
        </a>
        <div className="delivery-topbar-right">
          <span className="delivery-lab-label">
            <FlaskConical size={14} />
            配送路線實驗
          </span>
          <a href="/">
            <ArrowLeft size={15} />
            回到 Studio
          </a>
        </div>
      </header>
      <main id="delivery-main" className="delivery-main">
        <section className="delivery-hero">
          <div>
            <p className="delivery-eyebrow">DECISION LAB / 02</p>
            <h1>
              每次變動，
              <br className="delivery-mobile-break" />
              都值得重排嗎？
            </h1>
            <p className="delivery-hero-copy">
              同一條配送路線，四種回應方式。
              <br />
              讓規則與語意一起面對變動，看清楚每次重算的理由與代價。
            </p>
          </div>
          <div className="delivery-hero-note">
            <Route size={28} strokeWidth={1.2} />
            <span>
              先規劃路線
              <br />
              再比較「何時重排」
            </span>
            <span className="delivery-note-index">01 → 02</span>
          </div>
        </section>
        <div className="delivery-announcements">
          <p role="status" className="delivery-notice">
            {notice}
          </p>
          {error && (
            <div className="delivery-error" role="alert">
              <TriangleAlert size={18} />
              <span>{error}</span>
              <button aria-label="關閉錯誤訊息" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
        </div>
        {!draft && (
          <div className="delivery-loading">
            <LoaderCircle className="delivery-spin" size={26} />
            <p>{error ? "配送情境尚未載入。" : "準備配送情境與固定路網…"}</p>
            {error && (
              <button
                className="delivery-button"
                onClick={() => window.location.reload()}
              >
                重新載入
              </button>
            )}
          </div>
        )}
        {draft && (
          <>
            <section
              className="delivery-planning"
              aria-labelledby="delivery-plan-heading"
            >
              <div className="delivery-section-heading">
                <div>
                  <span className="delivery-section-number">01</span>
                  <h2 id="delivery-plan-heading">把路線放上地圖</h2>
                </div>
                <span className="delivery-small-badge">
                  公開地標・合成配送情境
                </span>
              </div>
              <div className="delivery-plan-toolbar">
                <div
                  className="delivery-provider-buttons"
                  aria-label="路網來源"
                >
                  {(Object.keys(providers) as MapProvider[]).map((value) => (
                    <button
                      key={value}
                      aria-pressed={provider === value}
                      className={provider === value ? "active" : ""}
                      disabled={
                        Boolean(busy) ||
                        (value === "google" &&
                          !config?.maps.googleConfigured) ||
                        (value === "osrm" && !config?.maps.osrm)
                      }
                      onClick={() => {
                        setProvider(value);
                        setAutoRefresh(false);
                      }}
                    >
                      {providers[value]}
                    </button>
                  ))}
                </div>
                <button
                  className="delivery-button primary"
                  onClick={() => void runPlan()}
                  disabled={Boolean(busy)}
                >
                  {busy === "plan" ? (
                    <LoaderCircle className="delivery-spin" size={17} />
                  ) : (
                    <RefreshCw size={16} />
                  )}
                  {provider === "fixture"
                    ? "使用固定路網規劃"
                    : "更新路網並規劃"}
                </button>
              </div>
              <p className="delivery-source-note">
                {provider === "fixture"
                  ? "不呼叫路由服務。地圖虛線僅示意順序；距離與時間來自固定測試矩陣。"
                  : provider === "osrm"
                    ? "按下更新才會連線 OSRM。擷取的是路網行車估時，不是即時車流。"
                    : "按下更新才會使用 Google 當下路況估時，與下方的案例出發時鐘分開。"}
                {!config?.maps.googleConfigured && (
                  <span> Google 尚未設定。</span>
                )}
              </p>
              {stale && (
                <div className="delivery-stale">
                  <TriangleAlert size={16} />
                  目前設定尚未取得新計畫。以下仍是上次完成的路線，請更新後再比較。
                </div>
              )}
              <div className="delivery-map-layout">
                <div className="delivery-map-card">
                  {displayedDraft && (
                    <DeliveryMap
                      draft={displayedDraft}
                      result={plan}
                      stale={stale}
                      provider={provider === "google" ? "google" : planProvider}
                    />
                  )}
                  <div className="delivery-map-stats">
                    <div>
                      <span>總里程</span>
                      <strong>
                        {fixed(
                          plan?.plan.distanceMeters == null
                            ? null
                            : plan.plan.distanceMeters / 1000,
                          1,
                        )}
                        <small>km</small>
                      </strong>
                    </div>
                    <div>
                      <span>行車估時</span>
                      <strong>
                        {fixed(plan?.plan.driveMinutes, 1)}
                        <small>分</small>
                      </strong>
                    </div>
                    <div>
                      <span>全程含停靠</span>
                      <strong>
                        {fixed(plan?.plan.totalMinutes, 1)}
                        <small>分</small>
                      </strong>
                    </div>
                    <div>
                      <span>約束檢查</span>
                      <strong
                        className={plan?.plan.feasible ? "positive" : "caution"}
                      >
                        {plan ? (plan.plan.feasible ? "可行" : "待調整") : "—"}
                      </strong>
                    </div>
                  </div>
                </div>
                <aside
                  className="delivery-itinerary"
                  aria-label="路線順序與到站時間"
                >
                  <div className="delivery-itinerary-heading">
                    <h3>這一趟的順序</h3>
                    <span>{draft.stops.length} 個站點</span>
                  </div>
                  <p className="delivery-itinerary-intro">
                    {time(displayedDraft?.departureMinutes)} 出發 ·{" "}
                    {displayedDraft?.returnToDepot
                      ? "完成後返回起點"
                      : "終點結束"}
                  </p>
                  <ol>
                    <li className="delivery-depot-stop">
                      <span className="delivery-stop-number">起</span>
                      <div>
                        <strong>{displayedDraft?.depot.name}</strong>
                        <span>出發地點</span>
                      </div>
                      <time>{time(displayedDraft?.departureMinutes)}</time>
                    </li>
                    {stopOrder.map((stop, index) => {
                      const leg = plan?.plan.legs.find(
                        (item) => item.to === stop.id,
                      );
                      return (
                        <li key={stop.id}>
                          <span className="delivery-stop-number">
                            {index + 1}
                          </span>
                          <div>
                            <strong>{stop.name}</strong>
                            <span>
                              {time(stop.earliest)}–{time(stop.latest)} · 停靠{" "}
                              {stop.serviceMinutes} 分
                            </span>
                            {Boolean(leg?.lateMinutes) && (
                              <em>逾時 {fixed(leg?.lateMinutes, 1)} 分</em>
                            )}
                          </div>
                          <time>{time(leg?.arrivalMinutes)}</time>
                        </li>
                      );
                    })}
                    {displayedDraft?.returnToDepot && (
                      <li className="delivery-return-stop">
                        <span className="delivery-stop-number">
                          <ArrowDown size={13} />
                        </span>
                        <div>
                          <strong>返回起點</strong>
                          <span>{displayedDraft.depot.name}</span>
                        </div>
                        <time>
                          {time(
                            plan?.plan.legs
                              .slice()
                              .reverse()
                              .find((leg) => leg.to === displayedDraft.depot.id)
                              ?.arrivalMinutes,
                          )}
                        </time>
                      </li>
                    )}
                  </ol>
                  {plan && (
                    <div className="delivery-route-foot">
                      <span>
                        <Clock3 size={13} />
                        求解 {timing(plan.plan.elapsedMs)}
                      </span>
                      <span>{fixed(plan.plan.permutations)} 種順序</span>
                    </div>
                  )}
                </aside>
              </div>
              {plan && (
                <div className="delivery-fetch-metrics">
                  <span>
                    本次路由服務請求 {plan.metrics.requests} 次 · 矩陣元素{" "}
                    {String(dataObject(plan.matrix.metrics).elements ?? "—")} ·
                    規劃總耗時 {timing(plan.metrics.elapsedMs)}
                  </span>
                  <span>
                    {dataObject(plan.matrix.provenance).cached
                      ? "快取資料抓取於"
                      : "資料抓取於"}{" "}
                    {new Date(
                      String(
                        dataObject(plan.matrix.provenance).fetchedAt ??
                          plan.createdAt,
                      ),
                    ).toLocaleTimeString("zh-TW", {
                      hour12: false,
                    })}{" "}
                    · 計數不含底圖圖磚
                  </span>
                </div>
              )}
              {plan?.geometryError && (
                <div className="delivery-stale">
                  <TriangleAlert size={16} />
                  {plan.geometryError}
                </div>
              )}
              {provider === "google" && (
                <div className="delivery-google-policy">
                  Google Maps
                  估時僅供當次列表顯示，不保存、重播比較或匯出。比較策略請使用固定路網或
                  OSRM。
                </div>
              )}
              {plan && !plan.plan.feasible && (
                <div className="delivery-infeasible">
                  <TriangleAlert size={17} />
                  <div>
                    <strong>這組約束下尚未找到可行路線</strong>
                    <p>
                      {plan.plan.infeasibilityReasons
                        ?.map(
                          (reason) =>
                            ({
                              time_windows: "配送時窗存在逾時",
                              capacity_exceeded: "需求超過車輛容量",
                              unreachable: "路網有無法到達的站點",
                              no_route: "沒有可達路線",
                            })[reason] ?? reason,
                        )
                        .join("；") ||
                        `請檢查配送時窗與車輛容量。${plan.plan.capacityExceeded ? "目前需求超過容量。" : ""}`}
                    </p>
                  </div>
                </div>
              )}
              <div className="delivery-refresh-row">
                <label>
                  <input
                    type="checkbox"
                    checked={autoRefresh}
                    disabled={provider === "fixture" || Boolean(busy)}
                    onChange={(event) => {
                      setAutoRefresh(event.target.checked);
                      if (event.target.checked) {
                        autoCountRef.current = 0;
                        setAutoCount(0);
                        setNotice(
                          "每 60 秒刷新一次；只在此頁可見且沒有進行中的請求時執行，最多 5 次。",
                        );
                      }
                    }}
                  />
                  每 60 秒更新路網<span>自願開啟・最多 5 次</span>
                </label>
                <span>
                  {autoCount > 0
                    ? `本輪已嘗試刷新 ${autoCount}/5 次${!autoRefresh ? "・已停止" : ""}`
                    : "離開分頁時暫停刷新"}
                </span>
              </div>
              <details className="delivery-editor">
                <summary>
                  <span>
                    <Settings2 size={17} />
                    調整站點與配送約束
                  </span>
                  <span>
                    {draft.stops.length}/7 站 · 貨量 {totalDemand}/
                    {draft.capacity}
                    <ChevronDown size={15} />
                  </span>
                </summary>
                <fieldset disabled={Boolean(busy)}>
                  <legend className="delivery-sr-only">配送設定</legend>
                  <button
                    className="delivery-button"
                    type="button"
                    onClick={() => {
                      if (config) {
                        updateDraft(copy(config.scenario.draft));
                        setEvents(copy(config.scenario.events));
                        setSelectedEvent(0);
                        setNotice("已還原六站示範設定，請重新規劃。");
                      }
                    }}
                  >
                    還原六站示範
                  </button>
                  <div className="delivery-global-fields">
                    <label>
                      案例出發時鐘
                      <input
                        type="time"
                        value={time(draft.departureMinutes)}
                        onChange={(event) =>
                          updateDraft({
                            ...draft,
                            departureMinutes: minutes(event.target.value),
                          })
                        }
                      />
                    </label>
                    <label>
                      車輛容量
                      <input
                        type="number"
                        min={1}
                        max={1000}
                        value={draft.capacity}
                        onChange={(event) =>
                          updateDraft({
                            ...draft,
                            capacity: event.target.valueAsNumber,
                          })
                        }
                      />
                    </label>
                    <label className="delivery-checkbox">
                      <input
                        type="checkbox"
                        checked={draft.returnToDepot}
                        onChange={(event) =>
                          updateDraft({
                            ...draft,
                            returnToDepot: event.target.checked,
                          })
                        }
                      />
                      完成後返回起點
                    </label>
                  </div>
                  <div className="delivery-depot-editor">
                    <h3>
                      <MapPin size={16} />
                      出發地點
                    </h3>
                    <PointFields
                      point={draft.depot}
                      prefix="起點"
                      onChange={(depot) => updateDraft({ ...draft, depot })}
                    />
                  </div>
                  {draft.stops.map((stop, index) => (
                    <div className="delivery-stop-editor" key={stop.id}>
                      <div className="delivery-stop-editor-heading">
                        <h3>
                          <span>{index + 1}</span>配送站點
                        </h3>
                        <button
                          className="delivery-icon-button"
                          aria-label={`移除站點${index + 1} ${stop.name}`}
                          disabled={draft.stops.length <= 2}
                          onClick={() =>
                            updateDraft({
                              ...draft,
                              stops: draft.stops.filter(
                                (item) => item.id !== stop.id,
                              ),
                            })
                          }
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                      <PointFields
                        point={stop}
                        prefix={`站點${index + 1}`}
                        onChange={(point) =>
                          updateDraft({
                            ...draft,
                            stops: draft.stops.map((item) =>
                              item.id === stop.id
                                ? { ...stop, ...point }
                                : item,
                            ),
                          })
                        }
                      />
                      <div className="delivery-stop-constraints">
                        {(
                          [
                            "earliest",
                            "latest",
                            "serviceMinutes",
                            "demand",
                          ] as const
                        ).map((key) => (
                          <label key={key}>
                            {
                              {
                                earliest: "最早到站",
                                latest: "最晚到站",
                                serviceMinutes: "停靠分鐘",
                                demand: "貨量",
                              }[key]
                            }
                            <input
                              type={
                                key === "earliest" || key === "latest"
                                  ? "time"
                                  : "number"
                              }
                              min={0}
                              max={key === "demand" ? 1000 : 1440}
                              value={
                                key === "earliest" || key === "latest"
                                  ? time(stop[key])
                                  : stop[key]
                              }
                              onChange={(event) =>
                                updateDraft({
                                  ...draft,
                                  stops: draft.stops.map((item) =>
                                    item.id === stop.id
                                      ? {
                                          ...item,
                                          [key]:
                                            key === "earliest" ||
                                            key === "latest"
                                              ? minutes(event.target.value)
                                              : event.target.valueAsNumber,
                                        }
                                      : item,
                                  ),
                                })
                              }
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                  <button
                    className="delivery-button"
                    disabled={draft.stops.length >= 7}
                    onClick={() => {
                      const stop: DeliveryStop = {
                        id: `stop_${Date.now().toString(36)}`,
                        name: "新增公開地標",
                        lat: draft.depot.lat,
                        lng: draft.depot.lng,
                        earliest: draft.departureMinutes,
                        latest: Math.min(1439, draft.departureMinutes + 240),
                        serviceMinutes: 5,
                        demand: 1,
                      };
                      updateDraft({ ...draft, stops: [...draft.stops, stop] });
                    }}
                  >
                    <Plus size={16} />
                    新增站點<span>{draft.stops.length}/7</span>
                  </button>
                  <p className="delivery-form-help">
                    只輸入公開地標座標；不會使用你的定位。時間為合成案例的配送約束。
                  </p>
                </fieldset>
              </details>
            </section>
            <section
              className="delivery-experiment"
              aria-labelledby="delivery-compare-heading"
            >
              <div className="delivery-section-heading">
                <div>
                  <span className="delivery-section-number">02</span>
                  <h2 id="delivery-compare-heading">
                    讓變動進來，看看誰會重排
                  </h2>
                </div>
                <span className="delivery-small-badge">同一快照・相同事件</span>
              </div>
              <div className="delivery-experiment-intro">
                <p>
                  一句謝謝，不一定值得重新抓取地圖。
                  <br />
                  真正的交期變動，也不能被忽略。
                </p>
                <span>
                  比較四種決策方式：
                  <br />
                  每次重排、明確規則、單題語意、分層語意。
                </span>
              </div>
              <div className="delivery-event-lab">
                <div className="delivery-event-stream" aria-label="事件序列">
                  {events.map((event, index) => (
                    <button
                      key={event.id}
                      onClick={() => setSelectedEvent(index)}
                      aria-pressed={selectedEvent === index}
                      className={selectedEvent === index ? "active" : ""}
                    >
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <strong>
                        {eventNames[event.id] ?? event.text.slice(0, 14)}
                      </strong>
                      <ArrowRight size={14} />
                    </button>
                  ))}
                </div>
                {selected && (
                  <div className="delivery-event-editor">
                    <div>
                      <span className="delivery-eyebrow">
                        EVENT {String(selectedEvent + 1).padStart(2, "0")}
                      </span>
                      <span className="delivery-event-label">
                        {customDraft ||
                        eventEdited ||
                        selected.expectedRefresh === undefined
                          ? "自訂文字・未標記"
                          : `教學標記：${selected.expectedRefresh ? "需要刷新" : "不需刷新"}`}
                      </span>
                    </div>
                    <label
                      htmlFor="delivery-event-text"
                      className="delivery-sr-only"
                    >
                      目前事件的訊息內容
                    </label>
                    <textarea
                      id="delivery-event-text"
                      rows={3}
                      readOnly={selected.kind === "structured"}
                      maxLength={1200}
                      value={selected.text}
                      disabled={Boolean(busy)}
                      onChange={(event) =>
                        setEvents((items) =>
                          items.map((item, index) =>
                            index === selectedEvent
                              ? { ...item, text: event.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                    {selected.kind === "structured" && selected.patch && (
                      <label className="delivery-confirmed-window">
                        已確認的欄位變更：
                        {
                          draft?.stops.find(
                            (stop) => stop.id === selected.patch?.stopId,
                          )?.name
                        }{" "}
                        最晚開始交付
                        <input
                          type="time"
                          aria-label="事件確認的最晚交付時間"
                          disabled={Boolean(busy)}
                          value={time(selected.patch.latest)}
                          onChange={(event) => {
                            const latest = minutes(event.target.value);
                            const text = `演練控制台確認：此站最晚開始交付改為 ${event.target.value}，套用明確時間窗後重新計算。`;
                            setEvents((items) =>
                              items.map((item, index) =>
                                index === selectedEvent
                                  ? {
                                      ...item,
                                      text,
                                      expectedRefresh: undefined,
                                      patch: { ...item.patch!, latest },
                                    }
                                  : item,
                              ),
                            );
                          }}
                        />
                        <small>
                          此事件直接修改上方時間窗；自由文字事件不會自行修改地址或期限。
                        </small>
                      </label>
                    )}
                    <p>
                      可修改訊息再比較；修改訊息或配送設定後，原教學標記失效。這些標記用於示範比對，不代表真實準確率。
                    </p>
                  </div>
                )}
              </div>
              <div className="delivery-comparison-controls">
                <div>
                  <label htmlFor="delivery-model-mode">語意評估來源</label>
                  <select
                    id="delivery-model-mode"
                    value={mode}
                    disabled={Boolean(busy)}
                    onChange={(event) => setMode(event.target.value as Mode)}
                  >
                    {(Object.keys(modes) as Mode[]).map((value) => (
                      <option
                        key={value}
                        value={value}
                        disabled={
                          value === "localjev"
                            ? !config?.health.localjev.available
                            : value === "typesafe"
                              ? !config?.health.typesafe.configured
                              : false
                        }
                      >
                        {modes[value]}
                        {value === "localjev" &&
                        !config?.health.localjev.available
                          ? "・尚未就緒"
                          : value === "typesafe" &&
                              !config?.health.typesafe.configured
                            ? "・未設定"
                            : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <p>
                  {mode === "fixture"
                    ? "預設使用固定教學回應；結果不衡量模型品質。"
                    : `使用${mode === "localjev" ? "本機" : "已設定的雲端"}語意服務，需等待實際回應。沒有回應時不替換成固定值。`}
                </p>
                <button
                  className="delivery-button primary"
                  disabled={
                    !plan ||
                    plan.comparisonAllowed === false ||
                    provider === "google" ||
                    stale ||
                    Boolean(busy)
                  }
                  onClick={() => void runComparison()}
                >
                  {busy === "compare" ? (
                    <LoaderCircle className="delivery-spin" size={17} />
                  ) : (
                    <GitBranch size={17} />
                  )}
                  {busy === "compare" ? "等待實際評估…" : "開始比較四種策略"}
                </button>
                {busy && (
                  <button
                    className="delivery-button"
                    onClick={() => pending.current?.abort()}
                  >
                    <X size={15} />
                    取消等待
                  </button>
                )}
              </div>
              <details className="delivery-cost-settings">
                <summary>
                  <span>
                    <Settings2 size={15} />
                    門檻與成本估算
                  </span>
                  <span>
                    單價留空時不估算
                    <ChevronDown size={15} />
                  </span>
                </summary>
                <div className="delivery-cost-grid">
                  <label>
                    FALSE 上限
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={thresholds.falseAt}
                      disabled={Boolean(busy)}
                      onChange={(event) =>
                        setThresholds({
                          ...thresholds,
                          falseAt: event.target.valueAsNumber,
                        })
                      }
                    />
                  </label>
                  <label>
                    TRUE 下限
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={thresholds.trueAt}
                      disabled={Boolean(busy)}
                      onChange={(event) =>
                        setThresholds({
                          ...thresholds,
                          trueAt: event.target.valueAsNumber,
                        })
                      }
                    />
                  </label>
                  {(
                    Object.keys(priceLabels) as Array<keyof DeliveryPrices>
                  ).map((key) => (
                    <label key={key}>
                      {priceLabels[key]}
                      <span className="delivery-currency-input">
                        <span>$</span>
                        <input
                          type="number"
                          min={0}
                          step="any"
                          placeholder="未填單價"
                          value={prices[key] ?? ""}
                          disabled={Boolean(busy)}
                          onChange={(event) =>
                            setPrices({
                              ...prices,
                              [key]:
                                event.target.value === ""
                                  ? null
                                  : event.target.valueAsNumber,
                            })
                          }
                        />
                        <span>USD</span>
                      </span>
                    </label>
                  ))}
                </div>
                <p>
                  成本依你提供的假設單價投影；求解時間是實測經過時間，不是 CPU
                  真實用量。建議刷新次數來自重播，不等於已發生的地圖請求或實際節省。
                </p>
              </details>
              {comparisonStale && (
                <div className="delivery-stale">
                  <TriangleAlert size={16} />
                  事件、門檻或路線已變更。下方保留前一次比較，請重新執行。
                </div>
              )}
              {comparison ? (
                <div
                  className={`delivery-results ${comparisonStale ? "is-stale" : ""}`}
                >
                  <div className="delivery-shared-snapshot">
                    <Layers3 size={23} strokeWidth={1.3} />
                    <div>
                      <strong>四種策略，共用同一張路網快照</strong>
                      <span>
                        比較階段實際地圖請求：{comparison.actual.mapRequests} 次
                        · 語意請求 {comparison.actual.modelRequests} 次 · 總耗時{" "}
                        {timing(comparison.actual.elapsedMs)}
                      </span>
                    </div>
                    <button
                      className="delivery-button"
                      disabled={Boolean(busy)}
                      onClick={verifyReport}
                    >
                      <ShieldCheck size={15} />
                      {busy === "verify" ? "驗證中…" : "離線驗證"}
                    </button>
                    <button
                      className="delivery-button"
                      onClick={download}
                      disabled={
                        plan?.comparisonAllowed === false ||
                        provider === "google"
                      }
                    >
                      <Download size={15} />
                      下載報告
                    </button>
                  </div>
                  {verification && (
                    <p className="delivery-results-explainer" role="status">
                      {verification}
                    </p>
                  )}
                  <p className="delivery-results-explainer">
                    建議刷新次數（重播，不另呼叫地圖）。請同時比較明確規則基準，以及遺漏與多餘決策；不能只靠刷新較少就認定更好。
                  </p>
                  <div className="delivery-comparison-grid">
                    {comparison.strategies.map((strategy) => (
                      <article
                        className={`delivery-strategy ${strategy.id === "rules" ? "baseline" : ""}`}
                        key={strategy.id}
                      >
                        <header>
                          <span>
                            {strategy.id === "always"
                              ? "BASELINE 01"
                              : strategy.id === "rules"
                                ? "BASELINE 02"
                                : strategy.id === "single"
                                  ? "SEMANTIC 01"
                                  : "SEMANTIC 02"}
                          </span>
                          <h3>{strategy.name}</h3>
                          {strategy.id === "rules" && (
                            <span className="delivery-baseline-label">
                              規則基準
                            </span>
                          )}
                        </header>
                        <div className="delivery-strategy-number">
                          <strong>{strategy.mapRefreshDecisions}</strong>
                          <span>次建議刷新</span>
                        </div>
                        <dl>
                          <div>
                            <dt>重新求解</dt>
                            <dd>{strategy.replans} 次</dd>
                          </div>
                          <div>
                            <dt>模型請求 / 題數</dt>
                            <dd>
                              {strategy.modelRequests} /{" "}
                              {strategy.modelQuestions}
                            </dd>
                          </div>
                          <div>
                            <dt>語意實測時間</dt>
                            <dd>{timing(strategy.semanticMs)}</dd>
                          </div>
                          <div>
                            <dt>求解實測時間</dt>
                            <dd>{timing(strategy.solverMs)}</dd>
                          </div>
                          <div>
                            <dt>漏掉需要刷新的事件</dt>
                            <dd>{fixed(strategy.missedRefreshes)}</dd>
                          </div>
                          <div>
                            <dt>多餘的刷新決策</dt>
                            <dd>{fixed(strategy.falseRefreshes)}</dd>
                          </div>
                          <div className="delivery-cost-total">
                            <dt>成本估算</dt>
                            <dd>
                              {strategy.estimatedCostUsd === null
                                ? "未估算"
                                : `$${strategy.estimatedCostUsd.toFixed(5)}`}
                            </dd>
                          </div>
                        </dl>
                        <details className="delivery-strategy-steps">
                          <summary>
                            看每次判斷
                            <ChevronDown size={14} />
                          </summary>
                          <ol>
                            {strategy.steps.map((step, index) => (
                              <li key={`${step.eventId}-${index}`}>
                                <div>
                                  <span>
                                    {String(index + 1).padStart(2, "0")}
                                  </span>
                                  <strong
                                    className={
                                      step.decision === "refresh"
                                        ? "refresh"
                                        : ""
                                    }
                                  >
                                    {step.decision === "refresh"
                                      ? "建議刷新"
                                      : "略過"}
                                    {step.truth ? ` · ${step.truth}` : ""}
                                  </strong>
                                </div>
                                <p>{step.text}</p>
                                <small>{step.reason}</small>
                                {step.gateSignals && (
                                  <div className="delivery-gate-signals">
                                    {Object.entries(step.gateSignals).map(
                                      ([id, signal]) => (
                                        <span key={id}>
                                          {gateNames[id] ?? id} ·{" "}
                                          {typeof signal === "string"
                                            ? signal
                                            : (signal.truth ?? "UNKNOWN")}
                                        </span>
                                      ),
                                    )}
                                  </div>
                                )}
                                {step.planChanged !== undefined && (
                                  <small>
                                    {step.planChanged
                                      ? "路線或估時有變更"
                                      : "路線與估時未變更"}
                                  </small>
                                )}
                              </li>
                            ))}
                          </ol>
                        </details>
                      </article>
                    ))}
                  </div>
                  {comparison.warnings?.length > 0 && (
                    <div className="delivery-warnings">
                      <ShieldCheck size={17} />
                      <ul>
                        {comparison.warnings.map((warning, index) => (
                          <li key={index}>{warning}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ) : (
                <div className="delivery-comparison-empty">
                  <GitBranch size={25} strokeWidth={1.2} />
                  <div>
                    <strong>路線相同，判斷可以不同。</strong>
                    <p>
                      選好事件後開始比較。這裡會分開呈現地圖決策、語意評估與求解成本。
                    </p>
                  </div>
                </div>
              )}
            </section>
            <footer className="delivery-footer">
              <span>
                <FlaskConical size={15} />
                這是一個研究用配送實驗，不會派單或聯絡客戶。
              </span>
              <a href="/">
                探索其他語意情境
                <ArrowRight size={14} />
              </a>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
