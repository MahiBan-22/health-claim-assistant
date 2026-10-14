"""Queue transport. SQLite stays the source of truth; Redis only carries work."""
import logging
from redis import Redis
from rq import Queue
from . import db
from .config import settings

logger = logging.getLogger(__name__)
QUEUE = "claims"

def connection():
    return Redis.from_url(settings().redis_url, socket_connect_timeout=3, socket_keepalive=True)

def enqueue(run_id):
    config = settings()
    if config.job_backend == "postgres":
        # The analyses row is the durable queue. Cron advances one checkpointed node.
        return
    try:
        Queue(QUEUE, connection=connection()).enqueue("app.workflow.process_run", run_id, job_timeout=config.job_timeout_seconds + 30)
    except Exception:
        logger.error("analysis_enqueue_failed run_id=%s", run_id, exc_info=True)
        with db.transaction() as transaction:
            db.execute(transaction, "UPDATE analyses SET status='paused',error='The analysis queue is unavailable. Start Redis, then resume this analysis.' WHERE id=:id", id=run_id)

def worker_running():
    """A live worker holds data/runtime/worker.lock; the OS frees it the moment that process ends.

    Redis registrations are not used here: a worker stopped mid-analysis stays registered for minutes.
    """
    from filelock import FileLock, Timeout
    path = settings().data_dir.resolve() / "runtime" / "worker.lock"
    if not path.exists():
        return False
    lock = FileLock(str(path))
    try:
        lock.acquire(timeout=0)
    except Timeout:
        return True
    lock.release()
    return False

def queue_status():
    if settings().job_backend == "postgres":
        count = db.rows("SELECT COUNT(*) AS count FROM analyses WHERE status IN ('queued','running')")[0]["count"]
        return {"redis": False, "workers": 0, "queued": count, "backend": "postgres", "scheduler": "vercel_cron"}
    workers = 1 if worker_running() else 0
    try:
        redis = connection()
        redis.ping()
        return {"redis": True, "workers": workers, "queued": Queue(QUEUE, connection=redis).count}
    except Exception:
        return {"redis": False, "workers": workers, "queued": 0}

def recover_interrupted_runs():
    """Re-queue work a stopped worker left behind. process_run is idempotent per run.

    Only the process holding the worker lock calls this, so a run marked running has no live owner.
    """
    queue = Queue(QUEUE, connection=connection())
    pending = {job.args[0] for job in queue.get_jobs() if job.args}
    with db.transaction() as transaction:
        db.execute(transaction, "UPDATE analyses SET status='queued',error=NULL WHERE status='running'")
    unfinished = [run["id"] for run in db.rows("SELECT id FROM analyses WHERE status='queued' ORDER BY created_at")]
    for run_id in unfinished:
        if run_id not in pending:
            queue.enqueue("app.workflow.process_run", run_id, job_timeout=settings().job_timeout_seconds + 30)
    if unfinished:
        logger.info("analysis_recovered count=%d", len(unfinished))
    return len(unfinished)

def advance_pending():
    from .workflow import process_run
    for run in db.rows("SELECT id FROM analyses WHERE status IN ('queued','running') ORDER BY created_at, id LIMIT 20"):
        if process_run(run["id"]):
            return {"advanced": run["id"]}
    return {"advanced": None}
