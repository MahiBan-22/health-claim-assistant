"""Vercel FastAPI entry point; local commands continue to use app.main:app."""
import os
from pathlib import Path

if os.environ.get("VERCEL") == "1":
    os.environ.setdefault("DATA_DIR", "/tmp/claimwise-data")
    os.environ.setdefault("LOG_DIR", "/tmp/claimwise-logs")
    os.environ.setdefault("JOB_BACKEND", "postgres")
    os.environ.setdefault("MODEL_PROVIDER", "openai")
    os.environ.setdefault("MAX_UPLOAD_BYTES", "4000000")
    os.environ.setdefault("MODEL_TIMEOUT_SECONDS", "20")
    os.environ.setdefault("MAX_PAGES", "8")
    os.environ.setdefault("JOB_TIMEOUT_SECONDS", "240")
    os.environ.setdefault("NEATLOGS_ENABLED", "false")
    os.environ.setdefault("FIXTURES_DIR", str(Path(__file__).parent / "fixtures"))
    if not os.environ.get("DATABASE_URL"):
        raise RuntimeError("Set DATABASE_URL before deploying; local SQLite is not durable on Vercel.")
    if not os.environ.get("CRON_SECRET"):
        raise RuntimeError("Set CRON_SECRET to protect the hosted job endpoint.")
    if os.environ["JOB_BACKEND"] != "postgres" or os.environ["MODEL_PROVIDER"] != "openai":
        raise RuntimeError("Vercel deployments require JOB_BACKEND=postgres and MODEL_PROVIDER=openai.")

from app.main import app
