# Native Windows runtime with Docker infrastructure

Run FastAPI, the RQ worker and Vite on Windows. Docker runs Redis only by default.
This lets browser sign-in and model calls use the Windows user's protected
Credential Manager without sharing ChatGPT tokens with a container.

## Start

From a PowerShell terminal in the repository:

    .\scripts\start-native.ps1

The script installs locked Python/frontend dependencies, stops this project's
Docker application containers, starts Docker Redis on 127.0.0.1:6379, and launches
native services in hidden windows. API/UI ports are 8000/5173. Logs are in logs/.
Use -SkipInstall when dependencies are already installed.

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

## Connect ChatGPT

1. Open http://127.0.0.1:5173 and enter LOCAL_ACCESS_TOKEN from .env.
2. In ChatGPT connection, click Continue with ChatGPT. Allow the browser popup.
3. Sign in, select the intended workspace, and authorize the requested plan-use
   permissions. The first registration uses this application's own name.
4. On the completion page, close the sign-in tab and return to the workspace.
5. Refresh connection if needed. Analysis is enabled only if the account's model
   catalog contains the configured gpt-6-luna model. There is no silent fallback.
6. Start a new analysis, or resume a saved paused run through its API endpoint.

The sign-in route is http://127.0.0.1:8000/auth/chatgpt/callback. Keep the native
API running while completing sign-in. A stable, opaque host ID is stored under
 data/runtime/. OAuth state, PKCE, browser cookie binding, issuer, signature,
audience, nonce and granted permissions are validated. Each token set is stored
in the OS credential vault, chunked to fit Windows credential-size limits.
Refreshes are serialized across the API and worker using a local file lock.
The browser and .env never receive access or refresh tokens.

The current UI uses the profile selected by OAUTH_ACCOUNT (default: default).
Use a different profile label for a different account/workspace registration and
restart both native processes. A full multi-account picker is not yet implemented.
Disconnect clears local tokens, retains the verified account/client registration,
and attempts remote session revocation. If revocation cannot be confirmed, the
UI directs you to disconnect the app in ChatGPT Settings.

Account entitlement and model availability must be checked during a real sign-in.
Local tests do not establish eligibility, quota, or a successful live Luna call.
A purchased API key is neither needed by nor used by this connection path.

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
-SkipInstall. Avoid restarting during sign-in: pending OAuth transactions are
short-lived and held by the API process.

Optional old container mode:

    docker compose --profile containers up -d --build

This mode still lacks an OS-vault bridge for live model access; use native mode
for host ChatGPT sign-in. Default docker compose up -d starts Redis only.

The Windows worker executes one job at a time in process with timer-based
timeouts. Process isolation and automatic recovery after termination are pending.

## Diagnostics

    .\backend\.venv\Scripts\python.exe -m app.runtime_probe

This enqueues a non-medical probe to confirm that a native Windows worker can
reach Redis and the OS credential backend. It never returns credentials.
Tesseract must be installed on the host for scanned PDFs; native-text PDFs and
UTF-8 text fixtures do not require OCR.

Official references:
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
