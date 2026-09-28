"""A short bid for one freelance gig the user pasted (2026-09-28, "Freelance, the small version").

The cover letter's twin for gigs found where JobFinder cannot read (XPlace,
Upwork, Fiverr briefs, Facebook and WhatsApp groups): the user copies the gig
in, and gets 80-180 words in the GIG's language, grounded in their resume. The
route charges it exactly like a cover letter for the same posting
(`quota.pass_charged(..., "cover_letter", ref=jd_ref(jd))`): one monthly use per
posting covers letters and proposals alike (`docs/handbook/cost-and-quota.md`).

The model is asked never to write a rate, a timeline or availability, and
`proposal_terms.guard` is the floor under that ask: what it took out, the
placeholders left for the user and the numbers the resume does not carry travel
on the answer, so the page can say so. JobFinder never sends a proposal: the
user does, on the platform, themselves.
"""
from __future__ import annotations

from dataclasses import dataclass

from app.core import proposal_terms
from app.core.lang import prose_language
from app.llm import prompts
from app.llm.client import get_llm_client
from app.models import JDModel, ResumeModel


@dataclass(frozen=True)
class Proposal:
    text: str
    language: str
    placeholders: tuple[str, ...] = ()
    replaced: tuple[str, ...] = ()
    unverified: tuple[str, ...] = ()


def proposal_language(gig_text: str, jd: JDModel) -> str:
    """The gig's language: its own words by share (`lang.prose_language`), else
    the analysed posting's, else English. Never the resume's: a Hebrew freelancer
    bidding on an English Upwork post answers in English."""
    return prose_language(gig_text) or (jd.language if jd.language in ("he", "en") else "") or "en"


def write_proposal(resume: ResumeModel, jd: JDModel, gig_text: str = "", rate: str = "", tone: str = "") -> Proposal:
    language = proposal_language(gig_text, jd)
    resume_json = resume.model_dump_json()
    table = proposal_terms.PLACEHOLDERS[language]
    raw = get_llm_client().complete_text(
        prompts.PROPOSAL_SYSTEM,
        prompts.proposal_user(
            resume_json,
            jd.model_dump_json(),
            gig_text,
            rate,
            tone,
            language,
            ", ".join(f"{kind} {table[kind]}" for kind in proposal_terms.KINDS),
        ),
    ).strip()
    guarded = proposal_terms.guard(
        raw, language=language, rate=rate, resume_text=resume_json, gig_text=f"{gig_text}\n{jd.model_dump_json()}"
    )
    return Proposal(
        text=guarded.text,
        language=language,
        placeholders=guarded.placeholders,
        replaced=guarded.replaced,
        unverified=guarded.unverified,
    )
