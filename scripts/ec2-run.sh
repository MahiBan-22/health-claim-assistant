#!/usr/bin/env bash
# Run as ec2-user: bash /home/ec2-user/claim-wise-build/ec2-run.sh
set -Eeuo pipefail
umask 077
BUILD_DIR=/home/ec2-user/claim-wise-build
BACKEND_DIR=/home/ec2-user/claim-wise-backend
ARCHIVE="$BUILD_DIR/claim-wise-backend.tar.gz"
PYTHON="${PYTHON:-python3.12}"
fail() { echo "ERROR: $*" >&2; exit 1; }
for tool in "$PYTHON" tar flock sha256sum docker; do
    command -v "$tool" >/dev/null || fail "Missing prerequisite: $tool (see DEPLOYMENT.md)"
done
docker compose version >/dev/null || fail "Install the Docker Compose v2 plugin."
docker info >/dev/null 2>&1 || fail "Start Docker and grant ec2-user permission to use it."
[[ -r "$ARCHIVE" && -r "$BUILD_DIR/.env" ]] || fail "Build folder needs claim-wise-backend.tar.gz and .env"
"$PYTHON" -c 'import sys; assert sys.version_info[:2] == (3, 12), "Use Python 3.12"'
mkdir -p "$BACKEND_DIR"
exec 9>"$BACKEND_DIR/.deployment.lock"
flock -n 9 || fail "Backend is already running/deploying. Stop it before deploying again."
if [[ -f "$ARCHIVE.sha256" ]]; then
    # Accept checksum files generated or edited with Windows CRLF line endings.
    (cd "$BUILD_DIR" && tr -d '\r' < claim-wise-backend.tar.gz.sha256 | sha256sum --check -)
fi
STAGE=$(mktemp -d "$BACKEND_DIR/.release.XXXXXX")
api_pid= worker_pid=
cleanup() {
    trap - EXIT INT TERM
    [[ -z "$api_pid" ]] || kill -TERM "$api_pid" 2>/dev/null || true
    [[ -z "$worker_pid" ]] || kill -TERM "$worker_pid" 2>/dev/null || true
    [[ -z "$api_pid" ]] || wait "$api_pid" 2>/dev/null || true
    [[ -z "$worker_pid" ]] || wait "$worker_pid" 2>/dev/null || true
    rm -rf -- "$STAGE"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Reject traversal, links and unexpected top-level files before extraction.
"$PYTHON" - "$ARCHIVE" "$STAGE" <<'PY'
import sys, tarfile
from pathlib import PurePosixPath
with tarfile.open(sys.argv[1], "r:gz") as archive:
    members = archive.getmembers()
    allowed = {"app", "fixtures", "requirements.txt", "ec2-run.sh", "ec2-infrastructure.yaml", "DEPLOYMENT.md"}
    for member in members:
        p = PurePosixPath(member.name)
        if (not p.parts or p.is_absolute() or ".." in p.parts
                or p.parts[0] not in allowed or not member.isfile()):
            raise SystemExit("Unsafe or unexpected archive member: " + member.name)
    archive.extractall(sys.argv[2], members=members, filter="data")
PY
[[ -f "$STAGE/app/main.py" && -f "$STAGE/app/worker.py" && -f "$STAGE/requirements.txt" && -f "$STAGE/ec2-infrastructure.yaml" ]] || fail "Incomplete backend package"
# Pull Redis when absent, persist its data, and wait until it is healthy.
# API and worker run natively with Python 3.12, outside Docker.
docker compose -p claim-wise-infra -f "$STAGE/ec2-infrastructure.yaml" up -d --pull missing --wait --wait-timeout 90 redis
VENV="$BACKEND_DIR/.venv"
[[ -x "$VENV/bin/python3.12" ]] || "$PYTHON" -m venv "$VENV"
"$VENV/bin/python3.12" -c 'import sys; assert sys.version_info[:2] == (3, 12), "Recreate .venv with Python 3.12"'
requirements_hash=$(sha256sum "$STAGE/requirements.txt" | cut -d ' ' -f 1)
if [[ ! -f "$VENV/.requirements.sha256" ]] || [[ "$(cat "$VENV/.requirements.sha256")" != "$requirements_hash" ]]; then
    # Retain pip's download cache and prefer wheels; no project build is needed.
    "$VENV/bin/python3.12" -m pip install --prefer-binary -r "$STAGE/requirements.txt"
    "$VENV/bin/python3.12" -m pip check
    printf '%s\n' "$requirements_hash" > "$VENV/.requirements.sha256"
else
    echo "Requirements unchanged; reusing installed dependencies."
fi
# Replace code so deleted modules do not survive. Preserve data, logs and .venv.
for directory in app fixtures; do
    if [[ -d "$BACKEND_DIR/$directory" ]]; then mv "$BACKEND_DIR/$directory" "$STAGE/previous-$directory"; fi
    if [[ -d "$STAGE/$directory" ]]; then mv "$STAGE/$directory" "$BACKEND_DIR/$directory"; fi
done
for file in requirements.txt ec2-run.sh ec2-infrastructure.yaml DEPLOYMENT.md; do
    cp "$STAGE/$file" "$BACKEND_DIR/$file"
done
# Pydantic reads dotenv syntax; never execute .env as shell code.
cp "$BUILD_DIR/.env" "$BACKEND_DIR/.env"
chmod 600 "$BACKEND_DIR/.env"
cd "$BACKEND_DIR"
"$VENV/bin/python3.12" - <<'PY'
from app.config import settings
from redis import Redis
config = settings()
config.data_dir.mkdir(parents=True, exist_ok=True)
config.log_dir.mkdir(parents=True, exist_ok=True)
Redis.from_url(config.redis_url, socket_connect_timeout=5, socket_timeout=5).ping()
print("Configuration loaded; Redis reachable.")
PY
# Use SSH forwarding or an authenticated reverse proxy for access.
"$VENV/bin/python3.12" -m uvicorn app.main:app --host "${BIND_HOST:-127.0.0.1}" --port "${PORT:-8000}" --no-access-log &
api_pid=$!
"$VENV/bin/python3.12" -m app.worker &
worker_pid=$!
echo "API PID=$api_pid; worker PID=$worker_pid. Ctrl+C stops both."
# An unexpected exit of either process stops the other and fails the supervisor.
set +e
wait -n "$api_pid" "$worker_pid"
status=$?
set -e
[[ "$status" -ne 0 ]] || status=1
exit "$status"
