"""FastAPI application entrypoint."""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import router
from app.config import get_settings
from app.db.database import init_db
from app.llm.limits import ContextWindowExceeded, InputTooLarge, OutputTruncated
from app.llm.metering import meter


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="JobFinder API", version="0.1.0", lifespan=lifespan)

settings = get_settings()

# Error tracking (PLAN 7.0): opt-in via SENTRY_DSN. Résumé/JD text travels in
# request bodies, so bodies are never captured and PII stays off.
if settings.sentry_dsn:
    import sentry_sdk

    sentry_sdk.init(
        dsn=settings.sentry_dsn,
        environment=settings.sentry_environment,
        send_default_pii=False,
        max_request_body_size="never",
        traces_sample_rate=0.0,
    )

# Size limits, mapped once for the whole app rather than in each of the ~26
# route bodies that wrap their model call in a bare `except Exception -> 502`.
# 413 is deliberate on both counts: it is the status the upload cap already uses
# (routes.py's _read_capped), and Sentry's Starlette integration captures only
# 5xx — so a limit the user can act on stops generating issues, while a genuine
# 500 still does. The detail is STRUCTURED, following the daily-cap precedent in
# usage.py, so the sentence is composed client-side and can be translated;
# `apiErrorMessage` already knows how to read one.
@app.exception_handler(InputTooLarge)
async def _input_too_large(request: Request, exc: InputTooLarge) -> JSONResponse:
    return JSONResponse(
        status_code=413,
        content={
            "detail": {
                "code": "input_too_large",
                "kind": exc.kind,
                "size_kb": exc.size_kb,
                "cap_kb": exc.cap_kb,
            }
        },
    )


@app.exception_handler(ContextWindowExceeded)
async def _context_exceeded(request: Request, exc: ContextWindowExceeded) -> JSONResponse:
    # Survived our caps and the model still refused it — the honest "your CV is
    # legitimately enormous" case.
    return JSONResponse(
        status_code=413, content={"detail": {"code": "context_exceeded"}}
    )


@app.exception_handler(OutputTruncated)
async def _output_truncated(request: Request, exc: OutputTruncated) -> JSONResponse:
    # 503, not 413: nothing about the REQUEST was too big — the answer was. A
    # retry or a shorter résumé is the action, and it is our ceiling that was
    # hit, so this one SHOULD stay visible in Sentry.
    return JSONResponse(
        status_code=503, content={"detail": {"code": "output_truncated"}}
    )


app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Paths as seen locally and under the Vercel /api mount. The alerts cron is
# called by Vercel's scheduler (no X-App-Key); it enforces its own Bearer
# CRON_SECRET check in the handler. /public/scan is the free no-signup
# CV-vs-JD scan (deterministic only, rate-limited in its handler).
_GATE_EXEMPT = {
    "/", "/health", "/api", "/api/health",
    "/jobs/alerts/cron", "/api/jobs/alerts/cron",
    "/jobs/nudges/cron", "/api/jobs/nudges/cron",
    "/public/scan", "/api/public/scan",
}


@app.middleware("http")
async def llm_metering(request: Request, call_next):
    """Bind a per-request LLM token tally (PLAN 20.8 / N2).

    It lives HERE rather than in the `metered_user`/`llm_user` dependencies for
    a concrete reason: FastAPI runs a `yield` dependency through
    `contextmanager_in_threadpool`, so its setup and teardown can land in
    different contexts — binding there raised "Token was created in a different
    Context" on teardown, and the endpoint never saw the tally at all. Middleware
    sets and resets in one context, and a sync endpoint's threadpool hop copies
    that context, so `record()` reaches this object from the endpoint, from the
    search's scoring pool, and back. Verified both directions before relying on it.

    The tally also rides `request.state` so the dependencies can read it without
    touching contextvars at all.
    """
    with meter() as tally:
        request.state.llm_tally = tally
        return await call_next(request)


@app.middleware("http")
async def access_gate(request: Request, call_next):
    """When APP_ACCESS_CODE is set (the public deployment), require every API
    call to present a valid invite code in X-App-Key (PLAN 7.1: each code maps
    to a user; the admin's code IS the access code). Unset locally, so dev is
    unaffected and routes fall back to the admin user."""
    if (
        settings.app_access_code
        and request.method != "OPTIONS"
        and request.url.path not in _GATE_EXEMPT
    ):
        from app.db.database import SessionLocal
        from app.db.users import resolve_user, touch_last_seen

        db = SessionLocal()
        try:
            user = resolve_user(db, request.headers.get("x-app-key", ""))
            # Stamped here, on the session already open for the lookup, so it
            # costs no extra connection and covers every authenticated request
            # — including the uncapped /tools/* routes and unknown paths, which
            # this gate sees but no route dependency ever does.
            #
            # The id is read INSIDE the session, and that is load-bearing:
            # `touch_last_seen` commits, SQLAlchemy expires every attribute on
            # commit, and `db.close()` then detaches the instance — so a later
            # `user.id` tries to refresh itself and raises
            # DetachedInstanceError. It bit here, and only on the first request
            # of each throttle window (a throttled call never commits, so it
            # never expires anything), which is exactly the shape that reaches
            # production looking like a flake.
            user_id = None
            if user is not None:
                touch_last_seen(db, user)
                user_id = user.id
        finally:
            db.close()
        if user_id is None:
            return JSONResponse({"detail": "Access code required."}, status_code=401)
        request.state.user_id = user_id
    return await call_next(request)


app.include_router(router)


@app.get("/")
def root() -> dict[str, str]:
    return {"name": "JobFinder API", "docs": "/docs"}
