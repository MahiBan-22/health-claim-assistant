import json
from contextlib import contextmanager
from datetime import datetime, timezone
from uuid import uuid4
from sqlalchemy import create_engine, event, text
from .config import settings

SCHEMA = [
    "CREATE TABLE IF NOT EXISTS cases (id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, claim_reference TEXT NOT NULL, created_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), logical_id TEXT NOT NULL, version INTEGER NOT NULL, kind TEXT NOT NULL, filename TEXT NOT NULL, sha256 TEXT NOT NULL, path TEXT NOT NULL, pages TEXT NOT NULL, extraction_status TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(case_id, logical_id, version))",
    "CREATE TABLE IF NOT EXISTS analyses (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), owner TEXT NOT NULL, thread_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, input_ids TEXT NOT NULL, report_id TEXT, error TEXT, created_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES analyses(id), case_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES analyses(id), request_id TEXT NOT NULL, finding TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), reviewer TEXT NOT NULL, decision TEXT NOT NULL, rationale TEXT NOT NULL, created_at TEXT NOT NULL)"
]

def uid():
    return str(uuid4())

def now():
    return datetime.now(timezone.utc).isoformat()

_engine = None

def engine():
    global _engine
    if _engine is None:
        directory = settings().data_dir.resolve()
        directory.mkdir(parents=True, exist_ok=True)
        _engine = create_engine("sqlite:///" + str(directory / "app.sqlite"), connect_args={"timeout": 30})
        @event.listens_for(_engine, "connect")
        def configure(connection, _):
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA foreign_keys=ON")
        with _engine.begin() as connection:
            for statement in SCHEMA:
                connection.execute(text(statement))
    return _engine

@contextmanager
def transaction():
    with engine().begin() as connection:
        yield connection

def rows(query, **params):
    with engine().connect() as connection:
        return [dict(r) for r in connection.execute(text(query), params).mappings()]

def execute(connection, query, **params):
    return connection.execute(text(query), params)

def documents(case_id, ids=None):
    result = rows("SELECT * FROM documents WHERE case_id=:case_id ORDER BY created_at, version", case_id=case_id)
    for item in result:
        item["pages"] = json.loads(item["pages"])
    return [r for r in result if ids is None or r["id"] in ids]
