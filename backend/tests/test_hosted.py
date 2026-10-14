"""Hosted transport, bounded execution and PostgreSQL integration contracts."""
import json
import os
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
from uuid import uuid4
import httpx
import pytest
from fastapi.testclient import TestClient
from app import db, openai_model, workflow
from app.config import Settings
from app.errors import ModelPaused
from test_workflow import setup_run, ReplayModel

def test_openai_request_is_stateless_and_supports_images(monkeypatch):
    config = Settings(model_provider="openai", openai_api_key="synthetic-key")
    monkeypatch.setattr(openai_model, "settings", lambda: config)
    captured = []
    def post(client, url, **kwargs):
        captured.append((url, kwargs))
        return httpx.Response(200, json={"status": "completed", "output": [
            {"type": "message", "content": [{"type": "output_text", "text": "copied text"}]}],
            "usage": {"input_tokens": 12, "output_tokens": 4}})
    monkeypatch.setattr(httpx.Client, "post", post)
    output, usage = openai_model.answer("copy this", b"synthetic-image", ".png")
    assert output == "copied text" and usage["input_tokens"] == 12
    _, request = captured[0]
    assert request["json"]["store"] is False
    assert "tools" not in request["json"]
    assert request["json"]["input"][0]["content"][1]["image_url"].startswith("data:image/png;base64,")
    assert request["headers"]["Authorization"] == "Bearer synthetic-key"

@pytest.mark.parametrize("status,body", [
    (401, {"error": "SECRET"}), (429, {"error": "SECRET"}),
    (500, {"error": "SECRET"}), (200, {"status": "incomplete", "output": []}),
])
def test_openai_failure_does_not_expose_provider_payload(monkeypatch, status, body):
    monkeypatch.setattr(openai_model, "settings", lambda: Settings(openai_api_key="SECRET"))
    monkeypatch.setattr(httpx.Client, "post", lambda *args, **kwargs: httpx.Response(status, json=body))
    with pytest.raises(ModelPaused) as error:
        openai_model.answer("synthetic")
    assert "SECRET" not in str(error.value)

def test_hosted_run_advances_one_node_and_resumes_after_restart(setup_run, monkeypatch):
    config = db.settings().model_copy(update={"job_backend": "postgres"})
    for module in ("app.workflow", "app.db", "app.config", "app.trace_store", "app.notifications"):
        monkeypatch.setattr(module + ".settings", lambda: config)
    model = ReplayModel()
    model.check_available = lambda: None
    monkeypatch.setattr(workflow, "LunaModel", lambda: model)
    assert workflow.process_run(setup_run["id"]) is True
    assert db.rows("SELECT status FROM analyses")[0]["status"] == "queued"
    assert model.roles == ["request planner"]
    # Recreate workflow and checkpoint connections each invocation, as cold starts do.
    for _ in range(8):
        workflow.process_run(setup_run["id"])
        if db.rows("SELECT status FROM analyses")[0]["status"] == "completed":
            break
    assert db.rows("SELECT status FROM analyses")[0]["status"] == "completed"
    assert len(db.rows("SELECT * FROM reports")) == 1
    assert workflow.process_run(setup_run["id"]) is False

def test_package_replay_restores_completed_status(setup_run):
    worker = workflow.ClaimWorkflow(setup_run, ReplayModel())
    with db.transaction() as connection:
        db.execute(connection, "INSERT INTO reports VALUES ('report','run-1','case-1','{}',:time)", time=db.now())
        db.execute(connection, "UPDATE analyses SET status='running'")
    assert worker.package({}) == {"report_id": "report"}
    assert db.rows("SELECT status,report_id FROM analyses")[0] == {"status": "completed", "report_id": "report"}

@pytest.fixture
def postgres_config(monkeypatch, tmp_path):
    url = os.environ.get("TEST_POSTGRES_URL")
    if not url:
        pytest.skip("Set TEST_POSTGRES_URL to run real PostgreSQL integration checks")
    import psycopg
    from psycopg import sql
    schema = "test_claimwise_" + uuid4().hex
    with psycopg.connect(url, autocommit=True) as connection:
        connection.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
    parsed = urlsplit(url)
    params = dict(parse_qsl(parsed.query))
    params["options"] = "-csearch_path=" + schema
    isolated = urlunsplit(parsed._replace(query=urlencode(params)))
    config = Settings(database_url=isolated, checkpoint_database_url=isolated,
                      job_backend="postgres", data_dir=tmp_path, log_dir=tmp_path / "logs",
                      neatlogs_enabled=False, cron_secret="synthetic-secret")
    modules = ("db", "main", "config", "checkpoints", "workflow", "trace_store", "storage", "jobs", "notifications", "model")
    for module in modules:
        monkeypatch.setattr("app." + module + ".settings", lambda: config)
    monkeypatch.setattr(db, "_engine", None)
    from app.checkpoints import initialize
    try:
        initialize()
        yield config
    finally:
        if db._engine is not None:
            db._engine.dispose()
        with psycopg.connect(url, autocommit=True) as connection:
            connection.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))

def test_postgres_files_checkpoints_locks_and_cron(postgres_config, monkeypatch):
    from app.main import app
    model = ReplayModel()
    model.check_available = lambda: None
    monkeypatch.setattr(workflow, "LunaModel", lambda: model)
    with TestClient(app, base_url="http://127.0.0.1:8000") as client:
        case = client.post("/cases", json={"title": "Synthetic", "claim_reference": "C-1"}).json()["id"]
        text = b"Claim reference: C-1\nPROVISIONAL summary"
        for kind in ("clinical", "insurer_communication"):
            uploaded = client.post(f"/cases/{case}/documents", data={"kind": kind}, files={"file": ("test.txt", text)})
            assert uploaded.status_code == 201
        document = uploaded.json()["id"]
        # Dispose connection state to prove originals are shared, not instance-local files.
        db.engine().dispose()
        assert client.get(f"/cases/{case}/documents/{document}/original").content == text
        run = client.post(f"/cases/{case}/analyses").json()["id"]
        assert client.get("/internal/jobs").status_code == 401
        with db.analysis_lock(run) as acquired:
            assert acquired
            with db.analysis_lock(run) as competing:
                assert not competing
            assert client.get("/internal/jobs", headers={"Authorization": "Bearer synthetic-secret"}).json()["advanced"] is None
        for _ in range(8):
            result = client.get("/internal/jobs", headers={"Authorization": "Bearer synthetic-secret"})
            assert result.status_code == 200
            state = client.get(f"/analyses/{run}").json()
            if state["status"] == "completed":
                break
        assert state["status"] == "completed", state
        assert client.get(f"/analyses/{run}/workflow").status_code == 200
        assert client.get("/business/impact").status_code == 200
        assert client.get(f"/reports/{state['report_id']}/package").status_code == 200
        assert client.delete(f"/analyses/{run}").status_code == 200
        assert client.delete(f"/cases/{case}").status_code == 200
        assert db.rows("SELECT * FROM document_files") == []
