# The Gmail inbox scanner — a tracker that reads its own replies

> **Handbook file.** Split out of `CLAUDE.md` on 2026-09-21, **verbatim** — `CLAUDE.md` keeps the index and the
> house rules, this file keeps the full record for one department. Section titles are the originals, so an older
> pointer such as "CLAUDE.md's *Phase 22* section" (PLAN.md, code comments) resolves here. Every bullet records a
> defect that shipped or a measurement that cost money: edit it the way you would edit code, and add new findings
> here, not back in `CLAUDE.md`.
>
> **Read before touching** `core/google_oauth.py`, `gmail_api.py`, `inbox_rules.py`, `inbox_classifier.py`,
> `inbox_sync.py`, `inbox_apply.py`, `token_crypto.py`, `api/inbox_routes.py`, `components/inbox/**` or the cron
> entries in `vercel.json`. This is the Gmail half of **Phase 29** (2026-09-13): the phase's intro, its review
> provenance (`B<n>` = smoke pin, `F<n>` = check-mirrors 30) and its deferred / known-open list — which includes
> the inbox's open items (the Spam-rescue gap, the unconfirmed real Google path, the hand-mirrored error codes) —
> are in `accounts-and-auth.md`. The classifier's real-key harness and the model decision are in `testing.md`.

### Phase 29 — the inbox half

**Gmail OAuth.**
- **The connect is bound to the browser that started it** (O1). `POST /inbox/google/start` sets `jf_oauth` (random, 600 s) and the state row stores its HMAC; the callback requires it in constant time, deletes it, and checks it BEFORE the state is consumed. A connect started with a session needs that same session back (none → `/login?next=/settings`; another account → `state_mismatch`). PKCE on top.
- **The invite-code exception is deliberate and was reviewed.** `X-App-Key` is a header Google's redirect cannot carry, so a connect started by code (the admin, the friends beta) completes on the binding cookie alone. Judged not exploitable because `CORS_ORIGINS` is an explicit list and `*.vercel.app` is on the public suffix list, so a foreign page can neither send the start request nor toss the cookie. **Widening `CORS_ORIGINS` to another origin, or moving under a shared parent domain, re-opens it.**
- **The redirect URI is built from `APP_BASE_URL`, never `request.url_for`** — behind the `/api` mount and the Vite proxy a derived URI never matches the registered one — so `google_ready` is false until `APP_BASE_URL` is set.
- **Who may connect: `INBOX_ACCESS=allowlist` (default) = `users.inbox_enabled` or admin** (O2), and since FIXB B15 the sync and the cron re-check it, so clearing `inbox_enabled` stops the reading rather than only the connect button. `GOOGLE_OAUTH_TESTING=true` sets `reauth_due_at = connected_at + 7 days`: Testing-mode grants expire weekly.
- **A grant is handed back whenever we stop holding it**: a refused callback (`missing_scope`, `profile_failed`) revokes the token it just received (FIXB B16); reconnecting as a DIFFERENT address revokes the old grant and restarts the import from its own backfill depth, while the same address revokes nothing (FIXB B8); Disconnect and the wipe report `google_revoked` false instead of claiming a revoke when `INBOX_TOKEN_KEY` is missing (FIXB B17). Refresh tokens are Fernet-encrypted (`token_crypto`, key rotation supported); **losing `INBOX_TOKEN_KEY` disconnects everyone.**

**The network door.**
- **Every call to Google goes through `google_oauth._http`: https only, host in `_HOSTS` (four Google hosts), a redirect is an error, 20 s timeout, JSON.** `gmail_api` only builds requests. **This is NOT the SSRF door and must not be "fixed" into `job_match._http_get`**: nothing here takes a URL from anyone, and for a constant URL a fixed allowlist proves the host IS Google, where `net_guard` can only prove it is public. Pinned both ways: every URL literal in the module names an allowed host, and the network is opened nowhere but inside `_http`. `_transport` is the offline seam.

**Rules before the model.**
- **The Gmail query is narrowed server-side** (I1: `after:`/`before:` in epoch SECONDS, job vocabulary en+he OR an ATS/LinkedIn application sender, `-in:sent -in:drafts -in:chats`, minus the alert senders), and the deterministic stage decides next: alert digests are noise; templated confirmations and "viewed" mails are rule-classified with NO model call — **only for a job sender and never for a Re:/Fwd: subject**, because universities and landlords write the same subject lines.
- **Everything else carrying job vocabulary reaches the model, so non-job mail with a job word in it DOES go to OpenAI.** The privacy page, Settings and the landing FAQ said such mail was set aside "before any AI sees it"; that was false and was corrected in both locales (review F2, pinned by check-mirrors 30). Keep the copy and `inbox_rules.candidate_reason` telling the same story.
- **The classifier runs on its own client, `inbox_classifier.get_inbox_llm_client`** (`INBOX_MODEL_ID`, default `gpt-4.1-nano` — see `testing.md`). Patch THAT name to observe calls, not the client factory. The model is not trusted with the answer: evidence must appear verbatim (whitespace collapsed), the company is the HIRING employer or `""` when an agency hides it, and a platform or generic sender name (LinkedIn, Comeet, HR, Talent, `גיוס`, `צוות`…) is never a company.
- **Metering: every `/inbox/*` route is plain `Depends(current_user)`; the only charges are the `inbox` daily cap (`DAILY_INBOX_CAP`, charging what is left, never all-or-nothing) and tokens under `action="inbox_tokens"`** — never the `llm` cap, pinned by a capped friend whose `llm` row is unchanged by a sync. Both pools submit through `copy_context().run`.
- **One unreadable message may not stall the import** (FIXB B3). A message whose body read or model call fails stops the run the FIRST time with the cursor before it; the second time it is recorded as skipped — id and error code only, no subject, snippet or sender — the cursor moves past it, and it is not charged again. Before, one bad message was re-classified and re-charged every run, forever.

**The windowed backfill.**
- **The import walks FORWARD from the oldest day** (I2, a critique blocker). Gmail lists newest first, so "list after 60 days ago, take 500" imports the last week or two and skips exactly the confirmations that carry the real applied dates. The connection holds `window_lo_ms` (the next unfinished 7-day window) and `cursor_ms` (everything at or below it is handled); a run lists from `max(window_lo, cursor + 1)`, halves the window past 2,000 ids or past what the run can read in its budget, advances the cursor only across the CONTIGUOUS handled prefix with same-millisecond messages together, and moves the window only when all of it is done. Windows end 5 minutes before now so an unindexed message cannot fall behind the cursor. Once the windows reach the present the same arithmetic is the incremental sync.
- **A lease (`sync_lock_until`) keeps a cron run and a "Sync now" tap from classifying the same mail twice.** The UI runs at most 3 foreground rounds and says the import continues; the cron carries an unfinished backfill on.

**Tracker writes.**
- **Monotonic**: saved → applied → interview → offer, or rejected. An email never moves a card backwards and never changes an offer or rejected card; a different verdict waits in Needs review. Low confidence (`INBOX_REVIEW_THRESHOLD`), several candidate cards, a title similarity under 0.5, or a blank/agency company all go to review.
- **Rule 5 covers EVERY row the inbox did not write, not just manual edits** (I4). `marker = status_changed_at or created_at`; when `status_source != "email"` — manual, kit, extension and legacy `""` alike — an email older than the marker may still move a confirmation saved → applied, sends an interview/offer/rejection to review, and otherwise only links. Without it a first 60-day import lands a two-month-old rejection from a PREVIOUS application on the card made today. Writers stamp `status_source` and `applied_at`: POST, PATCH (`manual` only when the status changes) and `auto_submit`, which also stamps `status_changed_at` now (FIXB B13).
- **`execute` re-plans against the FRESH row** (FIXB B9). The plan was made from a card snapshot taken at the start of a run up to 240 s long, so a card the user dragged to Offer mid-sync was overwritten to rejected.
- **A short company name matches only as a WHOLE word of the longer one** (FIXB B10): IBM ~ IBM Israel, Wix ~ Wix.com, while HP never matches Hapoalim. The old ≥4-character floor created a phantom rejected card beside the tracked IBM one.
- **Honest dates** (I3): an inbox-created card is dated by its earliest email, and `applied_at` stays nullable and comes only from a confirmation — a rejection proves nobody's send date. The analytics bucket on `applied_at ?? created_at`.
- **Honest interviews** (I5): every matched interview email sets `interviewed` even when the status does not move, an assessment moves nothing, and **Undo clears `interviewed` only when no other interview email remains on the card** (FIXB B11). The header tile and the funnel read ONE definition, `interviewed || status === "interview"` (review F3).
- **Undo is exact, and it respects the user's edits**: an email-created card goes with its Undo only while untouched — stars, notes, a tailored resume or a hand-toggled Interviewed all count (FIXB B12) — and a kept Applied card keeps its `applied_at`. `DELETE /applications/{id}` unlinks that card's mail events, because SQLite can reuse the id. A card's timeline and Recent updates keep an UNDONE email, shown as "Undone" with no Undo button: Undo reverts the board change, it does not un-receive the email — filtered out, the invite that moved a card could no longer be seen anywhere (Phase 29 browser pass). "Add to tracker" on a review email with no detected company or title takes the subject as the card title, so it never creates a blank card — and never guesses the company from the sender's display name, which on a recruiter's mail is a person.

**Cron.**
- **`/api/inbox/cron` runs at 05:00 and 14:00 UTC as TWO `vercel.json` entries** — a Vercel Hobby cron entry fires at most once a day — beside the unchanged alerts (06:00) and nudges (07:00). That Vercel accepts two entries on one path is not yet confirmed on a deploy.
- **It FAILS CLOSED** (A12): gate on and `CRON_SECRET` empty is 503 `cron_unconfigured`, because an open copy would refresh every user's Gmail grant and spend model calls for anyone who found the URL. It is in `_AUTH_OPTIONAL` and checks its own Bearer secret, runs on a wall-clock budget checked before each user (`INBOX_CRON_BUDGET_S` = 240; each user gets `min(2 × INBOX_SYNC_BUDGET_S, what is left)`), and prunes the security log.

### The codes the inbox sends, and the sentences that say them (P29-INBOX-CODES, 2026-09-21)

**The backend talks to the page in three families of codes, and each has a hand-written `switch` that turns a code into a sentence.**
- **Sync codes**, `InboxSyncResult.error_code` and `InboxStatus.last_error_code`, come from `inbox_sync.py` (plus the connect routes, which reset `last_error`) and are read by `useSyncErrorText` in `components/inbox/shared.tsx`.
- **Route refusals**, `HTTPException(detail={"code": …})` in `inbox_routes.py`, are read by `useInboxRefusalText`, in the same file.
- **Callback reasons**, the `/settings?inbox=<reason>` the Gmail callback redirects with, are read by `callbackMessage` in `InboxSettingsCard.tsx`.

**The drift that shipped.** Nothing compared the two sides, and they drifted where a user could read it. FIXB B15 (1836d30) made `sync_user` return `invite_only` for a connected account taken off the allowlist, three hours after the switch was written (5d7b63e), and touched no frontend file. The code fell to `default`, so someone who can never sync again was told "The last sync ran into a problem. It tries again on the next sync". The tracker's Reconnect showed the same 403 as "Couldn't start reconnecting", because it called `apiErrorMessage` directly instead of the refusal hook.

**check-mirrors 37 now reads the codes from the backend and holds the switches to them.**
- **Every code in the backend's closed set has a `case` of its own, even one that returns the generic sentence.** Such an arm makes "the generic sentence is right for this code" a decision a reviewer can see, rather than a default nobody chose. The generic groups say why they are generic: retried by the next run, or never seen by a signed-in page.
- **A `case` stacked on `default:` is not an arm of its own.** Each `default` is pinned to its generic sentence, never the code.
- **Arms are literal `t("…")` calls**, so check 29 resolves every key in both locales.
- **Google's OPEN set stays on `default` by design.** These are its own `error` strings and `http_<status>`, built by `google_oauth._error_code(…)` (the one open-set shape check 37 allows as a `GoogleAuthError` code), which reach `last_error` only through `_fail(…, e.code)` in `_open_mailbox`. A Google string mapped on purpose goes in `GOOGLE_PASSTHROUGH` in check-mirrors.js. `invalid_grant` and `admin_policy_enforced` are NOT in that open set, because `_REAUTH_CODES` names them.
- **The other direction is checked too (37(e)).** Every case literal must be a code the backend sends. So must every code a component compares with `apiErrorCode(…)`, an `error_code` / `last_error_code` or a status `reason`, and every member of `ANSWERS`. A backend rename otherwise leaves the comparison false for ever: the review sheet's `left` would put an email that was already filed back in the queue.
- **Every `InboxStatus.reason` is compared in BOTH `InboxBar` and `InboxSettingsCard`.** A new reason would otherwise hide the bar and the card with no sentence.
- **Nothing under `components/inbox/` calls `apiErrorMessage` except `useInboxRefusalText`.** The hook falls back to it for everything it does not translate, so routing a toast through the hook costs nothing for a gate or network error.

**Adding a code.** Write it as a literal, pass it to an existing emitter (`_fail`, `_note_error`), or return it as a literal from an `inbox_apply` refusal function. Then give it an arm on the page, and the build tells you which one.

The reader is text, not an AST, so its grammar is closed over the sites it knows. At one of those sites, a value it cannot read THROWS in check 37, naming the file's own line. These all throw:
- a computed sync code;
- a `GoogleAuthError` code that is neither a literal nor `_error_code(…)` (a ternary of literals is read, both branches);
- a refusal function that returns a helper's value;
- an f-string with two placeholders;
- an `HTTPException` detail that is a variable or a `dict(…)`;
- a `leave()` path built from anything but literals and one `quote(…)`;
- a callback reason held in a variable, or `reason` forwarded from outside an emitter.

Two nets catch a new way of sending a family, and they throw too: any `"code":` key in `inbox_routes.py` that is not an `HTTPException` detail, and any `?inbox=` there that no `leave()` carried. Teach the reader the new shape (its header lists every shape it reads), or write the code in a known one. Never leave it unread.

**What check 37 knowingly does not read.** It reads `inbox_sync.py`, `inbox_routes.py`, `inbox_apply.py` and the `google_oauth` functions `_open_mailbox` calls. It cannot see:
- a sync code written from any other module, or through a name the text cannot see (`setattr`, `InboxSyncResult(**…)`, `model_copy(update={"error_code": …})`);
- a `GoogleAuthError` raised outside `google_oauth` (`gmail_api` raises its own, which no emitter hands on today), or in a `google_oauth` function reached other than by its plain name;
- an inbox refusal raised outside `inbox_routes.py` (a dependency, the gate);
- a callback redirect whose `inbox=` is not written literally (`urlencode`).

Any of these needs the reader extended first.

**The first draft claimed more than it read.** Its header said every unknown shape throws. The review found four that were silently unread:
- a ternary as a `GoogleAuthError` code (its `else` branch had no arm);
- a variable as a `GoogleAuthError` code, which was read as no code at all;
- a positional `HTTPException(400, {"code": …})`;
- a reason `leave()` sent directly.

A black-formatted `error_code="…",` continuation line also went red as a false positive. Each one is now read or refused, with a probe twin beside it. The nets exist so that the next new shape fails loudly rather than quietly.

**A connected account off the invite list is shown as paused, on both surfaces.** B15's early return writes no `last_error` and no `last_sync_at`, so to a page that reads only the connection it looked healthy:
- a mint "Connected" badge in Settings;
- a Sync button on the bar that the server can only refuse;
- a background sync fired on every tracker visit, because "stale" never stopped being true.

`InboxStatus.reason` already said `invite_only`, and `shared.tsx`'s `isOffInviteList` applies the backend's own rule to it: connected, not the demo mailbox, reason `invite_only`. With it:
- the bar shows the invite-only line, offers neither Sync nor Reconnect, and skips the background sync;
- the Settings card shows a "Paused" badge and the invite-only line, with no Reconnect row. Disconnect stays, which is why the card renders for such an account at all.

check-mirrors 37(e) pins the rule and all three callers. This was verified at 390 px in en and he, with Playwright against mocked `/api` responses, beside the healthy-connection twin, which still shows Sync and still background-syncs. **Known limit**: on a server that offers the demo mailbox, `ready` is true and `reason` is `""` for such an account, so there only the Sync toast says it. `fake_enabled` is false whenever the gate is on with the real model, so that is a local-dev state.
