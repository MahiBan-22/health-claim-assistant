from pathlib import Path
from app import intake
from app.model import json_object
from app.tools import claim_references, normalize

def page(text):
    return [{"page": 1, "text": text}]

def test_categories_follow_wording_not_just_filenames():
    assert intake.classify("scan-001.txt", page("Receipt status: insurer receipt acknowledged\nAcknowledgement number: A-1")) == "receipt"
    assert intake.classify("doc.txt", page("Invoice number: INV-1\nItemized charges:\nTotal billed 100")) == "bill"
    assert intake.classify("doc.txt", page("Document: Endorsement\nEndorsement number: E-02\nclause 5.2 shall not apply")) == "endorsement"
    assert intake.classify("doc.txt", page("Document: Policy schedule\nSum insured: 500,000\nPolicy period: 1 April 2026")) == "schedule"
    assert intake.classify("holiday.txt", page("Nothing relevant here")) == "other"

def test_shipped_scenarios_are_categorised_as_labelled():
    fixtures = Path(__file__).resolve().parents[2] / "fixtures"
    scenarios = intake.scenarios(fixtures)
    assert [s["key"][:2] for s in scenarios] == ["01", "02", "03", "04", "05"]
    for scenario in scenarios:
        for document in scenario["documents"]:
            text = (scenario["directory"] / document["file"]).read_text(encoding="ascii")
            assert intake.classify(document["file"], page(text)) == document["kind"], document["file"]

def test_claim_reference_needs_an_identifier_not_a_word():
    assert claim_references("Claim reference: SYN-DEMO-001\nClaim: rejected\nClaim No: AB/2026/77.") == ["SYN-DEMO-001", "AB/2026/77"]

def test_quote_normalisation_keeps_wording():
    assert normalize("“Final”  signed\nsummary – issued") == normalize('"final" signed summary - issued')
    assert normalize("final summary") != normalize("provisional summary")

def test_dates_in_several_formats_are_ordered():
    documents = [{"id": "d", "logical_id": "l", "version": 1, "kind": "clinical", "filename": "a.txt",
                  "pages": [{"page": 1, "text": "Discharge: October 5, 2026\nAdmission date: 1 Oct 2026\nNo date here\nBad date: 31/02/2026"}]}]
    assert [e["date"] for e in intake.timeline(documents)] == ["2026-10-01", "2026-10-05"]

def test_model_json_is_unwrapped_from_code_fences():
    assert json_object('```json\n{"a": 1}\n```') == '{"a": 1}'
    assert json_object('Here you go: {"a": {"b": 2}} thanks') == '{"a": {"b": 2}}'
