"""The model half of the inbox scanner (Phase 29 / B2): INBOX_CLASSIFY.

Only mail the deterministic stage could not decide reaches this, and the model
is not trusted with the answer — the `review_rewrites` shape: whatever it
returns is post-validated here before anything reads it.

- `kind` outside the enum becomes "other"; `confidence` is clamped to 0..1.
- `evidence` must be a verbatim quote of what the model was shown (whitespace
  normalised on both sides). If it is not, it is emptied and confidence drops by
  0.2 — an answer that cannot point at its own reason is more likely to wait in
  Needs review than to move a card.
- A platform as `company` is emptied: "LinkedIn" delivered the mail, it is not
  the employer, and a card named after it would collect every LinkedIn email.
- `is_job_related` false forces kind "other", and the caller stores nothing.

ITS OWN CLIENT. `get_inbox_llm_client` builds a SEPARATE `OpenAIClient` on
INBOX_MODEL_ID. A client remembers, for the life of the process, every optional
parameter a model has rejected — so a cheap model that refuses `temperature`
would strip it from every TAILOR call if the two shared an instance, the trap
CLAUDE.md records for per-task routing. For the same reason the caller meters
this model's tokens under `inbox_tokens`, never `tokens`: two price tiers must
not blend into one row nobody can split again.

Patch `inbox_classifier.get_inbox_llm_client` to observe the calls — never
`app.llm.client`'s factory, whose name is not what this module calls.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any

from app.config import get_settings
from app.core.inbox_rules import KINDS, MessageMeta, Verdict, is_platform_name
from app.llm import prompts
from app.llm.client import LLMClient, OpenAIClient, StubClient

# Provisional: the real-key A/B in tests/inbox_eval.py decides the default.
DEFAULT_MODEL = "gpt-4.1-nano"
EVIDENCE_MAX = 200
EVIDENCE_PENALTY = 0.2


@lru_cache
def get_inbox_llm_client() -> LLMClient:
    """The classifier's client: the stub offline, else its own OpenAIClient."""
    settings = get_settings()
    if settings.use_stub_llm or not settings.openai_api_key:
        return StubClient()
    return OpenAIClient(settings.openai_api_key, (settings.inbox_model_id or "").strip() or DEFAULT_MODEL)


def prompt_for(meta: MessageMeta, body: str) -> tuple[str, str]:
    """(system, user) for one email — exactly what the model is shown, which is
    also what `evidence` has to quote."""
    sender = f"{meta.from_name} <{meta.from_email}>" if meta.from_name else (meta.from_email or "")
    date = ""
    if meta.internal_ms > 0:
        try:
            date = datetime.fromtimestamp(meta.internal_ms / 1000, timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        except (OverflowError, OSError, ValueError):
            date = ""
    user = prompts.inbox_classify_user(sender, meta.subject or "", date, meta.snippet or "", body or "")
    return prompts.INBOX_CLASSIFY_SYSTEM, user


def classify(meta: MessageMeta, body: str, *, client: LLMClient | None = None) -> Verdict:
    """One model call for one email. Raises whatever the client raises — the
    sync decides which failures skip a message and which stop the run."""
    system, user = prompt_for(meta, body)
    raw = (client or get_inbox_llm_client()).complete_json(system, user)
    return validate(raw if isinstance(raw, dict) else {}, shown=user)


def _collapse(value: str) -> str:
    return " ".join(value.split())


def _text(value: Any, limit: int) -> str:
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return ""
    return _collapse(str(value))[:limit]


def validate(raw: dict[str, Any], shown: str) -> Verdict:
    """The model's JSON -> a Verdict nothing downstream has to distrust."""
    kind = str(raw.get("kind") or "").strip().lower()
    if kind not in KINDS:
        kind = "other"
    flag = raw.get("is_job_related")
    is_job = flag if isinstance(flag, bool) else str(flag).strip().lower() in {"true", "yes", "1"}
    try:
        confidence = float(raw.get("confidence"))
    except (TypeError, ValueError):
        confidence = 0.0
    if math.isnan(confidence):
        confidence = 0.0
    confidence = min(1.0, max(0.0, confidence))
    company = _text(raw.get("company"), 255)
    title = _text(raw.get("job_title"), 255)
    interview_at = _text(raw.get("interview_at"), 40)
    evidence = _text(raw.get("evidence"), EVIDENCE_MAX)
    if company and is_platform_name(company):
        company = ""
    if evidence and evidence not in _collapse(shown):
        evidence = ""
        confidence = max(0.0, confidence - EVIDENCE_PENALTY)
    if not is_job:
        kind = "other"
    return Verdict(
        kind=kind,
        company=company,
        job_title=title,
        confidence=round(confidence, 3),
        method="llm",
        evidence=evidence,
        interview_at=interview_at,
        is_job_related=is_job,
    )
