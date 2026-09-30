"""The tailoring engine: score -> plan -> rewrite -> guard -> humanize ->
rescore (the humanization-spec pipeline)."""
from __future__ import annotations

from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context

from app.config import get_settings
from app.core.arabic_omit import jd_asks_for_arabic, omit_arabic, resume_mentions_arabic
from app.core.cv_planner import plan_cv
from app.core.job_market import MARKET_IL, MARKET_OTHER
from app.core.numerals import digits_in_resume, quantity_phrases
from app.core.fabrication_guard import check_fabrication, drop_invented_roles
from app.core.humanizer import humanize_resume
from app.core.keyword_guard import (
    MAX_RESTORED,
    lost_keywords,
    preserve_keywords,
    report_restore,
    shed_restored,
)
from app.core.lang import resume_language
from app.core.length_budget import OVERFLOW_NOTE, fit_to_pages
from app.core.scorer import keyword_analysis, score_resume
from app.core.skills import dedupe_skills, regroup_skills
from app.core.skills_shortlist import order_skills, shortlist_skills
from app.core.voice_audit import audit_voice
from app.llm.client import get_llm_client
from app.llm import prompts
from app.models import (
    ChangeLogEntry,
    FactsLedger,
    JDModel,
    ResumeModel,
    TailorResult,
)
from app.parsers.structurer import build_facts_ledger
from app.render.pdf_renderer import page_count
from app.render.templates import DEFAULT_TEMPLATE


# The pipeline's stages, in the order it reaches them (PLAN 31.3/2). `progress`
# is told each one AS IT STARTS, so a page can say what is happening now and
# never what it guesses: plan (the score before ∥ the positioning plan), rewrite
# (the TAILOR call), facts (invented roles cut, the page budget, the fabrication
# guard), voice (the audit and, when it finds tells, the humanizer), rescore (the
# keyword floor, the skills shortlist, the Arabic and numerals passes, and the
# score after). `frontend/src/lib/tailorStages.ts` mirrors this tuple and
# check-mirrors 64 holds the two equal.
TAILOR_STAGES = ("plan", "rewrite", "facts", "voice", "rescore")


# THE CHANGELOG SPEAKS THE RESUME'S LANGUAGE, EVERY LINE OF IT. The model writes
# its own entries in the resume's language (a Hebrew resume's TAILOR call carries
# `with_resume_language`'s write-in-Hebrew note), and every entry this module
# adds was English, so a Hebrew resume's changes panel read half in each: "Wrote
# 2 numbers as digits" and "Grouped your skills under the headings from your
# master resume" among Hebrew lines (seen 2026-09-29, recording the ad). Every
# `ChangeLogEntry` built here words its `change` and `reason` through `_say`,
# with the same `lang` the TAILOR call is given, and smoke pins that through the
# AST. The `section` stays a key: the page names it in its own language.
def _say(lang: str, en: str, he: str) -> str:
    return he if lang == "he" else en


# The sections the notes name, in Hebrew, as "in the X" (Hebrew glues the
# preposition on, and joins with a glued ו: "בניסיון התעסוקתי ובתקציר").
# `keyword_guard._where` answers with ResumeModel field names, and
# `arabic_omit.mentioned_sections` with its own labels ("military service").
_HE_IN_SECTION = {
    "headline": "בכותרת",
    "summary": "בתקציר",
    "skills": "בכישורים",
    "experience": "בניסיון התעסוקתי",
    "projects": "בפרויקטים",
    "military_service": "בשירות הצבאי",
    "military service": "בשירות הצבאי",
    "education": "בהשכלה",
    "certifications": "בהסמכות",
    "languages": "בשפות",
}


def _he_in(sections: list[str]) -> str:
    return " ו".join(_HE_IN_SECTION.get(s, s) for s in sections)


def tailor_resume(
    resume: ResumeModel,
    jd: JDModel,
    ledger: FactsLedger | None = None,
    avoid_phrases: list[str] | None = None,
    template: str = DEFAULT_TEMPLATE,
    hide_arabic_in_israel: bool = False,
    progress: Callable[[str], None] | None = None,
) -> TailorResult:
    """`avoid_phrases`: wording this user rejected in past reviews (§26
    feedback loop) — injected into the tailor prompt as a hard avoid-list.
    `template`: which resume template the page budget measures against.
    `hide_arabic_in_israel`: the user's opt-in preference (spec 07 / R1) —
    see the omission stage near the end. `progress`: told each of
    `TAILOR_STAGES` as the pipeline starts it (the stream route's frames); the
    plain route and the kit drain pass nothing and nothing changes for them."""

    def _stage(name: str) -> None:
        if progress is not None:
            progress(name)

    if ledger is None:
        ledger = build_facts_ledger(resume)

    # SPEC 07 / R1 — DECIDED ONCE, UP FRONT, because the prompt carries it. The
    # user chose it (OFF by default); the job must be KNOWN to be in Israel (an
    # unknown market is not Israel); and a job that asks for Arabic keeps it.
    omit_arabic_here = (
        hide_arabic_in_israel and jd.market == MARKET_IL and not jd_asks_for_arabic(jd)
    )

    settings = get_settings()
    max_pages = settings.resume_max_pages
    hard_max_pages = settings.resume_hard_max_pages

    # TWO CALLS THAT READ THE SAME TWO INPUTS AND NOTHING ELSE, so they have no
    # reason to queue behind each other. `score_before` is recorded in the result
    # and feeds nothing; `plan_cv` decides the story before writing. Measured
    # medians over 126 real runs: FIT_SCORE 1.20 s, PLAN_CV 2.79 s — serially
    # 3.99 s, concurrently 2.79 s.
    #
    # `copy_context().run`, never a bare submit: a pool worker starts from an
    # EMPTY context, so the request's LLM token tally (PLAN 20.8/N2) would be
    # invisible and every token these two spend would silently vanish from
    # `usage_log`. A fresh copy per submit because one Context cannot be entered
    # from two threads at once; the tally is mutable and shared by reference, so
    # the workers' usage still lands on the request's.
    #
    # Exceptions still propagate on `.result()`, so a failing `score_resume`
    # fails the tailor exactly as it did serially, and `plan_cv`'s own
    # best-effort `None` is unchanged.
    _stage("plan")
    with ThreadPoolExecutor(max_workers=2) as pool:
        _score_before = pool.submit(copy_context().run, score_resume, resume, jd)
        # Stage 4 (positioning): decide the professional story before writing —
        # including WHICH projects earn their space in this particular CV.
        # Best-effort — a failed plan (None) tailors without one.
        _plan = pool.submit(copy_context().run, plan_cv, resume, jd)
        score_before = _score_before.result()
        plan = _plan.result()

    _stage("rewrite")
    # One reading of the resume's language, for the TAILOR call and for every
    # changelog entry this module writes (`_say`), so the two cannot disagree.
    lang = resume_language(resume)
    client = get_llm_client()
    data = client.complete_json(
        # Hebrew resume => tailor in Hebrew (note appended AFTER the Task tag).
        prompts.with_resume_language(prompts.TAILOR_SYSTEM, lang),
        prompts.tailor_user(
            resume.model_dump_json(),
            jd.model_dump_json(),
            plan_json=plan.model_dump_json() if plan else "",
            avoid_phrases=avoid_phrases,
            max_pages=max_pages,
            source_pages=page_count(resume, template),
            source_projects=len(resume.projects),
            # Passed only when it applies, so an off preference cannot even
            # reach the builder's branch: the message stays byte-identical.
            **({"omit_arabic": True} if omit_arabic_here else {}),
        ),
    )

    # A TAILORED CV IS FLAT, AND THE VALIDATOR HAS TO BE TOLD SO BEFORE IT RUNS.
    # `ResumeModel` keeps `skills` as the flat union of every `skill_groups`
    # entry — correct for a master, where the taxonomy IS the document, and it
    # only ever ADDS. So a model that returns a curated 20-entry `skills` list
    # and *also* echoes the master's five groups has its shortlist silently
    # undone at parse time: measured, 20 flat + the real master's groups
    # validates to 66 skills, with nothing anywhere reporting that the curation
    # was reversed. The prompt does say "Return skill_groups: []", and across 12
    # measured runs the model complied every time — but an instruction is not a
    # guarantee, this one is a single temperature sample from failing, and when
    # it fails it defeats every other thing that shortens this section.
    #
    # The model's own FLAT list is authoritative and the groups are dropped.
    # Both halves of the condition matter: a response that returned groups and
    # NO flat list has the union as its only content, and stripping there would
    # delete the skills section outright.
    raw_tailored = dict(data.get("tailored_resume") or resume.model_dump())
    if raw_tailored.get("skill_groups") and raw_tailored.get("skills"):
        raw_tailored["skill_groups"] = []
    if "skills" in raw_tailored:
        raw_tailored["skills"] = dedupe_skills(raw_tailored["skills"])
    tailored = ResumeModel.model_validate(raw_tailored)
    changelog = [ChangeLogEntry.model_validate(c) for c in data.get("changelog", [])]
    covered = list(data.get("covered_keywords", []))

    _stage("facts")
    # Structural repair first: "roles are protected, projects are droppable"
    # gives the model a way to rescue a project it likes — promote it into
    # experience, where nothing may remove it — and the output then claims
    # employment that never happened. Cut those rows before anything measures
    # or audits the resume.
    tailored, invented_roles = drop_invented_roles(tailored, ledger)
    if invented_roles:
        changelog.append(
            ChangeLogEntry(
                section="experience",
                change=_say(
                    lang,
                    "Removed " + ", ".join(invented_roles) + " from Experience",
                    "הסרנו מהניסיון התעסוקתי: " + ", ".join(invented_roles),
                ),
                # This used to close by asserting the row had been kept in
                # Projects — a preservation the code does not perform.
                # `drop_invented_roles` filters `tailored.experience` and appends
                # nothing to `projects`, so whenever the model MOVED a project up
                # rather than copying it, the row and everything in it was gone
                # and the changelog said otherwise. Reproduced — a promoted "Ziko"
                # row carrying "Go" and "delivery platform" was cut while this
                # sentence claimed the content survived.
                #
                # The fix is the sentence, not a re-home. Re-inserting the row
                # into `projects` would take content the ledger could NOT verify
                # and move it to the section the fabrication guard checks least
                # (projects contribute numbers only), which is the opposite of
                # what this repair exists to do.
                reason=_say(
                    lang,
                    "Not employers in your resume — they were projects promoted into "
                    "job entries. If this was a project, it is in Projects only if the "
                    "rewrite kept it there.",
                    "אלה לא מעסיקים מקורות החיים שלכם — אלה פרויקטים שהוצגו כמשרות. "
                    "אם זה היה פרויקט, הוא מופיע בפרויקטים רק אם השכתוב השאיר אותו שם.",
                ),
            )
        )

    # Page budget: the prompt asks for a 2-pager, this guarantees one. Runs
    # BEFORE the guard and the voice pass so every later stage sees exactly
    # the content that will ship. Trimming only removes, so it can never add
    # a claim the guard would have caught.
    tailored, length_report = fit_to_pages(
        tailored, jd, plan, template=template,
        max_pages=max_pages, hard_max_pages=hard_max_pages,
    )

    flags = check_fabrication(tailored, ledger)

    # Human-voice loop (humanization spec): the deterministic audit hunts for
    # AI tells; when it finds any, one humanizer LLM pass fixes wording. The
    # revision ships ONLY if the guard finds nothing new in it AND the re-audit
    # confirms the voice actually improved — otherwise the tailored resume
    # stands. Voice polish is never allowed to cost truthfulness, and since
    # rewording can run long, it is not allowed to cost the page budget either.
    _stage("voice")
    report = audit_voice(tailored, jd)
    if report.issues:
        revised = humanize_resume(tailored, report.issues, jd)
        if revised is not None:
            revised_flags = check_fabrication(revised, ledger)
            post = audit_voice(revised, jd)
            if (
                len(revised_flags) <= len(flags)
                and post.human_voice_score > report.human_voice_score
                and page_count(revised, template) <= max(length_report.pages_after, max_pages)
                # ...and it may not cost keyword coverage either. HUMANIZE's
                # `keyword_stuffing` rule explicitly tells the model to "drop the
                # other occurrences", and its keep-list is prose in a prompt, so
                # an accepted revision could and did delete a JD keyword outright.
                # The baseline is `tailored`, NOT `resume`: the humanizer answers
                # only for what IT deleted, and measuring against the master would
                # reject every revision of an already-lossy tailor. Last conjunct
                # so `and` short-circuits past it whenever a cheaper term already
                # failed.
                and not lost_keywords(tailored, revised, jd)
            ):
                remaining = {(i.category, i.value) for i in post.issues}
                post.fixed = [i for i in report.issues if (i.category, i.value) not in remaining]
                post.revised = True
                tailored, flags, report = revised, revised_flags, post

    # Keyword preservation: a term THIS JOB asks for, which the candidate's own
    # skills list already carried, must not have been deleted by the rewrite.
    # Deterministic, no LLM, and it may only ever write a string that exists
    # byte-for-byte in `resume.skills` — see `keyword_guard`'s docstring.
    #
    # ONE CALL SITE, and here rather than in `routes.py` or `kits.py`. Both of
    # those reach the pipeline through this function (kits pass it as
    # `tailor_fn`), so a second site would only add a second gate to disagree
    # with this one — the geo-restriction correction, in a new costume.
    #
    # AFTER the humanizer, not before `fit_to_pages`: the humanizer is the last
    # stage that can delete a keyword, and the conjunct above narrows that but
    # cannot close it (a gate is a comparison, not a constraint). A guard placed
    # earlier would leave the restore un-guaranteed. Before `score_after`, so it
    # describes the resume that actually ships.
    _stage("rescore")
    pre_restore = tailored
    tailored, _, attempted = preserve_keywords(resume, tailored, jd)
    # THE GUARD'S OWN `restored` LIST IS DROPPED ON THE FLOOR HERE, deliberately.
    # It describes the resume `preserve_keywords` returned, and every line below
    # can still take an entry out of that — so quoting it produced "Put back: X"
    # in the changelog for keywords the refit had removed again, a sentence about
    # a document that no longer existed. What the user is told is MEASURED at the
    # end, on what ships (`report_restore`). `attempted` survives because a
    # reason ("only in prose", "the budget was spent") is a fact about the
    # ORIGINAL's wording, which no later trim changes.
    #
    # The gate below is IDENTITY, not a non-empty list. `preserve_keywords`
    # returns the same object when it had nothing to say (smoke-pinned), and it
    # can also write carriers that repair a keyword only partway — those add
    # render height too, and the old `if restored:` gate skipped the re-measure
    # for them entirely.
    pre_skills = set(pre_restore.skills)

    def restored_entries() -> list[str]:
        """The candidate's own skill entries this restore put on the page, as
        they stand RIGHT NOW. Recomputed rather than remembered, so it can never
        name one a later trim has removed — the same bug as `restored`, one
        level down."""
        return [s for s in tailored.skills if s not in pre_skills]

    # THE CEILING, immediately after the floor. `preserve_keywords` guarantees a
    # JD keyword the candidate's own skills list carried is not deleted;
    # `shortlist_skills` guarantees the section is a shortlist rather than the
    # master's inventory. Both are deterministic, both use the SAME matcher, and
    # they are adjacent so nothing between them can see a list that only one of
    # them has finished with.
    #
    # MEASURED, and this placement is the one that was measured: the trim ran
    # here in the winning A/B arm, over 12 job-pairs across two independent
    # real-key runs (`tests/ab_tailor.py`). Paired per-job medians vs the same
    # prompt with the trim off — 63.5 -> 20 skills, better on 12 of 12 jobs;
    # entries the job never names 48.5 -> 7.5; precision 18.6% -> 55.0%; and
    # coverage, lost keywords, fabrication flags, voice and page count all
    # UNCHANGED (coverage delta median 0.0, lost keywords tied on 12 of 12).
    # Every prompt-only arm that cut the count paid for it in coverage.
    #
    # The restored entries are protected, or the cap could evict a carrier the
    # changelog below then claims was put back.
    tailored, dropped_noise = shortlist_skills(
        tailored, jd, settings.resume_max_skills, protected=frozenset(restored_entries())
    )
    if dropped_noise:
        # THREE CLAIMS, AND TWO OF THEM WERE FALSE. Read off a rendered CV:
        #
        #   "Cut the skills list to the 30 this job asks for" — the cap keeps
        #   the top N by relevance, and most of them are NOT named by the job.
        #   The app's own `ats_scan` said so about the same document, in the
        #   same session: "19 of 30 entries are not mentioned by this posting."
        #
        #   "Your master resume lists 75 skills" — 75 is what the MODEL
        #   returned, and it over-produces on purpose (the master lists 66).
        #   The sentence named the wrong document.
        #
        # The third — "nothing this posting names was dropped" — is true, and
        # `shortlist_skills` is what makes it true: a `covered` entry is never
        # dropped, cap or no cap.
        n_before = len(dropped_noise) + len(tailored.skills)
        # NAME ONLY WHAT IS ACTUALLY IN THE MASTER. `dropped_noise` is the
        # model's list minus what the cap kept, and the model writes entries of
        # its own — "orchestration patterns", "tool use", "unstructured data
        # processing" — that no master lists. Sampling those under "stay in your
        # master resume" is the same class of false sentence as the two above.
        # Casefolded, because `dedupe_skills` is: an entry the model
        # returned as `python` against a master saying `Python` is the
        # same skill, and comparing raw would silently drop it from the
        # sample -- under-naming, never over-naming, but it can empty the
        # sentence out entirely.
        own = {s.strip().casefold() for s in resume.skills}
        recoverable = [s for s in dropped_noise if s.strip().casefold() in own]
        # A COUNT AND A SAMPLE, never the whole list: the master's tail can run
        # to forty entries and a changelog paragraph naming all of them is not a
        # log, it is the section over again.
        sample = ", ".join(recoverable[:6])
        changelog.append(
            ChangeLogEntry(
                section="skills",
                change=_say(
                    lang,
                    f"Cut the skills list from {n_before} to {len(tailored.skills)}, "
                    "ranked by how well each matches this posting",
                    f"קיצרנו את רשימת הכישורים מ־{n_before} ל־{len(tailored.skills)}, "
                    "לפי מידת ההתאמה של כל אחד למשרה הזו",
                ),
                # NO SECOND COUNT HERE. `change` above states the pre-cut
                # number, which is the honest one; attributing it to what
                # "the draft came back with" was wrong by up to MAX_RESTORED,
                # since `fit_to_pages` removes skills and `preserve_keywords`
                # adds them between the response and this line.
                reason=_say(
                    lang,
                    "A CV for one job is a "
                    "shortlist a recruiter reads in about three seconds. Nothing this "
                    "posting names outright was dropped."
                    + (
                        f" {sample}"
                        + (" and others" if len(recoverable) > 6 else "")
                        + " stay in your master resume."
                        if sample
                        else ""
                    ),
                    "קורות חיים למשרה אחת הם רשימה קצרה שמגייס קורא בערך בשלוש שניות. "
                    "שום דבר שהמשרה הזו מזכירה במפורש לא הוסר."
                    + (
                        f" {sample}"
                        + (" ועוד" if len(recoverable) > 6 else "")
                        + " נשארים בקורות החיים הראשיים שלכם."
                        if sample
                        else ""
                    ),
                ),
            )
        )

    if tailored is not pre_restore:
        pages_pre = page_count(pre_restore, template)
        shed: list[str] = []
        # A restore adds skill entries, so it can add render height, and the page
        # budget is the authority on size. Re-measure against the SAME gate the
        # humanizer's own acceptance test uses.
        if page_count(tailored, template) > max(pages_pre, max_pages):
            tailored, refit = fit_to_pages(
                tailored, jd, plan, template=template,
                max_pages=max_pages, hard_max_pages=hard_max_pages,
            )
            # `pages_before` is deliberately left alone: it describes what the
            # MODEL returned — the "we started at N pages" number — and the
            # restore did not change that. `pages_after` is set once, at the
            # bottom, from a measurement of whatever survives all of this.
            length_report.trimmed = length_report.trimmed or refit.trimmed
            for note in refit.notes:
                if note not in length_report.notes:
                    length_report.notes.append(note)
            for name in refit.dropped_projects:
                if name not in length_report.dropped_projects:
                    length_report.dropped_projects.append(name)
            # THE BACK-OFF. The refit cannot always give the height back:
            # everything trimmable can already be at its floor, and the
            # last-resort skills trim refuses to remove a restored entry — the
            # matcher that chose it as a carrier is the one that protects it.
            # Reproduced at 4 pages against a
            # hard max of 3, with `fit_to_pages` writing "could not get below 3
            # pages" into its notes and nothing acting on it. A CV over the
            # stated hard limit has traded a keyword for the one thing the page
            # budget exists to guarantee, so the guard retreats instead — and
            # what it gives back is reported, because the report is measured on
            # what ships. Gated on the restore being what caused it: a resume
            # already over the limit is not something giving skills back fixes.
            if page_count(tailored, template) > hard_max_pages >= pages_pre:
                tailored, shed = shed_restored(
                    tailored, restored_entries(),
                    lambda r: page_count(r, template) <= hard_max_pages,
                )
            # The restore itself adds nothing the ledger tracks (it never reads
            # `skills`), so it cannot create a flag. The REFIT is why this runs
            # anyway: it REMOVES content, and a flag still pointing at a bullet
            # that no longer ships is a warning about a document that does not
            # exist. Removal-only means the count can never rise, so re-running
            # here can only ever make the warnings truer.
            flags = check_fabrication(tailored, ledger)

        pages_now = page_count(tailored, template)
        length_report.pages_after = pages_now
        # A note the budget wrote can stop being TRUE: the back-off gets under
        # the limit after `fit_to_pages` has already recorded that it could not,
        # and a report carrying both "could not get below 3 pages" and a 3-page
        # CV is worse than either. Retracted by measurement, and the sentence is
        # imported from the module that writes it rather than restated here.
        if pages_now <= hard_max_pages:
            length_report.notes = [n for n in length_report.notes
                                   if not n.startswith(OVERFLOW_NOTE)]
        if shed:
            # A count, not the entries: the changelog names every one of them
            # under "Not carried over", and a note listing 15 long skill lines is
            # a paragraph where the others are a phrase.
            length_report.notes.append(
                f"gave back {len(shed)} of the put-back skills to stay inside "
                f"{hard_max_pages} pages"
            )
        # Say so when the restore changed the size. Without this the report can
        # read pages_before=1, pages_after=2, trimmed=False, notes=[] — a CV that
        # grew a page with no vocabulary anywhere for why.
        # Gated on the restore having ACTUALLY added something. This branch is
        # now also reached when the restore added nothing and the shortlist
        # merely trimmed — and a trim can only make the CV shorter, so an
        # ungated note would report a page the trim SAVED as a page the restore
        # SPENT, which is the sentence backwards.
        if pages_now != pages_pre and restored_entries():
            length_report.notes.append(
                f"putting back skills the job asks for took the CV from {pages_pre} "
                f"to {pages_now} pages"
            )
        # `voice_audit` scans the skills list for banned phrases, so a restored
        # entry like "Cutting-edge ML tooling" adds an issue the pre-restore
        # audit never saw, and `voice_report` is supposed to describe what
        # shipped. Deterministic, no LLM. The humanizer's own bookkeeping is
        # carried across by hand — a fresh audit knows nothing about a revision
        # that was accepted, and silently zeroing `revised`/`fixed` erases the
        # record of the only stage that rewrote anything.
        was_revised, was_fixed = report.revised, report.fixed
        report = audit_voice(tailored, jd)
        report.revised, report.fixed = was_revised, was_fixed

    # PRESENTATION, LAST: the candidate's own words lead, the ad's follow. After
    # every stage that can change the SET, because ordering something that is
    # about to be trimmed would be describing a document that does not ship.
    #
    # APPLIED ONLY IF IT COSTS NOTHING, and that gate is not belt-and-braces —
    # it replaces a claim that was FALSE. "The set is unchanged, so coverage and
    # the page count cannot move" is wrong twice over. `scorer._resume_text`
    # joins the skills with a SPACE and `_keyword_present` tries the verbatim
    # phrase first, so a multi-word JD keyword can match ACROSS the join between
    # two adjacent entries — and in Hebrew the token fallback does not rescue it,
    # because ב/ל/ה/ו/מ/ש glue to the noun. Measured, same set, reordered:
    # `['בפייתון', 'מתקדם']` scores 100.0 against `פייתון מתקדם` and
    # `['מתקדם', 'בפייתון']` scores 50.0. In the primary market. And `_Chips._pack`
    # fills rows by WIDTH, so a reorder repacks the section and can change its
    # rendered height — after the page budget has already signed the CV off.
    #
    # So the guarantee is ENFORCED rather than argued: measure both, keep the new
    # order only when coverage has not fallen and the CV has not grown, and
    # otherwise leave the document exactly as it was. Same acceptance-gate shape
    # as the humanizer's, one stage down.
    #
    # GROUPING RUNS FIRST AND REPLACES IT WHEN IT APPLIES. `regroup_skills` files
    # the shipped entries under the MASTER's own headings and leaves everything
    # the master has never heard of — i.e. the wording the model minted from the
    # ad — in the trailing unlabelled block, which is the same entries at the
    # same end of the list that `order_skills` exists to put there. Running both
    # would reorder the list twice and leave one of the two changelog entries
    # describing an order the document does not have, which is the rule this
    # file already pays for elsewhere: a changelog may not describe a document
    # that does not exist.
    #
    # Both go through the SAME acceptance gate, for the same measured reasons —
    # the skills join is what a multi-word JD keyword can match across, and the
    # section's rendered height moves with its arrangement. A user who asked for
    # grouped headings is not asking to lose a page or a keyword for them.
    def _accept(candidate: ResumeModel) -> bool:
        if candidate is tailored:
            return False
        _cov_before, _ = keyword_analysis(tailored, jd)
        _cov_after, _ = keyword_analysis(candidate, jd)
        return _cov_after >= _cov_before and page_count(candidate, template) <= page_count(
            tailored, template
        )

    _pre_order = tailored
    _regrouped = regroup_skills(tailored, resume)
    if _accept(_regrouped):
        tailored = _regrouped
        changelog.append(
            ChangeLogEntry(
                section="skills",
                change=_say(
                    lang,
                    "Grouped your skills under the headings from your master resume",
                    "קיבצנו את הכישורים תחת הכותרות מקורות החיים הראשיים שלכם",
                ),
                reason=_say(
                    lang,
                    "Same skills, same words — only the arrangement. Your own "
                    "headings go back on, in your own order, and anything the tailoring "
                    "introduced that your master resume does not list sits after them, "
                    "unlabelled, where you can see it.",
                    "אותם כישורים, אותן מילים — רק הסידור השתנה. הכותרות שלכם חוזרות, "
                    "בסדר שלכם, וכל מה שההתאמה הוסיפה ולא מופיע בקורות החיים הראשיים "
                    "שלכם בא אחריהן, בלי כותרת, במקום שבו תראו אותו.",
                ),
            )
        )
    else:
        _candidate = order_skills(tailored, resume)
        if _accept(_candidate):
            tailored = _candidate
    if tailored is not _pre_order and tailored is not _regrouped:
        # SAY SO, because the MODEL already said the opposite. It writes its own
        # skills changelog entry — "Reordered skills to surface Python,
        # automation tools, AI utilities, validation, logs, traceability … first"
        # was a real one — and this pass then moves exactly those to the end. Its
        # sentence is not deleted (identifying it means matching free text, which
        # would break the first time the wording drifted); it is ANSWERED, by a
        # later entry that describes the order actually on the page. Emitted only
        # when something moved: `order_skills` returns the same object when it
        # had nothing to say, so the gate is identity, like every other guard
        # here.
        changelog.append(
            ChangeLogEntry(
                section="skills",
                change=_say(
                    lang,
                    "Put your own wording first and the job ad's phrasing after it",
                    "הצבנו קודם את הניסוח שלכם, ואחריו את הניסוח של המודעה",
                ),
                reason=_say(
                    lang,
                    "Nothing was added or removed — only the order. The job's own "
                    "phrases score as relevant because they came from the posting, so they "
                    "were crowding out the tools you actually named. A reader sees your "
                    "stack first; the posting's wording is still there, further down, where "
                    "keyword matching reads it just the same.",
                    "שום דבר לא נוסף ולא הוסר — רק הסדר השתנה. הביטויים של המשרה נחשבים "
                    "רלוונטיים כי הם לקוחים מהמודעה, ולכן דחקו הצידה את הכלים שאתם עצמכם "
                    "ציינתם. קורא רואה קודם את הכלים שלכם; הניסוח של המודעה עדיין שם, "
                    "בהמשך, והתאמת מילות המפתח קוראת אותו בדיוק כמו קודם.",
                ),
            )
        )

    # BOTH LISTS ARE MEASURED HERE, after every stage that can change what the CV
    # says has finished. `restored` is "was lost before the restore and is at
    # target on the shipped document"; anything still lost is named with the
    # reason that is true of it. Nothing between the two ends ADDS content, so a
    # restored keyword always has a surviving entry behind it to name.
    restored, kept_back = report_restore(resume, pre_restore, tailored, jd, attempted)
    if restored:
        changelog.append(
            ChangeLogEntry(
                section="skills",
                # THE ENTRIES, and then the terms they answer. "Put back: REST
                # APIs" named the JD's phrase, which can appear nowhere in the
                # shipped CV even when the restore worked perfectly — the entries
                # behind it were ['REST', 'APIs'].
                change=_say(
                    lang,
                    "Put back: " + ", ".join(restored_entries()),
                    "החזרנו: " + ", ".join(restored_entries()),
                ),
                reason=_say(
                    lang,
                    "This job asks for " + ", ".join(restored)
                    + ". Those entries are your own wording, from your own resume, and "
                    "the rewrite had dropped them.",
                    "המשרה הזו מבקשת " + ", ".join(restored)
                    + ". הפריטים האלה הם הניסוח שלכם, מקורות החיים שלכם, והשכתוב השמיט אותם.",
                ),
            )
        )

    # Reported whether or not anything was restored: "this went missing and we
    # did not put it back" is the half that keeps the entry above honest. Split
    # by reason so each sentence can be true of its own class — a bigger number
    # fixes only the cap, and only `trimmed` is a loss WE caused rather than one
    # the user's own wording produced.
    #
    # THROUGH THE CHANGELOG, deliberately, and not through a new `TailorResult`
    # field. A changelog is a log of ACTIONS TAKEN, so its absence on a stored
    # kit or tracker row written before this guard existed means "no such
    # action", which is TRUE. A `kept_back: []` field would mean "nothing was
    # lost" on every one of those rows, which is false — the trap CLAUDE.md
    # names twice ("a row that predates the field means unknown, never zero").
    prose_losses = [k for k in kept_back if k.reason == "prose"]
    partial_losses = [k for k in kept_back if k.reason == "partial"]
    capped_losses = [k for k in kept_back if k.reason == "cap"]
    trimmed_losses = [k for k in kept_back if k.reason == "trimmed"]
    if prose_losses:
        where_at = list(dict.fromkeys(k.where for k in prose_losses if k.where))
        where = ", ".join(where_at)
        lost = ", ".join(k.keyword for k in prose_losses)
        changelog.append(
            ChangeLogEntry(
                section="keywords",
                change=_say(lang, "Not carried over: " + lost, "לא הועברו: " + lost),
                reason=_say(
                    lang,
                    "Your resume shows these only inside wording that was rewritten or "
                    + (f"trimmed ({where}). " if where else "trimmed. ")
                    + "We did not put them back: re-writing a sentence you did not write is "
                    "how a CV grows a claim you cannot defend.",
                    "בקורות החיים שלכם הם מופיעים רק בתוך ניסוח ששוכתב או "
                    + (f"קוצר ({', '.join(_HE_IN_SECTION.get(s, s) for s in where_at)}). " if where else "קוצר. ")
                    + "לא החזרנו אותם: לשכתב משפט שלא אתם כתבתם זו הדרך שבה קורות חיים "
                    "צוברים טענה שאי אפשר לעמוד מאחוריה.",
                ),
            )
        )
    if partial_losses:
        lost = ", ".join(k.keyword for k in partial_losses)
        changelog.append(
            ChangeLogEntry(
                section="keywords",
                change=_say(lang, "Partly carried over: " + lost, "הועברו חלקית: " + lost),
                # This class used to be reported as "prose", which contradicted
                # itself: the carriers are sitting in the skills list, so the
                # sentence above ("only inside wording") was false about them.
                reason=_say(
                    lang,
                    "Your skills list holds part of each of these, and those entries are "
                    "on the CV — but not the phrase this job uses. Writing the phrase itself "
                    "would be putting wording in your resume that you never used.",
                    "ברשימת הכישורים שלכם יש חלק מכל אחד מאלה, והפריטים האלה מופיעים "
                    "בקורות החיים — אבל לא הביטוי שהמשרה הזו משתמשת בו. לכתוב את הביטוי "
                    "עצמו פירושו להכניס לקורות החיים שלכם ניסוח שמעולם לא השתמשתם בו.",
                ),
            )
        )
    if capped_losses:
        lost = ", ".join(k.keyword for k in capped_losses)
        changelog.append(
            ChangeLogEntry(
                section="keywords",
                change=_say(lang, "Not carried over: " + lost, "לא הועברו: " + lost),
                reason=_say(
                    lang,
                    f"The skills list was already at its limit of {MAX_RESTORED} put-back "
                    "entries. Past that the space comes out of your projects and bullets, "
                    "which costs more than it buys.",
                    f"רשימת הכישורים כבר הגיעה למגבלה של {MAX_RESTORED} פריטים שהוחזרו. "
                    "מעבר לזה המקום בא על חשבון הפרויקטים והתבליטים שלכם, וזה עולה יותר "
                    "ממה שזה מרוויח.",
                ),
            )
        )
    if trimmed_losses:
        lost = ", ".join(k.keyword for k in trimmed_losses)
        changelog.append(
            ChangeLogEntry(
                section="keywords",
                change=_say(lang, "Not carried over: " + lost, "לא הועברו: " + lost),
                reason=_say(
                    lang,
                    "Putting your skills back cost more room than the page budget had, "
                    f"and the trim that followed removed these to hold {hard_max_pages} pages. "
                    "Your master resume still has them.",
                    "החזרת הכישורים דרשה יותר מקום ממה שמגבלת העמודים הרשתה, והקיצור "
                    f"שבא אחריה הסיר את אלה כדי לא לעבור {hard_max_pages} עמודים. "
                    "הם עדיין מופיעים בקורות החיים הראשיים שלכם.",
                ),
            )
        )

    # `score_after` used to share a pool with the CREDIBILITY review. That stage
    # is GONE — it produced 7-18 advisory flags per tailor for 31% of the wall
    # clock and the owner never read them, so it was removed rather than
    # deferred: a deferral needs a tri-state ("not yet reviewed" is a real third
    # state), and a deletion has none.
    #
    # THE LAST TWO TEXT STAGES (spec 07), after every stage that can change the
    # set and after the restore report, before `score_after` — so the score, the
    # guard and the changelog all describe the document that ships. Both are
    # deterministic and both return `tailored` ITSELF when they did nothing.
    _pre_text = tailored

    # R1 — leave Arabic off, when the user chose it and the job qualifies. It
    # only ever REMOVES, so it cannot create a fabrication flag or grow a page.
    if hide_arabic_in_israel:
        if omit_arabic_here:
            tailored, _arabic_removed, _arabic_left = omit_arabic(tailored)
            if _arabic_removed:
                changelog.append(
                    ChangeLogEntry(
                        section="languages",
                        change=_say(lang, "Left Arabic off", "השמטנו את הערבית"),
                        reason=_say(
                            lang,
                            "You chose to leave Arabic off resumes for jobs in Israel "
                            "(Settings). Your master resume still lists it.",
                            "בחרתם לא לציין ערבית בקורות חיים למשרות בישראל (בהגדרות). "
                            "היא עדיין מופיעה בקורות החיים הראשיים שלכם.",
                        ),
                    )
                )
            if _arabic_left:
                # REPORTED, NEVER REWRITTEN: a sentence this pipeline would have
                # to rephrase to remove the word is a sentence the user owns.
                changelog.append(
                    ChangeLogEntry(
                        section="languages",
                        change=_say(
                            lang,
                            "Arabic is still mentioned in your "
                            + " and ".join(_arabic_left)
                            + "; edit it before sending",
                            "ערבית עדיין מוזכרת " + _he_in(_arabic_left) + "; ערכו לפני השליחה",
                        ),
                        reason=_say(
                            lang,
                            "It is part of a sentence, not a list, and we do not rewrite "
                            "your sentences. Everything else was left off as you chose.",
                            "היא חלק ממשפט, לא מרשימה, ואנחנו לא משכתבים את המשפטים שלכם. "
                            "כל השאר הושמט כפי שבחרתם.",
                        ),
                    )
                )
        elif resume_mentions_arabic(tailored):
            # THE HONEST HALF: the preference is on and Arabic is on the page, so
            # say why — the owner can still remove it by hand. Silent on a job
            # KNOWN to be abroad: there is nothing to decide there.
            if jd.market == MARKET_IL:
                changelog.append(
                    ChangeLogEntry(
                        section="languages",
                        change=_say(
                            lang,
                            "Arabic kept: this job asks for it",
                            "הערבית נשארה: המשרה הזו מבקשת אותה",
                        ),
                        reason=_say(
                            lang,
                            "You chose to leave Arabic off resumes for jobs in Israel, "
                            "but this posting names Arabic, so leaving it off would hide a "
                            "skill the job wants.",
                            "בחרתם לא לציין ערבית בקורות חיים למשרות בישראל, אבל המודעה "
                            "הזו מזכירה ערבית, ולהשמיט אותה היה מסתיר כישור שהמשרה מחפשת.",
                        ),
                    )
                )
            elif jd.market != MARKET_OTHER:
                changelog.append(
                    ChangeLogEntry(
                        section="languages",
                        change=_say(
                            lang,
                            "Arabic kept: we couldn't tell this job is in Israel",
                            "הערבית נשארה: לא הצלחנו לדעת אם המשרה בישראל",
                        ),
                        reason=_say(
                            lang,
                            "You chose to leave Arabic off resumes for jobs in Israel. "
                            "This posting does not say where the job is — if it is in Israel, "
                            "remove Arabic before sending.",
                            "בחרתם לא לציין ערבית בקורות חיים למשרות בישראל. המודעה הזו "
                            "לא אומרת איפה המשרה — אם היא בישראל, הסירו את הערבית לפני השליחה.",
                        ),
                    )
                )

    # R2 — numbers as digits in the tailored PROSE, the last text stage.
    tailored, _digits, _digits_section = digits_in_resume(tailored)
    if _digits:
        # THE GUARD READS DIGITS ONLY (`structurer._NUMBER_RE`), so a number the
        # model invented IN WORDS was invisible to it — and is visible now that it
        # is a digit. Re-run it against a COPY of the ledger that also knows the
        # ORIGINAL resume's own quantity words, converted by the same function:
        # "five years" shipped as "5 years" is the candidate's fact, while an
        # invented "fifteen engineers" is not. Built from the original resume at
        # runtime, never from how the ledger was made — the kit path passes a
        # STORED ledger. The ledger itself is never mutated.
        _ledger_words = ledger.model_copy(
            update={"numbers": [*ledger.numbers, *quantity_phrases(resume)]}
        )
        flags = check_fabrication(tailored, _ledger_words)
        changelog.append(
            ChangeLogEntry(
                section=_digits_section or "summary",
                change=_say(
                    lang,
                    f"Wrote {_digits} number{'s' if _digits != 1 else ''} as digits",
                    "כתבנו מספר אחד בספרות" if _digits == 1 else f"כתבנו {_digits} מספרים בספרות",
                ),
                reason=_say(
                    lang,
                    "Recruiters skim for numbers; '5 years' reads faster than 'five years'.",
                    "מגייסים סורקים בחיפוש אחר מספרים; '5 שנים' נקרא מהר יותר מ'חמש שנים'.",
                ),
            )
        )

    if tailored is not _pre_text:
        # What shipped changed, so the two reports that describe it are
        # re-measured rather than carried: the page count (both stages only ever
        # shorten text, so this can only fall) and the voice audit, whose
        # humanizer bookkeeping is carried across by hand as above.
        length_report.pages_after = page_count(tailored, template)
        was_revised, was_fixed = report.revised, report.fixed
        report = audit_voice(tailored, jd)
        report.revised, report.fixed = was_revised, was_fixed

    # Inline, not a one-member pool: that would be a thread spawn and a context
    # copy for zero concurrency. It is also the SAFER spelling — `copy_context()
    # .run` exists only because a pool worker starts from an EMPTY context, and a
    # call on the request's own thread is natively visible to `metering`.
    score_after = score_resume(tailored, jd)

    return TailorResult(
        tailored_resume=tailored,
        changelog=changelog,
        covered_keywords=covered,
        fabrication_flags=flags,
        score_before=score_before,
        score_after=score_after,
        voice_report=report,
        plan=plan,
        length_report=length_report,
    )
