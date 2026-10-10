import { lazy, Suspense, useEffect, useState } from "react";
import {
  ArrowUpRight,
  ClipboardCheck,
  Quote,
  ShieldCheck,
  UserRoundCheck,
} from "lucide-react";
import { api, send } from "../api";
import { useApp } from "../app-context";
import { date, refsOf, reviewReasons } from "../lib";
import type { Decision, QueueItem } from "../types";
import {
  DecisionChip,
  Empty,
  EvidenceChip,
  Spinner,
  SubmissionChip,
} from "../ui";

const QueueGrid = lazy(() =>
  import("../grids").then((m) => ({ default: m.QueueGrid })),
);

export function ReviewDesk({
  setReviewer,
  setReviewerName,
}: {
  setReviewer: (value: boolean) => void;
  setReviewerName: (value: string) => void;
}) {
  const app = useApp();
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [scope, setScope] = useState<"open" | "all">("open");
  const [rationale, setRationale] = useState("");

  const load = () => api<QueueItem[]>("/review-queue").then(setItems);
  useEffect(() => {
    if (!app.reviewer) {
      setItems(null);
      return;
    }
    void load().catch((e: Error) => app.fail(e.message));
  }, [app.reviewer]);

  if (!app.reviewer)
    return (
      <div className="card mx-auto max-w-2xl">
        <Empty icon={UserRoundCheck} title="The review desk is for reviewers">
          <p>
            Reviewers check the points the assistant could not settle on its
            own, such as conflicting records or ambiguous policy wording, and
            record a decision with a reason. Every decision is kept in the
            claim's history.
          </p>
          <button
            className="btn btn-primary mx-auto mt-5"
            onClick={() => setReviewer(true)}
          >
            <ShieldCheck size={16} />
            Switch to reviewer mode
          </button>
        </Empty>
      </div>
    );
  if (!items) return <Spinner label="Loading the review queue..." />;

  // Only the newest report of each claim is actionable; older ones stay visible under "All".
  const shown = items.filter(
    (item) => scope === "all" || (item.current && !item.decisions.length),
  );
  const current = items.find((item) => item.task_id === selected) ?? null;
  const waiting = items.filter(
    (item) => item.current && !item.decisions.length,
  ).length;

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Human judgment, documented</p>
          <h1 className="mt-1 text-2xl font-bold">Review desk</h1>
          <p className="mt-1 text-sm text-ink-soft">
            {waiting} {waiting === 1 ? "point is" : "points are"} waiting for a
            decision across all claims.
          </p>
        </div>
        <label className="text-sm font-semibold">
          Reviewer name
          <input
            className="input w-56"
            value={app.reviewerName}
            maxLength={80}
            placeholder="Recorded with each decision"
            onChange={(e) => setReviewerName(e.target.value)}
          />
        </label>
      </section>

      <section className="card overflow-hidden">
        <div
          className="flex flex-wrap items-center gap-1 border-b border-line p-3"
          role="tablist"
          aria-label="Queue filter"
        >
          {(
            [
              ["open", "Awaiting decision", waiting],
              ["all", "All flagged points", items.length],
            ] as const
          ).map(([id, label, count]) => (
            <button
              key={id}
              role="tab"
              aria-selected={scope === id}
              className={"tab " + (scope === id ? "tab-active" : "")}
              onClick={() => setScope(id)}
            >
              {label}
              <span className="count">{count}</span>
            </button>
          ))}
        </div>
        {shown.length ? (
          <Suspense fallback={<Spinner label="Loading..." />}>
            <QueueGrid
              items={shown}
              onPick={(item) => {
                setSelected(item.task_id);
                setRationale("");
              }}
            />
          </Suspense>
        ) : (
          <Empty icon={ClipboardCheck} title="Nothing is waiting for review">
            Points the assistant flags for a person will appear here.
          </Empty>
        )}
      </section>

      {current && (
        <section className="card animate-rise p-6" aria-label="Selected point">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs text-muted">
                {current.case_title} · {current.claim_reference} · report v
                {current.report_version}
                {!current.current && " (superseded by a newer report)"}
              </p>
              <h2 className="mt-1 text-lg leading-snug font-bold">
                {current.request}
              </h2>
              <div className="mt-2 flex flex-wrap gap-2">
                <EvidenceChip value={current.finding.evidence_status} />
                <SubmissionChip value={current.finding.submission_status} />
              </div>
            </div>
            <button
              className="btn btn-soft btn-sm"
              onClick={() =>
                app.go({
                  view: "report",
                  caseId: current.case_id,
                  reportId: current.report_id,
                })
              }
            >
              Open full report
              <ArrowUpRight size={15} />
            </button>
          </div>

          <div className="mt-5 grid gap-6 lg:grid-cols-2">
            <div className="space-y-4">
              <div>
                <h3 className="eyebrow mb-1.5">Shown to the customer</h3>
                <p className="text-sm leading-relaxed whitespace-pre-line">
                  {current.finding.explanation}
                </p>
              </div>
              {current.finding.withheld_explanation && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <h3 className="text-sm font-bold">
                    Unverified draft wording (withheld)
                  </h3>
                  <p className="mt-1 text-sm leading-relaxed whitespace-pre-line text-ink-soft">
                    {current.finding.withheld_explanation}
                  </p>
                </div>
              )}
              <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4">
                <h3 className="text-sm font-bold text-amber-950">
                  Why it was flagged
                </h3>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-amber-950">
                  {reviewReasons(current.finding).map((reason, i) => (
                    <li key={i}>{reason}</li>
                  ))}
                </ul>
              </div>
              {refsOf(current.finding).length > 0 && (
                <div>
                  <h3 className="eyebrow mb-2">Cited sources</h3>
                  <div className="space-y-2">
                    {refsOf(current.finding).map(({ ref, type }, i) => (
                      <button
                        key={i}
                        className="flex w-full gap-3 rounded-xl border border-line p-3 text-left hover:border-violet-400 hover:bg-violet-50/60"
                        onClick={() => app.cite(current.case_id, ref)}
                      >
                        <Quote
                          size={16}
                          className="mt-0.5 shrink-0 text-fuchsia-500"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 text-[13px]">
                          <span className="line-clamp-2 italic">
                            {ref.quote}
                          </span>
                          <span className="mt-1 block text-xs text-ink-soft">
                            {type} · version {ref.version} · page {ref.page}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-4">
              <form
                className="rounded-2xl border border-violet-200 bg-violet-50/50 p-5"
                onSubmit={(e) => {
                  e.preventDefault();
                  const decision = new FormData(e.currentTarget).get(
                    "decision",
                  );
                  void app.act(async () => {
                    await send<Decision>(
                      "/tasks/" +
                        encodeURIComponent(current.task_id) +
                        "/review",
                      "POST",
                      {
                        decision,
                        rationale,
                        reviewer_name:
                          app.reviewerName.trim() || "Local reviewer",
                      },
                    );
                    setRationale("");
                    await load();
                    app.notify(
                      "Decision recorded in the claim's review history.",
                    );
                  });
                }}
              >
                <h3 className="text-base font-bold">Record a decision</h3>
                <fieldset className="mt-3 space-y-2">
                  <legend className="sr-only">Decision</legend>
                  {[
                    [
                      "approved",
                      "Approve the finding",
                      "The cited records support what is shown to the customer.",
                    ],
                    [
                      "request_evidence",
                      "Request evidence",
                      "More or clearer documents are needed before this can be settled.",
                    ],
                    [
                      "override",
                      "Record an override",
                      "You are replacing the finding with your own reasoned conclusion.",
                    ],
                  ].map(([value, label, hint], index) => (
                    <label
                      key={value}
                      className="flex cursor-pointer gap-3 rounded-xl border border-line bg-white p-3 text-sm has-checked:border-violet-500 has-checked:ring-2 has-checked:ring-violet-200"
                    >
                      <input
                        type="radio"
                        name="decision"
                        value={value}
                        defaultChecked={index === 0}
                        className="mt-0.5 accent-violet-600"
                      />
                      <span>
                        <strong className="font-semibold">{label}</strong>
                        <span className="block text-[13px] text-ink-soft">
                          {hint}
                        </span>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <label className="field mt-4 mb-0">
                  Reason
                  <textarea
                    className="input min-h-28"
                    required
                    minLength={10}
                    maxLength={4000}
                    placeholder="Which records did you check, and what do they show?"
                    value={rationale}
                    onChange={(e) => setRationale(e.target.value)}
                  />
                </label>
                <button
                  className="btn btn-primary mt-4 w-full"
                  disabled={app.busy}
                >
                  <ClipboardCheck size={16} />
                  Record decision
                </button>
              </form>
              {current.decisions.length > 0 && (
                <div>
                  <h3 className="eyebrow mb-2">Decision history</h3>
                  <ul className="space-y-2">
                    {[...current.decisions].reverse().map((decision) => (
                      <li
                        key={decision.id}
                        className="rounded-xl border border-line p-3 text-sm"
                      >
                        <p className="flex flex-wrap items-center gap-2">
                          <DecisionChip value={decision.decision} />
                          <span className="text-xs text-ink-soft">
                            {decision.reviewer} · {date(decision.created_at)}
                          </span>
                        </p>
                        <p className="mt-1.5 leading-relaxed">
                          {decision.rationale}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
