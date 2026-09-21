"""The inbox scanner's deterministic stage (Phase 29 / B2): what an email is
before any model sees it.

THIS MODULE MAY NEVER REACH THE MODEL OR THE NETWORK, and that is source-pinned
through the AST — the geo_restriction / keyword_guard shape, because this
docstring names the forbidden things in order to promise it does not use them
and a grep cannot tell a promise from an import. Three reasons it is code:

- Most job-flavoured mail a job seeker receives is not an employer reply but an
  alert digest ("X is hiring", "New jobs similar to…", AllJobs' daily list).
  Measured on a real inbox (2026-09-13, subjects and senders only), digests were
  the majority of everything a job vocabulary matched. Dropped here, they cost no
  body read, no model call, and are never stored.
- The templated signals — LinkedIn's "your application was sent to X", an ATS
  "thanks for applying to X" — are exact enough that a rule beats a model at
  temperature, and are the commonest way a tracker row starts.
- Every tracker write that follows is undoable only if it is explainable, and a
  rule answers the same way on every run.

Four questions, asked in this order by `inbox_sync`:
  1. `noise_reason`     — an alert digest, or our own alert mail: drop it.
  2. `template_verdict` — a templated confirmation or "viewed": decide it here.
  3. `candidate_reason` — job vocabulary or an ATS sender: worth a model call.
  4. anything else      — skipped: never read past its headers, never stored.

Plus what `inbox_apply` matches with (`normalize_company`, `company_matches`,
`title_similarity`) and `build_query`, the server-side Gmail search that narrows
what is listed at all (amendment I1).

The company legal-suffix table is this module's OWN copy. `job_search` has one,
but importing it would drag the search stack — providers, the scorer, the model
client — into a module pinned to have none of it.

Hebrew is matched as bare substrings, never with a word boundary: ב/ל/ה/ו/מ/ש
glue onto the word and Python counts them as word characters, so `\\bראיון`
misses "לראיון". The Python twin of check-mirrors check 10.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

KINDS = ("confirmation", "viewed", "interview", "assessment", "offer", "rejection", "recruiter", "other")
STATUSES = ("saved", "applied", "interview", "offer", "rejected")


@dataclass(frozen=True)
class MessageMeta:
    """One message as the metadata read returns it: headers and snippet, no body.

    Defined here rather than beside the Gmail client so this module can type
    what it reads without importing anything that talks to the network."""

    id: str
    thread_id: str = ""
    internal_ms: int = 0  # Gmail's internalDate, epoch milliseconds
    from_name: str = ""
    from_email: str = ""
    subject: str = ""
    snippet: str = ""
    rfc822_id: str = ""  # the Message-ID header, without angle brackets
    list_unsubscribe: str = ""


@dataclass(frozen=True)
class Verdict:
    """What one email says about an application, from a rule or the model."""

    kind: str
    company: str = ""
    job_title: str = ""
    confidence: float = 1.0
    method: str = "rule"  # rule | llm
    evidence: str = ""  # verbatim from the email, at most 200 characters
    interview_at: str = ""
    is_job_related: bool = True


# --- senders ---------------------------------------------------------------------
LINKEDIN_APPLICATIONS = "jobs-noreply@linkedin.com"
# Senders that send NOTHING but alerts, so the Gmail query excludes them outright.
# LinkedIn's jobs-noreply, AllJobs and Glassdoor are NOT here: each also sends the
# application confirmations this scanner exists to read, so they are filtered by
# subject below instead.
ALERT_ONLY_ADDRESSES = ("jobalerts-noreply@linkedin.com",)
ALERT_ONLY_DOMAINS = ("jobalert.indeed.com", "xplace.com")
ATS_DOMAINS = (
    "greenhouse.io", "greenhouse-mail.io", "ashbyhq.com", "lever.co", "comeet.co", "comeet.com",
    "myworkday.com", "myworkdayjobs.com", "workablemail.com", "smartrecruiters.com", "icims.com",
    "jobvite.com", "bamboohr.com", "recruitee.com", "teamtailor.com", "hibob.com", "taleo.net",
    "breezy.hr", "pinpointhq.com",
)
# SuccessFactors mails from regional hosts (performancemanager5.successfactors.eu,
# …), so it is matched by label rather than by one suffix.
_SUCCESSFACTORS = "successfactors"
JOB_BOARD_DOMAINS = (
    "linkedin.com", "indeed.com", "glassdoor.com", "drushim.co.il", "alljob.co.il", "jobmaster.co.il",
)


def _address(meta: MessageMeta) -> str:
    return (meta.from_email or "").strip().lower()


def _domain(address: str) -> str:
    return address.rsplit("@", 1)[-1] if "@" in address else ""


def _domain_in(domain: str, domains: tuple[str, ...]) -> bool:
    return any(domain == d or domain.endswith("." + d) for d in domains)


def is_ats_sender(meta: MessageMeta) -> bool:
    domain = _domain(_address(meta))
    return bool(domain) and (
        _domain_in(domain, ATS_DOMAINS) or _SUCCESSFACTORS in domain.split(".")
    )


def _job_sender(meta: MessageMeta) -> bool:
    return is_ats_sender(meta) or _domain_in(_domain(_address(meta)), JOB_BOARD_DOMAINS)


# --- 1. noise ------------------------------------------------------------------------
_LINKEDIN_DIGEST = re.compile(
    r"\bis hiring\b|\bnew jobs similar to\b|\bjobs similar to\b|\bapply now to\b"
    r"|\bjobs picked for you\b|\bdiscover roles\b|\blooking for a new job\b",
    re.IGNORECASE,
)
_ALLJOBS_DOMAIN = ("alljob.co.il",)
_ALLJOBS_DIGEST = ("עלתה משרה חדשה", "כל המשרות שעלו", "חשבנו עליך")
_GLASSDOOR_DOMAIN = ("glassdoor.com",)
_GLASSDOOR_DIGEST = re.compile(r"\bjobs? for you\b|\bnew jobs?\b|\bjob alert\b|\band \d+ more\b", re.IGNORECASE)


def noise_reason(meta: MessageMeta, own_senders: tuple[str, ...] | list[str] = ()) -> str:
    """Why this message is an alert digest rather than a reply ("" when it is not).

    `own_senders` is the address our OWN job-alert mail goes out from
    (ALERT_EMAIL_FROM / ALERT_SMTP_USER): the alert email is full of job titles
    and would otherwise read as twenty job events every morning.
    """
    address = _address(meta)
    domain = _domain(address)
    subject = meta.subject or ""
    own = {(s or "").strip().lower() for s in own_senders if (s or "").strip()}
    if address and address in own:
        return "own_alert"
    if address == LINKEDIN_APPLICATIONS and _LINKEDIN_DIGEST.search(subject):
        return "linkedin_digest"
    if address in ALERT_ONLY_ADDRESSES or (domain and _domain_in(domain, ALERT_ONLY_DOMAINS)):
        return "alert_sender"
    if domain and _domain_in(domain, _ALLJOBS_DOMAIN) and any(p in subject for p in _ALLJOBS_DIGEST):
        return "alljobs_digest"
    if domain and _domain_in(domain, _GLASSDOOR_DOMAIN) and _GLASSDOOR_DIGEST.search(subject):
        return "glassdoor_digest"
    return ""


# --- 2. templates --------------------------------------------------------------------
_REPLY_PREFIX = re.compile(r"^\s*(?:re|fwd?|fw)\s*:", re.IGNORECASE)
_SENT_TO = re.compile(r"^(?:.+?,\s*)?your application was sent to\s+(?P<company>.+?)\s*$", re.IGNORECASE)
_VIEWED_BY = re.compile(r"^(?:.+?,\s*)?your application was viewed by\s+(?P<company>.+?)\s*$", re.IGNORECASE)
_APPLICATION_TO_AT = re.compile(
    r"^your application to\s+(?P<title>.+)\s+at\s+(?P<company>.+?)\s*$", re.IGNORECASE
)
_THANKS_FOR_APPLYING = re.compile(
    r"^thank(?:s| you) for applying (?:to|at)\s+(?P<company>.+?)\s*!?\s*$", re.IGNORECASE
)
_HE_THANKS = re.compile(r"תודה על (?:הגשת )?מועמדות")
# Language that means a DECISION or a next step. A template never decides a mail
# carrying any of it: "Thank you for applying to X" is also the opening line of
# the commonest rejection there is, and "your application was sent" threads can
# carry an interview invite. Those go to the model instead.
_DECISION_EN = re.compile(
    r"\bother (?:applicants|candidates)\b|\bnot to proceed\b|\b(?:move|moving) forward with other\b"
    r"|\bunfortunately\b|\bschedul\w*|\binterview\w*|\bregret\b|\bnot (?:be )?(?:moving|going) forward\b"
    r"|\bdecided not\b|\bposition (?:has been|was) filled\b|\boffer\b|\bassessment\b|\bassignment\b"
    r"|\bcoding (?:test|challenge)\b",
    re.IGNORECASE,
)
_DECISION_HE = ("לצערנו", "ראיון", "הצעת עבודה", "מטלה", "מטלת", "לא להמשיך", "לתאם")
_LINKEDIN_PHRASE = re.compile(r"your application was (?:sent to|viewed by)", re.IGNORECASE)
_NOT_A_TITLE = re.compile(r"^(?:applied on|view (?:job|application)|now,|see (?:more|all)|your update)", re.IGNORECASE)


def _decision_language(meta: MessageMeta) -> bool:
    text = f"{meta.subject or ''}\n{meta.snippet or ''}"
    return bool(_DECISION_EN.search(text)) or any(w in text for w in _DECISION_HE)


def _clean(value: str, limit: int = 255) -> str:
    return " ".join((value or "").split()).strip(" \t\"'‘’“”!.,:;")[:limit]


def _plausible_title(line: str, company: str) -> bool:
    text = _clean(line, 400)
    if not 2 <= len(text) <= 120 or "·" in text or _NOT_A_TITLE.match(text):
        return False
    return normalize_company(text) != normalize_company(company)


def _title_after_phrase(text: str, company: str) -> str:
    """The role on a LinkedIn 'sent to' / 'viewed by' mail (amendment I7).

    The pinned pattern: the line AFTER the line carrying the phrase. A Gmail
    snippet flattens that layout onto one line ("…sent to Acme Solutions
    Engineer Acme · Tel Aviv…"), so the flat form is read too: the words between
    the company and its own name again ahead of the "·".
    """
    lines = [ln.strip() for ln in (text or "").splitlines()]
    if len(lines) > 1:
        for i, line in enumerate(lines):
            if _LINKEDIN_PHRASE.search(line):
                nxt = next((x for x in lines[i + 1:] if x), "")
                return _clean(nxt) if _plausible_title(nxt, company) else ""
    flat = " ".join((text or "").split())
    if company:
        m = re.search(
            r"(?:was sent to|was viewed by)\s+" + re.escape(company) + r"\s+(?P<title>.+?)\s+"
            + re.escape(company) + r"\s*[·•|]",
            flat,
            re.IGNORECASE,
        )
        if m and _plausible_title(m.group("title"), company):
            return _clean(m.group("title"))
    return ""


_TITLE_EN = (
    re.compile(
        r"\b(?:for|to|in) the\s+(?P<title>[^.,;:!?\n()]{2,80}?)\s+(?:role|position|job|opening|vacancy)\b",
        re.IGNORECASE,
    ),
    re.compile(r"\bthe position of\s+(?P<title>[^.,;:!?\n()]{2,80}?)(?=\s+at\b|[.,;:!?\n]|$)", re.IGNORECASE),
    re.compile(
        r"\bapplication for\s+(?:the\s+)?(?P<title>[^.,;:!?\n()]{2,80}?)(?=\s+at\b|[.,;:!?\n]|$)",
        re.IGNORECASE,
    ),
)
_TITLE_HE = re.compile(r"(?:לתפקיד|למשרת|למשרה|משרת)\s*:?\s+(?P<title>[^.,;:!?\n()]{2,60}?)(?=\s+בחברת|[.,;:!?\n]|$)")


def title_from_text(text: str) -> str:
    """A role named the way confirmation mail names one ("for the X role",
    "לתפקיד X"), or "" — never a guess."""
    for pattern in _TITLE_EN:
        m = pattern.search(text or "")
        if m:
            return _clean(m.group("title"))
    m = _TITLE_HE.search(text or "")
    return _clean(m.group("title")) if m else ""


def template_verdict(meta: MessageMeta, body: str | None = None) -> Verdict | None:
    """A templated confirmation or "viewed" mail, decided with no model call.

    None whenever the mail carries decision language, is a reply or a forward
    (a reply on a confirmation thread is whatever the reply says), or comes from
    a sender these templates do not belong to. Every template is gated on a job
    sender — LinkedIn, an ATS, a job board — because the same subject lines are
    written by universities and landlords ("Thank you for applying to the MSc
    programme at…"), and a mail no template claims still reaches the model.

    `body` is optional: the sync passes it on a second call when the snippet
    named no role, since the title is what later mail is matched by (I7). Reading
    a body is a Gmail read, still no model.
    """
    subject = " ".join((meta.subject or "").split())
    if not subject or _REPLY_PREFIX.match(subject) or _decision_language(meta):
        return None
    domain = _domain(_address(meta))
    linkedin = bool(domain) and _domain_in(domain, ("linkedin.com",))
    if linkedin:
        for pattern, kind in ((_SENT_TO, "confirmation"), (_VIEWED_BY, "viewed")):
            m = pattern.match(subject)
            if m:
                company = _clean(m.group("company"))
                if not company:
                    return None
                title = _title_after_phrase(meta.snippet or "", company) or _title_after_phrase(body or "", company)
                return Verdict(kind, company, title, 1.0, "rule", evidence=subject[:200])
    if not _job_sender(meta):
        return None
    m = _APPLICATION_TO_AT.match(subject)
    if m:
        company = _clean(m.group("company"))
        title = _clean(m.group("title"))
        if company:
            return Verdict("confirmation", company, title, 1.0, "rule", evidence=subject[:200])
    m = _THANKS_FOR_APPLYING.match(subject)
    if m:
        company = _clean(m.group("company"))
        if company:
            title = title_from_text(meta.snippet or "") or title_from_text(body or "")
            return Verdict("confirmation", company, title, 1.0, "rule", evidence=subject[:200])
    if _HE_THANKS.search(subject):
        # The company comes from the display name, so a platform or a generic
        # team name there is no company at all (I6) — and with none, the model
        # reads the body instead of the card being named "Comeet".
        company = company_from_display_name(meta.from_name)
        if company:
            title = title_from_text(meta.snippet or "") or title_from_text(body or "")
            return Verdict("confirmation", company, title, 1.0, "rule", evidence=subject[:200])
    return None


# --- 3. candidates -------------------------------------------------------------------
_JOB_WORDS_EN = re.compile(
    r"\b(?:applications?|applied|applying|candidac(?:y|ies)|candidates?|interview\w*|positions?"
    r"|recruit\w*|hiring|jobs?|job offer|offer letter|assessment|home assignment|take[- ]home"
    r"|coding (?:test|challenge)|phone screen|next steps?|talent acquisition|resume|cv"
    # A later round rarely says "interview" above the fold: "Re: Backend Engineer -
    # final round" with a snippet about the CTO is exactly the mail worth reading.
    r"|(?:final|next|second|third|technical|onsite|on-site) (?:round|stage)|hiring (?:manager|team))\b",
    re.IGNORECASE,
)
# A role named in the SUBJECT is a job thread even when the snippet is small talk.
# Subject only: in a snippet these words are ordinary prose.
_ROLE_IN_SUBJECT = re.compile(
    r"\b(?:engineer|developer|designer|analyst|scientist|architect|programmer)s?\b", re.IGNORECASE
)
_JOB_WORDS_HE = (
    "מועמד", "משרה", "משרת", "ראיון", "תפקיד", "גיוס", "קורות חיים", "קורות החיים",
    "הצעת עבודה", "מטלת בית", "מבחן בית", "שלב הבא",
)


def candidate_reason(meta: MessageMeta) -> str:
    """Why this message is worth a model call ("" = skip it, unread and unstored).

    Reads the subject and the snippet only. Gmail's query already searched the
    body; this second stage keeps a body-only word match ("…position…" in a bank's
    footer) from costing a model call."""
    if is_ats_sender(meta):
        return "ats_sender"
    text = f"{meta.subject or ''}\n{meta.snippet or ''}"
    if _JOB_WORDS_EN.search(text) or any(w in text for w in _JOB_WORDS_HE):
        return "job_vocabulary"
    if _ROLE_IN_SUBJECT.search(meta.subject or ""):
        return "role_in_subject"
    return ""


# --- matching -------------------------------------------------------------------------
_QUOTE_MARKS = re.compile(r"[\"'`׳״‘’“”]")
_NON_WORD = re.compile(r"[\W_]+")
_COMPANY_LEGAL = frozenset({
    "ltd", "limited", "inc", "incorporated", "llc", "corp", "corporation", "gmbh", "plc", "co",
    # בע"מ loses its gershayim to _QUOTE_MARKS first, so the table holds the bare form.
    "בעמ", "טכנולוגיות",
})
_PLATFORMS = frozenset({
    "linkedin", "indeed", "comeet", "greenhouse", "lever", "workday", "ashby", "ashbyhq",
    "smartrecruiters", "teamtailor", "hackerrank", "calendly", "glassdoor", "alljobs",
    "drushim", "workable", "icims", "jobvite", "bamboohr", "hibob",
})
_GENERIC_WORDS = frozenset({
    "noreply", "no", "reply", "donotreply", "do", "not", "hr", "talent", "acquisition",
    "recruiting", "recruitment", "recruiter", "recruiters", "careers", "career", "jobs", "job",
    "team", "hiring", "notifications", "notification", "support", "info", "people", "the",
})
_GENERIC_HE = ("גיוס", "צוות", "משרות")


def _words(value: str) -> list[str]:
    return _NON_WORD.sub(" ", _QUOTE_MARKS.sub("", (value or "").lower())).split()


def normalize_company(value: str) -> str:
    """Lower-cased words, quote marks and legal suffixes gone ("Oren Systems
    Ltd." == "oren systems"). A name that is nothing BUT a suffix keeps it."""
    words = _words(value)
    kept = [w for w in words if w not in _COMPANY_LEGAL]
    return " ".join(kept or words)


def company_matches(a: str, b: str) -> bool:
    """Two NORMALISED names: equal, or one contains the other as whole words
    ("tavor" never matches inside "tavorit").

    A name under 4 characters matches only when it is one WHOLE word of the
    longer name (FIXB B10): "sap" ~ "sap labs israel", "ibm" ~ "ibm israel",
    "wix" ~ "wix com" — while "hp" never matches inside "hapoalim". It used to
    need an exact match, so a rejection from "IBM Israel" created a second,
    rejected card beside the tracked IBM one; short names are common in the
    primary market (IBM, SAP, EY, HP, NSO, Wix)."""
    if not a or not b:
        return False
    if a == b:
        return True
    short, long_ = sorted((a, b), key=len)
    if len(short) >= 4:
        return f" {short} " in f" {long_} "
    return short in long_.split()


_TITLE_FILLER = frozenset({"the", "a", "an", "of", "for", "and", "role", "position", "job"})


def title_similarity(a: str, b: str) -> float:
    """Token Jaccard over two role titles, 0.0 when either has no words."""
    ta = {w for w in _words(a) if w not in _TITLE_FILLER}
    tb = {w for w in _words(b) if w not in _TITLE_FILLER}
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def is_platform_name(value: str) -> bool:
    """Whether a "company" is really the platform that delivered the mail."""
    return any(w in _PLATFORMS for w in _words(value))


def company_from_display_name(name: str) -> str:
    """The employer a sender's display name names, or "" (amendment I6).

    A platform anywhere in it ("LinkedIn", "Comeet") means no employer at all.
    Generic team words are removed rather than disqualifying the whole name,
    because "Brightline HR" and "משאבי אנוש, גליל סופט" do name the employer —
    while "HR Team", "no-reply" and "צוות גיוס" name nobody and come back "".
    """
    raw = " ".join((name or "").split())
    if not raw or "@" in raw or is_platform_name(raw):
        return ""
    text = raw.replace("משאבי אנוש", " ")
    kept = []
    for token in re.split(r"[\s,|·:–—/\-]+", text):
        low = _QUOTE_MARKS.sub("", token.lower())
        if not low or low in _GENERIC_WORDS or len(low) == 1:
            continue
        if any(h in low for h in _GENERIC_HE):  # also "הגיוס", "וצוות"
            continue
        kept.append(token)
    return " ".join(kept)[:255]


# --- the Gmail query --------------------------------------------------------------------
_QUERY_TERMS = (
    "application", "applications", "applied", "applying", "candidacy", "candidate", "candidates",
    "interview", "interviews", "position", "recruiter", "recruiting", "hiring", "assessment",
    '"offer letter"', '"job offer"', '"home assignment"', '"coding test"', '"phone screen"',
    '"next steps"', '"final round"', '"next round"',
    "מועמדות", "מועמדותך", "מועמדותכם", "מועמד", "משרה", "משרת", "למשרת", "ראיון", "לראיון",
    "תפקיד", "לתפקיד", '"קורות חיים"', '"קורות החיים"', '"הצעת עבודה"', '"מטלת בית"',
)


# P29-SPAM-RESCUE. The one operator that makes a listing a SPAM listing. It is a
# whole query token: `gmail_api` switches `includeSpamTrash` on only when a
# query's whitespace-split tokens contain it exactly, so `-in:spam` never can.
SPAM_OPERATOR = "in:spam"


def build_query(
    after_epoch_s: int,
    before_epoch_s: int | None = None,
    exclude_senders: tuple[str, ...] | list[str] = (),
    *,
    spam: bool = False,
) -> str:
    """The Gmail search one sync window lists (amendment I1).

    Epoch SECONDS on both bounds: Gmail reads a date in `q` as midnight PST, so
    `newer_than:`/dates would shift the window by the reader's offset. Job
    vocabulary in both languages OR an ATS sender OR LinkedIn's application
    sender; never sent mail, drafts or chats; never the alert-only senders.
    `inbox_sync` still runs every listed message through the stages above — the
    query narrows what is listed, it decides nothing.

    `spam=True` is the same search restricted to Spam (P29-SPAM-RESCUE): the
    sync lists it only to PARK job mail Gmail filed there, by id, so a reply the
    user later rescues can still be imported. Nothing it lists is read unless
    the window's default listing named it too (mail moved into Spam after that
    listing, which the sync handles as inbox mail, as it did before the fix).
    """
    terms = [
        *_QUERY_TERMS,
        *(f"from:{d}" for d in ATS_DOMAINS),
        "from:successfactors.com", "from:successfactors.eu",
        f"from:{LINKEDIN_APPLICATIONS}",
    ]
    parts = [f"after:{int(after_epoch_s)}"]
    if before_epoch_s is not None:
        parts.append(f"before:{int(before_epoch_s)}")
    parts.append("{" + " ".join(terms) + "}")
    if spam:
        parts.append(SPAM_OPERATOR)
    parts += ["-in:sent", "-in:drafts", "-in:chats"]
    seen: set[str] = set()
    for sender in (*ALERT_ONLY_ADDRESSES, *ALERT_ONLY_DOMAINS, *exclude_senders):
        s = (sender or "").strip().lower()
        # Never exclude LinkedIn's application sender, whatever a setting says:
        # it carries the confirmations as well as the digests.
        if s and s not in seen and not any(c.isspace() for c in s) and s != LINKEDIN_APPLICATIONS:
            seen.add(s)
            parts.append(f"-from:{s}")
    return " ".join(parts)
