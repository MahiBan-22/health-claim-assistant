"""Non-medical diagnostic for native RQ execution and the worker's access to the Codex CLI."""
import platform
import time
from redis import Redis
from rq import Queue
from . import codex
from .config import settings

def worker_probe():
    return {"platform": platform.system(), "model_access": codex.status()["message"],
            "data_dir": str(settings().data_dir.resolve())}

if __name__ == "__main__":
    queue = Queue("claims", connection=Redis.from_url(settings().redis_url))
    job = queue.enqueue("app.runtime_probe.worker_probe", job_timeout=30, result_ttl=60)
    for _ in range(60):
        status = job.get_status(refresh=True)
        if status.value == "finished":
            print(job.return_value())
            break
        if status.value in {"failed", "stopped", "canceled"}:
            raise RuntimeError("Native worker diagnostic failed; inspect worker console logs")
        time.sleep(0.5)
    else:
        raise RuntimeError("Native worker diagnostic timed out")
