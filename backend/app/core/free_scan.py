"""Free public CV-vs-JD scan — 100% deterministic, zero LLM calls.

The landing-page wedge (PLAN 6): a visitor drops a resume and pastes a JD and
gets the keyword-coverage half of the scorer with no access code and no
persistence. Because this path is free to serve, it must never call the LLM:
JD keywords come from a pure frequency heuristic (not the JD analyzer), and
matching reuses the scorer's own deterministic `keyword_analysis`, so the
numbers here agree with the full product's coverage score.

Hebrew-safe end to end: the shared tokenizer already covers the Hebrew block,
and fully-missing Hebrew keywords get a second chance with the common
single-letter prefixes (ו ב ל מ ש כ ה) stripped — counted as "partial", never
"covered", so the free score stays honest.
"""
from __future__ import annotations

import re
import threading
import time
from collections import Counter, deque

from app.core.lang import detect_language
from app.core.scorer import _WORD_RE, keyword_analysis
from app.models import FreeScanCheck, FreeScanResult, GapItem, JDModel, ResumeModel

# --------------------------------------------------------------------------- #
# JD keyword extraction (deterministic — the free path never calls the LLM)
# --------------------------------------------------------------------------- #
# Function words + JD boilerplate that would otherwise dominate by frequency.
# Deliberately conservative on domain words (e.g. "business", "team" stay in:
# "business analyst" / "עבודת צוות" are real keywords).
_EN_STOP = frozenset(
    """
    a an the and or of to in on at for with from by as is are was were be been
    being it its this that these those you your yours we our ours us they their
    them he she his her i me my will would can could should shall may might
    have has had do does did done not no if then than so but about into over
    under up down out off all any both each few more most other some such only
    own same very s t just also etc eg ie e.g i.e per via plus through during
    between while what which who whom when where how why because
    experience experienced years year work working works worked ability
    abilities able strong excellent good great skills skill knowledge
    familiarity familiar understanding proficiency proficient required
    requirements requirement require requires preferred preference advantage
    must responsibilities responsible responsibility role position job company
    candidate candidates ideal looking join joining opportunity opportunities
    benefits salary location full part time apply application applications
    including include includes included within across using use used uses help
    helps day daily new well high level least minimum related relevant
    environment qualifications qualification description duties seeking hiring
    hire ll re ve
    """.split()
)
_HE_STOP = frozenset(
    """
    של את על עם גם או אם לא כל זה זו זאת הוא היא הם הן אנחנו אנו אני אתה יש
    אין בין עד כמו כי מה מי אשר כדי כגון וכן וכו עוד רק כבר מאוד יותר פחות
    ביותר אחר אחרים אחרת כולל לפחות בעל בעלי בעלת בו בה אך כך כן לו לה אל מן
    שנה שנים שנות ניסיון נסיון ידע הכרות היכרות הבנה יכולת יכולות רקע חובה
    יתרון דרישות דרישה נדרש נדרשת נדרשים דרוש דרושה דרושים דרושות תפקיד
    התפקיד לתפקיד משרה המשרה למשרה מלאה חלקית היקף עבודה העבודה לעבודה מחפשים
    מחפשת מחפש להצטרף הצטרפו חברה החברה לחברה חברת אודות תיאור תנאים שליחת
    קורות חיים בתחום תחום לתחום עדיפות אפשרות אפשרויות ומעלה כחלק חלק במסגרת
    """.split()
)
_PURE_NUMBER_RE = re.compile(r"\d+(?:\.\d+)*")
# A letter next to a digit / + / # / . reads as a tech term (c++, .net, b2b).
_TECHY_RE = re.compile("(?=.*[a-z\\u0590-\\u05FF])(?=.*[\\d+#.])", re.IGNORECASE)


def _is_stopword(token: str) -> bool:
    return token in _EN_STOP or token in _HE_STOP


def _keepable(token: str) -> bool:
    return len(token) >= 2 and not _is_stopword(token) and not _PURE_NUMBER_RE.fullmatch(token)


def extract_jd_keywords(jd_text: str, cap: int = 30) -> list[str]:
    """Pure frequency heuristic: non-stopword tokens ranked by how often the
    JD repeats them (repeated bigrams like "machine learning" outrank their
    parts), with a bump for tech-looking tokens (c++, node.js, ...) and for
    words the JD capitalizes. Display casing is the first original occurrence.
    """
    # The shared tokenizer keeps "." for node.js-style terms, which also glues
    # sentence-final periods onto words ("Developer." != "developer") — strip
    # trailing dots. _WORD_RE is lowercase-only for Latin, so tokenize the
    # lowered text and keep a parallel original-cased scan for display casing.
    original = [t.rstrip(".") for t in _WORD_RE.findall(jd_text)]
    lowered = [t.rstrip(".") for t in _WORD_RE.findall(jd_text.lower())]
    display: dict[str, str] = {}
    for tok in original:
        display.setdefault(tok.lower(), tok)

    kept = [t for t in lowered if _keepable(t)]
    if not kept:
        return []
    uni_freq = Counter(kept)

    # Bigrams over tokens adjacent in the raw stream (no stopword in between).
    bi_freq: Counter[tuple[str, str]] = Counter()
    for a, b in zip(lowered, lowered[1:]):
        if _keepable(a) and _keepable(b):
            bi_freq[(a, b)] += 1
    bigrams = [(pair, n) for pair, n in bi_freq.items() if n >= 2]

    def uni_score(token: str) -> float:
        score = float(uni_freq[token])
        if _TECHY_RE.search(token):
            score += 1.5
        if any(c.isupper() for c in display.get(token, "")):
            score += 1.0
        return score

    first_index = {}
    for i, t in enumerate(kept):
        first_index.setdefault(t, i)

    ranked_bi = sorted(bigrams, key=lambda kv: (-kv[1], first_index[kv[0][0]]))
    in_bigram = {t for (a, b), _ in ranked_bi for t in (a, b)}
    ranked_uni = sorted(
        (t for t in uni_freq if t not in in_bigram),
        key=lambda t: (-uni_score(t), first_index[t]),
    )

    keywords = [f"{display.get(a, a)} {display.get(b, b)}" for (a, b), _ in ranked_bi]
    keywords += [display.get(t, t) for t in ranked_uni]
    return keywords[:cap]


# --------------------------------------------------------------------------- #
# Matching (reuses the scorer's deterministic keyword_analysis)
# --------------------------------------------------------------------------- #
# Single-letter Hebrew prefixes (conjunction/prepositions/article) that glue
# onto the next word: ו ב ל מ ש כ ה. "בפייתון" in a JD vs "פייתון" on a CV.
_HE_PREFIXES = "ובלמשכה"


def _hebrew_prefix_variants(word: str) -> list[str]:
    """Up to two leading prefixes stripped, never below 3 letters (so real
    words like בנק or מנהל can't be truncated into noise)."""
    out: list[str] = []
    w = word
    for _ in range(2):
        if w and w[0] in _HE_PREFIXES and len(w) > 3:
            w = w[1:]
            out.append(w)
        else:
            break
    return out


def _prefix_rescue(keyword: str, resume_text: str) -> bool:
    """True when every word of a fully-missing Hebrew keyword appears in the
    resume once its glued prefix is stripped (JD "בפייתון" vs CV "פייתון")."""
    parts = _WORD_RE.findall(keyword.lower())
    if not parts:
        return False
    rescued_any = False
    for part in parts:
        if part in resume_text:
            continue
        variants = _hebrew_prefix_variants(part)
        if variants and any(v in resume_text for v in variants):
            rescued_any = True
            continue
        return False
    return rescued_any


def _recompute_coverage(gaps: list[GapItem]) -> float:
    if not gaps:
        return 0.0
    covered = sum(1.0 if g.status == "covered" else 0.5 if g.status == "partial" else 0.0 for g in gaps)
    return round(100.0 * covered / len(gaps), 1)


# --------------------------------------------------------------------------- #
# Raw-text resume checks (the ats_scan spirit, without needing the LLM
# structurer — ids are stable so the UI can translate them)
# --------------------------------------------------------------------------- #
_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_PHONE_RE = re.compile(r"\+?\d[\d\s().\-]{7,}\d")


def _resume_checks(resume_text: str) -> list[FreeScanCheck]:
    checks = [
        FreeScanCheck(id="email", severity="good" if _EMAIL_RE.search(resume_text) else "warn"),
        FreeScanCheck(id="phone", severity="good" if _PHONE_RE.search(resume_text) else "warn"),
    ]
    words = len(_WORD_RE.findall(resume_text.lower()))
    checks.append(
        FreeScanCheck(id="length", severity="good" if 120 <= words <= 1200 else "warn", value=str(words))
    )
    numbers = len(re.findall(r"\d+", resume_text))
    checks.append(FreeScanCheck(id="numbers", severity="good" if numbers >= 3 else "warn", value=str(numbers)))
    return checks


def free_scan(resume_text: str, jd_text: str) -> FreeScanResult:
    """The whole free scan: extract keywords, run the scorer's deterministic
    coverage on the raw resume text, rescue prefix-glued Hebrew misses as
    partial, and add the raw-text checks. Pure — no LLM, no DB, no network."""
    keywords = extract_jd_keywords(jd_text)
    # Wrap the raw text so keyword_analysis (which reads structured resumes)
    # sees it verbatim — same containment + token matching as the paid path.
    _, gaps = keyword_analysis(ResumeModel(summary=resume_text), JDModel(keywords=keywords))
    lowered_resume = resume_text.lower()
    for gap in gaps:
        if gap.status == "missing" and _prefix_rescue(gap.keyword, lowered_resume):
            gap.status = "partial"
            gap.suggestion = ""
    return FreeScanResult(
        coverage=_recompute_coverage(gaps),
        keywords=gaps,
        checks=_resume_checks(resume_text),
        jd_language=detect_language(jd_text),
        resume_language=detect_language(resume_text),
    )


# --------------------------------------------------------------------------- #
# Rate limiting (the endpoint is public — best-effort, in-process)
# --------------------------------------------------------------------------- #
class RateLimiter:
    """Sliding-window per-key limiter. In-process only, which is fine for a
    best-effort free tier: on serverless each instance gets its own window."""

    def __init__(self, max_requests: int = 20, window_seconds: float = 3600.0):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str, now: float | None = None) -> bool:
        ts = time.monotonic() if now is None else now
        with self._lock:
            hits = self._hits.setdefault(key, deque())
            while hits and ts - hits[0] >= self.window_seconds:
                hits.popleft()
            if len(hits) >= self.max_requests:
                return False
            hits.append(ts)
            # Don't let one-off keys accumulate forever.
            if len(self._hits) > 10_000:
                for k in [k for k, v in self._hits.items() if not v or ts - v[-1] >= self.window_seconds]:
                    del self._hits[k]
            return True


free_scan_limiter = RateLimiter()
