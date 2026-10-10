export type ClaimCase = {
  id: string;
  title: string;
  claim_reference: string;
  created_at?: string;
  document_count?: number;
  analysis_count?: number;
  report_count?: number;
  latest_status?: string | null;
  sample_key?: string | null;
  sample_follow_up?: string | null;
};
export type Document = {
  id: string;
  logical_id: string;
  filename: string;
  kind: string;
  version: number;
  extraction_status: string;
  created_at?: string;
  page_count?: number;
  claim_references?: string[];
  in_use?: boolean;
  is_latest?: boolean;
};
export type Page = {
  page: number;
  text: string;
  method?: string;
  readable?: boolean;
};
export type Run = {
  id: string;
  case_id: string;
  created_at: string;
  status: string;
  error: string | null;
  report_id: string | null;
};
export type Ref = {
  document_id: string;
  version: number;
  page: number;
  quote: string;
};
export type Verification = { decision: string; reasons: string[] };
export type Finding = {
  request_id: string;
  evidence_status: string;
  submission_status: string;
  explanation: string;
  response_text?: string;
  evidence_refs: Ref[];
  policy_refs: Ref[];
  receipt_refs: Ref[];
  unresolved_questions: string[];
  next_action: string;
  review_required: boolean;
  blocked?: boolean;
  policy_position?: string | null;
  review_reasons?: string[];
  verification?: Verification;
  source_checks?: string[];
  withheld_explanation?: string;
};
export type ClaimRequest = {
  request_id: string;
  text: string;
  category?: string;
  needs_policy?: boolean;
};
export type ManifestItem = {
  document_id: string;
  version: number;
  filename: string;
  kind?: string;
  sha256?: string;
};
export type Report = {
  id: string;
  case_id: string;
  run_id: string;
  version: number;
  model: string;
  created_at?: string;
  claim_reference?: string;
  findings: Finding[];
  requests: ClaimRequest[];
  response_draft: string;
  customer_draft?: string | null;
  completed_actions?: string[];
  review_required: boolean;
  attachment_manifest: ManifestItem[];
  input_versions?: {
    id: string;
    filename: string;
    version: number;
    kind: string;
  }[];
  warnings?: string[];
};
export type Decision = {
  id: string;
  task_id: string;
  reviewer: string;
  decision: string;
  rationale: string;
  created_at: string;
  request_id?: string;
};
export type QueueItem = {
  task_id: string;
  report_id: string;
  report_version: number;
  case_id: string;
  case_title: string;
  claim_reference: string;
  created_at: string;
  current: boolean;
  request: string;
  finding: Finding;
  decisions: Decision[];
};
export type Sample = {
  key: string;
  title: string;
  claim_reference: string;
  scenario: string;
  summary: string;
  what_to_expect: string[];
  accent: string;
  document_count: number;
  has_follow_up: boolean;
};
export type SystemStatus = {
  api: boolean;
  database: boolean;
  redis: boolean;
  workers: number;
  queued: number;
  ocr: boolean;
  model: string;
  counts: {
    cases: number;
    documents: number;
    analyses: number;
    reports: number;
    active: number;
  };
};
export type Connection = {
  connected: boolean;
  storage_available: boolean;
  email?: string | null;
  message?: string;
  model?: string;
  model_available?: boolean;
};
export type TimelineEvent = {
  date: string;
  label: string;
  document_id: string;
  filename: string;
  kind: string;
  version: number;
  page: number;
};
export type Uploaded = {
  id: string;
  kind: string;
  filename: string;
  version: number;
  claim_references: string[];
};
