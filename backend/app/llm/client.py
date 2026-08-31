"""Provider-agnostic LLM client.

The rest of the app depends only on `LLMClient.complete_json` / `complete_text`.
Swapping models or providers is a config change, not a code change.
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from typing import Any, Protocol

from app.config import get_settings
from app.llm.limits import ContextWindowExceeded, OutputTruncated
from app.llm.metering import record


class LLMClient(Protocol):
    def complete_json(self, system: str, user: str) -> dict[str, Any]:
        """Return a parsed JSON object from the model."""
        ...

    def complete_text(self, system: str, user: str) -> str:
        """Return free-form text from the model."""
        ...


def _is_context_overflow(e: Exception) -> bool:
    """True only for a genuine context-window rejection.

    Keys on `code`, not the exception type: every malformed-parameter bug is
    also a BadRequestError, and reporting those to the user as "your résumé is
    too long" would be a guard that fires on legitimate input. The message
    fallback covers providers whose error body omits `code`."""
    if getattr(e, "code", None) == "context_length_exceeded":
        return True
    text = str(e).lower()
    return "context length" in text or "maximum context" in text


def _rejected_param(e: Exception, kwargs: dict[str, Any]) -> str | None:
    """Which optional parameter this 400 is complaining about, if any."""
    text = str(e).lower()
    for name in ("temperature", "max_completion_tokens", "max_tokens"):
        if name in kwargs and name.lower() in text:
            return name
    return None


def _guard_finish_reason(resp: Any) -> None:
    """Raise if the model stopped because it ran out of output budget.

    Hand-written because `chat.completions.create` NEVER raises on truncation —
    it returns a normal response with partial content. The SDK's own
    LengthFinishReasonError is reachable only through `.parse()` and
    `.stream()`. Without this, an output cap silently converts a working tailor
    into a JSONDecodeError, and a cover letter into a letter that just stops."""
    choices = getattr(resp, "choices", None) or []
    if choices and getattr(choices[0], "finish_reason", None) == "length":
        raise OutputTruncated(
            "the model hit its output limit before finishing this response"
        )


class OpenAIClient:
    """OpenAI implementation using the Chat Completions API with JSON mode."""

    def __init__(self, api_key: str, model_id: str):
        # Imported lazily so the package isn't required when using the stub.
        from openai import OpenAI

        # timeout/max_retries: the parallel job search fans many calls out at
        # once — one hung call must not stall a whole search (PLAN 12.1).
        self._client = OpenAI(api_key=api_key, timeout=90, max_retries=2)
        self._model = model_id
        # Optional request parameters this model might reject, each dropped
        # permanently the first time the API refuses it:
        #   temperature            — newer models (gpt-5.x) allow only the default.
        #   max_completion_tokens  — the modern output-cap name.
        #   max_tokens             — the legacy one; models accept one or the other.
        # A SET, not a pair of booleans, because the retry below strips one
        # parameter per attempt and loops. The previous single-shot version
        # retried exactly ONCE and stripped exactly ONE kwarg, so a call the API
        # rejected for two reasons at once died on the second — which is what
        # adding a second probe to it would have caused.
        self._unsupported: set[str] = set()
        # Output-cap parameter name, resolved on first rejection.
        self._cap_param = "max_completion_tokens"

    def _optional_kwargs(self, temperature: float) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if "temperature" not in self._unsupported:
            out["temperature"] = temperature
        cap = get_settings().llm_max_output_tokens
        if cap > 0 and self._cap_param not in self._unsupported:
            out[self._cap_param] = cap
        return out

    def _create(self, messages: list[dict[str, str]], json_mode: bool, temperature: float):
        # Resolved here, not at import: `openai` is imported lazily so the stub
        # path never requires the package (get_llm_client returns StubClient
        # without an API key), and a module-level import would break that.
        from openai import BadRequestError

        base: dict[str, Any] = {"model": self._model, "messages": messages}
        if json_mode:
            base["response_format"] = {"type": "json_object"}
        # At most one attempt per optional parameter, plus the bare call.
        for _ in range(3):
            kwargs = {**base, **self._optional_kwargs(temperature)}
            try:
                return self._metered(kwargs)
            except BadRequestError as e:
                # A context overflow is NOT a capability problem — surface it.
                if _is_context_overflow(e):
                    raise ContextWindowExceeded(str(e)) from e
                rejected = _rejected_param(e, kwargs)
                if rejected is None:
                    raise
                if rejected == "max_completion_tokens" and "max_tokens" not in self._unsupported:
                    # Legacy model: same intent, older parameter name.
                    self._cap_param = "max_tokens"
                self._unsupported.add(rejected)
        return self._metered({**base, **self._optional_kwargs(temperature)})

    def _metered(self, kwargs: dict[str, Any]):
        """One API call, with its token usage reported to the request's tally
        (PLAN 20.8 / N2). Metering is strictly observational: a missing or
        malformed `usage` block must never turn a good completion into an error,
        so everything here is defensive."""
        resp = self._client.chat.completions.create(**kwargs)
        usage = getattr(resp, "usage", None)
        if usage is not None:
            record(
                int(getattr(usage, "prompt_tokens", 0) or 0),
                int(getattr(usage, "completion_tokens", 0) or 0),
            )
        return resp

    def complete_json(self, system: str, user: str) -> dict[str, Any]:
        resp = self._create(
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            json_mode=True,
            temperature=0.3,
        )
        _guard_finish_reason(resp)  # before json.loads — see OutputTruncated
        content = resp.choices[0].message.content or "{}"
        return json.loads(content)

    def complete_text(self, system: str, user: str) -> str:
        resp = self._create(
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            json_mode=False,
            temperature=0.5,
        )
        # No parse step here to fail loudly, so without this a capped cover
        # letter would simply stop mid-sentence with no error at all.
        _guard_finish_reason(resp)
        return resp.choices[0].message.content or ""


class StubClient:
    """Offline client returning canned, schema-shaped JSON.

    Lets the whole pipeline (parsing, scoring, rendering, guard, tracker) be
    exercised end-to-end without an API key. It echoes/derives plausible output
    from the input so behavior is observable.
    """

    def complete_json(self, system: str, user: str) -> dict[str, Any]:
        # Route on the explicit "Task: <TOKEN>." tag each system prompt carries,
        # so overlapping vocabulary between prompts can't misroute the stub.
        head = system[:40].upper()
        if "STRUCTURE_RESUME" in head:
            return self._stub_structured_resume(user)
        if "ANALYZE_JD" in head:
            return self._stub_jd(user)
        if "JD_FIT" in head:
            # Merged ANALYZE_JD + FIT_SCORE (PLAN 12.1): one call per job in
            # the search hot path. Neither token is a substring of the other,
            # so ordering vs. FIT_SCORE below is safe either way.
            return {
                **self._stub_jd(user),
                "fit_score": 72.0,
                "rationale": "[stub] Reasonable overlap in core skills.",
            }
        if "TAILOR" in head:
            return self._stub_tailor(user)
        if "HUMANIZE" in head:
            return self._stub_humanize(user)
        if "PLAN_CV" in head:
            return self._stub_plan_cv(user)
        if "FIT_SCORE" in head:
            return {"fit_score": 72.0, "rationale": "[stub] Reasonable overlap in core skills."}
        if "INTERVIEW_QUESTIONS" in head:
            return self._stub_interview_questions()
        if "INTERVIEW_ANSWER" in head:
            return {
                "answer": "[stub] Situation: at my last role we faced X. Task: I owned Y. "
                "Action: I did Z using my real skills. Result: measurable improvement.",
                "tips": ["Lead with the result", "Keep it under 90 seconds"],
            }
        if "INTERVIEW_FEEDBACK" in head:
            return {
                "score": 74,
                "strengths": ["[stub] Clear structure", "Relevant example"],
                "improvements": ["Quantify the impact", "Tie it back to the role"],
                "revised_answer": "[stub] A tightened version of your answer.",
            }
        if "INTERVIEW_CHAT" in head:
            return {
                "message": "[stub] Tell me about a recent project you're proud of — "
                "what was your specific contribution?",
                "done": False,
            }
        if "INTERVIEW_SCORECARD" in head:
            return {
                "overall": 78,
                "summary": "[stub] Solid session: specific examples, could quantify more.",
                "strengths": ["[stub] Concrete, resume-grounded examples"],
                "improvements": ["[stub] Quantify outcomes with numbers"],
                "question_feedback": [
                    {"question": "Recent project?", "feedback": "[stub] Good detail and ownership."}
                ],
            }
        if "LINKEDIN" in head:
            return {
                "headline": "[stub] Backend Engineer · Python · Distributed Systems",
                "about": "[stub] First-person summary drawn from your real experience.",
                "experience_bullets": ["[stub] Impact-first bullet from a real role."],
                "skills": ["Python", "REST APIs", "SQL"],
            }
        if "SEARCH_CONTEXT" in head:
            return {"job_title": "Software Engineer", "location": "Israel"}
        if "FOLLOW_UP" in head:
            return {
                "subject": "[stub] Following up on the {role} role",
                "body": "[stub] Hi, thanks for your time. I remain very interested in the role "
                "and wanted to reiterate one relevant point of fit. Best regards.",
            }
        if "OUTREACH" in head:
            return {
                "connection_note": "[stub] Hi — I build Python/REST backends and admire your "
                "team's work. Would love to connect about the open role.",
                "inmail_subject": "[stub] Backend engineer keen on the role",
                "inmail_body": "[stub] Hi, I'm a backend engineer whose Python and REST API "
                "experience lines up closely with this role. I'd welcome a short chat about how "
                "I could help. Thanks for your time!",
                "referral_message": "[stub] Hi! I saw your company is hiring for this role and it "
                "looks like a strong fit for my background — would you be open to referring me, "
                "or a quick chat first?",
            }
        if "SCREENING_ANSWER" in head:
            return {
                "answer": "[stub] Drawing on my real experience, here is a specific, honest "
                "answer to the question that ties my background to what the role needs.",
                "tips": ["Keep it specific", "Tie it back to the role"],
            }
        if "COMPANY_BRIEF" in head:
            return {
                "company": "Example Inc",
                "overview": "[stub] Example Inc builds a data-pipeline platform for analytics teams.",
                "products": ["[stub] Data pipeline platform", "[stub] Analytics dashboard"],
                "culture": ["[stub] Small teams with ownership, per their careers page"],
                "interview_style": ["[stub] Likely a practical coding stage, per the hiring page"],
                "talking_points": [
                    "[stub] Your Python and REST API work maps to their platform stack."
                ],
                "people": [
                    {"name": "Dana Levi", "role": "Co-founder & CEO",
                     "evidence": "Founded by Dana Levi"}
                ],
                "outreach_subject": "[stub] Engineer interested in the backend role",
                "outreach_message": "[stub] Hi Dana, I'm a backend engineer working in Python "
                "and REST APIs — the pipeline work your team does lines up closely with what "
                "I've been building. Would you be open to a quick chat about the role?",
            }
        if "RESUME_HEALTH" in head:
            return {
                "strengths": ["[stub] Real metrics in the experience bullets"],
                "improvements": ["[stub] Lead the summary with your seniority and stack"],
                "rewrites": [
                    {"before": "Built things.",
                     "after": "Built internal tooling for the operations team."}
                ],
            }
        if "RECRUITER_SCREEN" in head:
            return {
                "pitch": "[stub] I'm a backend engineer with Python and REST API experience, "
                "most recently building services at my current role.",
                "items": [
                    {"question": "Walk me through your background.",
                     "talking_point": "[stub] Lead with your most recent role and its impact."},
                    {"question": "Why are you looking to leave?",
                     "talking_point": "[stub] Frame it forward-looking, not negative."},
                    {"question": "What are your salary expectations?",
                     "talking_point": "[stub] Give a researched range, not a single number."},
                ],
                "salary_note": "[stub] Share a researched range for the role and location, "
                "not a single figure — and ask what they've budgeted.",
            }
        return {}

    def complete_text(self, system: str, user: str) -> str:
        return (
            "[stub cover letter]\n\nDear Hiring Manager,\n\nI am excited to apply. "
            "My background aligns well with this role.\n\nSincerely,\nApplicant"
        )

    # -- stub helpers ----------------------------------------------------- #
    # "AI & LLMs: OpenAI, LangChain, RAG" — a grouped skills line as a CV writes
    # one. Deliberately narrow on both halves:
    #   * the comma is required, so a one-value "Email: x@y.com" contact line
    #     cannot pass for a group;
    #   * quotes and brackets are excluded, because `_stub_tailor` feeds this the
    #     TAILOR user payload — résumé JSON *and* JD JSON — and a loose pattern
    #     matched `"hard_skills": ["Python", "REST APIs", ...]`, quietly grafting
    #     the JOB's skills onto the candidate. It surfaced as a keyword-stuffing
    #     voice issue three sections later.
    _SKILL_GROUP_RE = re.compile(
        r"^[ \t]*([A-Za-z֐-׿][\w &/+.\-֐-׿]{1,38}):"
        r"[ \t]*([^\"{}\[\]\n]*,[^\"{}\[\]\n]*)$",
        re.MULTILINE,
    )

    def _stub_skill_groups(self, raw: str) -> list[dict[str, Any]]:
        """Derive skill groups from the raw text, the way the real structurer
        is asked to: copy the source's own labels when it groups its skills,
        and return nothing when it lists them flat.

        The stub echoes its input on purpose (see the class docstring) — a
        canned constant would prove the branch runs but not that grouping
        survives import, which is the behaviour this feature is about.
        """
        groups: list[dict[str, Any]] = []
        for label, tail in self._SKILL_GROUP_RE.findall(raw or ""):
            items = [i.strip() for i in tail.split(",") if i.strip()]
            if len(items) >= 2:
                groups.append({"label": label.strip(), "items": items})
        return groups[:6]

    def _stub_structured_resume(self, raw: str) -> dict[str, Any]:
        groups = self._stub_skill_groups(raw)
        return {
            "contact": {"name": "Sample Candidate", "email": "sample@example.com"},
            "headline": "Engineer",
            "summary": "Experienced professional.",
            # `skills` stays the flat surface everything downstream scores; when
            # the source grouped them, ResumeModel folds the grouped items into
            # this list so none of them can go unscored.
            "skills": ["Python", "Communication", "Project Management"],
            "skill_groups": groups,
            "experience": [
                {
                    "company": "Acme Corp",
                    "title": "Engineer",
                    "start_date": "2020",
                    "end_date": "Present",
                    "bullets": ["Built things.", "Improved processes by 20%."],
                }
            ],
            "education": [{"institution": "State University", "degree": "BSc", "field": "CS"}],
            "projects": [],
            "certifications": [],
            "military_service": [
                {
                    "unit": "8200",
                    "role": "Intelligence Analyst",
                    "rank": "Sergeant",
                    "start_date": "2015",
                    "end_date": "2018",
                    "bullets": ["Analyzed signals data."],
                }
            ],
            "languages": [
                {"language": "Hebrew", "level": "native"},
                {"language": "English", "level": "fluent"},
            ],
        }

    def _stub_jd(self, jd_text: str) -> dict[str, Any]:
        return {
            "job_title": "Software Engineer",
            "company": "Example Inc",
            "seniority": "Mid",
            "hard_skills": ["Python", "REST APIs", "SQL"],
            "preferred_skills": ["Docker", "Kubernetes"],
            "business_outcomes": ["Ship features faster", "Improve system reliability"],
            "soft_skills": ["Communication", "Teamwork"],
            "keywords": ["Python", "REST APIs", "SQL", "CI/CD", "Agile"],
            "responsibilities": ["Build features", "Review code"],
            "qualifications": ["3+ years experience"],
        }

    def _stub_interview_questions(self) -> dict[str, Any]:
        return {
            "questions": [
                {"question": "Tell me about a challenging project you led.", "category": "behavioral",
                 "rationale": "[stub] Gauges ownership and impact."},
                {"question": "How would you design a scalable REST API?", "category": "technical",
                 "rationale": "[stub] Core to the role."},
                {"question": "Why are you interested in this role?", "category": "culture",
                 "rationale": "[stub] Motivation fit."},
            ]
        }

    # Plain-verb rewrites the humanizer stub applies, mirroring what the real
    # HUMANIZE prompt asks for. Deterministic and fact-safe (verbs only), so
    # the voice-audit -> humanize -> guard loop is observable offline.
    _HUMANIZE_FIXES = [
        ("spearheaded", "led"),
        ("spearheading", "leading"),
        ("leveraged", "used"),
        ("leveraging", "using"),
        ("utilized", "used"),
        ("utilizing", "using"),
        ("streamlined", "reworked"),
        ("orchestrated", "ran"),
        ("championed", "led"),
        ("passionate about", "focused on"),
        ("results-driven", "hands-on"),
        ("cutting-edge", "modern"),
    ]

    def _stub_humanize(self, user: str) -> dict[str, Any]:
        # Extract the resume between the markers humanize_user() writes, then
        # swap banned buzzwords for plain verbs (case-preserving on the first
        # letter). Anything unexpected -> {} and the caller keeps the original.
        start = user.find("RESUME TO EDIT (JSON):")
        end = user.find("END RESUME")
        if start == -1 or end == -1:
            return {}
        try:
            resume = json.loads(user[start + len("RESUME TO EDIT (JSON):"):end].strip())
        except json.JSONDecodeError:
            return {}

        def fix(text: str) -> str:
            for bad, good in self._HUMANIZE_FIXES:
                text = text.replace(bad, good)
                text = text.replace(bad.capitalize(), good.capitalize())
            return text

        resume["summary"] = fix(resume.get("summary", ""))
        for exp in resume.get("experience", []):
            exp["bullets"] = [fix(b) for b in exp.get("bullets", [])]
        for proj in resume.get("projects", []):
            proj["description"] = fix(proj.get("description", ""))
            proj["bullets"] = [fix(b) for b in proj.get("bullets", [])]
        return {"revised_resume": resume}

    @staticmethod
    def _first_json_object(text: str) -> dict[str, Any]:
        """Pull the first embedded JSON object out of a user message. Lets the
        stub react to the REAL résumé it was handed instead of a fixture."""
        decoder = json.JSONDecoder()
        start = text.find("{")
        while start != -1:
            try:
                obj, _ = decoder.raw_decode(text[start:])
            except ValueError:
                start = text.find("{", start + 1)
                continue
            if isinstance(obj, dict):
                return obj
            start = text.find("{", start + 1)
        return {}

    def _stub_plan_cv(self, user: str) -> dict[str, Any]:
        """Echoes the résumé's real project names into the select/drop split so
        the offline pipeline exercises project curation instead of always
        planning against a fixed fixture with no projects."""
        projects = self._first_json_object(user).get("projects") or []
        names = [
            p.get("name", "")
            for p in projects
            if isinstance(p, dict) and p.get("name")
        ]
        return {
            "positioning": "[stub] Software engineer focused on Python services and REST APIs.",
            "lead_strengths": ["Python", "REST APIs", "SQL"],
            "emphasize": ["Engineer at Acme Corp"],
            "downplay": ["[stub] Early unrelated coursework"],
            "conservative_notes": ["[stub] Keep process-improvement claims tied to the 20% metric"],
            "select_projects": names[:3],
            "drop_projects": names[3:],
        }

    def _stub_tailor(self, user: str) -> dict[str, Any]:
        # Apply realistic, guard-clean edits (no new numbers/employers/titles/
        # dates) so the per-bullet accept/reject diff is demoable offline.
        resume = self._stub_structured_resume(user)
        # Repositioned, not promoted — the guard's rank check must stay quiet on
        # the happy path, so the smoke test can tell a real flag from noise.
        resume["headline"] = "Software Engineer"
        resume["summary"] = "Software engineer building Python services and REST APIs."
        resume["skills"] = ["Python", "REST APIs", "SQL", "Project Management"]
        resume["experience"][0]["bullets"] = [
            "Built things with Python and REST APIs.",
            "Improved processes by 20%.",
            "Wrote SQL reports for internal teams.",
        ]
        return {
            "tailored_resume": resume,
            "changelog": [
                {"section": "summary", "change": "Rewrote to target the role", "reason": "Lead with Python & REST APIs"},
                {"section": "skills", "change": "Surfaced REST APIs and SQL first", "reason": "Match JD keywords"},
                {"section": "experience", "change": "Reworded bullets toward JD keywords", "reason": "ATS coverage"},
            ],
            "covered_keywords": ["Python", "REST APIs", "SQL"],
        }


@lru_cache
def get_llm_client() -> LLMClient:
    """Process-wide singleton. The OpenAI SDK client is thread-safe and keeps a
    connection pool worth reusing across the parallel search workers; building
    a fresh client per call threw that pool away. (`_send_temperature` mutating
    on the singleton is the point — the capability probe runs once per process.
    Settings are lru_cached too, so a changed .env means a new process anyway.)"""
    settings = get_settings()
    if settings.use_stub_llm or not settings.openai_api_key:
        return StubClient()
    return OpenAIClient(settings.openai_api_key, settings.model_id)
