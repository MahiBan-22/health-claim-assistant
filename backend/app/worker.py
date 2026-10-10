import os
import time
from rq import Worker, SimpleWorker
from rq.timeouts import TimerDeathPenalty
from .config import settings
from .jobs import QUEUE, connection, recover_interrupted_runs
from .logging_setup import configure_logging

class WindowsWorker(SimpleWorker):
    # RQ SpawnWorker still uses Unix wait4 in this installed version.
    # A single in-process localhost worker avoids fork/spawn and signal alarms.
    death_penalty_class = TimerDeathPenalty

def serve(logger, worker_class):
    """Keep one worker alive. RQ exits its loop on a Redis timeout; a claim queue must not."""
    from filelock import FileLock, Timeout
    runtime = settings().data_dir.resolve() / "runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    # The operating system releases this lock when a worker dies, unlike its Redis registration.
    primary = FileLock(str(runtime / "worker.lock"))
    try:
        primary.acquire(timeout=5)  # The API probes this lock for an instant when reporting status.
    except Timeout:
        primary = None
        logger.info("worker_secondary recovery_skipped")
    delay = 1
    while True:
        worker = None
        try:
            recovered = recover_interrupted_runs() if primary else 0
            if recovered:
                logger.info("worker_requeued_unfinished count=%d", recovered)
            # A short TTL lets the workspace notice a stopped worker within about a minute.
            worker = worker_class([QUEUE], connection=connection(), log_job_description=False, worker_ttl=60)
            worker.work()
            delay = 1
        except Exception:
            logger.error("worker_loop_failed", exc_info=True)
        # RQ records the request date for both an idle and a mid-job stop signal.
        if worker is not None and getattr(worker, "_shutdown_requested_date", None):
            return
        logger.warning("worker_restarting delay_seconds=%d", delay)
        time.sleep(delay)
        delay = min(delay * 2, 30)

if __name__ == "__main__":
    logger = configure_logging("worker", settings())
    logger.info("worker_started")
    worker_class = WindowsWorker if os.name == "nt" else Worker
    from . import observability
    if os.name == "nt": observability.initialize("worker", settings())
    # Unix RQ workhorses initialize their own SDK after fork in process_run.
    try:
        serve(logger, worker_class)
    finally:
        observability.shutdown()
