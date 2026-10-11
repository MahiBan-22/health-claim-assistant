#!/usr/bin/env bash
# Invoked over SSH by .github/workflows/backend-ec2.yml as ec2-user.
set -Eeuo pipefail
umask 077
BUILD_DIR=/home/ec2-user/claim-wise-build
BACKEND_DIR=/home/ec2-user/claim-wise-backend
SERVICE=claim-wise-backend.service
incoming="${1:?Usage: bash deploy-ec2.sh /home/ec2-user/claim-wise-build/.incoming-RUN-ATTEMPT}"
fail() { echo "ERROR: $*" >&2; exit 1; }

[[ "$(id -un)" == ec2-user ]] || fail "Deploy as ec2-user."
[[ "$incoming" =~ ^/home/ec2-user/claim-wise-build/\.incoming-[0-9]+-[0-9]+$ ]] || fail "Unexpected upload directory."
for tool in python3.12 docker flock curl sudo systemctl; do
    command -v "$tool" >/dev/null || fail "Missing prerequisite: $tool (see docs/ec2-backend.md)."
done
[[ -r "$BUILD_DIR/.env" ]] || fail "Create $BUILD_DIR/.env before the first deployment. It is never uploaded by CI."
python3.12 -c 'import sys; assert sys.version_info[:2] == (3, 12), "Use Python 3.12"'
docker info >/dev/null 2>&1 || fail "Start Docker and grant ec2-user permission to use it."
docker compose version >/dev/null || fail "Install Docker Compose v2."
for file in claim-wise-backend.tar.gz claim-wise-backend.tar.gz.sha256 ec2-run.sh claim-wise-backend.service; do
    [[ -f "$incoming/$file" && ! -L "$incoming/$file" ]] || fail "Missing uploaded file: $file"
done

# Serialize manual and CI deployments too; the launcher holds a separate runtime lock.
exec 8>"$BUILD_DIR/.github-deployment.lock"
flock -n 8 || fail "Another GitHub deployment is running."
(cd "$incoming" && sha256sum --check claim-wise-backend.tar.gz.sha256)
bash -n "$incoming/ec2-run.sh"

# Installing the unit also handles first deployment, when no service exists yet.
sudo -n install -m 644 "$incoming/$SERVICE" "/etc/systemd/system/$SERVICE"
sudo -n systemctl daemon-reload
sudo -n systemctl stop "$SERVICE"
mkdir -p "$BACKEND_DIR"
flock -n "$BACKEND_DIR/.deployment.lock" -c true || fail "A foreground backend is still running. Stop it before deploying."

for file in claim-wise-backend.tar.gz claim-wise-backend.tar.gz.sha256 ec2-run.sh; do
    mv -f -- "$incoming/$file" "$BUILD_DIR/$file"
done
chmod 700 "$BUILD_DIR/ec2-run.sh"

# Equivalent to BIND_HOST=0.0.0.0 bash /home/ec2-user/claim-wise-build/ec2-run.sh.
# That launcher verifies and unpacks the tar into BACKEND_DIR, preserving .env,
# data, logs and .venv, installs runtime dependencies, then starts API and worker.
sudo -n systemctl enable --now "$SERVICE"

diagnostics() {
    sudo -n systemctl status "$SERVICE" --no-pager -l || true
    sudo -n journalctl -u "$SERVICE" -n 80 --no-pager || true
}

# First deployment may need several minutes to install the Linux dependencies.
runtime_python="$BACKEND_DIR/.venv/bin/python3.12"
for ((attempt=1; attempt<=120; attempt++)); do
    if sudo -n systemctl is-failed --quiet "$SERVICE"; then
        diagnostics
        fail "Backend service failed during startup."
    fi
    if sudo -n systemctl is-active --quiet "$SERVICE" && [[ -x "$runtime_python" ]] && \
        "$runtime_python" - <<'PY' 2>/dev/null
import json
from urllib.request import urlopen

def get(path):
    with urlopen("http://127.0.0.1:8000" + path, timeout=3) as response:
        return json.load(response)

assert get("/health")["status"] == "ok"
status = get("/system/status")
assert status["database"] and status["redis"] and status["workers"] >= 1
PY
    then
        echo "Deployment healthy: API, database, Redis and worker are running on port 8000."
        curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8000/health
        echo
        exit 0
    fi
    sleep 5
done
diagnostics
fail "Backend did not become healthy within the startup window."
