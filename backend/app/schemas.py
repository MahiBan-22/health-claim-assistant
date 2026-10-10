from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator

class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")

class CaseCreate(Contract):
    title: str = Field(min_length=1, max_length=200)
    claim_reference: str = Field(min_length=1, max_length=100)

class CaseUpdate(Contract):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    claim_reference: str | None = Field(default=None, min_length=1, max_length=100)

class SourceRef(Contract):
    document_id: str
    version: int = Field(ge=1)
    page: int = Field(ge=1)
    quote: str = Field(min_length=1, max_length=4000)

class Request(Contract):
    request_id: str
    text: str = Field(min_length=1, max_length=4000)
    required_evidence: list[str]
    needs_policy: bool
    category: Literal["document_request", "repeat_request", "deduction", "rejection_reason", "clarification"] = "document_request"

class Plan(Contract):
    requests: list[Request] = Field(min_length=1, max_length=12)

    @model_validator(mode="after")
    def unique_ids(self):
        if len({r.request_id for r in self.requests}) != len(self.requests):
            raise ValueError("Request IDs must be unique")
        return self

class Finding(Contract):
    request_id: str
    evidence_status: Literal["satisfied", "partially_satisfied", "not_found_in_available_records", "unreadable", "conflicting_evidence"]
    submission_status: Literal["confirmed_by_receipt", "customer_reported", "not_established"]
    explanation: str = Field(min_length=1, max_length=6000)
    # Sentences the customer can send to the insurer; assembled into the response draft.
    response_text: str = Field(default="", max_length=3000)
    evidence_refs: list[SourceRef]
    policy_refs: list[SourceRef]
    receipt_refs: list[SourceRef]
    unresolved_questions: list[str]
    next_action: str
    review_required: bool

class PolicyContext(Contract):
    explanation: str
    # How the supplied wording bears on the insurer's stated reason; never a coverage decision.
    position: Literal["supports_insurer", "contradicts_insurer", "does_not_address", "unclear"]
    policy_refs: list[SourceRef]
    unresolved_questions: list[str]

class Verification(Contract):
    decision: Literal["supported", "needs_targeted_action", "requires_review"]
    reasons: list[str]
    targeted_query: str | None
    # Statements the cited pages do not support. Any left in the explanation after one correction block it;
    # ones only in the response text just remove that text from the letter.
    unsupported_explanation: list[str]
    unsupported_response: list[str]

class Review(Contract):
    decision: Literal["approved", "request_evidence", "override"]
    rationale: str = Field(min_length=10, max_length=4000)
    reviewer_name: str = Field(default="Local reviewer", min_length=1, max_length=80)

class DraftUpdate(Contract):
    text: str = Field(max_length=20000)

class ChecklistUpdate(Contract):
    completed: list[str] = Field(max_length=50)
