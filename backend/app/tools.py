"""Case scope is bound by the worker, never supplied by the model."""
import re
from .schemas import Finding

POLICY_KINDS = {"policy", "schedule", "endorsement"}

class CaseTools:
    def __init__(self, documents: list[dict], claim_reference: str):
        self.documents = {d["id"]: d for d in documents}
        self.claim_reference = claim_reference

    def list_documents(self):
        return [{k: d[k] for k in ("id", "logical_id", "version", "kind", "filename", "sha256", "extraction_status")}
                for d in self.documents.values()]

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
                                               "kind": document["kind"], "page": page["page"], "text": page["text"]}))
        return [item for _, item in sorted(candidates, key=lambda x: x[0], reverse=True)[:limit]]

    def read_page(self, document_id, version, page):
        document = self.documents.get(document_id)
        if not document or document["version"] != version:
            return None
        return next((p for p in document["pages"] if p["page"] == page), None)

    def find_receipts(self):
        return [{**{k: d[k] for k in ("id", "version", "kind", "sha256")}, "pages": d["pages"]}
                for d in self.documents.values() if d["kind"] == "receipt"]

    def validate_source_refs(self, finding: Finding):
        errors = []
        for ref in finding.evidence_refs + finding.policy_refs + finding.receipt_refs:
            page = self.read_page(ref.document_id, ref.version, ref.page)
            if not page or ref.quote not in page["text"]:
                errors.append("Citation or exact supporting quote is absent from the authorized input snapshot")
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

    def check_identifiers(self, finding: Finding):
        errors = []
        for ref in finding.evidence_refs:
            page = self.read_page(ref.document_id, ref.version, ref.page)
            if page:
                identifiers = re.findall(r"claim(?: reference| ref| id)?\s*[:#]\s*([A-Za-z0-9-]+)", page["text"], flags=re.I)
                if any(i.casefold() != self.claim_reference.casefold() for i in identifiers):
                    errors.append("Claim identifier mismatch requires review")
        return list(dict.fromkeys(errors))
