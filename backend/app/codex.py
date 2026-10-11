"""Model access through the Codex CLI signed in on this host.

The CLI keeps and refreshes its own sign-in; nothing here opens its credential files.
Each answer is one `codex exec` run with the CLI's tools switched off, no saved session
and an empty working directory, so a document cannot make it run a command or read a file.
"""
import json
import logging
import os
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from .config import settings
from .errors import ModelPaused

logger = logging.getLogger(__name__)
# Switched off wherever this CLI version knows the name; it rejects a name it does not know.
TOOL_FEATURES = ("shell_tool", "unified_exec", "code_mode_host", "apps", "plugins", "remote_plugin", "multi_agent",
                 "image_generation", "browser_use", "browser_use_external", "in_app_browser", "computer_use",
                 "view_image", "hooks", "goals", "memories", "sleep_tool", "skill_search", "tool_suggest",
                 "workspace_dependencies")
REQUIRED_OFF = {"shell_tool"}
# What a run without tools can emit. Any other item means the model acted instead of answering.
PLAIN_ITEMS = {"agent_message", "reasoning", "error", "todo_list"}
# A key in the environment would take the place of the signed-in account.
WITHHELD = {"CODEX_API_KEY", "OPENAI_API_KEY"}
SIGNED_OUT = "The AI engine is signed out on the server. An administrator needs to run codex login there."
_cache: dict = {}
_cache_lock = threading.Lock()

class Transient(Exception):
    """The run failed before an answer was accepted; safe to repeat."""

def _cached(key, seconds, load):
    with _cache_lock:
        held = _cache.get(key)
        if held and held[0] > time.monotonic():
            return held[1]
    value = load()
    with _cache_lock:
        _cache[key] = (time.monotonic() + seconds, value)
    return value

def _stop(process):
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(process.pid)], capture_output=True, timeout=15)
        else:
            os.killpg(process.pid, signal.SIGKILL)
    except (OSError, subprocess.SubprocessError):
        process.kill()
    try:
        process.communicate(timeout=10)
    except (OSError, ValueError, subprocess.SubprocessError):
        pass

def _run(arguments, timeout, text=""):
    """Exit code, output and error text of one CLI run. A run that overstays is stopped with anything it started."""
    path = shutil.which(settings().codex_path)
    if not path:
        raise ModelPaused("The Codex CLI is not installed on the server, or CODEX_PATH does not point to it.")
    environment = {name: value for name, value in os.environ.items() if name.upper() not in WITHHELD}
    try:
        process = subprocess.Popen([path, *arguments], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   env=environment, **({} if os.name == "nt" else {"process_group": 0}))
    except OSError as error:
        raise ModelPaused("The Codex CLI on the server could not be started.") from error
    try:
        out, err = process.communicate(text.encode("utf-8"), timeout=timeout)
    except BaseException:
        _stop(process)
        raise
    return process.returncode, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")

def _probe(arguments):
    try:
        return _run(arguments, 60)
    except subprocess.TimeoutExpired as error:
        raise ModelPaused("The Codex CLI on the server did not respond.") from error

def _features():
    def load():
        code, out, _ = _probe(["features", "list"])
        names = {line.split()[0] for line in out.splitlines() if line.strip()}
        if code != 0 or not REQUIRED_OFF <= names:
            raise ModelPaused("This version of the Codex CLI cannot run with its tools switched off. Update it on the server.")
        return names
    return _cached("features", 3600, load)

def _catalog():
    """Model names the CLI lists for its account, or None when this version cannot say."""
    code, out, _ = _probe(["debug", "models"])
    try:
        return {entry["slug"] for entry in json.loads(out)["models"]} if code == 0 else None
    except (ValueError, KeyError, TypeError):
        return None

def status():
    """Whether analyses can run, in words that are safe to show any visitor."""
    model = settings().llm_model
    try:
        _features()
        if not _cached("login", 30, lambda: _probe(["login", "status"])[0] == 0):
            raise ModelPaused(SIGNED_OUT)
        listed = _cached("models", 600, _catalog)
    except ModelPaused as error:
        return {"connected": False, "model_available": False, "model": model, "message": str(error)}
    available = listed is None or model in listed
    return {"connected": True, "model_available": available, "model": model,
            "message": "The AI engine is connected and " + model + " is available." if available else
                       "The server's Codex account does not list " + model + ". Analyses are paused; no other model is used."}

def _failure(code, events, err):
    """Why a run produced no answer, without passing the CLI's own wording to the interface."""
    detail = " ".join(str(event.get("message") or (event.get("error") or {}).get("message") or "")
                      for event in events if event.get("type") in {"turn.failed", "error"}).strip() or err.strip()
    logger.warning("codex_run_failed exit=%s detail=%s", code, detail[:300])
    lowered = detail.lower()
    if "not supported when using codex" in lowered or "model_not_found" in lowered:
        return ModelPaused("Requested model is unavailable to the server's Codex account: " + settings().llm_model)
    if "usage limit" in lowered or "usage_limit" in lowered:
        return ModelPaused("The AI engine has reached its usage limit for now. Resume later.")
    if "not logged in" in lowered or "401" in lowered or "unauthorized" in lowered or "codex login" in lowered:
        with _cache_lock:
            _cache.pop("login", None)
        return ModelPaused(SIGNED_OUT)
    if "unexpected argument" in lowered or "usage: codex" in lowered:
        return ModelPaused("This version of the Codex CLI does not accept the options this application uses. Update it on the server.")
    return Transient("The model connection dropped; resume to continue")

def answer(prompt, image=None, suffix=".jpg"):
    """The model's answer to one prompt, with the token usage the CLI reported."""
    config = settings()
    known = _features()
    with tempfile.TemporaryDirectory(prefix="claim-codex-", ignore_cleanup_errors=True) as work:
        arguments = ["exec"]
        if image is not None:
            picture = Path(work) / ("page" + suffix)
            picture.write_bytes(image)
            arguments += ["--image", str(picture)]
        # No prompt argument: the CLI then reads it from standard input, so claim text never appears in a process list.
        arguments += ["--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
                      "--color", "never", "--sandbox", "read-only", "--model", config.llm_model, "--cd", work,
                      "-c", "web_search=disabled", "-c", "project_doc_max_bytes=0"]
        for name in TOOL_FEATURES:
            if name in known:
                arguments += ["--disable", name]
        try:
            code, out, err = _run(arguments, config.model_timeout_seconds, prompt)
        except subprocess.TimeoutExpired as error:
            raise ModelPaused("Inference time budget exhausted") from error
    events = []
    for line in out.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict):
            events.append(event)
    kinds = [event.get("type") for event in events]
    if code != 0 or "turn.failed" in kinds:
        raise _failure(code, events, err)
    if "turn.completed" not in kinds:
        raise ModelPaused("Interrupted inference stream; no finding committed")
    items = [event["item"] for event in events if isinstance(event.get("item"), dict)]
    acted = {str(item.get("type")) for item in items} - PLAIN_ITEMS
    if acted:
        logger.warning("codex_tool_use_refused kinds=%s", ",".join(sorted(acted)))
        raise ModelPaused("The model tried to act instead of answering, so nothing from that attempt was kept. Resume to try again.")
    messages = [item.get("text") for item in items if item.get("type") == "agent_message" and isinstance(item.get("text"), str)]
    if not messages:
        raise ModelPaused("Interrupted inference stream; no finding committed")
    usage = next(event.get("usage") for event in events if event.get("type") == "turn.completed")
    return messages[-1], usage if isinstance(usage, dict) else {}
