import copy
import json
import threading
import time
from urllib.parse import parse_qs, urlsplit
import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm
from app.config import Settings
from app.chatgpt_auth import ChatGPTConnection, ISSUER, _pending
from app.credentials import CredentialStore
from app.errors import ModelPaused

class MemoryStore:
    def __init__(self, record=None):
        self.record = record
        self.lock = threading.RLock()
        self.saved = []
    def load(self):
        return copy.deepcopy(self.record)
    def save(self, record):
        self.record = copy.deepcopy(record)
        self.saved.append(copy.deepcopy(record))

class MemoryVault:
    def __init__(self):
        self.values = {}
    def get_password(self, service, key):
        return self.values.get((service, key))
    def set_password(self, service, key, value):
        self.values[service, key] = value
    def delete_password(self, service, key):
        self.values.pop((service, key), None)

@pytest.fixture
def connection(tmp_path):
    _pending.clear()
    service = ChatGPTConnection(Settings(data_dir=tmp_path), MemoryStore())
    yield service
    _pending.clear()

def prepare(connection):
    start = connection.start()
    ticket = parse_qs(urlsplit(start["sign_in_url"]).query)["ticket"][0]
    url, binding = connection.browser(ticket)
    return ticket, url, binding

def test_pkce_and_host_identity_are_stable(connection):
    ticket, url, _ = prepare(connection)
    params = parse_qs(urlsplit(url).query)
    assert params["client_id"] == ["dynamic_agent_client"]
    assert params["code_challenge_method"] == ["S256"]
    assert "chatgpt.tokens.use.direct" in params["scope"][0]
    assert params["ext_agent_host_id"] == [connection.host_id()]
    assert "code_verifier" not in params
    with pytest.raises(ModelPaused, match="already opened"):
        connection.browser(ticket)

def test_callback_rejects_wrong_browser_and_state(connection):
    ticket, _, binding = prepare(connection)
    with pytest.raises(ModelPaused, match="browser state"):
        connection.finish(ticket, "wrong", "code", "oaiapp_test")
    with pytest.raises(ModelPaused, match="state expired"):
        connection.finish("unknown", binding, "code", "oaiapp_test")

def test_callback_is_one_time_and_scopes_required(connection, monkeypatch):
    ticket, _, binding = prepare(connection)
    monkeypatch.setattr(connection, "exchange", lambda form: {"access_token": "test-access", "refresh_token": "test-refresh", "id_token": "test-id", "scope": "openid", "expires_in": 3600})
    monkeypatch.setattr(connection, "verify_identity", lambda *args: {"sub": "test-sub", "email": "synthetic@example.test"})
    with pytest.raises(ModelPaused, match="permission was not granted"):
        connection.finish(ticket, binding, "code", "oaiapp_test")
    assert connection.store.record["usable"] is False
    with pytest.raises(ModelPaused, match="already used"):
        connection.finish(ticket, binding, "code", "oaiapp_test")

def test_successful_callback_and_returning_registration(connection, monkeypatch):
    ticket, _, binding = prepare(connection)
    monkeypatch.setattr(connection, "exchange", lambda form: {"access_token": "test-access", "refresh_token": "test-refresh", "id_token": "test-id", "scope": "openid resource.invoke chatgpt.tokens.use.direct", "expires_in": 3600})
    monkeypatch.setattr(connection, "verify_identity", lambda *args: {"sub": "test-sub", "email": "synthetic@example.test"})
    result = connection.finish(ticket, binding, "code", "oaiapp_test")
    assert result["connected"] is True
    assert "access_token" not in result
    assert connection.access_token() == "test-access"
    _, url, _ = prepare(connection)
    params = parse_qs(urlsplit(url).query)
    assert params["client_id"] == ["oaiapp_test"]
    assert "agent_name_hint" not in params and "id_token_hint" not in params

def test_returning_account_identity_cannot_change(connection, monkeypatch):
    connection.store.record = {"client_id": "oaiapp_test", "subject": "original-sub", "usable": False}
    ticket, _, binding = prepare(connection)
    monkeypatch.setattr(connection, "exchange", lambda form: {"id_token": "new-id"})
    monkeypatch.setattr(connection, "verify_identity", lambda *args: {"sub": "different-sub"})
    with pytest.raises(ModelPaused, match="differs"):
        connection.finish(ticket, binding, "code", "oaiapp_test")
    assert connection.store.record["subject"] == "original-sub"

def test_refresh_rotation_is_saved_before_identity_validation(connection, monkeypatch):
    connection.store.record = {"client_id": "oaiapp_test", "subject": "original-sub", "usable": True, "access_token": "old-access", "refresh_token": "old-refresh", "id_token": "old-id", "scopes": ["resource.invoke", "chatgpt.tokens.use.direct"], "expires_at": 0}
    monkeypatch.setattr(connection, "exchange", lambda form: {"access_token": "new-access", "refresh_token": "new-refresh", "id_token": "new-id", "expires_in": 3600})
    monkeypatch.setattr(connection, "verify_identity", lambda *args: {"sub": "different-sub"})
    with pytest.raises(ModelPaused, match="identity changed"):
        connection.access_token()
    assert connection.store.record["refresh_token"] == "new-refresh"
    assert connection.store.record["usable"] is False

def test_near_expiry_is_refreshed_once(connection, monkeypatch):
    connection.store.record = {"client_id": "oaiapp_test", "subject": "test-sub", "usable": True, "access_token": "old-access", "refresh_token": "old-refresh", "id_token": "old-id", "scopes": ["resource.invoke", "chatgpt.tokens.use.direct"], "expires_at": time.time() + 10}
    calls = []
    def exchange(form):
        calls.append(form)
        return {"access_token": "new-access", "refresh_token": "new-refresh", "expires_in": 3600}
    monkeypatch.setattr(connection, "exchange", exchange)
    assert connection.access_token() == "new-access"
    assert connection.access_token() == "new-access"
    assert len(calls) == 1
    assert calls[0]["client_id"] == "oaiapp_test" and "scope" not in calls[0]

def test_large_credentials_remain_in_os_store(tmp_path):
    vault = MemoryVault()
    store = CredentialStore(Settings(data_dir=tmp_path), vault)
    record = {"access_token": "A" * 5000, "refresh_token": "R" * 5000}
    with store.lock:
        store.save(record)
        assert store.load() == record
        assert len(vault.values) > 2
        assert all(len(value) <= 800 for value in vault.values.values())
        store.save({"usable": False})
        assert store.load() == {"usable": False}
    for path in tmp_path.rglob("*"):
        if path.is_file():
            assert "AAAAAA" not in path.read_text()

@pytest.mark.parametrize("failure", [None, "issuer", "audience", "expired", "nonce", "signature"])
def test_real_signed_identity_validation(connection, monkeypatch, failure):
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_jwk = json.loads(RSAAlgorithm.to_jwk(private_key.public_key()))
    public_jwk["kid"] = "test-key"
    monkeypatch.setattr(connection, "metadata", lambda: {"issuer": ISSUER, "jwks_uri": "https://auth.openai.com/.well-known/jwks.json"})
    original = httpx.Client
    monkeypatch.setattr("app.chatgpt_auth.httpx.Client", lambda **kwargs: original(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"keys": [public_jwk]})), **kwargs))
    claims = {"sub": "test-sub", "iss": ISSUER, "aud": "oaiapp_test", "iat": int(time.time()), "exp": int(time.time()) + 600, "nonce": "test-nonce"}
    if failure == "issuer": claims["iss"] = "https://untrusted.example"
    if failure == "audience": claims["aud"] = "different-client"
    if failure == "expired": claims["exp"] = int(time.time()) - 600
    if failure == "nonce": claims["nonce"] = "different-nonce"
    signing_key = rsa.generate_private_key(public_exponent=65537, key_size=2048) if failure == "signature" else private_key
    token = jwt.encode(claims, signing_key, algorithm="RS256", headers={"kid": "test-key"})
    if failure:
        with pytest.raises((jwt.PyJWTError, ModelPaused)):
            connection.verify_identity(token, "oaiapp_test", "test-nonce")
    else:
        assert connection.verify_identity(token, "oaiapp_test", "test-nonce")["sub"] == "test-sub"
