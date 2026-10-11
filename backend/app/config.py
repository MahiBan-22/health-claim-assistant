from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from typing import Literal
from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    data_dir: Path = Path("data")
    log_dir: Path = Path("logs")
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = "INFO"
    log_max_bytes: int = Field(default=10 * 1024 * 1024, gt=0)
    log_backup_count: int = Field(default=5, ge=1)
    app_origin: str = "http://127.0.0.1:5173"
    @property
    def cors_origins(self) -> list[str]:
        origin = self.app_origin.rstrip("/")
        parsed = urlsplit(origin)
        origins = [origin]
        if parsed.hostname in {"127.0.0.1", "localhost"}:
            alternate = "localhost" if parsed.hostname == "127.0.0.1" else "127.0.0.1"
            authority = alternate + (":" + str(parsed.port) if parsed.port else "")
            origins.append(urlunsplit((parsed.scheme, authority, "", "", "")))
        return origins

    # The workspace has no login. Requests are accepted only for these Host names and UI origins.
    allowed_hosts: str = "127.0.0.1,localhost"
    @property
    def trusted_hosts(self) -> set[str]:
        return {host.strip().lower() for host in self.allowed_hosts.split(",") if host.strip()}

    redis_url: str = "redis://127.0.0.1:6379/0"
    fixtures_dir: Path = Path(__file__).resolve().parents[2] / "fixtures"
    app_version: str = Field(default="dev", pattern=r"^(dev|[0-9a-f]{7,40})$")
    neatlogs_enabled: bool = True
    neatlogs_api_key: SecretStr = SecretStr("")
    neatlogs_endpoint: Literal["https://ingest.neatlogs.com", "https://eu.ingest.neatlogs.com"] = "https://ingest.neatlogs.com"
    neatlogs_workflow_name: str = "claim-evidence-assistant"
    neatlogs_sample_rate: float = Field(default=1.0, ge=0, le=1)
    neatlogs_shutdown_timeout_ms: int = Field(default=5000, ge=100, le=30000)
    llm_model: str = "gpt-6-luna"
    # Analyses run through the Codex CLI signed in for this OS user. Give a full path when it is not on PATH.
    codex_path: str = "codex"
    max_upload_bytes: int = Field(default=20 * 1024 * 1024, gt=0)
    max_pages: int = Field(default=100, gt=0)
    max_context_chars: int = Field(default=60000, gt=0)
    max_requests: int = Field(default=12, gt=0)
    job_timeout_seconds: int = Field(default=600, gt=0)
    model_timeout_seconds: int = Field(default=90, gt=0)
    max_model_output_chars: int = Field(default=50000, gt=0)

@lru_cache
def settings() -> Settings:
    return Settings()
