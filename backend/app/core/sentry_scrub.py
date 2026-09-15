"""What reaches Sentry: never a secret, never mail content (Phase 29 review, FIXB B2).

sentry-sdk 2.x defaults to `include_local_variables=True`, and its built-in
scrubber drops only exact key names. So one unexpected exception inside an inbox
sync sent every frame's locals to Sentry: the `Settings` object (OPENAI_API_KEY,
CRON_SECRET and the rest, up to the 1024-character value cap) and the message
metadata the sync was handling (subjects, snippets, senders). Measured, not
assumed, in the review's probe.

Two layers, because either alone has a gap:

- `include_local_variables=False` stops frame variables at the source.
- `scrub_event` (before_send) drops any frame `vars` that still arrive (a future
  integration, a changed default) and replaces every configured secret VALUE
  wherever it appears in the event — a message, an exception string, a
  breadcrumb. If scrubbing itself fails, the event is DROPPED: an unscrubbed
  event is the one outcome this module exists to prevent.

Mail content cannot be recognised by value the way a secret can, so the inbox
sync logs its failures with the exception TYPE and the failing frame's location
only — never its message and never a traceback (`inbox_sync._failure_site`).

An OAuth callback's query string cannot be recognised by value either: Google
sends the browser back with a one-time `code` and our `state`, and the ASGI
integration attaches the query string to every event. So an event from either
callback (the Gmail connect's and Continue with Google's) loses its query string
outright (Phase 30 / E2).

`main.py` builds its `sentry_sdk.init` call from `sentry_init_options`, and the
smoke test initialises the real SDK from the same function, so the options the
check drives are the options production runs with.
"""
from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from app.config import Settings, get_settings

REDACTED = "[redacted]"
# A setting whose NAME contains one of these holds a credential. Only string
# values of at least _MIN_SECRET_LEN characters are redacted, so a blank or a
# short word can never start rewriting ordinary text.
_SECRET_NAME_PARTS = ("key", "secret", "password", "token", "dsn", "access_code", "database_url")
_MIN_SECRET_LEN = 6
# Both OAuth callbacks end with this: /api/inbox/google/callback and
# /api/auth/google/callback.
_CALLBACK_SUFFIX = "/google/callback"


def secret_values(settings: Settings) -> list[str]:
    """Every configured secret value, longest first (so a secret that contains
    another is replaced whole)."""
    found: set[str] = set()
    for name, value in settings.model_dump().items():
        if not isinstance(value, str):
            continue
        text = value.strip()
        if len(text) >= _MIN_SECRET_LEN and any(part in name.lower() for part in _SECRET_NAME_PARTS):
            found.add(text)
    return sorted(found, key=len, reverse=True)


def _drop_frame_vars(value: Any) -> None:
    if isinstance(value, dict):
        if "vars" in value and ("function" in value or "filename" in value or "lineno" in value):
            value.pop("vars", None)
        for child in value.values():
            _drop_frame_vars(child)
    elif isinstance(value, list):
        for child in value:
            _drop_frame_vars(child)


def _drop_callback_query(event: dict[str, Any]) -> None:
    """No query string on an event from an OAuth callback: it carries the
    authorization code and the state, and neither is a configured secret."""
    request = event.get("request")
    if not isinstance(request, dict):
        return
    url = request.get("url")
    path = urlsplit(url).path if isinstance(url, str) else ""
    if path.rstrip("/").endswith(_CALLBACK_SUFFIX):
        request.pop("query_string", None)
        request["url"] = url.split("?", 1)[0].split("#", 1)[0]


def _redact(value: Any, secrets: list[str]) -> Any:
    if isinstance(value, str):
        for secret in secrets:
            if secret in value:
                value = value.replace(secret, REDACTED)
        return value
    if isinstance(value, dict):
        return {key: _redact(child, secrets) for key, child in value.items()}
    if isinstance(value, list):
        return [_redact(child, secrets) for child in value]
    if isinstance(value, tuple):
        return tuple(_redact(child, secrets) for child in value)
    return value


def scrub_event(event: dict[str, Any], hint: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """Sentry's before_send: no frame variables, no configured secret, and no
    query string from an OAuth callback. None (drop the event) whenever
    scrubbing cannot be completed."""
    try:
        secrets = secret_values(get_settings())
        _drop_frame_vars(event)
        _drop_callback_query(event)
        return _redact(event, secrets)
    except Exception:  # noqa: BLE001 - an unscrubbed event must never be sent
        return None


def sentry_init_options(settings: Settings) -> dict[str, Any]:
    """The keyword arguments for `sentry_sdk.init`. Request bodies are never
    captured (resume and job-ad text travel in them) and PII stays off."""
    return {
        "dsn": settings.sentry_dsn,
        "environment": settings.sentry_environment,
        "send_default_pii": False,
        "max_request_body_size": "never",
        "traces_sample_rate": 0.0,
        "include_local_variables": False,
        "before_send": scrub_event,
    }
