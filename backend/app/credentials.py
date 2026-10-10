"""Protected OS credential storage, chunked for Windows Credential Manager."""
import base64
import hashlib
import json
import platform
from uuid import uuid4
import keyring
from keyring.errors import KeyringError, PasswordDeleteError
from filelock import FileLock, Timeout
from .errors import ModelPaused

SERVICE = "claim-evidence-assistant.chatgpt"

class CredentialStore:
    def __init__(self, config, backend=None):
        self.config = config
        self.backend = backend
        self.prefix = hashlib.sha256(config.oauth_account.encode()).hexdigest()[:24]
        directory = config.data_dir.resolve() / "runtime"
        directory.mkdir(parents=True, exist_ok=True)
        self.lock = FileLock(directory / ("oauth-" + self.prefix + ".lock"), timeout=20)

    def vault(self):
        if self.backend is not None:
            return self.backend
        if platform.system() == "Windows":
            from keyring.backends.Windows import WinVaultKeyring
            self.backend = WinVaultKeyring()
        else:
            candidate = keyring.get_keyring()
            if type(candidate).__module__ not in {"keyring.backends.macOS", "keyring.backends.SecretService", "keyring.backends.kwallet"}:
                raise ModelPaused("A secure OS credential store is unavailable. Run the API and worker natively under the same signed-in OS user.")
            self.backend = candidate
        return self.backend

    def load(self):
        try:
            manifest = self.vault().get_password(SERVICE, self.prefix)
            if not manifest:
                return None
            pointer = json.loads(manifest)
            count = pointer["count"]
            if not isinstance(count, int) or not 1 <= count <= 256:
                raise ValueError("Invalid credential manifest")
            chunks = [self.vault().get_password(SERVICE, self.prefix + ":" + pointer["generation"] + ":" + str(i)) for i in range(count)]
            if any(chunk is None for chunk in chunks):
                raise ValueError("Incomplete credentials")
            return json.loads(base64.b64decode("".join(chunks), validate=True))
        except (KeyringError, RuntimeError, ValueError, KeyError, TypeError) as error:
            if isinstance(error, ModelPaused):
                raise
            raise ModelPaused("ChatGPT credentials cannot be read from the secure OS store. Run the API and worker as the same Windows user and reconnect ChatGPT.") from error

    def save(self, record):
        # Callers hold the cross-process lock. Commit the pointer only after every chunk.
        encoded = base64.b64encode(json.dumps(record).encode()).decode()
        chunks = [encoded[i:i + 800] for i in range(0, len(encoded), 800)]
        if not 1 <= len(chunks) <= 256:
            raise ModelPaused("Credential record exceeds the secure storage limit")
        generation = uuid4().hex
        try:
            old = self.vault().get_password(SERVICE, self.prefix)
            for index, chunk in enumerate(chunks):
                self.vault().set_password(SERVICE, self.prefix + ":" + generation + ":" + str(index), chunk)
            self.vault().set_password(SERVICE, self.prefix, json.dumps({"generation": generation, "count": len(chunks)}))
        except (KeyringError, RuntimeError) as error:
            raise ModelPaused("ChatGPT credentials could not be saved to the OS credential store") from error
        if old:
            try:
                pointer = json.loads(old)
                for index in range(pointer["count"]):
                    self.vault().delete_password(SERVICE, self.prefix + ":" + pointer["generation"] + ":" + str(index))
            except (KeyringError, ValueError, KeyError):
                pass  # A committed replacement remains usable even if old-chunk cleanup fails.
