# Separate Vercel backend with PostgreSQL and OpenAI

The API and frontend are independent Vercel projects from the same repository.
The hosted API uses PostgreSQL for metadata, original document bytes, LangGraph
checkpoints and job ownership. It uses OpenAI Responses API calls instead of the
host's signed-in Codex CLI. No Redis server or persistent worker is needed in hosted mode.
Local mode keeps SQLite, files, Redis/RQ and the Codex CLI unless configured otherwise.

## 1. Create PostgreSQL

Use a managed PostgreSQL service (for example Neon through Vercel Marketplace, or
an existing managed PostgreSQL server). Create a project near your backend's Vercel
region, then a database named `claimwise` and a login role named `claimwise_app`.
Use PostgreSQL 15 or later. Enable TLS and backups. Choose a password in the provider
console and keep both connection strings in your password manager.

You need two connection URLs to the **same database**:

- `DATABASE_URL`: the normal application connection. A transaction-pooled URL is allowed.
- `CHECKPOINT_DATABASE_URL`: a **direct or session-pooled** URL. Do not use a transaction
  pooler here: workflow ownership uses session-level PostgreSQL advisory locks.

If the provider only gives a direct URL, use it for both variables. URL-encode special
characters in the password. Keep the provider's TLS parameters, usually `sslmode=require`.
Do not use a `localhost` database from Vercel.

On a PostgreSQL server where you create roles/databases yourself, run these as the
administrator, one statement at a time (CREATE DATABASE cannot run inside a transaction):

```sql
CREATE ROLE claimwise_app LOGIN;
-- Set the role password through your administrator UI, or psql: \password claimwise_app
CREATE DATABASE claimwise OWNER claimwise_app;
```

Reconnect your administrator tool to `claimwise`, then run:

```sql
GRANT CONNECT ON DATABASE claimwise TO claimwise_app;
GRANT USAGE, CREATE ON SCHEMA public TO claimwise_app;
```

Managed providers often create the database owner role for you; use that application
role instead if custom role creation is restricted. The role needs schema creation
rights for initial setup and current additive application schema initialization.
No vector extension, pgvector, manual case tables or Redis database is needed.

## 2. Initialize the tables

Install Python 3.12 and uv locally. From the repository root:

```bash
uv sync --project backend --extra test --python 3.12
```

Create `backend/.env` using `backend/.env.example`. Add the two PostgreSQL URLs there.
Never commit this file. From `backend`, run:

```bash
uv run python -m app.checkpoints
```

This creates the application tables and LangGraph's checkpoint tables. It is safe
to rerun. Table setup does not call OpenAI. Keep the same database selected for both
URLs. The application tables are:

`cases`, `documents`, `document_files`, `analyses`, `reports`, `tasks`, `reviews`,
`report_notes`, `run_events`, `inquiries`.

LangGraph also manages its own checkpoint migration, checkpoint, blob and write tables.
`document_files.content` is PostgreSQL BYTEA and holds original files, cascading away
when the corresponding document is deleted. Database storage therefore grows with
uploads. For larger deployments, move file delivery to private object storage.

## 3. Configure the backend Vercel project

Import the repository as a **new** Vercel project:

| Setting | Value |
| --- | --- |
| Root Directory | `backend` |
| Framework | FastAPI |
| Python | 3.12 (pinned by `.python-version`) |
| Build Command | `python prepare_vercel.py` (from vercel.json) |
| Output Directory | Leave unset |
| Include source files outside Root Directory | Enabled; required to package sample fixtures |

`server.py` is the hosted entry point. The build copies repository fixtures into the
backend bundle. This copy contains synthetic sample documents, not user uploads.

Add these backend environment variables in Vercel Settings → Environment Variables:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Application PostgreSQL URL |
| `CHECKPOINT_DATABASE_URL` | Direct/session-pooled PostgreSQL URL |
| `OPENAI_API_KEY` | Your OpenAI project API key |
| `MODEL_PROVIDER` | `openai` |
| `LLM_MODEL` | `gpt-6-luna`, or an API model your project can access that supports text and images |
| `JOB_BACKEND` | `postgres` |
| `CRON_SECRET` | A long random secret; generate with `python -c "import secrets; print(secrets.token_urlsafe(32))"` |
| `APP_ORIGIN` | `https://YOUR-FRONTEND.vercel.app` (the URL you actually open) |
| `ALLOWED_HOSTS` | `YOUR-BACKEND.vercel.app` (add custom backend hostnames separated by commas) |
| `NEATLOGS_ENABLED` | `false` |

Never put API keys, database URLs or CRON_SECRET in frontend `VITE_*` variables.
API billing is separate from a ChatGPT/Codex subscription. The model is configurable;
key presence alone does not prove model access. `/system/model` reports configuration;
actual requests verify credentials and model access. Failed requests pause the analysis
with a safe message, and Resume retries from the saved checkpoint.

The hosted entry point defaults to 4,000,000-byte originals, eight pages per document,
60-second individual model HTTP timeouts and 300-second function duration. These
conservative limits fit smaller hosted cases. Large ZIP response packages are rejected
at 4,000,000 bytes; download individual originals or split the case. Multipart overhead
is outside the original-file limit. A slow scan extraction can still time out; use
text-layer PDFs or smaller documents. These are deliberate differences from local mode.

## 4. Enable scheduled analysis

The committed Vercel Cron schedule calls `GET /internal/jobs` once per minute.
**This schedule requires Vercel Pro or another plan that permits minute-level Cron.**
Vercel automatically sends `Authorization: Bearer <CRON_SECRET>`; the handler rejects
missing/incorrect secrets. Cron runs only on production deployments.

Each invocation advances one workflow node for one pending run and persists its
checkpoint. Jobs remain queued between invocations; a report with several requests
can take several minutes. Competing invocations skip a run already locked by another
instance. If a function stops mid-step, the next invocation can retry its last durable
checkpoint. A crash can repeat an OpenAI call and incur additional usage; report
creation is idempotent per analysis. Paused runs require Resume, as in local mode.

For Vercel Hobby, remove the `crons` entry from `backend/vercel.json` before deployment
and arrange an external scheduler to call this HTTPS endpoint every minute with the
same Authorization header. Without a scheduler analyses remain queued. The external
scheduler must target the backend's production hostname and allow requests up to
300 seconds. Do not expose CRON_SECRET to the browser.

## 5. Connect the frontend and verify

Set `VITE_API_BASE=https://YOUR-BACKEND.vercel.app` on the frontend Vercel project,
then redeploy. See [frontend setup](vercel-frontend.md).

Check these with fictional documents:

1. Backend `/health` returns JSON and reports `model_access: openai`.
2. Case create/list/update works across requests and cold starts.
3. Upload, replacement, original download, page view and case/document deletion work.
4. A new analysis progresses when Cron runs, produces a report and downloads a ZIP.
5. Resume works after a model failure; duplicate scheduler calls do not run a locked job twice.
6. Analysis notifications update without Redis; hosted SSE emits short polling snapshots.

A 400 usually means a missing backend hostname in `ALLOWED_HOSTS`; a 403 means the
browser origin differs from `APP_ORIGIN`. A 401 on `/internal/jobs` means CRON_SECRET
or its Authorization header is wrong. A queued run needs the scheduler. Check Vercel
function logs for failures. Preview deployments need their own database and a scheduler
if testing analyses; do not point previews at production claim data.

## Existing EC2 data and deployment

These changes start with the selected PostgreSQL database; they do not automatically
import existing SQLite data, originals or checkpoints. Back up EC2 data before cutover.
If existing cases must be retained, migrate them before directing users to the new UI.
Do not point an in-flight EC2 worker at the hosted database.

The EC2 deployment job is now opt-in: it runs only on a manual workflow dispatch with
repository variable `ENABLE_EC2_DEPLOY=true`. Pushes still run its backend checks.
NeatLogs is an optional `tracing` extra so the hosted dependency bundle does not pull
in its large integration dependency tree. Install that extra if using tracing locally.

This application still has a single shared workspace and no user authentication.
CORS is an origin boundary, not an identity system. Keep demos synthetic; real medical
records need authentication and owner authorization before shared public hosting.

## References

- [Vercel FastAPI](https://vercel.com/docs/frameworks/backend/fastapi)
- [Vercel Cron security](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
- [Cron plan restrictions](https://vercel.com/docs/cron-jobs/usage-and-pricing)
- [Function limits](https://vercel.com/docs/functions/limitations)
- [PostgreSQL database creation](https://www.postgresql.org/docs/17/manage-ag-createdb.html)
- [OpenAI Responses API](https://developers.openai.com/api/reference/python/resources/responses/methods/create)
