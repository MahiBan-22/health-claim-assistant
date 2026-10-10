import os
from redis import Redis
from rq import Worker, SimpleWorker
from rq.timeouts import TimerDeathPenalty
from .config import settings
from .logging_setup import configure_logging

class WindowsWorker(SimpleWorker):
    # RQ SpawnWorker still uses Unix wait4 in this installed version.
    # A single in-process localhost worker avoids fork/spawn and signal alarms.
    death_penalty_class = TimerDeathPenalty

if __name__ == "__main__":
    configure_logging("worker", settings()).info("worker_started")
    connection = Redis.from_url(settings().redis_url)
    worker_class = WindowsWorker if os.name == "nt" else Worker
    worker_class(["claims"], connection=connection, log_job_description=False).work()
