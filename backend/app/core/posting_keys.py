"""A posting's two identities: its ADDRESS, and its ROLE at its company.

Pure functions, pinned that way through the AST (smoke, Phase 32 "applied jobs"):
no model, no network, no clock. Each was written beside the first code that
needed it (`job_match`, `job_search`, `db/history`) and moved here, answering
what it answered before, so that a deterministic module could use them:
`applied_jobs` decides which postings a person is never shown again, and may
import nothing that can reach the network. The old names still resolve
(`job_search.content_key`, `job_match._linkedin_job_id`), so no caller changed.
"""

from __future__ import annotations

import re


def linkedin_job_id(url: str) -> str:
    """Pull the numeric posting id out of any LinkedIn job URL shape:
    /jobs/view/<id>, /jobs/view/<slug>-<id>, ?currentJobId=<id>, or a guest api url."""
    for pat in (
        r"/jobs/view/(?:[^/?#]*?-)?(\d{6,})",
        r"[?&]currentJobId=(\d{6,})",
        r"/jobPosting/(\d{6,})",
    ):
        m = re.search(pat, url)
        if m:
            return m.group(1)
    return ""


# Query parameters that NAME a posting, on a board whose path does not: JobMaster
# writes every posting as `/jobs/checknum.asp?key=<N>`, and Greenhouse sends a
# company's own careers page as `…?gh_jid=<N>`. Every other parameter is tracking
# or session noise (LinkedIn's `refId` and `trackingId`, a `utm_*`), which is why
# the query was dropped in the first place.
_ID_PARAMS = frozenset({"key", "gh_jid"})


def url_key(url: str) -> str:
    """The tracker's key for a posting's address: what a search result, a History
    row and a tracker row are matched by (`history.applied_status_map`,
    `stamp_applied`, the applied filter). "" for no address, which never matches.

    LinkedIn's posting id wherever the URL carries one, because the tracker's copy
    and a search card's differ in shape for the same posting (a slug or a bare id,
    a regional host, tracking parameters). Otherwise the URL trimmed, without its
    trailing slash, and without its query EXCEPT the parameters that name the
    posting (`_ID_PARAMS`).

    That exception is a fix (Phase 32): the query used to go whole, so every
    JobMaster posting had ONE key, and a single tracked JobMaster job stamped its
    status, and its row's id, on every JobMaster result. Harmless-looking as a
    badge; as the key of a filter that removes applied jobs it would have removed
    every JobMaster posting after one application."""
    raw = (url or "").strip()
    jid = linkedin_job_id(raw)
    if jid:
        return jid
    base, _, query = raw.partition("?")
    base = base.rstrip("/")
    ids = sorted(
        part
        for part in query.split("&")
        if part.partition("=")[0] in _ID_PARAMS and part.partition("=")[2]
    )
    return f"{base}?{'&'.join(ids)}" if base and ids else base


# Cross-board duplicate detection (PLAN 15.1). Legal suffixes stripped from
# company names so "Acme Ltd" (Drushim) matches "Acme" (LinkedIn); anything
# fancier (similarity scoring) risks merging genuinely different roles, so the
# fingerprint is exact title + company after normalization, or nothing.
_CONTENT_NORM_RE = re.compile(r"\W+", re.UNICODE)
# Hebrew acronyms write their quote INSIDE the word (בע"מ, ע"ר) — strip those
# marks before word-splitting so the acronym survives as one token.
_ACRONYM_MARKS_RE = re.compile(r"[\"'׳״]")
_COMPANY_LEGAL = {"ltd", "limited", "inc", "llc", "corp", "gmbh", "בעמ"}


def content_key(title: str, company: str) -> str:
    """Fingerprint for 'same posting on another board': normalized title +
    company. Returns "" (never merge) when either half is empty — merging on
    title alone would collapse different companies' identical roles. Pure;
    pinned by the smoke test."""
    t_words = _CONTENT_NORM_RE.sub(" ", _ACRONYM_MARKS_RE.sub("", title.lower())).split()
    c_words = [
        w
        for w in _CONTENT_NORM_RE.sub(" ", _ACRONYM_MARKS_RE.sub("", company.lower())).split()
        if w not in _COMPANY_LEGAL
    ]
    if not t_words or not c_words:
        return ""
    return " ".join(t_words) + "|" + " ".join(c_words)
