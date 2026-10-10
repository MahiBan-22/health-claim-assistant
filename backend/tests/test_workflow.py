"""Offline model replay validates graph control, not live model quality."""
import json
import sqlite3
import pytest
from langgraph.checkpoint.sqlite import SqliteSaver
from app import db
from app.config import Settings
from app.schemas import Plan, Finding, Verification
from app.workflow import ClaimWorkflow
from test_contracts import finding

class ReplayModel:
    def __init__(self, correction=False):
        self.roles = []
        self.correction = correction
        self.verifications = 0

    def generate(self, role, instructions, payload, schema):
        self.roles.append(role)
        if schema is Plan:
            return Plan.model_validate({"requests": [{"request_id": "r1", "text": "Final signed summary", "required_evidence": ["summary"], "needs_policy": False}]})
        if schema is Finding:
            return finding()
        if schema is Verification:
            self.verifications += 1
            if self.correction:
                return Verification(decision="needs_targeted_action", reasons=["Read an alternate version"], targeted_query="final signed")
            return Verification(decision="supported", reasons=[], targeted_query=None)
        raise AssertionError("Unexpected schema")

@pytest.fixture
def setup_run(tmp_path, monkeypatch):
    configuration = Settings(data_dir=tmp_path)
    monkeypatch.setattr(db, "settings", lambda: configuration)
    monkeypatch.setattr("app.workflow.settings", lambda: configuration)
    monkeypatch.setattr(db, "_engine", None)
    doc = {"page": 1, "text": "Claim reference: C-1\nPROVISIONAL summary", "readable": True, "method": "native"}
    with db.transaction() as connection:
        db.execute(connection, "INSERT INTO cases VALUES ('case-1','local','Synthetic','C-1',:time)", time=db.now())
        for document_id, kind in [("doc-1", "clinical"), ("query-1", "insurer_communication")]:
            db.execute(connection, "INSERT INTO documents VALUES (:id,'case-1',:id,1,:kind,'test.txt','abc','unused',:pages,'extracted',:time)", id=document_id, kind=kind, pages=json.dumps([doc]), time=db.now())
        db.execute(connection, "INSERT INTO analyses VALUES ('run-1','case-1','local','thread-1','queued',:inputs,NULL,NULL,:time)", inputs=json.dumps(["doc-1", "query-1"]), time=db.now())
    yield db.rows("SELECT * FROM analyses")[0]
    db.engine().dispose()

@pytest.mark.parametrize("correction", [False, True])
def test_checkpoint_replay_and_bounded_correction(setup_run, correction):
    model = ReplayModel(correction)
    workflow = ClaimWorkflow(setup_run, model)
    with sqlite3.connect(":memory:", check_same_thread=False) as connection:
        graph = workflow.graph(SqliteSaver(connection))
        config = {"configurable": {"thread_id": "thread-1"}, "recursion_limit": 30}
        result = graph.invoke({"run_id": "run-1"}, config)
        assert len(result["findings"]) == 1
        assert result["findings"][0]["evidence_status"] == ("conflicting_evidence" if correction else "partially_satisfied")
        assert result["findings"][0]["submission_status"] == "not_established"
        assert result["findings"][0]["review_required"] is correction
        assert model.roles.count("Evidence Agent") == (2 if correction else 1)
        assert workflow.package(result)["report_id"] == result["report_id"]
        graph.invoke(None, config)
        assert len(db.rows("SELECT * FROM reports")) == 1
