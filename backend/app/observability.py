"""Metadata-only tracing. No prompts, document text, tokens or identities are captured."""
import contextvars
import functools
import json
import logging
import math
import re
import threading
import time
from contextlib import contextmanager
from logging.handlers import RotatingFileHandler
from uuid import uuid4

_sdk = None
_config = None
_service = "uninitialized"
_workflow_name = "claim-evidence-assistant"
_stop = None
_monitor = None
_current = contextvars.ContextVar("claim_trace", default=None)
_recorder = None
_local = logging.getLogger("claim.telemetry")
_local.propagate = False
_local.setLevel(logging.INFO)
logger = logging.getLogger(__name__)

# Only application-owned values and SDK routing fields survive the export boundary.
NUMBERS = {
    "claim.duration_ms", "claim.document_count", "claim.page_count", "claim.result_count",
    "claim.input_chars", "claim.output_chars", "claim.request_index", "claim.correction_count",
    "claim.unresolved_count", "claim.source_error_count", "claim.http_status",
    "neatlogs.llm.token_count.prompt", "neatlogs.llm.token_count.completion",
    "neatlogs.llm.token_count.total", "neatlogs.llm.token_count.reasoning",
    "neatlogs.llm.token_count.cache_read", "claim.ttft_ms", "claim.chunk_count",
}
ENUMS = {
    "claim.synthetic": {True, False},
    "claim.outcome": {"success", "error", "queued", "running", "paused", "completed", "empty", "unreadable"},
    "claim.analysis_status": {"queued", "running", "paused", "completed"},
    "claim.service": {"api", "worker", "diagnostic"},
    "claim.stream_state": {"started", "completed", "interrupted"},
    "claim.correction_reason": {"citation", "targeted_search", "unsupported_statements"},
    "claim.role": {"request planner", "Evidence Agent", "Policy Agent", "Verifier Agent", "Document Reader"},
    "claim.http_method": {"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
    "neatlogs.llm.provider": {"openai"},
    "neatlogs.llm.model_name": {"gpt-6-luna"},
    "neatlogs.llm.is_streaming": {True, False},
    "neatlogs.guardrail.passed": {True, False},
    "neatlogs.trace.complete": {True, False}, "neatlogs.internal": {True, False},
    "neatlogs.auto_root": {True, False},
}
NAMES = {"claim.analysis", "claim.graph", "claim.model", "claim.catalog", "claim.extraction",
         "claim.request", "claim.package", "claim.diagnostic", "plan", "evidence", "policy",
         "verify", "package", "LangGraph", "RunnableSequence", "ChannelWrite", "ChannelRead",
         "list_documents", "search", "read_page", "find_receipts", "validate_source_refs", "check_identifiers",
         "neatlogs.trace.complete"}
KINDS = {"workflow", "agent", "chain", "tool", "retriever", "guardrail", "llm", "task", "Neatlogs.INTERNAL"}

def safe_attributes(attrs):
    safe = {}
    for key, value in (attrs or {}).items():
        if key in NUMBERS and type(value) in {int, float} and math.isfinite(value) and value >= 0:
            safe[key] = value
        elif key in ENUMS and isinstance(value, (str, bool)) and value in ENUMS[key]:
            safe[key] = value
        elif key == "claim.run_id" and isinstance(value, str) and re.fullmatch(r"[0-9a-f-]{36}", value):
            safe[key] = value
        elif key == "claim.error_type" and isinstance(value, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,70}", value):
            safe[key] = value
        elif key == "claim.route" and isinstance(value, str) and re.fullmatch(r"/[a-z/{}_.-]+", value):
            safe[key] = value
        elif key in {"neatlogs.span.kind", "openinference.span.kind"} and isinstance(value, str) and value.lower() in {k.lower() for k in KINDS}:
            safe[key] = value
        elif key == "neatlogs.tool.name" and value in NAMES:
            safe[key] = value
        elif key == "claim.source_versions" and isinstance(value, str):
            try:
                refs = json.loads(value)
                if isinstance(refs, list) and len(refs) <= 100 and all(isinstance(r, dict) and set(r) == {"document_id", "version"} and re.fullmatch(r"[0-9a-f-]{36}", str(r["document_id"])) and type(r["version"]) is int and r["version"] > 0 for r in refs):
                    safe[key] = value
            except (ValueError, TypeError):
                pass
        elif key == "claim.code_version" and isinstance(value,str) and re.fullmatch(r"dev|[0-9a-f]{7,40}",value):
            safe[key] = value
        elif key == "claim.prompt_version" and value == "1":
            safe[key] = value
        elif key == "claim.instrumentation_version" and value == "1":
            safe[key] = value
    return safe

def mask(item, *, context=None):
    """SDK final export snapshot; fail closed on unexpected shapes."""
    if not isinstance(item, dict) or not isinstance(item.get("attributes"), dict):
        raise ValueError("Unexpected telemetry snapshot")
    item["attributes"] = safe_attributes(item["attributes"])
    item["name"] = item.get("name") if item.get("name") in NAMES else "claim.operation"
    item["events"] = []
    item["links"] = []
    item["resource"] = {"attributes": {
        "service.name": "claim-evidence-assistant",
        "neatlogs.workflow.name": _workflow_name,
        "telemetry.sdk.language": "python",
    }}
    status = item.get("status") or {}
    item["status"] = {"code": status.get("code") if status.get("code") in {"UNSET", "OK", "ERROR"} else "UNSET", "description": None}
    item.pop("body", None)
    return {key: value for key, value in item.items() if key in {"signal", "name", "attributes", "events", "links", "resource", "status"}}

def set_recorder(recorder):
    """Register a callable(phase, info) that receives each step at its start and end."""
    global _recorder
    _recorder = recorder

def _record(phase, name, kind, active, parent, started, duration=None):
    if _recorder is None:
        return
    try:
        _recorder(phase, {"name": name, "kind": kind, "trace_id": active.trace_id, "span_id": active.span_id,
                          "parent_span_id": parent.span_id if parent else None, "attributes": dict(active.attributes),
                          "started": started, "duration_ms": duration})
    except Exception:
        degraded("step_record_failed")

def degraded(reason):
    logger.warning("telemetry_degraded reason=%s", reason)
    _local.info(json.dumps({"event": "telemetry_degraded", "reason": reason, "service": _service, "time": time.time()}))

class SDKFailureHandler(logging.Handler):
    def emit(self, record):
        # Never forward exporter response bodies, exception messages or credentials.
        if record.levelno >= logging.WARNING:
            degraded("sdk_warning")

def initialize(service, config):
    global _sdk, _config, _service, _stop, _monitor, _workflow_name
    if _config is not None:
        return
    _config, _service = config, service
    _workflow_name = config.neatlogs_workflow_name
    try:
        directory = config.log_dir.resolve()
        directory.mkdir(parents=True, exist_ok=True)
        for handler in list(_local.handlers):
            _local.removeHandler(handler)
            handler.close()
        handler = RotatingFileHandler(directory / ("telemetry-" + service + ".jsonl"), maxBytes=config.log_max_bytes, backupCount=config.log_backup_count, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(message)s"))
        _local.addHandler(handler)
        if not config.neatlogs_enabled or not config.neatlogs_api_key.get_secret_value():
            logger.info("telemetry_local_only")
            return
        import neatlogs
        sdk_logger = logging.getLogger("neatlogs")
        sdk_logger.handlers = [SDKFailureHandler()]
        sdk_logger.propagate = False
        sdk_logger.setLevel(logging.WARNING)
        neatlogs.init(api_key=config.neatlogs_api_key.get_secret_value(), endpoint=config.neatlogs_endpoint,
                      workflow_name=config.neatlogs_workflow_name, mask=mask, capture_logs=False,
                      instrumentations=[], sample_rate=config.neatlogs_sample_rate,
                      register_shutdown_handlers=False, uploads_enabled=False)
        _sdk = neatlogs
        _stop = threading.Event()
        _monitor = threading.Thread(target=_monitor_delivery, daemon=True, name="claim-telemetry-health")
        _monitor.start()
        logger.info("telemetry_initialized service=%s", service)
    except Exception:
        _sdk = None
        degraded("initialization_failed")

def _monitor_delivery():
    previous = {}
    while not _stop.wait(5):
        try:
            current = _sdk.get_delivery_diagnostics()
            for key, value in current.items():
                if any(word in key for word in ("failures", "drops")) and type(value) is int and value > previous.get(key, 0):
                    degraded("export_or_queue_loss")
            previous = current
        except Exception:
            degraded("diagnostics_unavailable")

def shutdown():
    global _sdk, _config, _stop, _monitor
    if _stop is not None:
        _stop.set()
    if _monitor is not None:
        _monitor.join(timeout=1)
    if _sdk is not None:
        try:
            if not _sdk.flush(timeout_millis=_config.neatlogs_shutdown_timeout_ms):
                degraded("flush_incomplete")
            if _sdk.shutdown(timeout_millis=_config.neatlogs_shutdown_timeout_ms) is False:
                degraded("shutdown_incomplete")
        except Exception:
            degraded("shutdown_failed")
    _sdk = _config = _stop = _monitor = None
    for handler in list(_local.handlers):
        _local.removeHandler(handler)
        handler.close()

class Span:
    def __init__(self, remote, trace_id, span_id, attrs):
        self.remote, self.trace_id, self.span_id, self.attributes = remote, trace_id, span_id, safe_attributes(attrs)
    def set_attribute(self, key, value):
        safe = safe_attributes({key: value})
        self.attributes.update(safe)
        if self.remote is not None:
            try:
                for k, v in safe.items(): self.remote.set_attribute(k, v)
            except Exception:
                degraded("attribute_failed")
    def error(self, error_type):
        self.set_attribute("claim.outcome", "error")
        self.set_attribute("claim.error_type", error_type)
        if self.remote is not None:
            try:
                from opentelemetry.trace import Status, StatusCode
                self.remote.set_status(Status(StatusCode.ERROR))
            except Exception:
                degraded("status_failed")

@contextmanager
def span(name, kind="TOOL", **attributes):
    parent = _current.get()
    manager = remote = None
    trace_id = parent.trace_id if parent else uuid4().hex
    span_id = uuid4().hex[:16]
    attrs = {**({k: v for k, v in parent.attributes.items() if k in {"claim.run_id", "claim.instrumentation_version", "claim.synthetic"}} if parent else {}), "claim.service": _service, "claim.code_version": _config.app_version if _config else "dev", "claim.prompt_version":"1", **attributes}
    if _sdk is not None:
        try:
            manager = _sdk.trace(name, kind=kind)
            remote = manager.__enter__()
            context = remote.get_span_context()
            trace_id, span_id = f"{context.trace_id:032x}", f"{context.span_id:016x}"
        except Exception:
            manager = remote = None
            degraded("span_start_failed")
    active = Span(remote, trace_id, span_id, attrs)
    for k, v in active.attributes.copy().items(): active.set_attribute(k, v)
    token = _current.set(active)
    started = time.monotonic()
    started_at = time.time()
    _record("start", name, kind, active, parent, started_at)
    try:
        yield active
    except BaseException as error:
        active.error(type(error).__name__)
        raise
    finally:
        active.set_attribute("claim.duration_ms", (time.monotonic() - started) * 1000)
        if "claim.outcome" not in active.attributes: active.set_attribute("claim.outcome", "success")
        _current.reset(token)
        if manager is not None:
            try:
                manager.__exit__(None, None, None)
            except Exception:
                degraded("span_end_failed")
        _record("end", name, kind, active, parent, started_at, active.attributes.get("claim.duration_ms"))
        _local.info(json.dumps({"event": "span", "time": time.time(), "name": name, "kind": kind,
                               "trace_id": trace_id, "span_id": span_id,
                               "parent_span_id": parent.span_id if parent else None, "attributes": active.attributes}))

def traced(name, kind="TOOL"):
    def decorate(function):
        @functools.wraps(function)
        def invoke(*args, **kwargs):
            with span(name, kind) as active:
                result = function(*args, **kwargs)
                if name == "claim.extraction":
                    active.set_attribute("claim.page_count", len(result[0]))
                    active.set_attribute("claim.outcome", "unreadable" if result[1] == "unreadable" else "success")
                elif isinstance(result, list):
                    active.set_attribute("claim.result_count", len(result))
                    if name in {"validate_source_refs", "check_identifiers"}: active.set_attribute("neatlogs.guardrail.passed", not result)
                return result
        return invoke
    return decorate

def exporting():
    """True when the SDK is initialised in this process and spans are being exported."""
    return _sdk is not None

def graph_callbacks():
    if _sdk is None:
        return []
    try:
        return [_sdk.langchain_handler()]
    except Exception:
        degraded("graph_callbacks_unavailable")
        return []


def current_span():
    return _current.get()


def worker_telemetry(function):
    @functools.wraps(function)
    def invoke(*args, **kwargs):
        owns_lifecycle = _config is None
        if owns_lifecycle:
            from .config import settings
            from .logging_setup import configure_logging
            configure_logging("worker", settings())
            initialize("worker", settings())
        try:
            return function(*args, **kwargs)
        finally:
            if owns_lifecycle: shutdown()
    return invoke
