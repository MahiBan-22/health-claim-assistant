import { lazy, Suspense, useEffect, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  CircleCheck,
  CloudUpload,
  FileCheck2,
  Files,
  History,
  Lightbulb,
  LoaderCircle,
  Pencil,
  Radio,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
  Workflow,
} from "lucide-react";
import { api, blob, saveFile, send } from "../api";
import { foreignReferences, useApp } from "../app-context";
import { KINDS, date, day, kindLabel } from "../lib";
import type { ClaimCase, Document, Run, TimelineEvent } from "../types";
import { Empty, KindChip, RunChip, Spinner } from "../ui";

const DocumentsGrid = lazy(() =>
  import("../grids").then((m) => ({ default: m.DocumentsGrid })),
);
const ACTIVE = ["queued", "running"];
type Tab = "documents" | "timeline" | "analyses";

export function CaseView({
  item,
  documents,
  runs,
  live,
  reload,
  onCase,
  removeRun,
  removeDocument,
}: {
  item: ClaimCase;
  documents: Document[];
  runs: Run[];
  live: boolean;
  reload: () => Promise<void>;
  onCase: (saved: ClaimCase) => void;
  removeRun: (run: Run, number: number) => void;
  removeDocument: (document: Document) => void;
}) {
  const app = useApp();
  const [tab, setTab] = useState<Tab>("documents");
  const [query, setQuery] = useState("");
  const [timeline, setTimeline] = useState<TimelineEvent[] | null>(null);
  const active = runs.some((run) => ACTIVE.includes(run.status));
  const reports = runs.filter((run) => run.report_id);
  const latest = documents.filter((d) => d.is_latest !== false);
  const hasLetter = latest.some((d) => d.kind === "insurer_communication");
  const hasSupport = latest.some((d) => d.kind !== "insurer_communication");
  const offline =
    !!app.system && app.system.backend !== "postgres" &&
    (!app.system.redis || app.system.workers === 0);
  const foreign = foreignReferences(item, documents);
  const stale =
    !!reports[0] &&
    documents.some((d) => (d.created_at ?? "") > reports[0].created_at);

  useEffect(() => {
    if (tab !== "timeline") return;
    let cancelled = false;
    api<TimelineEvent[]>("/cases/" + item.id + "/timeline")
      .then((events) => !cancelled && setTimeline(events))
      .catch((e: Error) => app.fail(e.message));
    return () => {
      cancelled = true;
    };
  }, [tab, item.id, documents.length]);

  const start = () =>
    void app.act(async () => {
      await send<Run>("/cases/" + item.id + "/analyses", "POST");
      setTab("analyses");
      app.notify(
        offline
          ? "Analysis saved. It will start as soon as the analysis worker is running."
          : "Analysis started. You can keep working; this page updates by itself.",
      );
    });

  const steps = [
    { label: "Insurer's letter", done: hasLetter },
    { label: "Your documents", done: hasSupport },
    { label: "AI engine ready", done: app.ready },
    { label: "Analysis", done: reports.length > 0, working: active },
    { label: "Reply ready", done: reports.length > 0 && !stale },
  ];
  const next = active
    ? {
        title: "Checking every request against your documents",
        text: "This usually takes one to three minutes. You can leave this page; the report appears here when it is done.",
        action: null,
      }
    : !hasLetter
      ? {
          title: "Start with the insurer's letter",
          text: "Add the query, rejection or settlement letter so the analysis knows exactly what was asked.",
          action: {
            label: "Add documents",
            run: () => app.open({ type: "upload" }),
          },
        }
      : !hasSupport
        ? {
            title: "Add the documents you hold",
            text: "Bills, medical records, acknowledgements and policy papers. The more you add, the more can be matched.",
            action: {
              label: "Add documents",
              run: () => app.open({ type: "upload" }),
            },
          }
        : !app.ready
          ? {
              title: "The AI engine is not available",
              text: "Analyses are paused until the workspace's AI engine is back. You can keep adding documents meanwhile.",
              action: {
                label: "See AI engine status",
                run: () => app.open({ type: "connection" }),
              },
            }
          : stale
            ? {
                title: "New documents since your last report",
                text: "Run a fresh analysis so the report reflects everything you have added. Earlier reports are kept.",
                action: { label: "Run a new analysis", run: start },
              }
            : reports.length
              ? {
                  title: "Your report is ready",
                  text: "See what is supported, what is missing, and the reply drafted for you.",
                  action: {
                    label: "Open the report",
                    run: () =>
                      app.go({
                        view: "report",
                        caseId: item.id,
                        reportId: reports[0].report_id!,
                      }),
                  },
                }
              : {
                  title: "Ready to analyse",
                  text: "The assistant will list what the insurer asked and match each point to your documents.",
                  action: { label: "Run analysis", run: start },
                };

  return (
    <div className="space-y-6">
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-indigo-700 via-violet-700 to-fuchsia-600 p-6 text-white shadow-pop sm:p-8">
        <div
          className="pointer-events-none absolute -top-20 right-0 size-72 animate-drift rounded-full bg-fuchsia-400/40 blur-3xl"
          aria-hidden="true"
        />
        <div className="relative flex flex-wrap items-start justify-between gap-6">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-[11px] font-bold tracking-[0.14em] text-white/80 uppercase">
              Claim workspace
              <span className="rounded-full bg-white/20 px-2.5 py-1 tracking-normal normal-case">
                {item.claim_reference}
              </span>
              {item.sample_key && (
                <span className="rounded-full bg-amber-300 px-2.5 py-1 tracking-normal text-amber-950 normal-case">
                  Sample data
                </span>
              )}
            </p>
            <h1 className="mt-3 flex items-center gap-2 text-2xl font-bold sm:text-3xl">
              <span className="truncate">{item.title}</span>
              <button
                className="grid size-8 shrink-0 place-items-center rounded-lg text-white/80 hover:bg-white/20 hover:text-white"
                aria-label="Edit claim details"
                onClick={() => app.open({ type: "rename", item })}
              >
                <Pencil size={16} />
              </button>
            </h1>
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              className="btn bg-white text-violet-800 hover:bg-violet-50"
              disabled={app.busy}
              onClick={() => app.open({ type: "upload" })}
            >
              <CloudUpload size={16} />
              Add documents
            </button>
            <button
              className="btn btn-glass"
              disabled={app.busy || !app.ready || !hasLetter || active}
              onClick={start}
              title={
                !hasLetter
                  ? "Add the insurer's letter first"
                  : !app.ready
                    ? "The AI engine is not available right now"
                    : undefined
              }
            >
              {active ? (
                <LoaderCircle className="animate-spin" size={16} />
              ) : (
                <Sparkles size={16} />
              )}
              {active ? "Analysis in progress" : "Run analysis"}
            </button>
          </div>
        </div>
        <ol
          className="relative mt-7 grid gap-2 sm:grid-cols-5"
          aria-label="Claim progress"
        >
          {steps.map((step, index) => (
            <li
              key={step.label}
              className={
                "flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-semibold " +
                (step.done ? "bg-white/20" : "bg-black/10 text-white/75")
              }
            >
              <span
                className={
                  "grid size-6 shrink-0 place-items-center rounded-full text-xs " +
                  (step.done
                    ? "bg-emerald-400 text-emerald-950"
                    : "border border-white/50")
                }
              >
                {step.working ? (
                  <LoaderCircle size={13} className="animate-spin" />
                ) : step.done ? (
                  <Check size={14} strokeWidth={3} />
                ) : (
                  index + 1
                )}
              </span>
              {step.label}
            </li>
          ))}
        </ol>
      </section>

      {foreign.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
          role="alert"
        >
          <TriangleAlert
            size={19}
            className="shrink-0 text-amber-500"
            aria-hidden="true"
          />
          <p className="min-w-0 flex-1">
            Your documents mention claim reference{" "}
            <strong>{foreign.join(", ")}</strong>, but this claim is saved as{" "}
            <strong>{item.claim_reference}</strong>. A mismatch sends every
            finding to review.
          </p>
          {foreign.length === 1 && (
            <button
              className="btn btn-sm bg-amber-500 text-amber-950 hover:bg-amber-400"
              disabled={app.busy}
              onClick={() =>
                void app.act(async () =>
                  onCase(
                    await send<ClaimCase>("/cases/" + item.id, "PATCH", {
                      claim_reference: foreign[0],
                    }),
                  ),
                )
              }
            >
              Use {foreign[0]}
            </button>
          )}
        </div>
      )}
      {offline && (
        <div
          className="flex flex-wrap items-center gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-950"
          role="alert"
        >
          <TriangleAlert
            size={19}
            className="shrink-0 text-critical"
            aria-hidden="true"
          />
          <p className="min-w-0 flex-1">
            The analysis worker is not running, so analyses will wait in the
            queue. Start it with scripts/start-native.ps1.
          </p>
          <button
            className="btn btn-soft btn-sm"
            onClick={() => app.open({ type: "system" })}
          >
            System status
          </button>
        </div>
      )}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <section className="card min-w-0 overflow-hidden">
          <div
            className="flex flex-wrap items-center gap-1 border-b border-line p-3"
            role="tablist"
            aria-label="Claim content"
          >
            {(
              [
                ["documents", "Documents", Files, documents.length],
                ["timeline", "Timeline", CalendarDays, null],
                ["analyses", "Analyses", History, runs.length],
              ] as const
            ).map(([id, label, Icon, count]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                className={"tab " + (tab === id ? "tab-active" : "")}
                onClick={() => setTab(id)}
              >
                <Icon size={16} />
                {label}
                {count !== null && <span className="count">{count}</span>}
              </button>
            ))}
            {tab === "documents" && documents.length > 0 && (
              <label className="relative ml-auto w-full sm:w-64">
                <Search
                  size={15}
                  className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
                />
                <input
                  className="input mt-0 py-2 pl-9"
                  aria-label="Search documents"
                  placeholder="Search documents..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
            )}
            {tab === "analyses" && (
              <span
                className="chip ml-auto border-line bg-white text-ink-soft"
                title={
                  live
                    ? "This list updates by itself"
                    : "Reconnecting to live updates"
                }
              >
                <Radio
                  size={13}
                  className={live ? "text-good" : "text-amber-500"}
                />
                {live ? "Live" : "Reconnecting"}
              </span>
            )}
          </div>

          {tab === "documents" &&
            (documents.length ? (
              <Suspense
                fallback={<Spinner label="Loading your documents..." />}
              >
                <DocumentsGrid
                  documents={documents}
                  query={query}
                  actions={{
                    open: (d) =>
                      app.open({
                        type: "document",
                        caseId: item.id,
                        documentId: d.id,
                      }),
                    download: (d) =>
                      void app.act(async () =>
                        saveFile(
                          await blob(
                            "/cases/" +
                              item.id +
                              "/documents/" +
                              d.id +
                              "/original",
                          ),
                          d.filename,
                        ),
                      ),
                    remove: removeDocument,
                  }}
                  onKind={(d, kind) =>
                    void app.act(async () => {
                      const data = new FormData();
                      data.set("kind", kind);
                      try {
                        await api("/cases/" + item.id + "/documents/" + d.id, {
                          method: "PATCH",
                          body: data,
                        });
                        app.notify(
                          d.filename +
                            " is now filed as " +
                            kindLabel(kind).toLowerCase() +
                            ".",
                        );
                      } finally {
                        await reload();
                      }
                    })
                  }
                />
                <p className="border-t border-line px-5 py-3 text-xs text-ink-soft">
                  {documents.length} file{documents.length === 1 ? "" : "s"}.
                  Every version is kept. Click a category to correct it.
                </p>
              </Suspense>
            ) : (
              <Empty icon={CloudUpload} title="No documents yet">
                Add the insurer's letter first, then everything you sent or
                hold. Categories are detected for you.
                <button
                  className="btn btn-primary mx-auto mt-5"
                  onClick={() => app.open({ type: "upload" })}
                >
                  <CloudUpload size={16} />
                  Add documents
                </button>
              </Empty>
            ))}

          {tab === "timeline" &&
            (!timeline ? (
              <Spinner label="Reading dates from your documents..." />
            ) : timeline.length ? (
              <ol className="relative m-6 space-y-5 border-l-2 border-violet-200 pl-6">
                {timeline.map((event, index) => (
                  <li key={index} className="relative">
                    <span
                      className="absolute top-1 -left-[31px] size-3 rounded-full border-2 border-white bg-gradient-to-br from-violet-600 to-fuchsia-500 ring-2 ring-violet-200"
                      aria-hidden="true"
                    />
                    <p className="text-xs font-bold text-violet-700">
                      {day(event.date)}
                    </p>
                    <p className="mt-0.5 text-sm text-ink">{event.label}</p>
                    <button
                      className="mt-1.5 inline-flex items-center gap-2 text-xs text-ink-soft hover:text-violet-700"
                      onClick={() =>
                        app.open({
                          type: "document",
                          caseId: item.id,
                          documentId: event.document_id,
                          page: event.page,
                          quote: event.label,
                        })
                      }
                    >
                      <KindChip value={event.kind} />
                      {event.filename}, page {event.page}
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <Empty icon={CalendarDays} title="No dates found yet">
                Dates written in your documents appear here in order, so you can
                see the story of the claim at a glance.
              </Empty>
            ))}

          {tab === "analyses" &&
            (runs.length ? (
              <ul className="divide-y divide-line">
                {runs.map((run, index) => (
                  <li
                    key={run.id}
                    className="flex flex-wrap items-center gap-4 px-5 py-4"
                  >
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-violet-100 to-fuchsia-100 text-violet-700">
                      <FileCheck2 size={19} aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h3 className="flex flex-wrap items-center gap-2 text-sm font-bold">
                        Analysis {runs.length - index}{" "}
                        <RunChip value={run.status} />
                      </h3>
                      <p className="text-xs text-muted">
                        {date(run.created_at)}
                      </p>
                      {run.error && (
                        <p className="mt-1.5 rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-950">
                          {run.error}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {run.report_id && (
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() =>
                            app.go({
                              view: "report",
                              caseId: item.id,
                              reportId: run.report_id!,
                            })
                          }
                        >
                          View report <ArrowUpRight size={15} />
                        </button>
                      )}
                      <button
                        className="btn btn-soft btn-sm"
                        onClick={() =>
                          app.go({
                            view: "workflow",
                            caseId: item.id,
                            runId: run.id,
                          })
                        }
                      >
                        <Workflow size={14} />
                        Workflow
                      </button>
                      {run.status === "paused" && (
                        <button
                          className="btn btn-soft btn-sm"
                          disabled={app.busy || !app.ready}
                          onClick={() =>
                            void app.act(
                              async () =>
                                void (await send(
                                  "/analyses/" + run.id + "/resume",
                                  "POST",
                                )),
                            )
                          }
                        >
                          <RotateCcw size={14} />
                          Resume
                        </button>
                      )}
                      <button
                        className="icon-btn hover:bg-rose-100 hover:text-rose-700"
                        aria-label={"Delete analysis " + (runs.length - index)}
                        disabled={app.busy || ACTIVE.includes(run.status)}
                        onClick={() => removeRun(run, runs.length - index)}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty icon={Sparkles} title="No analysis yet">
                Run an analysis to match each of the insurer's requests to your
                documents.
              </Empty>
            ))}
        </section>

        <aside className="space-y-4">
          <section className="card overflow-hidden">
            <div className="bg-gradient-to-r from-amber-400 to-orange-400 px-5 py-3 text-amber-950">
              <p className="flex items-center gap-2 text-[11px] font-bold tracking-[0.14em] uppercase">
                <Lightbulb size={14} aria-hidden="true" />
                Next best step
              </p>
            </div>
            <div className="p-5">
              <h2 className="text-base font-bold">{next.title}</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">
                {next.text}
              </p>
              {next.action && (
                <button
                  className="btn btn-primary mt-4 w-full"
                  disabled={app.busy}
                  onClick={next.action.run}
                >
                  {next.action.label}
                  <ArrowRight size={16} />
                </button>
              )}
            </div>
          </section>

          {item.sample_follow_up &&
            documents.length > 0 &&
            !documents.some((d) => d.version > 1) &&
            reports.length > 0 && (
              <section className="card border-sky-200 bg-sky-50/60 p-5">
                <h2 className="text-sm font-bold">
                  Sample: add the missing documents
                </h2>
                <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">
                  {item.sample_follow_up}
                </p>
                <button
                  className="btn btn-soft btn-sm mt-3"
                  disabled={app.busy}
                  onClick={() =>
                    void app.act(async () => {
                      const result = await send<{ added: number }>(
                        "/cases/" + item.id + "/sample-follow-up",
                        "POST",
                      );
                      await reload();
                      app.notify(
                        result.added +
                          " sample documents added. Run a new analysis to see what changes.",
                      );
                    })
                  }
                >
                  Add the sample documents
                </button>
              </section>
            )}

          <section className="card p-5">
            <h2 className="text-sm font-bold">What is in your file</h2>
            <ul className="mt-3 space-y-2">
              {Object.entries(KINDS)
                .filter(([kind]) => kind !== "other")
                .map(([kind, meta]) => {
                  const count = latest.filter((d) => d.kind === kind).length;
                  return (
                    <li
                      key={kind}
                      className="flex items-center gap-2.5 text-sm"
                      title={meta.hint}
                    >
                      {count ? (
                        <CircleCheck
                          size={16}
                          className="shrink-0 text-good"
                          aria-label="On file"
                        />
                      ) : (
                        <span
                          className="size-4 shrink-0 rounded-full border-2 border-dashed border-slate-300"
                          aria-label="Not added"
                        />
                      )}
                      <span className={count ? "text-ink" : "text-ink-soft"}>
                        {meta.label}
                      </span>
                      {count > 0 && (
                        <span className="ml-auto text-xs font-semibold text-ink-soft">
                          {count}
                        </span>
                      )}
                    </li>
                  );
                })}
            </ul>
            <p className="mt-3 text-xs leading-relaxed text-muted">
              Not every claim needs every category. Add what the insurer's
              letter refers to.
            </p>
          </section>

          <section className="flex gap-3 rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4 text-emerald-950">
            <ShieldCheck
              size={19}
              className="mt-0.5 shrink-0 text-good"
              aria-hidden="true"
            />
            <p className="text-[13px] leading-relaxed">
              <strong>Every finding points to a page.</strong> Nothing is marked
              as sent to the insurer unless an acknowledgement proves it.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
