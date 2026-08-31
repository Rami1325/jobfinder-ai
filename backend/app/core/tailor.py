"""The tailoring engine: score -> plan -> rewrite -> guard -> humanize ->
credibility review -> rescore (the humanization-spec pipeline)."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context

from app.config import get_settings
from app.core.credibility import review_credibility
from app.core.cv_planner import plan_cv
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
from app.core.scorer import score_resume
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


def _dedupe_skills(raw: object) -> object:
    """Drop repeated entries from the model's flat skills list. First wins.

    MEASURED on the shipped configuration: 3 of 12 real-key runs returned the
    same entry twice — `AI agents`, `webhooks`, `Python` — and every one of them
    shipped. `skills.skill_blocks` hands the flat list straight to both
    renderers and `ResumeView` mirrors it, so a repeat is a chip drawn twice on
    the page the user sends. `ResumeModel`'s union validator cannot catch it: it
    dedupes what it ADDS from `skill_groups` and seeds `seen` FROM the flat
    list, so a flat list handed in already carrying repeats is passed through
    untouched.

    It also breaks the cap. `shortlist_skills` counts `cap` against a SET of
    kept strings and then emits `[s for s in resume.skills if s in keep]`, so a
    duplicate buys a free slot — cap 30 shipped 31 and 32, under a changelog
    line announcing the cut to "the 32 this job asks for".

    HERE, beside the `skill_groups` strip, and NOT in a `model_validator` — the
    reason the multi-skill splitter documents one door over: a validator runs on
    every construction, i.e. every READ of every stored master, tracker résumé,
    saved kit and version snapshot, and would rewrite all of them without any of
    them being a write. This is the one place a raw TAILOR response becomes a
    résumé.

    IT MAY ONLY EVER REMOVE. The first occurrence keeps its position and the
    model's own spelling: `shortlist_skills` selects in the model's order and
    `order_skills` partitions that order without re-sorting inside it, so the
    model's relative ranking is still carried all the way to the page and
    dropping the FIRST copy instead of the second would move an entry the model
    ranked. The key is stripped and casefolded because
    `['Python', 'python', '  Python  ']` renders as three chips, not one.

    Shape-guarded rather than coerced: a response whose `skills` is not a list
    of strings is returned exactly as it arrived, so `ResumeModel.model_validate`
    still reports it as the validation error it is instead of this function
    dying on it first with a worse message.
    """
    if not isinstance(raw, list) or not all(isinstance(s, str) for s in raw):
        return raw
    out: list[str] = []
    seen: set[str] = set()
    for s in raw:
        key = s.strip().casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
    return out


def tailor_resume(
    resume: ResumeModel,
    jd: JDModel,
    ledger: FactsLedger | None = None,
    avoid_phrases: list[str] | None = None,
    template: str = DEFAULT_TEMPLATE,
) -> TailorResult:
    """`avoid_phrases`: wording this user rejected in past reviews (§26
    feedback loop) — injected into the tailor prompt as a hard avoid-list.
    `template`: which résumé template the page budget measures against."""
    if ledger is None:
        ledger = build_facts_ledger(resume)

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
    with ThreadPoolExecutor(max_workers=2) as pool:
        _score_before = pool.submit(copy_context().run, score_resume, resume, jd)
        # Stage 4 (positioning): decide the professional story before writing —
        # including WHICH projects earn their space in this particular CV.
        # Best-effort — a failed plan (None) tailors without one.
        _plan = pool.submit(copy_context().run, plan_cv, resume, jd)
        score_before = _score_before.result()
        plan = _plan.result()

    client = get_llm_client()
    data = client.complete_json(
        # Hebrew résumé => tailor in Hebrew (note appended AFTER the Task tag).
        prompts.with_resume_language(prompts.TAILOR_SYSTEM, resume_language(resume)),
        prompts.tailor_user(
            resume.model_dump_json(),
            jd.model_dump_json(),
            plan_json=plan.model_dump_json() if plan else "",
            avoid_phrases=avoid_phrases,
            max_pages=max_pages,
            source_pages=page_count(resume, template),
            source_projects=len(resume.projects),
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
        raw_tailored["skills"] = _dedupe_skills(raw_tailored["skills"])
    tailored = ResumeModel.model_validate(raw_tailored)
    changelog = [ChangeLogEntry.model_validate(c) for c in data.get("changelog", [])]
    covered = list(data.get("covered_keywords", []))

    # Structural repair first: "roles are protected, projects are droppable"
    # gives the model a way to rescue a project it likes — promote it into
    # experience, where nothing may remove it — and the output then claims
    # employment that never happened. Cut those rows before anything measures
    # or audits the résumé.
    tailored, invented_roles = drop_invented_roles(tailored, ledger)
    if invented_roles:
        changelog.append(
            ChangeLogEntry(
                section="experience",
                change="Removed " + ", ".join(invented_roles) + " from Experience",
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
                reason="Not employers in your résumé — they were projects promoted into "
                "job entries. If this was a project, it is in Projects only if the "
                "rewrite kept it there.",
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
    # earlier would leave the restore un-guaranteed. Before credibility and
    # `score_after`, so both describe the résumé that actually ships.
    pre_restore = tailored
    tailored, _, attempted = preserve_keywords(resume, tailored, jd)
    # THE GUARD'S OWN `restored` LIST IS DROPPED ON THE FLOOR HERE, deliberately.
    # It describes the résumé `preserve_keywords` returned, and every line below
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
        #   "Your master résumé lists 75 skills" — 75 is what the MODEL
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
        # master résumé" is the same class of false sentence as the two above.
        own = {s.strip() for s in resume.skills}
        recoverable = [s for s in dropped_noise if s.strip() in own]
        # A COUNT AND A SAMPLE, never the whole list: the master's tail can run
        # to forty entries and a changelog paragraph naming all of them is not a
        # log, it is the section over again.
        sample = ", ".join(recoverable[:6])
        changelog.append(
            ChangeLogEntry(
                section="skills",
                change=(
                    f"Cut the skills list from {n_before} to {len(tailored.skills)}, "
                    "ranked by how well each matches this posting"
                ),
                reason=(
                    f"The draft came back with {n_before} skills; a CV for one job is a "
                    "shortlist a recruiter reads in about three seconds. Nothing this "
                    "posting names was dropped."
                    + (
                        f" {sample}"
                        + (" and others" if len(recoverable) > 6 else "")
                        + " stay in your master résumé."
                        if sample
                        else ""
                    )
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
            # what ships. Gated on the restore being what caused it: a résumé
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
    # A stable partition of the same entries — see `order_skills` for the
    # measurement, and note that every counterweight this pipeline reports
    # (coverage, lost keywords, fabrication flags, pages) is a function of the
    # set and therefore provably unmoved.
    tailored = order_skills(tailored, resume)

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
                change="Put back: " + ", ".join(restored_entries()),
                reason="This job asks for " + ", ".join(restored)
                + ". Those entries are your own wording, from your own résumé, and "
                "the rewrite had dropped them.",
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
        where = ", ".join(dict.fromkeys(k.where for k in prose_losses if k.where))
        changelog.append(
            ChangeLogEntry(
                section="keywords",
                change="Not carried over: " + ", ".join(k.keyword for k in prose_losses),
                reason="Your résumé shows these only inside wording that was rewritten or "
                + (f"trimmed ({where}). " if where else "trimmed. ")
                + "We did not put them back: re-writing a sentence you did not write is "
                "how a CV grows a claim you cannot defend.",
            )
        )
    if partial_losses:
        changelog.append(
            ChangeLogEntry(
                section="keywords",
                change="Partly carried over: " + ", ".join(k.keyword for k in partial_losses),
                # This class used to be reported as "prose", which contradicted
                # itself: the carriers are sitting in the skills list, so the
                # sentence above ("only inside wording") was false about them.
                reason="Your skills list holds part of each of these, and those entries are "
                "on the CV — but not the phrase this job uses. Writing the phrase itself "
                "would be putting wording in your résumé that you never used.",
            )
        )
    if capped_losses:
        changelog.append(
            ChangeLogEntry(
                section="keywords",
                change="Not carried over: " + ", ".join(k.keyword for k in capped_losses),
                reason=f"The skills list was already at its limit of {MAX_RESTORED} put-back "
                "entries. Past that the space comes out of your projects and bullets, "
                "which costs more than it buys.",
            )
        )
    if trimmed_losses:
        changelog.append(
            ChangeLogEntry(
                section="keywords",
                change="Not carried over: " + ", ".join(k.keyword for k in trimmed_losses),
                reason="Putting your skills back cost more room than the page budget had, "
                f"and the trim that followed removed these to hold {hard_max_pages} pages. "
                "Your master résumé still has them.",
            )
        )

    # THE TAIL, and the same argument: both of these read the finished `tailored`
    # and neither reads the other. Measured medians: CREDIBILITY 5.71 s,
    # FIT_SCORE 1.20 s — serially 6.91 s, concurrently 5.71 s.
    #
    # Stage 11 (credibility) is true-but-overstated wording the candidate may
    # struggle to defend in an interview: advisory flags, never auto-removal.
    # It is the single slowest call in the pipeline at 31% of the wall clock, and
    # because it is advisory it is also the obvious candidate for dropping out of
    # the response entirely — NOT DONE HERE, deliberately. `TailorPage` and
    # `KitReviewPage` both read `result.credibility_flags`, and a stored kit
    # persists the whole result JSON, so deferring it is a response-contract
    # change with a frontend and a persistence half. That is its own slice; this
    # one is behaviour-identical.
    with ThreadPoolExecutor(max_workers=2) as pool:
        _cred = pool.submit(copy_context().run, review_credibility, tailored, jd)
        _after = pool.submit(copy_context().run, score_resume, tailored, jd)
        credibility_flags = _cred.result()
        score_after = _after.result()

    return TailorResult(
        tailored_resume=tailored,
        changelog=changelog,
        covered_keywords=covered,
        fabrication_flags=flags,
        score_before=score_before,
        score_after=score_after,
        voice_report=report,
        plan=plan,
        credibility_flags=credibility_flags,
        length_report=length_report,
    )
