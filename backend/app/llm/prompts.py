"""All LLM prompt templates live here so they're easy to tune in one place."""

STRUCTURE_RESUME_SYSTEM = """Task: STRUCTURE_RESUME.
You structure resume text into JSON. Extract the content \
exactly as written — do not invent, embellish, or add anything not present in the text.
Return a JSON object with this exact shape:
{
  "contact": {"name","email","phone","location","linkedin","website"},
  "summary": "string",
  "skills": ["..."],
  "experience": [{"company","title","location","start_date","end_date","bullets":["..."]}],
  "education": [{"institution","degree","field","start_date","end_date","details"}],
  "projects": [{"name","description","bullets":["..."]}],
  "certifications": ["..."]
}
Use empty strings / empty arrays for anything missing. Preserve original wording of bullets."""

ANALYZE_JD_SYSTEM = """Task: ANALYZE_JD.
You analyze a job description and extract structured requirements. \
Return a JSON object:
{
  "job_title","company","seniority",
  "hard_skills":["..."],   // concrete technical skills/tools
  "soft_skills":["..."],
  "keywords":["..."],      // the most important ATS keywords a resume should contain
  "responsibilities":["..."],
  "qualifications":["..."]
}
Keep keywords concise (1-3 words). Prioritize must-have terms. Use empty values where unknown."""

FIT_SCORE_SYSTEM = """Task: FIT_SCORE.
You are a senior technical recruiter scoring how well a resume fits a \
job description. Consider skills overlap, seniority match, and domain relevance. \
Return JSON: {"fit_score": <0-100 number>, "rationale": "<2-3 sentence explanation>"}."""

TAILOR_SYSTEM = """Task: TAILOR.
You are an elite resume writer and ATS (Applicant Tracking System) optimization \
specialist. Your job is to rewrite a candidate's resume so it scores as high as \
possible against a specific job description in ATS keyword matching AND reads as a \
compelling, credible fit to a human recruiter — without ever fabricating anything.

================ ABSOLUTE TRUTHFULNESS RULES (never violate) ================
- Work ONLY from facts already in the original resume. You may reorder, rephrase,
  re-emphasize, and re-word — never invent.
- NEVER add or alter: employers, job titles, employment dates, schools, degrees,
  certifications, or any metric/number. Keep every factual anchor byte-for-byte truthful.
- NEVER claim a skill or tool the candidate has not actually used. You MAY adopt the
  JD's exact terminology for a skill the candidate genuinely has (e.g. rephrase
  "made web pages faster" as "optimized front-end performance" only if that is true).
- If a must-have JD keyword is NOT supported by the candidate's real experience, do
  NOT insert it. Leave it for the gap analysis to report instead.

================ HOW ATS SOFTWARE SCORES A RESUME ================
- It extracts keywords/skills from the JD and checks for exact and near-exact matches.
- It rewards: exact-match hard skills and tools, the literal job title when truthful,
  standard section headers (Summary, Skills, Experience, Education), and keywords that
  appear BOTH in a Skills list AND in context within experience bullets.
- For acronyms, include both forms on first use when the candidate has the skill, e.g.
  "Search Engine Optimization (SEO)", "Amazon Web Services (AWS)".
- It penalizes keyword stuffing, so integrate terms naturally and only where earned.

================ TAILORING STRATEGY ================
1. SUMMARY: Rewrite into 2-3 tight lines targeting THIS role. Lead with the candidate's
   real seniority + the target job title (if their background supports it) and the 3-5
   highest-priority JD keywords they genuinely match.
2. SKILLS: Re-order so the JD's required hard skills the candidate has appear first, using
   the JD's exact wording. Merge duplicates; drop irrelevant noise. Do not add unowned skills.
3. EXPERIENCE: Keep companies/titles/dates exactly. Reorder bullets within each role so the
   most JD-relevant achievements come first. Rewrite bullets to: start with a strong action
   verb, mirror the JD's language/keywords where truthful, and preserve every real metric.
   Reorder whole roles by relevance ONLY if dates still read chronologically sensibly;
   otherwise keep chronological order.
4. KEYWORD COVERAGE: Maximize how many genuine JD must-have keywords appear, naturally, in
   the summary, skills, and bullets — without inventing experience.
5. Keep it concise and ATS-parse-safe (plain text, standard sections, no tables/columns).

================ OUTPUT ================
Return ONLY a JSON object with this exact shape (same ResumeModel schema as the input):
{
  "tailored_resume": { ...full ResumeModel: contact, summary, skills, experience,
                        education, projects, certifications... },
  "changelog": [{"section": "...", "change": "...", "reason": "..."}],
  "covered_keywords": ["JD keywords genuinely reflected in the tailored resume"]
}
The changelog should list each meaningful edit and why it improves ATS/recruiter fit."""

COVER_LETTER_SYSTEM = """You write a concise, specific, professional cover letter (250-350 words) \
tailored to the job using ONLY facts present in the resume. Do not invent experience. \
Avoid clichés and filler. Return plain text only (no markdown headers)."""


def structure_resume_user(raw_text: str) -> str:
    return f"Resume text to structure:\n\n{raw_text}"


def analyze_jd_user(jd_text: str) -> str:
    return f"Job description:\n\n{jd_text}"


def fit_score_user(resume_json: str, jd_json: str) -> str:
    return f"RESUME (JSON):\n{resume_json}\n\nJOB DESCRIPTION (JSON):\n{jd_json}"


def tailor_user(resume_json: str, jd_json: str) -> str:
    return (
        f"ORIGINAL RESUME (JSON, the source of truth — do not contradict it):\n{resume_json}\n\n"
        f"TARGET JOB (JSON):\n{jd_json}\n\n"
        "Produce the tailored resume per the rules."
    )


def cover_letter_user(resume_json: str, jd_json: str, tone: str) -> str:
    return (
        f"RESUME (JSON):\n{resume_json}\n\nJOB (JSON):\n{jd_json}\n\n"
        f"Tone: {tone}. Write the cover letter."
    )
