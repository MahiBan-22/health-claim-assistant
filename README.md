# Health Claim Evidence Assistant

Initial implementation of [Health_Claim_Architecture.md](Health_Claim_Architecture.md).

**Recommended: native Windows API, worker and UI, with Redis in Docker.**
See [native setup and ChatGPT sign-in](docs/native-run.md).
Read the detailed [architecture review and remaining work](docs/architecture-review.md).

## Included

- React/TypeScript claim workspace, evidence report, source preview and reviewer view.
- FastAPI APIs with a required local access token and separate reviewer permission.
- Versioned uploads, SHA256 hashes, immutable original files, PDF text/OCR extraction.
- SQLite metadata and LangGraph checkpoints with planner, Evidence, Policy and Verifier roles.
- One corrective evidence cycle, source/version checks, explicit uncertainty, review audit events.
- RQ/Redis job transport, structured response draft and attachment manifest.
- OAuth-only model adapter configured to **gpt-6-luna** for every application LLM call.

**This is an initial vertical slice, not the completed MVP.** Native browser OAuth
registration, OS-vault credential storage and serialized token refresh are now
implemented. Chroma/BGE retrieval, automatic queue recovery, selective invalidation,
and live partner integrations remain pending. Live inference pauses without an authorized
credential and account-visible Luna model. Test replay is never used as live inference.

## Local setup

Use Python 3.12, Node 22+, Redis, and Tesseract for scanned PDFs. Native Windows
uses RQ SimpleWorker with timer-based timeouts; Linux uses the standard RQ worker.

1. Copy .env.example to .env at the repository root. Set different, long random values
   for LOCAL_ACCESS_TOKEN and REVIEWER_ACCESS_TOKEN. Never commit this file.
2. Start Redis locally without exposing it beyond loopback.
3. From the repository root, create a virtual environment and install the backend:

       uv venv --python 3.12
       uv pip install --python .venv/Scripts/python.exe -e ./backend[test]

   On Linux use .venv/bin/python instead of .venv/Scripts/python.exe.

4. Activate the environment (.\\.venv\\Scripts\\Activate.ps1 on Windows, or
   source .venv/bin/activate on Linux). From the root, start the API:

       python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000

5. From a second root terminal with the same environment and .env configuration:

       python -m app.worker

   Set PYTHONPATH=backend for the worker, or install the package as in step 3.
6. In frontend/, run npm ci, then npm run dev -- --host 127.0.0.1.
7. Open http://127.0.0.1:5173 and enter the local access token. API docs are at
   http://127.0.0.1:8000/docs. For reviewer actions, lock the workspace and reconnect
   with the reviewer token, then open the saved report by ID.

If using uv sync from backend/, run commands with its backend/.venv interpreter
and place a .env in the current command directory or export the settings explicitly.
Relative DATA_DIR paths are resolved from that command directory: API and worker
must share the same working directory and storage location.

## Docker skeleton

After configuring .env and starting Docker Desktop:

    docker compose --profile containers up --build

Ports bind to 127.0.0.1; Redis is private to Compose. Data is stored in named volumes.
Stop with docker compose down to preserve the volumes.

The container skeleton runs API/UI/queue processes. It does **not** yet supply a
usable OAuth credential-store bridge to the worker. Host OS keyring credentials
are not visible inside the Linux containers; live Docker inference remains blocked
until the OAuth subsystem and secure worker credential lifecycle are implemented.
The frontend image runs Vite for localhost development, not production hosting.

## Model connection

All planner/specialist calls share LLM_MODEL=gpt-6-luna. The adapter queries the signed-in
account's model catalog and requires that exact slug. It uses the public Responses
endpoint, store=false, stream=true, and a completed terminal event. It never reads
OPENAI_API_KEY, browser credentials, or Codex authentication files.

The native application now provides Continue with ChatGPT in the workspace. Tokens are obtained through the supported loopback OAuth flow and stored in the
OS credential vault. The native API and worker must run under the same OS user.
See docs/native-run.md for launcher, account status, model access and migration
instructions. No successful live inference is claimed before account authorization.

Official references:
- https://developers.openai.com/api/docs/models/gpt-6-luna
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in

## Synthetic fixture

Create a case with reference SYN-DEN-001. Upload fixtures/dengue/insurer-query.txt as
insurer_communication and provisional-summary.txt as clinical. Expected behavior is
in expected.json: a provisional summary must not satisfy the final-summary request,
and local upload must not imply confirmed insurer receipt. This fixture is a target
for live evaluation once OAuth is complete, not proof of a live result.

## Checks

    cd backend
    uv sync --extra test --python 3.12
    uv run pytest

    cd ../frontend
    npm ci
    npm run build

Backend tests use scripted model responses and an isolated temporary SQLite database;
they verify contracts and workflow controls, not model accuracy. The implementation
status and verification outcomes are recorded in docs/architecture-review.md.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /health | Liveness and model configuration |
| GET / POST | /cases | List/create local cases |
| GET / POST | /cases/{id}/documents | Inventory/upload; logical_id creates a replacement version |
| GET | /cases/{id}/documents/{document}/pages/{page} | Authorized extracted source page |
| GET | /cases/{id}/documents/{document}/original | Download immutable original version |
| POST | /cases/{id}/analyses | Snapshot latest versions and enqueue |
| GET | /analyses/{run} | Run state/error/report ID |
| POST | /analyses/{run}/resume | Resume a paused run using its existing checkpoint |
| GET | /reports/{report} | Immutable structured response package |
| POST | /tasks/{run}:{request}/review | Record reviewer decision and rationale |
| GET | /tasks/{run}:{request}/reviews | Read review audit history |

Use Authorization: Bearer <local-token> on all case/report/review endpoints. Only the
reviewer token can record review decisions. This is a single-user localhost boundary,
not multi-tenant production authentication. The UI retains the token only in memory.

## Current limits

Extraction happens in the API's thread pool, not an extraction queue. Retrieval is
keyword based. Runs select current versions; historical version comparison is pending.
New uploads require a new analysis; full reanalysis retains prior reports. A terminated
worker can leave a run marked running; queue reconciliation is pending. Reviews append
an audit event and do not yet generate a revised approved report. Package download is
structured JSON with a manifest, not a ZIP containing the original attachments.
Dependencies are constrained and lockfiles record resolved versions; compatibility
requires the documented checks. Keep real medical records out of public demos.

## UI origin / CORS

APP_ORIGIN sets the UI origin (default http://127.0.0.1:5173). For local
development the API also accepts the equivalent localhost hostname on that same
port. Other origins and ports remain blocked. Vite uses strictPort so an occupied
5173 port produces an error instead of silently changing the UI origin. If you
choose another UI port, update APP_ORIGIN and restart the backend. Restart the
backend after any .env or CORS configuration change.

When running Docker, backend source is copied into the image. After a backend
code change, load it with `docker compose up -d --build --no-deps api`.
`docker compose restart api` only restarts the existing image and does not load
source changes. Rebuild the worker too when its processing code changes.

## Backend file logging

API logs are appended to logs/api.log; worker analysis logs go to logs/worker.log.
Docker bind-mounts the repository logs/ folder so logs remain visible on the host
and survive container replacement. Native processes use LOG_DIR (default ./logs).
All logs/ directories are ignored by Git.

LOG_LEVEL defaults to INFO. Files rotate at LOG_MAX_BYTES (10 MiB by default),
retaining LOG_BACKUP_COUNT backups (default 5). API startup/shutdown, request
method/route template/status/duration, enqueue failures, and analysis outcomes
are logged. Request bodies, headers, query strings, and raw identifiers from URL
paths are excluded. Exception records retain stack locations and exception type
while omitting exception messages and source lines that may contain sensitive data.
Third-party library logs are not indiscriminately exported into these files.

After changing backend code or Compose mounts, rebuild the running services:

    docker compose up -d --build --no-deps api worker
