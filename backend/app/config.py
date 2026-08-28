"""Application configuration loaded from environment / .env."""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    openai_api_key: str = ""
    # Non-empty => every API call must send X-App-Key. Since the friends beta
    # (PLAN 7) the header is a per-user invite code; this value stays the
    # ADMIN user's code (synced into the users table on startup).
    app_access_code: str = ""

    # Friends beta (PLAN 7): error tracking + per-user daily cost caps.
    # Caps guard the OpenAI key while friends test; <= 0 disables a cap and
    # admins are always exempt.
    sentry_dsn: str = ""
    # Sentry environment tag: "production" on Vercel, "development" locally,
    # so local runs never pollute the prod error stream.
    sentry_environment: str = "development"
    daily_search_cap: int = 20
    daily_tailor_cap: int = 30
    # Everything else that calls the model (cover letter, interview turns,
    # outreach, company brief, the tools…). Until PLAN 20.6/S2 these 17 routes
    # were free, which made the other two caps decorative — /interview/chat in
    # particular is a user-driven loop, one call per turn, resending the whole
    # transcript. 150 is generous for real use (a long mock interview is ~25
    # turns) and still a hard stop on a runaway client.
    daily_llm_cap: int = 150
    # Auto-submit (PLAN 8.4): real applications sent per user per day.
    daily_submit_cap: int = 10
    # Upload limits. Both upload routes read the file into memory to parse it,
    # and /public/scan takes NO access code, so an unbounded read is a free way
    # to exhaust a serverless instance. A résumé is a couple of hundred kB; 10 MB
    # is generous for a scan-heavy PDF and still nowhere near dangerous. The page
    # ceiling bounds pdfplumber, which is the expensive half — a master CV can
    # legitimately be ~30 rendered pages (PLAN 18.4), so 50 leaves real headroom
    # while stopping a thousand-page decompression bomb.
    max_upload_mb: int = 10
    max_pdf_pages: int = 50
    jooble_api_key: str = ""  # empty => the Jooble board reports "needs an API key"
    # Stale-application nudges: an "applied" app with no status change for this
    # many days surfaces a "time to follow up" reminder on the tracker (<= 0 disables).
    stale_application_days: int = 7
    # Tailored-résumé page budget. A master résumé holds everything the
    # candidate has ever built; one application needs a couple of pages of it.
    # The tailor aims for `resume_max_pages`; the deterministic length budget
    # guarantees `resume_hard_max_pages` — it will sit at the hard limit rather
    # than gut the CV, but never go past it.
    resume_max_pages: int = 2
    resume_hard_max_pages: int = 3
    # Prompt input ceilings, in UTF-8 KB (see app/llm/limits.py for why bytes
    # and not characters — Hebrew costs ~1.83 bytes/char, so a character cap
    # silently grants the primary market ~2x the tokens).
    #
    # These are GUARD RAILS, not budgets: they must fire on a 500-page PDF and
    # never on a real CV. 256 KB is ~256k English or ~140k Hebrew characters,
    # comfortably past the ~30 rendered pages a master résumé can legitimately
    # run (see resume_max_pages above). 32 KB is ~10x a long job ad and ~2.5x
    # company_brief's existing _PAGE_TEXT_CAP of 12,000. A legitimate document
    # that is still too big for the model is caught by ContextWindowExceeded
    # instead, which can say something actionable.
    max_resume_kb: int = 256
    max_jd_kb: int = 32
    # Runaway-generation stop, NOT a budget — and it may only ship alongside the
    # finish_reason check in llm/client.py, or a truncated completion becomes a
    # JSONDecodeError blamed on us. Arithmetic: the largest legitimate output is
    # a TAILOR at resume_hard_max_pages (3), which the prompt's own budget puts
    # at ~1,650 body words — measured at ~31.8k chars in English (~7,950 tokens)
    # and ~23.3k chars in Hebrew, where a character can cost a whole token. So
    # 16,000 sits at 2x the English worst case, and BELOW the pessimistic Hebrew
    # one: a very long Hebrew tailor can hit it, and the finish_reason check is
    # what turns that into an honest message. It is not raised further because
    # 16,384 is the max-output ceiling on current mid-tier models and asking for
    # more risks a 400 on every call.
    llm_max_output_tokens: int = 16000
    model_id: str = "gpt-4o-mini"
    use_stub_llm: bool = False
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    database_url: str = "sqlite:///./jobfinder.db"

    # Job alerts (PLAN 6): SMTP for the alert emails + the Vercel cron secret.
    # Vercel sends "Authorization: Bearer <CRON_SECRET>" on cron invocations
    # when the CRON_SECRET env var exists; unset = the cron endpoint is open.
    cron_secret: str = ""
    # Wall-clock budget for one alerts-cron tick (PLAN 20.5/C2). One alert is a
    # full multi-board fan-out plus up to 25 LLM scoring calls, and Vercel kills
    # a function at 300s — so the cron stops cleanly at this mark and reports
    # what it didn't reach, instead of being killed partway with users at the
    # end of the list silently never getting their email. <= 0 disables the
    # budget (fine locally, never on serverless).
    alert_cron_budget_s: int = 240
    app_base_url: str = ""  # public app URL for links in alert emails (no trailing /)
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
