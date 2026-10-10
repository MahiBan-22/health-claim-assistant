# Architecture review and implementation decisions

Reviewed baseline: `Health_Claim_Architecture.md`, version 2, 10 October 2026.

## Assessment

The architecture defines a sound evidence-reconciliation product. Its strongest
decision is to separate evidence completeness, submission proof, policy context,
and insurer outcomes. Those distinctions must survive every schema, prompt,
screen, and exported draft. An evidence status is not an adjudication result.

The three specialists have useful boundaries. The planner decomposes requests;
the Evidence Agent investigates records; the Policy Agent contextualizes wording;
the Verifier checks support. A coordinator, rather than an agent prompt, must
enforce authorization, state transitions, retries, deadlines, and report creation.

The original file is an implementation specification, not an existing system.
It contains no measured quality results, registered OAuth application, dependency
lockfile, connected partner accounts, or runnable project. This implementation
therefore starts with a vertical slice and tracks remaining capabilities explicitly.

## Decisions that need implementation detail

| Concern | Analysis | Initial implementation |
| --- | --- | --- |
| Identity | Localhost alone is not authorization. Production needs tenant membership, reviewer assignment, and auditable identities. | No login for the single local owner. The API serves only allowed Host names and its own UI origin, which blocks other websites and DNS rebinding. Reviewer mode is a workspace role with a recorded name, not an identity. Never suitable as a multi-user identity system. |
| Input versions | Graph retries must consume the same inputs even after uploads. | Each run freezes document IDs; replacements create immutable new rows and files. |
| Request revisions | A new insurer communication may supersede an old request rather than add to it. | Explicit replacement via logical document ID. New runs select newest versions. Request-level diffing is pending. |
| Extraction | OCR success does not prove text accuracy; a mixed PDF can contain readable and unreadable pages. | Native text then page OCR, page mapping and explicit unreadable state; visual OCR validation is pending. |
| Retrieval | Search absence means absence in the searched records, not absence in reality. Keyword recall is limited. | Case-bound keyword search and inventory visibility; the verifier receives the inventory so a missing document is recorded as not found instead of looping. BGE/Chroma integration remains pending. |
| Final documents | Filename or keyword matching cannot establish signed/final content. | Evidence and verifier prompts inspect contents; semantic quality still needs labelled live evaluation. |
| Receipts | Upload records do not prove insurer receipt; acknowledgements need document-version or event mapping. | Separate receipt references and deterministic receipt-type checks; semantic matching by verifier. Typed submission-event tables are pending. |
| Policy applicability | Policy dates, schedule, endorsements, and exceptions matter together. | The policy step runs first and returns its reading with a position (supports, contradicts, does not address, unclear) so the evidence step writes one answer from records and wording together. No automatic diagnosis exclusion. Applicability fields need a richer typed model. |
| Source support | Existing quotes can still fail to support a conclusion. | Deterministic version/page/quote checks (tolerant of typography and line wrapping, strict on wording) plus model entailment review that names each unsupported statement. An unsupported statement in the explanation blocks the conclusion after one correction; one only in the reply text is removed from the letter. A second model is not an independent truth oracle. |
| Identity mismatch | A wrong claim reference may be a typing slip or a document from another claim. | Mismatches are surfaced at upload with a one-step correction, and in the report as a warning plus a review flag. They no longer discard the finding. |
| Contradictions | Different invoices can reflect an OCR error or a legitimate correction. Hashes prove changes, not intent. | Conflict status and reviewer path; reports can be compared across analyses. Comparing superseded versions inside one analysis remains pending. |
| Corrections | Corrective investigation and transport retry are different budgets. | One corrective cycle per task, used for a failed citation, a targeted search or unsupported statements. Separate bounded transport retry with backoff for rate limits and server errors, and one re-ask for a malformed answer. |
| Durability | Queue delivery can repeat; report side effects must be idempotent. | SQLite graph checkpoints, stable thread IDs, atomic report/task writes, unique run/report relation. The worker restarts its loop after a Redis timeout and, holding an OS-level lock, re-queues runs a stopped worker left behind. |
| New evidence | Dependency invalidation needs provenance edges between inputs, findings, and tasks. | Full reanalysis of newest versions, prior report retention. Selective task invalidation is pending. |
| Review | Review is an auditable event, not a silent rewrite of history. | Append-only decision, rationale and reviewer name tied to the run task; a review desk lists flagged findings across claims and the report shows the decision history. The package itself is unchanged; revised reviewed reports remain pending. |
| Model connection | A ChatGPT subscription cannot be assumed to authorize an arbitrary model or application. | OAuth-only adapter, live catalog check, `gpt-6-luna` default, completed-stream requirement; missing access pauses processing. |
| OAuth lifecycle | PKCE, state, nonce, grant validation, refresh rotation, account switching, and keyring storage are a separate subsystem. | Native browser sign-in, PKCE, verified identity, scoped grants, serialized refresh rotation and Windows Credential Manager storage are implemented. Profile selection uses OAUTH_ACCOUNT; a multi-account picker remains pending. No Codex credentials are read. |
| Observability | Raw case inputs and credentials must not enter partner traces. | NeatLogs SDK export, graph callbacks, custom model/tool spans, client-side metadata allowlisting, local metrics and read-only MCP investigation are implemented. Live synthetic tracing and hosted Doctor were verified; no clinical quality score is claimed. |
| Partners | Entire, cfo.ai, and Crustdata have separate development/business roles. | No live partner writes or claims of connected integrations. No health records sent to business tools. |

## First milestone coverage

Implemented: FastAPI case/document/analysis/report/review routes, SQLAlchemy SQLite
metadata, immutable original uploads, page extraction, strict Pydantic contracts,
RQ worker entry point, LangGraph SQLite checkpoints, planner and three specialist
roles, one corrective cycle, source checks, review routing, report manifest and
response draft, React workspace/report/reviewer screens, synthetic dengue fixture,
offline tests, and loopback Compose topology.

The role calls all pass through one configured Luna adapter. The adapter does not
silently use another model or API-key billing. It consumes the official streaming
Responses endpoint with `store=false` and requires a completed terminal event.
There is no fixture inference mode in the running application; scripted model
replay exists only in tests and does not measure live agent quality.

This milestone is not the documentation's completed MVP. Native Windows API/UI/worker
share the OS credential vault, while Docker runs Redis only. The Windows worker
executes one job at a time in process with timer-based timeouts; process isolation
remains future work. Recovery after termination is implemented and was exercised
(see Verification status).

## Second milestone: customer workspace and scenario coverage

Added after the first slice: the no-login local boundary, the redesigned three-screen
workspace, suggested document categories, the timeline, the page viewer, report
comparison, the editable reply letter with checklist and ZIP package, the review desk,
the system status panel, five labelled scenario fixture sets, the policy-first graph
order, statement-level verification, bounded transport retry, and worker recovery.

Three workflow changes came directly from running the scenarios:

1. **Policy before evidence.** With evidence first, the customer answer was written
   before the wording had been read, so it asked for clauses that were on file and the
   verifier rejected all three deduction findings. The policy step now runs first.
2. **Statement-level verification.** A single yes/no on the whole explanation blocked
   useful findings over one sentence. The verifier now names unsupported statements;
   the writer gets the one corrective cycle to remove them; only an explanation that is
   still unsupported is blocked, and a problem confined to the reply text removes that
   text from the letter.
3. **Identifier mismatch is a flag, not a verdict.** A claim reference typed differently
   from the documents used to replace every finding with a generic failure. It is now
   caught at upload with a one-step correction and otherwise reported as a warning.

## Recommended next milestones

1. Add a multi-account picker and evaluate live agent quality on a larger
   labelled set (the architecture proposes 20 cases); record counts, not
   percentages from five runs.
2. Move extraction to RQ jobs, add retrieval/page/tool result budgets and typed
   local tools, implement receipt-event matching and comparison of superseded
   versions inside one analysis.
3. Add BGE/Chroma retrieval with immutable version metadata and case filters.
4. Add dependency invalidation so a new version recomputes only affected
   findings, and automated interruption tests across API, worker, checkpoint and
   report commit boundaries.
5. Add prompt-injection/adversarial fixtures, a scanned-PDF fixture with
   Tesseract installed, a deterministic member-identity check and arithmetic
   checks for stated totals.
6. Extend labelled failure/fix evaluation and detection tuning; record an Entire
   development checkpoint; export aggregate business metrics for cfo.ai and
   isolate Crustdata research behind its own authorized workflow.

## Verification status

### First milestone

The backend suite passed **56 tests**, covering workflow contracts, authorization,
source/version checks, stream completion, OAuth state/PKCE/identity validation,
refresh rotation, vault chunking and native data migration. The React TypeScript
check and Vite production build passed. Native API/UI health checks passed, and a
queued diagnostic executed on Windows with the WinVaultKeyring backend. Docker
runs Redis only. Existing Docker case data was copied and hash-verified; the
original volume was preserved.

A subsequent isolated synthetic graph exercised live Luna inference and NeatLogs
export/readback; see observability.md for evidence.

### Second milestone, 10 October 2026

The backend suite passes **85 tests**, adding the local access boundary, new endpoints,
category suggestion, timeline, sample scenarios, each verification branch, the
policy-first order and run recovery. The frontend type-checks and builds, and three
browser tests pass in headless Chrome against intercepted responses.

The five scenarios were run live through the workspace in Chrome against gpt-6-luna;
results and their limits are recorded in fixtures/scenarios/README.md. The customer's
original starter documents, with the claim reference corrected in the workspace,
produced the outcome their README labels for round 1.

Checked against the acceptance table in Health_Claim_Architecture.md:

| Test | Status |
| --- | --- |
| Final versus provisional document | Demonstrated live (scenario 1) and unit-tested. |
| Upload without acknowledgement | Demonstrated live (scenarios 1 and 5: submission never claimed); receipt confirmed only with a matching acknowledgement (scenario 2). |
| Policy amendment | Demonstrated live (scenario 3: endorsement E-02 and the schedule surfaced against the co-payment deduction). |
| Unreadable scan | Not demonstrated. Tesseract is not installed on this machine; the status panel says so. Unreadable pages are reported explicitly in unit tests. |
| Wrong case or member | Unit-tested (cross-case reads refused); a mismatched claim reference is flagged at upload and in the report. Member-identity mismatch was noticed by the model in scenario 5 but has no deterministic check. |
| Unsupported citation | Unit-tested: one correction, then the conclusion is blocked. |
| Worker interruption | Demonstrated live: all processes were stopped mid-analysis; the run resumed from its checkpoint with one report. The worker also restarted itself after two Redis timeouts. |
| New document version | Demonstrated live (scenario 1 follow-up): earlier reports kept, new report compared. Recomputing only affected findings is pending; a full new analysis runs. |
| Conflicting invoice | Demonstrated live (scenario 5): both originals kept, routed to review, no accusation. |
| Prompt injection in document | Not demonstrated. The model is told documents are untrusted; no adversarial fixture exists yet. |

OCR on scanned PDFs, an adversarial fixture, other partner integrations and
statistical accuracy remain unverified.

## Official model connection references

- https://developers.openai.com/api/docs/models/gpt-6-luna
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in

Account-specific model access and eligibility still need a real authorized smoke
test. External services and model calls transmit selected input data off-machine.
