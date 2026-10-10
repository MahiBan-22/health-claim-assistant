import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ClipboardCheck,
  Copy,
  Download,
  FileText,
  Flag,
  GitCompareArrows,
  ListChecks,
  Mail,
  PackageOpen,
  Quote,
  Save,
  ShieldAlert,
  TriangleAlert,
  Undo2,
  Workflow,
} from "lucide-react";
import { api, blob, saveFile, send } from "../api";
import { useApp } from "../app-context";
import { CATEGORY, EVIDENCE, date, refsOf, reviewReasons } from "../lib";
import type { ClaimCase, Decision, Finding, Report, Run } from "../types";
import {
  DecisionChip,
  EvidenceChip,
  KindChip,
  PolicyChip,
  Spinner,
  StatusBar,
  SubmissionChip,
} from "../ui";

const FindingsGrid = lazy(() =>
  import("../grids").then((m) => ({ default: m.FindingsGrid })),
);

const words = (text: string) =>
  new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
/** Request IDs are assigned per run, so earlier findings are matched on the wording of the request. */
function matchPrevious(report: Report, previous: Report) {
  const result = new Map<string, Finding>();
  const taken = new Set<string>();
  for (const request of report.requests) {
    const mine = words(request.text);
    let best: { score: number; id: string } | null = null;
    for (const other of previous.requests) {
      if (taken.has(other.request_id)) continue;
      const theirs = words(other.text);
      const shared = [...mine].filter((word) => theirs.has(word)).length;
      const score = shared / Math.max(1, mine.size + theirs.size - shared);
      if (score >= 0.4 && (!best || score > best.score))
        best = { score, id: other.request_id };
    }
    const finding =
      best && previous.findings.find((f) => f.request_id === best.id);
    if (best && finding) {
      taken.add(best.id);
      result.set(request.request_id, finding);
    }
  }
  return result;
}

export function ReportView({
  item,
  report,
  runs,
  onReport,
}: {
  item: ClaimCase;
  report: Report;
  runs: Run[];
  onReport: (report: Report) => void;
}) {
  const app = useApp();
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [draft, setDraft] = useState(
    report.customer_draft ?? report.response_draft,
  );
  const [previous, setPrevious] = useState<Report | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const done = new Set(report.completed_actions ?? []);
  const saved = report.customer_draft ?? report.response_draft;
  const names = useMemo(
    () =>
      new Map(
        (report.input_versions ?? report.attachment_manifest ?? []).map((d) => [
          "id" in d ? d.id : d.document_id,
          d.filename,
        ]),
      ),
    [report],
  );
  const requestOf = (finding: Finding) =>
    report.requests.find((r) => r.request_id === finding.request_id);
  const earlier = useMemo(() => {
    const withReports = runs.filter((run) => run.report_id);
    const index = withReports.findIndex((run) => run.report_id === report.id);
    return index >= 0 ? withReports[index + 1] : undefined;
  }, [runs, report.id]);
  const changes = useMemo(
    () => (previous ? matchPrevious(report, previous) : null),
    [report, previous],
  );

  useEffect(() => {
    setDraft(report.customer_draft ?? report.response_draft);
    setPrevious(null);
    let cancelled = false;
    api<Decision[]>("/reports/" + report.id + "/reviews")
      .then((result) => !cancelled && setDecisions(result))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [report.id]);

  const total = report.findings.length;
  const supported = report.findings.filter(
    (f) => f.evidence_status === "satisfied",
  ).length;
  const confirmed = report.findings.filter(
    (f) => f.submission_status === "confirmed_by_receipt",
  ).length;
  const flagged = report.findings.filter((f) => f.review_required).length;
  const segments = Object.entries(EVIDENCE).map(([key, meta]) => ({
    key,
    label: meta.label,
    tone: meta.tone,
    value: report.findings.filter((f) => f.evidence_status === key).length,
  }));

  const pick = (requestId: string) => {
    document
      .getElementById("finding-" + requestId)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlash(requestId);
    window.setTimeout(() => setFlash(null), 1600);
  };
  const toggle = (requestId: string) => {
    const completed = done.has(requestId)
      ? [...done].filter((id) => id !== requestId)
      : [...done, requestId];
    onReport({ ...report, completed_actions: completed });
    void send("/reports/" + report.id + "/checklist", "PUT", {
      completed,
    }).catch((e: Error) => app.fail(e.message));
  };
  const saveDraft = (text: string, message: string) =>
    void app.act(async () => {
      await send("/reports/" + report.id + "/draft", "PUT", { text });
      onReport({
        ...report,
        customer_draft:
          text.trim() && text !== report.response_draft ? text : null,
      });
      if (!text.trim()) setDraft(report.response_draft);
      app.notify(message);
    });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <button
          className="btn btn-ghost btn-sm -ml-2"
          onClick={() => app.go({ view: "case", caseId: item.id })}
        >
          <ArrowLeft size={15} />
          Back to claim
        </button>
        <div className="ml-auto flex flex-wrap gap-2">
          <button
            className="btn btn-soft btn-sm"
            onClick={() =>
              app.go({
                view: "workflow",
                caseId: item.id,
                runId: report.run_id,
              })
            }
          >
            <Workflow size={15} />
            How this was produced
          </button>
          {earlier && (
            <button
              className={
                "btn btn-sm " +
                (previous ? "bg-violet-100 text-violet-900" : "btn-soft")
              }
              aria-pressed={!!previous}
              disabled={app.busy}
              onClick={() =>
                previous
                  ? setPrevious(null)
                  : void app.act(async () =>
                      setPrevious(
                        await api<Report>("/reports/" + earlier.report_id),
                      ),
                    )
              }
            >
              <GitCompareArrows size={15} />
              {previous ? "Hide comparison" : "Compare with previous report"}
            </button>
          )}
          <button
            className="btn btn-primary btn-sm"
            disabled={app.busy}
            onClick={() =>
              void app.act(async () =>
                saveFile(
                  await blob("/reports/" + report.id + "/package"),
                  "claim-response-package-v" + report.version + ".zip",
                ),
              )
            }
          >
            <PackageOpen size={15} />
            Download response package
          </button>
        </div>
      </div>

      <section className="card overflow-hidden">
        <div className="grid gap-0 lg:grid-cols-[19rem_minmax(0,1fr)]">
          <div className="bg-gradient-to-br from-violet-700 to-fuchsia-600 p-7 text-white">
            <p className="text-[11px] font-bold tracking-[0.14em] text-white/80 uppercase">
              Evidence report · version {report.version}
            </p>
            <p className="mt-5 text-6xl leading-none font-bold">
              {supported}
              <span className="text-3xl font-semibold text-white/70">
                {" "}
                of {total}
              </span>
            </p>
            <p className="mt-3 text-sm leading-relaxed text-white/90">
              {total === 1 ? "point" : "points"} the insurer raised{" "}
              {supported === 1 ? "is" : "are"} fully supported by your
              documents.
            </p>
            <p className="mt-5 text-xs text-white/70">
              {item.title} · {date(report.created_at)}
            </p>
          </div>
          <div className="p-7">
            <h1 className="text-xl font-bold">The evidence, explained.</h1>
            <p className="mt-1 mb-5 text-sm text-ink-soft">
              How your documents answer each point in the insurer's letter.
              Hover a segment for the count.
            </p>
            <StatusBar segments={segments} total={total} unit="points" />
            <dl className="mt-6 grid gap-3 sm:grid-cols-3">
              {[
                {
                  label: "Proof of receipt on file",
                  value: confirmed + " of " + total,
                },
                { label: "Need a reviewer", value: String(flagged) },
                {
                  label: "Documents cited",
                  value: String(report.attachment_manifest?.length ?? 0),
                },
              ].map((stat) => (
                <div
                  key={stat.label}
                  className="rounded-2xl border border-line bg-violet-50/50 px-4 py-3"
                >
                  <dt className="text-xs text-ink-soft">{stat.label}</dt>
                  <dd className="mt-0.5 text-xl font-semibold">{stat.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>

      {(report.warnings ?? []).map((warning) => (
        <div
          key={warning}
          className="flex items-start gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
          role="alert"
        >
          <TriangleAlert
            size={19}
            className="mt-0.5 shrink-0 text-amber-500"
            aria-hidden="true"
          />
          <p>{warning}</p>
        </div>
      ))}
      {flagged > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-violet-200 bg-violet-50 p-4 text-sm">
          <ShieldAlert
            size={19}
            className="shrink-0 text-violet-600"
            aria-hidden="true"
          />
          <p className="min-w-0 flex-1">
            <strong>
              {flagged} {flagged === 1 ? "point needs" : "points need"} a person
              to check.
            </strong>{" "}
            Records disagree, wording is ambiguous, or an answer could not be
            verified. These stay marked until a reviewer records a decision.
          </p>
          <button
            className="btn btn-soft btn-sm"
            onClick={() => app.go({ view: "review" })}
          >
            Open review desk
            <ArrowRight size={15} />
          </button>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="card min-w-0 overflow-hidden">
          <div className="border-b border-line px-5 py-4">
            <h2 className="text-base font-bold">At a glance</h2>
            <p className="text-sm text-ink-soft">
              Select a row to jump to the full explanation.
            </p>
          </div>
          <Suspense fallback={<Spinner label="Loading findings..." />}>
            <FindingsGrid report={report} onPick={pick} />
          </Suspense>
        </section>
        <section className="card p-5">
          <h2 className="flex items-center gap-2 text-base font-bold">
            <ListChecks
              size={18}
              className="text-violet-600"
              aria-hidden="true"
            />
            Your next steps
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            {done.size} of {total} done. Tick each one off as you go.
          </p>
          <div
            className="mt-3 h-2 overflow-hidden rounded-full bg-violet-100"
            aria-hidden="true"
          >
            <div
              className="h-full rounded-full bg-violet-600 transition-all"
              style={{ width: (total ? (done.size / total) * 100 : 0) + "%" }}
            />
          </div>
          <ul className="mt-4 space-y-2.5">
            {report.findings.map((finding) => (
              <li key={finding.request_id}>
                <label
                  className={
                    "flex cursor-pointer gap-3 rounded-xl border p-3 text-sm transition " +
                    (done.has(finding.request_id)
                      ? "border-emerald-200 bg-emerald-50/60 text-ink-soft line-through"
                      : "border-line hover:border-violet-300")
                  }
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 shrink-0 accent-violet-600"
                    checked={done.has(finding.request_id)}
                    onChange={() => toggle(finding.request_id)}
                  />
                  <span className="leading-snug">{finding.next_action}</span>
                </label>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {report.findings.map((finding, index) => {
        const request = requestOf(finding);
        const before = changes?.get(finding.request_id);
        const history = decisions.filter(
          (d) => d.request_id === finding.request_id,
        );
        return (
          <section
            key={finding.request_id}
            id={"finding-" + finding.request_id}
            className={
              "card scroll-mt-24 p-6 transition-shadow duration-500 " +
              (flash === finding.request_id ? "ring-4 ring-violet-300" : "")
            }
          >
            <div className="flex gap-4">
              <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-violet-600 to-fuchsia-600 text-sm font-bold text-white">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div className="min-w-0 flex-1">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  {request?.category && (
                    <span className="chip border-line bg-white text-ink-soft">
                      {CATEGORY[request.category] ?? request.category}
                    </span>
                  )}
                  <EvidenceChip value={finding.evidence_status} />
                  <SubmissionChip value={finding.submission_status} />
                  {finding.policy_position && !finding.blocked && (
                    <PolicyChip value={finding.policy_position} />
                  )}
                  {finding.review_required && (
                    <span className="chip border-amber-200 bg-amber-50 text-amber-950">
                      <Flag
                        size={12}
                        className="text-amber-500"
                        aria-hidden="true"
                      />
                      Review needed
                    </span>
                  )}
                </div>
                <h3 className="text-base leading-snug font-bold">
                  {request?.text ?? "Evidence finding"}
                </h3>
              </div>
            </div>
            <div className="mt-4 space-y-4 sm:pl-15">
              {changes && (
                <p className="flex flex-wrap items-center gap-2 rounded-xl bg-sky-50 px-3 py-2 text-sm text-sky-950">
                  <GitCompareArrows
                    size={15}
                    className="text-sky-600"
                    aria-hidden="true"
                  />
                  {!before ? (
                    "New since the previous report."
                  ) : before.evidence_status === finding.evidence_status &&
                    before.submission_status === finding.submission_status ? (
                    "Unchanged since the previous report."
                  ) : (
                    <>
                      Previously <EvidenceChip value={before.evidence_status} />{" "}
                      <ArrowRight size={14} /> now{" "}
                      <EvidenceChip value={finding.evidence_status} />
                    </>
                  )}
                </p>
              )}
              <div>
                <h4 className="eyebrow mb-1.5">What we found</h4>
                <p className="text-[15px] leading-relaxed whitespace-pre-line text-ink">
                  {finding.explanation}
                </p>
              </div>
              {refsOf(finding).length > 0 && (
                <div>
                  <h4 className="eyebrow mb-2">Where it says so</h4>
                  <div className="grid gap-2 md:grid-cols-2">
                    {refsOf(finding).map(({ ref, type }, i) => (
                      <button
                        key={i}
                        className="group flex gap-3 rounded-xl border border-line p-3 text-left transition hover:border-violet-400 hover:bg-violet-50/60"
                        onClick={() => app.cite(report.case_id, ref)}
                      >
                        <Quote
                          size={16}
                          className="mt-0.5 shrink-0 text-fuchsia-500"
                          aria-hidden="true"
                        />
                        <span className="min-w-0">
                          <span className="line-clamp-2 text-[13px] leading-snug text-ink italic">
                            {ref.quote}
                          </span>
                          <span className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-ink-soft">
                            <strong className="font-semibold text-violet-700">
                              {type}
                            </strong>
                            <span className="truncate">
                              {names.get(ref.document_id) ?? "Source document"}
                            </span>
                            <span>
                              v{ref.version} · p. {ref.page}
                            </span>
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {finding.unresolved_questions.length > 0 && (
                <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4">
                  <h4 className="text-sm font-bold text-amber-950">
                    Still open
                  </h4>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-amber-950">
                    {finding.unresolved_questions.map((question, i) => (
                      <li key={i}>{question}</li>
                    ))}
                  </ul>
                </div>
              )}
              {reviewReasons(finding).length > 0 && (
                <div className="rounded-xl border border-violet-200 bg-violet-50/60 p-4">
                  <h4 className="flex items-center gap-2 text-sm font-bold">
                    <ShieldAlert
                      size={15}
                      className="text-violet-600"
                      aria-hidden="true"
                    />
                    Why a person needs to check this
                  </h4>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-ink">
                    {reviewReasons(finding).map((reason, i) => (
                      <li key={i}>{reason}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="flex gap-3 rounded-xl bg-gradient-to-r from-violet-50 to-fuchsia-50 p-4">
                <ArrowRight
                  size={18}
                  className="mt-0.5 shrink-0 text-violet-600"
                  aria-hidden="true"
                />
                <div>
                  <h4 className="text-sm font-bold">Your next step</h4>
                  <p className="mt-0.5 text-sm leading-relaxed text-ink">
                    {finding.next_action}
                  </p>
                </div>
              </div>
              {app.reviewer &&
                (finding.verification || finding.withheld_explanation) && (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm">
                    <h4 className="font-bold">
                      Reviewer notes (not shown to the customer)
                    </h4>
                    {finding.verification && (
                      <p className="mt-1 text-ink-soft">
                        Verifier decision:{" "}
                        {finding.verification.decision.replaceAll("_", " ")}.
                      </p>
                    )}
                    {finding.withheld_explanation && (
                      <p className="mt-2 whitespace-pre-line text-ink-soft">
                        Unverified draft wording: {finding.withheld_explanation}
                      </p>
                    )}
                  </div>
                )}
              {history.map((decision) => (
                <div
                  key={decision.id}
                  className="flex flex-wrap items-start gap-3 rounded-xl border border-line p-4 text-sm"
                >
                  <ClipboardCheck
                    size={17}
                    className="mt-0.5 shrink-0 text-violet-600"
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <DecisionChip value={decision.decision} />
                      <span className="text-ink-soft">
                        {decision.reviewer} · {date(decision.created_at)}
                      </span>
                    </p>
                    <p className="mt-1.5 leading-relaxed">
                      {decision.rationale}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}

      <section className="card p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-bold">
              <Mail size={18} className="text-violet-600" aria-hidden="true" />
              Your reply to the insurer
              {report.customer_draft && (
                <span className="chip border-sky-200 bg-sky-50 text-sky-900">
                  Edited by you
                </span>
              )}
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-ink-soft">
              Built only from the verified findings above. Edit it freely, add
              your name, then send it yourself. Nothing is sent from this app.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="btn btn-soft btn-sm"
              onClick={() =>
                void navigator.clipboard.writeText(draft).then(
                  () => app.notify("Letter copied."),
                  () =>
                    app.fail(
                      "Copy is not available in this browser. Select the text and copy it manually.",
                    ),
                )
              }
            >
              <Copy size={14} />
              Copy
            </button>
            <button
              className="btn btn-soft btn-sm"
              onClick={() =>
                saveFile(
                  new Blob([draft], { type: "text/plain" }),
                  "response-letter-" +
                    (report.claim_reference ?? item.claim_reference) +
                    ".txt",
                )
              }
            >
              <Download size={14} />
              Download
            </button>
          </div>
        </div>
        <textarea
          className="input mt-4 min-h-80 font-mono text-[13px] leading-relaxed"
          aria-label="Response letter"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {report.customer_draft && (
            <button
              className="btn btn-ghost btn-sm"
              disabled={app.busy}
              onClick={() =>
                saveDraft("", "Letter restored to the generated version.")
              }
            >
              <Undo2 size={14} />
              Restore generated letter
            </button>
          )}
          <button
            className="btn btn-primary btn-sm"
            disabled={app.busy || draft === saved}
            onClick={() =>
              saveDraft(
                draft,
                "Your edits are saved and will be used in the response package.",
              )
            }
          >
            <Save size={14} />
            Save edits
          </button>
        </div>
      </section>

      {(report.attachment_manifest?.length ?? 0) > 0 && (
        <section className="card p-6">
          <h2 className="text-base font-bold">
            Attachments to send with your reply
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            The documents the findings rely on. They are included in the
            response package.
          </p>
          <ul className="mt-4 grid gap-2 md:grid-cols-2">
            {report.attachment_manifest.map((attachment) => (
              <li key={attachment.document_id}>
                <button
                  className="flex w-full items-center gap-3 rounded-xl border border-line p-3 text-left text-sm hover:border-violet-400 hover:bg-violet-50/60"
                  onClick={() =>
                    app.open({
                      type: "document",
                      caseId: report.case_id,
                      documentId: attachment.document_id,
                    })
                  }
                >
                  <FileText
                    size={17}
                    className="shrink-0 text-violet-600"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate font-semibold">
                    {attachment.filename}
                  </span>
                  {attachment.kind && <KindChip value={attachment.kind} />}
                  <span className="text-xs text-muted">
                    v{attachment.version}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="pb-2 text-center text-xs leading-relaxed text-muted">
        Prepared by {report.model} from the documents in this claim. It explains
        evidence; it is not a coverage decision, legal advice or a promise of
        payment.
      </p>
    </div>
  );
}
