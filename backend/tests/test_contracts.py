import pytest
from pydantic import ValidationError
from app.schemas import Finding, Plan, SourceRef
from app.tools import CaseTools
from app.extraction import extract

@pytest.fixture
def document():
    return {"id": "doc-1", "version": 1, "logical_id": "logical-1", "kind": "clinical", "filename": "summary.txt", "sha256": "abc", "extraction_status": "extracted", "pages": [{"page": 1, "text": "Claim reference: C-1\nPROVISIONAL summary", "readable": True}]}

def finding(**overrides):
    values = {"request_id": "r1", "evidence_status": "partially_satisfied", "submission_status": "not_established",
              "explanation": "Only provisional records are available", "evidence_refs": [{"document_id": "doc-1", "version": 1, "page": 1, "quote": "PROVISIONAL summary"}],
              "policy_refs": [], "receipt_refs": [], "unresolved_questions": [], "next_action": "Obtain the final summary", "review_required": False}
    return Finding.model_validate({**values, **overrides})

def test_source_quotes_and_version_are_checked(document):
    tools = CaseTools([document], "C-1")
    assert tools.validate_source_refs(finding()) == []
    invalid = finding()
    invalid.evidence_refs[0].version = 2
    assert tools.validate_source_refs(invalid)
    invalid = finding()
    invalid.evidence_refs[0].quote = "Final signed summary"
    assert tools.validate_source_refs(invalid)

def test_cross_case_reference_is_rejected(document):
    invalid = finding()
    invalid.evidence_refs[0].document_id = "other-case-document"
    assert CaseTools([document], "C-1").validate_source_refs(invalid)

def test_upload_is_not_receipt(document):
    tools = CaseTools([document], "C-1")
    assert tools.validate_source_refs(finding(submission_status="confirmed_by_receipt"))
    invalid = finding(submission_status="confirmed_by_receipt", receipt_refs=[{"document_id": "doc-1", "version": 1, "page": 1, "quote": "PROVISIONAL summary"}])
    assert tools.validate_source_refs(invalid)

def test_identifier_mismatch(document):
    assert CaseTools([document], "WRONG-CASE").check_identifiers(finding())

def test_duplicate_tasks_rejected():
    task = {"request_id": "r1", "text": "Final summary", "required_evidence": ["summary"], "needs_policy": False}
    with pytest.raises(ValidationError):
        Plan.model_validate({"requests": [task, task]})

def test_text_keeps_original_page_mapping():
    pages, status = extract(b"First page\fSecond page", "sample.txt")
    assert status == "extracted"
    assert [(p["page"], p["text"]) for p in pages] == [(1, "First page"), (2, "Second page")]

def test_unreadable_text_is_explicit():
    pages, status = extract(b" ", "empty.txt")
    assert status == "unreadable"
    assert not pages[0]["readable"]
