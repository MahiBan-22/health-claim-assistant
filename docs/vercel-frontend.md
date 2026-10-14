# Frontend deployment on Vercel

Use two projects connected to this repository. The frontend project uses Root
Directory `frontend`, the Vite preset, `npm ci`, `npm run build`, and output `dist`.
Set Node.js to 22.x.

Set `VITE_API_BASE=https://YOUR-BACKEND.vercel.app` in the frontend project's
Production environment. Use the API origin only, without `/api` or another path.
Set the corresponding Preview value only when a separate preview backend/database
exists. Vite embeds this setting at build time: redeploy after changing it.
The Vercel build rejects a missing or non-HTTPS API origin.

The EC2 rewrite has been removed. Browser requests now go directly to the separate
HTTPS backend project. Backend `APP_ORIGIN` must equal the exact frontend origin,
and `ALLOWED_HOSTS` must include the backend hostname. Arbitrary preview origins
are intentionally not accepted.

Follow [backend and PostgreSQL setup](vercel-backend.md) before cutting over the UI.
Verify `/health` on the backend, then create a synthetic case through the frontend,
upload a document, run analysis, and download originals and the response package.
The existing local development default remains `http://127.0.0.1:8000`.
