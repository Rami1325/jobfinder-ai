"""Provider-agnostic LLM client.

The rest of the app depends only on `LLMClient.complete_json` / `complete_text`.
Swapping models or providers is a config change, not a code change.
"""
from __future__ import annotations

import json
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

        self._client = OpenAI(api_key=api_key)
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


def get_llm_client() -> LLMClient:
    settings = get_settings()
    if settings.use_stub_llm or not settings.openai_api_key:
        return StubClient()
    return OpenAIClient(settings.openai_api_key, settings.model_id)
