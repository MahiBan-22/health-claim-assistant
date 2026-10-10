import type { Finding } from "./types";

export const human = (text: string) => text.replaceAll("_", " ");
export const date = (text?: string) =>
  text
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(text))
    : "";
export const day = (text: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(text + "T00:00:00"),
  );

export type Tone =
  "good" | "warn" | "neutral" | "serious" | "critical" | "info";

/** What each evidence status means, in the customer's words. Order is the order used in charts. */
export const EVIDENCE: Record<
  string,
  { label: string; plain: string; tone: Tone }
> = {
  satisfied: {
    label: "Supported",
    plain: "Your documents answer this point.",
    tone: "good",
  },
  partially_satisfied: {
    label: "Partly supported",
    plain:
      "Something related is on file, but part of what was asked is missing or different.",
    tone: "warn",
  },
  not_found_in_available_records: {
    label: "Not in your documents",
    plain: "Nothing in this case answers this point yet.",
    tone: "neutral",
  },
  conflicting_evidence: {
    label: "Needs a closer look",
    plain: "Records disagree, or the answer could not be verified.",
    tone: "critical",
  },
  unreadable: {
    label: "Unreadable",
    plain: "A page could not be read. A clearer copy is needed.",
    tone: "serious",
  },
};
export const SUBMISSION: Record<
  string,
  { label: string; plain: string; tone: Tone }
> = {
  confirmed_by_receipt: {
    label: "Receipt confirmed",
    plain: "An acknowledgement names this exact document.",
    tone: "good",
  },
  customer_reported: {
    label: "Sent, no receipt",
    plain: "You reported sending it, but no acknowledgement is on file.",
    tone: "warn",
  },
  not_established: {
    label: "No proof of receipt",
    plain: "Nothing on file shows the insurer received this.",
    tone: "neutral",
  },
};
export const RUN: Record<string, { label: string; tone: Tone }> = {
  queued: { label: "Waiting to start", tone: "info" },
  running: { label: "Analysing", tone: "info" },
  paused: { label: "Paused", tone: "warn" },
  completed: { label: "Report ready", tone: "good" },
};
export const EXTRACTION: Record<string, { label: string; tone: Tone }> = {
  extracted: { label: "Readable", tone: "good" },
  ready: { label: "Readable", tone: "good" },
  unreadable: { label: "Unreadable", tone: "serious" },
};
/** How the supplied policy wording bears on the insurer's stated reason. A reading aid, not a coverage decision. */
export const POLICY_POSITION: Record<
  string,
  { label: string; plain: string; tone: Tone }
> = {
  supports_insurer: {
    label: "Wording matches insurer's reason",
    plain:
      "The policy wording you supplied is consistent with the reason the insurer gave.",
    tone: "neutral",
  },
  contradicts_insurer: {
    label: "Wording does not match insurer's reason",
    plain:
      "A schedule term, endorsement, definition or date in your policy points the other way.",
    tone: "critical",
  },
  does_not_address: {
    label: "Wording is silent",
    plain: "The policy wording you supplied does not deal with this point.",
    tone: "warn",
  },
  unclear: {
    label: "Wording unclear",
    plain: "Facts needed to apply the wording are missing.",
    tone: "warn",
  },
};
export const DECISION: Record<string, { label: string; tone: Tone }> = {
  approved: { label: "Approved", tone: "good" },
  request_evidence: { label: "Evidence requested", tone: "warn" },
  override: { label: "Override recorded", tone: "critical" },
};
export const TONE: Record<Tone, { chip: string; dot: string; fill: string }> = {
  good: {
    chip: "border-emerald-200 bg-emerald-50 text-emerald-900",
    dot: "text-good",
    fill: "bg-good",
  },
  warn: {
    chip: "border-amber-200 bg-amber-50 text-amber-950",
    dot: "text-amber-500",
    fill: "bg-warn",
  },
  neutral: {
    chip: "border-slate-200 bg-slate-50 text-slate-800",
    dot: "text-neutral",
    fill: "bg-neutral",
  },
  serious: {
    chip: "border-orange-200 bg-orange-50 text-orange-950",
    dot: "text-serious",
    fill: "bg-serious",
  },
  critical: {
    chip: "border-rose-200 bg-rose-50 text-rose-900",
    dot: "text-critical",
    fill: "bg-critical",
  },
  info: {
    chip: "border-sky-200 bg-sky-50 text-sky-900",
    dot: "text-sky-500",
    fill: "bg-sky-500",
  },
};

export const KINDS: Record<
  string,
  { label: string; hint: string; chip: string }
> = {
  insurer_communication: {
    label: "Insurer letter",
    hint: "The query, rejection or settlement letter",
    chip: "bg-violet-100 text-violet-900",
  },
  clinical: {
    label: "Medical record",
    hint: "Discharge summary, lab report, prescription",
    chip: "bg-sky-100 text-sky-900",
  },
  bill: {
    label: "Bill or invoice",
    hint: "Hospital bill, pharmacy invoice",
    chip: "bg-amber-100 text-amber-950",
  },
  receipt: {
    label: "Acknowledgement",
    hint: "Proof the insurer received something",
    chip: "bg-emerald-100 text-emerald-900",
  },
  policy: {
    label: "Policy wording",
    hint: "The terms and conditions booklet",
    chip: "bg-fuchsia-100 text-fuchsia-900",
  },
  schedule: {
    label: "Policy schedule",
    hint: "Your sum insured, dates and members",
    chip: "bg-indigo-100 text-indigo-900",
  },
  endorsement: {
    label: "Endorsement",
    hint: "A change the insurer made to the policy",
    chip: "bg-rose-100 text-rose-900",
  },
  other: {
    label: "Other document",
    hint: "Proposal form, emails, anything else",
    chip: "bg-slate-100 text-slate-800",
  },
};
export const kindLabel = (kind: string) => KINDS[kind]?.label ?? human(kind);

export const CATEGORY: Record<string, string> = {
  document_request: "Document request",
  repeat_request: "Repeat request",
  deduction: "Deduction",
  rejection_reason: "Rejection reason",
  clarification: "Clarification",
};

/** Why a flagged finding needs a person. Older reports stored no reasons, so fall back to the status. */
export function reviewReasons(finding: Finding): string[] {
  if (!finding.review_required) return [];
  if (finding.review_reasons?.length) return finding.review_reasons;
  if (finding.evidence_status === "conflicting_evidence")
    return [
      "The records disagree with each other or with the insurer's stated reason. A person must decide which applies.",
    ];
  if (finding.evidence_status === "unreadable")
    return [
      "A page could not be read. A person must check the original document.",
    ];
  return ["A person should confirm this finding before it is relied on."];
}

export const refsOf = (finding: Finding) => [
  ...finding.evidence_refs.map((ref) => ({ ref, type: "Evidence" })),
  ...finding.policy_refs.map((ref) => ({ ref, type: "Policy" })),
  ...finding.receipt_refs.map((ref) => ({ ref, type: "Receipt" })),
];

export const GLOSSARY: { term: string; meaning: string }[] = [
  {
    term: "Provisional vs final discharge summary",
    meaning:
      "A provisional summary is an early, unsigned version. Insurers usually want the final one, signed by the treating doctor. The two are different documents even when the filename looks the same.",
  },
  {
    term: "Itemized bill",
    meaning:
      "A bill that lists every charge on its own line (room, medicines, tests) with a total, rather than one lump sum.",
  },
  {
    term: "Acknowledgement",
    meaning:
      "The insurer's written confirmation that it received a specific document. Uploading a file somewhere is not the same as an acknowledgement.",
  },
  {
    term: "Policy schedule",
    meaning:
      "The page of your policy with your own details: who is covered, the sum insured, start and end dates, and which endorsements apply.",
  },
  {
    term: "Endorsement",
    meaning:
      "A written change the insurer adds to your policy after it is issued. It overrides the standard wording for the part it mentions.",
  },
  {
    term: "Sum insured",
    meaning:
      "The maximum the policy pays in a policy year. Several limits, such as room rent, are worked out as a percentage of it.",
  },
  {
    term: "Room rent limit",
    meaning:
      "A cap on the daily room charge the policy pays, often a percentage of the sum insured. Charges above it may be deducted.",
  },
  {
    term: "Co-payment",
    meaning:
      "A share of each approved claim that you pay yourself, for example 10%. Whether it applies depends on the wording, the schedule and any endorsement.",
  },
  {
    term: "Non-payable items",
    meaning:
      "Items the policy lists as not covered, commonly consumables such as gloves and masks.",
  },
  {
    term: "Deduction",
    meaning:
      "An amount the insurer subtracts from what you claimed. Each deduction should come with a reason and a clause.",
  },
  {
    term: "Pre-existing disease",
    meaning:
      "A condition diagnosed or treated within a set period before your first policy started. The exact period is defined in your wording.",
  },
  {
    term: "Waiting period",
    meaning:
      "Time that must pass from your first policy start date before certain conditions are covered. Unbroken renewals normally count towards it.",
  },
  {
    term: "Rejection (repudiation)",
    meaning:
      "The insurer's decision not to pay a claim. It should state each reason and the clause relied on.",
  },
  {
    term: "Reconsideration",
    meaning:
      "A request asking the insurer to review its decision, supported by documents. It does not guarantee a different outcome.",
  },
];
