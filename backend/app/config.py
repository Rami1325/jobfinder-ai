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
    # Monthly uses (Phase 30 / B2, app/core/quota.py): one shared pool of this many
    # uses a month per person, spent by every AI feature. The admin and plan
    # "unlimited" are exempt; <= 0 switches the monthly limit off (the daily caps'
    # kill-switch shape). The landing, FAQ and privacy copy state the number in
    # both locales, so changing it means editing that copy too.
    free_monthly_uses: int = 10
    # Daily caps for the model calls that are sub-steps of a counted flow and so
    # stay OFF the monthly pool (Phase 30 / B4.6): counting them would make one
    # tailor cost two uses. Each is its own usage_log action; admins are exempt,
    # plan "unlimited" is NOT, and <= 0 disables a cap.
    daily_upload_cap: int = 10
    daily_jd_analyze_cap: int = 30
    daily_search_context_cap: int = 10
    # The CV scan's own daily cap, beside its monthly charge (Phase 30 / A2).
    daily_scan_cap: int = 20
    # `/jobs/fetch` is NOT one of the three above: it reaches no model, so it is
    # off the pool and has no tokens to meter. What it spends is one outbound GET
    # per call from the deployment's own IPs — invocations, inbound bytes, and
    # our standing with the boards — and it carried no cap of any kind until the
    # Phase 30 review (COST-3). 60 is a ceiling a real user cannot reach: the UI
    # calls it once per pasted URL.
    daily_fetch_cap: int = 60
    # Upload limits. Both upload routes (/resume/upload and /tools/scan) read the
    # file into memory to parse it, and a free account costs nothing to make, so
    # an unbounded read is a cheap way to exhaust a serverless instance. A resume
    # is a couple of hundred kB; 10 MB
    # is generous for a scan-heavy PDF and still nowhere near dangerous. The page
    # ceiling bounds pdfplumber, which is the expensive half — a master CV can
    # legitimately be ~30 rendered pages (PLAN 18.4), so 50 leaves real headroom
    # while stopping a thousand-page decompression bomb.
    max_upload_mb: int = 10
    max_pdf_pages: int = 50
    # The DOCX half of the same guard, and the one the page ceiling above does
    # not cover. `max_upload_mb` caps COMPRESSED bytes; a .docx is a zip, and
    # python-docx expands every part into an lxml tree before we see a word of
    # it. Measured on this machine: a valid .docx of 3,000,000 trivial
    # paragraphs compresses 343:1 — 0.298 MB of zip becomes 102.0 MB of
    # `document.xml`, and python-docx builds the tree in 1.2 s. Against the
    # 10 MB compressed cap that same content admits ~3.4 GB of XML from
    # unremarkable input, before anyone crafts a payload. (The defect report
    # measured the same shape at 294:1, 0.85 MB -> 249 MB / 5.6 s, i.e. ~2.9 GB
    # at the cap — the ratio varies with paragraph shape, the class does not.)
    #
    # 32 MB is sized off the worst LEGITIMATE case, not off the bomb. Measured:
    # a 30-page text master expands to 1.0 MB, our own `render_docx` output to
    # 0.9 MB, and a CV whose bulk is embedded photos to 10.3 MB — images are
    # already compressed, so an image-heavy .docx expands ~1:1 and its ceiling
    # is `max_upload_mb` ITSELF. That is the real floor under this number, and
    # `_assert_docx_expansion` DERIVES it (`max(cap, 3 * max_upload_mb)`) rather
    # than trusting this constant to be kept in step: a cap at or below 10 MB
    # would refuse a legitimate photo-heavy CV the upload cap had just admitted.
    #
    # What it still costs is recorded rather than guessed. `extract_text` is
    # linear at ~1.19 s per MB of expanded XML (3.4 MB -> 4.2 s; 17.0 MB ->
    # 20.2 s; 61.2 MB -> 72.7 s) — the `doc.paragraphs` walk, not the tree
    # build. So a bomb sized just under this cap still buys ~38 s of one
    # instance against Vercel's 300 s kill; unguarded, the same upload buys
    # ~3.4 GB and OOMs long before it finishes. 64 MB was the first choice and
    # was halved on exactly that number: the scan took no access code then, and
    # while every upload route is signed in since Phase 30, a free account is
    # still cheap to make, so the CPU one request can buy is the quantity being
    # bounded, and 3x headroom over a measured worst case is enough. Below ~12 MB
    # the guard
    # starts firing on legitimate input, which is the other wall.
    #
    # <= 0 disables the check.
    max_docx_uncompressed_mb: int = 32
    jooble_api_key: str = ""  # empty => the Jooble board reports "needs an API key"
    # Stale-application nudges: an "applied" app with no status change for this
    # many days surfaces a "time to follow up" reminder on the tracker (<= 0 disables).
    stale_application_days: int = 7
    # Tailored-resume page budget. A master resume holds everything the
    # candidate has ever built; one application needs a couple of pages of it.
    # The tailor aims for `resume_max_pages`; the deterministic length budget
    # guarantees `resume_hard_max_pages` — it will sit at the hard limit rather
    # than gut the CV, but never go past it.
    resume_max_pages: int = 2
    resume_hard_max_pages: int = 3
    # Tailored skills-section ceiling, guaranteed by `core/skills_shortlist.py`
    # the same way the page count is guaranteed by `core/length_budget.py`. 20 is
    # the middle of the range the TAILOR prompt has always asked for ("roughly
    # 15-25") and the value the real-key A/B measured; the prompt asking for it
    # was not enough on its own, which is the whole reason the module exists —
    # measured median 66 shipped skills against a 66-skill master.
    #
    # It is a CEILING FOR THE TAIL, not a hard truncation: an entry the job
    # actually names is never dropped, so a broad posting legitimately lands
    # above this number and a narrow one below it. <= 0 disables the trim.
    #
    # RAISED 20 -> 30 (2026-08-30), and the reason matters more than the number.
    # At 20 the list filled with the model's JD-shaped PARAPHRASE -- "orchestration
    # patterns", "tool use", "feedback loops" -- and cut the candidate's actual
    # toolchain: FastAPI, PostgreSQL, pgvector, RAG, embeddings, n8n, Vapi all
    # gone from an AI-engineering application. Found by rendering the document and
    # reading it, not by any metric: `skills_precision` scores an entry as GOOD
    # when a JD term matches it, so it REWARDED paraphrase and marked the real
    # stack as noise. It read 18.6% -> 55% while the CV got worse.
    #
    # THE RAISE IS FREE, which is why it is the fix rather than a prompt change.
    # Simulated against eighteen real 52-74 entry model outputs: JD coverage of
    # the shipped list is CONSTANT at 55.1 for every cap from 20 to 40, because
    # `shortlist_skills` never drops an entry the job named -- so a bigger cap can
    # only add. Measured 20 -> 30: the candidate's own wording 72% -> 82%, concrete
    # tools 9.0 -> 15.5, page count unchanged at 2. Re-ranking was tried first and
    # is DEAD: three rank rules gave byte-identical output, because the model
    # front-ranks its own paraphrases, so no reordering of its list can recover
    # the toolchain. A prompt arm was tried too and rejected -- where it worked it
    # cost 30 coverage points, and on the job that motivated it, it did nothing.
    resume_max_skills: int = 30
    # Prompt input ceilings, in UTF-8 KB (see app/llm/limits.py for why bytes
    # and not characters — Hebrew costs ~1.83 bytes/char, so a character cap
    # silently grants the primary market ~2x the tokens).
    #
    # These are GUARD RAILS, not budgets: they must fire on a 500-page PDF and
    # never on a real CV. 256 KB is ~256k English or ~140k Hebrew characters,
    # comfortably past the ~30 rendered pages a master resume can legitimately
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
    # when the CRON_SECRET env var exists. With the access gate on
    # (APP_ACCESS_CODE set) and no secret, the alerts cron and the inbox cron
    # refuse with 503 cron_unconfigured (Phase 30 / B6.1: a morning can spend a
    # free user's monthly use); the nudges cron reaches no model and stays open.
    # With the gate off (local dev) an unset secret leaves the crons open.
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

    # Self-service accounts (Phase 29 / B1). Invite codes keep working exactly as
    # before; everything below governs the email + password sign-in beside them.
    #
    # "open" lets anyone create an account; "closed" refuses POST /auth/signup
    # with 403 signup_closed while every existing account keeps working, so the
    # door can be shut from the Vercel env without a code deploy. Anything but
    # "closed" counts as open, so a blank variable cannot silently lock it.
    signup_mode: str = "open"
    # A session slides forward on use (at most once every 12 h) by this many
    # days, but never past `session_max_days` after the sign-in that made it: a
    # stolen cookie that keeps being used still dies on a fixed date.
    session_ttl_days: int = 30
    session_max_days: int = 180
    # scrypt work factor for password hashes (N; r=8, p=1). 2**17 measured ~0.28
    # s and ~128 MB per hash on the owner's machine. The parameters are stored
    # INSIDE each hash, so raising this later locks nobody out: every account is
    # re-hashed at the new N on its next successful login. The smoke test sets
    # 4096 so its signups cost ~0.02 s each.
    auth_scrypt_n: int = 131072
    # Minutes a verification code/link and a password-reset link stay valid.
    verify_ttl_min: int = 60
    reset_ttl_min: int = 60
    # "smtp" sends auth mail through the ALERT_SMTP_* account above, and an
    # unconfigured SMTP is a 503 email_unavailable — never a signup that
    # "succeeds" and then waits for a code nobody sent. "console" prints each
    # mail to stdout instead, for local browser testing where the code is read
    # off the server log. Never "console" in production: it logs live codes.
    auth_email_mode: str = "smtp"
    # Keys the HMACs that turn an IP address or an email into a throttle key
    # (an unsalted hash of an IPv4 address reverses in seconds). Falls back to
    # CRON_SECRET, then APP_ACCESS_CODE, so a deployment is never keyed on a
    # public constant; rotating whichever one is in use resets every throttle.
    auth_secret: str = ""
    # Google OAuth client for the Gmail connect (Phase 29 / B2), in the Google
    # Cloud project that stays in Testing. Sign-in never reads these.
    google_client_id: str = ""
    google_client_secret: str = ""
    # Continue with Google (Phase 30 / E): the Web client of a SEPARATE Google
    # Cloud project, "JobFinder Sign-in" (In production, basic scopes only).
    # Separate because revocation is project-wide (a Gmail Disconnect would end
    # the sign-in grant too), the restricted-scope user cap belongs to a project,
    # and include_granted_scopes would pull gmail.readonly into a sign-in. There is
    # NO fallback to the Gmail pair above: one would silently put sign-in on the
    # Gmail project. Sign-in is on when both of these and APP_BASE_URL are set,
    # and /auth/me reports it as google_enabled. The redirect URI to register is
    # APP_BASE_URL + /api/auth/google/callback.
    google_signin_client_id: str = ""
    google_signin_client_secret: str = ""

    # Gmail inbox scanner (Phase 29 / B2): reads employer replies and files them
    # on the tracker. Nothing below does anything until the Google client above,
    # APP_BASE_URL and `inbox_token_key` are all set (or the demo mailbox is
    # switched on) — and the inbox UI renders nothing on a server with neither.
    #
    # Fernet key(s) encrypting stored Google refresh tokens, comma-separated and
    # NEWEST FIRST: rotate by prepending a new key, redeploying, and dropping the
    # old one later. Losing every key disconnects everyone — their grants can no
    # longer be read, so each connection reads as needs_reauth.
    inbox_token_key: str = ""
    # The classifier's model. It gets its OWN OpenAIClient, never the tailor's:
    # the client drops a parameter the first time a model rejects it, for the
    # life of the process, so a cheap model that refuses `temperature` would
    # strip it from every TAILOR call if the two shared an instance. Provisional
    # until the real-key A/B (tests/inbox_eval.py) picks it; "" = this default.
    inbox_model_id: str = "gpt-4.1-nano"
    # Model classifications per user per UTC day (admins exempt, <= 0 disables).
    # The alert-digest filter and the templates decide most mail with no model
    # call, so this bounds the ambiguous remainder, not the mailbox.
    daily_inbox_cap: int = 300
    # Wall clock for one sync — the interactive button, and each user inside a
    # cron tick — and for the whole tick, which must stop under Vercel's 300 s.
    inbox_sync_budget_s: int = 25
    inbox_cron_budget_s: int = 240
    inbox_max_messages_per_run: int = 150
    # How far back the first import reads when the user does not pick.
    inbox_backfill_days: int = 60
    # Below this classifier confidence an email waits in Needs review instead of
    # touching a card.
    inbox_review_threshold: float = 0.6
    # A canned in-memory mailbox (app/core/inbox_fake.py), so the whole flow runs
    # offline and in a browser without Google. Refused while the gate is ON and
    # the real model is in use — i.e. it cannot be switched on in production.
    inbox_fake_provider: bool = False
    # Who may connect Gmail. "allowlist" (the default, and what anything but
    # "all" means) = admins plus accounts the admin enabled with PATCH
    # /admin/users/{id} {"inbox_enabled": true}; "all" = every account. While the
    # Google app is in Testing, Google's own consent page admits only its listed
    # test users, so a Connect button shown to everyone would send most people
    # to an "Access blocked" page our callback never even hears about.
    inbox_access: str = "allowlist"
    # True while the Google app is in Testing, where Google ends every Gmail
    # grant 7 days after consent: the connect screen says so up front, and the
    # connection turns needs_reauth on that date instead of after a failed refresh.
    google_oauth_testing: bool = True

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
