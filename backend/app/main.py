import asyncio
import sqlite3
import hashlib
import hmac
import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal
from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile, Cookie
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from redis import Redis
from rq import Queue
from . import db
from .config import settings
from .extraction import extract
from .schemas import CaseCreate, Review
from .logging_setup import configure_logging, RequestLoggingMiddleware
from .chatgpt_auth import ChatGPTConnection
from .errors import ModelPaused

logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(app):
    configure_logging("api", settings())
    logging.getLogger("uvicorn.access").disabled = True  # OAuth codes/tickets must not enter raw access logs.
    logger.info("api_started")
    yield
    logger.info("api_stopped")

app = FastAPI(title="Health Claim Evidence Assistant", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=settings().cors_origins,
                   allow_methods=["GET", "POST", "DELETE"], allow_headers=["Authorization", "Content-Type"])
app.add_middleware(RequestLoggingMiddleware)
auth = HTTPBearer(auto_error=False)

def principal(credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(auth)]):
    config = settings()
    if not config.local_access_token.get_secret_value():
        raise HTTPException(503, "Configure LOCAL_ACCESS_TOKEN before accessing cases")
    token = credentials.credentials if credentials else ""
    if config.reviewer_access_token.get_secret_value() and hmac.compare_digest(token, config.reviewer_access_token.get_secret_value()):
        return {"owner": "local", "role": "reviewer", "id": "local-reviewer"}
    if hmac.compare_digest(token, config.local_access_token.get_secret_value()):
        return {"owner": "local", "role": "customer", "id": "local-customer"}
    raise HTTPException(401, "Invalid local access token")

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

def enqueue(run_id):
    config = settings()
    try:
        queue = Queue("claims", connection=Redis.from_url(config.redis_url))
        queue.enqueue("app.workflow.process_run", run_id, job_timeout=config.job_timeout_seconds + 30)
    except Exception:
        logger.error("analysis_enqueue_failed run_id=%s", run_id, exc_info=True)
        with db.transaction() as connection:
            db.execute(connection, "UPDATE analyses SET status='paused',error='Queue unavailable; retry when Redis is running' WHERE id=:id", id=run_id)

@app.get("/health")
def health():
    db.engine()
    return {"status": "ok", "model": settings().llm_model, "authentication": "local bearer", "oauth_setup": "host_sign_in"}

@app.get("/cases")
def list_cases(user: User):
    return db.rows("SELECT * FROM cases WHERE owner=:owner ORDER BY created_at DESC", owner=user["owner"])

@app.post("/cases", status_code=201)
def create_case(body: CaseCreate, user: User):
    case_id = db.uid()
    with db.transaction() as connection:
        db.execute(connection, "INSERT INTO cases VALUES (:id,:owner,:title,:reference,:time)", id=case_id,
                   owner=user["owner"], title=body.title, reference=body.claim_reference, time=db.now())
    return case_for(case_id, user)

@app.get("/cases/{case_id}/documents")
def list_documents(case_id: str, user: User):
    case_for(case_id, user)
    return [{k: v for k, v in d.items() if k not in {"path", "pages"}} for d in db.documents(case_id)]

@app.post("/cases/{case_id}/documents", status_code=201)
async def upload_document(case_id: str, user: User, file: Annotated[UploadFile, File()],
                          kind: Annotated[Literal["insurer_communication", "clinical", "bill", "receipt", "policy", "schedule", "endorsement"], Form()],
                          logical_id: Annotated[str | None, Form()] = None):
    case_for(case_id, user)
    data = await file.read(settings().max_upload_bytes + 1)
    if len(data) > settings().max_upload_bytes:
        raise HTTPException(413, "Upload exceeds size limit")
    if not data:
        raise HTTPException(422, "Document is empty")
    filename = Path((file.filename or "document.txt").replace("\\", "/")).name
    try:
        # OCR is bounded; move extraction into a dedicated RQ job in the next milestone.
        from starlette.concurrency import run_in_threadpool
        pages, status = await run_in_threadpool(extract, data, filename)
    except (ValueError, UnicodeError) as error:
        raise HTTPException(422, str(error)) from error
    except Exception as error:
        raise HTTPException(422, "Document could not be extracted; supply a readable PDF or UTF-8 text file") from error
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
                if not previous or previous["kind"] != kind:
                    raise HTTPException(422, "Replacement must identify an existing document of the same kind")
                version = previous["version"] + 1
            else:
                logical_id, version = db.uid(), 1
            db.execute(connection, "INSERT INTO documents VALUES (:id,:case,:logical,:version,:kind,:filename,:hash,:path,:pages,:status,:time)",
                       id=document_id, case=case_id, logical=logical_id, version=version, kind=kind,
                       filename=filename, hash=digest, path=str(path), pages=json.dumps(pages), status=status, time=db.now())
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return {"id": document_id, "logical_id": logical_id, "version": version, "sha256": digest, "extraction_status": status}

@app.get("/cases/{case_id}/documents/{document_id}/pages/{page}")
def read_page(case_id: str, document_id: str, page: int, user: User):
    case_for(case_id, user)
    docs = db.documents(case_id, [document_id])
    if not docs:
        raise HTTPException(404, "Document not found")
    result = next((p for p in docs[0]["pages"] if p["page"] == page), None)
    if not result:
        raise HTTPException(404, "Page not found")
    return {"document_id": document_id, "version": docs[0]["version"], **result}

@app.get("/cases/{case_id}/documents/{document_id}/original")
def original(case_id: str, document_id: str, user: User):
    case_for(case_id, user)
    docs = db.documents(case_id, [document_id])
    if not docs:
        raise HTTPException(404, "Document not found")
    return FileResponse(docs[0]["path"], filename=docs[0]["filename"], media_type="application/octet-stream")

@app.post("/cases/{case_id}/analyses", status_code=202)
def analyze(case_id: str, user: User):
    case_for(case_id, user)
    docs = db.documents(case_id)
    # New runs snapshot the newest version of every logical document; old reports remain immutable.
    latest = {}
    for document in docs:
        if document["logical_id"] not in latest or latest[document["logical_id"]]["version"] < document["version"]:
            latest[document["logical_id"]] = document
    selected = list(latest.values())
    if not any(d["kind"] == "insurer_communication" for d in selected):
        raise HTTPException(422, "Upload insurer correspondence first")
    run_id = db.uid()
    with db.transaction() as connection:
        db.execute(connection, "INSERT INTO analyses VALUES (:id,:case,:owner,:thread,'queued',:inputs,NULL,NULL,:time)",
                   id=run_id, case=case_id, owner=user["owner"], thread=db.uid(), inputs=json.dumps([d["id"] for d in selected]), time=db.now())
    enqueue(run_id)
    from .notifications import notify_case
    notify_case(case_id)
    return run_for(run_id, user)

@app.get("/cases/{case_id}/analyses")
def list_analyses(case_id: str, user: User):
    case_for(case_id, user)
    return db.rows("SELECT * FROM analyses WHERE case_id=:case AND owner=:owner ORDER BY created_at DESC, id DESC", case=case_id, owner=user["owner"])

@app.get("/cases/{case_id}/analysis-events")
async def analysis_events(case_id: str, user: User):
    from redis.asyncio import Redis as AsyncRedis
    from starlette.concurrency import run_in_threadpool
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
    from langgraph.checkpoint.sqlite import SqliteSaver
    run = run_for(run_id, user)
    lock = settings().data_dir / "runtime" / ("analysis-" + run["id"] + ".lock")
    lock.parent.mkdir(parents=True, exist_ok=True)
    try:
        with FileLock(str(lock), timeout=0):
            with db.transaction() as connection:
                # Serialize deletion against resume and worker status transitions.
                db.execute(connection, "UPDATE analyses SET status=status WHERE id=:id", id=run_id)
                current = db.execute(connection, "SELECT status FROM analyses WHERE id=:id", id=run_id).scalar()
                if current in {"queued", "running"}:
                    raise HTTPException(409, "Wait for the analysis to finish before deleting it")
                checkpoint = settings().data_dir / "checkpoints.sqlite"
                if checkpoint.exists():
                    with sqlite3.connect(str(checkpoint), check_same_thread=False) as checkpoint_connection:
                        SqliteSaver(checkpoint_connection).delete_thread(run["thread_id"])
                db.execute(connection, "DELETE FROM reviews WHERE task_id IN (SELECT id FROM tasks WHERE run_id=:id)", id=run_id)
                db.execute(connection, "DELETE FROM tasks WHERE run_id=:id", id=run_id)
                db.execute(connection, "DELETE FROM reports WHERE run_id=:id", id=run_id)
                db.execute(connection, "DELETE FROM analyses WHERE id=:id", id=run_id)
    except Timeout:
        raise HTTPException(409, "The analysis is still finishing; try again shortly")
    from .notifications import notify_case
    notify_case(run["case_id"])
    return {"deleted": True}

@app.get("/analyses/{run_id}")
def analysis(run_id: str, user: User):
    return run_for(run_id, user)

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
    from .notifications import notify_case
    notify_case(run["case_id"])
    return run_for(run_id, user)

@app.get("/reports/{report_id}")
def report(report_id: str, user: User):
    records = db.rows("SELECT * FROM reports WHERE id=:id", id=report_id)
    if not records:
        raise HTTPException(404, "Report not found")
    case_for(records[0]["case_id"], user)
    return json.loads(records[0]["body"])

@app.post("/tasks/{task_id}/review", status_code=201)
def review_task(task_id: str, body: Review, user: User):
    if user["role"] != "reviewer":
        raise HTTPException(403, "Reviewer access required")
    tasks = db.rows("SELECT * FROM tasks WHERE id=:id", id=task_id)
    if not tasks:
        raise HTTPException(404, "Task not found")
    run_for(tasks[0]["run_id"], user)
    review_id = db.uid()
    with db.transaction() as connection:
        db.execute(connection, "INSERT INTO reviews VALUES (:id,:task,:reviewer,:decision,:rationale,:time)",
                   id=review_id, task=task_id, reviewer=user["id"], decision=body.decision, rationale=body.rationale, time=db.now())
    return {"id": review_id, "task_id": task_id, **body.model_dump()}

@app.get("/tasks/{task_id}/reviews")
def task_reviews(task_id: str, user: User):
    tasks = db.rows("SELECT * FROM tasks WHERE id=:id", id=task_id)
    if not tasks:
        raise HTTPException(404, "Task not found")
    run_for(tasks[0]["run_id"], user)
    return db.rows("SELECT * FROM reviews WHERE task_id=:id ORDER BY created_at", id=task_id)

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
