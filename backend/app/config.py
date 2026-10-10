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

    redis_url: str = "redis://127.0.0.1:6379/0"
    local_access_token: SecretStr = SecretStr("")
    reviewer_access_token: SecretStr = SecretStr("")
    llm_model: str = "gpt-6-luna"
    oauth_account: str = "default"
    oauth_redirect_uri: str = "http://127.0.0.1:8000/auth/chatgpt/callback"
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
