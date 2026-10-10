# Health Claim Evidence Assistant (Claimwise)

Implementation of [Health_Claim_Architecture.md](Health_Claim_Architecture.md): a localhost
workspace that reconciles an insurer's letter with the customer's documents and policy,
shows what is supported and what is missing, and drafts a reply with page-level citations.

**Recommended: native Windows API, worker and UI, with Redis in Docker.**
See [native setup and ChatGPT sign-in](docs/native-run.md).
Read the [architecture review and verification record](docs/architecture-review.md).

## Included

- React/TypeScript workspace styled with Tailwind CSS v4, with AG Grid tables for documents,
  findings and the review queue. Three core screens: claim workspace, evidence report, review desk.
- **No login.** The workspace opens directly. The API answers only its own interface on the
  loopback address (see "Local access boundary").
- Drag-and-drop upload with suggested categories, versioned replacements, SHA256 hashes,
  immutable originals, PDF text/OCR extraction, a dated timeline and a page viewer that
  highlights the cited passage.
- FastAPI APIs, SQLite metadata and LangGraph checkpoints with planner, Policy, Evidence and
  Verifier roles. Policy wording is read before the customer answer is written.
- One corrective cycle per request, deterministic citation and identifier checks, statement-level
  verification, explicit uncertainty and an auditable review history.
- RQ/Redis job transport with a self-restarting worker that re-queues interrupted analyses.
- Response package: editable reply letter, next-step checklist, attachment manifest and a ZIP
  with the letter, a readable summary, the structured report and the cited originals.
- Five synthetic walkthrough scenarios that can be opened from the home screen.
- OAuth-only model adapter configured to **gpt-6-luna** for every application LLM call.

**This is a working localhost build, not a production service.** Chroma/BGE retrieval, selective
invalidation of findings, historical version comparison inside one analysis, multi-account
selection and live partner integrations other than NeatLogs tracing remain pending. Live
inference pauses without an authorized credential and an account-visible Luna model. Test
replay is never used as live inference.

## Local setup

Use Python 3.12, Node 22+, Redis, and Tesseract for scanned PDFs (optional). Native Windows
uses RQ SimpleWorker with timer-based timeouts; Linux uses the standard RQ worker.

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
7. Open http://127.0.0.1:5173. Choose **AI engine** in the sidebar and continue with ChatGPT
   once. API docs are at http://127.0.0.1:8000/docs.

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
API/UI/queue processes but has no OS-vault bridge: host keyring credentials are not visible
inside Linux containers, so live inference there remains blocked. Use native mode for live
analysis. The frontend image runs Vite for localhost development, not production hosting.

After a backend code change, load it with `docker compose up -d --build --no-deps api worker`.

## Model connection

All planner/specialist calls share LLM_MODEL=gpt-6-luna. The adapter queries the signed-in
account's model catalog and requires that exact slug. It uses the public Responses endpoint,
store=false, stream=true, and a completed terminal event. Rate-limit and server errors get a
small bounded retry; a malformed answer is re-asked once. It never reads OPENAI_API_KEY,
browser credentials, or Codex authentication files.

Tokens are obtained through the supported loopback OAuth flow and stored in the OS credential
vault. The native API and worker must run under the same OS user. See docs/native-run.md.

Official references:
- https://developers.openai.com/api/docs/models/gpt-6-luna
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in

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
| GET | /system/status | Database, queue, worker and OCR availability, with counts |
| GET / POST | /cases | List (with counts) / create claims |
| PATCH / DELETE | /cases/{id} | Correct the title or claim reference / delete a claim and everything it owns |
| GET / POST | /cases/{id}/documents | Inventory / upload; kind=auto suggests a category; logical_id creates a new version |
| GET / PATCH / DELETE | /cases/{id}/documents/{document} | Read pages / correct the category / remove an unused document |
| GET | /cases/{id}/documents/{document}/pages/{page} | Extracted source page |
| GET | /cases/{id}/documents/{document}/original | Download the immutable original |
| GET | /cases/{id}/timeline | Dated lines found in the newest document versions |
| GET / POST | /cases/{id}/analyses | History / snapshot latest versions and enqueue |
| GET | /cases/{id}/analysis-events | Server-sent analysis status |
| GET / DELETE | /analyses/{run} | Run state / delete a finished run with its report |
| POST | /analyses/{run}/resume | Resume a paused run from its checkpoint |
| GET | /reports/{report} | Immutable report plus the customer's saved edits |
| PUT | /reports/{report}/draft, /checklist | Save the edited letter / ticked next steps |
| GET | /reports/{report}/reviews | Review decisions for the report |
| GET | /reports/{report}/package | ZIP response package |
| GET | /review-queue | Findings that need a person (reviewer mode) |
| POST / GET | /tasks/{run}:{request}/review(s) | Record a decision (reviewer mode) / read history |
| GET / POST | /samples, /samples/{key} | List / create a sample claim |
| POST | /cases/{id}/sample-follow-up | Add a sample's second-round documents |

## Current limits

Extraction happens in the API's thread pool, not an extraction queue. Retrieval is keyword
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
