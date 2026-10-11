# Frontend deployment through the Vercel dashboard

The frontend is a static Vite application. Its production API base defaults to `/api`.
`frontend/vercel.json` forwards `/api/*` to:

```text
http://ec2-54-158-24-179.compute-1.amazonaws.com:8000/*
```

The browser uses your HTTPS Vercel origin, avoiding browser mixed-content blocking.
The Vercel-to-EC2 connection still uses HTTP. Add TLS to the backend and update the
rewrite destination before sending sensitive records over that connection.
Vercel external rewrites are documented at https://vercel.com/docs/routing/rewrites.
API responses are configured not to be cached. Frontend navigation falls back to
`index.html`; API errors are kept separate from that fallback.

## Dashboard settings

Import the Git repository and configure:

| Setting | Value |
| --- | --- |
| Root Directory | `frontend` |
| Framework Preset | Vite |
| Install Command | `npm ci` |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Node.js Version | 22.x |
| Environment variables | None required |

Push these changes to the Git branch you import before deploying. The config file must
be within the selected `frontend` root. If a `VITE_API_BASE` variable already exists in
the Vercel project, remove it or set it to `/api` for Production and Preview. Do not set
it to the HTTP EC2 address. Vite embeds variables at build time, so redeploy after
changing them. The optional example is in `frontend/.env.example`.

## Configure the EC2 backend after getting your Vercel URL

Edit `/home/ec2-user/claim-wise-build/.env`, replacing `YOUR-PROJECT`:

```dotenv
APP_ORIGIN=https://YOUR-PROJECT.vercel.app
ALLOWED_HOSTS=127.0.0.1,localhost,ec2-54-158-24-179.compute-1.amazonaws.com,YOUR-PROJECT.vercel.app
```

Use the exact frontend origin, without a path or trailing slash. Use your custom domain
instead if that is the URL you open. The current backend supports one configured
frontend origin; arbitrary Vercel preview domains will not be accepted. Hostnames have
no scheme or port; both the EC2 and frontend hostname are listed for proxy routing.
Keep the existing loopback OAuth callback; changing it to the Vercel URL is unsupported
by the current backend auth implementation.

Stop the backend and restart it so the launcher copies the updated `.env`:

```bash
BIND_HOST=0.0.0.0 bash /home/ec2-user/claim-wise-build/ec2-run.sh
```

If managed by the existing systemd service with `BIND_HOST=0.0.0.0` configured:

```bash
sudo systemctl restart claim-wise-backend
```

EC2 port 8000 must be reachable from Vercel, not only from your laptop IP. A security
group rule allowing only your laptop will make the proxy fail. Use a suitable protected
ingress or Vercel egress configuration for the deployment; the current app has no login.

## Verify after deployment

1. Open `https://YOUR-PROJECT.vercel.app/api/health`; expect JSON with `status: "ok"`.
2. Open the frontend. In browser DevTools, API calls should go to your Vercel domain
   under `/api/`, never to the HTTP EC2 URL or `127.0.0.1`.
3. Create a synthetic sample claim and verify uploads, downloads and analysis updates.

A backend 400 indicates `ALLOWED_HOSTS`; 403 indicates `APP_ORIGIN`. A proxy timeout
or 502 requires checking EC2 reachability, the security group and the API listener.
Streaming status requests reconnect automatically; a proxy may close long connections.
Validate large uploads and long document extraction requests against the hosted proxy's
limits. The build can be checked locally with `cd frontend` and `npm run build`.

The existing headless EC2 credential-vault limitation still applies to live AI analysis.
This frontend configuration does not add server authentication or model credentials.
