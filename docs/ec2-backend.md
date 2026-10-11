# Windows build and EC2 backend

For automatic build, test, packaging and EC2 deployment after backend changes on
`main`, use [the GitHub Actions setup](ec2-github-actions.md). That workflow installs
the systemd service with `BIND_HOST=0.0.0.0`; the manual launcher below defaults to
loopback access.

The package contains Python application source, pinned runtime requirements and the
synthetic sample fixtures used by the API. It excludes the frontend, tests, local
virtual environments, credentials, existing claim data and logs. Python source needs
no compilation on Windows. Linux dependencies are installed on EC2; never copy the
Windows virtual environment there.

## 1. Build on Windows

From the repository root in PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-backend.ps1
```

Requires Python 3.12 on Windows (the existing backend virtual environment, `py -3.12`,
or `python3.12` on PATH). Packaging itself installs nothing and uses the standard library.
Output is `dist/claim-wise-build/`:

```text
claim-wise-backend.tar.gz
claim-wise-backend.tar.gz.sha256
ec2-run.sh
.env
.env.example
DEPLOYMENT.md
```

Edit the generated `.env`. It starts with the values in
`docs/ec2-backend.env.example`; your real local `.env` is never read or bundled.
Subsequent builds preserve the generated `.env`. Set `APP_ORIGIN` to your frontend's
exact origin, and include your API hostname in `ALLOWED_HOSTS` if using a reverse proxy.
The optional NeatLogs key is needed only when enabling tracing. `CRUSTDATA_API_KEY` is
reserved for the existing integration; it is not required for backend startup.

## 2. Prepare EC2 once

Log in as `ec2-user`. Install **Python 3.12 with pip and venv support**, Bash 4.3+,
tar, util-linux (`flock`), coreutils (`sha256sum`), Docker Engine and the Docker Compose
v2 plugin supporting `up --wait`. Start Docker and give `ec2-user` access to it;
log in again after changing group membership. Enable Docker at boot if using systemd.
The launcher pulls and starts Redis in Docker automatically; no host Redis installation
is needed. Redis is the only required container service. SQLite is built into Python.
Install Tesseract and English language data if you need OCR without a model connection.
Package names vary between Amazon Linux releases; this script deliberately does not
change OS packages.

Install the Codex CLI for `ec2-user` and sign in once. Analyses run through that
sign-in; the application has no sign-in of its own:

```bash
codex login --device-auth     # no browser on the server: approve the code from your own machine
codex login status            # expect a logged-in account
command -v codex              # note this path; see CODEX_PATH below
```

If ChatGPT refuses the code, allow device-code sign-in for Codex in your ChatGPT
security settings and repeat the command. Verify before deployment:

```bash
python3.12 --version
python3.12 -m pip --version
docker info
docker compose version
codex login status
tesseract --version           # optional OCR prerequisite
mkdir -p /home/ec2-user/claim-wise-build /home/ec2-user/claim-wise-backend
```

Use `PYTHON=/full/path/to/python3.12 bash .../ec2-run.sh` if Python has another location.
Outbound connections to PyPI and Docker Hub are required for the first deployment.
Host port 6379 must be free. Keep `REDIS_URL=redis://127.0.0.1:6379/0` for the
included Docker Redis service.

## 3. Copy from Windows

Replace the example key path and host:

```powershell
$ec2Host = "ec2-user@YOUR_EC2_HOST"
$keyPath = "C:\keys\your-key.pem"
scp -i $keyPath .\dist\claim-wise-build\claim-wise-backend.tar.gz .\dist\claim-wise-build\claim-wise-backend.tar.gz.sha256 .\dist\claim-wise-build\ec2-run.sh .\dist\claim-wise-build\.env .\dist\claim-wise-build\DEPLOYMENT.md "${ec2Host}:/home/ec2-user/claim-wise-build/"
```

The explicit `.env` argument ensures the hidden file is copied. Keep the build folder
private. On EC2:

```bash
chmod 700 /home/ec2-user/claim-wise-build
chmod 600 /home/ec2-user/claim-wise-build/.env
bash /home/ec2-user/claim-wise-build/ec2-run.sh
```

If an older Windows build reports a checksum filename ending in `$'\r'`, normalize
that checksum file once and retry:

```bash
sed -i 's/\r$//' /home/ec2-user/claim-wise-build/claim-wise-backend.tar.gz.sha256
bash /home/ec2-user/claim-wise-build/ec2-run.sh
```

Use `ls -la /home/ec2-user/claim-wise-build` to see `.env`; ordinary `ls` hides it.

The script checks the checksum when present, extracts into the backend folder, pulls
Redis if its image is missing, and waits for the container to become healthy. It creates
`.venv` using `python3.12`, installs requirements, copies `.env` with mode 600 and starts
the API plus RQ worker using `.venv/bin/python3.12`. Docker runs infrastructure only.
The API defaults to `127.0.0.1:8000`. Before starting it the launcher prints an
`AI engine:` line saying whether the Codex CLI is installed, signed in and lists the
configured model; a problem there is reported but does not stop the start.
Check `curl http://127.0.0.1:8000/health` and `curl http://127.0.0.1:8000/system/model`
from another EC2 terminal.
This command stays in the foreground; Ctrl+C stops both processes. A worker may finish
its current job during shutdown. Redis stays running, with data in the Docker volume
`claim-wise-infra_redis-data`. File logs are under `claim-wise-backend/logs/`.
After deployment, inspect or stop Redis separately (stopping preserves its data):

```bash
docker compose -p claim-wise-infra -f /home/ec2-user/claim-wise-backend/ec2-infrastructure.yaml ps
docker compose -p claim-wise-infra -f /home/ec2-user/claim-wise-backend/ec2-infrastructure.yaml stop redis
```

For private access from Windows, keep this tunnel open:

```powershell
ssh -i $keyPath -L 8000:127.0.0.1:8000 $ec2Host
```

Then visit `http://127.0.0.1:8000/docs`. The frontend is deployed separately.
For a reverse proxy, leave the API bound to loopback. For a direct private-network
listener, use `BIND_HOST=0.0.0.0 bash .../ec2-run.sh`; set `ALLOWED_HOSTS` and restrict
the EC2 security group appropriately. `BIND_HOST`, `PORT` and `PYTHON` are shell
variables for the launcher, not application `.env` settings.

## 4. Keep running after logout (optional systemd service)

After a successful foreground run, stop it with Ctrl+C. Create
`/etc/systemd/system/claim-wise-backend.service` using sudo:

```ini
[Unit]
Description=Claimwise API and worker
After=network-online.target docker.service
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
User=ec2-user
# Include the directory of `command -v codex`, and of `node` if Codex was installed with npm.
Environment=PATH=/home/ec2-user/.local/bin:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=/home/ec2-user/claim-wise-build
ExecStart=/bin/bash /home/ec2-user/claim-wise-build/ec2-run.sh
Restart=on-failure
RestartSec=10
TimeoutStopSec=660
KillMode=control-group
UMask=0077

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now claim-wise-backend
sudo systemctl status claim-wise-backend
journalctl -u claim-wise-backend -f
```

On subsequent deployments: stop the service, copy the new archive, checksum and launcher,
then start the service. Keep the EC2 `.env` unless intentionally changing configuration.
Data, logs and `.venv` survive extraction. Code and sample fixtures are replaced.
The launcher prevents overlapping deployments. This is an in-place deployment with
downtime; it does not provide automatic rollback. Back up claim data before upgrading.

## Dependency installation speed

`backend/requirements.txt` is exported from the existing `backend/uv.lock`, including
transitive versions and platform markers, without test dependencies or the local project.
EC2 runs `pip install --prefer-binary -r requirements.txt`, without building the project
from `pyproject.toml`. pip's download cache is retained. A requirements checksum skips
installation entirely on subsequent launches when the requirements are unchanged.
If manually repairing dependencies, remove `.venv/.requirements.sha256` and restart.

The first installation can still take time: the current NeatLogs dependency brings in
ChromaDB, ONNX Runtime and several instrumentation packages. A requirements file does
not remove those downloads. Disabling tracing does not change the dependency set.
Windows wheels cannot be reused as Linux dependencies.

After changing dependencies, update the lock and regenerate requirements using uv:

```powershell
uv lock --project backend
uv export --project backend --frozen --no-dev --no-emit-project --no-hashes --output-file backend/requirements.txt
```

Then rebuild and upload. Use Python 3.12 for this deployment; other Python versions
have not been validated by this workflow.

## Model access on EC2

The API and worker call the Codex CLI as `ec2-user`, using the account that
`codex login` signed in. The application holds no model credentials, opens none of the
CLI's files and offers no sign-in in the browser. `GET /system/model` reports whether
the CLI is installed, signed in and lists `LLM_MODEL`; the launcher prints the same
message at start.

- **Signed out or expired:** run `codex login --device-auth` as `ec2-user`. No restart
  is needed; the workspace notices within about a minute.
- **"The Codex CLI is not installed on the server, or CODEX_PATH does not point to
  it":** set `CODEX_PATH` in `/home/ec2-user/claim-wise-build/.env` to the output of
  `command -v codex`, or put its directory on the service's `PATH`, then restart.
  This is the usual cause under systemd, whose `PATH` is shorter than a login shell's.
- **Model not listed:** the signed-in account has no access to `LLM_MODEL`. No other
  model is used.
- **Same OS user:** run the service as the user that ran `codex login`. Another user,
  or a different `HOME` or `CODEX_HOME`, has no sign-in.
- **API keys:** `OPENAI_API_KEY` and `CODEX_API_KEY` are removed from the CLI's
  environment on purpose, so only the signed-in account is used.

Every analysis from every visitor spends that one account's usage, and a reached usage
limit pauses analyses until it resets. Each model call is one `codex exec` run with the
CLI's tools switched off and no saved session.

The application also has no user authentication or tenant isolation. Keep this backend
private or behind an authenticated access layer before using real claim records.
