"""Leave Arabic off a TAILORED resume for a job in Israel (spec 07 / R1).

The owner's request, and the candidate's choice: the preference is OFF for
every user until they turn it on in Settings. Deterministic — no model, no
network — and it only ever REMOVES. It never adds, never rewords a sentence,
never touches the person's name or contact line, and never sees the master
resume (the caller hands it the tailored copy).

WHAT IT REMOVES, AND WHAT IT ONLY REPORTS:
  - A `languages` entry whose language IS Arabic ("Arabic", "Arab", "ערבית",
    "عربي", "العربية" — with a level or dialect word beside it, in any case).
  - The same entries in `skills` AND in `skill_groups`. A TWO-FIELD WRITE:
    `ResumeModel`'s validator keeps `skills` as the union of the groups, so
    removing it from one field alone resurrects it on the next construction.
  - Unambiguous LIST forms in prose — "Hebrew, English and Arabic" -> "Hebrew,
    English". A list form here needs a real language on its other side, and a
    clause with "between" / "from" / "בין" is left alone: "translated contracts
    between Arabic and Hebrew" is not a list, and deleting "Arabic and " from it
    would turn a true sentence into a false one.
  - EVERYTHING ELSE IS REPORTED, NEVER REWRITTEN. A sentence this module did not
    write is not one it gets to rephrase; the changelog names the section so the
    user can edit it before sending.

"United Arab Emirates" and "Saudi Arabia" are places, not the language — the
English matcher reads the word "Arabic" only.
"""
from __future__ import annotations

import re
from typing import Any

from app.models import JDModel, ResumeModel

_HE_LETTER = r"֐-׿"

# The language, as a MENTION anywhere in text.
_MENTION_EN = re.compile(r"(?<![A-Za-z])arabic(?![A-Za-z])", re.IGNORECASE)
_MENTION_HE = "ערבית"  # substring: ב/ל/ה/ו/מ/ש glue onto it
_MENTION_AR = "عربي"  # a substring of العربية / عربية too


def mentions_arabic(text: str) -> bool:
    if not text:
        return False
    return bool(_MENTION_EN.search(text)) or _MENTION_HE in text or _MENTION_AR in text


def jd_asks_for_arabic(jd: JDModel) -> bool:
    """Any requirement, preference, keyword, qualification or responsibility the
    analysed job names Arabic in. When it does, Arabic stays: leaving off a skill
    the job asks for is not what the user chose."""
    fields = (jd.hard_skills, jd.preferred_skills, jd.keywords, jd.qualifications, jd.responsibilities)
    return any(mentions_arabic(item) for items in fields for item in items)


# --------------------------------------------------------------------------- #
# Is this ENTRY the language (and nothing else)?
# --------------------------------------------------------------------------- #
_ARABIC_TOKENS = {"arabic", "arab", "ערבית", "عربي", "العربية", "عربية"}
_QUALIFIERS = {
    # dialect / register
    "spoken", "colloquial", "levantine", "palestinian", "egyptian", "iraqi",
    "moroccan", "standard", "modern", "msa", "written", "reading", "writing",
    "language", "lang", "שפה", "השפה", "מדוברת", "ספרותית",
    # level
    "native", "fluent", "fluency", "basic", "conversational", "professional",
    "intermediate", "advanced", "good", "very", "excellent", "mother", "tongue",
    "working", "proficiency", "proficient", "limited", "elementary", "level",
    "high", "full", "bilingual", "beginner",
    "a1", "a2", "b1", "b2", "c1", "c2",
    "שפת", "אם", "ברמה", "רמה", "בסיסית", "טובה", "גבוהה", "מצוינת", "שוטפת",
    "דובר", "דוברת", "בינונית", "מלאה", "טובה-מאוד", "מאוד",
}
_TOKEN_RE = re.compile(r"[^\W_]+(?:[’'][^\W_]+)?")


def is_arabic_name(value: str) -> bool:
    """True when `value` names the Arabic language and nothing else — so
    "Arabic (native)" and "ערבית – שפת אם" are the language, while "Arabic
    translation", "Judeo-Arabic" and "Hebrew, Arabic" are not whole entries to
    delete (the last one is a list, handled by the prose pass)."""
    if not value:
        return False
    text = re.sub(r"\([^()]*\)|\[[^\[\]]*\]", " ", value).casefold()
    tokens = _TOKEN_RE.findall(text)
    arabic = [t for t in tokens if t in _ARABIC_TOKENS]
    if len(arabic) != 1:
        return False
    return all(t in _ARABIC_TOKENS or t in _QUALIFIERS for t in tokens)


# --------------------------------------------------------------------------- #
# Prose list forms
# --------------------------------------------------------------------------- #
_EN_LANGS = (
    "Hebrew|English|Russian|French|Spanish|German|Amharic|Italian|Portuguese|"
    "Chinese|Mandarin|Cantonese|Japanese|Yiddish|Romanian|Ukrainian|Polish|Turkish|"
    "Persian|Farsi|Hindi|Dutch|Korean|Greek|Hungarian|Czech|Georgian|Tigrinya|"
    "Aramaic|Ladino|Bulgarian|Serbian|Croatian|Swedish|Norwegian|Danish|Finnish"
)
_HE_LANGS = (
    "עברית|אנגלית|רוסית|צרפתית|ספרדית|גרמנית|אמהרית|איטלקית|פורטוגזית|סינית|"
    "יפנית|יידיש|רומנית|אוקראינית|פולנית|טורקית|פרסית|הולנדית|יוונית|הונגרית|"
    "גאורגית|לדינו|בולגרית"
)
_PAREN = r"(?:\s*\([^()]*\))?"

# (pattern, keep-group) — keep-group 1 means "replace the match with group 1".
_LIST_FORMS: list[tuple[re.Pattern[str], bool]] = [
    # "Hebrew, Arabic" / "Hebrew, and Arabic" / "Hebrew and Arabic"
    (re.compile(
        rf"((?<![A-Za-z])(?:{_EN_LANGS}){_PAREN})(?:\s*,\s*(?:and\s+)?|\s+and\s+)arabic{_PAREN}(?![A-Za-z])",
        re.IGNORECASE), True),
    # "Arabic, Hebrew" / "Arabic and Hebrew"
    (re.compile(
        rf"(?<![A-Za-z])arabic{_PAREN}(?:\s*,\s*|\s+and\s+)(?=(?:{_EN_LANGS})(?![A-Za-z]))",
        re.IGNORECASE), False),
    # "עברית, ערבית" / "עברית וערבית" / "עברית ו-ערבית"
    (re.compile(
        rf"((?:{_HE_LANGS}){_PAREN})(?:\s*,\s*|\s+ו-?\s*)ערבית{_PAREN}(?![{_HE_LETTER}])"), True),
    # "ערבית, עברית"
    (re.compile(
        rf"(?<![{_HE_LETTER}])ערבית{_PAREN}\s*,\s*(?=(?:{_HE_LANGS}))"), False),
]
_NOT_A_LIST = re.compile(r"(?<![A-Za-z])(?:between|from)(?![A-Za-z])|בין", re.IGNORECASE)
_SENTENCE_END = re.compile(r"[.!?;\n]")


def strip_list_forms(text: str) -> str:
    """Remove Arabic where it is one item of a list of languages. Anything else
    is left exactly as written."""
    if not text or not mentions_arabic(text):
        return text
    for pattern, keep in _LIST_FORMS:
        def _repl(m: re.Match[str], keep: bool = keep) -> str:
            head = text_now[: m.start()]
            ends = list(_SENTENCE_END.finditer(head))
            clause = head[ends[-1].end():] if ends else head
            if _NOT_A_LIST.search(clause):
                return m.group(0)
            return m.group(1) if keep else ""

        text_now = text
        text = pattern.sub(_repl, text)
    return text


# --------------------------------------------------------------------------- #
# The resume
# --------------------------------------------------------------------------- #
def _strings(obj: Any) -> list[str]:
    if isinstance(obj, str):
        return [obj]
    if isinstance(obj, dict):
        return [s for v in obj.values() for s in _strings(v)]
    if isinstance(obj, list):
        return [s for v in obj for s in _strings(v)]
    return []


# Section names the changelog uses, in the order the reader meets them. The
# contact block is deliberately absent: this never touches the person.
_SECTIONS = (
    ("headline", "headline"), ("summary", "summary"), ("skills", "skills"),
    ("experience", "experience"), ("projects", "projects"),
    ("military_service", "military service"), ("education", "education"),
    ("certifications", "certifications"), ("languages", "languages"),
)


def resume_mentions_arabic(resume: ResumeModel) -> bool:
    return bool(mentioned_sections(resume))


def mentioned_sections(resume: ResumeModel) -> list[str]:
    data = resume.model_dump()
    data["skills"] = list(data.get("skills") or []) + [
        i for g in data.get("skill_groups") or [] for i in g.get("items") or []
    ]
    return [label for key, label in _SECTIONS if any(mentions_arabic(s) for s in _strings(data.get(key)))]


def omit_arabic(resume: ResumeModel) -> tuple[ResumeModel, bool, list[str]]:
    """(resume, removed anything, sections that still mention Arabic).

    Returns `resume` ITSELF when nothing was removed. Never mutates its input."""
    if not mentioned_sections(resume):
        return resume, False, []
    out = resume.model_copy(deep=True)
    removed = False

    langs = []
    for entry in out.languages:
        if is_arabic_name(entry.language):
            removed = True
            continue
        new = strip_list_forms(entry.language)
        if new != entry.language:
            entry.language = new
            removed = True
        langs.append(entry)
    out.languages = langs

    # Skills: BOTH fields, or the union validator puts it back.
    kept_skills = [s for s in out.skills if not is_arabic_name(s)]
    if len(kept_skills) != len(out.skills):
        removed = True
    out.skills = kept_skills
    groups = []
    for group in out.skill_groups:
        items = [i for i in group.items if not is_arabic_name(i)]
        if len(items) != len(group.items):
            removed = True
            if not items:
                continue  # a group that held only Arabic has nothing left to head
        group.items = items
        groups.append(group)
    out.skill_groups = groups

    def _prose(value: str) -> str:
        nonlocal removed
        new = strip_list_forms(value)
        if new != value:
            removed = True
        return new

    out.headline = _prose(out.headline)
    out.summary = _prose(out.summary)
    for exp in out.experience:
        exp.bullets = [_prose(b) for b in exp.bullets]
    for proj in out.projects:
        proj.description = _prose(proj.description)
        proj.bullets = [_prose(b) for b in proj.bullets]
    for ms in out.military_service:
        ms.bullets = [_prose(b) for b in ms.bullets]

    if not removed:
        return resume, False, mentioned_sections(resume)
    return out, True, mentioned_sections(out)
