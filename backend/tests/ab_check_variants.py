"""Pre-flight for A/B variant prompts, run BEFORE any money is spent.

A variant that quietly breaks the output contract does not produce a bad score --
it produces an exception in `ResumeModel.model_validate` or, worse, a valid
resume that silently lost a field, and either way the cell is wasted spend. So
every variant is checked mechanically first, against the baseline it has to be
comparable with.

What it checks, and why each one is here:
  1. the file opens with `Task: TAILOR.` -- `StubClient` routes on it and
     `with_resume_language` appends after it; a variant that loses the tag
     misroutes and the run measures a different task entirely
  2. every JSON key the CALLER reads survives (`tailor.py` reads
     `tailored_resume`, `changelog`, `covered_keywords`; `ChangeLogEntry` needs
     `section`/`change`/`reason`)
  3. the rules a variant is NOT allowed to touch are still there -- the military
     rule, the protected-entries rule, the role-count self-check and a sample of
     the banned-word list. A variant that improved the skills count by deleting
     the truthfulness rules would score well on every metric the harness records.
  4. the diff is reported per region, so a "narrow" variant that rewrote six
     sections is visible before it is measured rather than after
"""
from __future__ import annotations

import difflib
import sys
from pathlib import Path

VARIANTS = Path(__file__).resolve().parent / "fixtures" / "ab" / "variants"

# Substrings that must survive in every variant. Each is a rule the A/B is not
# testing, so a variant that drops one is not comparable -- it is a different
# experiment wearing the same name.
REQUIRED = [
    ("task tag", "Task: TAILOR."),
    ("output key: tailored_resume", "tailored_resume"),
    ("output key: changelog", "changelog"),
    ("output key: covered_keywords", "covered_keywords"),
    ("changelog field: section", "section"),
    ("changelog field: reason", "reason"),
    ("military untouchable", "MILITARY SERVICE IS UNTOUCHABLE"),
    ("closed-set rule", "SKILLS ARE A CLOSED SET"),
    ("protected entries", "PROTECTED ENTRIES"),
    ("role-count self-check", "ROLE COUNT"),
    ("banned word: spearheaded", "spearheaded"),
    ("banned word: leveraged", "leveraged"),
    ("no JD echo", "NEVER ECHO THE JD"),
    ("headline rule", "NEVER promote"),
    ("page budget", "LENGTH"),
]


def regions(base: str, var: str) -> list[str]:
    """Which numbered strategy rules / named sections the variant touched."""
    out: list[str] = []
    sm = difflib.SequenceMatcher(None, base.splitlines(), var.splitlines())
    blines = base.splitlines()
    for tag, i1, i2, _j1, _j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        # Walk backwards to the nearest heading or numbered rule.
        head = "(preamble)"
        for k in range(min(i1, len(blines) - 1), -1, -1):
            line = blines[k]
            if line.startswith("=====") or (line[:2].strip().rstrip(".").isdigit() and line[1:3] in (". ", ") ")):
                head = line.strip()[:60]
                break
        span = f"{head}  [{tag} {i2 - i1} base lines]"
        if span not in out:
            out.append(span)
    return out


def main() -> int:
    base_p = VARIANTS / "baseline.txt"
    if not base_p.exists():
        print("no baseline.txt -- run `-m tests.ab_tailor --prepare` first")
        return 2
    base = base_p.read_text(encoding="utf-8")
    names = sys.argv[1:] or [
        p.stem for p in sorted(VARIANTS.glob("*.txt")) if p.stem != "baseline"
    ]

    # PROBE THE CHECKER AGAINST THE CONTROL FIRST. The first draft of this file
    # used the needle "NEVER PROMOTE" where the prompt says "NEVER promote", so
    # it failed all five variants AND the byte-identical copy of the baseline --
    # a check that cannot pass its own control is not measuring the variants.
    # Cheap, and it is the only reason that draft was caught before the run.
    self_missing = [label for label, needle in REQUIRED if needle not in base]
    if self_missing:
        print("THE CHECKER IS BROKEN: baseline.txt itself fails these rules:")
        for m in self_missing:
            print("  %s" % m)
        return 2

    bad = 0
    for name in names:
        p = VARIANTS / (name + ".txt")
        if not p.exists():
            print("MISSING  %s" % p)
            bad += 1
            continue
        text = p.read_text(encoding="utf-8")
        missing = [label for label, needle in REQUIRED if needle not in text]
        identical = text == base
        delta = len(text) - len(base)
        status = "FAIL" if missing else ("SAME-AS-BASELINE" if identical else "ok")
        if missing:
            bad += 1
        print(
            "%-10s %-17s %6d chars (%+d)  %d/%d required rules present"
            % (name, status, len(text), delta, len(REQUIRED) - len(missing), len(REQUIRED))
        )
        for m in missing:
            print("             MISSING RULE: %s" % m)
        if not identical:
            for r in regions(base, text):
                print("             touched: %s" % r)
    print()
    print("%d variant(s) checked, %d unusable" % (len(names), bad))
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
