# Health Claim Evidence Assistant (Claimwise)

Implementation of [Health_Claim_Architecture.md](Health_Claim_Architecture.md): a localhost
workspace that reconciles an insurer's letter with the customer's documents and policy,
shows what is supported and what is missing, and drafts a reply with page-level citations.

**Recommended: native Windows API, worker and UI, with Redis in Docker.**
See [native setup and model access](docs/native-run.md).
For a backend-only Windows package and EC2 extraction/startup workflow, see
[EC2 backend deployment](docs/ec2-backend.md).
For dashboard-based frontend deployment, see [Vercel frontend setup](docs/vercel-frontend.md).
Read the [architecture review and verification record](docs/architecture-review.md) and the
[neatHack requirements and evidence](docs/hackathon.md).

## Included

- React/TypeScript workspace styled with Tailwind CSS v4, with AG Grid tables for documents,
  findings and the review queue. Three core screens: claim workspace, evidence report, review desk.
- **No login.** The workspace opens directly. The API answers only its own interface on the
  loopback address (see "Local access boundary").
- Drag-and-drop upload of PDF, Word (.docx) and text files with suggested categories,
  versioned replacements, SHA256 hashes, immutable originals, a dated timeline and a page
  viewer that highlights the cited passage.
- Page text from every format: a text layer is copied exactly; scanned PDF pages and pictures
  inside Word files are read by the connected model and labelled "Read by AI" (see
  "Reading documents").
- FastAPI APIs, SQLite metadata and LangGraph checkpoints with planner, Policy, Evidence and
  Verifier roles. Policy wording is read before the customer answer is written.
- One corrective cycle per request, deterministic citation and identifier checks, statement-level
  verification, explicit uncertainty and an auditable review history.
- RQ/Redis job transport with a self-restarting worker that re-queues interrupted analyses.
- Response package: editable reply letter, next-step checklist, attachment manifest and a ZIP
  with the letter, a readable summary, the structured report and the cited originals.
- Five synthetic walkthrough scenarios that can be opened from the home screen.
- A standalone landing page (no workspace sidebar) with its own top bar, a four-step journey,
  a diagram of how each document format is read, an interactive four-agent infographic,
  workspace impact metrics and a footer contact form (name and email, saved locally).
  Latest reports count once per claim; built-in sample references are grouped separately.
  An adjustable manual-review baseline estimates potential time saved using complete recorded
  run timings. It is explicitly an estimate, not measured labor savings or settled claims.
- An Analysis workflow page that draws every analysis as a flowchart from its recorded steps
  (planner, policy, evidence, verifier, correction loops, packaging), live while it runs.
- A monthly usage export for the cfo.ai business model (`GET /business/metrics.csv`) and a
  report of how neatlogs, Entire and cfo.ai are used here (`GET /system/integrations`).
- A model adapter over the host's Codex CLI, configured to **gpt-6-luna** for every application LLM call.

**This is a working localhost build, not a production service.** Chroma/BGE retrieval, selective
invalidation of findings, historical version comparison inside one analysis and live partner
integrations other than NeatLogs tracing remain pending. Live inference pauses when the host's
Codex CLI is signed out or its account does not list the Luna model. Test replay is never used
as live inference.

## Local setup

Use Python 3.12, Node 22+, Redis and the Codex CLI, signed in once with `codex login` as the
OS user that runs the API and worker. Tesseract is optional: it reads scans only when the AI
engine is unavailable. Native Windows uses RQ SimpleWorker with timer-based timeouts; Linux uses
the standard RQ worker.

The quickest path on Windows is `.\scripts\start-native.ps1`, described in
[docs/native-run.md](docs/native-run.md). Manual steps:

1. Optional: copy .env.example to .env at the repository root to change defaults or add a
   NeatLogs key. No access tokens are needed. Never commit .env.
2. Start Redis locally without exposing it beyond loopback (`docker compose up -d redis`).
3. From the repository root, create a virtual environment and install the backend:

       uv venv --python 3.12
       uv pip install --python .venv/Scripts/python.exe -e ./backend[test]

   On Linux use .venv/bin/python instead of .venv/Scripts/python.exe.

4. Activate the environment and start the API from the root:

       python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000

5. From a second root terminal with the same environment:

       python -m app.worker

   Set PYTHONPATH=backend for the worker, or install the package as in step 3.
6. In frontend/, run npm ci, then npm run dev -- --host 127.0.0.1.
7. Open http://127.0.0.1:5173. There is no sign-in in the workspace: if the header reports
   the AI engine as unavailable, run `codex login` in a terminal. API docs are at
   http://127.0.0.1:8000/docs.

Relative DATA_DIR paths are resolved from the command directory: API and worker must share
the same working directory and storage location. The header pill and the System status panel
show whether the service, database, queue, worker and model are available.

## Local access boundary

The earlier access-token prompt was removed: on a single-user computer it added a step
without protecting anything, because any process running as that user can read data/ directly.
The API instead refuses requests that could come from elsewhere:

- **Host check.** Only ALLOWED_HOSTS (default 127.0.0.1 and localhost) are served, which
  blocks DNS rebinding.
- **Origin check.** A request carrying an Origin header is served only for APP_ORIGIN and its
  localhost/127.0.0.1 twin. Other websites open in the same browser cannot read or change
  cases. Cross-site state-changing requests without an Origin header are refused as well.
- Ports stay bound to 127.0.0.1.

**Reviewer mode** is a workspace role chosen with the sidebar switch, sent as the
X-Workspace-Role header. It keeps review actions and withheld draft wording out of the
customer view and records the reviewer's name with each decision. It is a workflow guard, not
an identity system: a shared or hosted deployment needs real authentication and tenant
authorization before any real records are used.

## Sample scenarios

fixtures/scenarios/ holds five fictional document sets that map to the architecture's scenarios.
They appear on the home screen under "Sample cases"; each creates a claim with its documents so
a real analysis can be run. See [fixtures/scenarios/README.md](fixtures/scenarios/README.md) for
the expected behaviour and the recorded live results.

| Sample | Architecture scenario |
| --- | --- |
| 01-document-completeness | Scenario 1, final versus provisional summary; includes a second round with new versions |
| 02-repeated-request | Scenario 2, repeated request with a matching acknowledgement |
| 03-deduction-confusion | Scenario 3, three deductions against wording, schedule and an endorsement |
| 04-rejection-dispute | Scenario 4, rejection for waiting period and non-disclosure |
| 05-conflicting-invoices | Customer example 4, two versions of an invoice |

## Docker skeleton

    docker compose --profile containers up --build

Ports bind to 127.0.0.1; Redis is private to Compose. Data is stored in named volumes.
Stop with docker compose down to preserve the volumes. The container skeleton runs
API/UI/queue processes, but its images carry neither the Codex CLI nor a sign-in, so live
inference there remains blocked. Use native mode for live analysis. The frontend image runs Vite for localhost development, not production hosting.

After a backend code change, load it with `docker compose up -d --build --no-deps api worker`.

## Model connection

All planner/specialist calls share LLM_MODEL=gpt-6-luna and run through the Codex CLI signed
in for the OS user that runs the API and worker (`codex login`, or `codex login --device-auth`
on a server without a browser). The workspace has no sign-in of its own: `GET /system/model`
reports whether the CLI is installed, signed in and lists that exact model, and nothing in the
browser can connect or disconnect it.

Each call is one `codex exec` run with the CLI's tools switched off, a read-only sandbox, an
empty working directory and no saved session; the prompt goes in on standard input. An answer
counts only after the run reports a completed turn, and a run in which the model used a tool is
discarded. Failed runs get a small bounded retry; a malformed answer is re-asked once. The
adapter never opens the CLI's credential files, and it removes OPENAI_API_KEY and CODEX_API_KEY
from the CLI's environment so that only the signed-in account is used. Set CODEX_PATH when
`codex` is not on the service's PATH. See docs/native-run.md.

Every analysis, whoever starts it, spends that one account's usage, and the workspace has no
login. Keep a hosted deployment private or behind an authenticated access layer.

## Reading documents

| Upload | How its text is obtained |
| --- | --- |
| Text file | Decoded as UTF-8; a form feed starts a new page. |
| PDF page with a text layer | Copied exactly with PyMuPDF. The model is not called. |
| PDF page without one (a scan) | Rendered to an image and transcribed by the model, four pages at a time. |
| Word (.docx) | Typed text and tables are read from the file itself. Pages follow Word's last saved layout or explicit page breaks; a file with neither is cut into page-sized parts. Letterhead and footer text is kept once, on page 1. |
| Picture inside a Word file | Transcribed by the model and placed where the picture sits. |

Pages read by the model carry `method: "luna"` and are labelled "Read by AI" in the document
list and the page viewer. The reader is told to copy, not interpret: it writes `[illegible]`
instead of guessing, marks `[signature]`, `[stamp]` and `[seal]`, and reports a page with no
text as blank. When the AI engine is unavailable the upload still succeeds: Tesseract is tried
if installed, otherwise a scan is stored as unreadable and an unread picture is counted on its
page. Add the file again once the engine is available. Older `.doc` files and image files are refused.

Official references:
- https://developers.openai.com/api/docs/models/gpt-6-luna
- https://learn.chatgpt.com/docs/non-interactive-mode

## Checks

    cd backend
    uv sync --extra test --python 3.12
    uv run pytest

    cd ../frontend
    npm ci
    npm run build
    npm run test:e2e      # needs the Vite dev server on 127.0.0.1:5173

Backend tests use scripted model responses and an isolated temporary SQLite database; they
verify contracts and workflow controls, not model accuracy. Browser tests run in headless
Chrome against intercepted fictional API responses.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /health | Liveness and model configuration |
| GET | /system/status | Database, queue, worker and Tesseract availability, with counts |
| GET / POST | /cases | List (with counts) / create claims |
| PATCH / DELETE | /cases/{id} | Correct the title or claim reference / delete a claim and everything it owns |
| GET / POST | /cases/{id}/documents | Inventory / upload a PDF, .docx or text file; kind=auto suggests a category; logical_id creates a new version |
| GET / PATCH / DELETE | /cases/{id}/documents/{document} | Read pages / correct the category / remove an unused document |
| GET | /cases/{id}/documents/{document}/pages/{page} | Extracted source page |
| GET | /cases/{id}/documents/{document}/original | Download the immutable original |
| GET | /cases/{id}/timeline | Dated lines found in the newest document versions |
| GET / POST | /cases/{id}/analyses | History / snapshot latest versions and enqueue |
| GET | /cases/{id}/analysis-events | Server-sent analysis status |
| GET / DELETE | /analyses/{run} | Run state / delete a finished run with its report |
| POST | /analyses/{run}/resume | Resume a paused run from its checkpoint |
| GET | /analyses/{run}/workflow | The analysis as it ran: attempts, steps, timings, tool and model calls |
| GET | /system/integrations | How neatlogs, Entire, cfo.ai and the core stack are used here |
| GET | /business/metrics.csv | Monthly usage totals for the cfo.ai model (no claim content) |
| GET | /business/impact | Latest-report impact totals, with customer and sample activity separated |
| GET | /reports/{report} | Immutable report plus the customer's saved edits |
| PUT | /reports/{report}/draft, /checklist | Save the edited letter / ticked next steps |
| GET | /reports/{report}/reviews | Review decisions for the report |
| GET | /reports/{report}/package | ZIP response package |
| GET | /review-queue | Findings that need a person (reviewer mode) |
| POST / GET | /tasks/{run}:{request}/review(s) | Record a decision (reviewer mode) / read history |
| GET / POST | /samples, /samples/{key} | List / create a sample claim |
| POST / GET | /inquiries | Save a name and email left through the landing page / list them |
| POST | /cases/{id}/sample-follow-up | Add a sample's second-round documents |

## Step record

Each workflow step is stored in the run_events table as it starts and finishes: its name,
kind, timing, counts and outcome, the same metadata that is traced to neatlogs. No document
text is stored there. It feeds the Analysis workflow page and the monthly usage totals.
Analyses made before the table existed are filled in from logs/telemetry-worker.jsonl the
first time their workflow is opened.

## Current limits

Extraction happens in the API's thread pool, not an extraction queue, so an upload of many
scanned pages holds its request open while they are read. A transcription is not checked
against the page image by a second pass: citations are verified word for word against the
transcribed text, so compare "Read by AI" pages with the original. Footnotes, comments and
text inside charts in Word files are not read. Contact-form entries are stored in the local
database only; nothing sends or forwards them. Retrieval is keyword
based. Each analysis snapshots the newest version of every document; older versions are kept
and reports can be compared, but one analysis does not read superseded versions. New uploads
need a new analysis; earlier reports are retained. Reviews append an audit event and do not
regenerate the report. Category suggestions and the timeline are keyword and date heuristics
that the customer can correct. Keep real medical records out of public demos.

## UI origin / CORS

APP_ORIGIN sets the UI origin (default http://127.0.0.1:5173). For local development the API
also accepts the equivalent localhost hostname on that same port. Other origins and ports are
refused. Vite uses strictPort so an occupied 5173 port produces an error instead of silently
changing the UI origin. If you choose another UI port, update APP_ORIGIN and restart the
backend. Restart the backend after any .env change.

## Backend file logging

API logs are appended to logs/api.log; worker analysis logs go to logs/worker.log. Native
processes use LOG_DIR (default ./logs). All logs/ directories are ignored by Git.

LOG_LEVEL defaults to INFO. Files rotate at LOG_MAX_BYTES (10 MiB by default), retaining
LOG_BACKUP_COUNT backups (default 5). Request bodies, headers, query strings, and raw
identifiers from URL paths are excluded. Exception records retain stack locations and
exception type while omitting exception messages and source lines that may contain
sensitive data.

## NeatLogs observability

API and worker tracing, metadata-only masking, local metrics and developer trace search are
implemented. See [observability setup and investigation](docs/observability.md).
