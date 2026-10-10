import pytest
from fastapi.testclient import TestClient
from app import db
from app.config import Settings
from app.main import app

@pytest.fixture
def client(tmp_path, monkeypatch):
    config = Settings(data_dir=tmp_path, log_dir=tmp_path / "logs", local_access_token="customer-secret", reviewer_access_token="reviewer-secret")
    monkeypatch.setattr("app.main.settings", lambda: config)
    monkeypatch.setattr(db, "settings", lambda: config)
    monkeypatch.setattr(db, "_engine", None)
    monkeypatch.setattr("app.main.enqueue", lambda run_id: None)
    monkeypatch.setattr("app.notifications.notify_case", lambda case_id: None)
    with TestClient(app) as client:
        yield client
    db.engine().dispose()

AUTH = {"Authorization": "Bearer customer-secret"}

def create_case(client):
    response = client.post("/cases", headers=AUTH, json={"title": "Synthetic", "claim_reference": "C-1"})
    assert response.status_code == 201
    return response.json()["id"]

def upload(client, case, content=b"Claim reference: C-1\nFinal signed summary", **data):
    return client.post(f"/cases/{case}/documents", headers=AUTH, data={"kind": "clinical", **data}, files={"file": ("summary.txt", content, "text/plain")})

def test_authentication_required(client):
    assert client.get("/cases").status_code == 401
    assert client.get("/cases", headers={"Authorization": "Bearer wrong"}).status_code == 401

def test_versions_and_originals_are_preserved(client):
    case = create_case(client)
    first = upload(client, case)
    assert first.status_code == 201
    original = first.json()
    second = upload(client, case, b"Claim reference: C-1\nCorrected summary", logical_id=original["logical_id"])
    assert second.status_code == 201
    assert second.json()["version"] == 2
    assert second.json()["sha256"] != original["sha256"]
    page = client.get(f"/cases/{case}/documents/{original['id']}/pages/1", headers=AUTH).json()
    assert page["version"] == 1
    assert "Final signed summary" in page["text"]
    assert len(client.get(f"/cases/{case}/documents", headers=AUTH).json()) == 2

def test_document_cannot_be_read_through_other_case(client):
    case, other = create_case(client), create_case(client)
    document = upload(client, case).json()["id"]
    assert client.get(f"/cases/{other}/documents/{document}/pages/1", headers=AUTH).status_code == 404
    assert client.get(f"/cases/{other}/documents/{document}/original", headers=AUTH).status_code == 404

def test_analysis_freezes_latest_versions(client):
    case = create_case(client)
    first = upload(client, case, b"Please supply a summary", kind="insurer_communication").json()
    run = client.post(f"/cases/{case}/analyses", headers=AUTH)
    assert run.status_code == 202
    before = run.json()
    second = upload(client, case, b"Please supply a final summary", kind="insurer_communication", logical_id=first["logical_id"]).json()
    after = client.post(f"/cases/{case}/analyses", headers=AUTH).json()
    assert first["id"] in before["input_ids"]
    assert first["id"] not in after["input_ids"]
    assert second["id"] in after["input_ids"]

def test_customer_cannot_record_review(client):
    assert client.post("/tasks/no-such-task/review", headers=AUTH, json={"decision": "approved", "rationale": "I have reviewed the evidence"}).status_code == 403

@pytest.mark.parametrize("origin", ["http://127.0.0.1:5173", "http://localhost:5173"])
def test_local_ui_preflight(client, origin):
    response = client.options("/cases", headers={
        "Origin": origin, "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization,content-type",
    })
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin

@pytest.mark.parametrize("origin", ["https://untrusted.example", "http://localhost:5174"])
def test_unconfigured_origin_rejected(client, origin):
    response = client.options("/cases", headers={"Origin": origin, "Access-Control-Request-Method": "GET"})
    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers

def test_auth_error_still_has_cors_headers(client):
    response = client.get("/cases", headers={"Origin": "http://localhost:5173"})
    assert response.status_code == 401
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"

def test_custom_ui_port_alias():
    config = Settings(app_origin="http://localhost:6000")
    assert set(config.cors_origins) == {"http://localhost:6000", "http://127.0.0.1:6000"}

def test_remote_origin_is_not_expanded():
    config = Settings(app_origin="https://claims.example")
    assert config.cors_origins == ["https://claims.example"]

def test_chatgpt_control_requires_local_auth(client):
    assert client.post("/auth/chatgpt/start").status_code == 401
    assert client.get("/auth/chatgpt/status").status_code == 401
    assert client.post("/auth/chatgpt/disconnect").status_code == 401


def new_run(client):
    case = create_case(client)
    upload(client, case, b"Please supply a final summary", kind="insurer_communication")
    return case, client.post(f"/cases/{case}/analyses", headers=AUTH).json()


def test_analysis_history_and_active_delete_protection(client):
    case, run = new_run(client)
    assert client.get(f"/cases/{case}/analyses").status_code == 401
    assert client.get(f"/cases/{case}/analysis-events").status_code == 401
    history = client.get(f"/cases/{case}/analyses", headers=AUTH).json()
    assert [item["id"] for item in history] == [run["id"]]
    assert client.delete(f"/analyses/{run['id']}", headers=AUTH).status_code == 409
    with db.transaction() as connection:
        db.execute(connection, "UPDATE analyses SET status='running' WHERE id=:id", id=run["id"])
    assert client.delete(f"/analyses/{run['id']}", headers=AUTH).status_code == 409


def test_delete_analysis_removes_report_reviews_and_checkpoint_keeps_uploads(client):
    import json
    import sqlite3
    from langgraph.checkpoint.sqlite import SqliteSaver
    case, run = new_run(client)
    checkpoint = db.settings().data_dir / "checkpoints.sqlite"
    with sqlite3.connect(checkpoint) as connection:
        saver = SqliteSaver(connection)
        saver.setup()
        connection.execute("INSERT INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, type, checkpoint) VALUES (?, '', 'checkpoint', 'json', '{}')", (run["thread_id"],))
    with db.transaction() as connection:
        db.execute(connection, "UPDATE analyses SET status='completed',report_id='report' WHERE id=:id", id=run["id"])
        db.execute(connection, "INSERT INTO reports VALUES ('report',:run,:case,:body,:time)", run=run["id"], case=case, body=json.dumps({"id":"report"}), time=db.now())
        db.execute(connection, "INSERT INTO tasks VALUES ('task',:run,'request','{}')", run=run["id"])
        db.execute(connection, "INSERT INTO reviews VALUES ('review','task','reviewer','approved','Reviewed',:time)", time=db.now())
    assert client.get('/reports/report', headers=AUTH).status_code == 200
    assert client.delete(f"/analyses/{run['id']}").status_code == 401
    assert client.delete(f"/analyses/{run['id']}", headers=AUTH).status_code == 200
    assert client.get(f"/cases/{case}/analyses", headers=AUTH).json() == []
    assert client.get(f"/analyses/{run['id']}", headers=AUTH).status_code == 404
    assert client.get('/reports/report', headers=AUTH).status_code == 404
    assert db.rows("SELECT * FROM reviews") == []
    assert db.rows("SELECT * FROM tasks") == []
    documents = db.documents(case)
    from pathlib import Path
    assert len(documents) == 1 and Path(documents[0]["path"]).exists()
    with sqlite3.connect(checkpoint) as connection:
        assert connection.execute("SELECT COUNT(*) FROM checkpoints").fetchone()[0] == 0


def test_history_is_owner_scoped(client):
    case, run = new_run(client)
    with db.transaction() as connection:
        db.execute(connection, "UPDATE cases SET owner='other' WHERE id=:id", id=case)
        db.execute(connection, "UPDATE analyses SET owner='other' WHERE id=:id", id=run["id"])
    assert client.get(f"/cases/{case}/analyses", headers=AUTH).status_code == 404
    assert client.delete(f"/analyses/{run['id']}", headers=AUTH).status_code == 404


def test_event_stream_subscribes_before_snapshot_and_closes(client, monkeypatch):
    import asyncio
    from app.main import analysis_events
    case, run = new_run(client)
    actions = []
    class Pubsub:
        async def subscribe(self, channel): actions.append('subscribed')
        async def get_message(self, **kwargs): return {"data": "changed"}
        async def aclose(self): actions.append('pubsub closed')
    class Redis:
        def pubsub(self): return Pubsub()
        async def aclose(self): actions.append('redis closed')
    monkeypatch.setattr('redis.asyncio.Redis.from_url', lambda *args, **kwargs: Redis())
    async def check():
        response = await analysis_events(case, {"owner":"local"})
        assert actions == ['subscribed']
        first = await anext(response.body_iterator)
        assert run['id'] in first and first.startswith('data: ')
        with db.transaction() as connection:
            db.execute(connection, "UPDATE analyses SET status='completed' WHERE id=:id", id=run['id'])
        second = await anext(response.body_iterator)
        assert 'completed' in second
        await response.body_iterator.aclose()
        assert actions[-2:] == ['pubsub closed', 'redis closed']
    asyncio.run(check())


def test_delete_cors_preflight(client):
    response = client.options('/analyses/example', headers={
        'Origin': 'http://localhost:5173', 'Access-Control-Request-Method': 'DELETE',
        'Access-Control-Request-Headers': 'authorization',
    })
    assert response.status_code == 200
