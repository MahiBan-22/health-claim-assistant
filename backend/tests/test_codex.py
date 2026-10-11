import json
import subprocess
import sys
import time
from pathlib import Path
import pytest
from app import codex
from app.config import Settings
from app.errors import ModelPaused

REAL_RUN = codex._run  # Bound before the suite's stand-in replaces it.
FEATURES = "shell_tool    stable    true\napps    stable    true\nmulti_agent    stable    true\nold_flag    removed    false\n"
CATALOG = json.dumps({"models": [{"slug": "gpt-6-luna"}, {"slug": "gpt-6-sol"}]})
USAGE = {"input_tokens": 11, "cached_input_tokens": 4, "output_tokens": 7, "reasoning_output_tokens": 2}

def stream(*events):
    return "\n".join(json.dumps(event) for event in events)

def message(text):
    return {"type": "item.completed", "item": {"id": "item_1", "type": "agent_message", "text": text}}

DONE = {"type": "turn.completed", "usage": USAGE}
# Every run of this CLI version reports this notice once its code-running host is switched off.
NOTICE = {"type": "item.completed", "item": {"id": "item_0", "type": "error", "message": "Code Mode is unavailable"}}

class Cli:
    """Stands in for the Codex CLI: records each command line and answers from a table keyed by subcommand."""
    def __init__(self):
        self.calls = []
        self.replies = {"features": (0, FEATURES, ""), "login": (0, "", "Logged in using ChatGPT"),
                        "debug": (0, CATALOG, ""), "exec": (0, stream(NOTICE, message("An answer"), DONE), "")}

    def run(self, arguments, timeout, text=""):
        call = {"arguments": arguments, "timeout": timeout, "text": text}
        if "--image" in arguments:
            call["image"] = Path(arguments[arguments.index("--image") + 1]).read_bytes()
        self.calls.append(call)
        reply = self.replies[arguments[0]]
        if isinstance(reply, Exception):
            raise reply
        return reply

    def runs(self, name="exec"):
        return [call for call in self.calls if call["arguments"][0] == name]

@pytest.fixture
def cli(monkeypatch):
    monkeypatch.setattr("app.codex.settings", lambda: Settings(model_timeout_seconds=45))
    stand_in = Cli()
    monkeypatch.setattr(codex, "_run", stand_in.run)
    return stand_in

def test_answer_runs_with_tools_off_and_nothing_saved(cli):
    text, usage = codex.answer("Claim text for the model")
    assert text == "An answer" and usage == USAGE
    run = cli.runs()[0]
    arguments = run["arguments"]
    for flag in ("--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check"):
        assert flag in arguments
    assert arguments[arguments.index("--sandbox") + 1] == "read-only"
    assert arguments[arguments.index("--model") + 1] == "gpt-6-luna"
    assert "web_search=disabled" in arguments
    # Only names this CLI version knows are passed: it rejects any other.
    assert [arguments[i + 1] for i, value in enumerate(arguments) if value == "--disable"] == ["shell_tool", "apps", "multi_agent"]
    # The prompt goes in on standard input, never on the command line.
    assert run["text"] == "Claim text for the model" and not any("Claim text" in value for value in arguments)
    assert run["timeout"] == 45
    assert not Path(arguments[arguments.index("--cd") + 1]).exists()

def test_cli_that_cannot_switch_tools_off_is_refused(cli):
    cli.replies["features"] = (0, "apps    stable    true\n", "")
    with pytest.raises(ModelPaused, match="tools switched off"):
        codex.answer("prompt")
    assert cli.runs() == []
    assert codex.status()["connected"] is False

def test_answer_is_discarded_when_the_model_acted(cli):
    command = {"type": "item.completed", "item": {"id": "item_1", "type": "command_execution", "command": "cat secrets"}}
    cli.replies["exec"] = (0, stream(command, message("Here are the secrets"), DONE), "")
    with pytest.raises(ModelPaused, match="tried to act"):
        codex.answer("prompt")

def test_last_message_is_the_answer(cli):
    cli.replies["exec"] = (0, stream(message("Working on it"), {"type": "item.completed", "item": {"type": "reasoning", "text": "thinking"}}, message("Final"), DONE), "")
    assert codex.answer("prompt")[0] == "Final"

@pytest.mark.parametrize("output", [stream(message("Half an ans")), stream(DONE), "not json at all"])
def test_run_without_a_completed_answer_is_not_an_answer(cli, output):
    cli.replies["exec"] = (0, output, "")
    with pytest.raises(ModelPaused, match="Interrupted"):
        codex.answer("prompt")

@pytest.mark.parametrize(("detail", "kind", "words"), [
    ('{"error":{"message":"The \'gpt-6-luna\' model is not supported when using Codex with a ChatGPT account."}}', ModelPaused, "unavailable"),
    ("You've hit your usage limit. Try again at 3:15 PM.", ModelPaused, "usage limit"),
    ("401 Unauthorized: please run codex login", ModelPaused, "signed out"),
    ("stream disconnected before completion", codex.Transient, "dropped"),
])
def test_failed_run_is_explained_without_the_cli_wording(cli, detail, kind, words):
    cli.replies["exec"] = (1, stream({"type": "error", "message": detail}, {"type": "turn.failed", "error": {"message": detail}}), "")
    with pytest.raises(kind, match=words) as raised:
        codex.answer("prompt")
    assert "3:15" not in str(raised.value) and "Unauthorized" not in str(raised.value)

def test_crashed_cli_is_worth_one_more_try(cli):
    cli.replies["exec"] = (101, "", "thread 'main' panicked")
    with pytest.raises(codex.Transient):
        codex.answer("prompt")

def test_older_cli_that_rejects_an_option_asks_for_an_update(cli):
    cli.replies["exec"] = (2, "", "error: unexpected argument '--ignore-rules' found\n\nUsage: codex exec [OPTIONS] [PROMPT]")
    with pytest.raises(ModelPaused, match="Update it on the server"):
        codex.answer("prompt")

def test_sign_out_seen_during_a_run_is_reported_at_once(cli):
    assert codex.status()["connected"]
    cli.replies["exec"] = (1, stream({"type": "turn.failed", "error": {"message": "Not logged in"}}), "")
    cli.replies["login"] = (1, "", "Not logged in")
    with pytest.raises(ModelPaused, match="signed out"):
        codex.answer("prompt")
    assert codex.status() == {"connected": False, "model_available": False, "model": "gpt-6-luna", "message": codex.SIGNED_OUT}

def test_run_that_overstays_pauses(cli):
    cli.replies["exec"] = subprocess.TimeoutExpired("codex", 45)
    with pytest.raises(ModelPaused, match="time budget"):
        codex.answer("prompt")

def test_page_image_is_attached_ahead_of_the_options(cli):
    codex.answer("Transcribe", b"\x89PNG-bytes", ".png")
    run = cli.runs()[0]
    arguments = run["arguments"]
    assert run["image"] == b"\x89PNG-bytes" and arguments[arguments.index("--image") + 1].endswith("page.png")
    # The image option takes several values, so an option, not the prompt, must follow it.
    assert arguments.index("--image") == 1 and arguments[3] == "--json"

def test_status_when_ready(cli):
    assert codex.status() == {"connected": True, "model_available": True, "model": "gpt-6-luna",
                              "message": "The AI engine is connected and gpt-6-luna is available."}
    codex.status()
    assert len(cli.calls) == 3  # The checks are remembered briefly, so a page load does not start three processes.

def test_status_when_signed_out(cli):
    cli.replies["login"] = (1, "", "Not logged in")
    status = codex.status()
    assert status["connected"] is False and status["message"] == codex.SIGNED_OUT
    assert cli.runs("debug") == []

def test_status_when_the_account_lacks_the_model(cli):
    cli.replies["debug"] = (0, json.dumps({"models": [{"slug": "gpt-6-sol"}]}), "")
    status = codex.status()
    assert status["connected"] and not status["model_available"] and "does not list gpt-6-luna" in status["message"]

@pytest.mark.parametrize("reply", [(1, "", "unknown subcommand"), (0, "<html>", "")])
def test_cli_without_a_catalog_is_judged_by_its_first_answer(cli, reply):
    cli.replies["debug"] = reply
    assert codex.status()["model_available"]

def test_status_when_the_cli_hangs(cli):
    cli.replies["features"] = ModelPaused("The Codex CLI on the server did not respond.")
    assert codex.status()["message"] == "The Codex CLI on the server did not respond."

def test_status_never_carries_cli_output(cli):
    cli.replies["login"] = (0, "", "Logged in using an API key - sk-proj-SECRET")
    assert "SECRET" not in json.dumps(codex.status())

@pytest.fixture
def python_as_cli(monkeypatch):
    """Runs the real process handling against this Python instead of the Codex CLI."""
    monkeypatch.setattr("app.codex.settings", lambda: Settings(codex_path=sys.executable))
    monkeypatch.setattr(codex, "_run", REAL_RUN)

def test_api_keys_never_reach_the_cli(python_as_cli, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-must-not-pass")
    monkeypatch.setenv("CODEX_API_KEY", "sk-must-not-pass")
    monkeypatch.setenv("CLAIM_TEST_MARKER", "kept")
    code, out, _ = codex._run(["-c", "import os,sys;print(os.environ.get('OPENAI_API_KEY'),os.environ.get('CODEX_API_KEY'),os.environ['CLAIM_TEST_MARKER'],sys.stdin.read())"], 30, "prompt-text")
    assert code == 0 and out.split() == ["None", "None", "kept", "prompt-text"]

def test_run_that_overstays_is_stopped(python_as_cli):
    started = time.monotonic()
    with pytest.raises(subprocess.TimeoutExpired):
        codex._run(["-c", "import time;time.sleep(60)"], 1)
    assert time.monotonic() - started < 30

def test_missing_cli_is_reported(monkeypatch):
    monkeypatch.setattr("app.codex.settings", lambda: Settings(codex_path="codex-is-not-installed-here"))
    monkeypatch.setattr(codex, "_run", REAL_RUN)
    status = codex.status()
    assert status["connected"] is False and "not installed" in status["message"]
