# Deploy the backend with GitHub Actions

The workflow in [backend-ec2.yml](../.github/workflows/backend-ec2.yml) runs when
`backend/` changes on `main`. Changes to the packaged fixtures, deployment scripts,
EC2 documentation or workflow also trigger it. Pull requests targeting `main` run
build, tests and packaging only. **Run workflow** in the Actions tab can deploy
`main` manually, including the first deployment.

## What each run does

1. Installs Python 3.12 and the locked backend/test dependencies with uv, checks
   Python and Bash syntax, and runs the full pytest suite.
2. Runs `scripts/build_backend.py` to create and verify
   `claim-wise-backend.tar.gz` and its SHA-256 checksum. The tested package is saved
   as a GitHub artifact for seven days. Only the archive, checksum, launcher,
   deployment helper and systemd unit are uploaded; `.env` is excluded.
3. Copies those files over SSH into a unique staging directory beneath
   `/home/ec2-user/claim-wise-build`.
4. Checks prerequisites, the existing server `.env` and the archive checksum;
   installs the systemd unit; stops the previous service; and moves the new
   archive, checksum and launcher into `/home/ec2-user/claim-wise-build`.
5. Starts the service. Its `BIND_HOST=0.0.0.0` environment and Bash command are
   equivalent to:

   ```bash
   BIND_HOST=0.0.0.0 bash /home/ec2-user/claim-wise-build/ec2-run.sh
   ```

   The existing launcher verifies and unpacks the archive, replaces application
   code and fixtures in `/home/ec2-user/claim-wise-backend`, installs Linux runtime
   dependencies and starts the API and worker. Extraction is handled by the
   launcher rather than a second, duplicate `tar` command. Data, logs and `.venv`
   are preserved, and the server `.env` is copied from the build folder.
6. Waits for `/health` and `/system/status` to confirm the API, database, Redis and
   worker are ready. Failure prints systemd diagnostics and fails the workflow.
   Deployment is serialized and an active deployment is not cancelled by a push.

This is an in-place deployment with downtime during restart and dependency
installation, without automatic rollback. A failed deployment remains a failed
workflow even if systemd subsequently restarts the backend successfully.

## One-time EC2 setup

Use `ec2-user` on the instance and complete the prerequisites in
[ec2-backend.md](ec2-backend.md#2-prepare-ec2-once): Python 3.12 with pip/venv,
Docker Engine, Docker Compose v2 with `up --wait`, Bash 4.3+, `flock`, `curl`, and
the Codex CLI when model access is needed. Enable Docker at boot. `ec2-user` must
be able to use Docker and run the deployment's `sudo` commands without a password
(`sudo -n`): installing the service unit and managing/inspecting it with systemctl
and journalctl. Standard EC2 sudo access usually provides this.

Create the private build folder:

```bash
install -d -m 700 /home/ec2-user/claim-wise-build
nano /home/ec2-user/claim-wise-build/.env
chmod 600 /home/ec2-user/claim-wise-build/.env
```

Use [ec2-backend.env.example](ec2-backend.env.example) as the `.env` contents,
including the EC2 `DATA_DIR`, `LOG_DIR`, `FIXTURES_DIR` and `REDIS_URL`. For the
current Vercel frontend, set:

```dotenv
APP_ORIGIN=https://health-claim-assistant.vercel.app
ALLOWED_HOSTS=127.0.0.1,localhost,ec2-54-158-24-179.compute-1.amazonaws.com,health-claim-assistant.vercel.app
```

Update the hostnames if your addresses differ. Set `CODEX_PATH` to the full CLI
path if it is outside the service's PATH, and sign in as `ec2-user` as described
in the existing backend guide. `BIND_HOST` is configured in the service, not `.env`.

If a foreground `ec2-run.sh` is already running, stop it before the first workflow
deployment. The helper fails rather than killing an unmanaged process. The
workflow creates `claim-wise-backend.service` automatically, enables it at boot,
and starts it without tying its lifetime to the SSH session.

## GitHub secrets

Under **Settings → Secrets and variables → Actions**, add these repository secrets
(or secrets on the `production` environment):

| Secret | Value |
| --- | --- |
| `EC2_HOST` | Instance public DNS name or IPv4 address, without scheme, port or username; currently `ec2-54-158-24-179.compute-1.amazonaws.com` |
| `EC2_SSH_PRIVATE_KEY` | Full private SSH key, including BEGIN/END lines; its public key must be authorized for `ec2-user`; use a key that works without an interactive passphrase |
| `EC2_SSH_KNOWN_HOSTS` | Verified OpenSSH known_hosts entry for the exact value of `EC2_HOST` |

The workflow connects as `ec2-user` on port 22 and uses strict host-key checking.
To construct the known_hosts entry, get the public host key from the instance
through an already trusted SSH session or AWS console session:

```bash
sudo cat /etc/ssh/ssh_host_ed25519_key.pub
```

If that prints `ssh-ed25519 AAAA... server-comment`, the secret should be one line:

```text
ec2-54-158-24-179.compute-1.amazonaws.com ssh-ed25519 AAAA...
```

Use the actual key, not the placeholder, and match the hostname/IP in `EC2_HOST`.
The host public key is different from the SSH login private key.

The EC2 security group and host firewall must let the GitHub runner reach SSH
port 22. For Vercel access, port 8000 must be reachable from the intended proxy
egress, not just from your laptop. Use protected ingress for this app, which has
no login. The workflow changes neither AWS network rules nor the Vercel rewrite.
Keep the rewrite destination in `frontend/vercel.json` aligned with the instance's
public address; an Elastic IP or stable backend domain avoids address changes.

## Run and verify

Commit and push the workflow and scripts to `main`, then use **Actions → Backend
build, test and EC2 deployment → Run workflow**, selecting `main`. Subsequent
backend changes on `main` deploy automatically after tests pass. The deploy job
uses the `production` environment and respects any rules you configure there.

After the workflow succeeds, verify the public proxy as well:

```text
https://health-claim-assistant.vercel.app/api/health
```

Expect JSON with `status: "ok"`. The workflow's health checks run inside EC2;
if they pass but the public URL returns 502, check Vercel's target address,
the security group and the host firewall. A backend 400/403 suggests the configured
host/origin values instead.

To inspect startup or runtime failures on EC2:

```bash
sudo systemctl status claim-wise-backend --no-pager -l
sudo journalctl -u claim-wise-backend -n 100 --no-pager
```
