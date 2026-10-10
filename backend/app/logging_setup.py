"""Local rotating logs; request bodies, headers and query strings are excluded."""
import logging
import time
import traceback
from logging.handlers import RotatingFileHandler
from .config import Settings

class SafeFormatter(logging.Formatter):
    converter = time.gmtime

    def formatException(self, exc_info):
        # Exception messages/source lines can contain SQL parameters or patient text.
        frames = traceback.extract_tb(exc_info[2])
        stack = "\n".join(f"  {frame.filename}:{frame.lineno} in {frame.name}" for frame in frames)
        return "Traceback (messages and source text omitted):\n" + stack + "\n" + exc_info[0].__name__

def configure_logging(service: str, config: Settings):
    directory = config.log_dir.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / (service + ".log")
    logger = logging.getLogger("app")
    logger.setLevel(config.log_level)
    logger.propagate = False
    for handler in list(logger.handlers):
        logger.removeHandler(handler)
        handler.close()
    formatter = SafeFormatter("%(asctime)sZ %(levelname)s %(name)s pid=%(process)d %(message)s", datefmt="%Y-%m-%dT%H:%M:%S")
    handler = RotatingFileHandler(destination, maxBytes=config.log_max_bytes,
                                  backupCount=config.log_backup_count, encoding="utf-8")
    handler.setFormatter(formatter)
    logger.addHandler(handler)
    console = logging.StreamHandler()
    console.setFormatter(formatter)
    logger.addHandler(console)
    return logger

class RequestLoggingMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        from .observability import span
        if scope["type"] != "http" or scope.get("path", "").startswith("/auth/") or scope.get("path", "").endswith("/analysis-events") or scope.get("path") == "/health":
            return await self.handle(scope, receive, send)
        with span("claim.request", "TASK"):
            return await self.handle(scope, receive, send)

    async def handle(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        started = time.monotonic()
        status = 500
        logger = logging.getLogger("app.http")

        async def capture(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, capture)
        except Exception:
            logger.error("request_failed", exc_info=True)
            raise
        finally:
            route = scope.get("route")
            template = getattr(route, "path", "<unmatched-or-preflight>")
            from .observability import current_span
            active = current_span()
            if active:
                active.set_attribute("claim.route", template)
                active.set_attribute("claim.http_method", scope["method"])
                active.set_attribute("claim.http_status", status)
                if status >= 500: active.error("HTTPServerError")
            logger.info("request method=%s route=%s status=%d duration_ms=%.1f",
                        scope["method"], template, status, (time.monotonic() - started) * 1000)
