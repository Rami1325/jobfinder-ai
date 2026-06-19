"""Offline end-to-end smoke test using the stub LLM (no API key needed).

Run from the backend dir:
    .venv\\Scripts\\python.exe -m tests.smoke_test
"""
from __future__ import annotations

import os

os.environ["USE_STUB_LLM"] = "true"

from app.config import get_settings  # noqa: E402

get_settings.cache_clear()  # ensure env override is picked up

from app.core.cover_letter import generate_cover_letter  # noqa: E402
from app.core.fabrication_guard import check_fabrication  # noqa: E402
from app.core.jd_analyzer import analyze_jd  # noqa: E402
from app.core.tailor import tailor_resume  # noqa: E402
from app.models import Experience, FactsLedger, ResumeModel  # noqa: E402
from app.parsers.structurer import build_facts_ledger, structure_resume  # noqa: E402
from app.render.docx_renderer import render_docx  # noqa: E402
from app.render.pdf_renderer import render_pdf  # noqa: E402

failures: list[str] = []


def check(name: str, cond: bool, extra: str = "") -> None:
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name}" + (f" — {extra}" if extra else ""))
    if not cond:
        failures.append(name)


# 1. Structure a resume from raw text
resume = structure_resume("John Doe\nEngineer at Acme Corp 2020-Present\n- Built things")
check("structure_resume returns ResumeModel", isinstance(resume, ResumeModel))
check("resume has experience", len(resume.experience) > 0)

# 2. Facts ledger
ledger = build_facts_ledger(resume)
check("ledger captured employers", "Acme Corp" in ledger.employers, str(ledger.employers))
check("ledger captured numbers", "20%" in ledger.numbers, str(ledger.numbers))

# 3. JD analysis
jd = analyze_jd("We need a Software Engineer with Python, REST APIs and SQL.")
check("jd has keywords", len(jd.keywords) > 0, str(jd.keywords))

# 4. Tailor (score -> rewrite -> guard -> rescore)
result = tailor_resume(resume, jd, ledger)
check("tailor produced resume", isinstance(result.tailored_resume, ResumeModel))
check("score_before computed", result.score_before.overall >= 0)
check("score_after computed", result.score_after.overall >= 0)
check("changelog present", len(result.changelog) > 0)
check("no false fabrication flags on honest tailor", len(result.fabrication_flags) == 0, str(result.fabrication_flags))
check("keyword coverage is a percentage", 0 <= result.score_after.keyword_coverage <= 100)
check("gap analysis present", len(result.score_after.gaps) > 0)

# 5. Fabrication guard catches an injected fake employer
fake = result.tailored_resume.model_copy(deep=True)
fake.experience.append(Experience(company="FAKE Industries Ltd", title="CEO", start_date="2010", end_date="2019"))
flags = check_fabrication(fake, ledger)
flagged_employers = [f.value for f in flags if f.category == "employer"]
check("guard flags fabricated employer", "FAKE Industries Ltd" in flagged_employers, str(flagged_employers))

# 6. Renderers produce valid files
docx_bytes = render_docx(result.tailored_resume)
check("docx renders (zip/PK header)", docx_bytes[:2] == b"PK", f"{len(docx_bytes)} bytes")
pdf_bytes = render_pdf(result.tailored_resume)
check("pdf renders (%PDF header)", pdf_bytes[:4] == b"%PDF", f"{len(pdf_bytes)} bytes")

# 7. Cover letter
letter = generate_cover_letter(result.tailored_resume, jd)
check("cover letter non-empty", len(letter) > 20)

print("\n" + ("ALL PASSED" if not failures else f"FAILURES: {failures}"))
raise SystemExit(1 if failures else 0)
