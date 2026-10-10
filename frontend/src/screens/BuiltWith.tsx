import { useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  CircleCheck,
  Download,
  GitBranch,
  LineChart,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { api, blob, saveFile } from "../api";
import { useApp } from "../app-context";
import type { Integrations } from "../types";

/** The eight things the hackathon asks an agent to show, and where this app does each. */
const FOCUS: [string, string][] = [
  [
    "Planning",
    "The planner splits the insurer's letter into separate points before any work starts.",
  ],
  [
    "Tool use",
    "Agents list documents, search pages, open cited pages and look up acknowledgements.",
  ],
  [
    "State",
    "Every step is checkpointed, and each analysis freezes the document versions it read.",
  ],
  [
    "Context",
    "Each agent receives only the pages for its point; policy wording is read before the answer is written.",
  ],
  [
    "Execution",
    "A queue and worker carry each analysis through to a finished report, letter and attachment list.",
  ],
  [
    "Recovery",
    "A stopped worker restarts itself and resumes interrupted analyses from the last saved step.",
  ],
  [
    "Verification",
    "Citations are checked word for word, then a verifier tests each statement against the cited page.",
  ],
  [
    "Iteration",
    "A failed check sends the point back once for a targeted correction before it is flagged for review.",
  ],
];
const STACK: [string, string, string][] = [
  [
    "LangGraph",
    "langgraph",
    "Runs the planner, policy, evidence and verifier steps and saves a checkpoint after each.",
  ],
  [
    "FastAPI",
    "fastapi",
    "Serves the workspace and accepts requests only from this computer's own interface.",
  ],
  [
    "Pydantic",
    "pydantic",
    "Validates every plan, finding and verdict the model returns.",
  ],
  [
    "SQLite + SQLAlchemy",
    "sqlalchemy",
    "Stores claims, documents, reports, reviews and the step record on this computer.",
  ],
  ["Redis + RQ", "rq", "Queues analyses for the background worker."],
  [
    "PyMuPDF",
    "pymupdf",
    "Extracts page text from PDFs, with Tesseract as the fallback for scans.",
  ],
];
const FRONTEND = "React, TypeScript, Vite, Tailwind CSS and AG Grid";

function Status({ ok, label }: { ok: boolean; label: string }) {
  const Icon = ok ? CircleCheck : TriangleAlert;
  return (
    <span
      className={
        "chip " +
        (ok
          ? "border-emerald-200 bg-emerald-50 text-emerald-900"
          : "border-amber-200 bg-amber-50 text-amber-950")
      }
    >
      <Icon
        size={13}
        className={ok ? "text-good" : "text-amber-500"}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

function Tool({
  icon: Icon,
  name,
  role,
  tone,
  status,
  children,
  facts,
}: {
  icon: LucideIcon;
  name: string;
  role: string;
  tone: string;
  status: ReactNode;
  children: ReactNode;
  facts: [string, string][];
}) {
  return (
    <article className="card flex flex-col overflow-hidden">
      <div className={"bg-gradient-to-r px-5 py-4 text-white " + tone}>
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/20">
            <Icon size={20} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 className="text-lg leading-tight font-bold">{name}</h3>
            <p className="text-xs text-white/85">{role}</p>
          </div>
        </div>
      </div>
      <div className="flex flex-1 flex-col p-5">
        <div className="mb-3">{status}</div>
        <div className="text-sm leading-relaxed text-ink-soft">{children}</div>
        <dl className="mt-4 space-y-1.5 border-t border-line pt-3 text-[13px]">
          {facts.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-3">
              <dt className="text-ink-soft">{label}</dt>
              <dd className="text-right font-semibold break-all">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </article>
  );
}

export function BuiltWith() {
  const app = useApp();
  const [tools, setTools] = useState<Integrations | null>(null);
  useEffect(() => {
    void api<Integrations>("/system/integrations").then(
      setTools,
      () => undefined,
    );
  }, []);
  if (!tools) return null;
  const { neatlogs, entire, cfo_ai } = tools;
  return (
    <section aria-labelledby="built-with" className="space-y-6">
      <div>
        <p className="eyebrow">Built for neatHack 2026</p>
        <h2 id="built-with" className="mt-1 text-xl font-bold">
          How the required tools are used
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          The hackathon requires neatlogs, Entire and cfo.ai. This is what each
          one does here, read from this installation.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Tool
          icon={Activity}
          name="neatlogs"
          role="Traces every agent run"
          tone="from-violet-600 to-indigo-600"
          status={
            <Status
              ok={neatlogs.exporting}
              label={
                neatlogs.exporting
                  ? "Exporting traces"
                  : neatlogs.key_configured
                    ? "Configured, not exporting"
                    : "Recording locally only"
              }
            />
          }
          facts={[
            ["Python SDK", neatlogs.sdk_version ?? "not installed"],
            ["Workflow name", neatlogs.workflow_name],
            ["Analyses traced", neatlogs.analyses_traced.toLocaleString()],
            ["Steps recorded", neatlogs.steps_recorded.toLocaleString()],
          ]}
        >
          Each analysis is one trace: the planner, policy, evidence and verifier
          agents, every tool call and every model call, with timings and token
          counts. Text is masked before it leaves this computer, so only step
          names, counts and IDs are exported. The same steps draw the workflow
          chart for each analysis.
        </Tool>
        <Tool
          icon={GitBranch}
          name="Entire"
          role="Gives coding agents repository context"
          tone="from-sky-600 to-cyan-600"
          status={
            <Status
              ok={entire.enabled}
              label={
                entire.enabled
                  ? "Session tracking enabled"
                  : "Not enabled in this repository"
              }
            />
          }
          facts={[
            ["Agents", "Claude Code, Codex"],
            ["Checkpoints", "One git ref per commit"],
            ["Repository", "Hosted on Entire"],
          ]}
        >
          The code is hosted on Entire, and its hooks record the coding session
          behind each commit as a checkpoint, so the next agent or reviewer can
          see why a change was made. It records development work only: no claim
          or customer document passes through it.
        </Tool>
        <Tool
          icon={LineChart}
          name="cfo.ai"
          role="Plans pricing, costs, revenue and runway"
          tone="from-amber-500 to-orange-500"
          status={
            <Status ok={cfo_ai.months > 0} label="Metrics export ready" />
          }
          facts={[
            ["Months of data", String(cfo_ai.months)],
            ["Analyses counted", cfo_ai.analyses.toLocaleString()],
            ["Contents", "Totals only"],
          ]}
        >
          cfo.ai is where the business plan is built. This app supplies its
          measured inputs: monthly totals (claims, analyses, review load, model
          calls and tokens) as a CSV to import there. No claim content is
          included.
          <button
            className="btn btn-soft btn-sm mt-3 flex"
            disabled={app.busy}
            onClick={() =>
              void app.act(async () =>
                saveFile(
                  await blob(cfo_ai.export),
                  "claimwise-monthly-metrics.csv",
                ),
              )
            }
          >
            <Download size={14} />
            Download metrics CSV
          </button>
        </Tool>
      </div>

      <div className="card p-6">
        <h3 className="text-base font-bold">What the agents demonstrate</h3>
        <dl className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-2 xl:grid-cols-4">
          {FOCUS.map(([name, where]) => (
            <div key={name}>
              <dt className="text-sm font-bold text-violet-700">{name}</dt>
              <dd className="mt-1 text-[13px] leading-relaxed text-ink-soft">
                {where}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="card p-6">
        <h3 className="text-base font-bold">Core stack</h3>
        <ul className="mt-4 grid gap-x-8 gap-y-3 md:grid-cols-2">
          {STACK.map(([name, key, use]) => (
            <li key={name} className="text-[13px] leading-relaxed">
              <strong className="text-sm font-bold">{name}</strong>
              {tools.stack[key] && (
                <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-ink-soft">
                  {tools.stack[key]}
                </span>
              )}
              <span className="block text-ink-soft">{use}</span>
            </li>
          ))}
          <li className="text-[13px] leading-relaxed">
            <strong className="text-sm font-bold">Language model</strong>
            <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-ink-soft">
              {tools.model}
            </span>
            <span className="block text-ink-soft">
              Used for every agent call through Sign in with ChatGPT, with no
              API key stored.
            </span>
          </li>
          <li className="text-[13px] leading-relaxed">
            <strong className="text-sm font-bold">Interface</strong>
            <span className="block text-ink-soft">{FRONTEND}.</span>
          </li>
        </ul>
        <p className="mt-4 border-t border-line pt-3 text-xs text-muted">
          Optional hackathon resources not used: Crustdata, LiteLLM and AWS.
        </p>
      </div>
    </section>
  );
}
