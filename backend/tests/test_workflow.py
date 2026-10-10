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
                return Verification(decision="needs_targeted_action", reasons=["Read an alternate version"], targeted_query="final signed", unsupported_explanation=["The statement is not on the page"], unsupported_response=[])
            return Verification(decision="supported", reasons=[], targeted_query=None, unsupported_explanation=[], unsupported_response=[])
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


class ScriptedModel:
    """Returns queued findings and verdicts so each verification branch can be exercised."""
    def __init__(self, findings, verdicts):
        self.findings, self.verdicts, self.roles, self.corrections = list(findings), list(verdicts), [], []

    def generate(self, role, instructions, payload, schema):
        self.roles.append(role)
        if schema is Plan:
            return Plan.model_validate({"requests": [{"request_id": "r1", "text": "Final signed summary", "required_evidence": ["summary"], "needs_policy": False}]})
        if schema is Finding:
            self.corrections.append(payload["correction"])
            return self.findings.pop(0)
        return self.verdicts.pop(0)

def run_graph(run, model):
    workflow = ClaimWorkflow(run, model)
    with sqlite3.connect(":memory:", check_same_thread=False) as connection:
        result = workflow.graph(SqliteSaver(connection)).invoke({"run_id": "run-1"}, {"configurable": {"thread_id": "thread-1"}, "recursion_limit": 30})
    return result["findings"][0], json.loads(db.rows("SELECT body FROM reports")[0]["body"])

SUPPORTED = Verification(decision="supported", reasons=[], targeted_query=None, unsupported_explanation=[], unsupported_response=[])

def test_reference_mismatch_is_flagged_without_discarding_the_finding(setup_run):
    with db.transaction() as connection:
        db.execute(connection, "UPDATE cases SET claim_reference='TYPO-9' WHERE id='case-1'")
    result, report = run_graph(setup_run, ScriptedModel([finding()], [SUPPORTED]))
    assert result["evidence_status"] == "partially_satisfied" and result["explanation"] == "Only provisional records are available"
    assert result["review_required"] and not result["blocked"]
    assert any("C-1" in note and "TYPO-9" in note for note in result["review_reasons"]) and result["unresolved_questions"] == []
    assert report["warnings"] and "TYPO-9" in report["warnings"][0]

def test_bad_citation_gets_one_correction_then_blocks_the_conclusion(setup_run):
    invented = finding(evidence_status="satisfied", evidence_refs=[{"document_id": "doc-1", "version": 1, "page": 1, "quote": "Final signed summary enclosed"}])
    model = ScriptedModel([invented, invented], [SUPPORTED])
    result, report = run_graph(setup_run, model)
    assert model.roles.count("Evidence Agent") == 2 and model.roles.count("Verifier Agent") == 1
    assert "word for word" in model.corrections[1]
    assert result["blocked"] and result["evidence_status"] == "conflicting_evidence" and result["review_required"]
    assert result["withheld_explanation"] == "Only provisional records are available"
    assert "Only provisional records" not in report["response_draft"]

def test_corrected_citation_is_accepted(setup_run):
    invented = finding(evidence_refs=[{"document_id": "doc-1", "version": 1, "page": 1, "quote": "not on the page"}])
    result, _ = run_graph(setup_run, ScriptedModel([invented, finding()], [SUPPORTED]))
    assert not result["blocked"] and not result["review_required"] and result["evidence_status"] == "partially_satisfied"

def test_quote_check_ignores_layout_but_not_wording(setup_run):
    rewrapped = finding(evidence_refs=[{"document_id": "doc-1", "version": 1, "page": 1, "quote": "claim reference:  C-1 provisional  summary"}])
    result, _ = run_graph(setup_run, ScriptedModel([rewrapped], [SUPPORTED]))
    assert not result["blocked"] and result["source_checks"] == []

def test_supported_explanation_survives_a_review_decision(setup_run):
    verdict = Verification(decision="requires_review", reasons=["Two records disagree"], targeted_query=None, unsupported_explanation=[], unsupported_response=[])
    result, report = run_graph(setup_run, ScriptedModel([finding(response_text="A provisional summary is enclosed.")], [verdict]))
    assert result["review_required"] and not result["blocked"]
    assert result["explanation"] == "Only provisional records are available" and "Two records disagree" in result["review_reasons"]
    assert "A provisional summary is enclosed." in report["response_draft"] and "claim reference C-1" in report["response_draft"]

def test_unsupported_explanation_is_withheld_on_review(setup_run):
    verdict = Verification(decision="requires_review", reasons=["Needs a person"], targeted_query=None, unsupported_explanation=["The statement is not on the page"], unsupported_response=[])
    model = ScriptedModel([finding(), finding()], [verdict, verdict])
    result, _ = run_graph(setup_run, model)
    assert "The statement is not on the page" in model.corrections[1] and model.roles.count("Evidence Agent") == 2
    assert result["blocked"] and result["explanation"] != "Only provisional records are available"
    assert "The statement is not on the page" in result["review_reasons"]

def test_a_finding_flagged_by_status_alone_still_says_why(setup_run):
    conflict = finding(evidence_status="conflicting_evidence", explanation="Two invoices show different totals.")
    result, _ = run_graph(setup_run, ScriptedModel([conflict], [SUPPORTED]))
    assert result["review_required"] and not result["blocked"] and "disagree" in result["review_reasons"][0]

def test_open_question_for_the_customer_is_not_a_review_trigger(setup_run):
    result, _ = run_graph(setup_run, ScriptedModel([finding(unresolved_questions=["Can the hospital issue the final summary?"])], [SUPPORTED]))
    assert not result["review_required"] and result["unresolved_questions"] == ["Can the hospital issue the final summary?"]

def test_stopped_worker_runs_are_requeued_once(setup_run, monkeypatch):
    from types import SimpleNamespace
    from app import jobs
    queued, pending = [], []
    class Queue:
        def __init__(self, *args, **kwargs): pass
        def get_jobs(self): return [SimpleNamespace(args=(run_id,)) for run_id in pending]
        def enqueue(self, function, run_id, **kwargs): queued.append(run_id)
    monkeypatch.setattr(jobs, "settings", lambda: Settings())
    monkeypatch.setattr(jobs, "connection", lambda: None)
    monkeypatch.setattr(jobs, "Queue", Queue)
    with db.transaction() as connection:
        db.execute(connection, "UPDATE analyses SET status='running' WHERE id='run-1'")
    assert jobs.recover_interrupted_runs() == 1 and queued == ["run-1"]
    assert db.rows("SELECT status FROM analyses")[0]["status"] == "queued"
    pending.append("run-1")
    assert jobs.recover_interrupted_runs() == 1 and queued == ["run-1"]
    with db.transaction() as connection:
        db.execute(connection, "UPDATE analyses SET status='completed' WHERE id='run-1'")
    assert jobs.recover_interrupted_runs() == 0

def test_absence_confirmed_after_the_targeted_search_is_recorded_as_not_found(setup_run):
    again = Verification(decision="needs_targeted_action", reasons=["Search the hospital records"], targeted_query="laboratory report", unsupported_explanation=[], unsupported_response=[])
    missing = finding(evidence_status="not_found_in_available_records", explanation="The laboratory report is not among your documents.")
    result, _ = run_graph(setup_run, ScriptedModel([missing, missing], [again, again]))
    assert result["evidence_status"] == "not_found_in_available_records" and not result["blocked"] and not result["review_required"]
    assert result["explanation"] == "The laboratory report is not among your documents." and result["unresolved_questions"] == []

def test_other_unsettled_findings_still_go_to_review_after_the_search(setup_run):
    again = Verification(decision="needs_targeted_action", reasons=["Look for a newer version"], targeted_query="final", unsupported_explanation=[], unsupported_response=[])
    result, _ = run_graph(setup_run, ScriptedModel([finding(), finding()], [again, again]))
    assert result["review_required"] and not result["blocked"] and "Look for a newer version" in result["review_reasons"]


def test_policy_wording_is_read_before_the_customer_answer_is_written(setup_run):
    from app.schemas import PolicyContext
    clause = {"page": 1, "text": "Clause 4.1 Room rent is payable up to 1% of the sum insured per day.", "readable": True, "method": "native"}
    with db.transaction() as connection:
        db.execute(connection, "INSERT INTO documents VALUES ('policy-1','case-1','policy-1',1,'policy','wording.txt','def','unused',:pages,'extracted',:time)", pages=json.dumps([clause]), time=db.now())
        db.execute(connection, "UPDATE analyses SET input_ids=:ids WHERE id='run-1'", ids=json.dumps(["doc-1", "query-1", "policy-1"]))
    seen = {}
    class PolicyModel:
        roles = []
        def generate(self, role, instructions, payload, schema):
            self.roles.append(role)
            if schema is Plan:
                return Plan.model_validate({"requests": [{"request_id": "r1", "text": "Deduction A: room rent, clause 4.1", "required_evidence": ["bill"], "needs_policy": True, "category": "deduction"}]})
            if schema is PolicyContext:
                return PolicyContext(explanation="Room rent is capped at 1% of the sum insured per day.", position="supports_insurer", unresolved_questions=["Which sum insured applies?"],
                                     policy_refs=[{"document_id": "policy-1", "version": 1, "page": 1, "quote": "payable up to 1% of the sum insured per day"}])
            if schema is Finding:
                seen["policy_context"] = payload["policy_context"]
                return finding()
            return SUPPORTED
    model = PolicyModel()
    result, _ = run_graph(db.rows("SELECT * FROM analyses")[0], model)
    assert model.roles == ["request planner", "Policy Agent", "Evidence Agent", "Verifier Agent"]
    assert seen["policy_context"]["position"] == "supports_insurer"
    assert result["policy_position"] == "supports_insurer" and result["policy_refs"][0]["document_id"] == "policy-1"
    assert "Which sum insured applies?" in result["unresolved_questions"] and not result["blocked"]


def test_one_unsupported_sentence_is_corrected_instead_of_blocking_the_finding(setup_run):
    flagged = Verification(decision="requires_review", reasons=["Check the claim"], targeted_query=None, unsupported_explanation=["No receipt exists anywhere"], unsupported_response=[])
    result, _ = run_graph(setup_run, ScriptedModel([finding(explanation="Draft with an unsupported line"), finding()], [flagged, SUPPORTED]))
    assert not result["blocked"] and not result["review_required"] and result["explanation"] == "Only provisional records are available"

def test_a_promise_in_the_reply_is_removed_without_losing_the_finding(setup_run):
    promise = Verification(decision="supported", reasons=[], targeted_query=None, unsupported_explanation=[], unsupported_response=["I will send the final summary next week"])
    drafts = [finding(response_text="I will send the final summary next week."), finding(response_text="I will send the final summary next week.")]
    result, report = run_graph(setup_run, ScriptedModel(drafts, [promise, promise]))
    assert not result["blocked"] and not result["review_required"] and result["response_text"] == ""
    assert "I will send" not in report["response_draft"] and "Only provisional records are available" in report["response_draft"]
