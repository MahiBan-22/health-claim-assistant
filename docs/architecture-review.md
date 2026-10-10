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
| Identity | Localhost alone is not authorization. Production needs tenant membership, reviewer assignment, and auditable identities. | Required customer/reviewer bearer tokens, one local owner. Never suitable as a multi-user identity system. |
| Input versions | Graph retries must consume the same inputs even after uploads. | Each run freezes document IDs; replacements create immutable new rows and files. |
| Request revisions | A new insurer communication may supersede an old request rather than add to it. | Explicit replacement via logical document ID. New runs select newest versions. Request-level diffing is pending. |
| Extraction | OCR success does not prove text accuracy; a mixed PDF can contain readable and unreadable pages. | Native text then page OCR, page mapping and explicit unreadable state; visual OCR validation is pending. |
| Retrieval | Search absence means absence in the searched records, not absence in reality. Keyword recall is limited. | Case-bound keyword search and inventory visibility. BGE/Chroma integration remains pending. |
| Final documents | Filename or keyword matching cannot establish signed/final content. | Evidence and verifier prompts inspect contents; semantic quality still needs labelled live evaluation. |
| Receipts | Upload records do not prove insurer receipt; acknowledgements need document-version or event mapping. | Separate receipt references and deterministic receipt-type checks; semantic matching by verifier. Typed submission-event tables are pending. |
| Policy applicability | Policy dates, schedule, endorsements, and exceptions matter together. | Dedicated policy step with schedule/endorsement context; no automatic diagnosis exclusion. Applicability fields need a richer typed model. |
| Source support | Existing quotes can still fail to support a conclusion. | Deterministic version/page/quote checks plus separate model entailment review. A second model is not an independent truth oracle. |
| Contradictions | Different invoices can reflect an OCR error or a legitimate correction. Hashes prove changes, not intent. | Conflict status and reviewer path; historical-version comparison tools remain pending. |
| Corrections | Corrective investigation and transport retry are different budgets. | One extra evidence cycle per task; explicit run resume on transport failure. Automated backoff is pending. |
| Durability | Queue delivery can repeat; report side effects must be idempotent. | SQLite graph checkpoints, stable thread IDs, atomic report/task writes, unique run/report relation. Queue reconciliation after a killed worker remains pending. |
| New evidence | Dependency invalidation needs provenance edges between inputs, findings, and tasks. | Full reanalysis of newest versions, prior report retention. Selective task invalidation is pending. |
| Review | Review is an auditable event, not a silent rewrite of history. | Append-only review decision and rationale tied to the run task; previous package remains unchanged. Revised reviewed reports remain pending. |
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
and recovery after termination remain future work. Live account authorization and
a synthetic Luna smoke test still require user sign-in.

## Recommended next milestones

1. Complete authorized ChatGPT sign-in and a synthetic Luna smoke test; add a
   multi-account picker and evaluate live agent quality.
2. Move extraction to RQ jobs, add retrieval/page/tool result budgets and typed
   local tools, implement receipt-event matching and version comparisons.
3. Add BGE/Chroma retrieval with immutable version metadata and case filters.
4. Add queue recovery, process-level locking, dependency invalidation, and
   interruption tests across API, worker, checkpoint and report commit boundaries.
5. Add the four labelled scenario families, prompt-injection/adversarial fixtures,
   policy date/endorsement cases, and measured citation-support evaluation.
6. Extend labelled failure/fix evaluation and detection tuning; record an Entire
   development checkpoint; export aggregate business metrics for cfo.ai and
   isolate Crustdata research behind its own authorized workflow.

## Verification status

The backend suite now passes **56 tests**, covering workflow contracts, authorization,
source/version checks, stream completion, OAuth state/PKCE/identity validation,
refresh rotation, vault chunking and native data migration. The React TypeScript
check and Vite production build passed. Native API/UI health checks passed, and a
queued diagnostic executed on Windows with the WinVaultKeyring backend. Docker
runs Redis only. Existing Docker case data was copied and hash-verified; the
original volume was preserved.

A subsequent isolated synthetic graph exercised live Luna inference and NeatLogs
export/readback; see observability.md for evidence. OCR/Tesseract, other partner
integrations, process-kill recovery and statistical accuracy remain unverified.

## Official model connection references

- https://developers.openai.com/api/docs/models/gpt-6-luna
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in

Account-specific model access and eligibility still need a real authorized smoke
test. External services and model calls transmit selected input data off-machine.
