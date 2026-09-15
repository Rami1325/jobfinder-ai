"""FastAPI application entrypoint."""
from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime
from typing import NamedTuple

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import select
from starlette._utils import get_route_path

from app.api.auth_routes import router as auth_router
from app.api.inbox_routes import router as inbox_router
from app.api.routes import router
from app.config import get_settings
from app.core import quota
from app.core.accounts import AuthError, is_verified
from app.core.sessions import COOKIE_NAME, set_session_cookie
from app.db.database import init_db
from app.llm.limits import ContextWindowExceeded, InputTooLarge, OutputTruncated
from app.llm.metering import meter


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="JobFinder API", version="0.1.0", lifespan=lifespan)

settings = get_settings()

# Error tracking (PLAN 7.0): opt-in via SENTRY_DSN. Resume/JD text travels in
# request bodies, so bodies are never captured and PII stays off. The options
# live in app/core/sentry_scrub.py (FIXB B2): no frame variables, and a
# before_send that redacts every configured secret — the SDK's defaults sent the
# Settings object and inbox mail metadata to Sentry on one failed sync.
if settings.sentry_dsn:
    import sentry_sdk

    from app.core.sentry_scrub import sentry_init_options

    sentry_sdk.init(**sentry_init_options(settings))

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
    # retry or a shorter resume is the action, and it is our ceiling that was
    # hit, so this one SHOULD stay visible in Sentry.
    return JSONResponse(
        status_code=503, content={"detail": {"code": "output_truncated"}}
    )


@app.exception_handler(AuthError)
async def _auth_error(request: Request, exc: AuthError) -> JSONResponse:
    # Account refusals (Phase 29): the same structured-detail shape, translated
    # client-side, and by construction never a 401 — the frontend reads a 401
    # anywhere as "you are signed out, go log in", which is the wrong answer to
    # "that password was wrong".
    return JSONResponse(status_code=exc.status, content={"detail": exc.detail})


app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Paths as seen locally and under the Vercel /api mount. The alerts cron is
# called by Vercel's scheduler (no X-App-Key); it enforces its own Bearer
# CRON_SECRET check in the handler. Every FEATURE is behind the gate: the CV
# scan left this set in Phase 30 (A2), when it became /tools/scan, so no
# anonymous route feeds a file to the parser any more. A feature added here would
# skip credentials, CSRF and verification all at once.
_GATE_EXEMPT = {
    "/", "/health", "/api", "/api/health",
    "/jobs/alerts/cron", "/api/jobs/alerts/cron",
    "/jobs/nudges/cron", "/api/jobs/nudges/cron",
}

# Account routes that must answer a caller holding no valid credential, since
# signing in is how one gets it (Phase 29). The gate still RESOLVES whatever
# credential is present — /auth/me reports who you are, and a verification code
# needs the pending session — but a missing or bad one never 401s here.
#
# Compared by ROUTE path (`get_route_path`), which is bare both locally and under
# the Vercel /api mount, so unlike _GATE_EXEMPT above there is no second
# spelling to forget. A forgotten "/api" twin passes every smoke check, because
# the suite drives the unmounted app, and 401s only in production.
_AUTH_OPTIONAL = frozenset({
    "/auth/me", "/auth/signup", "/auth/login", "/auth/logout",
    "/auth/verify", "/auth/forgot", "/auth/reset",
    # Phase 29 / B2. Google's redirect back carries no credential header, and the
    # route checks its own state, binding cookie and session (amendment O1); the
    # cron is called by Vercel's scheduler and checks its own Bearer secret.
    "/inbox/google/callback", "/inbox/cron",
    # Phase 30 / E2. Continue with Google starts on a signed-out login page, and
    # Google's redirect back carries no credential header: the callback checks
    # its own state, the jf_gsi binding cookie and the id_token's claims.
    "/auth/google/start", "/auth/google/callback",
})
# The doors an UNVERIFIED account must still be able to open, or verifying would
# be impossible to finish or to escape: resend the code, fix a mistyped address,
# and read the extension key (that route refuses an unverified caller itself,
# with the same code). Every _AUTH_OPTIONAL path is skipped too — an unverified
# cookie must not stop someone logging in to a DIFFERENT account — and so is
# DELETE /profile/account, the way out.
_UNVERIFIED_OK = frozenset({"/auth/resend", "/auth/change-email", "/auth/extension-key"})
_UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


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
async def uses_meter(request: Request, call_next):
    """Carry this request's monthly-uses count to the client (Phase 30 / B7).

    Every ledger write in app/core/quota.py records what it left on a holder
    bound HERE, and the headers come from it once the route has answered:
    `X-Uses-Remaining: <int>`, and for an interview or screening pass
    `X-Uses-Pass: <feature>;<calls_left>;<expires_in_s>` (`;0;0` once the pass
    was deleted or closed). A middleware for the reason `llm_metering` gives: a
    ContextVar cannot be bound inside a FastAPI yield dependency.

    Declared ABOVE `access_gate`, so it runs INSIDE the gate and
    `request.state.user_id` is already the caller. A write reaches the holder only
    for the user it was bound to, which keeps a cron request that charges many
    users from handing any of them a header. The app is same-origin in dev (the
    Vite proxy) and in production (the /api mount), so CORS needs no
    `expose_headers`.
    """
    with quota.bind_uses(getattr(request.state, "user_id", None) or None) as holder:
        response = await call_next(request)
    if holder.remaining is not None:
        response.headers["X-Uses-Remaining"] = str(holder.remaining)
    if holder.pass_ is not None:
        feature, calls_left, expires_in_s = holder.pass_
        response.headers["X-Uses-Pass"] = f"{feature};{calls_left};{expires_in_s}"
    return response


class _Identity(NamedTuple):
    """Everything the gate decides from — plain values, never ORM attributes."""

    user_id: int
    is_admin: bool
    signup_source: str
    verified: bool
    session_id: int | None
    auth_method: str  # "invite_code" | "session"
    renewed_until: datetime | None


def _resolve_identity(app_key: str, session_token: str, optional: bool) -> _Identity | None:
    """Resolve the request's credential to a user, stamp them as seen, and hand
    back a plain tuple.

    Every value is read INSIDE the session and AFTER its last commit, and that
    is load-bearing (Phase 29 amendment A11). `touch_last_seen` commits and so
    does a session renewal, SQLAlchemy expires every attribute on commit, and
    `db.close()` then detaches the instance — so a later `user.id` tries to
    refresh itself and raises DetachedInstanceError. It bit here once already,
    and only on the first request of each throttle window (a throttled call
    never commits, so never expires anything), which is exactly the shape that
    reaches production looking like a flake. With renewal added there are two
    such windows, so nothing after `close()` may touch the ORM at all.
    """
    from app.core.sessions import resolve_session
    from app.db.database import SessionLocal
    from app.db.models import User, UserLogin
    from app.db.users import resolve_user, touch_last_seen

    db = SessionLocal()
    try:
        user, method, session = None, "", None
        if app_key:
            user = resolve_user(db, app_key)
            method = "invite_code"
        # X-App-Key present means the invite path ONLY: a bad key 401s even
        # beside a valid cookie, so a leaked cookie can't quietly rescue it and
        # the "unknown invite code 401s" checks keep meaning what they say. The
        # one exception is an optional auth path, where a STALE stored code
        # falls through to the cookie — otherwise a friend whose code was
        # rotated loops for ever between a login that works and a feature call
        # that 401s on the old header (amendment A10).
        if user is None and session_token and (not app_key or optional):
            session = resolve_session(db, session_token)
            if session is not None:
                user = db.get(User, session.user_id)
                method = "session"
        if user is None:
            return None
        # Stamped here, on the session already open for the lookup, so it costs
        # no extra connection and covers every authenticated request —
        # including the uncapped /tools/* routes and unknown paths, which this
        # gate sees but no route dependency ever does.
        touch_last_seen(db, user)
        user_id = user.id
        is_admin = bool(user.is_admin)
        source = user.signup_source or ""
        verified_at = None
        if not is_admin and source:
            verified_at = db.execute(
                select(UserLogin.email_verified_at).where(UserLogin.user_id == user_id)
            ).scalar()
        return _Identity(
            user_id=user_id,
            is_admin=is_admin,
            signup_source=source,
            verified=is_verified(is_admin, source, verified_at),
            session_id=session.session_id if session is not None else None,
            auth_method=method,
            renewed_until=session.renewed_until if session is not None else None,
        )
    finally:
        db.close()


def _sets_session_cookie(response) -> bool:  # noqa: ANN001 - a Starlette response of any kind
    return any(v.startswith(COOKIE_NAME + "=") for v in response.headers.getlist("set-cookie"))


@app.middleware("http")
async def access_gate(request: Request, call_next):
    """Who is calling, decided once and before routing (PLAN 7.1; accounts
    since Phase 29).

    Credentials, when the gate is ON (APP_ACCESS_CODE set — the public
    deployment), in strict precedence:
      1. `X-App-Key` present => the invite-code path only (each code maps to a
         user; the admin's code IS the access code). See _resolve_identity for
         the one stale-code exception.
      2. else the `jf_session` cookie.
      3. else 401 — unless the path is _AUTH_OPTIONAL.
    With the gate OFF (local dev) a session cookie is still honoured, so a
    signed-in local user is themselves; with none, every route falls back to the
    admin exactly as before.

    Then, in this order, and credentials first so a protected route with no
    credentials still says 401:
      - CSRF. With the gate ON, every POST/PUT/PATCH/DELETE that does not carry
        X-App-Key must carry a non-empty X-Requested-With, cookie or no cookie,
        /auth/* included. The frontend sends it on every call; a cross-site form
        cannot add a custom header without a CORS preflight this app never
        grants. The cookie being SameSite=Lax is not enough on its own — a
        top-level cross-site form POST still carries a Lax cookie — and the fact
        that FastAPI happens to refuse a form body on a JSON route is an
        accident, not a defence.
        With the gate OFF (local dev) it applies only to a request carrying a
        session cookie, and to /auth/* (FIXB B18). There X-App-Key is ignored
        and a keyless request is the dev admin, so the rule used to 403 the
        installed Chrome extension and every local script — a regression a
        deploy cannot fix. The session and the cookie-issuing /auth/* doors,
        which are what login CSRF aims at, stay covered.
      - Verification. An email signup whose address is unproven reaches only
        the _AUTH_OPTIONAL and _UNVERIFIED_OK doors (403 email_unverified
        everywhere else). Invite codes and the admin are verified by
        construction, so none of the pre-accounts behaviour moves.
    """
    if request.method == "OPTIONS" or request.url.path in _GATE_EXEMPT:
        return await call_next(request)

    gate_on = bool(settings.app_access_code)
    route_path = get_route_path(request.scope)
    optional = route_path in _AUTH_OPTIONAL
    app_key = request.headers.get("x-app-key", "") if gate_on else ""
    session_token = request.cookies.get(COOKIE_NAME, "")
    ident = (
        _resolve_identity(app_key, session_token, optional)
        if app_key or session_token
        else None
    )

    if gate_on and ident is None and not optional:
        return JSONResponse({"detail": "Access code required."}, status_code=401)
    csrf_applies = gate_on or bool(session_token) or route_path.startswith("/auth/")
    if (
        csrf_applies
        and request.method in _UNSAFE_METHODS
        and not request.headers.get("x-app-key")
        and not request.headers.get("x-requested-with", "").strip()
    ):
        return JSONResponse({"detail": {"code": "csrf"}}, status_code=403)
    if ident is not None:
        if (
            not ident.verified
            and not optional
            and route_path not in _UNVERIFIED_OK
            and not (request.method == "DELETE" and route_path == "/profile/account")
        ):
            return JSONResponse({"detail": {"code": "email_unverified"}}, status_code=403)
        request.state.user_id = ident.user_id
        request.state.auth_method = ident.auth_method
        request.state.session_id = ident.session_id

    response = await call_next(request)
    # A session that slid forward gets its cookie re-issued with the new
    # lifetime; otherwise the browser drops it one TTL after sign-in and the
    # renewal is decorative. Not when the route itself just set or cleared the
    # cookie (a logout, a fresh sign-in) — re-issuing then would resurrect it.
    if ident is not None and ident.renewed_until is not None and not _sets_session_cookie(response):
        set_session_cookie(response, request, session_token, ident.renewed_until)
    return response


app.include_router(router)
app.include_router(auth_router)
app.include_router(inbox_router)


@app.get("/")
def root() -> dict[str, str]:
    return {"name": "JobFinder API", "docs": "/docs"}
