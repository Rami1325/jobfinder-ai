"""Real-key A/B harness for the INBOX_CLASSIFY classifier (Phase 29 / B2).

**Never part of the smoke test, and never run by CI.** A model arm makes one real
OpenAI call for every fixture email the rules pass to the model, and spends the
account's credit. `--stub` is the free plumbing check, and the only mode an
unattended run may use.

WHAT IS HELD CONSTANT. The fixtures (`tests/fixtures/inbox_eval/*.json`) are
synthetic mail modelled on the shapes a real job seeker's inbox showed on
2026-09-13 — LinkedIn and ATS confirmations and rejections, recruiter invites in
English and Hebrew, assessments, offers, alert digests, personal and transactional
mail — each carrying its expected reading. Every arm runs the SAME deterministic
stage first, and it is the app's own: `inbox_sync._stage` decides noise,
templates and candidates exactly as a sync does, and only what it passes on
reaches the model, through the app's own `inbox_classifier.classify` — the real
INBOX_CLASSIFY prompt and the real post-validation. A harness with its own filter
or its own prompt would grade a pipeline that does not ship: the "one matcher,
one answer" rule, applied to the grader.

WHAT IS MEASURED, per model:
- kind accuracy over the job emails (a rule's verdict counts as the pipeline's
  answer, because that is what the tracker acts on);
- company match, compared with the app's own `normalize_company`;
- false positives: a not-job email read as job-related (a card nobody applied for);
- rejection read as interview: the one error the decision rule allows none of,
  because it moves a closed application into the Interview column;
- noise leaks and skipped job mail: failures of the RULES, independent of the
  model, reported on every arm so a rules regression cannot hide behind a model;
- model calls the rules avoided, p50/p95 latency, prompt + completion tokens, and
  an estimated cost where a price is known.

THE DECISION RULE, written before any run: the cheapest model whose kind accuracy
is within 3 points of the best AND that reads no rejection as an interview. Set
INBOX_MODEL_ID (and `inbox_classifier.DEFAULT_MODEL`) to it and record the table.
Prices move — check the provider's pricing page and pass `--price`; the defaults
below are only there so a table prints.

USAGE (from backend/):

    .\\.venv\\Scripts\\python.exe -m tests.inbox_eval --stub
    .\\.venv\\Scripts\\python.exe -m tests.inbox_eval --models gpt-4.1-nano,gpt-5.4-nano,gpt-4o-mini
    .\\.venv\\Scripts\\python.exe -m tests.inbox_eval --models gpt-4.1-nano --reps 3 --out runs/inbox.json
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402
from app.core import inbox_classifier, inbox_rules, inbox_sync  # noqa: E402
from app.core.gmail_api import FakeMailbox, FakeMessage  # noqa: E402
from app.llm import metering  # noqa: E402
from app.llm.client import LLMClient, OpenAIClient, StubClient  # noqa: E402

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures" / "inbox_eval"
FIXTURE_FILES = ("emails_en.json", "emails_he_noise_edge.json")
# USD per 1M tokens (input, output) — for the estimate only. VERIFY before deciding.
DEFAULT_PRICES: dict[str, tuple[float, float]] = {
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4.1-nano": (0.10, 0.40),
}
ACCURACY_BAND = 3.0
# The fixture's own alert mail (n07) comes from this address. A deployment sets it
# as ALERT_EMAIL_FROM; the harness passes it the same way the sync would.
DEFAULT_ALERT_SENDER = "alerts-sender@example.com"


def load_fixtures(directory: Path = FIXTURES) -> list[dict[str, Any]]:
    emails: list[dict[str, Any]] = []
    for name in FIXTURE_FILES:
        path = directory / name
        rows = json.loads(path.read_text(encoding="utf-8"))
        for row in rows:
            row["_file"] = name
        emails.extend(rows)
    return emails


def mailbox_for(emails: list[dict[str, Any]]) -> FakeMailbox:
    return FakeMailbox([
        FakeMessage(
            id=e["id"],
            internal_ms=int(datetime.fromisoformat(e["date"]).timestamp() * 1000),
            from_name=e.get("from_name", ""),
            from_email=e.get("from_email", ""),
            subject=e.get("subject", ""),
            snippet=e.get("snippet", ""),
            body=e.get("body", ""),
            thread_id=e["id"],
        )
        for e in emails
    ])


@dataclass
class Arm:
    model: str
    reps: int = 1
    n_job: int = 0
    kind_correct: int = 0
    company_scored: int = 0
    company_correct: int = 0
    title_close: int = 0
    n_not_job: int = 0
    false_positives: int = 0
    rejection_as_interview: int = 0
    noise_leaks: int = 0
    job_skipped: int = 0
    rule_decided: int = 0
    model_calls: int = 0
    errors: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    latencies_ms: list[float] = field(default_factory=list)
    misses: list[dict[str, Any]] = field(default_factory=list)

    def pct(self, part: int, whole: int) -> float:
        return round(100.0 * part / whole, 1) if whole else 0.0

    @property
    def kind_accuracy(self) -> float:
        return self.pct(self.kind_correct, self.n_job)

    def cost(self, prices: dict[str, tuple[float, float]]) -> float | None:
        price = prices.get(self.model)
        if price is None:
            return None
        return round(self.prompt_tokens / 1e6 * price[0] + self.completion_tokens / 1e6 * price[1], 6)

    def latency(self, q: float) -> float:
        if not self.latencies_ms:
            return 0.0
        ordered = sorted(self.latencies_ms)
        return round(ordered[min(len(ordered) - 1, int(q * len(ordered)))], 1)


def read_one(
    email: dict[str, Any], box: FakeMailbox, alert_senders: tuple[str, ...], client: LLMClient, arm: Arm
) -> dict[str, Any]:
    """The pipeline's reading of one email: the app's own deterministic stage,
    then — only if it passes the email on — the app's own classifier."""
    run = SimpleNamespace(exclude=alert_senders, box=box)
    meta = box.get_meta(email["id"])
    staged = inbox_sync._stage(run, meta)
    reading: dict[str, Any] = {"stage": staged.stage, "kind": staged.stage, "company": "", "job_title": ""}
    if staged.stage == "rule" and staged.verdict is not None:
        arm.rule_decided += 1
        reading.update(kind=staged.verdict.kind, company=staged.verdict.company, job_title=staged.verdict.job_title)
    elif staged.stage == "model":
        body = box.get_body(meta.id)
        started = time.perf_counter()
        try:
            with metering.meter() as tally:
                verdict = inbox_classifier.classify(meta, body, client=client)
        except Exception as e:  # noqa: BLE001 - an arm's failure is data, not a crash
            arm.errors += 1
            reading.update(kind="error", error=f"{type(e).__name__}: {e}"[:200])
            return reading
        arm.latencies_ms.append((time.perf_counter() - started) * 1000)
        arm.model_calls += 1
        arm.prompt_tokens += tally.prompt
        arm.completion_tokens += tally.completion
        reading.update(
            kind=verdict.kind if verdict.is_job_related else "not_job",
            company=verdict.company,
            job_title=verdict.job_title,
            confidence=verdict.confidence,
            evidence=verdict.evidence,
        )
    return reading


def score(email: dict[str, Any], reading: dict[str, Any], arm: Arm) -> None:
    expected = email.get("expected") or {}
    got = reading["kind"]
    miss = ""
    if expected.get("noise"):
        if got != "noise":
            arm.noise_leaks += 1
            miss = "noise leaked past the rules"
    elif expected.get("kind") == "not_job":
        arm.n_not_job += 1
        if got in inbox_rules.KINDS:
            arm.false_positives += 1
            miss = "not-job mail read as job-related"
    elif expected.get("kind"):
        arm.n_job += 1
        want = expected["kind"]
        if got in ("skip", "noise"):
            arm.job_skipped += 1
            miss = f"job mail dropped by the rules as {got}"
        if got == want:
            arm.kind_correct += 1
        elif not miss:
            miss = f"kind {got} != {want}"
        if want == "rejection" and got == "interview":
            arm.rejection_as_interview += 1
        # A recruiter's company is not scored. The prompt's rule 2 (Phase 29
        # amendment I6) makes `company` the HIRING employer and "" when an agency
        # hides its client, while the fixtures name the agency itself — so the
        # correct answer and the fixture disagree by design on exactly these rows.
        if want != "recruiter":
            arm.company_scored += 1
            exp_company = inbox_rules.normalize_company(expected.get("company", ""))
            if inbox_rules.normalize_company(reading.get("company", "")) == exp_company:
                arm.company_correct += 1
            elif got == want and not miss:
                miss = f"company {reading.get('company')!r} != {expected.get('company')!r}"
        exp_title, got_title = expected.get("job_title", ""), reading.get("job_title", "")
        if (not exp_title and not got_title) or inbox_rules.title_similarity(exp_title, got_title) >= 0.5:
            arm.title_close += 1
    if miss:
        arm.misses.append({"id": email["id"], "why": miss, "reading": reading})


def run_arm(
    model: str, client: LLMClient, emails: list[dict[str, Any]], alert_senders: tuple[str, ...], reps: int
) -> Arm:
    arm = Arm(model=model, reps=reps)
    for _ in range(reps):
        box = mailbox_for(emails)
        for email in emails:
            score(email, read_one(email, box, alert_senders, client, arm), arm)
    return arm


def decide(arms: list[Arm], prices: dict[str, tuple[float, float]]) -> dict[str, Any]:
    real = [a for a in arms if a.model != "stub"]
    if not real:
        return {"chosen": None, "why": "stub run: plumbing only, nothing to decide"}
    best = max(a.kind_accuracy for a in real)
    eligible = [a for a in real if a.kind_accuracy >= best - ACCURACY_BAND and a.rejection_as_interview == 0]
    if not eligible:
        return {"chosen": None, "why": "no model is within the band with zero rejection-as-interview errors"}

    def expense(a: Arm) -> tuple[int, float]:
        cost = a.cost(prices)
        return (0, cost) if cost is not None else (1, float(a.prompt_tokens + a.completion_tokens))

    chosen = min(eligible, key=expense)
    return {
        "chosen": chosen.model,
        "why": f"cheapest within {ACCURACY_BAND} points of the best kind accuracy ({best}%) "
               "with no rejection read as an interview",
        "eligible": [a.model for a in eligible],
    }


def print_table(arms: list[Arm], prices: dict[str, tuple[float, float]]) -> None:
    head = (f"{'model':<16}{'kind%':>7}{'company%':>10}{'title%':>8}{'FP':>4}{'rej->int':>9}"
            f"{'leaks':>6}{'skipped':>8}{'rules':>6}{'calls':>6}{'err':>4}{'p50ms':>8}{'p95ms':>8}"
            f"{'tok in':>8}{'tok out':>8}{'cost $':>10}")
    print(head)
    print("-" * len(head))
    for a in arms:
        cost = a.cost(prices)
        print(
            f"{a.model:<16}{a.kind_accuracy:>7}{a.pct(a.company_correct, a.company_scored):>10}"
            f"{a.pct(a.title_close, a.n_job):>8}{a.false_positives:>4}{a.rejection_as_interview:>9}"
            f"{a.noise_leaks:>6}{a.job_skipped:>8}{a.rule_decided:>6}{a.model_calls:>6}{a.errors:>4}"
            f"{a.latency(0.5):>8}{a.latency(0.95):>8}{a.prompt_tokens:>8}{a.completion_tokens:>8}"
            f"{('-' if cost is None else f'{cost:.5f}'):>10}"
        )


def _prices(overrides: list[str]) -> dict[str, tuple[float, float]]:
    prices = dict(DEFAULT_PRICES)
    for item in overrides:
        name, _, pair = item.partition("=")
        low, _, high = pair.partition(",")
        prices[name.strip()] = (float(low), float(high))
    return prices


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--stub", action="store_true", help="offline plumbing check with the stub client (free)")
    parser.add_argument("--models", default="", help="comma-separated real model ids (SPENDS MONEY)")
    parser.add_argument("--reps", type=int, default=1, help="repeat every model arm this many times")
    parser.add_argument("--out", default="", help="write the full result as JSON to this path")
    parser.add_argument("--alert-sender", default=DEFAULT_ALERT_SENDER,
                        help="the deployment's ALERT_EMAIL_FROM, which the rules drop as our own alert mail")
    parser.add_argument("--price", action="append", default=[], metavar="MODEL=IN,OUT",
                        help="USD per 1M input,output tokens; repeatable")
    args = parser.parse_args(argv)

    models = [m.strip() for m in args.models.split(",") if m.strip()]
    if not args.stub and not models:
        parser.print_help()
        return 2
    emails = load_fixtures()
    alert_senders = (args.alert_sender,) if args.alert_sender else ()
    prices = _prices(args.price)
    arms: list[Arm] = []
    if args.stub:
        arms.append(run_arm("stub", StubClient(), emails, alert_senders, 1))
    if models:
        key = get_settings().openai_api_key
        if not key:
            print("OPENAI_API_KEY is not set: a model arm needs the real key (use --stub for a free run).")
            return 2
        print(f"Spending real credit: {len(models)} model(s) x {max(1, args.reps)} rep(s).")
        for model in models:
            # A separate client per arm, for the reason the classifier has its own
            # client in the app: a probe set shared across models would carry one
            # model's rejected parameter into the next one's calls.
            arms.append(run_arm(model, OpenAIClient(key, model), emails, alert_senders, max(1, args.reps)))

    print(f"{len(emails)} fixture emails "
          f"({sum(1 for e in emails if e.get('expected', {}).get('noise'))} noise, "
          f"{sum(1 for e in emails if e.get('expected', {}).get('kind') == 'not_job')} not-job)\n")
    print_table(arms, prices)
    decision = decide(arms, prices)
    print(f"\ndecision: {decision['chosen'] or '-'} — {decision['why']}")
    for arm in arms:
        if arm.misses:
            print(f"\n{arm.model}: {len(arm.misses)} miss(es)")
            for miss in arm.misses[:25]:
                print(f"  {miss['id']}: {miss['why']}")
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps({
            "run_at": datetime.now(timezone.utc).isoformat(),
            "fixtures": list(FIXTURE_FILES),
            "decision_rule": f"cheapest model within {ACCURACY_BAND} kind-accuracy points of the best, "
                             "with zero rejection-as-interview errors",
            "prices_per_1m": prices,
            "arms": [
                {**{k: v for k, v in vars(a).items() if k != "latencies_ms"},
                 "kind_accuracy": a.kind_accuracy, "p50_ms": a.latency(0.5), "p95_ms": a.latency(0.95),
                 "cost_usd": a.cost(prices)}
                for a in arms
            ],
            "decision": decision,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
