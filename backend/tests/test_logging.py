import asyncio
import logging
import pytest
from app.config import Settings
from app.logging_setup import configure_logging, RequestLoggingMiddleware

def test_rotation_and_reconfiguration(tmp_path):
    config = Settings(log_dir=tmp_path / "logs", log_max_bytes=150, log_backup_count=2)
    logger = configure_logging("api", config)
    for _ in range(8):
        logger.info("test event with enough text to rotate the log file")
    assert (config.log_dir / "api.log").exists()
    assert (config.log_dir / "api.log.1").exists()
    logger = configure_logging("api", config)
    logger.info("unique_marker")
    assert (config.log_dir / "api.log").read_text().count("unique_marker") == 1

def test_exception_message_is_excluded(tmp_path):
    logger = configure_logging("api", Settings(log_dir=tmp_path))
    try:
        raise ValueError("SECRET_TOKEN_AND_PATIENT_CONTENT")
    except ValueError:
        logger.error("operation_failed", exc_info=True)
    text = (tmp_path / "api.log").read_text()
    assert "ValueError" in text
    assert "operation_failed" in text
    assert "SECRET_TOKEN_AND_PATIENT_CONTENT" not in text

def test_request_logs_exclude_untrusted_paths_queries_and_headers(tmp_path):
    configure_logging("api", Settings(log_dir=tmp_path))
    async def endpoint(scope, receive, send):
        await send({"type": "http.response.start", "status": 401, "headers": []})
        await send({"type": "http.response.body", "body": b""})
    async def receive():
        return {"type": "http.request", "body": b"PATIENT_BODY"}
    async def send(message):
        pass
    scope = {"type": "http", "method": "GET", "path": "/PATIENT_PATH",
             "query_string": b"token=SECRET_QUERY", "headers": [(b"authorization", b"Bearer SECRET_HEADER")]}
    asyncio.run(RequestLoggingMiddleware(endpoint)(scope, receive, send))
    text = (tmp_path / "api.log").read_text()
    assert "status=401" in text and "duration_ms=" in text
    for secret in ("PATIENT_PATH", "SECRET_QUERY", "SECRET_HEADER", "PATIENT_BODY"):
        assert secret not in text
