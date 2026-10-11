import pytest
from app import codex
from app.errors import ModelPaused

@pytest.fixture(autouse=True)
def no_host_codex(monkeypatch):
    """Tests behave as a host without the Codex CLI, so none can start it or spend the account's usage."""
    def absent(arguments, timeout, text=""):
        raise ModelPaused("The Codex CLI is not installed on the server, or CODEX_PATH does not point to it.")
    monkeypatch.setattr(codex, "_run", absent)
    codex._cache.clear()
    yield
    codex._cache.clear()
