# Native Windows runtime with Docker infrastructure

Run FastAPI, the RQ worker and Vite on Windows. Docker runs Redis only by default.
The API and worker run as your Windows user, so model calls go through the Codex CLI
you are signed in to and no model credentials are shared with a container.

## Start

From a PowerShell terminal in the repository:

    .\scripts\start-native.ps1

The script installs locked Python/frontend dependencies, stops this project's
Docker application containers, starts Docker Redis on 127.0.0.1:6379, and launches
native services in hidden windows. API/UI ports are 8000/5173. Logs are in logs/.
Use -SkipInstall when dependencies are already installed. A .env file is optional:
every setting has a localhost default and the workspace has no login.

For the first migration from existing Docker data:

    .\scripts\start-native.ps1 -ImportDockerData

Import refuses to overwrite an existing native app.sqlite. It stops the Docker
application processes, copies /data including SQLite WAL files, checks database
integrity, verifies every original document's SHA256, and normalizes stored paths
for Windows. The original Docker volume is preserved. Do not switch back to the
old Docker API while expecting it to see subsequent native changes: these are
separate storage copies.

Once imported, use start-native.ps1 without -ImportDockerData on later launches.
If PowerShell blocks local scripts, run the reviewed script with a process-scoped
execution policy rather than changing the system-wide policy:

    powershell -ExecutionPolicy Bypass -File .\scripts\start-native.ps1 -SkipInstall

## Model access

The workspace has no sign-in. Analyses and scan reading run through the Codex CLI
signed in for the Windows user that starts the app.

1. Install the Codex CLI and run `codex login` once in a terminal. `codex login status`
   should then report that you are logged in.
2. Start the app and open http://127.0.0.1:5173. The header shows All systems ready
   when the CLI is signed in and its account lists the configured gpt-6-luna model.
   There is no silent fallback to another model.
3. If the header shows AI engine unavailable, open it to read why (CLI not found,
   signed out, or model not listed), fix that in a terminal and choose Check again.
4. Start a new analysis, or use Resume on a paused run under Analyses.

Each model call starts one `codex exec` process with the CLI's tools switched off, a
read-only sandbox, an empty temporary working directory and no saved session. The
application never opens the CLI's credential files and holds no tokens of its own;
the CLI refreshes its sign-in itself. OPENAI_API_KEY and CODEX_API_KEY are removed
from the CLI's environment, so the signed-in account is always the one used. The
browser and .env never receive model credentials.

Set CODEX_PATH to the CLI's full path when `codex` is not on the PATH of the API and
worker processes, then restart both. To change accounts, run `codex logout` and
`codex login` in a terminal; the workspace notices within about a minute.

Every analysis spends the signed-in account's usage, and each call also carries the
CLI's own instructions, so token counts are higher than the claim text alone. Account
entitlement and model availability are established only by a real run: the test suite
never starts the CLI.

## Database and files

Native database: <repository>/data/app.sqlite.
Original uploads: <repository>/data/cases/.
Graph checkpoints: <repository>/data/checkpoints.sqlite (created when graph work begins).
Runtime metadata and process IDs: <repository>/data/runtime/.
API/worker logs: <repository>/logs/api.log and logs/worker.log.

Manual SQL from a root terminal:

    .\backend\.venv\Scripts\python.exe -m sqlite3 .\data\app.sqlite

The native launcher uses the same root data/log paths for both Python processes.
Do not start API and worker from different working directories with different
relative DATA_DIR values.

## Stop and restart

Wait for active analysis work to finish, then:

    .\scripts\stop-native.ps1

This stops only the recorded native process trees after checking their start times
and executable paths. Redis and data remain. Restart with start-native.ps1
-SkipInstall.

An analysis interrupted by a stop, crash or reboot is not lost. On start the worker
takes data/runtime/worker.lock, moves any run left as running back to queued and
re-enqueues unfinished runs; each resumes from its LangGraph checkpoint and still
produces exactly one report. If Redis drops the connection, the worker loop restarts
itself with a short backoff instead of exiting. The workspace header and the System
status panel report a stopped worker within seconds, because they test that lock
rather than the worker's Redis registration.

Optional old container mode:

    docker compose --profile containers up -d --build

Its images carry neither the Codex CLI nor a sign-in, so live model access is
unavailable there; use native mode. Default docker compose up -d starts Redis only.

The Windows worker executes one job at a time in process with timer-based
timeouts. Process isolation is pending.

## Diagnostics

    .\backend\.venv\Scripts\python.exe -m app.runtime_probe

This enqueues a non-medical probe to confirm that a native Windows worker can
reach Redis and the Codex CLI. It reports the CLI's state in words and never returns
credentials. Scanned PDF pages and pictures inside Word files are read by the model.
Tesseract is only a fallback for when the AI engine is unavailable; PDFs with a text
layer, Word files and UTF-8 text need neither.

Official reference:
- https://learn.chatgpt.com/docs/non-interactive-mode

## Analysis history and reports

Open a claim and choose Analyses to see every run, including earlier ones while a
new run is active. Completed runs have a View report button. Paused runs can be
resumed. Delete asks for confirmation and removes the run, its report, review
records and graph checkpoint while keeping uploaded documents. Queued/running
analyses cannot be deleted. A report can be compared with the previous one, and
its reply letter, checklist and ZIP package are available from the report screen.

Analysis status uses a server-sent event connection per selected claim. The worker publishes status changes through Redis; the API sends updated
history over the existing connection. Heartbeats keep it open without querying
SQLite. Reconnects use a fresh snapshot to recover missed changes. The UI displays
connection health and retries interrupted connections with a bounded backoff.
AI engine status checks are separate from analysis notifications.
