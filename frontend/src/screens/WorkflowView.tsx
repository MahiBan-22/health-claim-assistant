import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUpRight,
  ChevronDown,
  CircleCheck,
  CirclePause,
  FileSearch,
  Flag,
  ListTree,
  LoaderCircle,
  PackageCheck,
  Play,
  Repeat2,
  ScrollText,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { api } from "../api";
import { useApp } from "../app-context";
import { CATEGORY, date } from "../lib";
import type {
  ClaimCase,
  FlowAttempt,
  FlowPass,
  FlowRequest,
  FlowStep,
  Workflow,
} from "../types";
import {
  Empty,
  EvidenceChip,
  PolicyChip,
  RunChip,
  Spinner,
  SubmissionChip,
} from "../ui";

const ACTIVE = ["queued", "running"];

/** What each kind of step is for, in the customer's words, and the colour that identifies it. */
const ROLE: Record<
  string,
  { title: string; does: string; icon: LucideIcon; tone: string; skill: string }
> = {
  "claim.catalog": {
    title: "AI model check",
    does: "Confirms the analysis model is available on your ChatGPT plan.",
    icon: Sparkles,
    tone: "from-slate-500 to-slate-600",
    skill: "State",
  },
  plan: {
    title: "Planner",
    does: "Reads the insurer's letter and lists each point to answer.",
    icon: ListTree,
    tone: "from-violet-600 to-indigo-600",
    skill: "Planning",
  },
  policy: {
    title: "Policy agent",
    does: "Reads your policy wording, schedule and endorsements for this point.",
    icon: ScrollText,
    tone: "from-fuchsia-600 to-pink-600",
    skill: "Context",
  },
  evidence: {
    title: "Evidence agent",
    does: "Matches the point to pages in your documents and writes the answer.",
    icon: FileSearch,
    tone: "from-sky-600 to-cyan-600",
    skill: "Tool use",
  },
  verify: {
    title: "Verifier",
    does: "Checks every citation and statement against the cited pages.",
    icon: ShieldCheck,
    tone: "from-amber-500 to-orange-500",
    skill: "Verification",
  },
  "claim.package": {
    title: "Response package",
    does: "Builds the report, reply letter and attachment list.",
    icon: PackageCheck,
    tone: "from-emerald-600 to-teal-600",
    skill: "Execution",
  },
};
const TOOL: Record<string, string> = {
  list_documents: "Listed the documents in this analysis",
  search: "Searched pages for matching wording",
  read_page: "Opened the cited pages",
  find_receipts: "Looked for acknowledgements",
  validate_source_refs: "Checked each citation word for word",
  check_identifiers: "Compared claim references",
};
const CORRECTION: Record<string, string> = {
  citation:
    "A quoted passage was not found on the cited page, so the answer was rewritten.",
  targeted_search:
    "The verifier asked for one more targeted search of the documents.",
  unsupported_statements:
    "The verifier found statements the pages did not support, so they were removed.",
};

const seconds = (ms: number | null | undefined) =>
  ms == null
    ? ""
    : ms < 1000
      ? "under 1 s"
      : ms < 60000
        ? (ms / 1000).toFixed(1) + " s"
        : Math.floor(ms / 60000) +
          " min " +
          Math.round((ms % 60000) / 1000) +
          " s";
const count = (n: number, one: string, many = one + "s") =>
  n.toLocaleString() + " " + (n === 1 ? one : many);

function Connector({ label }: { label?: string }) {
  return (
    <div
      className="flex flex-col items-center py-1 text-violet-400"
      aria-hidden="true"
    >
      <span className="h-5 w-0.5 bg-violet-300" />
      {label && (
        <span className="my-1 rounded-full bg-violet-100 px-2.5 py-0.5 text-[11px] font-semibold text-violet-800">
          {label}
        </span>
      )}
      <ArrowDown size={16} className="-mt-1" />
    </div>
  );
}

function Terminal({
  icon: Icon,
  title,
  children,
  tone,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  tone: string;
}) {
  return (
    <div
      className={
        "mx-auto flex w-full max-w-xl items-center gap-3 rounded-full px-5 py-3 text-white shadow-card " +
        tone
      }
    >
      <Icon size={20} className="shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-sm font-bold">{title}</p>
        {children && <p className="text-xs text-white/85">{children}</p>}
      </div>
    </div>
  );
}

function Node({ step, wide }: { step: FlowStep; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  const role = ROLE[step.name] ?? {
    title: step.name,
    does: "",
    icon: Sparkles,
    tone: "from-slate-500 to-slate-600",
    skill: "",
  };
  const Icon = role.icon;
  // A policy step with no model call means the point did not depend on policy wording.
  const skipped =
    step.name === "policy" && !step.model && !step.running && !step.interrupted;
  const toolCalls = step.tools.reduce((sum, tool) => sum + tool.calls, 0);
  const hasDetails = step.tools.length > 0 || !!step.model;
  return (
    <div
      className={
        "card min-w-0 flex-1 overflow-hidden transition " +
        (wide ? "mx-auto w-full max-w-xl " : "") +
        (step.running ? "ring-4 ring-violet-300 " : "") +
        (step.interrupted ? "border-dashed border-amber-400 " : "") +
        (skipped ? "opacity-60" : "")
      }
    >
      <button
        className={
          "flex w-full items-start gap-3 p-4 text-left " +
          (hasDetails ? "" : "cursor-default")
        }
        aria-expanded={hasDetails ? open : undefined}
        // A step with nothing inside stays readable rather than greyed out as a disabled control.
        aria-disabled={!hasDetails}
        onClick={() => hasDetails && setOpen(!open)}
      >
        <span
          className={
            "grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br text-white " +
            role.tone
          }
        >
          {step.running ? (
            <LoaderCircle
              size={19}
              className="animate-spin"
              aria-hidden="true"
            />
          ) : (
            <Icon size={19} aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2">
            <strong className="text-sm font-bold">{role.title}</strong>
            {role.skill && (
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-ink-soft uppercase">
                {role.skill}
              </span>
            )}
          </span>
          <span className="mt-0.5 block text-[13px] leading-snug text-ink-soft">
            {skipped
              ? "Not needed: this point does not depend on policy wording."
              : role.does}
          </span>
          <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-soft">
            {step.running ? (
              <strong className="font-semibold text-violet-700">
                Working now
              </strong>
            ) : step.interrupted ? (
              <strong className="font-semibold text-amber-700">
                Interrupted here
              </strong>
            ) : (
              <span>{seconds(step.duration_ms)}</span>
            )}
            {step.model && (
              <span>
                {count(step.model.calls, "model call")}
                {step.model.tokens > 0 &&
                  " · " + step.model.tokens.toLocaleString() + " tokens"}
              </span>
            )}
            {toolCalls > 0 && <span>{count(toolCalls, "tool call")}</span>}
            {step.name === "plan" && step.facts.results != null && (
              <span>{count(Number(step.facts.results), "point")} found</span>
            )}
          </span>
        </span>
        {hasDetails && (
          <ChevronDown
            size={16}
            className={
              "mt-1 shrink-0 text-muted transition " +
              (open ? "rotate-180" : "")
            }
            aria-hidden="true"
          />
        )}
      </button>
      {open && hasDetails && (
        <ul className="space-y-1.5 border-t border-line bg-violet-50/40 px-4 py-3 text-[13px]">
          {step.tools.map((tool) => (
            <li key={tool.name} className="flex items-start gap-2">
              {tool.passed === false ? (
                <TriangleAlert
                  size={14}
                  className="mt-0.5 shrink-0 text-amber-500"
                  aria-label="Flagged"
                />
              ) : (
                <CircleCheck
                  size={14}
                  className="mt-0.5 shrink-0 text-good"
                  aria-label="Done"
                />
              )}
              <span className="min-w-0 flex-1">
                {TOOL[tool.name] ?? tool.name}
                {tool.passed === false && ": something needs attention"}
                {tool.passed === true && ": passed"}
              </span>
              <span className="shrink-0 text-xs text-muted">
                {tool.calls > 1 ? tool.calls + "× " : ""}
                {tool.passed == null && tool.results > 0
                  ? count(tool.results, "result")
                  : ""}
              </span>
            </li>
          ))}
          {step.model && (
            <li className="flex items-start gap-2">
              <Sparkles
                size={14}
                className="mt-0.5 shrink-0 text-violet-600"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                Asked the model{" "}
                {step.model.calls > 1 ? step.model.calls + " times" : "once"}
              </span>
              <span className="shrink-0 text-xs text-muted">
                {seconds(step.model.duration_ms)}
              </span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function Lane({
  index,
  request,
  passes,
}: {
  index: number;
  request?: FlowRequest;
  passes: FlowPass[];
}) {
  const result = request?.result;
  const working = passes.some((p) => p.steps.some((s) => s.running));
  return (
    <section
      className="rounded-3xl border-2 border-violet-200 bg-white/70 p-4 sm:p-5"
      aria-label={"Point " + (index + 1)}
    >
      <header className="mb-4 flex flex-wrap items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-violet-600 to-fuchsia-600 text-sm font-bold text-white">
          {String(index + 1).padStart(2, "0")}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-violet-700">
            Point {index + 1}
            {request?.category && " · " + (CATEGORY[request.category] ?? "")}
          </p>
          <h3 className="text-sm leading-snug font-bold">
            {request?.text ?? "The insurer's point " + (index + 1)}
          </h3>
        </div>
      </header>
      {passes.map((pass, position) => {
        const reason = pass.steps.at(-1)?.facts.correction_reason;
        return (
          <div key={pass.number + "-" + position}>
            <div className="flex flex-col items-stretch gap-2 lg:flex-row lg:items-start">
              {pass.steps.map((step, i) => (
                <div
                  key={step.id}
                  className="flex min-w-0 flex-1 flex-col items-stretch gap-2 lg:flex-row lg:items-start"
                >
                  {i > 0 && (
                    <ArrowDown
                      size={18}
                      className="mx-auto shrink-0 text-violet-400 lg:mt-6 lg:-rotate-90"
                      aria-hidden="true"
                    />
                  )}
                  <Node step={step} />
                </div>
              ))}
            </div>
            {position < passes.length - 1 && (
              <div className="my-3 flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
                <Repeat2
                  size={18}
                  className="shrink-0 text-amber-500"
                  aria-hidden="true"
                />
                <p>
                  <strong>Correction loop.</strong>{" "}
                  {CORRECTION[String(reason)] ??
                    "The verifier asked for a correction."}{" "}
                  Each point gets one.
                </p>
              </div>
            )}
          </div>
        );
      })}
      <footer className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-sm">
        <Flag size={15} className="text-violet-600" aria-hidden="true" />
        <span className="font-semibold">Outcome</span>
        {result ? (
          <>
            <EvidenceChip value={result.evidence_status} />
            <SubmissionChip value={result.submission_status} />
            {result.policy_position && !result.blocked && (
              <PolicyChip value={result.policy_position} />
            )}
            {result.review_required && (
              <span className="chip border-amber-200 bg-amber-50 text-amber-950">
                <Flag size={12} className="text-amber-500" aria-hidden="true" />
                Sent to review
              </span>
            )}
          </>
        ) : (
          <span className="text-ink-soft">
            {working ? "Being worked out now" : "Not reached"}
          </span>
        )}
      </footer>
    </section>
  );
}

function Attempt({
  attempt,
  number,
  flow,
  caseId,
}: {
  attempt: FlowAttempt;
  number: number;
  flow: Workflow;
  caseId: string;
}) {
  const app = useApp();
  const last = number === flow.attempts.length;
  const lanes = [...new Set(attempt.passes.map((p) => p.request_index))].sort(
    (a, b) => a - b,
  );
  const run = flow.run;
  return (
    <div>
      {flow.attempts.length > 1 && (
        <p className="mb-3 text-center text-xs font-bold tracking-[0.14em] text-violet-700 uppercase">
          Attempt {number} of {flow.attempts.length}
          {number > 1 && " · resumed from the saved checkpoint"}
        </p>
      )}
      <Terminal
        icon={Play}
        title={number > 1 ? "Resumed" : "Analysis started"}
        tone="bg-gradient-to-r from-indigo-600 to-violet-600"
      >
        {date(attempt.started_at)} · {count(flow.totals.documents, "document")}{" "}
        frozen as the input
      </Terminal>
      {attempt.setup.map((step) => (
        <div key={step.id}>
          <Connector />
          <Node step={step} wide />
        </div>
      ))}
      {attempt.plan && (
        <>
          <Connector />
          <Node step={attempt.plan} wide />
        </>
      )}
      {lanes.map((index) => (
        <div key={index}>
          <Connector label={"Point " + (index + 1)} />
          <Lane
            index={index}
            request={flow.requests[index]}
            passes={attempt.passes.filter((p) => p.request_index === index)}
          />
        </div>
      ))}
      {attempt.package && (
        <>
          <Connector label="All points checked" />
          <Node step={attempt.package} wide />
        </>
      )}
      <Connector />
      {attempt.running ? (
        <Terminal
          icon={LoaderCircle}
          title="Still working"
          tone="bg-gradient-to-r from-violet-600 to-fuchsia-600"
        >
          This page updates by itself.
        </Terminal>
      ) : attempt.interrupted || !last ? (
        <Terminal
          icon={CirclePause}
          title="Stopped before finishing"
          tone="bg-gradient-to-r from-amber-500 to-orange-500"
        >
          The work so far was saved
          {last ? "." : " and the next attempt carried on from it."}
        </Terminal>
      ) : run.status === "completed" ? (
        <div className="mx-auto flex w-full max-w-xl flex-wrap items-center gap-3 rounded-full bg-gradient-to-r from-emerald-600 to-teal-600 px-5 py-3 text-white shadow-card">
          <CircleCheck size={20} className="shrink-0" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-sm font-bold">
            Report ready
            <span className="block text-xs font-normal text-white/85">
              Finished in {seconds(attempt.duration_ms)}
            </span>
          </p>
          {run.report_id && (
            <button
              className="btn btn-sm bg-white text-emerald-800 hover:bg-emerald-50"
              onClick={() =>
                app.go({ view: "report", caseId, reportId: run.report_id! })
              }
            >
              Open report
              <ArrowUpRight size={15} />
            </button>
          )}
        </div>
      ) : (
        <Terminal
          icon={CirclePause}
          title="Paused"
          tone="bg-gradient-to-r from-amber-500 to-orange-500"
        >
          {run.error ?? "Resume it from the claim's Analyses tab."}
        </Terminal>
      )}
    </div>
  );
}

export function WorkflowView({
  item,
  runId,
  liveStatus,
}: {
  item: ClaimCase;
  runId: string;
  /** Status from the claim's live updates; a change (such as a resume) reloads the chart. */
  liveStatus?: string;
}) {
  const app = useApp();
  const [flow, setFlow] = useState<Workflow | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const result = await api<Workflow>("/analyses/" + runId + "/workflow");
        if (cancelled) return;
        setFlow(result);
        // While the analysis is in progress the chart follows it step by step.
        if (ACTIVE.includes(result.run.status))
          timer = window.setTimeout(() => void load(), 2500);
      } catch (e) {
        if (cancelled) return;
        app.fail(
          e instanceof Error ? e.message : "The workflow is unavailable.",
        );
        app.go({ view: "case", caseId: item.id });
      }
    };
    void load();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [runId, liveStatus]);
  useEffect(() => {
    setFlow(null);
  }, [runId]);

  if (!flow) return <Spinner label="Loading how this analysis ran..." />;
  const totals = flow.totals;
  // A step still in progress has no duration yet, so count from when its attempt began.
  const elapsed =
    totals.duration_ms +
    flow.attempts
      .filter((attempt) => attempt.running)
      .reduce((sum, a) => sum + (Date.now() - Date.parse(a.started_at)), 0);
  return (
    <div className="space-y-6">
      <button
        className="btn btn-ghost btn-sm -ml-2"
        onClick={() => app.go({ view: "case", caseId: item.id })}
      >
        <ArrowLeft size={15} />
        Back to claim
      </button>
      <section className="card p-6 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="eyebrow">Analysis workflow</p>
            <h1 className="mt-1 text-2xl font-bold">How this analysis ran</h1>
            <p className="mt-1 max-w-2xl text-sm text-ink-soft">
              Every step the assistant took for <strong>{item.title}</strong>,
              in order, from the moment it started to the finished report. Open
              a step to see what it did.
            </p>
          </div>
          <RunChip value={flow.run.status} />
        </div>
        <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {[
            ["Time taken", seconds(elapsed) || "0 s"],
            ["Points checked", String(flow.requests.length || "-")],
            ["Model calls", totals.model_calls.toLocaleString()],
            ["Model tokens", totals.tokens.toLocaleString()],
            ["Tool calls", totals.tool_calls.toLocaleString()],
            ["Correction loops", String(totals.corrections)],
          ].map(([label, value]) => (
            <div
              key={label}
              className="rounded-2xl border border-line bg-violet-50/50 px-4 py-3"
            >
              <dt className="text-xs text-ink-soft">{label}</dt>
              <dd className="mt-0.5 text-xl font-semibold">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {!flow.recorded ? (
        <div className="card">
          <Empty
            icon={ListTree}
            title={
              ACTIVE.includes(flow.run.status)
                ? "Waiting for the analysis to start"
                : "No step record for this analysis"
            }
          >
            {ACTIVE.includes(flow.run.status)
              ? "The steps appear here as soon as the analysis worker picks it up."
              : "Steps are recorded for analyses run from this version onwards. Run a new analysis to see its workflow."}
          </Empty>
        </div>
      ) : (
        <div className="space-y-10">
          {flow.attempts.map((attempt, index) => (
            <Attempt
              key={attempt.id}
              attempt={attempt}
              number={index + 1}
              flow={flow}
              caseId={item.id}
            />
          ))}
        </div>
      )}
      <p className="pb-2 text-center text-xs leading-relaxed text-muted">
        This chart is drawn from the recorded steps of this analysis: names,
        timings and counts. Document text is not stored in the step record.
      </p>
    </div>
  );
}
