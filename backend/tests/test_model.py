import json
import httpx
import pytest
from app.config import Settings
from app.model import LunaModel, ModelPaused
from app.schemas import Verification

def configure(monkeypatch, events):
    monkeypatch.setattr("app.model.settings", lambda: Settings())
    monkeypatch.setattr("app.model.ChatGPTConnection.access_token", lambda self: "synthetic-oauth-token")
    original = httpx.Client
    requests = []
    def respond(request):
        requests.append(request)
        stream = "".join("data: " + json.dumps(event) + "\n\n" for event in events)
        return httpx.Response(200, text=stream, headers={"Content-Type": "text/event-stream"})
    monkeypatch.setattr("app.model.httpx.Client", lambda **kwargs: original(transport=httpx.MockTransport(respond), **kwargs))
    return LunaModel(), requests

def test_completed_stream_uses_requested_luna(monkeypatch):
    result = {"decision": "supported", "reasons": [], "targeted_query": None}
    model, requests = configure(monkeypatch, [{"type": "response.output_text.delta", "delta": json.dumps(result)}, {"type": "response.completed"}])
    assert model.generate("Verifier", "Check support", {}, Verification).decision == "supported"
    body = json.loads(requests[0].content)
    assert body["model"] == "gpt-6-luna"
    assert body["store"] is False and body["stream"] is True
    assert "max_output_tokens" not in body

def test_partial_stream_never_becomes_finding(monkeypatch):
    model, _ = configure(monkeypatch, [{"type": "response.output_text.delta", "delta": '{}'}])
    with pytest.raises(ModelPaused, match="Interrupted"):
        model.generate("Verifier", "Check support", {}, Verification)

def test_quota_failure_after_text_is_not_success(monkeypatch):
    model, _ = configure(monkeypatch, [{"type": "response.output_text.delta", "delta": '{}'}, {"type": "response.failed"}])
    with pytest.raises(ModelPaused, match="did not complete"):
        model.generate("Verifier", "Check support", {}, Verification)

def test_missing_credential_pauses(monkeypatch):
    def missing(self):
        raise ModelPaused("Continue with ChatGPT")
    monkeypatch.setattr("app.model.ChatGPTConnection.access_token", missing)
    with pytest.raises(ModelPaused, match="Continue"):
        LunaModel().credential()
