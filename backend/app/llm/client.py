"""Provider-agnostic LLM client.

The rest of the app depends only on `LLMClient.complete_json` / `complete_text`.
Swapping models or providers is a config change, not a code change.
"""
from __future__ import annotations

import json
from functools import lru_cache
from typing import Any, Protocol

from app.config import get_settings


class LLMClient(Protocol):
    def complete_json(self, system: str, user: str) -> dict[str, Any]:
        """Return a parsed JSON object from the model."""
        ...

    def complete_text(self, system: str, user: str) -> str:
        """Return free-form text from the model."""
        ...


class OpenAIClient:
    """OpenAI implementation using the Chat Completions API with JSON mode."""

    def __init__(self, api_key: str, model_id: str):
        # Imported lazily so the package isn't required when using the stub.
        from openai import OpenAI

        # timeout/max_retries: the parallel job search fans many calls out at
        # once — one hung call must not stall a whole search (PLAN 12.1).
        self._client = OpenAI(api_key=api_key, timeout=90, max_retries=2)
        self._model = model_id
        # Some newer models (e.g. gpt-5.x) reject any non-default temperature.
        # Start by trying a low temperature for deterministic output, and turn
        # this off permanently the first time the API rejects it.
        self._send_temperature = True

    def _create(self, messages: list[dict[str, str]], json_mode: bool, temperature: float):
        kwargs: dict[str, Any] = {"model": self._model, "messages": messages}
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        if self._send_temperature:
            kwargs["temperature"] = temperature
        try:
            return self._client.chat.completions.create(**kwargs)
        except Exception as e:  # noqa: BLE001 - inspect message for the temperature restriction
            if self._send_temperature and "temperature" in str(e).lower():
                # Model only supports the default temperature: retry without it
                # and stop sending it for the rest of this client's life.
                self._send_temperature = False
                kwargs.pop("temperature", None)
                return self._client.chat.completions.create(**kwargs)
            raise

    def complete_json(self, system: str, user: str) -> dict[str, Any]:
        resp = self._create(
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            json_mode=True,
            temperature=0.3,
        )
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
    def _stub_structured_resume(self, raw: str) -> dict[str, Any]:
        return {
            "contact": {"name": "Sample Candidate", "email": "sample@example.com"},
            "summary": "Experienced professional.",
            "skills": ["Python", "Communication", "Project Management"],
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

    def _stub_tailor(self, user: str) -> dict[str, Any]:
        # Apply realistic, guard-clean edits (no new numbers/employers/titles/
        # dates) so the per-bullet accept/reject diff is demoable offline.
        resume = self._stub_structured_resume(user)
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
