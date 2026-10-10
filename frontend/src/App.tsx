import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Activity,
  BookOpenText,
  ChevronRight,
  ClipboardCheck,
  FileCheck2,
  House,
  LayoutDashboard,
  Menu,
  Plus,
  ShieldCheck,
  Sparkles,
  UserRoundCheck,
  X,
} from "lucide-react";
import { api, listen, send, setReviewerMode } from "./api";
import {
  AppContext,
  parseRoute,
  routeHash,
  type App as AppValue,
  type Dialog,
  type Route,
} from "./app-context";
import {
  CaseDialog,
  ConnectionDialog,
  DocumentDialog,
  GlossaryDialog,
  SystemDialog,
  UploadDialog,
} from "./dialogs";
import { kindLabel } from "./lib";
import { CaseView } from "./screens/CaseView";
import { Home } from "./screens/Home";
import { ReportView } from "./screens/ReportView";
import { ReviewDesk } from "./screens/ReviewDesk";
import type {
  ClaimCase,
  Connection,
  Document,
  Report,
  Run,
  Sample,
  SystemStatus,
  Uploaded,
} from "./types";
import { Confirm, Spinner, Toasts, type Toast } from "./ui";

type Pending = {
  title: string;
  body: ReactNode;
  action: string;
  run: () => Promise<void>;
};
const stored = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Private browsing: the choice simply lasts for this visit. */
  }
};

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  const [cases, setCases] = useState<ClaimCase[] | null>(null);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [live, setLive] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [reachable, setReachable] = useState(true);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [reviewer, setReviewerState] = useState(
    () => stored("claimwise.reviewer") === "1",
  );
  const [reviewerName, setReviewerNameState] = useState(
    () => stored("claimwise.reviewerName") ?? "",
  );
  const toastId = useRef(0);
  const statuses = useRef(new Map<string, string>());
  const signIn = useRef<{ started: number; popup: Window | null }>({
    started: 0,
    popup: null,
  });
  setReviewerMode(reviewer);

  const caseId =
    route.view === "case" || route.view === "report" ? route.caseId : null;
  const reportId = route.view === "report" ? route.reportId : null;
  const item = cases?.find((c) => c.id === caseId) ?? null;
  const ready = !!connection?.connected && !!connection.model_available;

  const toast = useCallback((kind: Toast["kind"], text: string) => {
    const id = ++toastId.current;
    setToasts((current) => [...current.slice(-3), { id, kind, text }]);
    window.setTimeout(
      () => setToasts((current) => current.filter((t) => t.id !== id)),
      kind === "error" ? 12000 : 6000,
    );
  }, []);
  const notify = useCallback((text: string) => toast("ok", text), [toast]);
  const fail = useCallback((text: string) => toast("error", text), [toast]);
  const act = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      try {
        await action();
        return true;
      } catch (e) {
        fail(
          e instanceof Error
            ? e.message
            : "Something unexpected happened. Please try again.",
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [fail],
  );
  const go = useCallback((next: Route) => {
    location.hash = routeHash(next);
    setMenu(false);
    window.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    // Each screen opens at its top, after it has rendered.
    window.scrollTo(0, 0);
  }, [route.view, caseId, reportId]);

  const loadCases = useCallback(
    async () => setCases(await api<ClaimCase[]>("/cases")),
    [],
  );
  const refreshConnection = useCallback(async () => {
    const status = await api<Connection>("/auth/chatgpt/status");
    if (status.connected) {
      try {
        const catalog = await api<{ selected_model_available: boolean }>(
          "/auth/chatgpt/models",
        );
        status.model_available = catalog.selected_model_available;
        status.message = catalog.selected_model_available
          ? "ChatGPT is connected and the analysis model is available."
          : "Your ChatGPT account does not list " +
            (status.model ?? "the configured model") +
            ". Analyses are paused; no other model is used.";
      } catch (e) {
        status.model_available = false;
        status.message =
          e instanceof Error
            ? e.message
            : "The model list is unavailable right now.";
      }
    }
    setConnection(status);
    return status;
  }, []);

  useEffect(() => {
    void loadCases().catch((e: Error) => {
      setCases([]);
      fail(e.message);
    });
    void api<Sample[]>("/samples").then(setSamples, () => undefined);
    void refreshConnection().catch(() => undefined);
    const check = () =>
      api<SystemStatus>("/system/status").then(
        (status) => {
          setSystem(status);
          setReachable(true);
        },
        () => {
          setSystem(null);
          setReachable(false);
        },
      );
    void check();
    const timer = window.setInterval(check, 8000);
    return () => window.clearInterval(timer);
  }, []);

  const loadDocuments = useCallback(
    async (id: string) =>
      setDocuments(await api<Document[]>("/cases/" + id + "/documents")),
    [],
  );
  useEffect(() => {
    setDocuments([]);
    setRuns([]);
    setLive(false);
    statuses.current = new Map();
    if (!caseId) return;
    let cancelled = false;
    const receive = (current: Run[]) => {
      if (cancelled) return;
      // Announce a finished or stopped analysis once, when its status actually changes.
      for (const run of current) {
        const before = statuses.current.get(run.id);
        if (before && before !== run.status && run.status === "completed") {
          notify("Analysis finished. Your report is ready.");
          void loadCases().catch(() => undefined);
        }
        if (before && before !== run.status && run.status === "paused")
          fail(run.error ?? "The analysis paused. Open Analyses to resume it.");
        statuses.current.set(run.id, run.status);
      }
      setRuns(current);
    };
    loadDocuments(caseId).catch((e: Error) => {
      if (cancelled) return;
      fail(e.message);
      go({ view: "home" });
    });
    api<Run[]>("/cases/" + caseId + "/analyses").then(receive, () => undefined);
    const stop = listen<Run[]>(
      "/cases/" + caseId + "/analysis-events",
      receive,
      (state) => !cancelled && setLive(state),
    );
    return () => {
      cancelled = true;
      stop();
    };
  }, [caseId]);

  useEffect(() => {
    setReport(null);
  }, [reportId]);
  useEffect(() => {
    // Switching reviewer mode refreshes the same report in place, without losing the reader's position.
    if (!reportId) return;
    let cancelled = false;
    api<Report>("/reports/" + reportId)
      .then((result) => !cancelled && setReport(result))
      .catch((e: Error) => {
        if (cancelled) return;
        fail(e.message);
        go(caseId ? { view: "case", caseId } : { view: "home" });
      });
    return () => {
      cancelled = true;
    };
  }, [reportId, reviewer]);

  useEffect(() => {
    if (!signingIn) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      if (
        Date.now() - signIn.current.started > 600000 ||
        signIn.current.popup?.closed
      ) {
        setSigningIn(false);
        void refreshConnection().catch(() => undefined);
        return;
      }
      void api<Connection>("/auth/chatgpt/status").then(
        async (status) => {
          if (cancelled || !status.connected) return;
          setSigningIn(false);
          await refreshConnection();
          notify("ChatGPT connected.");
        },
        () => !cancelled && setSigningIn(false),
      );
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [signingIn]);

  function connect() {
    // Open the window during the click so the browser does not block it.
    const popup = window.open(
      "",
      "claim-chatgpt-signin",
      "width=650,height=780",
    );
    if (!popup)
      return fail(
        "Allow pop-ups for this page, then choose Continue with ChatGPT again.",
      );
    signIn.current = { started: Date.now(), popup };
    void act(async () => {
      try {
        popup.location.href = (
          await send<{ sign_in_url: string }>("/auth/chatgpt/start", "POST")
        ).sign_in_url;
        setSigningIn(true);
      } catch (e) {
        popup.close();
        throw e;
      }
    });
  }

  const setReviewer = (value: boolean) => {
    setReviewerMode(value);
    setReviewerState(value);
    store("claimwise.reviewer", value ? "1" : "0");
    notify(
      value
        ? "Reviewer mode is on. Your decisions are recorded with your name."
        : "Back to the customer view.",
    );
  };
  const reload = async () => {
    if (!caseId) return;
    await Promise.all([
      loadDocuments(caseId),
      api<Run[]>("/cases/" + caseId + "/analyses").then(setRuns),
      loadCases(),
    ]);
  };
  const upsertCase = (saved: ClaimCase) =>
    setCases((current) =>
      [saved, ...(current ?? []).filter((c) => c.id !== saved.id)].sort(
        (a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""),
      ),
    );
  const confirmThen = (
    title: string,
    body: ReactNode,
    action: string,
    run: () => Promise<void>,
  ) => setPending({ title, body, action, run });

  // Opening anything from the slide-in menu closes the menu, so its backdrop never covers the page.
  const openDialog = (next: Dialog | null) => {
    setDialog(next);
    setMenu(false);
  };
  const context: AppValue = {
    busy,
    act,
    notify,
    fail,
    go,
    open: openDialog,
    cite: (id, ref) =>
      setDialog({
        type: "document",
        caseId: id,
        documentId: ref.document_id,
        quote: ref.quote,
        page: ref.page,
      }),
    reviewer,
    reviewerName,
    system,
    connection,
    ready,
  };

  const latestReport = runs.find((run) => run.report_id);
  const health = !reachable
    ? {
        label: "Service offline",
        tone: "bg-rose-100 text-rose-900",
        dot: "bg-critical",
      }
    : system && (!system.redis || !system.workers)
      ? {
          label: "Analysis engine offline",
          tone: "bg-amber-100 text-amber-950",
          dot: "bg-warn",
        }
      : !ready
        ? {
            label: "Connect AI to analyse",
            tone: "bg-sky-100 text-sky-900",
            dot: "bg-sky-500",
          }
        : {
            label: "All systems ready",
            tone: "bg-emerald-100 text-emerald-900",
            dot: "bg-good animate-pulse-ring",
          };
  const nav = useMemo(
    () => [
      {
        label: "My claims",
        icon: House,
        active: route.view === "home",
        run: () => go({ view: "home" }),
        enabled: true,
      },
      {
        label: "Claim workspace",
        icon: LayoutDashboard,
        active: route.view === "case",
        run: () => caseId && go({ view: "case", caseId }),
        enabled: !!caseId,
      },
      {
        label: "Evidence report",
        icon: FileCheck2,
        active: route.view === "report",
        run: () =>
          caseId &&
          latestReport &&
          go({ view: "report", caseId, reportId: latestReport.report_id! }),
        enabled: !!latestReport,
      },
      {
        label: "Review desk",
        icon: ClipboardCheck,
        active: route.view === "review",
        run: () => go({ view: "review" }),
        enabled: true,
      },
    ],
    [route, caseId, latestReport?.report_id],
  );

  return (
    <AppContext.Provider value={context}>
      <div className="min-h-screen lg:grid lg:grid-cols-[17rem_minmax(0,1fr)]">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2"
        >
          Skip to content
        </a>
        {menu && (
          <div
            className="fixed inset-0 z-30 bg-ink/50 lg:hidden"
            onClick={() => setMenu(false)}
            aria-hidden="true"
          />
        )}
        <aside
          className={
            "fixed inset-y-0 left-0 z-40 flex w-68 flex-col overflow-y-auto bg-gradient-to-b from-indigo-950 via-violet-950 to-fuchsia-950 p-5 text-white transition-transform lg:sticky lg:top-0 lg:h-screen lg:w-auto lg:translate-x-0 " +
            (menu ? "translate-x-0" : "-translate-x-full")
          }
        >
          <div className="flex items-center justify-between">
            <button
              className="flex items-center gap-2.5 text-xl font-bold tracking-tight"
              onClick={() => go({ view: "home" })}
            >
              <span className="grid size-10 place-items-center rounded-2xl bg-gradient-to-br from-fuchsia-500 to-orange-400 shadow-lg shadow-fuchsia-500/40">
                <ShieldCheck size={22} aria-hidden="true" />
              </span>
              claimwise
            </button>
            <button
              className="grid size-9 place-items-center rounded-lg hover:bg-white/10 lg:hidden"
              aria-label="Close menu"
              onClick={() => setMenu(false)}
            >
              <X size={18} />
            </button>
          </div>

          <nav aria-label="Main navigation" className="mt-8 space-y-1">
            {nav.map(({ label, icon: Icon, active, run, enabled }) => (
              <button
                key={label}
                aria-current={active ? "page" : undefined}
                disabled={!enabled}
                className={
                  "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition " +
                  (active
                    ? "bg-white/15 text-white shadow-inner"
                    : "text-white/70 hover:bg-white/10 hover:text-white")
                }
                onClick={run}
              >
                <Icon size={18} aria-hidden="true" />
                {label}
              </button>
            ))}
          </nav>

          <div className="mt-8 min-h-24 flex-1 overflow-y-auto">
            <div className="mb-2 flex items-center justify-between px-3">
              <p className="text-[11px] font-bold tracking-[0.14em] text-white/50 uppercase">
                Your claims
              </p>
              <button
                className="grid size-7 place-items-center rounded-lg text-white/70 hover:bg-white/10 hover:text-white"
                aria-label="Start a new claim"
                onClick={() => openDialog({ type: "case" })}
              >
                <Plus size={16} />
              </button>
            </div>
            <ul className="space-y-0.5">
              {(cases ?? []).map((c) => (
                <li key={c.id}>
                  <button
                    className={
                      "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition " +
                      (c.id === caseId
                        ? "bg-white/15 font-semibold text-white"
                        : "text-white/70 hover:bg-white/10 hover:text-white")
                    }
                    onClick={() => go({ view: "case", caseId: c.id })}
                  >
                    <span
                      className={
                        "size-2 shrink-0 rounded-full " +
                        (c.id === caseId ? "bg-fuchsia-400" : "bg-white/30")
                      }
                      aria-hidden="true"
                    />
                    <span className="truncate">{c.title}</span>
                  </button>
                </li>
              ))}
              {cases?.length === 0 && (
                <li className="px-3 text-xs text-white/50">
                  Your claims will appear here.
                </li>
              )}
            </ul>
          </div>

          <div className="mt-6 space-y-2">
            <button
              className="flex w-full items-center gap-3 rounded-2xl border border-white/15 bg-white/10 p-3 text-left hover:bg-white/15"
              onClick={() => openDialog({ type: "connection" })}
            >
              <span
                className={
                  "grid size-9 shrink-0 place-items-center rounded-xl " +
                  (ready ? "bg-emerald-400 text-emerald-950" : "bg-white/20")
                }
              >
                <Sparkles size={17} aria-hidden="true" />
              </span>
              <span className="min-w-0 text-sm font-semibold">
                AI engine
                <small className="block truncate text-xs font-normal text-white/70">
                  {ready
                    ? "Connected"
                    : connection?.connected
                      ? "Model unavailable"
                      : "Connect ChatGPT"}
                </small>
              </span>
            </button>
            <label className="flex cursor-pointer items-center gap-3 rounded-2xl px-3 py-2 text-sm text-white/80 hover:bg-white/10">
              <UserRoundCheck size={17} aria-hidden="true" />
              <span className="flex-1">Reviewer mode</span>
              <input
                type="checkbox"
                role="switch"
                aria-label="Reviewer mode"
                className="peer sr-only"
                checked={reviewer}
                onChange={(e) => setReviewer(e.target.checked)}
              />
              <span className="relative h-5 w-9 rounded-full bg-white/25 transition peer-checked:bg-fuchsia-500 peer-focus-visible:ring-2 peer-focus-visible:ring-white after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-white after:transition peer-checked:after:translate-x-4" />
            </label>
          </div>
        </aside>

        <div className="min-w-0">
          <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-line bg-white/80 px-4 py-3 backdrop-blur-xl sm:px-8">
            <button
              className="icon-btn lg:hidden"
              aria-label="Open menu"
              onClick={() => setMenu(true)}
            >
              <Menu size={20} />
            </button>
            <nav
              aria-label="Breadcrumb"
              className="flex min-w-0 items-center gap-1.5 text-sm text-ink-soft"
            >
              <button
                className="hover:text-violet-700"
                onClick={() => go({ view: "home" })}
              >
                My claims
              </button>
              {item && (
                <>
                  <ChevronRight
                    size={14}
                    className="shrink-0"
                    aria-hidden="true"
                  />
                  <button
                    className={
                      "truncate hover:text-violet-700 " +
                      (route.view === "case" ? "font-semibold text-ink" : "")
                    }
                    onClick={() => go({ view: "case", caseId: item.id })}
                  >
                    {item.title}
                  </button>
                </>
              )}
              {route.view === "report" && (
                <>
                  <ChevronRight
                    size={14}
                    className="shrink-0"
                    aria-hidden="true"
                  />
                  <span className="font-semibold whitespace-nowrap text-ink">
                    Report
                  </span>
                </>
              )}
              {route.view === "review" && (
                <>
                  <ChevronRight
                    size={14}
                    className="shrink-0"
                    aria-hidden="true"
                  />
                  <span className="font-semibold text-ink">Review desk</span>
                </>
              )}
            </nav>
            <div className="ml-auto flex items-center gap-2">
              {reviewer && (
                <span className="chip hidden border-fuchsia-200 bg-fuchsia-50 text-fuchsia-900 sm:inline-flex">
                  Reviewer mode
                </span>
              )}
              <button
                className="btn btn-ghost btn-sm"
                aria-label="Terms explained"
                onClick={() => setDialog({ type: "glossary" })}
              >
                <BookOpenText size={16} />
                <span className="hidden sm:inline">Terms explained</span>
              </button>
              <button
                className={
                  "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold whitespace-nowrap " +
                  health.tone
                }
                onClick={() => setDialog({ type: "system" })}
                aria-label={"System status: " + health.label}
              >
                <span
                  className={"size-2 rounded-full " + health.dot}
                  aria-hidden="true"
                />
                <span className="hidden sm:inline">{health.label}</span>
                <Activity size={14} className="sm:hidden" aria-hidden="true" />
              </button>
            </div>
          </header>

          <main id="main" className="mx-auto max-w-[88rem] p-4 sm:p-8">
            {!cases ? (
              <Spinner label="Opening your workspace..." />
            ) : route.view === "home" ? (
              <Home
                cases={cases}
                samples={samples}
                openSample={(sample) => {
                  const existing = cases.find(
                    (c) => c.sample_key === sample.key,
                  );
                  if (existing)
                    return go({ view: "case", caseId: existing.id });
                  void act(async () => {
                    const created = await send<ClaimCase>(
                      "/samples/" + sample.key,
                      "POST",
                    );
                    upsertCase(created);
                    go({ view: "case", caseId: created.id });
                    notify(
                      "Sample loaded with " +
                        created.document_count +
                        " fictional documents. Run the analysis to see the result.",
                    );
                  });
                }}
                remove={(target) =>
                  confirmThen(
                    "Delete this claim?",
                    <>
                      This removes <strong>{target.title}</strong> with its
                      documents, analyses and reports from this computer. It
                      cannot be undone.
                    </>,
                    "Delete claim",
                    async () => {
                      await send("/cases/" + target.id, "DELETE");
                      await loadCases();
                      notify("Claim deleted.");
                    },
                  )
                }
              />
            ) : route.view === "review" ? (
              <ReviewDesk
                setReviewer={setReviewer}
                setReviewerName={(value) => {
                  setReviewerNameState(value);
                  store("claimwise.reviewerName", value);
                }}
              />
            ) : !item ? (
              <Spinner label="Opening the claim..." />
            ) : route.view === "report" ? (
              report ? (
                <ReportView
                  item={item}
                  report={report}
                  runs={runs}
                  onReport={setReport}
                />
              ) : (
                <Spinner label="Opening the report..." />
              )
            ) : (
              <CaseView
                item={item}
                documents={documents}
                runs={runs}
                live={live}
                reload={reload}
                onCase={upsertCase}
                removeRun={(run, number) =>
                  confirmThen(
                    "Delete analysis " + number + "?",
                    "Its report and review history are removed. Your uploaded documents stay.",
                    "Delete analysis",
                    async () => {
                      await send("/analyses/" + run.id, "DELETE");
                      await reload();
                      notify("Analysis deleted. Your documents were kept.");
                    },
                  )
                }
                removeDocument={(document) =>
                  confirmThen(
                    "Remove this document?",
                    <>
                      <strong>{document.filename}</strong> (
                      {kindLabel(document.kind).toLowerCase()}, version{" "}
                      {document.version}) will be deleted from this claim.
                    </>,
                    "Remove document",
                    async () => {
                      await send(
                        "/cases/" + item.id + "/documents/" + document.id,
                        "DELETE",
                      );
                      await reload();
                      notify("Document removed.");
                    },
                  )
                }
              />
            )}
            <footer className="mt-12 flex flex-wrap justify-between gap-2 border-t border-line pt-5 text-xs text-muted">
              <span>Claimwise · Runs on this computer</span>
              <span>
                Explains your evidence. The insurer's decision stays with the
                insurer.
              </span>
            </footer>
          </main>
        </div>
      </div>

      {dialog?.type === "case" && (
        <CaseDialog
          onSaved={(saved) => {
            upsertCase(saved);
            go({ view: "case", caseId: saved.id });
            notify("Claim created. Add the insurer's letter to begin.");
          }}
        />
      )}
      {dialog?.type === "rename" && (
        <CaseDialog
          item={dialog.item}
          onSaved={(saved) => {
            upsertCase(saved);
            notify("Claim details updated.");
          }}
        />
      )}
      {dialog?.type === "upload" && item && (
        <UploadDialog
          item={item}
          documents={documents}
          onDone={(added: Uploaded[]) => {
            void reload().catch(() => undefined);
            notify(
              added.length === 1
                ? added[0].filename +
                    " added as " +
                    kindLabel(added[0].kind).toLowerCase() +
                    "."
                : added.length + " documents added and sorted into categories.",
            );
          }}
        />
      )}
      {dialog?.type === "document" && (
        <DocumentDialog
          key={dialog.documentId + (dialog.quote ?? "")}
          caseId={dialog.caseId}
          documentId={dialog.documentId}
          quote={dialog.quote}
          page={dialog.page}
        />
      )}
      {dialog?.type === "connection" && (
        <ConnectionDialog
          signingIn={signingIn}
          connect={connect}
          refresh={refreshConnection}
          disconnect={async () => {
            const result = await send<{ revocation_confirmed: boolean }>(
              "/auth/chatgpt/disconnect",
              "POST",
            );
            await refreshConnection();
            notify(
              result.revocation_confirmed
                ? "ChatGPT disconnected."
                : "Disconnected on this computer. Also remove this app in ChatGPT Settings to finish.",
            );
          }}
        />
      )}
      {dialog?.type === "system" && <SystemDialog system={system} />}
      {dialog?.type === "glossary" && <GlossaryDialog />}
      {pending && (
        <Confirm
          title={pending.title}
          body={pending.body}
          action={pending.action}
          busy={busy}
          close={() => setPending(null)}
          onConfirm={() =>
            void act(async () => {
              try {
                await pending.run();
              } finally {
                setPending(null);
              }
            })
          }
        />
      )}
      <Toasts
        items={toasts}
        dismiss={(id) =>
          setToasts((current) => current.filter((t) => t.id !== id))
        }
      />
    </AppContext.Provider>
  );
}
