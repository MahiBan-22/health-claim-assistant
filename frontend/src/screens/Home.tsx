import {
  ArrowRight,
  FileSearch,
  FileText,
  FolderOpen,
  ListChecks,
  MessageSquareText,
  Plus,
  Rocket,
  ScanText,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useApp } from "../app-context";
import { BuiltWith } from "./BuiltWith";
import { date } from "../lib";
import type { ClaimCase, Sample } from "../types";
import { Empty, RunChip } from "../ui";

const ACCENT: Record<string, string> = {
  violet: "from-violet-500 to-indigo-500",
  sky: "from-sky-500 to-cyan-500",
  amber: "from-amber-500 to-orange-500",
  rose: "from-rose-500 to-pink-500",
  emerald: "from-emerald-500 to-teal-500",
};
const STEPS = [
  {
    icon: FileText,
    title: "Add the insurer's letter",
    text: "The query, rejection or settlement note that started this.",
  },
  {
    icon: ScanText,
    title: "Add what you hold",
    text: "Bills, medical records, acknowledgements and your policy.",
  },
  {
    icon: FileSearch,
    title: "Get each point checked",
    text: "Every request is matched to the exact page that answers it.",
  },
  {
    icon: MessageSquareText,
    title: "Reply with confidence",
    text: "A response letter, a to-do list and the attachments to send.",
  },
];

export function Home({
  cases,
  samples,
  openSample,
  remove,
}: {
  cases: ClaimCase[];
  samples: Sample[];
  openSample: (sample: Sample) => void;
  remove: (item: ClaimCase) => void;
}) {
  const app = useApp();
  return (
    <div className="space-y-8">
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-violet-700 via-fuchsia-600 to-orange-400 px-6 py-10 text-white shadow-pop sm:px-10 sm:py-12">
        <div
          className="pointer-events-none absolute -top-24 -right-16 size-80 animate-drift rounded-full bg-yellow-300/40 blur-3xl"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute -bottom-28 left-1/3 size-96 animate-drift rounded-full bg-sky-400/40 blur-3xl [animation-delay:-6s]"
          aria-hidden="true"
        />
        <div className="relative max-w-2xl">
          <p className="text-[11px] font-bold tracking-[0.16em] text-white/80 uppercase">
            Your claim, made clear
          </p>
          <h1 className="mt-3 text-3xl leading-tight font-bold sm:text-[2.6rem]">
            Know exactly what your insurer is asking for.
          </h1>
          <p className="mt-4 text-base leading-relaxed text-white/90">
            Upload the insurer's letter and your documents. Claimwise checks
            each request against what you hold, shows what is missing, and
            drafts your reply with the page that proves every point.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <button
              className="btn bg-white text-violet-800 shadow-lg hover:bg-violet-50"
              onClick={() => app.open({ type: "case" })}
            >
              <Plus size={17} />
              Start a new claim
            </button>
            {samples.length > 0 && (
              <button
                className="btn btn-glass"
                onClick={() =>
                  document
                    .getElementById("samples")
                    ?.scrollIntoView({ behavior: "smooth" })
                }
              >
                <Rocket size={16} />
                Try a sample case
              </button>
            )}
          </div>
        </div>
      </section>

      <section
        aria-label="How it works"
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        {STEPS.map(({ icon: Icon, title, text }, index) => (
          <div key={title} className="card flex gap-4 p-5">
            <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-violet-100 to-fuchsia-100 text-violet-700">
              <Icon size={20} aria-hidden="true" />
            </span>
            <div>
              <p className="text-[11px] font-bold tracking-widest text-fuchsia-600">
                STEP {index + 1}
              </p>
              <h3 className="text-sm font-bold">{title}</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
                {text}
              </p>
            </div>
          </div>
        ))}
      </section>

      <section>
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <p className="eyebrow">Your claims</p>
            <h2 className="mt-1 text-xl font-bold">
              Pick up where you left off
            </h2>
          </div>
          <button
            className="btn btn-soft btn-sm"
            onClick={() => app.open({ type: "case" })}
          >
            <Plus size={15} />
            New claim
          </button>
        </div>
        {cases.length ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {cases.map((item) => (
              <article
                key={item.id}
                className="card group relative flex flex-col p-5 transition hover:-translate-y-0.5 hover:border-violet-300"
              >
                <div className="flex items-start gap-3">
                  <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-violet-600 to-fuchsia-600 text-white">
                    <FolderOpen size={20} aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-bold" title={item.title}>
                      {item.title}
                    </h3>
                    <p className="truncate text-xs text-muted">
                      {item.claim_reference}
                    </p>
                  </div>
                  <button
                    className="icon-btn -mt-1 -mr-2 hover:bg-rose-100 hover:text-rose-700"
                    aria-label={"Delete claim " + item.title}
                    disabled={app.busy}
                    onClick={() => remove(item)}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
                <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
                  {[
                    ["Documents", item.document_count],
                    ["Analyses", item.analysis_count],
                    ["Reports", item.report_count],
                  ].map(([label, value]) => (
                    <div
                      key={label}
                      className="rounded-xl bg-violet-50/70 py-2"
                    >
                      <dd className="text-lg font-bold">{value ?? 0}</dd>
                      <dt className="text-[11px] text-ink-soft">{label}</dt>
                    </div>
                  ))}
                </dl>
                <div className="mt-4 flex items-center justify-between gap-3">
                  {item.latest_status ? (
                    <RunChip value={item.latest_status} />
                  ) : (
                    <span className="text-xs text-muted">
                      {date(item.created_at)}
                    </span>
                  )}
                  <button
                    className="btn btn-ghost btn-sm text-violet-700"
                    onClick={() => app.go({ view: "case", caseId: item.id })}
                  >
                    Open claim
                    <ArrowRight size={15} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="card">
            <Empty icon={ListChecks} title="No claims yet">
              Create a claim for the letter you received, or open a sample below
              to see how a finished report looks.
            </Empty>
          </div>
        )}
      </section>

      {samples.length > 0 && (
        <section id="samples" className="scroll-mt-24">
          <p className="eyebrow">Explore safely</p>
          <h2 className="mt-1 text-xl font-bold">
            Sample cases with made-up documents
          </h2>
          <p className="mt-1 mb-4 max-w-2xl text-sm text-ink-soft">
            Each sample loads fictional documents for a common situation, so you
            can run a real analysis and see the result before using your own
            papers.
          </p>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {samples.map((sample) => (
              <article
                key={sample.key}
                className="card flex flex-col overflow-hidden"
              >
                <div
                  className={
                    "bg-gradient-to-r px-5 py-4 text-white " +
                    (ACCENT[sample.accent] ?? ACCENT.violet)
                  }
                >
                  <p className="text-[11px] font-bold tracking-wider uppercase opacity-90">
                    {sample.scenario}
                  </p>
                  <h3 className="mt-1 text-lg leading-snug font-bold">
                    {sample.title}
                  </h3>
                </div>
                <div className="flex flex-1 flex-col p-5">
                  <p className="text-sm leading-relaxed text-ink-soft">
                    {sample.summary}
                  </p>
                  <ul className="mt-3 space-y-1.5 text-[13px] text-ink">
                    {sample.what_to_expect.map((line) => (
                      <li key={line} className="flex gap-2">
                        <Sparkles
                          size={14}
                          className="mt-0.5 shrink-0 text-fuchsia-500"
                          aria-hidden="true"
                        />
                        {line}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-auto flex items-center justify-between pt-5">
                    <span className="text-xs text-muted">
                      {sample.document_count} documents
                    </span>
                    <button
                      className="btn btn-soft btn-sm"
                      disabled={app.busy}
                      onClick={() => openSample(sample)}
                    >
                      Open this sample
                      <ArrowRight size={15} />
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      <BuiltWith />
    </div>
  );
}
