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

def picture(text="SCAN", size=(400, 200)):
    from io import BytesIO
    from PIL import Image, ImageDraw
    image = Image.new("RGB", size, "white")
    ImageDraw.Draw(image).text((20, 20), text, fill="black")
    buffer = BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()

def pdf(*pages):
    """Each page is typed text, a picture (bytes) standing in for a scan, or None for a blank sheet."""
    import pymupdf
    document = pymupdf.open()
    for content in pages:
        page = document.new_page()
        if isinstance(content, bytes):
            page.insert_image(pymupdf.Rect(40, 40, 440, 240), stream=content)
        elif content:
            page.insert_text((72, 72), content)
    return document.tobytes()

def word(body, parts=None, relationships=""):
    import zipfile
    from io import BytesIO
    w = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{}</Relationships>'
    office = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("_rels/.rels", rels.format(f'<Relationship Id="rId1" Type="{office}officeDocument" Target="word/document.xml"/>'))
        archive.writestr("word/_rels/document.xml.rels", rels.format(relationships.replace("TYPE/", office)))
        archive.writestr("word/document.xml", f"<w:document {w}><w:body>{body}</w:body></w:document>")
        for name, content in (parts or {}).items():
            archive.writestr(name, content if isinstance(content, bytes) else f"<w:hdr {w}>{content}</w:hdr>")
    return buffer.getvalue()

def paragraph(text):
    return f"<w:p><w:r><w:t>{text}</w:t></w:r></w:p>"

def unavailable():
    raise AssertionError("A text layer must be copied without calling the model")

def test_pdf_text_layer_is_copied_exactly_without_the_model():
    pages, status = extract(pdf("Claim reference: C-1 final signed discharge summary"), "summary.pdf", reader=unavailable)
    assert status == "extracted"
    assert pages[0]["method"] == "native" and "Claim reference: C-1" in pages[0]["text"]

def test_scanned_pdf_pages_are_read_by_the_model_in_page_order(monkeypatch):
    monkeypatch.setattr("app.extraction.READERS", 1)
    seen = []
    def read(image):
        seen.append(image[:3])
        return "```\nRoom charges\t13,000.00\n```" if len(seen) == 1 else "BLANK"
    data = pdf(picture("first"), "Typed page with a real text layer, long enough to keep.", None, picture("second"))
    pages, status = extract(data, "scan.pdf", reader=lambda: read)
    assert seen == [b"\xff\xd8\xff"] * 2  # two JPEG page images; typed and empty pages were never sent
    assert [(p["page"], p["method"], p["readable"]) for p in pages] == [(1, "luna", True), (2, "native", True), (3, "native", True), (4, "luna", True)]
    assert pages[0]["text"] == "Room charges\t13,000.00"
    assert pages[2]["blank"] and pages[3]["blank"] and pages[3]["text"] == ""
    assert status == "extracted"

def test_scan_stays_unreadable_when_nothing_can_read_it(monkeypatch):
    monkeypatch.setattr("app.extraction._ocr", lambda image: "")
    pages, status = extract(pdf(picture()), "scan.pdf", reader=lambda: None)
    assert status == "unreadable" and pages[0]["method"] == "ocr" and not pages[0]["readable"]

def test_one_failed_page_does_not_lose_the_others(monkeypatch):
    from app.errors import ModelPaused
    monkeypatch.setattr("app.extraction._ocr", lambda image: "")
    monkeypatch.setattr("app.extraction.READERS", 1)
    calls = []
    def read(image):
        calls.append(1)
        if len(calls) == 1:
            raise ModelPaused("Inference unavailable")
        return "Second page"
    pages, status = extract(pdf(picture(), picture()), "scan.pdf", reader=lambda: read)
    assert [p["text"] for p in pages] == ["", "Second page"] and status == "unreadable"

def test_word_text_tables_pages_and_pictures(monkeypatch):
    body = (paragraph("Claim reference: C-1") +
            "<w:tbl><w:tblPr/><w:tr><w:trPr/><w:tc><w:tcPr/>" + paragraph("Room charges") + "</w:tc><w:tc>" + paragraph("13,000.00") + "</w:tc></w:tr></w:tbl>" +
            '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' +
            "<w:p><w:r><w:lastRenderedPageBreak/><w:t>Second</w:t></w:r><w:r><w:tab/><w:t>page</w:t></w:r>"
            "<w:del><w:r><w:delText>removed</w:delText></w:r></w:del></w:p>" +
            '<w:p><w:r><w:drawing><a:blip r:embed="rId7"/></w:drawing></w:r></w:p>' +
            '<w:p><w:r><w:drawing><a:blip r:embed="rId8"/></w:drawing></w:r></w:p>')
    relationships = ('<Relationship Id="rId7" Type="TYPE/image" Target="media/stamp.png"/>'
                     '<Relationship Id="rId8" Type="TYPE/image" Target="media/icon.png"/>'
                     '<Relationship Id="rId9" Type="TYPE/header" Target="header1.xml"/>')
    data = word(body, {"word/media/stamp.png": picture(), "word/media/icon.png": picture(size=(20, 20)),
                       "word/header1.xml": paragraph("Northfield Insurance")}, relationships)
    read = []
    pages, status = extract(data, "letter.docx", reader=lambda: lambda image: read.append(image) or "[stamp] RECEIVED 6 October 2026")
    assert status == "extracted" and len(read) == 1  # the icon is too small to carry text
    assert pages[0] == {"page": 1, "text": "Northfield Insurance\nClaim reference: C-1\nRoom charges\t13,000.00", "method": "native", "readable": True}
    assert pages[1]["text"] == "Second\tpage\n\n[stamp] RECEIVED 6 October 2026" and pages[1]["method"] == "luna"
    # Without a reader the typed text is still exact, and the unread picture is counted rather than hidden.
    monkeypatch.setattr("app.extraction._ocr", lambda image: "")
    pages, status = extract(data, "letter.docx", reader=lambda: None)
    assert status == "extracted" and pages[1] == {"page": 2, "text": "Second\tpage", "method": "native", "readable": True, "unread_images": 1}

def test_long_word_file_without_page_marks_is_cut_into_pages():
    pages, _ = extract(word("".join(paragraph("Clause %d. " % index + "wording " * 40) for index in range(40))), "policy.docx", reader=unavailable)
    assert len(pages) > 3 and all(len(page["text"]) <= 3400 for page in pages)
    assert pages[0]["text"].startswith("Clause 0.") and "Clause 39." in pages[-1]["text"]

@pytest.mark.parametrize("name,data,message", [
    ("letter.docx", b"not a zip archive", "could not be opened"),
    ("letter.docx", word('<!DOCTYPE x [<!ENTITY a "b">]>'), "not accepted"),
    ("letter.doc", b"\xd0\xcf\x11\xe0", "save the document as .docx"),
    ("photo.heic", b"x", "Only PDF, Word"),
])
def test_unsupported_or_unsafe_uploads_are_refused(name, data, message):
    with pytest.raises(ValueError, match=message):
        extract(data, name, reader=unavailable)
