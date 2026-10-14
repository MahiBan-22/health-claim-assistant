import json
from contextlib import contextmanager
from datetime import datetime, timezone
from uuid import uuid4
from sqlalchemy import create_engine, event, text
from sqlalchemy.pool import NullPool
from .config import settings

SCHEMA = [
    "CREATE TABLE IF NOT EXISTS cases (id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, claim_reference TEXT NOT NULL, created_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), logical_id TEXT NOT NULL, version INTEGER NOT NULL, kind TEXT NOT NULL, filename TEXT NOT NULL, sha256 TEXT NOT NULL, path TEXT NOT NULL, pages TEXT NOT NULL, extraction_status TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(case_id, logical_id, version))",
    "CREATE TABLE IF NOT EXISTS analyses (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), owner TEXT NOT NULL, thread_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, input_ids TEXT NOT NULL, report_id TEXT, error TEXT, created_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES analyses(id), case_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES analyses(id), request_id TEXT NOT NULL, finding TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), reviewer TEXT NOT NULL, decision TEXT NOT NULL, rationale TEXT NOT NULL, created_at TEXT NOT NULL)",
    # Customer edits sit beside the immutable report: the edited draft and ticked next actions.
    "CREATE TABLE IF NOT EXISTS report_notes (report_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (report_id, key))",
    # One row per workflow step of an analysis (metadata only), for the workflow view and usage totals.
    "CREATE TABLE IF NOT EXISTS run_events (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL, kind TEXT NOT NULL, started_at REAL NOT NULL, duration_ms REAL, attributes TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS run_events_by_run ON run_events (run_id, started_at)",
    # Questions left through the landing page's contact form.
    "CREATE TABLE IF NOT EXISTS inquiries (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, created_at TEXT NOT NULL)"
]

RUN_CLEANUP = [
    "DELETE FROM reviews WHERE task_id IN (SELECT id FROM tasks WHERE run_id=:id)",
    "DELETE FROM tasks WHERE run_id=:id",
    "DELETE FROM report_notes WHERE report_id IN (SELECT id FROM reports WHERE run_id=:id)",
    "DELETE FROM reports WHERE run_id=:id",
    "DELETE FROM run_events WHERE run_id=:id",
    "DELETE FROM analyses WHERE id=:id",
]

def uid():
    return str(uuid4())

def now():
    return datetime.now(timezone.utc).isoformat()

_engine = None

def engine():
    global _engine
    if _engine is None:
        if settings().postgres:
            url = settings().database_url.get_secret_value()
            if url.startswith("postgres://"):
                url = "postgresql://" + url[len("postgres://"):]
            url = url.replace("postgresql://", "postgresql+psycopg://", 1)
            candidate = create_engine(url, poolclass=NullPool, hide_parameters=True,
                                     connect_args={"connect_timeout": 10, "prepare_threshold": None})
            with candidate.begin() as connection:
                connection.execute(text("SELECT pg_advisory_xact_lock(708124001)"))
                for statement in SCHEMA:
                    connection.execute(text(statement.replace("started_at REAL", "started_at DOUBLE PRECISION").replace("duration_ms REAL", "duration_ms DOUBLE PRECISION")))
                connection.execute(text("CREATE TABLE IF NOT EXISTS document_files (document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE, content BYTEA NOT NULL)"))
            _engine = candidate
            return _engine
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

def delete_run(connection, run_id):
    for statement in RUN_CLEANUP:
        execute(connection, statement, id=run_id)

def notes(report_id):
    return {r["key"]: json.loads(r["value"]) for r in rows("SELECT key, value FROM report_notes WHERE report_id=:id", id=report_id)}

def save_note(report_id, key, value):
    with transaction() as connection:
        execute(connection, "INSERT INTO report_notes VALUES (:report,:key,:value,:time) ON CONFLICT(report_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                report=report_id, key=key, value=json.dumps(value), time=now())

def latest_versions(items):
    latest = {}
    for document in items:
        if document["logical_id"] not in latest or latest[document["logical_id"]]["version"] < document["version"]:
            latest[document["logical_id"]] = document
    return list(latest.values())

def documents(case_id, ids=None):
    result = rows("SELECT * FROM documents WHERE case_id=:case_id ORDER BY created_at, version", case_id=case_id)
    for item in result:
        item["pages"] = json.loads(item["pages"])
    return [r for r in result if ids is None or r["id"] in ids]

@contextmanager
def analysis_lock(run_id):
    """Session locks require a direct/session-pooled PostgreSQL connection, never PgBouncer transaction pooling."""
    if not settings().postgres:
        from filelock import FileLock
        path = settings().data_dir / "runtime" / ("analysis-" + run_id + ".lock")
        path.parent.mkdir(parents=True, exist_ok=True)
        with FileLock(str(path), timeout=0):
            yield True
        return
    import hashlib
    import psycopg
    key = int.from_bytes(hashlib.sha256(run_id.encode()).digest()[:8], "big", signed=True)
    url = settings().checkpoint_database_url.get_secret_value() or settings().database_url.get_secret_value()
    url = url.replace("postgresql+psycopg://", "postgresql://", 1)
    with psycopg.connect(url, autocommit=True, prepare_threshold=None, connect_timeout=10) as connection:
        acquired = connection.execute("SELECT pg_try_advisory_lock(%s)", (key,)).fetchone()[0]
        try:
            yield acquired
        finally:
            if acquired:
                connection.execute("SELECT pg_advisory_unlock(%s)", (key,))
