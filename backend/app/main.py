import asyncio
import hashlib
import io
import json
import logging
import shutil
import sqlite3
import zipfile
from contextlib import asynccontextmanager, closing
from pathlib import Path
from typing import Annotated, Literal
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile, Cookie
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from starlette.concurrency import run_in_threadpool
from . import db, intake, trace_store
from .config import settings
from .extraction import extract
from .jobs import enqueue, queue_status
from .schemas import CaseCreate, CaseUpdate, ChecklistUpdate, DraftUpdate, Review
from .logging_setup import configure_logging, RequestLoggingMiddleware
from .chatgpt_auth import ChatGPTConnection
from .errors import ModelPaused
from .tools import document_references

logger = logging.getLogger(__name__)
ACTIVE = {"queued", "running"}
DocumentKind = Literal["insurer_communication", "clinical", "bill", "receipt", "policy", "schedule", "endorsement", "other"]

@asynccontextmanager
async def lifespan(app):
    configure_logging("api", settings())
    logging.getLogger("uvicorn.access").disabled = True  # OAuth codes/tickets must not enter raw access logs.
    from . import observability
    observability.initialize("api", settings())
    logger.info("api_started")
    try:
        yield
    finally:
        observability.shutdown()
        logger.info("api_stopped")

class LocalBoundaryMiddleware:
    """The workspace has no login, so the API only answers its own loopback interface.

    Host validation stops DNS rebinding; Origin validation stops other websites from
    reading or changing cases through the user's browser. Processes already running
    as this OS user can read the data directory directly and are not in scope.
    """
    def __init__(self, app, hosts, origins):
        self.app, self.hosts, self.origins = app, hosts, {o.rstrip("/") for o in origins}

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {key.decode("latin-1").lower(): value.decode("latin-1") for key, value in scope["headers"]}
        host = headers.get("host", "")
        hostname = host[1:host.index("]")] if host.startswith("[") and "]" in host else host.split(":")[0]
        origin = headers.get("origin")
        refusal = None
        if hostname.lower() not in self.hosts:
            refusal = (400, "Unrecognised host for this local workspace")
        elif origin is not None and origin.rstrip("/") not in self.origins:
            refusal = (403, "This workspace only accepts requests from its own interface")
        elif origin is None and scope["method"] not in {"GET", "HEAD", "OPTIONS"} and headers.get("sec-fetch-site") == "cross-site":
            refusal = (403, "This workspace only accepts requests from its own interface")
        if refusal:
            return await JSONResponse({"detail": refusal[1]}, status_code=refusal[0])(scope, receive, send)
        await self.app(scope, receive, send)

app = FastAPI(title="Health Claim Evidence Assistant", version="0.2.0", lifespan=lifespan)
app.add_middleware(LocalBoundaryMiddleware, hosts=settings().trusted_hosts, origins=settings().cors_origins)
app.add_middleware(CORSMiddleware, allow_origins=settings().cors_origins,
                   allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
                   allow_headers=["Content-Type", "X-Workspace-Role"])
app.add_middleware(RequestLoggingMiddleware)

def principal(role: Annotated[str | None, Header(alias="X-Workspace-Role")] = None):
    # One local owner. Reviewer mode is a workspace role chosen in the interface, not an identity.
    return {"owner": "local", "role": "reviewer" if role == "reviewer" else "customer"}

User = Annotated[dict, Depends(principal)]

def case_for(case_id, user):
    cases = db.rows("SELECT * FROM cases WHERE id=:id AND owner=:owner", id=case_id, owner=user["owner"])
    if not cases:
        raise HTTPException(404, "Case not found")
    return cases[0]

def run_for(run_id, user):
    runs = db.rows("SELECT * FROM analyses WHERE id=:id AND owner=:owner", id=run_id, owner=user["owner"])
    if not runs:
        raise HTTPException(404, "Analysis not found")
    return runs[0]

def report_for(report_id, user):
    records = db.rows("SELECT * FROM reports WHERE id=:id", id=report_id)
    if not records:
        raise HTTPException(404, "Report not found")
    case_for(records[0]["case_id"], user)
    return records[0]

def reviewer(user):
    if user["role"] != "reviewer":
        raise HTTPException(403, "Switch to reviewer mode to do this")

def notify(case_id):
    from .notifications import notify_case
    notify_case(case_id)

def drop_checkpoints(thread_ids):
    from langgraph.checkpoint.sqlite import SqliteSaver
    checkpoint = settings().data_dir / "checkpoints.sqlite"
    if checkpoint.exists() and thread_ids:
        with closing(sqlite3.connect(str(checkpoint), check_same_thread=False)) as connection:
            saver = SqliteSaver(connection)
            for thread_id in thread_ids:
                saver.delete_thread(thread_id)
            connection.commit()

def sample_keys():
    return {item["claim_reference"]: item for item in intake.scenarios(settings().fixtures_dir)}

CASE_VIEW = """SELECT c.*,
    (SELECT COUNT(*) FROM documents d WHERE d.case_id=c.id) AS document_count,
    (SELECT COUNT(*) FROM analyses a WHERE a.case_id=c.id) AS analysis_count,
    (SELECT COUNT(*) FROM reports r WHERE r.case_id=c.id) AS report_count,
    (SELECT a.status FROM analyses a WHERE a.case_id=c.id ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS latest_status
    FROM cases c WHERE c.owner=:owner"""

def case_views(user, case_id=None):
    samples = sample_keys()
    records = db.rows(CASE_VIEW + (" AND c.id=:id" if case_id else "") + " ORDER BY c.created_at DESC", owner=user["owner"], **({"id": case_id} if case_id else {}))
    for record in records:
        sample = samples.get(record["claim_reference"])
        record["sample_key"] = sample["key"] if sample else None
        record["sample_follow_up"] = sample.get("follow_up", {}).get("description") if sample else None
    return records

def document_view(document, used=frozenset(), latest=frozenset()):
    view = {k: v for k, v in document.items() if k not in {"path", "pages"}}
    view.update(page_count=len(document["pages"]), claim_references=document_references(document),
                in_use=document["id"] in used, is_latest=document["id"] in latest)
    return view

def store_document(case_id, data, filename, kind, logical_id=None):
    if len(data) > settings().max_upload_bytes:
        raise HTTPException(413, "Upload exceeds size limit")
    if not data:
        raise HTTPException(422, "Document is empty")
    filename = Path((filename or "document.txt").replace("\\", "/")).name
    try:
        # OCR is bounded; move extraction into a dedicated RQ job in the next milestone.
        pages, status = extract(data, filename)
    except (ValueError, UnicodeError) as error:
        raise HTTPException(422, str(error)) from error
    except Exception as error:
        raise HTTPException(422, "Document could not be extracted; supply a readable PDF or UTF-8 text file") from error
    if kind == "auto":
        kind = intake.classify(filename, pages)
    document_id = db.uid()
    digest = hashlib.sha256(data).hexdigest()
    path = settings().data_dir.resolve() / "cases" / case_id / (document_id + Path(filename).suffix.lower())
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    try:
        with db.transaction() as connection:
            # Acquire a write lock before choosing the next version.
            db.execute(connection, "UPDATE cases SET title=title WHERE id=:id", id=case_id)
            if logical_id:
                previous = db.execute(connection, "SELECT MAX(version) AS version, kind FROM documents WHERE case_id=:case AND logical_id=:logical GROUP BY kind", case=case_id, logical=logical_id).mappings().first()
                if not previous:
                    raise HTTPException(422, "Replacement must identify an existing document in this case")
                version, kind = previous["version"] + 1, previous["kind"]
            else:
                logical_id, version = db.uid(), 1
            db.execute(connection, "INSERT INTO documents VALUES (:id,:case,:logical,:version,:kind,:filename,:hash,:path,:pages,:status,:time)",
                       id=document_id, case=case_id, logical=logical_id, version=version, kind=kind,
                       filename=filename, hash=digest, path=str(path), pages=json.dumps(pages), status=status, time=db.now())
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return {"id": document_id, "logical_id": logical_id, "version": version, "kind": kind, "filename": filename, "sha256": digest,
            "extraction_status": status, "claim_references": document_references({"pages": pages})}

@app.get("/health")
def health():
    db.engine()
    return {"status": "ok", "model": settings().llm_model, "authentication": "local workspace", "oauth_setup": "host_sign_in"}

@app.get("/system/status")
def system_status(user: User):
    counts = db.rows("SELECT (SELECT COUNT(*) FROM cases) AS cases, (SELECT COUNT(*) FROM documents) AS documents, (SELECT COUNT(*) FROM analyses) AS analyses, (SELECT COUNT(*) FROM reports) AS reports, (SELECT COUNT(*) FROM analyses WHERE status IN ('queued','running')) AS active")[0]
    return {"api": True, "database": True, **queue_status(), "ocr": bool(shutil.which("tesseract")),
            "model": settings().llm_model, "counts": counts}

def package_version(name):
    from importlib.metadata import PackageNotFoundError, version
    try:
        return version(name)
    except PackageNotFoundError:
        return None

@app.get("/system/integrations")
def integrations(user: User):
    """How the hackathon's required tools and the core stack are used. Facts only, read from this installation."""
    from . import observability
    config = settings()
    repository = Path(__file__).resolve().parents[2]
    entire = {}
    try:
        entire = json.loads((repository / ".entire" / "settings.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    counts = db.rows("SELECT (SELECT COUNT(DISTINCT run_id) FROM run_events) AS traced, (SELECT COUNT(*) FROM run_events) AS steps, "
                     "(SELECT COUNT(*) FROM analyses) AS analyses")[0]
    return {
        "neatlogs": {"sdk_version": package_version("neatlogs"), "enabled": config.neatlogs_enabled, "key_configured": bool(config.neatlogs_api_key.get_secret_value()),
                     "exporting": observability.exporting(), "endpoint": config.neatlogs_endpoint, "workflow_name": config.neatlogs_workflow_name,
                     "analyses_traced": counts["traced"], "steps_recorded": counts["steps"]},
        "entire": {"enabled": bool(entire.get("enabled")), "configured": bool(entire)},
        "cfo_ai": {"export": "/business/metrics.csv", "months": len(trace_store.monthly_metrics()), "analyses": counts["analyses"]},
        "stack": {name: package_version(name) for name in ("langgraph", "fastapi", "pydantic", "sqlalchemy", "rq", "redis", "pymupdf", "httpx", "keyring")},
        "model": config.llm_model,
    }

@app.get("/business/metrics.csv")
def business_metrics(user: User):
    """Monthly totals for the cfo.ai business model. No claim content, document or person is included."""
    import csv
    rows = trace_store.monthly_metrics()
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=list(rows[0]) if rows else ["month"], lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return Response(buffer.getvalue(), media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="claimwise-monthly-metrics.csv"'})

@app.get("/cases")
def list_cases(user: User):
    return case_views(user)

@app.post("/cases", status_code=201)
def create_case(body: CaseCreate, user: User):
    case_id = db.uid()
    with db.transaction() as connection:
        db.execute(connection, "INSERT INTO cases VALUES (:id,:owner,:title,:reference,:time)", id=case_id,
                   owner=user["owner"], title=body.title.strip(), reference=body.claim_reference.strip(), time=db.now())
    return case_views(user, case_id)[0]

@app.patch("/cases/{case_id}")
def update_case(case_id: str, body: CaseUpdate, user: User):
    case = case_for(case_id, user)
    with db.transaction() as connection:
        db.execute(connection, "UPDATE cases SET title=:title, claim_reference=:reference WHERE id=:id", id=case_id,
                   title=(body.title or case["title"]).strip(), reference=(body.claim_reference or case["claim_reference"]).strip())
    return case_views(user, case_id)[0]

@app.delete("/cases/{case_id}")
def delete_case(case_id: str, user: User):
    case_for(case_id, user)
    runs = db.rows("SELECT id, thread_id, status FROM analyses WHERE case_id=:case", case=case_id)
    if any(run["status"] in ACTIVE for run in runs):
        raise HTTPException(409, "Wait for the running analysis to finish before deleting this case")
    drop_checkpoints([run["thread_id"] for run in runs])
    with db.transaction() as connection:
        for run in runs:
            db.delete_run(connection, run["id"])
        db.execute(connection, "DELETE FROM documents WHERE case_id=:id", id=case_id)
        db.execute(connection, "DELETE FROM cases WHERE id=:id", id=case_id)
    shutil.rmtree(settings().data_dir.resolve() / "cases" / case_id, ignore_errors=True)
    return {"deleted": True}

@app.get("/cases/{case_id}/documents")
def list_documents(case_id: str, user: User):
    case_for(case_id, user)
    documents = db.documents(case_id)
    used = {doc for run in db.rows("SELECT input_ids FROM analyses WHERE case_id=:case", case=case_id) for doc in json.loads(run["input_ids"])}
    latest = {d["id"] for d in db.latest_versions(documents)}
    return [document_view(d, used, latest) for d in documents]

@app.post("/cases/{case_id}/documents", status_code=201)
async def upload_document(case_id: str, user: User, file: Annotated[UploadFile, File()],
                          kind: Annotated[DocumentKind | Literal["auto"], Form()] = "auto",
                          logical_id: Annotated[str | None, Form()] = None):
    case_for(case_id, user)
    data = await file.read(settings().max_upload_bytes + 1)
    return await run_in_threadpool(store_document, case_id, data, file.filename, kind, logical_id)

def document_for(case_id, document_id, user):
    case_for(case_id, user)
    docs = db.documents(case_id, [document_id])
    if not docs:
        raise HTTPException(404, "Document not found")
    return docs[0]

@app.get("/cases/{case_id}/documents/{document_id}")
def read_document(case_id: str, document_id: str, user: User):
    document = document_for(case_id, document_id, user)
    return {**document_view(document), "pages": document["pages"]}

@app.patch("/cases/{case_id}/documents/{document_id}")
def recategorise_document(case_id: str, document_id: str, kind: Annotated[DocumentKind, Form()], user: User):
    document = document_for(case_id, document_id, user)
    with db.transaction() as connection:
        # Every version of one logical document shares its category.
        db.execute(connection, "UPDATE documents SET kind=:kind WHERE case_id=:case AND logical_id=:logical", kind=kind, case=case_id, logical=document["logical_id"])
    return {"id": document_id, "kind": kind}

@app.delete("/cases/{case_id}/documents/{document_id}")
def delete_document(case_id: str, document_id: str, user: User):
    document = document_for(case_id, document_id, user)
    if any(document_id in json.loads(run["input_ids"]) for run in db.rows("SELECT input_ids FROM analyses WHERE case_id=:case", case=case_id)):
        raise HTTPException(409, "A saved analysis used this document. Delete that analysis first, or upload a replacement version.")
    with db.transaction() as connection:
        db.execute(connection, "DELETE FROM documents WHERE id=:id", id=document_id)
    Path(document["path"]).unlink(missing_ok=True)
    return {"deleted": True}

@app.get("/cases/{case_id}/documents/{document_id}/pages/{page}")
def read_page(case_id: str, document_id: str, page: int, user: User):
    document = document_for(case_id, document_id, user)
    result = next((p for p in document["pages"] if p["page"] == page), None)
    if not result:
        raise HTTPException(404, "Page not found")
    return {"document_id": document_id, "version": document["version"], "filename": document["filename"], "kind": document["kind"], **result}

@app.get("/cases/{case_id}/documents/{document_id}/original")
def original(case_id: str, document_id: str, user: User):
    document = document_for(case_id, document_id, user)
    return FileResponse(document["path"], filename=document["filename"], media_type="application/octet-stream")

@app.get("/cases/{case_id}/timeline")
def case_timeline(case_id: str, user: User):
    case_for(case_id, user)
    return intake.timeline(db.documents(case_id))

@app.post("/cases/{case_id}/analyses", status_code=202)
def analyze(case_id: str, user: User):
    case_for(case_id, user)
    # New runs snapshot the newest version of every logical document; old reports remain immutable.
    selected = db.latest_versions(db.documents(case_id))
    if not any(d["kind"] == "insurer_communication" for d in selected):
        raise HTTPException(422, "Add the insurer's letter or query first, so the analysis knows what was asked")
    run_id = db.uid()
    with db.transaction() as connection:
        db.execute(connection, "INSERT INTO analyses VALUES (:id,:case,:owner,:thread,'queued',:inputs,NULL,NULL,:time)",
                   id=run_id, case=case_id, owner=user["owner"], thread=db.uid(), inputs=json.dumps([d["id"] for d in selected]), time=db.now())
    enqueue(run_id)
    notify(case_id)
    return run_for(run_id, user)

@app.get("/cases/{case_id}/analyses")
def list_analyses(case_id: str, user: User):
    case_for(case_id, user)
    return db.rows("SELECT * FROM analyses WHERE case_id=:case AND owner=:owner ORDER BY created_at DESC, id DESC", case=case_id, owner=user["owner"])

@app.get("/cases/{case_id}/analysis-events")
async def analysis_events(case_id: str, user: User):
    from redis.asyncio import Redis as AsyncRedis
    await run_in_threadpool(case_for, case_id, user)
    redis = AsyncRedis.from_url(settings().redis_url, socket_connect_timeout=2)
    pubsub = redis.pubsub()
    try:
        # Subscribe before taking the snapshot so completion cannot fall into a gap.
        await pubsub.subscribe("case-analyses:" + case_id)
    except Exception:
        await pubsub.aclose()
        await redis.aclose()
        raise HTTPException(503, "Live notifications unavailable; retry the connection")

    async def events():
        try:
            snapshot = await run_in_threadpool(list_analyses, case_id, user)
            yield "data: " + json.dumps(snapshot) + "\n\n"
            while True:
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=15)
                if message:
                    snapshot = await run_in_threadpool(list_analyses, case_id, user)
                    yield "data: " + json.dumps(snapshot) + "\n\n"
                else:
                    yield ": keepalive\n\n"
                await asyncio.sleep(0.05)
        finally:
            await pubsub.aclose()
            await redis.aclose()
    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

@app.delete("/analyses/{run_id}")
def delete_analysis(run_id: str, user: User):
    from filelock import FileLock, Timeout
    run = run_for(run_id, user)
    lock = settings().data_dir / "runtime" / ("analysis-" + run["id"] + ".lock")
    lock.parent.mkdir(parents=True, exist_ok=True)
    try:
        with FileLock(str(lock), timeout=0):
            with db.transaction() as connection:
                # Serialize deletion against resume and worker status transitions.
                db.execute(connection, "UPDATE analyses SET status=status WHERE id=:id", id=run_id)
                current = db.execute(connection, "SELECT status FROM analyses WHERE id=:id", id=run_id).scalar()
                if current in ACTIVE:
                    raise HTTPException(409, "Wait for the analysis to finish before deleting it")
                drop_checkpoints([run["thread_id"]])
                db.delete_run(connection, run_id)
    except Timeout:
        raise HTTPException(409, "The analysis is still finishing; try again shortly")
    notify(run["case_id"])
    return {"deleted": True}

@app.get("/analyses/{run_id}")
def analysis(run_id: str, user: User):
    return run_for(run_id, user)

@app.get("/analyses/{run_id}/workflow")
def analysis_workflow(run_id: str, user: User):
    """The analysis as it actually ran, step by step, for the workflow view."""
    run = run_for(run_id, user)
    reports = db.rows("SELECT body FROM reports WHERE run_id=:run", run=run_id)
    return trace_store.view(run, json.loads(reports[0]["body"]) if reports else None)

@app.post("/analyses/{run_id}/resume", status_code=202)
def resume(run_id: str, user: User):
    run = run_for(run_id, user)
    if run["status"] != "paused":
        raise HTTPException(409, "Only paused analyses can be resumed")
    with db.transaction() as connection:
        updated = db.execute(connection, "UPDATE analyses SET status='queued',error=NULL WHERE id=:id AND status='paused'", id=run_id)
        if updated.rowcount != 1:
            raise HTTPException(409, "Run was already resumed")
    enqueue(run_id)
    notify(run["case_id"])
    return run_for(run_id, user)

def report_body(record, user):
    body = json.loads(record["body"])
    if user["role"] != "reviewer":
        # Unverified draft wording stays with the reviewer.
        for finding in body.get("findings", []):
            finding.pop("withheld_explanation", None)
    notes = db.notes(record["id"])
    return {**body, "created_at": record["created_at"], "customer_draft": notes.get("draft"), "completed_actions": notes.get("checklist", [])}

@app.get("/reports/{report_id}")
def report(report_id: str, user: User):
    return report_body(report_for(report_id, user), user)

@app.put("/reports/{report_id}/draft")
def save_draft(report_id: str, body: DraftUpdate, user: User):
    report_for(report_id, user)
    db.save_note(report_id, "draft", body.text.strip() or None)
    return {"saved": True}

@app.put("/reports/{report_id}/checklist")
def save_checklist(report_id: str, body: ChecklistUpdate, user: User):
    report_for(report_id, user)
    db.save_note(report_id, "checklist", list(dict.fromkeys(body.completed)))
    return {"saved": True}

@app.get("/reports/{report_id}/reviews")
def report_reviews(report_id: str, user: User):
    record = report_for(report_id, user)
    return db.rows("SELECT r.*, t.request_id FROM reviews r JOIN tasks t ON t.id=r.task_id WHERE t.run_id=:run ORDER BY r.created_at", run=record["run_id"])

@app.get("/reports/{report_id}/package")
def report_package(report_id: str, user: User):
    """Response package: the letter, a readable summary, the structured report and cited originals."""
    record = report_for(report_id, user)
    body = report_body(record, {**user, "role": "customer"})
    requests = {r["request_id"]: r for r in body.get("requests", [])}
    summary = ["Claim evidence summary", "Claim reference: " + str(body.get("claim_reference", "")), "Report version: " + str(body.get("version", "")), ""]
    for index, finding in enumerate(body.get("findings", []), 1):
        summary += [str(index) + ". " + requests.get(finding["request_id"], {}).get("text", "Request"),
                    "   Evidence: " + finding["evidence_status"].replace("_", " ") + " | Submission: " + finding["submission_status"].replace("_", " ")
                    + (" | Needs review" if finding.get("review_required") else ""),
                    "   " + finding["explanation"].replace("\n", "\n   "), "   Next step: " + finding.get("next_action", ""), ""]
    summary.append("This summary reflects the documents available in the workspace. It is not an insurer decision.")
    documents = {d["id"]: d for d in db.documents(record["case_id"])}
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("response-letter.txt", body.get("customer_draft") or body.get("response_draft", ""))
        archive.writestr("evidence-summary.txt", "\n".join(summary))
        archive.writestr("report.json", json.dumps(body, indent=2))
        for index, item in enumerate(body.get("attachment_manifest", []), 1):
            document = documents.get(item["document_id"])
            if document and Path(document["path"]).is_file():
                archive.write(document["path"], "attachments/" + str(index).zfill(2) + "-v" + str(document["version"]) + "-" + document["filename"])
    return Response(buffer.getvalue(), media_type="application/zip",
                    headers={"Content-Disposition": 'attachment; filename="claim-response-package-v' + str(body.get("version", 1)) + '.zip"'})

@app.get("/review-queue")
def review_queue(user: User):
    reviewer(user)
    reports = db.rows("SELECT r.id, r.run_id, r.case_id, r.body, r.created_at, c.title, c.claim_reference FROM reports r JOIN cases c ON c.id=r.case_id WHERE c.owner=:owner ORDER BY r.created_at DESC", owner=user["owner"])
    decisions = {}
    for review in db.rows("SELECT * FROM reviews ORDER BY created_at"):
        decisions.setdefault(review["task_id"], []).append(review)
    newest, items = {}, []
    for record in reports:
        newest.setdefault(record["case_id"], record["id"])
        body = json.loads(record["body"])
        requests = {r["request_id"]: r for r in body.get("requests", [])}
        for finding in body.get("findings", []):
            if not finding.get("review_required"):
                continue
            task_id = record["run_id"] + ":" + finding["request_id"]
            history = decisions.get(task_id, [])
            items.append({"task_id": task_id, "report_id": record["id"], "report_version": body.get("version"), "case_id": record["case_id"],
                          "case_title": record["title"], "claim_reference": record["claim_reference"], "created_at": record["created_at"],
                          "current": newest[record["case_id"]] == record["id"], "request": requests.get(finding["request_id"], {}).get("text", ""),
                          "finding": finding, "decisions": history})
    return items

@app.post("/tasks/{task_id}/review", status_code=201)
def review_task(task_id: str, body: Review, user: User):
    reviewer(user)
    tasks = db.rows("SELECT * FROM tasks WHERE id=:id", id=task_id)
    if not tasks:
        raise HTTPException(404, "Task not found")
    run_for(tasks[0]["run_id"], user)
    review_id = db.uid()
    with db.transaction() as connection:
        db.execute(connection, "INSERT INTO reviews VALUES (:id,:task,:reviewer,:decision,:rationale,:time)",
                   id=review_id, task=task_id, reviewer=body.reviewer_name.strip(), decision=body.decision, rationale=body.rationale, time=db.now())
    return db.rows("SELECT * FROM reviews WHERE id=:id", id=review_id)[0]

@app.get("/tasks/{task_id}/reviews")
def task_reviews(task_id: str, user: User):
    tasks = db.rows("SELECT * FROM tasks WHERE id=:id", id=task_id)
    if not tasks:
        raise HTTPException(404, "Task not found")
    run_for(tasks[0]["run_id"], user)
    return db.rows("SELECT * FROM reviews WHERE task_id=:id ORDER BY created_at", id=task_id)

def scenario_for(key):
    scenario = next((item for item in intake.scenarios(settings().fixtures_dir) if item["key"] == key), None)
    if not scenario:
        raise HTTPException(404, "Sample not found")
    return scenario

@app.get("/samples")
def list_samples(user: User):
    return [intake.public_scenario(item) for item in intake.scenarios(settings().fixtures_dir)]

@app.post("/samples/{key}", status_code=201)
def create_sample(key: str, user: User):
    """Create a case from synthetic walkthrough documents so the workspace can be explored safely."""
    scenario = scenario_for(key)
    case = create_case(CaseCreate(title=scenario["title"], claim_reference=scenario["claim_reference"]), user)
    for document in scenario["documents"]:
        store_document(case["id"], (scenario["directory"] / document["file"]).read_bytes(), document["file"], document["kind"])
    return case_views(user, case["id"])[0]

@app.post("/cases/{case_id}/sample-follow-up", status_code=201)
def add_sample_follow_up(case_id: str, user: User):
    case = case_for(case_id, user)
    scenario = sample_keys().get(case["claim_reference"])
    if not scenario or not scenario.get("follow_up"):
        raise HTTPException(404, "This case has no sample follow-up documents")
    existing = db.documents(case_id)
    hashes = {d["sha256"] for d in existing}
    added = 0
    for document in scenario["follow_up"]["documents"]:
        data = (scenario["directory"] / document["file"]).read_bytes()
        if hashlib.sha256(data).hexdigest() in hashes:
            continue
        replaced = next((d["logical_id"] for d in existing if d["filename"] == document.get("replaces")), None)
        store_document(case_id, data, document["file"], document["kind"], replaced)
        added += 1
    return {"added": added}

@app.get("/auth/chatgpt/status")
def chatgpt_status(user: User):
    return ChatGPTConnection().status()

@app.post("/auth/chatgpt/start")
def chatgpt_start(user: User):
    try:
        return ChatGPTConnection().start()
    except ModelPaused as error:
        raise HTTPException(503, str(error)) from error
    except Exception as error:
        logger.error("chatgpt_signin_start_failed", exc_info=True)
        raise HTTPException(503, "ChatGPT sign-in could not start; inspect local logs") from error

@app.get("/auth/chatgpt/browser")
def chatgpt_browser(ticket: str):
    try:
        url, binding = ChatGPTConnection().browser(ticket)
    except ModelPaused as error:
        raise HTTPException(400, str(error)) from error
    response = RedirectResponse(url, status_code=303)
    response.set_cookie("cea_chatgpt_binding", binding, httponly=True, samesite="lax", max_age=600, path="/auth/chatgpt")
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response

@app.get("/auth/chatgpt/callback")
def chatgpt_callback(state: str = "", code: str | None = None, client_id: str | None = None,
                     error: str | None = None, cea_chatgpt_binding: Annotated[str | None, Cookie()] = None):
    from html import escape
    status = 200
    try:
        ChatGPTConnection().finish(state, cea_chatgpt_binding, code, client_id, error)
        message = "ChatGPT is connected. Close this tab and return to the claim workspace."
        logger.info("chatgpt_signin_completed")
    except ModelPaused as failure:
        status, message = 400, str(failure)
        logger.warning("chatgpt_signin_incomplete")
    except Exception:
        status, message = 400, "ChatGPT identity validation or connection failed. Close this tab and start sign-in again."
        logger.error("chatgpt_signin_failed", exc_info=True)
    response = HTMLResponse("<!doctype html><html lang='en'><meta charset='utf-8'><title>ChatGPT connection</title><h1>ChatGPT connection</h1><p>" + escape(message) + "</p></html>", status_code=status)
    response.delete_cookie("cea_chatgpt_binding", path="/auth/chatgpt")
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'"
    return response

@app.get("/auth/chatgpt/models")
def chatgpt_models(user: User):
    try:
        return ChatGPTConnection().models()
    except ModelPaused as error:
        raise HTTPException(503, str(error)) from error
    except Exception as error:
        logger.error("chatgpt_catalog_failed", exc_info=True)
        raise HTTPException(503, "ChatGPT model catalog unavailable; retry or reconnect") from error

@app.post("/auth/chatgpt/disconnect")
def chatgpt_disconnect(user: User):
    try:
        return ChatGPTConnection().disconnect()
    except ModelPaused as error:
        raise HTTPException(503, str(error)) from error
