import { useEffect, useState, useRef, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import type { ClaimCase, Document, Run, Report, Ref } from "./types";
import "./style.css";
import {
  ShieldCheck,
  LayoutDashboard,
  Files,
  FileCheck2,
  ClipboardCheck,
  ArrowUpRight,
  ArrowRight,
  Plus,
  Upload,
  Play,
  Sparkles,
  Settings2,
  LockKeyhole,
  ChevronRight,
  Search,
  Download,
  Trash2,
  RotateCcw,
  Radio,
  Check,
  FolderOpen,
  X,
  LoaderCircle,
} from "lucide-react";
import { Badge, Modal, human, date } from "./ui";

type Connection = {
  connected: boolean;
  storage_available: boolean;
  email?: string | null;
  message?: string;
  model?: string;
  model_available?: boolean;
};
const EvidenceGrid = lazy(() => import("./EvidenceGrid"));
const base = "http://127.0.0.1:8000";
function App() {
  const [dialog, setDialog] = useState<"case" | "upload" | "settings" | null>(
    null,
  );
  const [tab, setTab] = useState("evidence");
  const [query, setQuery] = useState("");
  const selection = useRef(0);
  const [token, setToken] = useState("");
  const [connected, setConnected] = useState(false);
  const [cases, setCases] = useState<ClaimCase[]>([]);
  const [selected, setSelected] = useState<ClaimCase | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [view, setView] = useState("workspace");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ ref: Ref; text: string } | null>(
    null,
  );
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [chatgpt, setChatgpt] = useState<Connection | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const signInStarted = useRef(0);
  const signInWindow = useRef<Window | null>(null);

  async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(base + path, {
      ...options,
      headers: { Authorization: "Bearer " + token, ...(options.headers || {}) },
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(
        typeof result.detail === "string"
          ? result.detail
          : "Request failed (" + response.status + ")",
      );
    }
    return response.json() as Promise<T>;
  }
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unexpected error");
    } finally {
      setBusy(false);
    }
  }
  const [liveStatus, setLiveStatus] = useState("");
  useEffect(() => {
    if (!connected || !selected) return;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 1000;
    async function listen() {
      try {
        setLiveStatus("Connecting to live analysis updates…");
        const response = await fetch(
          base + "/cases/" + selected!.id + "/analysis-events",
          {
            headers: { Authorization: "Bearer " + token },
            signal: controller.signal,
          },
        );
        if (!response.ok || !response.body)
          throw new Error("Live updates unavailable");
        setLiveStatus("Live analysis updates connected");
        delay = 1000;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) throw new Error("Live connection ended");
            buffer += decoder.decode(value, { stream: true });
            let boundary: number;
            while ((boundary = buffer.indexOf("\n\n")) >= 0) {
              const event = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              if (!event.startsWith("data: ")) continue;
              const current = JSON.parse(event.slice(6)) as Run[];
              if (controller.signal.aborted) return;
              setRuns(current);
              setRun((previous) =>
                previous
                  ? current.find((item) => item.id === previous.id) || null
                  : null,
              );
            }
          }
        } finally {
          reader.releaseLock();
        }
      } catch {
        if (controller.signal.aborted) return;
        setLiveStatus("Live connection interrupted. Reconnecting…");
        retry = setTimeout(() => void listen(), delay);
        delay = Math.min(delay * 2, 30000);
      }
    }
    void listen();
    return () => {
      controller.abort();
      if (retry) clearTimeout(retry);
    };
  }, [connected, selected?.id, token]);

  async function refreshConnection() {
    const status = await api<Connection>("/auth/chatgpt/status");
    if (status.connected) {
      try {
        const catalog = await api<{ selected_model_available: boolean }>(
          "/auth/chatgpt/models",
        );
        status.model_available = catalog.selected_model_available;
        status.message = catalog.selected_model_available
          ? "ChatGPT connected. Luna is available for analysis."
          : "Your connected account does not currently list gpt-6-luna. Analysis is paused; no other model will be used.";
      } catch (e) {
        status.model_available = false;
        status.message =
          e instanceof Error ? e.message : "Model catalog unavailable";
      }
    }
    setChatgpt(status);
    return status;
  }
  useEffect(() => {
    if (!connected) {
      setChatgpt(null);
      setSigningIn(false);
      return;
    }
    let cancelled = false;
    void api<Connection>("/auth/chatgpt/status")
      .then((status) => {
        if (!cancelled) {
          setChatgpt(status);
          if (status.connected)
            void refreshConnection().catch((e) => setError(String(e)));
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [connected, token]);
  useEffect(() => {
    if (!signingIn || !connected) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      if (
        Date.now() - signInStarted.current > 600000 ||
        signInWindow.current?.closed
      ) {
        setSigningIn(false);
        void refreshConnection().catch((e) => setError(String(e)));
        return;
      }
      void api<Connection>("/auth/chatgpt/status")
        .then(async (status) => {
          if (cancelled) return;
          if (status.connected) {
            setSigningIn(false);
            await refreshConnection();
          }
        })
        .catch((e) => {
          if (!cancelled) {
            setError(String(e));
            setSigningIn(false);
          }
        });
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [signingIn, connected, token]);
  function connectChatGPT() {
    const popup = window.open(
      "",
      "claim-chatgpt-signin",
      "width=650,height=780",
    );
    if (!popup) {
      setError(
        "Allow the sign-in popup, then click Continue with ChatGPT again.",
      );
      return;
    }
    signInWindow.current = popup;
    void act(async () => {
      try {
        const response = await api<{ sign_in_url: string }>(
          "/auth/chatgpt/start",
          { method: "POST" },
        );
        popup.location.href = response.sign_in_url;
        signInStarted.current = Date.now();
        setSigningIn(true);
      } catch (e) {
        popup.close();
        throw e;
      }
    });
  }

  async function choose(item: ClaimCase) {
    const revision = ++selection.current;
    setSelected(item);
    setRun(null);
    setRuns([]);
    setDocuments([]);
    setReport(null);
    setPreview(null);
    setQuery("");
    setView("workspace");
    const docs = await api<Document[]>("/cases/" + item.id + "/documents");
    if (revision === selection.current) setDocuments(docs);
  }
  async function openReport(item: Run) {
    if (!item.report_id) return;
    setReport(await api<Report>("/reports/" + item.report_id));
    setPreview(null);
    setView("report");
  }
  async function saveRun(item: Run) {
    setRun(item);
    setRuns((previous) =>
      [item, ...previous.filter((r) => r.id !== item.id)].sort((a, b) =>
        b.created_at.localeCompare(a.created_at),
      ),
    );
  }
  async function removeRun(item: Run) {
    if (
      !window.confirm(
        "Delete this analysis, its report and review history? Uploaded documents will remain.",
      )
    )
      return;
    await api("/analyses/" + item.id, { method: "DELETE" });
    setRuns((previous) => previous.filter((r) => r.id !== item.id));
    if (run?.id === item.id) setRun(null);
    if (report?.run_id === item.id) {
      setReport(null);
      setPreview(null);
    }
    setNotice("Analysis deleted. Uploaded documents were kept.");
  }
  async function inspect(ref: Ref) {
    if (!report) return;
    const page = await api<{ text: string }>(
      "/cases/" +
        report.case_id +
        "/documents/" +
        ref.document_id +
        "/pages/" +
        ref.page,
    );
    setPreview({ ref, text: page.text });
  }
  async function original(ref: Ref) {
    if (!report) return;
    const response = await fetch(
      base +
        "/cases/" +
        report.case_id +
        "/documents/" +
        ref.document_id +
        "/original",
      { headers: { Authorization: "Bearer " + token } },
    );
    if (!response.ok) throw new Error("Original document unavailable");
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = "source-" + ref.document_id;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function download() {
    if (!report) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "claim-package-v" + report.version + ".json";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const active = runs.some((item) =>
    ["queued", "running"].includes(item.status),
  );
  const ready = !!chatgpt?.connected && !!chatgpt.model_available;
  const hasLetter = documents.some((d) => d.kind === "insurer_communication");
  const reports = runs.filter((r) => r.report_id);
  const lock = () => {
    selection.current++;
    setConnected(false);
    setToken("");
    setSelected(null);
    setReport(null);
    setRun(null);
    setRuns([]);
    setDocuments([]);
    setPreview(null);
    setDialog(null);
  };
  const start = () =>
    void act(async () => {
      await saveRun(
        await api<Run>("/cases/" + selected!.id + "/analyses", {
          method: "POST",
        }),
      );
      setTab("analyses");
      setView("workspace");
    });
  const alerts = (
    <>
      {error && (
        <div role="alert" className="alert">
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {notice && (
        <div role="status" className="notice">
          <Check size={16} />
          <span>{notice}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </>
  );
  const runList = (
    <div className="run-list">
      {runs.length ? (
        runs.map((item, i) => (
          <article className="run-row" key={item.id}>
            <div className="run-icon">
              <FileCheck2 size={20} />
            </div>
            <div className="min-w-0 flex-1">
              <h3>
                Analysis {runs.length - i} <Badge value={item.status} />
              </h3>
              <p>{date(item.created_at)}</p>
              {item.error && <p className="run-error">{item.error}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              {item.report_id && (
                <button
                  className="button small"
                  disabled={busy}
                  onClick={() => void act(() => openReport(item))}
                >
                  View report <ArrowUpRight size={15} />
                </button>
              )}
              {item.status === "paused" && (
                <button
                  className="button secondary small"
                  disabled={busy || !ready}
                  onClick={() =>
                    void act(async () => {
                      await saveRun(
                        await api<Run>("/analyses/" + item.id + "/resume", {
                          method: "POST",
                        }),
                      );
                    })
                  }
                >
                  <RotateCcw size={14} />
                  Resume
                </button>
              )}
              <button
                className="icon-button danger"
                aria-label={"Delete analysis " + (runs.length - i)}
                disabled={busy || ["queued", "running"].includes(item.status)}
                onClick={() => void act(() => removeRun(item))}
              >
                <Trash2 size={16} />
              </button>
            </div>
          </article>
        ))
      ) : (
        <div className="empty">
          <Sparkles />
          <h3>Your first insight starts here</h3>
          <p>
            Add the insurer communication, then run an analysis to connect each
            request to its evidence.
          </p>
        </div>
      )}
    </div>
  );
  if (!connected)
    return (
      <div className="login-shell">
        <section className="login-story">
          <div className="brand">
            <span className="brand-mark">
              <ShieldCheck size={25} />
            </span>
            claimwise<span className="brand-dot">.</span>
          </div>
          <div>
            <div className="eyebrow">CLARITY AT EVERY STEP</div>
            <h1>
              Every document.
              <br />A clearer picture.
            </h1>
            <p>
              Bring your claim evidence together. Understand what's supported,
              what's missing, and what comes next.
            </p>
            <div className="story-steps">
              {[
                "Organize your evidence",
                "Connect the details",
                "Move forward with confidence",
              ].map((s, i) => (
                <div key={s}>
                  <span>0{i + 1}</span>
                  {s}
                </div>
              ))}
            </div>
          </div>
          <span className="text-sm opacity-60">
            Health claim evidence workspace
          </span>
        </section>
        <section className="login-form">
          <div className="w-full max-w-sm">
            <span className="login-icon">
              <LockKeyhole size={24} />
            </span>
            <p className="eyebrow mt-7">YOUR LOCAL WORKSPACE</p>
            <h2>Welcome back.</h2>
            <p className="mt-3 mb-8 text-muted">
              A little organization. A lot more clarity.
            </p>
            {alerts}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  const items = await api<ClaimCase[]>("/cases");
                  setCases(items);
                  setConnected(true);
                  if (items[0]) await choose(items[0]);
                });
              }}
            >
              <label>
                Workspace access token
                <input
                  type="password"
                  required
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  autoComplete="off"
                  placeholder="Enter your access token"
                />
              </label>
              <button className="button w-full mt-5" disabled={busy}>
                {busy ? (
                  <LoaderCircle className="animate-spin" size={17} />
                ) : (
                  <>
                    Open workspace
                    <ArrowRight size={17} />
                  </>
                )}
              </button>
            </form>
            <p className="login-help">
              Use the local or reviewer access token from your installation.
              Your token stays in memory for this session.
            </p>
          </div>
        </section>
      </div>
    );
  return (
    <div className="app-shell">
      <a href="#main" className="skip-link">
        Skip to workspace
      </a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <ShieldCheck size={24} />
          </span>
          claimwise<span className="brand-dot">.</span>
        </div>
        <div className="workspace-label">
          <span className="workspace-avatar">CW</span>
          <div>
            Personal workspace<small>Local installation</small>
          </div>
          <span className="online-dot" />
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav aria-label="Main navigation">
          {[
            { id: "workspace", label: "Case workspace", icon: LayoutDashboard },
            { id: "report", label: "Evidence reports", icon: FileCheck2 },
            { id: "review", label: "Review queue", icon: ClipboardCheck },
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={view === id ? "active" : ""}
              onClick={() => setView(id)}
            >
              <Icon size={18} />
              {label}
              {id === "report" && reports.length > 0 && (
                <span className="nav-count">{reports.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-cases">
          <div className="flex items-center justify-between">
            <p className="nav-label">
              YOUR CASES <span>{cases.length}</span>
            </p>
            <button
              className="icon-button"
              aria-label="Create case"
              onClick={() => setDialog("case")}
            >
              <Plus size={16} />
            </button>
          </div>
          {cases.map((c) => (
            <button
              key={c.id}
              className={
                "case-link " + (selected?.id === c.id ? "selected" : "")
              }
              disabled={busy}
              onClick={() => void act(() => choose(c))}
            >
              <span className="case-dot" />
              <span className="truncate">{c.title}</span>
            </button>
          ))}
          {!cases.length && (
            <p className="text-xs text-muted px-3">
              Your cases will appear here.
            </p>
          )}
        </div>
        <div className="sidebar-bottom">
          <button className="model-card" onClick={() => setDialog("settings")}>
            <span className="model-symbol">
              <Sparkles size={18} />
            </span>
            <span>
              Analysis engine
              <small>{ready ? "Luna · Connected" : "Connect ChatGPT"}</small>
            </span>
            <Settings2 size={15} />
          </button>
          <button className="lock-button" onClick={lock}>
            <LockKeyhole size={16} />
            Lock workspace
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="flex items-center gap-2 text-muted">
            <span>Workspace</span>
            <ChevronRight size={14} />
            <span className="text-ink">
              {view === "workspace"
                ? "Cases"
                : view === "report"
                  ? "Reports"
                  : "Review queue"}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <span className="local-pill">
              <span />
              Local workspace
            </span>
            <button
              className="avatar"
              aria-label="Connection settings"
              onClick={() => setDialog("settings")}
            >
              CW
            </button>
          </div>
        </header>
        <main id="main" className="content">
          {alerts}
          <div className="mobile-case-picker">
            <label>
              Current case
              <select
                value={selected?.id || ""}
                disabled={busy}
                onChange={(e) => {
                  const item = cases.find((c) => c.id === e.target.value);
                  if (item) void act(() => choose(item));
                }}
              >
                <option value="" disabled>
                  Select a case
                </option>
                {cases.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="page-heading">
            <div>
              <p className="eyebrow">
                {view === "workspace"
                  ? "YOUR CLAIM, CONNECTED"
                  : view === "report"
                    ? "FROM EVIDENCE TO UNDERSTANDING"
                    : "HUMAN JUDGMENT, DOCUMENTED"}
              </p>
              <h1>
                {view === "workspace"
                  ? "Case workspace"
                  : view === "report"
                    ? "Evidence reports"
                    : "Review queue"}
              </h1>
              <p>
                {view === "workspace"
                  ? "Everything you need to move your claim forward."
                  : view === "report"
                    ? "Trace every finding back to the original evidence."
                    : "Review the findings that need a closer look."}
              </p>
            </div>
            <button
              className="button secondary"
              onClick={() => setDialog("case")}
            >
              <Plus size={17} />
              New case
            </button>
          </div>
          {!selected ? (
            <section className="panel empty welcome">
              <FolderOpen size={40} />
              <h2>A clearer claim starts here.</h2>
              <p>
                Create a case to organize documents, run an evidence analysis,
                and build a response package.
              </p>
              <button className="button" onClick={() => setDialog("case")}>
                <Plus size={16} />
                Create your first case
              </button>
            </section>
          ) : (
            <>
              <section className="case-hero">
                <div className="hero-copy">
                  <span className="eyebrow">
                    ACTIVE CASE{" "}
                    <span className="hero-ref">{selected.claim_reference}</span>
                  </span>
                  <h2>{selected.title}</h2>
                  <p>One place for your documents, findings, and next steps.</p>
                  <div className="hero-actions">
                    <button
                      className="button light"
                      disabled={busy}
                      onClick={() => setDialog("upload")}
                    >
                      <Upload size={16} />
                      Add evidence
                    </button>
                    <button
                      className="button hero-button"
                      disabled={busy || !ready || !hasLetter || active}
                      onClick={start}
                    >
                      {active ? (
                        <LoaderCircle className="animate-spin" size={16} />
                      ) : (
                        <Sparkles size={16} />
                      )}{" "}
                      {active ? "Analysis in progress" : "Run analysis"}
                      <ArrowUpRight size={15} />
                    </button>
                  </div>
                </div>
                <div className="hero-art" aria-hidden="true">
                  <div className="orbit orbit-one" />
                  <div className="orbit orbit-two" />
                  <div className="art-document">
                    <span />
                    <span />
                    <span />
                    <div>
                      <ShieldCheck size={32} />
                    </div>
                  </div>
                  <div className="art-check">
                    <Check size={20} />
                  </div>
                </div>
              </section>
              <div className="stats-grid">
                <div className="stat">
                  <span className="stat-icon">
                    <Files size={19} />
                  </span>
                  <div>
                    <p>Evidence documents</p>
                    <strong>
                      {documents.length.toString().padStart(2, "0")}
                    </strong>
                  </div>
                  <span className="stat-caption">All versions</span>
                </div>
                <div className="stat">
                  <span className="stat-icon">
                    <Sparkles size={19} />
                  </span>
                  <div>
                    <p>Analyses</p>
                    <strong>{runs.length.toString().padStart(2, "0")}</strong>
                  </div>
                  <span className="stat-caption">
                    {active ? "Processing now" : "Saved history"}
                  </span>
                </div>
                <div className="stat">
                  <span className="stat-icon">
                    <FileCheck2 size={19} />
                  </span>
                  <div>
                    <p>Ready reports</p>
                    <strong>
                      {reports.length.toString().padStart(2, "0")}
                    </strong>
                  </div>
                  <button
                    className="icon-button"
                    aria-label="Browse reports"
                    onClick={() => {
                      setReport(null);
                      setView("report");
                    }}
                  >
                    <ArrowUpRight size={19} />
                  </button>
                </div>
              </div>
              {view === "workspace" ? (
                <div className="workspace-columns">
                  <section className="panel min-w-0">
                    <div
                      className="tabs"
                      role="tablist"
                      aria-label="Case content"
                    >
                      <button
                        role="tab"
                        aria-selected={tab === "evidence"}
                        onClick={() => setTab("evidence")}
                        className={tab === "evidence" ? "active" : ""}
                      >
                        <Files size={16} />
                        Evidence <span>{documents.length}</span>
                      </button>
                      <button
                        role="tab"
                        aria-selected={tab === "analyses"}
                        onClick={() => setTab("analyses")}
                        className={tab === "analyses" ? "active" : ""}
                      >
                        <Sparkles size={16} />
                        Analysis history <span>{runs.length}</span>
                      </button>
                    </div>
                    {tab === "evidence" ? (
                      <Suspense
                        fallback={
                          <div className="empty" role="status">
                            Loading evidence library…
                          </div>
                        }
                      >
                        <EvidenceGrid
                          documents={documents}
                          query={query}
                          setQuery={setQuery}
                        />
                      </Suspense>
                    ) : (
                      <>
                        <div className="grid-toolbar">
                          <div>
                            <h2>Analysis history</h2>
                            <p>Every run, with its report a click away.</p>
                          </div>
                          <span title={liveStatus} className="live-indicator">
                            <Radio size={14} />
                            {liveStatus.includes("connected")
                              ? "Live"
                              : "Connecting"}
                          </span>
                        </div>
                        {runList}
                      </>
                    )}
                  </section>
                  <aside className="insight-column">
                    <section className="panel next-step">
                      <span className="eyebrow">NEXT BEST STEP</span>
                      <span className="step-icon">
                        {active ? (
                          <LoaderCircle className="animate-spin" />
                        ) : !hasLetter ? (
                          <Upload />
                        ) : (
                          <Sparkles />
                        )}
                      </span>
                      <h2>
                        {active
                          ? "Connecting the evidence"
                          : !hasLetter
                            ? "Start with the request"
                            : !ready
                              ? "Connect your analysis engine"
                              : "Ready for a closer look"}
                      </h2>
                      <p>
                        {active
                          ? "You can keep exploring previous reports. This workspace updates as soon as the analysis finishes."
                          : !hasLetter
                            ? "Add the insurer communication so the analysis knows which questions your evidence needs to answer."
                            : !ready
                              ? "Sign in to ChatGPT on this computer to enable Luna for your claim analysis."
                              : "Luna will compare the insurer’s requests with your documents and highlight supported findings and gaps."}
                      </p>
                      <button
                        className="text-button"
                        disabled={busy || active}
                        onClick={() =>
                          !hasLetter
                            ? setDialog("upload")
                            : !ready
                              ? setDialog("settings")
                              : start()
                        }
                      >
                        {active
                          ? "Updates arrive automatically"
                          : !hasLetter
                            ? "Upload communication"
                            : !ready
                              ? "Connection settings"
                              : "Start analysis"}
                        {!active && <ArrowRight size={15} />}
                      </button>
                    </section>
                    <section className="trust-note">
                      <ShieldCheck size={19} />
                      <div>
                        <h3>Evidence you can trace</h3>
                        <p>
                          Findings link to source pages. Your original documents
                          and their versions stay available.
                        </p>
                      </div>
                    </section>
                    {reports[0] && (
                      <button
                        className="latest-report"
                        disabled={busy}
                        onClick={() => void act(() => openReport(reports[0]))}
                      >
                        <FileCheck2 size={22} />
                        <span>
                          Latest report
                          <small>{date(reports[0].created_at)}</small>
                        </span>
                        <ArrowUpRight size={18} />
                      </button>
                    )}
                  </aside>
                </div>
              ) : !report ? (
                <section className="panel">
                  <div className="grid-toolbar">
                    <div>
                      <h2>Saved reports</h2>
                      <p>
                        Open a completed analysis to explore its findings
                        {view === "review" ? " and review decisions" : ""}.
                      </p>
                    </div>
                    <FileCheck2 size={21} />
                  </div>
                  {reports.length ? (
                    <div className="report-library">
                      {reports.map((item, i) => (
                        <button
                          key={item.id}
                          className="report-tile"
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              await openReport(item);
                              setView(view);
                            })
                          }
                        >
                          <span className="file-icon">
                            <FileCheck2 size={24} />
                          </span>
                          <Badge value="completed" />
                          <h3>Evidence report {reports.length - i}</h3>
                          <p>{date(item.created_at)}</p>
                          <span className="text-button">
                            Open report
                            <ArrowUpRight size={16} />
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="empty">
                      <FileCheck2 />
                      <h3>No reports just yet</h3>
                      <p>
                        A completed analysis will appear here, ready to open.
                      </p>
                      <button
                        className="button secondary"
                        onClick={() => setView("workspace")}
                      >
                        Go to evidence
                        <ArrowRight size={16} />
                      </button>
                    </div>
                  )}
                </section>
              ) : (
                <div className="report-layout">
                  <section className="panel report-summary">
                    <div>
                      <p className="eyebrow">
                        RESPONSE PACKAGE · VERSION {report.version}
                      </p>
                      <h2>
                        {view === "review"
                          ? "Findings for review"
                          : "The evidence, explained."}
                      </h2>
                      <p>
                        {report.findings.length} findings ·{" "}
                        {
                          report.findings.filter((f) => f.review_required)
                            .length
                        }{" "}
                        need review · {report.model}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        className="button secondary"
                        onClick={() => {
                          setReport(null);
                          setPreview(null);
                        }}
                      >
                        All reports
                      </button>
                      <button className="button" onClick={download}>
                        <Download size={16} />
                        Export package
                      </button>
                    </div>
                  </section>
                  {view === "review" &&
                    !report.findings.some((f) => f.review_required) && (
                      <div className="panel empty">
                        <Check />
                        <h3>No findings require review</h3>
                        <p>This report has no flagged findings.</p>
                      </div>
                    )}
                  {report.findings
                    .filter((f) => view !== "review" || f.review_required)
                    .map((f, index) => (
                      <section className="panel finding" key={f.request_id}>
                        <div className="finding-heading">
                          <span className="finding-number">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <div className="flex-1">
                            <div className="flex flex-wrap gap-2 mb-3">
                              <Badge value={f.evidence_status} />
                              {f.review_required && (
                                <span className="review-label">
                                  Review required
                                </span>
                              )}
                            </div>
                            <h2>
                              {report.requests.find(
                                (r) => r.request_id === f.request_id,
                              )?.text || "Evidence finding"}
                            </h2>
                          </div>
                        </div>
                        <div className="finding-content">
                          <p className="explanation">{f.explanation}</p>
                          <div className="submission">
                            <span>Submission status</span>
                            <Badge value={f.submission_status} />
                          </div>
                          <div className="citations">
                            {[
                              ...f.evidence_refs,
                              ...f.policy_refs,
                              ...f.receipt_refs,
                            ].map((ref, i) => (
                              <button
                                className="source-button"
                                key={i}
                                disabled={busy}
                                onClick={() => void act(() => inspect(ref))}
                              >
                                <Files size={14} />
                                Source {i + 1}
                                <span>
                                  v{ref.version} · p. {ref.page}
                                </span>
                                <ArrowUpRight size={13} />
                              </button>
                            ))}
                          </div>
                          {f.unresolved_questions.length > 0 && (
                            <div className="unresolved">
                              <h3>Still to clarify</h3>
                              <ul>
                                {f.unresolved_questions.map((q, i) => (
                                  <li key={i}>{q}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          <div className="next-action">
                            <ArrowRight size={18} />
                            <div>
                              <h3>Recommended next action</h3>
                              <p>{f.next_action}</p>
                            </div>
                          </div>
                          {view === "review" && (
                            <form
                              className="review-form"
                              onSubmit={(e) => {
                                e.preventDefault();
                                const data = new FormData(e.currentTarget);
                                void act(async () => {
                                  await api(
                                    "/tasks/" +
                                      encodeURIComponent(
                                        report.run_id + ":" + f.request_id,
                                      ) +
                                      "/review",
                                    {
                                      method: "POST",
                                      headers: {
                                        "Content-Type": "application/json",
                                      },
                                      body: JSON.stringify({
                                        decision: data.get("decision"),
                                        rationale:
                                          reviewNotes[f.request_id] || "",
                                      }),
                                    },
                                  );
                                  setNotice(
                                    "Reviewer decision saved to the audit history.",
                                  );
                                });
                              }}
                            >
                              <label>
                                Review decision
                                <select name="decision">
                                  <option value="approved">
                                    Approve finding
                                  </option>
                                  <option value="request_evidence">
                                    Request evidence
                                  </option>
                                  <option value="override">
                                    Record override
                                  </option>
                                </select>
                              </label>
                              <label>
                                Rationale
                                <textarea
                                  required
                                  minLength={10}
                                  placeholder="Explain the evidence behind your decision…"
                                  value={reviewNotes[f.request_id] || ""}
                                  onChange={(e) =>
                                    setReviewNotes({
                                      ...reviewNotes,
                                      [f.request_id]: e.target.value,
                                    })
                                  }
                                />
                              </label>
                              <div className="flex flex-wrap items-center justify-between gap-3">
                                <small className="text-muted">
                                  Requires reviewer access. Decisions are
                                  recorded in the audit history.
                                </small>
                                <button className="button" disabled={busy}>
                                  <ClipboardCheck size={16} />
                                  Record review
                                </button>
                              </div>
                            </form>
                          )}
                        </div>
                      </section>
                    ))}
                  {view === "report" && (
                    <section className="panel response-draft">
                      <div className="flex items-center gap-3 mb-4">
                        <FileCheck2 size={20} />
                        <h2>Your response draft</h2>
                      </div>
                      <p className="text-muted mb-6">
                        Review and adapt this draft before sharing it with your
                        insurer.
                      </p>
                      <pre>{report.response_draft}</pre>
                    </section>
                  )}
                </div>
              )}
            </>
          )}
          <footer className="page-footer">
            <span>
              CLAIMWISE <span className="mx-2">/</span> A clearer path forward.
            </span>
            <span>Evidence guidance · Insurer decisions remain external</span>
          </footer>
        </main>
      </div>
      {dialog === "case" && (
        <Modal title="Start a new case" close={() => setDialog(null)}>
          <p className="text-muted mb-6">
            Give this claim a home. You can add the supporting documents next.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              void act(async () => {
                const item = await api<ClaimCase>("/cases", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    title: data.get("title"),
                    claim_reference: data.get("reference"),
                  }),
                });
                setCases([item, ...cases]);
                await choose(item);
                setDialog(null);
              });
            }}
          >
            <label>
              Case title
              <input
                name="title"
                required
                maxLength={200}
                placeholder="e.g. Hospitalization claim"
                data-autofocus
              />
            </label>
            <label>
              Claim reference
              <input
                name="reference"
                required
                maxLength={100}
                placeholder="e.g. CLM-2026-001"
              />
            </label>
            <div className="dialog-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setDialog(null)}
              >
                Cancel
              </button>
              <button className="button" disabled={busy}>
                <Plus size={16} />
                Create case
              </button>
            </div>
          </form>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
        </Modal>
      )}
      {dialog === "upload" && selected && (
        <Modal title="Add evidence" close={() => setDialog(null)}>
          <p className="text-muted mb-6">
            Upload a document for <strong>{selected.title}</strong>. Original
            files and versions are preserved.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              if (!data.get("logical_id")) data.delete("logical_id");
              void act(async () => {
                await api("/cases/" + selected.id + "/documents", {
                  method: "POST",
                  body: data,
                });
                setDocuments(
                  await api<Document[]>("/cases/" + selected.id + "/documents"),
                );
                setDialog(null);
                setTab("evidence");
                setView("workspace");
                setNotice("Evidence uploaded successfully.");
              });
            }}
          >
            <label>
              Document category
              <select name="kind">
                {[
                  "insurer_communication",
                  "clinical",
                  "bill",
                  "receipt",
                  "policy",
                  "schedule",
                  "endorsement",
                ].map((k) => (
                  <option key={k} value={k}>
                    {human(k)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Document version
              <select name="logical_id">
                <option value="">New document</option>
                {documents
                  .filter(
                    (d, i, a) =>
                      a.findIndex((x) => x.logical_id === d.logical_id) === i,
                  )
                  .map((d) => (
                    <option key={d.logical_id} value={d.logical_id}>
                      {d.filename}
                    </option>
                  ))}
              </select>
            </label>
            <label className="file-upload">
              <Upload size={26} />
              <strong>Choose your evidence file</strong>
              <span>PDF or plain text</span>
              <input type="file" name="file" accept=".pdf,.txt" required />
            </label>
            <div className="dialog-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setDialog(null)}
              >
                Cancel
              </button>
              <button className="button" disabled={busy}>
                {busy ? (
                  <LoaderCircle className="animate-spin" size={16} />
                ) : (
                  <Upload size={16} />
                )}
                Upload evidence
              </button>
            </div>
          </form>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
        </Modal>
      )}
      {dialog === "settings" && (
        <Modal title="Analysis connection" close={() => setDialog(null)}>
          <button className="text-button mb-5" onClick={lock}>
            <LockKeyhole size={15} />
            Lock this workspace
          </button>
          <div className="connection-banner">
            <Sparkles size={26} />
            <div>
              <h3>ChatGPT · Luna</h3>
              <Badge value={ready ? "connected" : "disconnected"} />
            </div>
          </div>
          <p className="text-muted my-5">
            {chatgpt?.message || "Checking the host connection…"}
          </p>
          {chatgpt?.email && <p className="account-email">{chatgpt.email}</p>}
          <div className="flex flex-wrap gap-3 mt-6">
            <button
              className="button"
              disabled={busy || signingIn}
              onClick={connectChatGPT}
            >
              {signingIn ? "Waiting for sign-in…" : "Continue with ChatGPT"}
              <ArrowUpRight size={16} />
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await refreshConnection();
                })
              }
            >
              <RotateCcw size={16} />
              Refresh
            </button>
            {chatgpt?.connected && (
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const result = await api<{ revocation_confirmed: boolean }>(
                      "/auth/chatgpt/disconnect",
                      { method: "POST" },
                    );
                    await refreshConnection();
                    setNotice(
                      result.revocation_confirmed
                        ? "ChatGPT disconnected."
                        : "Disconnected locally. Remote revocation was not confirmed; disconnect this app in ChatGPT Settings.",
                    );
                  })
                }
              >
                Disconnect
              </button>
            )}
          </div>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
        </Modal>
      )}
      {preview && (
        <Modal
          title={
            "Source evidence · v" +
            preview.ref.version +
            " · page " +
            preview.ref.page
          }
          close={() => setPreview(null)}
        >
          <blockquote>{preview.ref.quote}</blockquote>
          <pre className="source-text">{preview.text}</pre>
          <button
            className="button mt-5"
            disabled={busy}
            onClick={() => void act(() => original(preview.ref))}
          >
            <Download size={16} />
            Download original
          </button>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
