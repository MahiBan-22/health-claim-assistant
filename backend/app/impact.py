"""Landing-page aggregates. Latest reports prevent reruns inflating impact."""
import json

from . import db


def summarize(owner, sample_references):
    groups = {}
    for scope in ("customer", "samples"):
        groups[scope] = dict(claims=0, documents=0, cases_analyzed=0, points_checked=0,
                             supported_points=0, needs_review=0, evidence_gaps=0,
                             cited_points=0, receipts_confirmed=0, policy_points=0,
                             timed_reports=0, analysis_seconds=0, report_seconds=[])
    cases = db.rows("SELECT id, claim_reference FROM cases WHERE owner=:owner", owner=owner)
    reports = db.rows("""SELECT r.* FROM reports r JOIN cases c ON c.id=r.case_id
                         WHERE c.owner=:owner ORDER BY r.created_at DESC, r.rowid DESC""", owner=owner)
    latest = {}
    for report in reports:
        latest.setdefault(report["case_id"], report)
    documents = {r["case_id"]: r["n"] for r in db.rows(
        "SELECT case_id, COUNT(*) AS n FROM documents GROUP BY case_id")}
    timings = {}
    for event in db.rows("""SELECT e.run_id, e.duration_ms FROM run_events e
                           JOIN analyses a ON a.id=e.run_id
                           WHERE a.owner=:owner AND e.name='claim.analysis'""", owner=owner):
        timings.setdefault(event["run_id"], []).append(event["duration_ms"])
    for case in cases:
        group = groups["samples" if case["claim_reference"] in sample_references else "customer"]
        group["claims"] += 1
        group["documents"] += documents.get(case["id"], 0)
        report = latest.get(case["id"])
        if report is None:
            continue
        group["cases_analyzed"] += 1
        for finding in json.loads(report["body"]).get("findings", []):
            group["points_checked"] += 1
            group["supported_points"] += bool(
                finding.get("evidence_status") == "satisfied"
                and finding.get("verification", {}).get("decision") == "supported"
                and not finding.get("blocked") and not finding.get("review_required"))
            group["needs_review"] += bool(finding.get("review_required") or finding.get("blocked"))
            group["evidence_gaps"] += finding.get("evidence_status") in {
                "partially_satisfied", "not_found_in_available_records", "unreadable"}
            group["cited_points"] += bool(not finding.get("blocked") and any(
                finding.get(key) for key in ("evidence_refs", "policy_refs", "receipt_refs")))
            group["receipts_confirmed"] += finding.get("submission_status") == "confirmed_by_receipt"
            group["policy_points"] += bool(finding.get("policy_refs"))
        durations = timings.get(report["run_id"], [])
        # Interrupted attempts have unknown duration; don't present a partial total as elapsed time.
        if durations and all(value is not None and value >= 0 for value in durations):
            seconds = sum(durations) / 1000
            group["timed_reports"] += 1
            group["analysis_seconds"] += seconds
            group["report_seconds"].append(round(seconds, 2))
    for group in groups.values():
        group["analysis_seconds"] = round(group["analysis_seconds"], 2)
    return groups
