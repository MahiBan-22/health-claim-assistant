"""Step-by-step record of each analysis, for the workflow view.

Mirrors the telemetry spans into the application database. Like telemetry it holds
metadata only: step names, timings, counts and outcomes, never document text.
"""
import json
from datetime import datetime, timezone
from . import db
from .config import settings

# Steps shown while still in progress; tools are quick and are stored when they finish.
LIVE_KINDS = {"WORKFLOW", "AGENT", "LLM"}
ACTIVE = {"queued", "running"}
TOP_LEVEL = {"claim.catalog", "plan", "policy", "evidence", "verify", "claim.package"}
FACTS = {"claim.result_count": "results", "claim.request_index": "request_index", "claim.correction_count": "correction",
         "claim.source_error_count": "source_errors", "claim.unresolved_count": "open_points",
         "neatlogs.guardrail.passed": "checks_passed", "claim.correction_reason": "correction_reason",
         "claim.document_count": "documents", "claim.error_type": "error"}

def record(phase, info):
    """Recorder registered with observability.span; called at the start and end of every step."""
    run_id = info["attributes"].get("claim.run_id")
    if not run_id or (phase == "start" and info["kind"] not in LIVE_KINDS):
        return
    with db.transaction() as connection:
        db.execute(connection, "INSERT INTO run_events VALUES (:id,:run,:parent,:name,:kind,:started,:duration,:attributes) "
                   "ON CONFLICT(id) DO UPDATE SET duration_ms=excluded.duration_ms, attributes=excluded.attributes",
                   id=info["span_id"], run=run_id, parent=info["parent_span_id"], name=info["name"], kind=info["kind"],
                   started=info["started"], duration=info.get("duration_ms"), attributes=json.dumps(info["attributes"]))

def install():
    from . import observability
    observability.set_recorder(record)

def import_local_telemetry(run_id):
    """Analyses made before the step record existed still have their steps in the local telemetry log."""
    added = 0
    for path in sorted(settings().log_dir.resolve().glob("telemetry-worker.jsonl*")):
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        with db.transaction() as connection:
            for line in lines:
                if run_id not in line:
                    continue
                try:
                    item = json.loads(line)
                    attributes = item["attributes"]
                    if item.get("event") != "span" or attributes.get("claim.run_id") != run_id:
                        continue
                    duration = float(attributes.get("claim.duration_ms", 0))
                    added += db.execute(connection, "INSERT INTO run_events VALUES (:id,:run,:parent,:name,:kind,:started,:duration,:attributes) ON CONFLICT(id) DO NOTHING",
                                        id=item["span_id"], run=run_id, parent=item["parent_span_id"], name=item["name"], kind=item["kind"],
                                        started=float(item["time"]) - duration / 1000, duration=duration, attributes=json.dumps(attributes)).rowcount
                except (ValueError, KeyError, TypeError):
                    continue
    return added

def checkpoint_values(thread_id):
    """Requests and findings so far for an analysis that has no report yet. Best effort."""
    from .checkpoints import saver
    path = settings().data_dir / "checkpoints.sqlite"
    if not settings().postgres and not path.exists():
        return {}
    try:
        with saver(settings()) as store:
            saved = store.get_tuple({"configurable": {"thread_id": thread_id}})
        return dict(saved.checkpoint.get("channel_values", {})) if saved else {}
    except Exception:
        return {}

def _iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat()

def _step(event, children, live):
    attributes = event["attributes"]
    models = [c for c in children if c["kind"] == "LLM"]
    tools = {}
    for child in children:
        if child["kind"] == "LLM":
            continue
        tool = tools.setdefault(child["name"], {"name": child["name"], "kind": child["kind"], "calls": 0, "results": 0, "duration_ms": 0.0, "passed": None})
        tool["calls"] += 1
        tool["results"] += child["attributes"].get("claim.result_count", 0)
        tool["duration_ms"] += child["duration_ms"] or 0
        if "neatlogs.guardrail.passed" in child["attributes"]:
            tool["passed"] = bool(child["attributes"]["neatlogs.guardrail.passed"]) and tool["passed"] is not False
    unfinished = event["duration_ms"] is None
    return {"id": event["id"], "name": event["name"], "kind": event["kind"], "started_at": _iso(event["started_at"]),
            "duration_ms": event["duration_ms"], "running": unfinished and live, "interrupted": unfinished and not live,
            "outcome": attributes.get("claim.outcome"),
            "model": {"calls": len(models), "duration_ms": sum(m["duration_ms"] or 0 for m in models),
                      "tokens": sum(m["attributes"].get("neatlogs.llm.token_count.total", 0) for m in models),
                      "running": live and any(m["duration_ms"] is None for m in models)} if models else None,
            "tools": list(tools.values()),
            "facts": {label: attributes[key] for key, label in FACTS.items() if key in attributes}}

def _attempt(root, children_of, live):
    setup, plan, package, passes, pending = [], None, None, [], []
    for event in children_of(root["id"]):
        step = _step(event, children_of(event["id"]), live)
        if event["name"] == "plan":
            plan = step
        elif event["name"] == "claim.package":
            package = step
        elif event["name"] in {"policy", "evidence"}:
            pending.append(step)
        elif event["name"] == "verify":
            passes.append({"request_index": step["facts"].get("request_index"), "number": step["facts"].get("correction", 0), "steps": pending + [step]})
            pending = []
        else:
            setup.append(step)
    if pending:
        # A pass still in progress, or one cut short. Older records carry no index on these steps.
        index = pending[0]["facts"].get("request_index")
        number = pending[0]["facts"].get("correction")
        if index is None and passes:
            previous = passes[-1]
            index = previous["request_index"] if previous["steps"][-1]["facts"].get("correction_reason") else (previous["request_index"] or 0) + 1
        passes.append({"request_index": index or 0, "number": number or 0, "steps": pending})
    for item in passes:
        if item["request_index"] is None:
            item["request_index"] = 0
    step = _step(root, [], live)
    return {**{key: step[key] for key in ("id", "started_at", "duration_ms", "running", "interrupted", "outcome", "facts")},
            "setup": setup, "plan": plan, "package": package, "passes": passes}

def view(run, report_body=None):
    """The analysis as it actually ran: attempts, the plan, each request's passes, and packaging."""
    # rowid keeps recording order for steps that began within the same clock tick.
    order = "started_at, id" if settings().postgres else "started_at, rowid"
    records = db.rows("SELECT * FROM run_events WHERE run_id=:run ORDER BY " + order, run=run["id"])
    if not records and import_local_telemetry(run["id"]):
        records = db.rows("SELECT * FROM run_events WHERE run_id=:run ORDER BY " + order, run=run["id"])
    for record_ in records:
        record_["attributes"] = json.loads(record_["attributes"])
    by_parent = {}
    for record_ in records:
        by_parent.setdefault(record_["parent_id"], []).append(record_)
    roots = [r for r in records if r["name"] == "claim.analysis"]
    # An attempt cut short before this record existed left its steps in the log without their parent.
    known = {r["id"] for r in records}
    for parent, children in by_parent.items():
        if parent and parent not in known and any(c["name"] in TOP_LEVEL for c in children):
            roots.append({"id": parent, "name": "claim.analysis", "kind": "WORKFLOW", "duration_ms": None, "attributes": {},
                          "started_at": min(c["started_at"] for c in children)})
    roots.sort(key=lambda root: root["started_at"])
    attempts = [_attempt(root, lambda parent: by_parent.get(parent, []), run["status"] in ACTIVE and root is roots[-1]) for root in roots]

    state = report_body or checkpoint_values(run["thread_id"])
    findings = {f["request_id"]: f for f in state.get("findings", [])}
    requests = []
    for index, request in enumerate(state.get("requests", [])):
        finding = findings.get(request["request_id"])
        requests.append({"index": index, "text": request["text"], "category": request.get("category"), "needs_policy": request.get("needs_policy"),
                         "result": {key: finding.get(key) for key in ("evidence_status", "submission_status", "review_required", "blocked", "policy_position")} if finding else None})
    models = [r for r in records if r["kind"] == "LLM"]
    return {"run": {key: run[key] for key in ("id", "case_id", "status", "error", "report_id", "created_at")},
            "recorded": bool(records), "requests": requests, "attempts": attempts,
            "totals": {"duration_ms": sum(a["duration_ms"] or 0 for a in attempts), "attempts": len(attempts), "model_calls": len(models),
                       "tokens": sum(m["attributes"].get("neatlogs.llm.token_count.total", 0) for m in models),
                       "tool_calls": sum(1 for r in records if r["kind"] in {"TOOL", "RETRIEVER", "GUARDRAIL"} and r["name"] not in {"claim.catalog", "claim.package"}),
                       "corrections": sum(1 for a in attempts for p in a["passes"] if p["number"]),
                       "documents": next((a["facts"].get("documents") for a in reversed(attempts) if a["facts"].get("documents")), len(json.loads(run["input_ids"])))}}

def monthly_metrics():
    """Aggregate usage per month for business planning. Totals only: no claim, document or person appears."""
    for row in db.rows("SELECT id FROM analyses WHERE id NOT IN (SELECT DISTINCT run_id FROM run_events)"):
        import_local_telemetry(row["id"])
    months = {}
    def bucket(stamp):
        return months.setdefault(stamp[:7], {"month": stamp[:7], "claims_created": 0, "documents_uploaded": 0, "analyses_started": 0, "analyses_completed": 0,
                                             "findings": 0, "findings_needing_review": 0, "review_decisions": 0, "corrective_cycles": 0,
                                             "model_calls": 0, "model_tokens": 0, "analysis_seconds": 0.0})
    for row in db.rows("SELECT created_at FROM cases"):
        bucket(row["created_at"])["claims_created"] += 1
    for row in db.rows("SELECT created_at FROM documents"):
        bucket(row["created_at"])["documents_uploaded"] += 1
    for row in db.rows("SELECT created_at, status FROM analyses"):
        entry = bucket(row["created_at"])
        entry["analyses_started"] += 1
        entry["analyses_completed"] += row["status"] == "completed"
    for row in db.rows("SELECT created_at, body FROM reports"):
        findings = json.loads(row["body"]).get("findings", [])
        entry = bucket(row["created_at"])
        entry["findings"] += len(findings)
        entry["findings_needing_review"] += sum(1 for f in findings if f.get("review_required"))
    for row in db.rows("SELECT created_at FROM reviews"):
        bucket(row["created_at"])["review_decisions"] += 1
    for row in db.rows("SELECT name, kind, started_at, duration_ms, attributes FROM run_events WHERE kind IN ('LLM','WORKFLOW') OR name='verify'"):
        entry = bucket(_iso(row["started_at"]))
        attributes = json.loads(row["attributes"])
        if row["kind"] == "LLM":
            entry["model_calls"] += 1
            entry["model_tokens"] += attributes.get("neatlogs.llm.token_count.total", 0)
        elif row["kind"] == "WORKFLOW":
            entry["analysis_seconds"] += (row["duration_ms"] or 0) / 1000
        elif attributes.get("claim.correction_count"):
            entry["corrective_cycles"] += 1
    for entry in months.values():
        entry["analysis_seconds"] = round(entry["analysis_seconds"], 1)
    return [months[key] for key in sorted(months)]
