"""Case scope is bound by the worker, never supplied by the model."""
import re
import unicodedata
from .schemas import Finding
from .observability import traced

POLICY_KINDS = {"policy", "schedule", "endorsement"}
# An identifier needs a digit so words such as "Claim: rejected" are not read as references.
CLAIM_REFERENCE = re.compile(r"claim\s*(?:reference|ref\.?|id|no\.?|number)?\s*[:#]\s*((?=[A-Za-z0-9/-]*\d)[A-Za-z0-9][A-Za-z0-9/-]{2,})", re.I)
_PUNCTUATION = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", "−": "-", " ": " "})

def normalize(text: str) -> str:
    """Compare quotes on wording, not on typographic quotes, dashes, case or line wrapping."""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", text).translate(_PUNCTUATION)).strip().casefold()

def claim_references(text: str) -> list[str]:
    return list(dict.fromkeys(match.rstrip("-/") for match in CLAIM_REFERENCE.findall(text)))

def document_references(document: dict) -> list[str]:
    return list(dict.fromkeys(ref for page in document["pages"] for ref in claim_references(page["text"])))

class CaseTools:
    def __init__(self, documents: list[dict], claim_reference: str):
        self.documents = {d["id"]: d for d in documents}
        self.claim_reference = claim_reference

    @traced("list_documents", "TOOL")
    def list_documents(self):
        return [{k: d[k] for k in ("id", "logical_id", "version", "kind", "filename", "sha256", "extraction_status")}
                for d in self.documents.values()]

    @traced("search", "RETRIEVER")
    def search(self, query: str, policy=False, limit=12):
        terms = set(re.findall(r"[a-z0-9]{3,}", query.lower()))
        candidates = []
        for document in self.documents.values():
            if (document["kind"] in POLICY_KINDS) != policy:
                continue
            for page in document["pages"]:
                score = sum(term in page["text"].lower() for term in terms)
                if score:
                    candidates.append((score, {"document_id": document["id"], "version": document["version"],
                                               "kind": document["kind"], "filename": document["filename"],
                                               "page": page["page"], "text": page["text"]}))
        return [item for _, item in sorted(candidates, key=lambda x: x[0], reverse=True)[:limit]]

    @traced("read_page", "TOOL")
    def read_page(self, document_id, version, page):
        document = self.documents.get(document_id)
        if not document or document["version"] != version:
            return None
        return next((p for p in document["pages"] if p["page"] == page), None)

    @traced("find_receipts", "TOOL")
    def find_receipts(self):
        return [{**{k: d[k] for k in ("id", "version", "kind", "filename", "sha256")}, "pages": d["pages"]}
                for d in self.documents.values() if d["kind"] == "receipt"]

    def label(self, ref):
        document = self.documents.get(ref.document_id)
        name = document["filename"] if document else "an unknown document"
        return name + " (version " + str(ref.version) + ", page " + str(ref.page) + ")"

    @traced("validate_source_refs", "GUARDRAIL")
    def validate_source_refs(self, finding: Finding):
        errors = []
        for ref in finding.evidence_refs + finding.policy_refs + finding.receipt_refs:
            page = self.read_page(ref.document_id, ref.version, ref.page)
            if not page:
                errors.append("A citation points to " + self.label(ref) + ", which is not in the analysed document set")
            elif normalize(ref.quote) not in normalize(page["text"]):
                errors.append("The quoted text is not found word for word in " + self.label(ref))
        for ref in finding.policy_refs:
            if self.documents.get(ref.document_id, {}).get("kind") not in POLICY_KINDS:
                errors.append("Policy reference is not a policy, schedule or endorsement")
        if finding.evidence_status in {"satisfied", "partially_satisfied"} and not finding.evidence_refs:
            errors.append("A positive evidence finding requires source references")
        if finding.submission_status == "confirmed_by_receipt":
            if not finding.receipt_refs:
                errors.append("Confirmed submission requires a receipt citation")
            for ref in finding.receipt_refs:
                if self.documents.get(ref.document_id, {}).get("kind") != "receipt":
                    errors.append("Submission citation must refer to a receipt")
        return list(dict.fromkeys(errors))

    @traced("check_identifiers", "GUARDRAIL")
    def check_identifiers(self, finding: Finding):
        """Surface claim-reference mismatches on cited pages without deciding what they mean."""
        notes = []
        for ref in finding.evidence_refs + finding.receipt_refs:
            page = self.read_page(ref.document_id, ref.version, ref.page)
            for identifier in claim_references(page["text"]) if page else []:
                if identifier.casefold() != self.claim_reference.casefold():
                    notes.append(self.label(ref) + " shows claim reference " + identifier +
                                 ", but this case is registered as " + self.claim_reference)
        return list(dict.fromkeys(notes))

    def reference_warnings(self):
        """Case-level view of the same check, for the report header."""
        found = {}
        for document in self.documents.values():
            for identifier in document_references(document):
                if identifier.casefold() != self.claim_reference.casefold():
                    found.setdefault(identifier, []).append(document["filename"])
        return ["Claim reference " + identifier + " appears in " + ", ".join(sorted(set(names))) +
                ", but this case is registered as " + self.claim_reference +
                ". Confirm these documents belong to this claim or correct the case reference."
                for identifier, names in found.items()]
