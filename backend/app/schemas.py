from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator

class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")

class CaseCreate(Contract):
    title: str = Field(min_length=1, max_length=200)
    claim_reference: str = Field(min_length=1, max_length=100)

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
    evidence_refs: list[SourceRef]
    policy_refs: list[SourceRef]
    receipt_refs: list[SourceRef]
    unresolved_questions: list[str]
    next_action: str
    review_required: bool

class PolicyContext(Contract):
    explanation: str
    policy_refs: list[SourceRef]
    unresolved_questions: list[str]

class Verification(Contract):
    decision: Literal["supported", "needs_targeted_action", "requires_review"]
    reasons: list[str]
    targeted_query: str | None

class Review(Contract):
    decision: Literal["approved", "request_evidence", "override"]
    rationale: str = Field(min_length=10, max_length=4000)
