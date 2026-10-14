# Beginner guide: Neon database and a separate Vercel backend

Do one stage at a time. At the end of each stage, check the expected result before
moving on. You do not need to understand the entire guide before starting.

Your existing frontend stays in its existing Vercel project. We will create a second
Vercel project for the backend. Neon will hold the database used by that backend.

| Service | What it does |
| --- | --- |
| Existing Vercel frontend | Shows the application in your browser |
| New Vercel backend | Receives requests and runs the application logic |
| Neon PostgreSQL | Saves claims, documents, reports and analysis progress |
| OpenAI | Reads document images and generates analysis answers |

**Keep private:** your OpenAI key, Neon connection strings and CRON_SECRET. Add them
only where the guide says. Do not send them in chat or commit them to GitHub.

## Stage 1 — Create the Neon project

Do this in your browser. No terminal commands are needed yet.

1. Open https://console.neon.tech and sign in or create an account.
2. Choose **New project** or **Create project**. If you already have a project for
   this application, open it instead of creating another one.
3. Enter `claimwise` as the project name.
4. If asked for a PostgreSQL version, use the default version, provided it is 15 or later.
5. If asked for a cloud provider, choose AWS for this walkthrough.
6. If you have not chosen a backend Vercel region, choose AWS US East / Northern
   Virginia (`us-east-1`) when available. We can use the matching Vercel backend
   region later. If you already chose a different backend region, choose a nearby
   Neon region and tell me which one you selected.
7. Keep the other settings at their defaults and create the project. Use the free
   Neon plan for initial testing if it meets your account's current limits.
8. Open the project dashboard.

Neon normally supplies a default database called `neondb` and a database user (role).
Use those defaults. The Neon project name and database name do not need to match.
The default branch may be called `production` or `main`; use the one already selected.
You do not need to create a new role, write SQL or create application tables manually.

**Stage 1 is complete when:** you can open the `claimwise` project dashboard.

## Stage 2 — Save the two Neon connection strings

A connection string is a private address containing the database's username and password.
Our application needs two versions of the address, both pointing to the same database.

1. In the Neon project, click **Connect**.
2. Keep the default branch selected.
3. Select database `neondb` (or your existing application database).
4. Keep Neon's default database user selected.
5. Turn **Connection pooling** ON.
6. Copy the connection string into your password manager, labelled `DATABASE_URL`.
7. Turn **Connection pooling** OFF.
8. Copy this connection string into your password manager, labelled
   `CHECKPOINT_DATABASE_URL`.

The pooled hostname usually contains `-pooler`. The direct hostname does not.
Do not remove the password or the settings after `?` from either string.
If Neon shows a shell command such as `psql 'postgresql://...'`, copy only the address
beginning with `postgresql://`, without `psql` or the surrounding quotes.

The second connection must be direct because the application uses it to prevent two
servers from processing the same analysis at once.

**Stage 2 is complete when:** you have saved both private addresses and know which is which.

## Stage 3 — Create the database tables from your Mac

Do this after Stage 2. You do not need to create the tables in Neon's SQL Editor.

1. Open the application folder in VS Code:
   `/Users/mahi/Desktop/health-claim-assistant`.
2. Open the `backend` folder in VS Code's file sidebar.
3. Create a file named `.env` inside `backend`. If it already exists, edit only the
   two database settings below; keep its other settings.
4. Add these two lines, replacing the text after each `=` with the correct saved
   Neon address. Do not type spaces around `=`.

```dotenv
DATABASE_URL=PASTE_YOUR_POOLED_NEON_ADDRESS_HERE
CHECKPOINT_DATABASE_URL=PASTE_YOUR_DIRECT_NEON_ADDRESS_HERE
```

5. Save the file. It is ignored by Git and must stay private.
6. Open **Terminal → New Terminal** in VS Code.
7. Paste and run this command to enter the application folder:

```bash
cd /Users/mahi/Desktop/health-claim-assistant
```

8. Install the backend's packages. This uses the uv executable already installed
   in this workspace and may download Python 3.12 if needed:

```bash
.venv/bin/uv sync --project backend --locked --extra test --python 3.12
```

9. Wait until the command finishes. Then enter the backend folder:

```bash
cd backend
```

10. Run the table-creation command:

```bash
.venv/bin/python -m app.checkpoints
```

Expected message:

```text
Application and checkpoint tables are ready.
```

11. Return to Neon and open **Tables** (possibly under **Postgres database**).
    Select the same branch and database, then refresh. You should see tables such
    as `cases`, `documents`, `analyses` and `reports`, plus checkpoint tables.

If a command fails, stop at that step and share the error with credentials removed.
Do not continue to Vercel until table creation succeeds.

**Stage 3 is complete when:** the success message appears and the tables are visible in Neon.

## Stage 4 — Prepare the GitHub scheduler for Vercel Hobby

Vercel Hobby allows a function to run for up to 60 seconds, and Vercel's own Cron
runs only once per day. This project needs to check the queue more often than once
a day. The repository therefore includes a GitHub Actions workflow that calls the
backend every five minutes. GitHub scheduling can be delayed, so analyses may wait
for several minutes between steps.

The GitHub workflow is already in the repository at
`.github/workflows/analysis-scheduler.yml`. It stays idle until you add its two settings.
The URL and secret are added later, after Vercel gives you the backend address.

Before importing the backend, ensure the changes in this workspace have been pushed
to the GitHub repository you will import. Editing files on your Mac alone does not
update the code Vercel builds. The push may also rebuild the existing frontend. Its
new build requires `VITE_API_BASE`; connect it in Stage 8. The previous successful
frontend deployment normally remains available while a new build is in progress.

**Stage 4 is complete when:** the new backend code and scheduler workflow are visible
in the GitHub repository.

## Stage 5 — Create the backend project in Vercel

Use a new project. Keep your existing frontend project.

1. Open the Vercel dashboard and choose **Add New → Project**.
2. Import the same GitHub repository used by your frontend.
3. Give this new project a distinct name, for example `claimwise-backend-mahi`.
4. Set **Root Directory** to `backend`.
5. Set **Framework Preset** to **FastAPI**, if not detected automatically.
6. Use build command `python prepare_vercel.py`. The repository configuration
   already specifies it.
7. Leave **Output Directory** unset. This is an API project, not a static frontend.
8. Enable **Include source files outside of the Root Directory in the Build Step**.
   This lets the build include the application's fictional sample documents.
   If this control is only available after project creation, enable it under the
   project's build/root-directory settings and redeploy before checking the app.
9. Open **Environment Variables** on the import screen. Add the values in Stage 6
   before clicking Deploy.

If your dashboard's wording differs slightly, look for the matching setting; do not
change the frontend project's Root Directory to `backend`.

## Stage 6 — Add the backend environment variables

An environment variable is a named setting. In Vercel, enter its name in the **Key**
field and its value in the **Value** field. Add each row separately.
Choose **Production** as the environment for this walkthrough. Do not share this
production database with preview deployments.

| Key — enter exactly | Value — what you enter |
| --- | --- |
| `DATABASE_URL` | The pooled Neon address saved in Stage 2 |
| `CHECKPOINT_DATABASE_URL` | The direct Neon address saved in Stage 2 |
| `OPENAI_API_KEY` | Your private OpenAI API key |
| `MODEL_PROVIDER` | `openai` |
| `LLM_MODEL` | `gpt-6-luna`, if your API project has access; otherwise we must choose an accessible text-and-image model |
| `JOB_BACKEND` | `postgres` |
| `NEATLOGS_ENABLED` | `false` |
| `APP_ORIGIN` | Your existing frontend URL, such as `https://YOUR-FRONTEND.vercel.app`, with no trailing slash |
| `ALLOWED_HOSTS` | Temporarily `localhost`; replace it with the real backend hostname in Stage 7 |
| `CRON_SECRET` | The private random value generated below |

To generate CRON_SECRET, run this in the VS Code terminal:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

Copy the printed value into CRON_SECRET and save it privately. It is a password for
the background scheduler. It is not your OpenAI key or Neon password.

These variables belong to the **backend Vercel project**. They do not belong in the
frontend project. Do not add quotation marks around values in Vercel's Value field.

**Stage 6 is complete when:** all ten variables have been added to the backend project.

## Stage 7 — Deploy and set up the GitHub scheduler

1. Click **Deploy** and wait for the build to finish.
2. Open the new backend project's **Settings → Domains**, or its production domain
   shown on the dashboard. Copy the stable production URL, not a temporary URL for
   an individual deployment. For example:
   `https://claimwise-backend-mahi.vercel.app`.
3. Open **Settings → Environment Variables** in the backend project.
4. Edit `ALLOWED_HOSTS`. Replace `localhost` with your actual backend hostname:

```text
claimwise-backend-mahi.vercel.app
```

Use your real hostname. Leave out `https://`, paths and trailing slashes.

5. Save the variable.
6. If you chose Neon Northern Virginia, set the backend's **Function Region** to
   Washington, D.C. / `iad1`, where the region setting is available.
7. Open **Deployments**, use the latest deployment's menu and choose **Redeploy**.
   Environment-variable changes apply to a new deployment, not an existing one.
8. After it finishes, open your actual backend URL followed by `/health`:

```text
https://YOUR-BACKEND.vercel.app/health
```

You should see JSON containing `"status":"ok"` and `"model_access":"openai"`.
Opening the backend URL without `/health` may show Not Found; that is normal because
the backend has no homepage. A host error before replacing `localhost` and redeploying
is expected; it does not mean Neon is broken.

Now tell GitHub where to call the backend and give it the secret. In your GitHub repository:

1. Open **Settings → Secrets and variables → Actions**.
2. Under **Variables**, click **New repository variable**.
3. Enter name `CLAIMWISE_BACKEND_URL` and value equal to your backend's full origin,
   for example `https://claimwise-backend-mahi.vercel.app`. Do not add `/health`, a
   trailing slash or another path. Click **Add variable**.
4. Under **Secrets**, click **New repository secret**.
5. Enter name `CLAIMWISE_CRON_SECRET` and value equal to the same private random text
   you entered for `CRON_SECRET` in Vercel. Click **Add secret**.
6. Click the repository's **Actions** tab, choose **Advance hosted claim analyses**,
   then **Run workflow**. This manual first run checks that the URL and secret work.
7. Open that run. A green check means GitHub reached the backend. The workflow will
   run automatically about every five minutes after this. The schedule may be delayed.

Do not put the secret under Variables, and do not put it in the backend URL variable.
GitHub sends it privately to the backend in an Authorization header.

**Stage 7 is complete when:** `/health` works and the GitHub workflow's manual run is green.

## Stage 8 — Connect your existing frontend

Only do this after the backend health check succeeds.

1. Open the **existing frontend** Vercel project.
2. Go to **Settings → Environment Variables**.
3. Add or edit `VITE_API_BASE` for **Production**.
4. Set its value to your actual backend's full HTTPS origin:

```text
https://YOUR-BACKEND.vercel.app
```

Do not append `/api` or `/health`.

5. Save it, then redeploy the frontend from **Deployments → Redeploy**. Ensure this
   deployment uses the updated code from GitHub.
6. Open the frontend's usual production URL.
7. Create a fictional claim, upload small fictional documents and run an analysis.
8. Wait several minutes: scheduled processing advances one workflow step at a time.
9. Check that a report appears and that an original document downloads successfully.

If you use a custom frontend domain, `APP_ORIGIN` in the backend must be that exact
origin. Changing it requires redeploying the backend again.

**Stage 8 is complete when:** the frontend can create a claim and complete an analysis.

## If something goes wrong

| What you see | First thing to check |
| --- | --- |
| Backend build says files outside Root Directory are unavailable | Enable the setting in Stage 5 and redeploy |
| Deploy fails because of Cron frequency | You are likely on Hobby; return to Stage 4 |
| `/health` gives a host error / HTTP 400 | Backend `ALLOWED_HOSTS` must contain the real backend hostname |
| Browser API calls give HTTP 403 | Backend `APP_ORIGIN` must match the frontend URL you opened |
| Frontend build requests VITE_API_BASE | Add the variable to the frontend project and redeploy |
| Analysis stays queued | Check the backend scheduler |
| Analysis pauses with an OpenAI error | Check the API key, API billing and model access |
| Database tables are missing | Complete Stage 3 using the same database URLs as Vercel |

## What to know before using real records

This setup starts with a new Neon database. It does not copy old EC2 claims automatically.
The current application has one shared workspace and no user login, so use fictional
records during this walkthrough. Hosted uploads currently allow 4 MB and eight pages
per document. Large ZIP downloads may exceed the hosted limit.

For implementation details and existing-data considerations, see
[the technical reference](vercel-backend-reference.md).

Official dashboard references:

- [Neon Console and default database](https://neon.com/docs/get-started/signing-up)
- [Neon connection strings](https://neon.com/docs/connect/connect-from-any-app)
- [Vercel environment variables](https://vercel.com/docs/environment-variables)
- [Vercel Hobby function limits](https://vercel.com/docs/functions/limitations)
- [GitHub scheduled workflow interval](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
