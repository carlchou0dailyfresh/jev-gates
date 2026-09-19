import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  Download,
  FileText,
  FlaskConical,
  GitBranch,
  History,
  Layers3,
  LoaderCircle,
  Menu,
  MessageSquareText,
  Minus,
  Network,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { scenarios } from "./scenarios";
import type {
  Draft,
  Gate,
  Health,
  Mode,
  Narration,
  Replay,
  Run,
  Scenario,
  Truth,
} from "./types";

const truthOrder: Truth[] = ["TRUE", "FALSE", "UNKNOWN"];
const truthNames: Record<Truth, string> = {
  TRUE: "條件成立",
  FALSE: "條件不成立",
  UNKNOWN: "仍需釐清",
};
const modeNames: Record<Mode, string> = {
  fixture: "固定測試",
  localjev: "LocalJev",
  typesafe: "TypeSafe JEV",
};
const scenarioIcons = {
  research: Search,
  support: MessageSquareText,
  incident: Activity,
  planning: Layers3,
};
const DRAFT_KEY = "jev-semantic-studio:drafts:v1";
const HISTORY_KEY = "jev-semantic-studio:history:v1";
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const shortId = () => Math.random().toString(36).slice(2, 10);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isTruth = (value: unknown): value is Truth =>
  typeof value === "string" && truthOrder.includes(value as Truth);
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isBranch = (value: unknown) =>
  isRecord(value) &&
  typeof value.title === "string" &&
  typeof value.instruction === "string";
function isDraft(value: unknown): value is Draft {
  if (
    !isRecord(value) ||
    typeof value.scenarioId !== "string" ||
    typeof value.title !== "string" ||
    typeof value.task !== "string"
  )
    return false;
  if (
    !Array.isArray(value.evidence) ||
    value.evidence.length < 1 ||
    value.evidence.length > 12 ||
    !value.evidence.every(
      (e) =>
        isRecord(e) &&
        typeof e.id === "string" &&
        /^E(?:[1-9]|1[0-2])$/.test(e.id) &&
        typeof e.title === "string" &&
        typeof e.text === "string",
    )
  )
    return false;
  if (new Set(value.evidence.map((e) => e.id)).size !== value.evidence.length)
    return false;
  if (
    !Array.isArray(value.gates) ||
    value.gates.length < 1 ||
    value.gates.length > 6 ||
    !value.gates.every(
      (g) =>
        isRecord(g) &&
        typeof g.id === "string" &&
        typeof g.title === "string" &&
        typeof g.question === "string" &&
        typeof g.enabled === "boolean" &&
        [g.fixture, g.falseAt, g.trueAt].every(
          (n) => finite(n) && n >= 0 && n <= 1,
        ),
    )
  )
    return false;
  if (new Set(value.gates.map((g) => g.id)).size !== value.gates.length)
    return false;
  const branches = value.branches;
  return (
    ["and", "or", "kofn"].includes(value.combination as string) &&
    Number.isInteger(value.k) &&
    finite(value.k) &&
    value.k >= 1 &&
    value.k <= 6 &&
    isRecord(branches) &&
    truthOrder.every((t) => isBranch(branches[t]))
  );
}
function isSignal(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isTruth(value.truth) ||
    typeof value.reason !== "string"
  )
    return false;
  if (value.answer === undefined) return true;
  return (
    isRecord(value.answer) &&
    (value.answer.noul === undefined || finite(value.answer.noul))
  );
}
function isRun(value: unknown): value is Run {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.createdAt !== "string" ||
    !["fixture", "localjev", "typesafe"].includes(value.mode as string) ||
    !isDraft(value.draft) ||
    !isTruth(value.truth) ||
    !isBranch(value.branch) ||
    !finite(value.elapsedMs) ||
    value.elapsedMs < 0 ||
    typeof value.digest !== "string" ||
    typeof value.template !== "string"
  )
    return false;
  const provenance = value.provenance;
  if (
    !isRecord(provenance) ||
    typeof provenance.provider !== "string" ||
    typeof provenance.model !== "string" ||
    (provenance.upstreamModel !== undefined &&
      typeof provenance.upstreamModel !== "string") ||
    provenance.synthetic !== true ||
    provenance.calibrated !== false
  )
    return false;
  const result = value.result;
  return (
    isRecord(result) &&
    typeof result.circuit === "string" &&
    typeof result.circuitDigest === "string" &&
    typeof result.inputDigest === "string" &&
    typeof result.status === "string" &&
    isRecord(result.signals) &&
    Object.values(result.signals).every(isSignal) &&
    isRecord(result.outputs) &&
    Object.values(result.outputs).every(isSignal) &&
    Array.isArray(result.nodes) &&
    result.nodes.every(
      (n) =>
        isRecord(n) &&
        typeof n.id === "string" &&
        typeof n.kind === "string" &&
        isSignal(n.signal) &&
        finite(n.elapsedMs),
    ) &&
    Array.isArray(result.calls)
  );
}

function getSavedDraft(scenario: Scenario): Draft {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}");
    const saved = isRecord(stored) ? stored[scenario.id] : null;
    if (isDraft(saved) && saved.scenarioId === scenario.id) return saved;
  } catch {
    /* A damaged local draft should not prevent opening the studio. */
  }
  return clone(scenario.draft);
}

function describeReason(reason: string): string {
  const labels: Record<string, string> = {
    condition_false: "前置條件不成立，因此沒有執行這個判斷。",
    condition_unknown: "前置條件仍然未知，等待更多資訊。",
    context_unknown: "依賴的判斷仍然未知，尚未繼續推論。",
    missing_input: "缺少這個判斷需要的輸入資料。",
    provider_error: "提供者未能完成判斷，保留未知結果。",
    timeout: "模型沒有在時間限制內回答。",
    budget_exhausted: "本次執行的呼叫預算已用完。",
    no_provider: "尚未設定可用的模型提供者。",
  };
  return (
    labels[reason] ||
    (reason.includes("threshold") || reason.includes("band")
      ? "依本次設定的分數門檻轉換為三值訊號。"
      : reason.includes("error") || reason.includes("invalid")
        ? "回答或執行發生問題，請查看下方原始原因。"
        : "依節點政策與實際輸入計算；原始原因保留於下方。")
  );
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    path,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const value = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      value.error || value.message || `請求未完成（${response.status}）`,
    );
  return value as T;
}

function TruthBadge({
  truth,
  small = false,
}: {
  truth: Truth;
  small?: boolean;
}) {
  return (
    <span
      className={`truth-badge truth-${truth.toLowerCase()}${small ? " small" : ""}`}
    >
      <span className="truth-dot" />
      {truthNames[truth]}
      <span className="truth-code">{truth}</span>
    </span>
  );
}

export default function App() {
  const [activeId, setActiveId] = useState(scenarios[0].id);
  const [draft, setDraft] = useState<Draft>(() => getSavedDraft(scenarios[0]));
  const [mode, setMode] = useState<Mode>("fixture");
  const [health, setHealth] = useState<Health | null>(null);
  const [healthBusy, setHealthBusy] = useState(false);
  const [healthError, setHealthError] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [inspector, setInspector] = useState<"result" | "gate" | "branch">(
    "result",
  );
  const [selectedGateId, setSelectedGateId] = useState(
    draft.gates[0]?.id || "",
  );
  const [selectedBranch, setSelectedBranch] = useState<Truth>("TRUE");
  const [narration, setNarration] = useState<Narration | null>(null);
  const [narrating, setNarrating] = useState(false);
  const [tone, setTone] = useState<"brief" | "analysis">("brief");
  const [llmModel, setLlmModel] = useState("");
  const [replaying, setReplaying] = useState(false);
  const [replay, setReplay] = useState<{
    result: Replay;
    label: string;
  } | null>(null);
  const [history, setHistory] = useState<Run[]>(() => {
    try {
      const saved: unknown = JSON.parse(
        localStorage.getItem(HISTORY_KEY) || "[]",
      );
      return Array.isArray(saved) ? saved.filter(isRun).slice(0, 10) : [];
    } catch {
      return [];
    }
  });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [savedStatus, setSavedStatus] = useState(true);
  const [copied, setCopied] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);

  const scenario = scenarios.find((s) => s.id === activeId) || scenarios[0];
  const activeGates = draft.gates.filter((g) => g.enabled);
  const selectedGate =
    draft.gates.find((g) => g.id === selectedGateId) || draft.gates[0];
  const stale =
    !!run &&
    (JSON.stringify(run.draft) !== JSON.stringify(draft) || run.mode !== mode);
  const currentRun = run && !stale ? run : null;
  const available =
    mode === "fixture" ||
    (mode === "localjev"
      ? !!health?.localjev.available
      : !!health?.typesafe.configured);
  const invalidPolicy = draft.gates.some((g) => g.falseAt >= g.trueAt);

  async function refreshHealth() {
    setHealthBusy(true);
    try {
      const value = await api<Health>("/api/health");
      setHealth(value);
      setHealthError(false);
      setLlmModel((previous) =>
        value.llm.models.includes(previous)
          ? previous
          : value.llm.defaultModel &&
              value.llm.models.includes(value.llm.defaultModel)
            ? value.llm.defaultModel
            : value.llm.models[0] || "",
      );
    } catch {
      setHealthError(true);
    } finally {
      setHealthBusy(false);
    }
  }
  useEffect(() => {
    void refreshHealth();
  }, []);
  useEffect(() => {
    try {
      let stored: unknown = {};
      try {
        stored = JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}");
      } catch {
        /* Replace a damaged stored draft collection. */
      }
      const saved = isRecord(stored) ? stored : {};
      localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ ...saved, [draft.scenarioId]: draft }),
      );
      setSavedStatus(true);
    } catch {
      setSavedStatus(false);
    }
  }, [draft]);

  function patchGate(id: string, patch: Partial<Gate>) {
    setDraft((previous) => ({
      ...previous,
      gates: previous.gates.map((g) => (g.id === id ? { ...g, ...patch } : g)),
    }));
  }
  function moveInspectorTab(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = ["result", "gate", "branch"] as const;
    const current = tabs.indexOf(inspector);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? 2
          : (current + (event.key === "ArrowRight" ? 1 : 2)) % 3;
    setInspector(tabs[next]);
    tabListRef.current
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      [next]?.focus();
  }
  function showInspector(kind: "result" | "gate" | "branch") {
    setInspector(kind);
    if (window.matchMedia("(max-width: 1050px)").matches) {
      requestAnimationFrame(() =>
        inspectorRef.current?.scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
            .matches
            ? "auto"
            : "smooth",
          block: "start",
        }),
      );
    }
  }
  function chooseScenario(next: Scenario) {
    const nextDraft = getSavedDraft(next);
    setActiveId(next.id);
    setDraft(nextDraft);
    setSelectedGateId(nextDraft.gates[0]?.id || "");
    setRun(null);
    setNarration(null);
    setReplay(null);
    setError("");
    setInspector("result");
    setSidebarOpen(false);
  }
  function resetDraft() {
    const nextDraft = clone(scenario.draft);
    setDraft(nextDraft);
    setSelectedGateId(nextDraft.gates[0]?.id || "");
    setError("");
  }
  function addGate() {
    if (draft.gates.length >= 6) return;
    const gate: Gate = {
      id: `gate_${shortId()}`,
      title: "新的語意判斷",
      question: "現有證據是否足以支持這個條件？",
      enabled: true,
      falseAt: 0.3,
      trueAt: 0.7,
      fixture: 0.5,
    };
    setDraft((previous) => ({ ...previous, gates: [...previous.gates, gate] }));
    setSelectedGateId(gate.id);
    showInspector("gate");
  }
  function deleteGate(id: string) {
    if (draft.gates.length <= 1) return;
    const remaining = draft.gates.filter((g) => g.id !== id);
    setDraft((previous) => ({
      ...previous,
      gates: remaining,
      k: Math.max(
        1,
        Math.min(previous.k, remaining.filter((g) => g.enabled).length || 1),
      ),
    }));
    setSelectedGateId(remaining[0].id);
  }
  async function execute() {
    setError("");
    setRun(null);
    setRunning(true);
    setNarration(null);
    setReplay(null);
    showInspector("result");
    const requestedDraft = clone(draft);
    const requestedMode = mode;
    try {
      const result = await api<Run>("/api/run", {
        draft: requestedDraft,
        mode: requestedMode,
      });
      setRun(result);
      setHistory((previous) => {
        const next = [
          result,
          ...previous.filter((r) => r.id !== result.id),
        ].slice(0, 10);
        try {
          localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
        } catch {
          /* Runs remain available in this session. */
        }
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "本次執行未完成，請重試。");
    } finally {
      setRunning(false);
    }
  }
  async function explain() {
    if (!currentRun) return;
    setNarrating(true);
    setError("");
    const runId = currentRun.id;
    try {
      const result = await api<Narration>("/api/narrate", {
        runId,
        tone,
        ...(llmModel ? { model: llmModel } : {}),
      });
      setNarration(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "模型解說未完成。");
    } finally {
      setNarrating(false);
    }
  }
  async function verifyReplay(candidate: Run, label: string) {
    setReplaying(true);
    setError("");
    setInspector("result");
    try {
      setReplay({
        result: await api<Replay>("/api/replay", { run: candidate }),
        label: `${label} · ${candidate.id}`,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "無法驗證這份紀錄。");
    } finally {
      setReplaying(false);
    }
  }
  function exportRun() {
    if (!run) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(run, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `jev-run-${run.id.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importRun(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 256 * 1024 - 16) {
      setError("請選擇小於 256 KB 的執行紀錄。");
      return;
    }
    try {
      const value: unknown = JSON.parse(await file.text());
      if (!isRun(value))
        throw new Error(
          "這不是完整的 JEV 執行紀錄，請匯入從工作台匯出的 JSON。",
        );
      await verifyReplay(value, file.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : "無法讀取這個 JSON 檔案。");
    }
  }
  function restoreRun(record: Run) {
    setActiveId(record.draft.scenarioId);
    setDraft(clone(record.draft));
    setMode(record.mode);
    setRun(record);
    setNarration(null);
    setReplay(null);
    setSelectedGateId(record.draft.gates[0]?.id || "");
    setHistoryOpen(false);
    setInspector("result");
    setError("");
  }
  async function copySummary() {
    if (!run) return;
    try {
      await navigator.clipboard.writeText(run.template);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("瀏覽器無法複製文字，請從結果面板選取文字。");
    }
  }

  return (
    <div className="studio-shell">
      <a className="skip-link" href="#workspace">
        跳至工作區
      </a>
      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          aria-label="關閉情境選單"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside
        className={`sidebar ${sidebarOpen ? "is-open" : ""}`}
        aria-label="工作台導覽"
        onKeyDown={(event) => {
          if (event.key === "Escape") setSidebarOpen(false);
        }}
      >
        <a
          className="brand"
          href="#workspace"
          onClick={() => setSidebarOpen(false)}
          aria-label="JEV Semantic Studio 工作區"
        >
          <span className="brand-mark">
            <GitBranch size={23} strokeWidth={1.5} />
          </span>
          <span>
            <strong>
              JEV<span className="brand-period">.</span>
            </strong>
            <small>SEMANTIC STUDIO</small>
          </span>
        </a>
        <a className="delivery-entry" href="/delivery">配送路線實驗 <span>地圖與成本比較 ↗</span></a>
        <div className="sidebar-section-label">
          探索情境 <span>04</span>
        </div>
        <nav className="scenario-nav" aria-label="情境">
          {scenarios.map((item, index) => {
            const Icon = scenarioIcons[item.icon] || FlaskConical;
            return (
              <button
                key={item.id}
                className={`scenario-item ${activeId === item.id ? "active" : ""}`}
                onClick={() => chooseScenario(item)}
                aria-current={activeId === item.id ? "page" : undefined}
                disabled={running}
              >
                <span className="scenario-icon">
                  <Icon size={18} strokeWidth={1.7} />
                </span>
                <span className="scenario-nav-copy">
                  <small>
                    0{index + 1} · {item.category}
                  </small>
                  <strong>{item.title}</strong>
                </span>
                <ChevronRight className="scenario-chevron" size={15} />
              </button>
            );
          })}
        </nav>
        <div className="sidebar-note">
          <span className="tiny-label">從證據，走向決策</span>
          <p>
            把一個大問題拆成小判斷，
            <br />
            看見每一步為什麼成立。
          </p>
          <div className="mini-circuit" aria-hidden="true">
            <i />
            <b />
            <i />
            <b />
            <i className="filled" />
          </div>
        </div>
        <div className="sidebar-bottom">
          <div className="connection-heading">
            <span>本機連線</span>
            <button
              className="icon-button"
              aria-label="重新檢查模型連線"
              onClick={refreshHealth}
              disabled={healthBusy}
            >
              <RefreshCw size={14} className={healthBusy ? "spin" : ""} />
            </button>
          </div>
          <div className="connection-row">
            <span
              className={`status-light ${health?.localjev.available ? "online" : ""}`}
            />
            <span>LocalJev</span>
            <small>
              {health?.localjev.available
                ? "已連線"
                : healthBusy
                  ? "檢查中"
                  : "未連線"}
            </small>
          </div>
          <div className="connection-row">
            <span
              className={`status-light ${health?.llm.available ? "online" : ""}`}
            />
            <span>本機語言模型</span>
            <small>
              {health?.llm.available
                ? "已連線"
                : healthBusy
                  ? "檢查中"
                  : "未連線"}
            </small>
          </div>
          {healthError && (
            <p className="connection-error">
              無法取得連線狀態，請確認工作台服務已啟動。
            </p>
          )}
          <div className="sidebar-footer">
            <FlaskConical size={14} />
            <span>研究展示 · 合成資料</span>
            <span className="version">v0.1</span>
          </div>
        </div>
      </aside>

      <main className="main" id="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="開啟情境選單"
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={20} />
            </button>
            <span>工作台</span>
            <ChevronRight size={13} />
            <strong>{scenario.category}</strong>
          </div>
          <div className="topbar-actions">
            <span className="save-indicator">
              <span />
              {savedStatus ? "草稿已儲存在此瀏覽器" : "草稿僅保留於此頁面"}
            </span>
            <button
              className={`subtle-button ${historyOpen ? "selected" : ""}`}
              onClick={() => setHistoryOpen((v) => !v)}
              aria-expanded={historyOpen}
            >
              <History size={15} />
              <span>執行紀錄</span>
              {history.length > 0 && (
                <span className="count-pill">{history.length}</span>
              )}
            </button>
          </div>
        </header>
        <div className="workspace-body">
          <section className="page-intro">
            <div>
              <div className="eyebrow">
                <span className="eyebrow-line" />
                把判斷攤開來看
              </div>
              <h1>{scenario.title}</h1>
              <p>{scenario.description}</p>
            </div>
            <div className="intro-controls">
              <div className="intro-meta">
                <span className="synthetic-tag">
                  <FlaskConical size={13} />
                  合成案例
                </span>
                <span className="intro-separator" />
                <span>
                  <Clock3 size={13} />
                  {scenario.duration}
                </span>
              </div>
              <button
                className="primary-button intro-run-button"
                onClick={execute}
                disabled={
                  running ||
                  !available ||
                  invalidPolicy ||
                  activeGates.length === 0 ||
                  !draft.task.trim()
                }
              >
                {running ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Play size={14} fill="currentColor" />
                )}
                {running ? "正在判斷" : "執行目前情境"}
                <ArrowRight size={14} />
              </button>
              <span className="intro-mode-label">
                {modeNames[mode]} · {activeGates.length} 個判斷
              </span>
            </div>
          </section>

          {historyOpen && (
            <section className="history-panel" aria-label="最近執行紀錄">
              <div className="section-heading">
                <div>
                  <span className="section-index">
                    <History size={15} />
                  </span>
                  <h2>最近執行</h2>
                  <span className="muted-caption">
                    最多保留 10 次，僅存於此瀏覽器
                  </span>
                </div>
                <button
                  className="icon-button"
                  aria-label="關閉執行紀錄"
                  onClick={() => setHistoryOpen(false)}
                >
                  <X size={17} />
                </button>
              </div>
              {history.length === 0 ? (
                <p className="small-empty">
                  還沒有執行紀錄。從下方編輯情境，再執行第一次判斷。
                </p>
              ) : (
                <div className="history-list">
                  {history.map((record) => (
                    <button
                      className="history-item"
                      key={record.id}
                      onClick={() => restoreRun(record)}
                      disabled={running}
                    >
                      <span>
                        <strong>{record.draft.title}</strong>
                        <small>
                          {new Date(record.createdAt).toLocaleString("zh-TW", {
                            month: "2-digit",
                            day: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}{" "}
                          · {modeNames[record.mode]}
                        </small>
                      </span>
                      <TruthBadge truth={record.truth} small />
                      <ArrowUpRight size={15} />
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

          {error && (
            <div className="error-banner" role="alert">
              <CircleHelp size={18} />
              <span>{error}</span>
              <button
                className="icon-button"
                aria-label="關閉錯誤訊息"
                onClick={() => setError("")}
              >
                <X size={15} />
              </button>
            </div>
          )}

          <div className="workbench-grid">
            <div className="editor-column">
              <section className="context-panel panel">
                <div className="section-heading">
                  <div>
                    <span className="section-index">01</span>
                    <h2>給判斷一個情境</h2>
                  </div>
                  <button
                    className="subtle-button reset-button"
                    onClick={resetDraft}
                    disabled={running}
                  >
                    <RotateCcw size={14} />
                    <span>還原範例</span>
                  </button>
                </div>
                <div className="context-content">
                  <label className="field-label" htmlFor="task">
                    這次要判斷什麼？<span>可直接改寫</span>
                  </label>
                  <textarea
                    id="task"
                    className="task-input"
                    value={draft.task}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, task: e.target.value }))
                    }
                    rows={3}
                    maxLength={4000}
                    spellCheck={false}
                  />
                  <div className="evidence-heading">
                    <label className="field-label">
                      提供給模型的證據<span>{draft.evidence.length} 份</span>
                    </label>
                    <button
                      className="text-button"
                      onClick={() =>
                        setDraft((d) => ({
                          ...d,
                          evidence: [
                            ...d.evidence,
                            {
                              id:
                                Array.from(
                                  { length: 12 },
                                  (_, i) => `E${i + 1}`,
                                ).find(
                                  (id) => !d.evidence.some((e) => e.id === id),
                                ) || "E12",
                              title: "補充資料",
                              text: "",
                            },
                          ],
                        }))
                      }
                      disabled={draft.evidence.length >= 12}
                    >
                      <Plus size={13} />
                      新增
                    </button>
                  </div>
                  <div className="evidence-list">
                    {draft.evidence.map((evidence, index) => (
                      <details className="evidence-item" key={evidence.id}>
                        <summary>
                          <span className="evidence-number">{evidence.id}</span>
                          <span className="evidence-title">
                            {evidence.title || "未命名證據"}
                          </span>
                          <ChevronDown className="evidence-chevron" size={15} />
                        </summary>
                        <div className="evidence-editor">
                          <div className="evidence-edit-heading">
                            <label
                              className="sr-only"
                              htmlFor={`title-${evidence.id}`}
                            >
                              證據 {index + 1} 名稱
                            </label>
                            <input
                              id={`title-${evidence.id}`}
                              aria-label={`證據 ${index + 1} 名稱`}
                              value={evidence.title}
                              onChange={(e) =>
                                setDraft((d) => ({
                                  ...d,
                                  evidence: d.evidence.map((item) =>
                                    item.id === evidence.id
                                      ? { ...item, title: e.target.value }
                                      : item,
                                  ),
                                }))
                              }
                              maxLength={160}
                            />
                            <button
                              className="icon-button danger-hover"
                              aria-label={`刪除證據 ${index + 1}`}
                              onClick={() =>
                                setDraft((d) => ({
                                  ...d,
                                  evidence: d.evidence.filter(
                                    (item) => item.id !== evidence.id,
                                  ),
                                }))
                              }
                              disabled={draft.evidence.length <= 1}
                            >
                              <X size={14} />
                            </button>
                          </div>
                          <label
                            className="sr-only"
                            htmlFor={`text-${evidence.id}`}
                          >
                            證據 {index + 1} 內容
                          </label>
                          <textarea
                            id={`text-${evidence.id}`}
                            value={evidence.text}
                            onChange={(e) =>
                              setDraft((d) => ({
                                ...d,
                                evidence: d.evidence.map((item) =>
                                  item.id === evidence.id
                                    ? { ...item, text: e.target.value }
                                    : item,
                                ),
                              }))
                            }
                            rows={4}
                            maxLength={4000}
                            spellCheck={false}
                          />
                          <div className="evidence-foot">
                            <FileText size={11} />
                            <span>合成資料 · 可編輯</span>
                            <span>
                              {evidence.text.length.toLocaleString()} 字元
                            </span>
                          </div>
                        </div>
                      </details>
                    ))}
                  </div>
                </div>
              </section>

              <section
                className="circuit-panel panel"
                aria-label="語意決策電路"
              >
                <div className="section-heading">
                  <div>
                    <span className="section-index">02</span>
                    <h2>把條件接成決策</h2>
                  </div>
                  <button
                    className="text-button"
                    onClick={addGate}
                    disabled={draft.gates.length >= 6}
                  >
                    <Plus size={14} />
                    新增判斷
                    <span className="gate-limit">{draft.gates.length}/6</span>
                  </button>
                </div>
                <div className="circuit-caption">
                  <span>點選節點，調整問題與門檻</span>
                  <div className="graph-legend">
                    <span>
                      <i className="legend-true" />
                      成立
                    </span>
                    <span>
                      <i className="legend-false" />
                      不成立
                    </span>
                    <span>
                      <i className="legend-unknown" />
                      未知
                    </span>
                  </div>
                </div>
                <div className="circuit-canvas">
                  <div className="input-anchor">
                    <FileText size={13} />
                    <span>原始任務 + {draft.evidence.length} 份證據</span>
                  </div>
                  <div className="stem" aria-hidden="true" />
                  <div
                    className="gate-rail"
                    style={
                      { "--gate-count": draft.gates.length } as CSSProperties
                    }
                  >
                    {draft.gates.map((gate, index) => {
                      const signal = currentRun?.result.signals[gate.id];
                      return (
                        <div
                          className={`gate-slot ${!gate.enabled ? "gate-disabled" : ""}`}
                          key={gate.id}
                        >
                          <div className="gate-feed" aria-hidden="true" />
                          <button
                            className={`gate-card ${selectedGateId === gate.id && inspector === "gate" ? "is-selected" : ""} ${signal && gate.enabled ? `signal-${signal.truth.toLowerCase()}` : ""}`}
                            onClick={() => {
                              setSelectedGateId(gate.id);
                              showInspector("gate");
                            }}
                            aria-pressed={
                              selectedGateId === gate.id && inspector === "gate"
                            }
                          >
                            <span className="gate-card-top">
                              <span className="gate-code">
                                G{String(index + 1).padStart(2, "0")}
                              </span>
                              <span
                                className={`gate-status-dot ${signal && gate.enabled ? signal.truth.toLowerCase() : ""}`}
                              />{" "}
                            </span>
                            <strong>{gate.title || "未命名判斷"}</strong>
                            <span className="gate-card-bottom">
                              {!gate.enabled
                                ? "已停用"
                                : running
                                  ? "判斷中…"
                                  : signal
                                    ? truthNames[signal.truth]
                                    : "語意判斷"}
                              <ArrowUpRight size={12} />
                            </span>
                          </button>
                          <div
                            className="gate-output-line"
                            aria-hidden="true"
                          />
                        </div>
                      );
                    })}
                  </div>
                  <div className="stem connector-bottom" aria-hidden="true" />
                  <div className="combination-control">
                    <span className="combination-icon">
                      <Network size={16} />
                    </span>
                    <label htmlFor="combination" className="sr-only">
                      邏輯組合方式
                    </label>
                    <select
                      id="combination"
                      value={draft.combination}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          combination: e.target.value as Draft["combination"],
                          k: Math.max(
                            1,
                            Math.min(d.k, activeGates.length || 1),
                          ),
                        }))
                      }
                    >
                      <option value="and">AND · 全部成立</option>
                      <option value="or">OR · 任一成立</option>
                      <option value="kofn">K OF N · 達到門檻</option>
                    </select>
                    {draft.combination === "kofn" && (
                      <>
                        <input
                          className="k-input"
                          type="number"
                          aria-label="至少成立的判斷數"
                          value={draft.k}
                          min={1}
                          max={Math.max(1, activeGates.length)}
                          onChange={(e) =>
                            setDraft((d) => ({
                              ...d,
                              k: Math.max(
                                1,
                                Math.min(
                                  Number(e.target.value) || 1,
                                  activeGates.length || 1,
                                ),
                              ),
                            }))
                          }
                        />
                        <span className="k-total">/ {activeGates.length}</span>
                      </>
                    )}
                    <ChevronDown size={13} className="select-chevron" />
                  </div>
                  <div className="stem branch-stem" aria-hidden="true" />
                  <div className="branch-rail">
                    {truthOrder.map((truth) => (
                      <div className="branch-slot" key={truth}>
                        <div className="branch-feed" aria-hidden="true" />
                        <button
                          className={`branch-card branch-${truth.toLowerCase()} ${currentRun?.truth === truth ? "is-active" : ""} ${inspector === "branch" && selectedBranch === truth ? "is-selected" : ""}`}
                          onClick={() => {
                            setSelectedBranch(truth);
                            showInspector("branch");
                          }}
                          aria-pressed={
                            inspector === "branch" && selectedBranch === truth
                          }
                        >
                          <span className="branch-top">
                            <span className="truth-dot" />
                            {truth}
                            <span className="branch-arrow">
                              {currentRun?.truth === truth ? (
                                <Check size={13} />
                              ) : (
                                <ArrowUpRight size={11} />
                              )}
                            </span>
                          </span>
                          <strong>{draft.branches[truth].title}</strong>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="circuit-footer">
                  <ShieldCheck size={13} />
                  <span>不知道，不等於否定。UNKNOWN 會保留不確定性。</span>
                </div>
              </section>

              <section className="run-console panel" aria-label="執行設定">
                <div className="run-config">
                  <div className="run-config-title">
                    <span className="section-index">03</span>
                    <h2>選擇判斷來源</h2>
                  </div>
                  <div
                    className="mode-control"
                    role="group"
                    aria-label="判斷來源"
                  >
                    {(["fixture", "localjev", "typesafe"] as Mode[]).map(
                      (value) => (
                        <button
                          key={value}
                          className={mode === value ? "active" : ""}
                          onClick={() => setMode(value)}
                          aria-pressed={mode === value}
                          disabled={running}
                        >
                          {value === "fixture" ? (
                            <FlaskConical size={13} />
                          ) : (
                            <span
                              className={`mode-dot ${(value === "localjev" ? health?.localjev.available : health?.typesafe.configured) ? "online" : ""}`}
                            />
                          )}
                          {modeNames[value]}
                        </button>
                      ),
                    )}
                  </div>
                </div>
                <p className="mode-explanation">
                  {mode === "fixture"
                    ? "使用預設分數展示電路。修改文字不會改變分數；請點選語意閘調整測試分數。"
                    : mode === "localjev"
                      ? `將目前任務與證據送至本機 LocalJev${health?.localjev.upstreamModel ? `（${health.localjev.upstreamModel}）` : ""}，取得實際判斷。`
                      : "將目前任務與證據送至已設定的 TypeSafe JEV 服務，可能產生 API 費用。"}
                </p>
                {!available && (
                  <p className="inline-warning">
                    <CircleHelp size={14} />
                    {mode === "localjev"
                      ? "LocalJev 尚未連線。可先使用固定測試，或啟動服務後重新檢查連線。"
                      : "TypeSafe 尚未設定金鑰。請在服務端設定後重新檢查連線。"}
                  </p>
                )}
                {invalidPolicy && (
                  <p className="inline-warning">
                    <CircleHelp size={14} />
                    「不成立」上限必須小於「成立」下限。
                  </p>
                )}
                {activeGates.length === 0 && (
                  <p className="inline-warning">
                    <CircleHelp size={14} />
                    至少啟用一個語意判斷。
                  </p>
                )}
                <div className="run-bottom">
                  <span className="run-footnote">
                    <span className="quiet-dot" />
                    {activeGates.length} 個判斷 · 不會執行外部動作
                  </span>
                  <button
                    className="primary-button run-button"
                    onClick={execute}
                    disabled={
                      running ||
                      !available ||
                      invalidPolicy ||
                      activeGates.length === 0 ||
                      !draft.task.trim()
                    }
                  >
                    {running ? (
                      <LoaderCircle size={16} className="spin" />
                    ) : (
                      <Play size={15} fill="currentColor" />
                    )}
                    {running ? "正在判斷" : run ? "重新執行判斷" : "執行判斷"}
                    {!running && <ArrowRight size={16} />}
                  </button>
                </div>
              </section>
              <p className="workspace-disclaimer">
                <FlaskConical size={13} />
                本工作台使用合成情境；測試分數與門檻尚未校準，不代表真實 JEV
                準確率或 AGI 能力。
              </p>
            </div>

            <aside
              ref={inspectorRef}
              className="inspector-column"
              aria-label="結果與節點設定"
            >
              <div className="inspector-panel panel">
                <div
                  className="inspector-tabs"
                  ref={tabListRef}
                  onKeyDown={moveInspectorTab}
                  role="tablist"
                  aria-label="檢視內容"
                >
                  <button
                    role="tab"
                    id="result-tab"
                    tabIndex={inspector === "result" ? 0 : -1}
                    aria-controls="result-panel"
                    aria-selected={inspector === "result"}
                    onClick={() => setInspector("result")}
                  >
                    判斷結果
                  </button>
                  <button
                    role="tab"
                    id="gate-tab"
                    tabIndex={inspector === "gate" ? 0 : -1}
                    aria-controls="gate-panel"
                    aria-selected={inspector === "gate"}
                    onClick={() => setInspector("gate")}
                  >
                    語意閘
                  </button>
                  <button
                    role="tab"
                    id="branch-tab"
                    tabIndex={inspector === "branch" ? 0 : -1}
                    aria-controls="branch-panel"
                    aria-selected={inspector === "branch"}
                    onClick={() => setInspector("branch")}
                  >
                    分流
                  </button>
                </div>

                {inspector === "result" && (
                  <div
                    id="result-panel"
                    role="tabpanel"
                    aria-labelledby="result-tab"
                    className="inspector-content result-content"
                  >
                    <div aria-live="polite">
                      {running ? (
                        <div className="result-empty running-state">
                          <div className="empty-illustration">
                            <LoaderCircle
                              size={31}
                              className="spin"
                              strokeWidth={1.2}
                            />
                          </div>
                          <h3>正在逐一確認條件</h3>
                          <p>
                            本次選用 {modeNames[mode]}。<br />
                            結果會保留每個判斷與原因。
                          </p>
                          <div className="loading-line">
                            <span />
                          </div>
                        </div>
                      ) : !run ? (
                        <div className="result-empty">
                          <div
                            className="empty-illustration"
                            aria-hidden="true"
                          >
                            <span className="empty-node n1" />
                            <span className="empty-node n2" />
                            <span className="empty-node n3" />
                            <GitBranch size={35} strokeWidth={1.1} />
                          </div>
                          <span className="tiny-label">
                            A DECISION, MADE VISIBLE
                          </span>
                          <h3>
                            答案之前，
                            <br />
                            先看見判斷。
                          </h3>
                          <p>
                            編輯左側情境並執行，
                            <br />
                            看看證據如何走向不同的分支。
                          </p>
                          <div className="empty-steps">
                            <span>情境</span>
                            <ArrowRight size={12} />
                            <span>語意閘</span>
                            <ArrowRight size={12} />
                            <span>決策</span>
                          </div>
                        </div>
                      ) : (
                        <>
                          {stale && (
                            <div className="stale-notice">
                              <RefreshCw size={15} />
                              <div>
                                <strong>輸入已變更</strong>
                                <span>
                                  下方為上一次結果，重新執行後才會更新。
                                </span>
                              </div>
                            </div>
                          )}
                          <div
                            className={`result-hero result-${run.truth.toLowerCase()} ${stale ? "is-stale" : ""}`}
                          >
                            <div className="result-hero-heading">
                              <span className="tiny-label">
                                {stale ? "上一次判斷" : "本次判斷"}
                              </span>
                              <span className="result-orbit">
                                <GitBranch size={18} />
                              </span>
                            </div>
                            <TruthBadge truth={run.truth} />
                            <h3>{run.branch.title}</h3>
                            <p>{run.branch.instruction}</p>
                          </div>
                          <div className="result-provenance">
                            <span>
                              <FlaskConical size={12} />
                              {modeNames[run.mode]}
                            </span>
                            <span>
                              <Clock3 size={12} />
                              {run.elapsedMs < 1000
                                ? `${Math.round(run.elapsedMs)} ms`
                                : `${(run.elapsedMs / 1000).toFixed(1)} 秒`}
                            </span>
                          </div>
                          <div className="result-section">
                            <div className="result-section-title">
                              <h3>判斷依據</h3>
                              <span>
                                {
                                  run.draft.gates.filter((g) => g.enabled)
                                    .length
                                }{" "}
                                個條件
                              </span>
                            </div>
                            <div className="gate-results">
                              {run.draft.gates
                                .filter((g) => g.enabled)
                                .map((gate, index) => {
                                  const signal = run.result.signals[gate.id];
                                  return (
                                    <button
                                      className="gate-result-row"
                                      key={gate.id}
                                      onClick={() => {
                                        setSelectedGateId(gate.id);
                                        showInspector("gate");
                                      }}
                                      disabled={
                                        !draft.gates.some(
                                          (g) => g.id === gate.id,
                                        )
                                      }
                                    >
                                      <span
                                        className={`result-symbol ${signal ? signal.truth.toLowerCase() : ""}`}
                                      >
                                        {signal?.truth === "TRUE" ? (
                                          <Check size={12} />
                                        ) : signal?.truth === "FALSE" ? (
                                          <X size={12} />
                                        ) : (
                                          <Minus size={12} />
                                        )}
                                      </span>
                                      <span>
                                        <strong>{gate.title}</strong>
                                        <small>
                                          G{String(index + 1).padStart(2, "0")}{" "}
                                          ·{" "}
                                          {signal
                                            ? truthNames[signal.truth]
                                            : "未取得訊號"}
                                        </small>
                                      </span>
                                      <span className="score-value">
                                        {signal?.answer?.noul === undefined
                                          ? "—"
                                          : signal.answer.noul.toFixed(2)}
                                      </span>
                                      <ChevronRight size={13} />
                                    </button>
                                  );
                                })}
                            </div>
                            <p className="score-note">
                              數值為單一判斷的原始分數，不是整體成功率。
                            </p>
                          </div>
                          <div className="result-section">
                            <div className="result-section-title">
                              <h3>結果摘要</h3>
                              <button
                                className="icon-button"
                                aria-label="複製結果摘要"
                                onClick={copySummary}
                              >
                                {copied ? (
                                  <Check size={13} />
                                ) : (
                                  <Copy size={13} />
                                )}
                              </button>
                            </div>
                            <p className="template-text">{run.template}</p>
                            <div className="template-label">
                              <ShieldCheck size={11} />
                              依實際結果產生的固定摘要
                            </div>
                          </div>
                          <div className="narration-section">
                            <div className="result-section-title">
                              <h3>
                                <Sparkles size={14} />
                                讓模型解讀結果
                              </h3>
                              <span
                                className={`availability-dot ${health?.llm.available ? "online" : ""}`}
                              />
                            </div>
                            <p>
                              另行呼叫本機語言模型，解讀已有的判斷；不改動電路結果。
                            </p>
                            {health?.llm.available ? (
                              <>
                                <div className="narration-options">
                                  <label
                                    className="sr-only"
                                    htmlFor="narration-tone"
                                  >
                                    解說長度
                                  </label>
                                  <select
                                    id="narration-tone"
                                    value={tone}
                                    onChange={(e) =>
                                      setTone(
                                        e.target.value as "brief" | "analysis",
                                      )
                                    }
                                  >
                                    <option value="brief">精簡解說</option>
                                    <option value="analysis">深入分析</option>
                                  </select>
                                  {health.llm.models.length > 1 && (
                                    <>
                                      <label
                                        className="sr-only"
                                        htmlFor="llm-model"
                                      >
                                        解說模型
                                      </label>
                                      <select
                                        id="llm-model"
                                        value={llmModel}
                                        onChange={(e) =>
                                          setLlmModel(e.target.value)
                                        }
                                      >
                                        {health.llm.models.map((model) => (
                                          <option key={model} value={model}>
                                            {model}
                                          </option>
                                        ))}
                                      </select>
                                    </>
                                  )}
                                </div>
                                <button
                                  className="secondary-button narrate-button"
                                  onClick={explain}
                                  disabled={stale || narrating || running}
                                >
                                  {narrating ? (
                                    <LoaderCircle size={14} className="spin" />
                                  ) : (
                                    <Sparkles size={14} />
                                  )}
                                  {narrating ? "模型正在解讀" : "產生模型解說"}
                                </button>
                              </>
                            ) : (
                              <div className="unavailable-note">
                                本機語言模型尚未連線
                              </div>
                            )}
                            {narration && narration.runId === run.id && (
                              <div
                                className={`narration-output ${stale ? "is-stale" : ""}`}
                              >
                                <p>{narration.text}</p>
                                <small>
                                  {narration.model} ·{" "}
                                  {(narration.elapsedMs / 1000).toFixed(1)} 秒
                                  {stale ? " · 對應上一次結果" : ""}
                                </small>
                              </div>
                            )}
                          </div>
                          <details className="run-details">
                            <summary>
                              版本與來源
                              <ChevronDown size={13} />
                            </summary>
                            <dl>
                              <dt>提供者</dt>
                              <dd>{run.provenance.provider}</dd>
                              <dt>模型</dt>
                              <dd>{run.provenance.model}</dd>
                              {run.provenance.upstreamModel && (
                                <>
                                  <dt>上游模型</dt>
                                  <dd>{run.provenance.upstreamModel}</dd>
                                </>
                              )}
                              <dt>資料</dt>
                              <dd>合成情境 · 未校準</dd>
                              <dt>執行 ID</dt>
                              <dd className="mono">{run.id}</dd>
                              <dt>摘要雜湊</dt>
                              <dd className="mono">{run.digest}</dd>
                            </dl>
                          </details>
                        </>
                      )}
                    </div>
                    <div className="result-actions">
                      <button
                        className="secondary-button"
                        onClick={exportRun}
                        disabled={!run || running}
                      >
                        <Download size={14} />
                        匯出紀錄
                      </button>
                      <button
                        className="secondary-button"
                        onClick={() =>
                          run && verifyReplay(run, run.draft.title)
                        }
                        disabled={!run || replaying || running}
                      >
                        {replaying ? (
                          <LoaderCircle size={14} className="spin" />
                        ) : (
                          <RotateCcw size={14} />
                        )}
                        離線重播
                      </button>
                    </div>
                    <button
                      className="import-button"
                      onClick={() => importRef.current?.click()}
                      disabled={replaying || running}
                    >
                      <Upload size={12} />
                      匯入 JSON 並驗證
                    </button>
                    <input
                      ref={importRef}
                      className="sr-only"
                      tabIndex={-1}
                      type="file"
                      accept="application/json,.json"
                      onChange={importRun}
                      aria-label="匯入執行紀錄"
                    />
                    {replay && (
                      <div
                        className={`replay-result ${replay.result.valid ? "valid" : "invalid"}`}
                        role="status"
                      >
                        <strong>
                          {replay.result.valid ? (
                            <CheckCircle2 size={15} />
                          ) : (
                            <CircleHelp size={15} />
                          )}
                          {replay.result.valid
                            ? "離線驗證通過"
                            : "紀錄驗證未通過"}
                        </strong>
                        <span>{replay.label}</span>
                        <ul>
                          {replay.result.checks.map((check, index) => (
                            <li key={index}>{check}</li>
                          ))}
                        </ul>
                        <small>
                          重算已記錄的回答，不重新呼叫模型或執行工具。
                        </small>
                      </div>
                    )}
                  </div>
                )}

                {inspector === "gate" && selectedGate && (
                  <div
                    id="gate-panel"
                    role="tabpanel"
                    aria-labelledby="gate-tab"
                    className="inspector-content gate-inspector"
                  >
                    <div className="inspector-eyebrow">
                      <span className="node-id">{selectedGate.id}</span>
                      <Settings2 size={15} />
                    </div>
                    <h3 className="inspector-title">一個清楚的小問題</h3>
                    <p className="inspector-description">
                      定義要判斷的條件，再決定哪些回答足夠明確。
                    </p>
                    <label className="toggle-row">
                      <span>啟用這個判斷</span>
                      <input
                        className="switch-input"
                        type="checkbox"
                        checked={selectedGate.enabled}
                        onChange={(e) => {
                          const enabled = e.target.checked;
                          setDraft((d) => {
                            const gates = d.gates.map((g) =>
                              g.id === selectedGate.id ? { ...g, enabled } : g,
                            );
                            return {
                              ...d,
                              gates,
                              k: Math.min(
                                d.k,
                                Math.max(
                                  1,
                                  gates.filter((g) => g.enabled).length,
                                ),
                              ),
                            };
                          });
                        }}
                      />
                      <span className="switch-track" aria-hidden="true" />
                    </label>
                    <div className="form-field">
                      <label htmlFor="gate-title">判斷名稱</label>
                      <input
                        id="gate-title"
                        value={selectedGate.title}
                        onChange={(e) =>
                          patchGate(selectedGate.id, { title: e.target.value })
                        }
                        maxLength={160}
                      />
                    </div>
                    <div className="form-field">
                      <label htmlFor="gate-question">交給模型的問題</label>
                      <textarea
                        id="gate-question"
                        value={selectedGate.question}
                        onChange={(e) =>
                          patchGate(selectedGate.id, {
                            question: e.target.value,
                          })
                        }
                        rows={4}
                        maxLength={1200}
                      />
                      <span className="field-hint">
                        一次只問一件事，依提供的任務與證據回答。
                      </span>
                    </div>
                    <div className="threshold-section">
                      <div className="result-section-title">
                        <h3>三值判斷門檻</h3>
                        <span>0 — 1</span>
                      </div>
                      <div className="threshold-track" aria-hidden="true">
                        <span
                          className="threshold-false"
                          style={{ width: `${selectedGate.falseAt * 100}%` }}
                        />
                        <span
                          className="threshold-unknown"
                          style={{
                            width: `${Math.max(0, selectedGate.trueAt - selectedGate.falseAt) * 100}%`,
                          }}
                        />
                        <span
                          className="threshold-true"
                          style={{
                            width: `${(1 - selectedGate.trueAt) * 100}%`,
                          }}
                        />
                      </div>
                      <div className="threshold-scale">
                        <span>FALSE</span>
                        <span>UNKNOWN</span>
                        <span>TRUE</span>
                      </div>
                      <div className="threshold-inputs">
                        <label htmlFor="false-at">
                          不成立上限
                          <input
                            id="false-at"
                            type="number"
                            min={0}
                            max={0.99}
                            step={0.05}
                            value={selectedGate.falseAt}
                            onChange={(e) =>
                              patchGate(selectedGate.id, {
                                falseAt: Math.min(
                                  0.99,
                                  Math.max(0, Number(e.target.value)),
                                ),
                              })
                            }
                          />
                        </label>
                        <label htmlFor="true-at">
                          成立下限
                          <input
                            id="true-at"
                            type="number"
                            min={0.01}
                            max={1}
                            step={0.05}
                            value={selectedGate.trueAt}
                            onChange={(e) =>
                              patchGate(selectedGate.id, {
                                trueAt: Math.min(
                                  1,
                                  Math.max(0.01, Number(e.target.value)),
                                ),
                              })
                            }
                          />
                        </label>
                      </div>
                      {selectedGate.falseAt >= selectedGate.trueAt ? (
                        <p className="field-error" role="alert">
                          不成立上限必須小於成立下限。
                        </p>
                      ) : (
                        <p className="field-hint">
                          介於 {selectedGate.falseAt.toFixed(2)} 與{" "}
                          {selectedGate.trueAt.toFixed(2)} 之間時，保留
                          UNKNOWN。
                        </p>
                      )}
                    </div>
                    <div className="fixture-control">
                      <div className="result-section-title">
                        <h3>
                          <FlaskConical size={14} />
                          固定測試分數
                        </h3>
                        <output htmlFor="fixture-score">
                          {selectedGate.fixture.toFixed(2)}
                        </output>
                      </div>
                      <input
                        id="fixture-score"
                        aria-label="固定測試分數"
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={selectedGate.fixture}
                        onChange={(e) =>
                          patchGate(selectedGate.id, {
                            fixture: Number(e.target.value),
                          })
                        }
                      />
                      <div className="range-labels">
                        <span>0.00</span>
                        <span>1.00</span>
                      </div>
                      <p>僅在「固定測試」使用。文字編輯不會改變此分數。</p>
                    </div>
                    {currentRun?.result.signals[selectedGate.id] && (
                      <div className="node-evidence">
                        <span className="tiny-label">本次節點結果</span>
                        <TruthBadge
                          truth={
                            currentRun.result.signals[selectedGate.id].truth
                          }
                        />
                        <p>
                          {describeReason(
                            currentRun.result.signals[selectedGate.id].reason,
                          )}
                        </p>
                        <code>
                          {currentRun.result.signals[selectedGate.id].reason}
                        </code>
                        <div className="source-chips">
                          {draft.evidence.map((e) => (
                            <span key={e.id}>
                              {e.id} · {e.title}
                            </span>
                          ))}
                        </div>
                        <small>
                          以上為提供给此節點的輸入，不代表每份證據都支持結論。
                        </small>
                      </div>
                    )}
                    <button
                      className="delete-gate"
                      onClick={() => deleteGate(selectedGate.id)}
                      disabled={draft.gates.length <= 1}
                    >
                      <X size={13} />
                      刪除這個判斷
                    </button>
                  </div>
                )}

                {inspector === "branch" && (
                  <div
                    id="branch-panel"
                    role="tabpanel"
                    aria-labelledby="branch-tab"
                    className="inspector-content branch-inspector"
                  >
                    <div className="inspector-eyebrow">
                      <span className="tiny-label">決策之後，往哪裡走</span>
                      <GitBranch size={15} />
                    </div>
                    <h3 className="inspector-title">為每種結果留一條路</h3>
                    <p className="inspector-description">
                      設定顯示給使用者的回應與下一步。這些文字不會自動執行外部動作。
                    </p>
                    <div
                      className="branch-selector"
                      role="group"
                      aria-label="要編輯的分流"
                    >
                      {truthOrder.map((truth) => (
                        <button
                          key={truth}
                          className={`branch-selector-${truth.toLowerCase()} ${selectedBranch === truth ? "active" : ""}`}
                          onClick={() => setSelectedBranch(truth)}
                          aria-pressed={selectedBranch === truth}
                        >
                          {truth}
                        </button>
                      ))}
                    </div>
                    <TruthBadge truth={selectedBranch} />
                    <div className="form-field">
                      <label htmlFor="branch-title">分流標題</label>
                      <input
                        id="branch-title"
                        value={draft.branches[selectedBranch].title}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            branches: {
                              ...d.branches,
                              [selectedBranch]: {
                                ...d.branches[selectedBranch],
                                title: e.target.value,
                              },
                            },
                          }))
                        }
                        maxLength={160}
                      />
                    </div>
                    <div className="form-field">
                      <label htmlFor="branch-instruction">
                        建議回應與下一步
                      </label>
                      <textarea
                        id="branch-instruction"
                        rows={6}
                        value={draft.branches[selectedBranch].instruction}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            branches: {
                              ...d.branches,
                              [selectedBranch]: {
                                ...d.branches[selectedBranch],
                                instruction: e.target.value,
                              },
                            },
                          }))
                        }
                        maxLength={2000}
                      />
                    </div>
                    <div className="branch-guidance">
                      <CircleHelp size={17} />
                      <p>
                        {selectedBranch === "TRUE"
                          ? "條件成立只代表符合目前政策。真實動作仍需要工具執行及結果驗證。"
                          : selectedBranch === "FALSE"
                            ? "條件不成立時，可設定替代方案或說明原因。這不等於整個任務失敗。"
                            : "保留未知，讓使用者知道缺少什麼資訊、可以補上哪些證據，再做一次判斷。"}
                      </p>
                    </div>
                  </div>
                )}
              </div>
              <div className="inspector-bottom-note">
                <span className="note-diamond" />
                小判斷可以組合，證據不能省略。
              </div>
            </aside>
          </div>
          <footer className="workspace-footer">
            <span>JEV SEMANTIC STUDIO</span>
            <span>可檢查 · 可調整 · 可重播</span>
            <span>Independent research project</span>
          </footer>
        </div>
      </main>
    </div>
  );
}
