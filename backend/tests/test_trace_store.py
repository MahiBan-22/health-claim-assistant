"""The workflow view is built from recorded steps, not from the report."""
import json
import sqlite3
import pytest
from langgraph.checkpoint.sqlite import SqliteSaver
from app import db, observability, trace_store
from app.config import Settings
from app.schemas import Verification
from app.workflow import ClaimWorkflow
from test_contracts import finding
from test_workflow import SUPPORTED, ScriptedModel, setup_run  # noqa: F401  (setup_run is a fixture)

RUN = "11111111-2222-3333-4444-555555555555"

@pytest.fixture
def recorded_run(setup_run, tmp_path, monkeypatch):
    configuration = Settings(data_dir=tmp_path, log_dir=tmp_path / "logs")
    monkeypatch.setattr(trace_store, "settings", lambda: configuration)
    with db.transaction() as connection:
        db.execute(connection, "UPDATE analyses SET id=:id", id=RUN)
    trace_store.install()
    yield db.rows("SELECT * FROM analyses")[0]
    observability.set_recorder(None)

def analyse(run, model):
    workflow = ClaimWorkflow(run, model)
    with sqlite3.connect(":memory:", check_same_thread=False) as connection:
        with observability.span("claim.analysis", "WORKFLOW", **{"claim.run_id": run["id"]}):
            workflow.graph(SqliteSaver(connection)).invoke({"run_id": run["id"]}, {"configurable": {"thread_id": "thread-1"}, "recursion_limit": 30})
    return json.loads(db.rows("SELECT body FROM reports")[0]["body"])

def test_each_step_is_recorded_and_grouped_by_request_and_pass(recorded_run):
    again = Verification(decision="needs_targeted_action", reasons=["Look again"], targeted_query="final", unsupported_explanation=[], unsupported_response=[])
    report = analyse(recorded_run, ScriptedModel([finding(), finding()], [again, SUPPORTED]))
    run = {**recorded_run, "status": "completed"}
    view = trace_store.view(run, report)
    assert view["recorded"] and len(view["attempts"]) == 1
    attempt = view["attempts"][0]
    assert attempt["plan"]["facts"]["results"] == 1 and attempt["package"]["name"] == "claim.package"
    assert [(p["request_index"], p["number"], [s["name"] for s in p["steps"]]) for p in attempt["passes"]] == [
        (0, 0, ["policy", "evidence", "verify"]), (0, 1, ["policy", "evidence", "verify"])]
    assert attempt["passes"][0]["steps"][-1]["facts"]["correction_reason"] == "targeted_search"
    evidence = attempt["passes"][0]["steps"][1]
    assert {tool["name"] for tool in evidence["tools"]} == {"list_documents", "search", "find_receipts"} and not evidence["running"]
    checks = {tool["name"]: tool["passed"] for tool in attempt["passes"][1]["steps"][-1]["tools"]}
    assert checks["validate_source_refs"] is True and checks["check_identifiers"] is True
    assert view["requests"] == [{"index": 0, "text": "Final signed summary", "category": "document_request", "needs_policy": False,
                                 "result": {"evidence_status": "partially_satisfied", "submission_status": "not_established", "review_required": False, "blocked": False, "policy_position": None}}]
    assert view["totals"]["corrections"] == 1 and view["totals"]["attempts"] == 1 and view["totals"]["tool_calls"] >= 8

def test_an_unfinished_step_is_running_only_while_the_analysis_is(recorded_run):
    observability.set_recorder(None)
    with db.transaction() as connection:
        for identifier, parent, name, kind in [("root", None, "claim.analysis", "WORKFLOW"), ("plan", "root", "plan", "AGENT"), ("evidence", "root", "evidence", "AGENT")]:
            db.execute(connection, "INSERT INTO run_events VALUES (:id,:run,:parent,:name,:kind,:started,:duration,'{}')", id=identifier, run=RUN, parent=parent,
                       name=name, kind=kind, started=1000.0 + len(identifier), duration=50.0 if name == "plan" else None)
    live = trace_store.view({**recorded_run, "status": "running"})["attempts"][0]
    assert live["running"] and live["passes"][0]["steps"][0]["running"] and live["passes"][0]["request_index"] == 0
    stopped = trace_store.view({**recorded_run, "status": "paused"})["attempts"][0]
    assert stopped["interrupted"] and stopped["passes"][0]["steps"][0]["interrupted"] and not stopped["passes"][0]["steps"][0]["running"]

def test_earlier_analyses_are_filled_in_from_the_local_telemetry_log(recorded_run, tmp_path):
    observability.set_recorder(None)
    log = tmp_path / "logs"
    log.mkdir()
    spans = [("root", None, "claim.analysis", "WORKFLOW", 9000, {"claim.document_count": 2}), ("plan", "root", "plan", "AGENT", 1000, {"claim.result_count": 1}),
             ("verify", "root", "verify", "AGENT", 2000, {"claim.request_index": 0, "claim.correction_count": 0}),
             ("llm", "verify", "claim.model", "LLM", 1500, {"neatlogs.llm.token_count.total": 321})]
    lines = [json.dumps({"event": "span", "time": 2000.0 + i, "name": name, "kind": kind, "span_id": identifier, "parent_span_id": parent,
                         "attributes": {"claim.run_id": RUN, "claim.duration_ms": duration, **extra}}) for i, (identifier, parent, name, kind, duration, extra) in enumerate(spans)]
    lines += [json.dumps({"event": "telemetry_degraded"}), "not json", json.dumps({"event": "span", "time": 1.0, "name": "plan", "kind": "AGENT", "span_id": "other",
                                                                                 "parent_span_id": None, "attributes": {"claim.run_id": "another-run", "claim.duration_ms": 1}})]
    (log / "telemetry-worker.jsonl").write_text("\n".join(lines), encoding="utf-8")
    view = trace_store.view({**recorded_run, "status": "completed"})
    assert view["recorded"] and view["totals"] == {"duration_ms": 9000.0, "attempts": 1, "model_calls": 1, "tokens": 321, "tool_calls": 0, "corrections": 0, "documents": 2}
    assert view["attempts"][0]["passes"][0]["steps"][0]["model"] == {"calls": 1, "duration_ms": 1500.0, "tokens": 321, "running": False}
    assert trace_store.import_local_telemetry(RUN) == 0 and len(db.rows("SELECT * FROM run_events")) == 4

def test_monthly_totals_hold_counts_only(recorded_run):
    report = analyse(recorded_run, ScriptedModel([finding(review_required=True)], [SUPPORTED]))
    assert report["findings"][0]["review_required"]
    month = trace_store.monthly_metrics()
    assert len(month) == 1 and month[0]["analyses_started"] == 1 and month[0]["findings"] == 1 and month[0]["findings_needing_review"] == 1
    assert month[0]["claims_created"] == 1 and month[0]["documents_uploaded"] == 2
    assert all(isinstance(value, (int, float)) for key, value in month[0].items() if key != "month")


def test_an_attempt_cut_short_and_its_resume_are_both_shown(recorded_run):
    observability.set_recorder(None)
    rows = [("plan-1", "lost-root", "plan", "AGENT", 1001.0, 500.0, {"claim.result_count": 1}),   # first attempt: its root never finished
            ("search-1", "lost-agent", "search", "RETRIEVER", 1002.0, 1.0, {}),                    # a tool whose agent never finished
            ("root-2", None, "claim.analysis", "WORKFLOW", 2000.0, 900.0, {"claim.outcome": "completed"}),
            ("verify-2", "root-2", "verify", "AGENT", 2001.0, 300.0, {"claim.request_index": 0, "claim.correction_count": 0})]
    with db.transaction() as connection:
        for identifier, parent, name, kind, started, duration, attributes in rows:
            db.execute(connection, "INSERT INTO run_events VALUES (:id,:run,:parent,:name,:kind,:started,:duration,:attributes)", id=identifier, run=RUN,
                       parent=parent, name=name, kind=kind, started=started, duration=duration, attributes=json.dumps(attributes))
    attempts = trace_store.view({**recorded_run, "status": "completed"})["attempts"]
    assert [(a["interrupted"], a["running"], bool(a["plan"]), len(a["passes"])) for a in attempts] == [(True, False, True, 0), (False, False, False, 1)]
