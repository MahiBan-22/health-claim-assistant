import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowDown,
  ArrowRight,
  BookOpenText,
  Check,
  CircleCheck,
  Clock3,
  CopyCheck,
  FileCheck2,
  FileImage,
  FileSearch,
  FileText,
  FileType,
  Fingerprint,
  GitBranch,
  Layers3,
  ListChecks,
  Lock,
  MoveUpRight,
  RotateCcw,
  ScanEye,
  ScanText,
  Send,
  ShieldCheck,
  Sparkles,
  Type,
  Users,
} from "lucide-react";
import { api, send } from "../api";
import { useApp } from "../app-context";

/** The header pill: what state the workspace is in, and whether the next step is connecting the AI engine. */
export type Health = {
  label: string;
  tone: string;
  dot: string;
  connect: boolean;
};

const AGENTS = [
  {
    name: "Planner",
    icon: GitBranch,
    role: "Makes sense of the ask",
    short: "Turns one complex letter into clear, individual questions.",
    problem: "A long insurer letter makes it hard to know where to start.",
    action:
      "Separates document requests, repeated requests, deductions and rejection reasons. Identifies which points need a policy check.",
    output: "A focused task list, with the insurer’s exact scope preserved.",
    example:
      "“Please send the final summary and explain the room charges” becomes two separate checks.",
  },
  {
    name: "Policy agent",
    icon: BookOpenText,
    role: "Decodes the fine print",
    short: "Checks wording, schedules and endorsements when needed.",
    problem:
      "The clause in a rejection or deduction may not tell the whole story.",
    action:
      "Reads the relevant wording before the evidence answer is written. Checks definitions, dates, exceptions and endorsements; flags missing context.",
    output:
      "A cited policy position: supports, contradicts, does not address, or unclear.",
    example:
      "A room-rent deduction is checked against both the base wording and any endorsement that changes the limit.",
  },
  {
    name: "Evidence agent",
    icon: FileSearch,
    role: "Connects every point to proof",
    short: "Matches records and receipts to the exact request.",
    problem:
      "Having a document does not mean it answers the request—or proves it was received.",
    action:
      "Checks the available document versions, matches source pages, spots missing or conflicting records, and verifies submission receipts separately.",
    output:
      "A finding, page citations, a suggested reply and one concrete next step.",
    example:
      "A provisional summary is identified as incomplete when the insurer requested a final signed version.",
  },
  {
    name: "Verifier",
    icon: ShieldCheck,
    role: "Checks the answer against proof",
    short: "Tests citations and statements before the report is packaged.",
    problem:
      "A confident answer can still contain a claim the documents do not support.",
    action:
      "Checks exact quotes, identifiers and statement support. Sends a point through one correction cycle when needed, then flags unresolved issues for a person.",
    output:
      "Checked findings, explicit uncertainty and withheld unsupported wording.",
    example:
      "An unsupported claim that a bill was received is corrected or withheld unless a matching acknowledgement supports it.",
  },
];

function jump(id: string) {
  document.getElementById(id)?.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "instant"
      : "smooth",
  });
}

const SECTIONS = [
  ["how-it-works", "How it works"],
  ["reading", "Your documents"],
  ["agent-flow", "The agents"],
  ["impact", "Impact"],
  ["your-claims", "Your claims"],
  ["contact", "Contact"],
];

function Brand() {
  return (
    <button className="lp-brand" onClick={() => jump("top")}>
      <span>
        <ShieldCheck size={20} aria-hidden="true" />
      </span>
      claimwise
    </button>
  );
}

export function LandingTopbar({ health }: { health: Health }) {
  const app = useApp();
  return (
    <header className="lp-topbar">
      <div>
        <Brand />
        <nav aria-label="On this page">
          {SECTIONS.map(([id, label]) => (
            <button key={id} onClick={() => jump(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="lp-topbar-actions">
          <button
            className={"lp-status " + health.tone}
            onClick={() =>
              app.open({ type: health.connect ? "connection" : "system" })
            }
            aria-label={"System status: " + health.label}
          >
            <span className={health.dot} aria-hidden="true" />
            <span>{health.label}</span>
          </button>
          <button
            className="landing-primary"
            onClick={() => app.open({ type: "case" })}
          >
            Start a new claim <ArrowRight size={17} />
          </button>
        </div>
      </div>
    </header>
  );
}

export function LandingHero({ hasSamples }: { hasSamples: boolean }) {
  const app = useApp();
  return (
    <>
      <section className="landing-hero" aria-labelledby="landing-title">
        <div className="hero-copy">
          <p className="landing-kicker">
            <span /> YOUR EVIDENCE. YOUR NEXT MOVE.
          </p>
          <h1 id="landing-title">
            Less paperwork.
            <br />
            More <em>clarity.</em>
          </h1>
          <p className="hero-description">
            Know what your insurer needs. Find the proof you already have. Move
            forward with a reply you can explain.
          </p>
          <div className="hero-actions">
            <button
              className="landing-primary"
              onClick={() => app.open({ type: "case" })}
            >
              Start a new claim <ArrowRight size={20} />
            </button>
            {hasSamples ? (
              <button
                className="landing-secondary"
                onClick={() => jump("samples")}
              >
                Explore a sample <MoveUpRight size={18} />
              </button>
            ) : (
              <button
                className="landing-secondary"
                onClick={() => jump("how-it-works")}
              >
                See how it works <ArrowDown size={18} />
              </button>
            )}
          </div>
          <div className="hero-trust">
            <span>
              <FileCheck2 size={17} /> Page-level citations
            </span>
            <span>
              <Users size={17} /> Human review when needed
            </span>
            <span>
              <ScanText size={17} /> Reads PDF, Word and scans
            </span>
          </div>
        </div>
        <div
          className="hero-visual"
          aria-label="Illustrative example of a claim evidence check"
        >
          <div className="visual-orbit orbit-one" />
          <div className="visual-orbit orbit-two" />
          <div className="source-chip source-letter">
            <FileText size={18} />
            <span>Insurer’s letter</span>
          </div>
          <div className="source-chip source-policy">
            <BookOpenText size={18} />
            <span>Policy & records</span>
          </div>
          <article className="preview-report">
            <div className="preview-top">
              <span className="preview-brand">
                <Layers3 size={19} /> claimwise
              </span>
              <span>ILLUSTRATIVE PREVIEW</span>
            </div>
            <div className="preview-title">
              <span className="preview-check">
                <Check size={24} />
              </span>
              <div>
                <h2>The next step is clear.</h2>
                <p>From scattered papers to a focused reply</p>
              </div>
            </div>
            <div className="preview-finding">
              <CircleCheck size={20} />
              <div>
                <strong>Itemized bill located</strong>
                <p>Supporting charges found in your records.</p>
                <span className="preview-citation">
                  Itemized bill · p. 1 <MoveUpRight size={12} />
                </span>
              </div>
            </div>
            <div className="preview-finding finding-amber">
              <FileSearch size={20} />
              <div>
                <strong>Final summary still needed</strong>
                <p>The available version is provisional.</p>
                <span className="preview-citation">
                  Discharge summary · p. 1 <MoveUpRight size={12} />
                </span>
              </div>
            </div>
            <div className="preview-output">
              <ListChecks size={17} />
              <span>Clear next steps. A reply with sources.</span>
            </div>
          </article>
          <div className="visual-footer">
            <span className="agent-avatars">
              {AGENTS.map(({ icon: Icon, name }) => (
                <span key={name}>
                  <Icon size={16} />
                </span>
              ))}
            </span>
            <p>
              <strong>Four roles. One clear picture.</strong>
              <br />
              Plan → interpret → match → verify
            </p>
          </div>
        </div>
      </section>
      <section
        id="how-it-works"
        className="landing-steps"
        aria-label="How it works"
      >
        <ol>
          {STEPS.map(({ title, description, icon: Icon }, index) => (
            <li key={title}>
              <span className="step-node">
                <Icon size={22} aria-hidden="true" />
                <span>{index + 1}</span>
              </span>
              <h3>{title}</h3>
              <p>{description}</p>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

const STEPS = [
  {
    title: "Bring the question",
    description: "Upload the insurer’s letter, query or rejection.",
    icon: FileText,
  },
  {
    title: "Add your evidence",
    description: "Bills, records and policy, as PDF, Word, scans or text.",
    icon: Layers3,
  },
  {
    title: "Let the agents check",
    description: "See what is supported, what is missing and why.",
    icon: Sparkles,
  },
  {
    title: "Take the next step",
    description: "Edit your reply and export the response package.",
    icon: FileCheck2,
  },
];

function FlowArrow() {
  return (
    <span className="reading-arrow" aria-hidden="true">
      <ArrowRight size={18} />
    </span>
  );
}

/** How each kind of upload becomes page text, shown as two lanes that meet in one result. */
export function ReadingFlow() {
  const app = useApp();
  const model = app.connection?.model ?? app.system?.model;
  return (
    <section
      id="reading"
      className="reading-section"
      aria-labelledby="reading-title"
    >
      <div className="section-heading">
        <div>
          <p className="landing-kicker">EVERY FORMAT, READ THE RIGHT WAY</p>
          <h2 id="reading-title">
            Any document in.
            <br />
            Exact words out.
          </h2>
        </div>
        <p>
          Typed text is copied character for character. Scans and pictures are
          read by the AI model and labelled, so you can always compare them with
          the original.
        </p>
      </div>
      <div className="reading-flow">
        <div className="reading-lane">
          <ul aria-label="Typed documents">
            <li>
              <FileText size={18} aria-hidden="true" /> PDF with text
            </li>
            <li>
              <FileType size={18} aria-hidden="true" /> Word (.docx)
            </li>
            <li>
              <Type size={18} aria-hidden="true" /> Plain text
            </li>
          </ul>
          <FlowArrow />
          <article>
            <span className="reading-icon">
              <CopyCheck size={22} aria-hidden="true" />
            </span>
            <div>
              <h3>Copied exactly</h3>
              <p>
                The text already inside the file is taken as it is. Nothing is
                rewritten and no AI is involved.
              </p>
              <span className="reading-tag">Text layer</span>
            </div>
          </article>
        </div>
        <div className="reading-lane lane-ai">
          <ul aria-label="Scans and pictures">
            <li>
              <ScanText size={18} aria-hidden="true" /> Scanned PDF pages
            </li>
            <li>
              <FileImage size={18} aria-hidden="true" /> Pictures in Word files
            </li>
          </ul>
          <FlowArrow />
          <article>
            <span className="reading-icon">
              <ScanEye size={22} aria-hidden="true" />
            </span>
            <div>
              <h3>Read by the AI model</h3>
              <p>
                Each page image is transcribed line by line. Signatures and
                stamps are marked, and an unclear word becomes [illegible]
                instead of a guess.
              </p>
              <span className="reading-tag">
                <Sparkles size={12} aria-hidden="true" />
                {model ? model + " · " : ""}labelled “Read by AI”
              </span>
            </div>
          </article>
        </div>
        <svg
          className="reading-merge"
          viewBox="0 0 60 200"
          preserveAspectRatio="none"
          fill="none"
          aria-hidden="true"
        >
          <path d="M0 50 C34 50 26 100 60 100" />
          <path d="M0 150 C34 150 26 100 60 100" />
        </svg>
        <article className="reading-result">
          <p className="detail-label">WHAT THE AGENTS WORK FROM</p>
          <h3>Page-by-page text you can check</h3>
          <div className="reading-page" aria-hidden="true">
            <span />
            <span />
            <span className="quoted" />
            <span />
            <em>p. 2</em>
          </div>
          <ul>
            <li>
              <Check size={16} aria-hidden="true" /> Every quote opens on its
              page
            </li>
            <li>
              <Check size={16} aria-hidden="true" /> AI-read pages carry a label
            </li>
            <li>
              <Check size={16} aria-hidden="true" /> Your original file is kept
              unchanged
            </li>
          </ul>
        </article>
      </div>
    </section>
  );
}

export function AgentFlow() {
  const [selected, select] = useState(0);
  const agent = AGENTS[selected];
  return (
    <section
      id="agent-flow"
      className="agent-section"
      aria-labelledby="agent-title"
    >
      <div className="section-heading">
        <div>
          <p className="landing-kicker">THE INTELLIGENCE BEHIND THE CLARITY</p>
          <h2 id="agent-title">
            Four specialists.
            <br />
            Every point accounted for.
          </h2>
        </div>
        <p>
          A coordinated workflow that follows the evidence, checks its own work,
          and knows when to ask a person.
        </p>
      </div>
      <div className="flow-entry">
        <span>
          <Layers3 size={17} /> Your letter + documents
        </span>
        <ArrowDown size={22} />
        <span className="flow-hint">Select an agent to explore its role</span>
      </div>
      <div
        className="agent-track"
        aria-label="Agent workflow, in execution order"
      >
        {AGENTS.map(({ name, icon: Icon, role, short }, index) => (
          <button
            key={name}
            className={"agent-node " + (selected === index ? "selected" : "")}
            onClick={() => select(index)}
            aria-pressed={selected === index}
            aria-controls="agent-detail"
          >
            <span className="agent-node-top">
              <span className="agent-icon">
                <Icon size={24} />
              </span>
              <span>0{index + 1}</span>
            </span>
            <h3>{name}</h3>
            <strong>{role}</strong>
            <p>{short}</p>
            <span className="agent-explore">
              Explore role <ArrowRight size={16} />
            </span>
          </button>
        ))}
      </div>
      <svg
        className="flow-cycle"
        viewBox="0 0 1000 45"
        fill="none"
        aria-hidden="true"
        preserveAspectRatio="none"
      >
        <path
          d="M880 0 V15 Q880 30 865 30 H390 Q375 30 375 15 V3"
          stroke="currentColor"
          strokeDasharray="5 5"
        />
        <path d="M369 10 L375 3 L381 10" stroke="currentColor" />
        <circle cx="880" cy="1" r="3" fill="currentColor" />
      </svg>
      <div className="flow-branches">
        <span>
          <RotateCcw size={17} /> One targeted correction, if needed{" "}
          <span aria-hidden="true">↶</span>
        </span>
        <span>
          <Users size={17} /> Unresolved issues → human review
        </span>
        <span>
          <FileCheck2 size={17} /> Findings → response package
        </span>
      </div>
      <div
        className="agent-detail"
        id="agent-detail"
        aria-live="polite"
        aria-atomic="true"
      >
        <div>
          <p className="detail-label">THE PROBLEM IT SOLVES</p>
          <h3>{agent.problem}</h3>
          <p>{agent.action}</p>
        </div>
        <div className="agent-deliverable">
          <p className="detail-label">
            WHAT {agent.name.toUpperCase()} DELIVERS
          </p>
          <h3>{agent.output}</h3>
          <p>
            <span>For example</span>
            {agent.example}
          </p>
        </div>
      </div>
      <p className="flow-note">
        Policy is checked when the question needs it. The policy → evidence →
        verification sequence repeats for each point before the final package is
        assembled.
      </p>
    </section>
  );
}

type ImpactGroup = {
  claims: number;
  documents: number;
  cases_analyzed: number;
  points_checked: number;
  supported_points: number;
  needs_review: number;
  evidence_gaps: number;
  cited_points: number;
  receipts_confirmed: number;
  policy_points: number;
  timed_reports: number;
  analysis_seconds: number;
  report_seconds: number[];
};
type Impact = { customer: ImpactGroup; samples: ImpactGroup };
const count = (value: number) => value.toLocaleString();
const duration = (seconds: number) =>
  seconds < 60
    ? `${Math.round(seconds)} sec`
    : seconds < 3600
      ? `${(seconds / 60).toFixed(1)} min`
      : `${(seconds / 3600).toFixed(1)} hrs`;

export function ImpactDashboard({ refreshKey }: { refreshKey: string }) {
  const [data, setData] = useState<Impact | null>(null);
  const [failed, setFailed] = useState(false);
  const [scope, setScope] = useState<keyof Impact>("customer");
  const [baseline, setBaseline] = useState(45);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void api<Impact>("/business/impact")
      .then((result) => {
        if (!result.customer || !result.samples)
          throw new Error("Impact metrics unavailable");
        if (!cancelled) setData(result);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [reload, refreshKey]);
  const metrics = data?.[scope];
  const savings =
    metrics?.report_seconds.reduce(
      (total, seconds) => total + Math.max(0, baseline * 60 - seconds),
      0,
    ) ?? 0;
  const coverage = metrics?.points_checked
    ? Math.round((metrics.cited_points / metrics.points_checked) * 100)
    : null;
  const average = metrics?.timed_reports
    ? metrics.analysis_seconds / metrics.timed_reports
    : null;
  return (
    <section
      id="impact"
      className="impact-section"
      aria-labelledby="impact-title"
    >
      <div className="section-heading">
        <div>
          <p className="landing-kicker">PROGRESS YOU CAN SEE</p>
          <h2 id="impact-title">
            Less guesswork.
            <br />
            Measurable progress.
          </h2>
        </div>
        <p>
          Real activity from this workspace. Each claim’s latest report counts
          once, even when you run it again.
        </p>
      </div>
      <div className="impact-toolbar">
        <div className="scope-switch" aria-label="Metrics scope">
          {(["customer", "samples"] as const).map((value) => (
            <button
              key={value}
              aria-pressed={scope === value}
              onClick={() => setScope(value)}
            >
              {value === "customer" ? "Your claims" : "Sample cases"}
            </button>
          ))}
        </div>
        <span>
          <span className="metric-dot" />
          {scope === "samples"
            ? "Fictional sample activity"
            : "Sample cases excluded"}
        </span>
      </div>
      {failed ? (
        <div className="impact-unavailable" role="status">
          <p>
            Impact metrics are unavailable right now. Your claims are still
            accessible below.
          </p>
          <button
            className="btn btn-soft"
            onClick={() => setReload((value) => value + 1)}
          >
            <RotateCcw size={16} />
            Retry metrics
          </button>
        </div>
      ) : !metrics ? (
        <p className="impact-unavailable" role="status">
          Loading workspace impact…
        </p>
      ) : (
        <>
          <div className="impact-grid">
            {[
              {
                icon: Users,
                value: count(metrics.cases_analyzed),
                title: "Claims brought into focus",
                note: `${count(metrics.claims)} claims · ${count(metrics.documents)} document versions`,
              },
              {
                icon: ListChecks,
                value: count(metrics.points_checked),
                title: "Insurer questions checked",
                note: "Individual points in the latest reports",
              },
              {
                icon: ShieldCheck,
                value: count(metrics.supported_points),
                title: "Points fully supported",
                note: "Satisfied, verified, and no review flag",
              },
              {
                icon: Clock3,
                value: metrics.timed_reports ? duration(savings) : "—",
                title: "Potential time saved",
                note: "Estimate · adjust your baseline below",
              },
            ].map(({ icon: Icon, value, title, note }, index) => (
              <article
                className={
                  "impact-card " + (index === 3 ? "impact-highlight" : "")
                }
                key={title}
              >
                <div>
                  <Icon size={22} />
                  <span>0{index + 1}</span>
                </div>
                <strong>{value}</strong>
                <h3>{title}</h3>
                <p>{note}</p>
              </article>
            ))}
          </div>
          <div className="impact-detail-grid">
            <div className="quality-panel">
              <div className="panel-title">
                <Fingerprint size={22} />
                <h3>Proof behind the progress</h3>
              </div>
              <div className="coverage-line">
                <span>Points with source citations</span>
                <strong>{coverage === null ? "—" : coverage + "%"}</strong>
              </div>
              <div
                className="coverage-track"
                role="meter"
                aria-label="Points with source citations"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={coverage ?? 0}
                aria-valuetext={
                  coverage === null ? "No findings yet" : coverage + "%"
                }
              >
                <span style={{ width: `${coverage ?? 0}%` }} />
              </div>
              <ul className="share-list">
                {(
                  [
                    ["Fully supported", metrics.supported_points],
                    ["Evidence gaps identified", metrics.evidence_gaps],
                    ["Flagged for review", metrics.needs_review],
                    ["Policy wording cited", metrics.policy_points],
                    ["Confirmed by receipt", metrics.receipts_confirmed],
                  ] as const
                ).map(([label, value]) => (
                  <li key={label}>
                    <span>{label}</span>
                    <strong>
                      {metrics.points_checked
                        ? `${count(value)} of ${count(metrics.points_checked)}`
                        : "—"}
                    </strong>
                    <div
                      className="share-track"
                      role="meter"
                      aria-label={label}
                      aria-valuemin={0}
                      aria-valuemax={metrics.points_checked}
                      aria-valuenow={value}
                    >
                      <span
                        style={{
                          width: metrics.points_checked
                            ? `${(value / metrics.points_checked) * 100}%`
                            : 0,
                        }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
              <p className="metric-footnote">
                These measures can overlap. A source citation alone does not
                mean a point is fully supported.
              </p>
            </div>
            <div className="time-panel">
              <div className="panel-title">
                <Clock3 size={22} />
                <h3>What could your time be worth?</h3>
              </div>
              <p>
                Compare recorded analysis time with your estimate for reviewing
                the same claim manually.
              </p>
              <label htmlFor="manual-minutes">
                Manual review per claim <strong>{baseline} min</strong>
              </label>
              <input
                id="manual-minutes"
                type="range"
                min="15"
                max="180"
                step="5"
                value={baseline}
                onChange={(event) => setBaseline(Number(event.target.value))}
              />
              <div className="range-labels">
                <span>15 minutes</span>
                <span>3 hours</span>
              </div>
              <div className="time-bars">
                <div>
                  <span>Manual review, your estimate</span>
                  <strong>{baseline} min</strong>
                  <div className="time-bar bar-context">
                    <span style={{ width: "100%" }} />
                  </div>
                </div>
                <div>
                  <span>Recorded analysis, average per claim</span>
                  <strong>
                    {average === null ? "Not measured yet" : duration(average)}
                  </strong>
                  <div className="time-bar">
                    <span
                      style={{
                        width:
                          average === null
                            ? 0
                            : `${Math.min(100, Math.max(1, (average / (baseline * 60)) * 100))}%`,
                      }}
                    />
                  </div>
                </div>
              </div>
              <p className="time-count">
                Reports with complete timings{" "}
                <strong>
                  {count(metrics.timed_reports)} /{" "}
                  {count(metrics.cases_analyzed)}
                </strong>
              </p>
              <p className="metric-footnote">
                Estimate = manual baseline minus recorded run time, floored at
                zero for each timed report. Excludes upload, queue and human
                review time. The 45-minute starting value is an assumption, not
                a measured benchmark.
              </p>
            </div>
          </div>
          {metrics.cases_analyzed === 0 && (
            <p className="impact-empty">
              {scope === "customer"
                ? "Your impact starts with your first analysis. Try a sample to explore the workflow, then bring your own claim."
                : "Open a sample below and run an analysis to see its metrics here."}
            </p>
          )}
          <details className="metric-method">
            <summary>How we measure impact</summary>
            <p>
              Counts use the latest saved report for each claim in the selected
              scope. “Points fully supported” requires satisfied evidence, a
              supported verifier decision, and no blocked wording or review
              flag. Timings include all recorded attempts for that report;
              reports with incomplete timing are excluded from time estimates.
              Sample cases are identified by the app’s built-in sample claim
              references. Claim settlements, unique customers, payouts and
              actual manual time savings are not recorded, so they are not
              claimed here.
            </p>
          </details>
        </>
      )}
    </section>
  );
}

export function LandingFooter() {
  const app = useApp();
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState("");
  const [sender, setSender] = useState({ name: "", email: "" });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const details = {
      name: String(data.get("name") ?? "").trim(),
      email: String(data.get("email") ?? "").trim(),
    };
    setState("sending");
    setError("");
    try {
      await send("/inquiries", "POST", details);
      setSender(details);
      setState("sent");
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "";
      setError(
        message.includes("(422)") || !message
          ? "That could not be saved. Check the name and email address, then try again."
          : message,
      );
      setState("idle");
    }
  }
  return (
    <footer className="lp-footer">
      <div>
        <section
          id="contact"
          className="lp-contact"
          aria-labelledby="contact-title"
        >
          <div>
            <p className="landing-kicker">QUESTIONS ABOUT THE APPLICATION?</p>
            <h2 id="contact-title">
              Ask us anything.
              <br />
              We’ll get back to you.
            </h2>
            <p>
              Leave your name and email address and we will reply with answers
              about how Claimwise works, what it reads and what it leaves to
              you.
            </p>
            <p className="contact-privacy">
              <Lock size={15} aria-hidden="true" /> Saved in this workspace
              only. Nothing is sent to a third party.
            </p>
          </div>
          {state === "sent" ? (
            <div className="contact-card contact-done" role="status">
              <span>
                <Check size={24} aria-hidden="true" />
              </span>
              <h3>Thank you, {sender.name}.</h3>
              <p>
                Your details are saved. We will reply to{" "}
                <strong>{sender.email}</strong>.
              </p>
              <button onClick={() => setState("idle")}>
                Send another question
              </button>
            </div>
          ) : (
            <form
              className="contact-card"
              onSubmit={(event) => void submit(event)}
            >
              <label htmlFor="contact-name">Your name</label>
              <input
                id="contact-name"
                name="name"
                required
                maxLength={120}
                autoComplete="name"
                placeholder="e.g. Asha Rao"
              />
              <label htmlFor="contact-email">Email address</label>
              <input
                id="contact-email"
                name="email"
                type="email"
                required
                maxLength={254}
                autoComplete="email"
                placeholder="you@example.com"
              />
              {error && (
                <p className="contact-error" role="alert">
                  {error}
                </p>
              )}
              <button disabled={state === "sending"}>
                {state === "sending" ? "Sending…" : "Ask a question"}
                <Send size={16} aria-hidden="true" />
              </button>
            </form>
          )}
        </section>
        <div className="lp-footer-links">
          <div>
            <Brand />
            <p>
              Reconciles an insurer’s letter with your documents and policy, and
              drafts a reply with page-level citations.
            </p>
          </div>
          <nav aria-label="Explore">
            <h3>Explore</h3>
            <button onClick={() => jump("how-it-works")}>How it works</button>
            <button onClick={() => jump("reading")}>Your documents</button>
            <button onClick={() => jump("agent-flow")}>The agents</button>
            <button onClick={() => jump("impact")}>Impact</button>
          </nav>
          <nav aria-label="Workspace">
            <h3>Workspace</h3>
            <button onClick={() => jump("your-claims")}>Your claims</button>
            <button onClick={() => jump("samples")}>Sample cases</button>
            <button onClick={() => app.go({ view: "review" })}>
              Review desk
            </button>
          </nav>
          <nav aria-label="Help">
            <h3>Help</h3>
            <button onClick={() => app.open({ type: "glossary" })}>
              Insurance terms explained
            </button>
            <button onClick={() => app.open({ type: "connection" })}>
              AI engine
            </button>
            <button onClick={() => app.open({ type: "system" })}>
              System check
            </button>
          </nav>
        </div>
        <div className="lp-footer-base">
          <span>Claimwise · Runs on this computer</span>
          <span>
            Explains your evidence. The insurer’s decision stays with the
            insurer.
          </span>
        </div>
      </div>
    </footer>
  );
}
