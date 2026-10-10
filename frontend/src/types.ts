export type ClaimCase = { id: string; title: string; claim_reference: string };
export type Document = { id: string; logical_id: string; filename: string; kind: string; version: number; extraction_status: string };
export type Run = { id: string; status: string; error: string | null; report_id: string | null };
export type Ref = { document_id: string; version: number; page: number; quote: string };
export type Finding = { request_id: string; evidence_status: string; submission_status: string; explanation: string; evidence_refs: Ref[]; policy_refs: Ref[]; receipt_refs: Ref[]; unresolved_questions: string[]; next_action: string; review_required: boolean };
export type Report = { id: string; case_id: string; run_id: string; version: number; model: string; findings: Finding[]; requests: {request_id: string; text: string}[]; response_draft: string; review_required: boolean; attachment_manifest: unknown[] };
