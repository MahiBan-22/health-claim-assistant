"""Host-owned Sign in with ChatGPT: PKCE, OIDC, scoped credentials and refresh."""
import base64
import hashlib
import hmac
import json
import secrets
import threading
import time
from urllib.parse import urlencode, urlsplit
from uuid import uuid4
import httpx
import jwt
from filelock import FileLock, Timeout
from .config import settings
from .credentials import CredentialStore
from .errors import ModelPaused

ISSUER = "https://auth.openai.com"
RESOURCE = "https://api.openai.com/v1"
SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
REQUIRED_SCOPES = {"resource.invoke", "chatgpt.tokens.use.direct"}
_pending = {}
_pending_lock = threading.Lock()

class ChatGPTConnection:
    def __init__(self, config=None, store=None):
        self.config = config or settings()
        self.store = store or CredentialStore(self.config)

    def metadata(self):
        with httpx.Client(timeout=15) as client:
            response = client.get(ISSUER + "/.well-known/openid-configuration")
            response.raise_for_status()
            data = response.json()
        if data.get("issuer") != ISSUER:
            raise ModelPaused("Unexpected ChatGPT identity issuer")
        for name in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
            parsed = urlsplit(data.get(name, ""))
            if parsed.scheme != "https" or parsed.hostname != "auth.openai.com":
                raise ModelPaused("Unexpected ChatGPT identity endpoint")
        return data

    def host_id(self):
        directory = self.config.data_dir.resolve() / "runtime"
        directory.mkdir(parents=True, exist_ok=True)
        with FileLock(directory / "host-id.lock", timeout=10):
            path = directory / "host-id.txt"
            if not path.exists():
                path.write_text("urn:uuid:" + str(uuid4()), encoding="utf-8")
            return path.read_text(encoding="utf-8").strip()

    def start(self):
        try:
            with self.store.lock:
                record = self.store.load() or {}
        except Timeout as error:
            raise ModelPaused("ChatGPT credentials are being updated; retry shortly") from error
        parsed = urlsplit(self.config.oauth_redirect_uri)
        if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.path != "/auth/chatgpt/callback" or parsed.query or parsed.fragment:
            raise ModelPaused("OAUTH_REDIRECT_URI must use http://127.0.0.1:<port>/auth/chatgpt/callback")
        state, nonce, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(32), secrets.token_urlsafe(64)
        entry = {"nonce": nonce, "verifier": verifier, "expires": time.monotonic() + 600,
                 "client_id": record.get("client_id", "dynamic_agent_client"), "subject": record.get("subject"),
                 "redirect_uri": self.config.oauth_redirect_uri, "host_id": self.host_id(),
                 "binding": secrets.token_urlsafe(32), "profile": self.config.oauth_account, "started": False}
        with _pending_lock:
            for key in list(_pending):
                if _pending[key]["expires"] < time.monotonic():
                    del _pending[key]
            if len(_pending) >= 16:
                raise ModelPaused("Too many pending sign-ins; wait for them to expire")
            _pending[state] = entry
        origin = parsed.scheme + "://" + parsed.netloc
        return {"sign_in_url": origin + "/auth/chatgpt/browser?" + urlencode({"ticket": state})}

    def browser(self, ticket):
        with _pending_lock:
            entry = _pending.get(ticket)
            if not entry or entry["expires"] < time.monotonic() or entry["started"]:
                raise ModelPaused("This sign-in link expired or was already opened; start again")
            if entry["profile"] != self.config.oauth_account:
                raise ModelPaused("Sign-in account profile changed; start again")
            entry["started"] = True
        challenge = base64.urlsafe_b64encode(hashlib.sha256(entry["verifier"].encode()).digest()).decode().rstrip("=")
        params = {"client_id": entry["client_id"], "ext_agent_host_id": entry["host_id"],
                  "response_type": "code", "redirect_uri": entry["redirect_uri"], "scope": SCOPES,
                  "resource": RESOURCE, "state": ticket, "nonce": entry["nonce"],
                  "code_challenge_method": "S256", "code_challenge": challenge}
        if entry["client_id"] == "dynamic_agent_client":
            params["agent_name_hint"] = "Health Claim Evidence Assistant"
        # Login hints containing ID tokens are intentionally not sent to browser JS.
        return ISSUER + "/api/accounts/authorize?" + urlencode(params), entry["binding"]

    def verify_identity(self, token, client_id, nonce=None):
        if not isinstance(token, str) or not token:
            raise ModelPaused("ChatGPT returned no ID token")
        metadata = self.metadata()
        header = jwt.get_unverified_header(token)
        if header.get("alg") not in {"RS256", "ES256"}:
            raise ModelPaused("Unsupported identity signing algorithm")
        with httpx.Client(timeout=15) as client:
            response = client.get(metadata["jwks_uri"])
            response.raise_for_status()
            keys = jwt.PyJWKSet.from_dict(response.json()).keys
        candidates = [key for key in keys if key.key_id == header.get("kid")]
        if len(candidates) != 1:
            raise ModelPaused("ChatGPT identity signing key was not found")
        claims = jwt.decode(token, candidates[0].key, algorithms=[header["alg"]], audience=client_id,
                            issuer=ISSUER, leeway=5, options={"require": ["sub", "iss", "aud", "exp", "iat"]})
        if not isinstance(claims["sub"], str) or not claims["sub"]:
            raise ModelPaused("Invalid ChatGPT account identity")
        if claims.get("azp", client_id) != client_id or (isinstance(claims["aud"], list) and len(claims["aud"]) > 1 and claims.get("azp") != client_id):
            raise ModelPaused("ChatGPT identity audience does not match this application")
        if nonce is not None and not hmac.compare_digest(str(claims.get("nonce", "")), nonce):
            raise ModelPaused("ChatGPT sign-in nonce did not match")
        return claims

    def exchange(self, form):
        with httpx.Client(timeout=20) as client:
            response = client.post(ISSUER + "/api/accounts/oauth/token", data=form)
        if response.status_code != 200:
            raise ModelPaused("ChatGPT authorization failed (HTTP " + str(response.status_code) + "); start sign-in again")
        tokens = response.json()
        if tokens.get("token_type", "").lower() != "bearer" or not isinstance(tokens.get("access_token"), str) or not tokens["access_token"]:
            raise ModelPaused("ChatGPT did not return an authorized bearer credential")
        return tokens

    def finish(self, state, binding, code=None, client_id=None, error=None):
        with _pending_lock:
            entry = _pending.get(state)
            if not entry or entry["expires"] < time.monotonic() or not entry["started"]:
                raise ModelPaused("Sign-in state expired or was already used; start again")
            if entry["profile"] != self.config.oauth_account or not hmac.compare_digest(binding or "", entry["binding"]):
                raise ModelPaused("Sign-in browser state did not match; start again")
            del _pending[state]
        if error:
            raise ModelPaused("ChatGPT sign-in was declined or interrupted; start again when ready")
        issued = client_id or entry["client_id"]
        if not issued or issued == "dynamic_agent_client" or not issued.startswith("oaiapp_"):
            raise ModelPaused("ChatGPT did not return a registered client ID")
        if entry["client_id"] != "dynamic_agent_client" and issued != entry["client_id"]:
            raise ModelPaused("ChatGPT returned a different account registration")
        if not code:
            raise ModelPaused("ChatGPT returned no authorization code")
        with self.store.lock:
            previous = self.store.load() or {}
            # Retain the issued registration even when a one-time code exchange fails.
            registration = {"client_id": issued, "subject": entry["subject"], "email": previous.get("email"), "usable": False}
            if not previous.get("usable"):
                self.store.save(registration)
            tokens = self.exchange({"grant_type": "authorization_code", "client_id": issued, "code": code,
                                    "code_verifier": entry["verifier"], "redirect_uri": entry["redirect_uri"], "resource": RESOURCE})
            claims = self.verify_identity(tokens.get("id_token"), issued, entry["nonce"])
            if entry["subject"] and claims["sub"] != entry["subject"]:
                raise ModelPaused("The signed-in account differs from the selected registration")
            record = {**registration, "subject": claims["sub"], "email": claims.get("email"),
                      "id_token": tokens["id_token"], "access_token": tokens["access_token"],
                      "refresh_token": tokens.get("refresh_token"), "scopes": tokens.get("scope", "").split(),
                      "expires_at": time.time() + float(tokens.get("expires_in", 0)), "usable": True}
            if not REQUIRED_SCOPES.issubset(record["scopes"]) or not record["refresh_token"]:
                record["usable"] = False
                self.store.save(record)
                raise ModelPaused("ChatGPT plan-use permission was not granted. Reconnect and authorize plan usage.")
            self.store.save(record)
        return {"connected": True, "email": record.get("email")}

    def access_token(self):
        try:
            with self.store.lock:
                record = self.store.load()
                if not record or not record.get("usable"):
                    raise ModelPaused("Continue with ChatGPT in the claim workspace before running analysis")
                if not REQUIRED_SCOPES.issubset(record.get("scopes", [])):
                    raise ModelPaused("The connected account lacks ChatGPT plan-use permission; reconnect")
                if record.get("expires_at", 0) > time.time() + 60:
                    return record["access_token"]
                if not record.get("refresh_token"):
                    raise ModelPaused("ChatGPT session expired; reconnect")
                tokens = self.exchange({"grant_type": "refresh_token", "client_id": record["client_id"],
                                        "refresh_token": record["refresh_token"], "resource": RESOURCE})
                updated = {**record, "access_token": tokens["access_token"],
                           "refresh_token": tokens.get("refresh_token", record["refresh_token"]),
                           "id_token": tokens.get("id_token", record["id_token"]),
                           "scopes": tokens.get("scope", " ".join(record["scopes"])).split(),
                           "expires_at": time.time() + float(tokens.get("expires_in", 0)), "usable": False}
                # Persist rotation before validation; a failed validation cannot reuse a spent refresh token.
                self.store.save(updated)
                if tokens.get("id_token"):
                    claims = self.verify_identity(tokens["id_token"], record["client_id"])
                    if claims["sub"] != record["subject"]:
                        raise ModelPaused("Refreshed ChatGPT identity changed; reconnect")
                if not REQUIRED_SCOPES.issubset(updated["scopes"]):
                    raise ModelPaused("ChatGPT plan-use permission was removed; reconnect")
                updated["usable"] = True
                self.store.save(updated)
                return updated["access_token"]
        except Timeout as error:
            raise ModelPaused("ChatGPT credentials are being refreshed; retry shortly") from error

    def status(self):
        try:
            with self.store.lock:
                record = self.store.load() or {}
            return {"connected": bool(record.get("usable")), "storage_available": True,
                    "email": record.get("email"), "profile": self.config.oauth_account,
                    "model": self.config.llm_model,
                    "message": "ChatGPT connected" if record.get("usable") else "Continue with ChatGPT to enable live analysis"}
        except (ModelPaused, Timeout) as error:
            return {"connected": False, "storage_available": False, "model": self.config.llm_model,
                    "message": str(error) if isinstance(error, ModelPaused) else "Credential store is busy; retry shortly"}

    def models(self):
        token = self.access_token()
        with httpx.Client(timeout=20) as client:
            response = client.get(RESOURCE + "/models", headers={"Authorization": "Bearer " + token})
        if response.status_code != 200:
            raise ModelPaused("ChatGPT model catalog unavailable; reconnect or retry")
        models = [{"slug": model["slug"], "display_name": model.get("display_name", model["slug"])}
                  for model in response.json().get("models", []) if model.get("visibility") == "list" and model.get("slug")]
        return {"models": models, "selected_model": self.config.llm_model,
                "selected_model_available": self.config.llm_model in {model["slug"] for model in models}}

    def disconnect(self):
        confirmed = True
        with self.store.lock:
            record = self.store.load() or {}
            if record.get("refresh_token"):
                confirmed = False
                try:
                    endpoint = self.metadata().get("revocation_endpoint", "")
                    parsed = urlsplit(endpoint)
                    if parsed.scheme == "https" and parsed.hostname == "auth.openai.com":
                        with httpx.Client(timeout=15) as client:
                            response = client.post(endpoint, data={"token": record["refresh_token"], "token_type_hint": "refresh_token", "client_id": record["client_id"]})
                        confirmed = response.status_code == 200
                except (httpx.HTTPError, ModelPaused):
                    pass
            registration = {k: record[k] for k in ("client_id", "subject", "email") if k in record}
            self.store.save({**registration, "usable": False})
        return {"connected": False, "revocation_confirmed": confirmed}
