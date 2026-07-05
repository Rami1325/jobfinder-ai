"""Application configuration loaded from environment / .env."""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    openai_api_key: str = ""
    app_access_code: str = ""  # non-empty => every API call must send X-App-Key
    jooble_api_key: str = ""  # empty => the Jooble board reports "needs an API key"
    model_id: str = "gpt-4o-mini"
    use_stub_llm: bool = False
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    database_url: str = "sqlite:///./jobfinder.db"

    # Job alerts (PLAN 6): SMTP for the alert emails + the Vercel cron secret.
    # Vercel sends "Authorization: Bearer <CRON_SECRET>" on cron invocations
    # when the CRON_SECRET env var exists; unset = the cron endpoint is open.
    cron_secret: str = ""
    alert_smtp_host: str = ""  # empty => alerts run but nothing is emailed
    alert_smtp_port: int = 587  # 465 => implicit TLS, anything else => STARTTLS
    alert_smtp_user: str = ""
    alert_smtp_password: str = ""
    alert_email_from: str = ""  # defaults to alert_smtp_user

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
