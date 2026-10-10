import logging
from redis import Redis
from .config import settings

def notify_case(case_id):
    # SQLite remains the source of truth; messages only tell connected UIs to refresh.
    try:
        with Redis.from_url(settings().redis_url, socket_connect_timeout=2, socket_timeout=2) as redis:
            redis.publish("case-analyses:" + case_id, "changed")
    except Exception:
        logging.getLogger(__name__).warning("analysis_notification_unavailable")
