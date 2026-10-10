import io
import json
import zipfile
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from app import db
from app.config import Settings
from app.extraction import extract
from app.main import app

REVIEWER = {"X-Workspace-Role": "reviewer"}
UI = "http://127.0.0.1:5173"

@pytest.fixture
def client(tmp_path, monkeypatch):
    config = Settings(neatlogs_enabled=False, data_dir=tmp_path, log_dir=tmp_path / "logs")
    monkeypatch.setattr("app.main.settings", lambda: config)
    monkeypatch.setattr(db, "settings", lambda: config)
    monkeypatch.setattr("app.trace_store.settings", lambda: config)
    monkeypatch.setattr(db, "_engine", None)
    monkeypatch.setattr("app.main.enqueue", lambda run_id: None)
    monkeypatch.setattr("app.main.queue_status", lambda: {"redis": True, "workers": 1, "queued": 0})
    monkeypatch.setattr("app.notifications.notify_case", lambda case_id: None)
    with TestClient(app, base_url="http://127.0.0.1:8000") as client:
        yield client
    db.engine().dispose()

def create_case(client, reference="C-1"):
    response = client.post("/cases", json={"title": "Synthetic", "claim_reference": reference})
    assert response.status_code == 201
    return response.json()["id"]

def upload(client, case, content=b"Claim reference: C-1\nFinal signed summary", name="summary.txt", **data):
    return client.post(f"/cases/{case}/documents", data={"kind": "clinical", **data}, files={"file": (name, content, "text/plain")})

def test_workspace_opens_without_a_login(client):
    assert client.get("/cases").status_code == 200
    assert client.get("/health").json()["authentication"] == "local workspace"
    status = client.get("/system/status").json()
    assert status["database"] and status["workers"] == 1 and status["counts"]["cases"] == 0


def test_impact_empty_workspace(client):
    metrics = client.get("/business/impact").json()
    assert set(metrics) == {"customer", "samples"}
    assert metrics["customer"]["cases_analyzed"] == 0
    assert metrics["customer"]["report_seconds"] == []


def test_impact_latest_report_samples_verification_and_timings(client, monkeypatch):
    monkeypatch.setattr("app.main.sample_keys", lambda: {"SAMPLE": {}})
    case = create_case(client)
    sample = create_case(client, "SAMPLE")
    supported = {"evidence_status": "satisfied", "verification": {"decision": "supported"},
                 "evidence_refs": [{"page": 1}], "submission_status": "confirmed_by_receipt"}
    review = {**supported, "review_required": True}
    blocked = {**supported, "blocked": True}
    gap = {"evidence_status": "partially_satisfied", "policy_refs": [{"page": 1}]}
    def insert(run_id, case_id, findings, stamp, durations):
        with db.transaction() as connection:
            db.execute(connection, "INSERT INTO analyses VALUES (:run,:case,'local',:run,'completed','[]',:run,NULL,:stamp)", run=run_id, case=case_id, stamp=stamp)
            db.execute(connection, "INSERT INTO reports VALUES (:run,:run,:case,:body,:stamp)", run=run_id, case=case_id, stamp=stamp, body=json.dumps({"findings": findings}))
            for index, duration in enumerate(durations):
                db.execute(connection, "INSERT INTO run_events VALUES (:id,:run,NULL,'claim.analysis','WORKFLOW',1,:duration,'{}')", id=f"{run_id}-{index}", run=run_id, duration=duration)
    insert("old", case, [supported] * 12, "2026-10-01", [1000])
    insert("latest", case, [supported, review, blocked, gap], "2026-10-02", [60000, 30000])
    insert("sample", sample, [supported], "2026-10-02", [None, 20000])
    result = client.get("/business/impact").json()
    own = result["customer"]
    assert own["cases_analyzed"] == 1 and own["points_checked"] == 4
    assert own["supported_points"] == 1 and own["needs_review"] == 2
    assert own["evidence_gaps"] == 1 and own["cited_points"] == 3
    assert own["policy_points"] == 1
    assert own["report_seconds"] == [90] and own["analysis_seconds"] == 90
    assert result["samples"]["points_checked"] == 1
    assert result["samples"]["timed_reports"] == 0
    # Equal timestamps still choose the newly inserted report deterministically.
    insert("newest", case, [gap], "2026-10-02", [])
    newest = client.get("/business/impact").json()["customer"]
    assert newest["points_checked"] == 1 and newest["supported_points"] == 0
    assert newest["timed_reports"] == 0

def test_requests_from_other_sites_are_refused(client):
    case = create_case(client)
    assert client.get("/cases", headers={"Origin": "https://untrusted.example"}).status_code == 403
    assert client.post("/cases", headers={"Origin": "http://127.0.0.1:9999"}, json={"title": "x", "claim_reference": "y"}).status_code == 403
    assert client.delete(f"/cases/{case}", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert client.get("/cases", headers={"Origin": UI}).status_code == 200
    assert len(client.get("/cases").json()) == 1

def test_rebound_host_names_are_refused(client):
    assert client.get("/cases", headers={"Host": "attacker.example:8000"}).status_code == 400
    assert client.get("/cases", headers={"Host": "localhost:8000"}).status_code == 200

def test_versions_and_originals_are_preserved(client):
    case = create_case(client)
    first = upload(client, case)
    assert first.status_code == 201
    original = first.json()
    second = upload(client, case, b"Claim reference: C-1\nCorrected summary", logical_id=original["logical_id"])
    assert second.status_code == 201
    assert second.json()["version"] == 2
    assert second.json()["sha256"] != original["sha256"]
    page = client.get(f"/cases/{case}/documents/{original['id']}/pages/1").json()
    assert page["version"] == 1
    assert "Final signed summary" in page["text"]
    listed = client.get(f"/cases/{case}/documents").json()
    assert [(d["version"], d["is_latest"]) for d in listed] == [(1, False), (2, True)]
    assert "path" not in listed[0] and listed[0]["page_count"] == 1

def test_word_and_scanned_pdf_uploads_report_how_they_were_read(client, monkeypatch):
    from test_contracts import paragraph, pdf, picture, word
    monkeypatch.setattr("app.main.extract", lambda data, name: extract(data, name, reader=lambda: lambda image: "Invoice number: INV-1\nItemized charges\nTotal billed 13,000.00"))
    case = create_case(client)
    letter = client.post(f"/cases/{case}/documents", files={"file": ("Letter.DOCX", word(paragraph("Dear customer, please supply the final discharge summary.")), "application/octet-stream")})
    assert letter.status_code == 201 and letter.json()["kind"] == "insurer_communication"
    assert (letter.json()["ai_pages"], letter.json()["unread_images"]) == (0, 0)
    scan = client.post(f"/cases/{case}/documents", files={"file": ("scan.pdf", pdf(picture()), "application/pdf")}).json()
    assert scan["kind"] == "bill" and scan["extraction_status"] == "extracted" and scan["ai_pages"] == 1
    listed = {d["filename"]: d for d in client.get(f"/cases/{case}/documents").json()}
    assert listed["scan.pdf"]["ai_pages"] == 1 and listed["Letter.DOCX"]["ai_pages"] == 0
    assert client.get(f"/cases/{case}/documents/{scan['id']}/pages/1").json()["method"] == "luna"
    assert client.get(f"/cases/{case}/documents/{letter.json()['id']}/original").content[:2] == b"PK"
    refused = client.post(f"/cases/{case}/documents", files={"file": ("old.doc", b"x", "application/msword")})
    assert refused.status_code == 422 and ".docx" in refused.json()["detail"]

def test_inquiry_is_saved_and_validated(client):
    assert client.post("/inquiries", json={"name": " Asha Rao ", "email": "asha@example.com"}).status_code == 201
    for body in ({"name": "  ", "email": "asha@example.com"}, {"name": "Asha", "email": "not-an-email"}, {"name": "Asha"}):
        assert client.post("/inquiries", json=body).status_code == 422
    assert client.post("/inquiries", headers={"Origin": "https://untrusted.example"}, json={"name": "x", "email": "x@example.com"}).status_code == 403
    assert [(item["name"], item["email"]) for item in client.get("/inquiries").json()] == [("Asha Rao", "asha@example.com")]

def test_document_cannot_be_read_through_other_case(client):
    case, other = create_case(client), create_case(client)
    document = upload(client, case).json()["id"]
    assert client.get(f"/cases/{other}/documents/{document}/pages/1").status_code == 404
    assert client.get(f"/cases/{other}/documents/{document}/original").status_code == 404
    assert client.get(f"/cases/{other}/documents/{document}").status_code == 404

def test_category_is_suggested_and_can_be_corrected(client):
    case = create_case(client)
    letter = client.post(f"/cases/{case}/documents", files={"file": ("letter.txt", b"Communication date: 8 October 2026\nPlease supply the final discharge summary.", "text/plain")}).json()
    assert letter["kind"] == "insurer_communication"
    unknown = client.post(f"/cases/{case}/documents", files={"file": ("notes.txt", b"Some unrelated text", "text/plain")}).json()
    assert unknown["kind"] == "other"
    assert client.patch(f"/cases/{case}/documents/{unknown['id']}", data={"kind": "bill"}).status_code == 200
    assert {d["kind"] for d in client.get(f"/cases/{case}/documents").json()} == {"insurer_communication", "bill"}
    assert client.patch(f"/cases/{case}/documents/{unknown['id']}", data={"kind": "invented"}).status_code == 422

def test_claim_reference_in_documents_is_surfaced_and_case_can_be_corrected(client):
    case = create_case(client, "TYPO-1")
    document = upload(client, case, b"Claim reference: SYN-DEMO-001\nPROVISIONAL summary").json()
    assert document["claim_references"] == ["SYN-DEMO-001"]
    updated = client.patch(f"/cases/{case}", json={"claim_reference": "SYN-DEMO-001"}).json()
    assert updated["claim_reference"] == "SYN-DEMO-001" and updated["title"] == "Synthetic" and updated["document_count"] == 1

def test_unused_document_can_be_removed_but_analysed_one_cannot(client):
    case = create_case(client)
    query = upload(client, case, b"Please supply a final summary", kind="insurer_communication").json()
    assert client.post(f"/cases/{case}/analyses").status_code == 202
    extra = upload(client, case, b"Uploaded by mistake").json()
    assert client.delete(f"/cases/{case}/documents/{query['id']}").status_code == 409
    assert client.delete(f"/cases/{case}/documents/{extra['id']}").status_code == 200
    assert [d["id"] for d in client.get(f"/cases/{case}/documents").json()] == [query["id"]]

def test_timeline_reads_dates_from_latest_versions(client):
    case = create_case(client)
    first = upload(client, case, b"Admission date: 1 October 2026\nDischarge date: 2026-10-05").json()
    upload(client, case, b"Admission date: 2 October 2026", logical_id=first["logical_id"])
    upload(client, case, b"Received at: 06/10/2026, 10:00 IST", name="ack.txt", kind="receipt")
    events = client.get(f"/cases/{case}/timeline").json()
    assert [(e["date"], e["kind"]) for e in events] == [("2026-10-02", "clinical"), ("2026-10-06", "receipt")]

def test_analysis_freezes_latest_versions(client):
    case = create_case(client)
    assert client.post(f"/cases/{case}/analyses").status_code == 422
    first = upload(client, case, b"Please supply a summary", kind="insurer_communication").json()
    run = client.post(f"/cases/{case}/analyses")
    assert run.status_code == 202
    before = run.json()
    second = upload(client, case, b"Please supply a final summary", kind="insurer_communication", logical_id=first["logical_id"]).json()
    after = client.post(f"/cases/{case}/analyses").json()
    assert first["id"] in before["input_ids"]
    assert first["id"] not in after["input_ids"]
    assert second["id"] in after["input_ids"]

def test_review_needs_reviewer_mode(client):
    body = {"decision": "approved", "rationale": "I have reviewed the evidence"}
    assert client.post("/tasks/no-such-task/review", json=body).status_code == 403
    assert client.post("/tasks/no-such-task/review", headers=REVIEWER, json=body).status_code == 404
    assert client.get("/review-queue").status_code == 403

@pytest.mark.parametrize("origin", ["http://127.0.0.1:5173", "http://localhost:5173"])
def test_local_ui_preflight(client, origin):
    response = client.options("/cases", headers={
        "Origin": origin, "Access-Control-Request-Method": "PATCH",
        "Access-Control-Request-Headers": "content-type,x-workspace-role",
    })
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin

@pytest.mark.parametrize("origin", ["https://untrusted.example", "http://localhost:5174"])
def test_unconfigured_origin_rejected(client, origin):
    response = client.options("/cases", headers={"Origin": origin, "Access-Control-Request-Method": "GET"})
    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers

def test_custom_ui_port_alias():
    config = Settings(app_origin="http://localhost:6000")
    assert set(config.cors_origins) == {"http://localhost:6000", "http://127.0.0.1:6000"}

def test_remote_origin_is_not_expanded():
    config = Settings(app_origin="https://claims.example")
    assert config.cors_origins == ["https://claims.example"]


def new_run(client):
    case = create_case(client)
    upload(client, case, b"Please supply a final summary", kind="insurer_communication")
    return case, client.post(f"/cases/{case}/analyses").json()

def completed_report(case, run, review_required=True):
    finding = {"request_id": "r1", "evidence_status": "partially_satisfied", "submission_status": "not_established", "explanation": "Only a provisional summary is available.",
               "response_text": "The final summary is being obtained.", "evidence_refs": [], "policy_refs": [], "receipt_refs": [], "unresolved_questions": ["Is a final version available?"],
               "next_action": "Obtain the final summary", "review_required": review_required, "withheld_explanation": "unverified wording"}
    document = db.documents(case)[0]
    body = {"id": "report", "run_id": run["id"], "case_id": case, "version": 1, "claim_reference": "C-1", "requests": [{"request_id": "r1", "text": "Final summary"}],
            "findings": [finding], "response_draft": "Dear Claims Team", "review_required": review_required,
            "attachment_manifest": [{"document_id": document["id"], "version": 1, "filename": document["filename"], "sha256": document["sha256"]}]}
    with db.transaction() as connection:
        db.execute(connection, "UPDATE analyses SET status='completed',report_id='report' WHERE id=:id", id=run["id"])
        db.execute(connection, "INSERT INTO reports VALUES ('report',:run,:case,:body,:time)", run=run["id"], case=case, body=json.dumps(body), time=db.now())
        db.execute(connection, "INSERT INTO tasks VALUES (:id,:run,'r1',:finding)", id=run["id"] + ":r1", run=run["id"], finding=json.dumps(finding))
    return run["id"] + ":r1"


def test_analysis_history_and_active_delete_protection(client):
    case, run = new_run(client)
    history = client.get(f"/cases/{case}/analyses").json()
    assert [item["id"] for item in history] == [run["id"]]
    assert client.delete(f"/analyses/{run['id']}").status_code == 409
    assert client.delete(f"/cases/{case}").status_code == 409
    with db.transaction() as connection:
        db.execute(connection, "UPDATE analyses SET status='running' WHERE id=:id", id=run["id"])
    assert client.delete(f"/analyses/{run['id']}").status_code == 409


def test_delete_analysis_removes_report_reviews_and_checkpoint_keeps_uploads(client):
    import sqlite3
    from contextlib import closing
    from langgraph.checkpoint.sqlite import SqliteSaver
    case, run = new_run(client)
    checkpoint = db.settings().data_dir / "checkpoints.sqlite"
    with closing(sqlite3.connect(checkpoint)) as connection:
        saver = SqliteSaver(connection)
        saver.setup()
        connection.execute("INSERT INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, type, checkpoint) VALUES (?, '', 'checkpoint', 'json', '{}')", (run["thread_id"],))
        connection.commit()
    task = completed_report(case, run)
    assert client.post(f"/tasks/{task}/review", headers=REVIEWER, json={"decision": "approved", "rationale": "Reviewed the cited pages"}).status_code == 201
    client.put("/reports/report/draft", json={"text": "My edited letter"})
    assert client.get('/reports/report').status_code == 200
    assert client.delete(f"/analyses/{run['id']}").status_code == 200
    assert client.get(f"/cases/{case}/analyses").json() == []
    assert client.get(f"/analyses/{run['id']}").status_code == 404
    assert client.get('/reports/report').status_code == 404
    assert db.rows("SELECT * FROM reviews") == [] and db.rows("SELECT * FROM tasks") == [] and db.rows("SELECT * FROM report_notes") == []
    documents = db.documents(case)
    assert len(documents) == 1 and Path(documents[0]["path"]).exists()
    with closing(sqlite3.connect(checkpoint)) as connection:
        assert connection.execute("SELECT COUNT(*) FROM checkpoints").fetchone()[0] == 0


def test_delete_case_removes_everything_it_owns(client):
    case, run = new_run(client)
    other = create_case(client)
    completed_report(case, run)
    folder = Path(db.documents(case)[0]["path"]).parent
    assert client.delete(f"/cases/{case}").status_code == 200
    assert [c["id"] for c in client.get("/cases").json()] == [other]
    assert not folder.exists()
    for table in ("documents", "analyses", "reports", "tasks"):
        assert db.rows("SELECT * FROM " + table) == []


def test_report_keeps_customer_edits_beside_the_immutable_package(client):
    case, run = new_run(client)
    completed_report(case, run)
    report = client.get("/reports/report").json()
    assert report["customer_draft"] is None and report["completed_actions"] == []
    assert "withheld_explanation" not in report["findings"][0]
    assert client.get("/reports/report", headers=REVIEWER).json()["findings"][0]["withheld_explanation"] == "unverified wording"
    assert client.put("/reports/report/draft", json={"text": "My edited letter"}).status_code == 200
    assert client.put("/reports/report/checklist", json={"completed": ["r1", "r1"]}).status_code == 200
    report = client.get("/reports/report").json()
    assert report["customer_draft"] == "My edited letter" and report["completed_actions"] == ["r1"]
    assert report["response_draft"] == "Dear Claims Team"
    with zipfile.ZipFile(io.BytesIO(client.get("/reports/report/package").content)) as archive:
        names = archive.namelist()
        assert archive.read("response-letter.txt") == b"My edited letter"
        assert "evidence-summary.txt" in names and "report.json" in names
        assert any(name.startswith("attachments/01-v1-") for name in names)
        assert "unverified wording" not in archive.read("report.json").decode()
    client.put("/reports/report/draft", json={"text": "  "})
    assert client.get("/reports/report").json()["customer_draft"] is None


def test_review_queue_and_decision_history(client):
    case, run = new_run(client)
    task = completed_report(case, run)
    queue = client.get("/review-queue", headers=REVIEWER).json()
    assert [(item["task_id"], item["current"], item["decisions"]) for item in queue] == [(task, True, [])]
    saved = client.post(f"/tasks/{task}/review", headers=REVIEWER, json={"decision": "request_evidence", "rationale": "The final summary is still missing", "reviewer_name": "Asha"})
    assert saved.status_code == 201 and saved.json()["reviewer"] == "Asha"
    assert client.get("/review-queue", headers=REVIEWER).json()[0]["decisions"][0]["decision"] == "request_evidence"
    assert [r["request_id"] for r in client.get("/reports/report/reviews").json()] == ["r1"]
    assert len(client.get(f"/tasks/{task}/reviews").json()) == 1


def test_sample_scenarios_create_ready_cases(client):
    samples = client.get("/samples").json()
    assert len(samples) == 5 and all("expected" not in s for s in samples)
    created = client.post("/samples/" + samples[0]["key"]).json()
    assert created["sample_key"] == samples[0]["key"] and created["document_count"] == samples[0]["document_count"]
    assert client.post(f"/cases/{created['id']}/sample-follow-up").json() == {"added": 2}
    assert client.post(f"/cases/{created['id']}/sample-follow-up").json() == {"added": 0}
    documents = client.get(f"/cases/{created['id']}/documents").json()
    assert sorted((d["filename"], d["version"]) for d in documents if d["kind"] == "clinical") == [
        ("02-discharge-summary.txt", 1), ("03-final-discharge-summary.txt", 2), ("04-laboratory-report.txt", 1)]
    assert client.post("/samples/unknown").status_code == 404
    assert client.post(f"/cases/{create_case(client)}/sample-follow-up").status_code == 404


def test_sample_receipt_hash_matches_the_bill_it_acknowledges(client):
    created = client.post("/samples/02-repeated-request").json()
    documents = {d["kind"]: d for d in client.get(f"/cases/{created['id']}/documents").json()}
    receipt = client.get(f"/cases/{created['id']}/documents/{documents['receipt']['id']}").json()
    assert documents["bill"]["sha256"] in receipt["pages"][0]["text"]


def test_history_is_owner_scoped(client):
    case, run = new_run(client)
    with db.transaction() as connection:
        db.execute(connection, "UPDATE cases SET owner='other' WHERE id=:id", id=case)
        db.execute(connection, "UPDATE analyses SET owner='other' WHERE id=:id", id=run["id"])
    assert client.get(f"/cases/{case}/analyses").status_code == 404
    assert client.delete(f"/analyses/{run['id']}").status_code == 404
    assert client.get("/cases").json() == []


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
        'Access-Control-Request-Headers': 'content-type',
    })
    assert response.status_code == 200


def test_workflow_integrations_and_business_metrics(client):
    case, run = new_run(client)
    empty = client.get(f"/analyses/{run['id']}/workflow").json()
    assert empty["recorded"] is False and empty["attempts"] == [] and empty["run"]["status"] == "queued" and empty["totals"]["documents"] == 1
    with db.transaction() as connection:
        db.execute(connection, "INSERT INTO run_events VALUES ('root',:run,NULL,'claim.analysis','WORKFLOW',1000.0,500.0,'{}')", run=run["id"])
        db.execute(connection, "INSERT INTO run_events VALUES ('plan',:run,'root','plan','AGENT',1000.1,200.0,:attributes)", run=run["id"], attributes=json.dumps({"claim.result_count": 2}))
    view = client.get(f"/analyses/{run['id']}/workflow").json()
    assert view["recorded"] and view["attempts"][0]["plan"]["facts"] == {"results": 2}
    assert client.get("/analyses/unknown/workflow").status_code == 404

    tools = client.get("/system/integrations").json()
    assert set(tools) == {"neatlogs", "entire", "cfo_ai", "stack", "model"}
    assert tools["neatlogs"]["analyses_traced"] == 1 and tools["neatlogs"]["exporting"] is False and tools["stack"]["langgraph"]
    assert "api_key" not in json.dumps(tools).lower()

    metrics = client.get("/business/metrics.csv")
    assert metrics.headers["content-type"].startswith("text/csv")
    header, *_, row = metrics.text.strip().splitlines()  # the newest month is last
    assert header.startswith("month,claims_created,documents_uploaded,analyses_started") and row.split(",")[1:4] == ["1", "1", "1"]

    completed_report(case, run)
    assert client.delete(f"/analyses/{run['id']}").status_code == 200
    assert db.rows("SELECT * FROM run_events") == []
