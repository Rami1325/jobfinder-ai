# Alerts on the phone — web push and WhatsApp

> **Handbook file.** Added on 2026-09-27 (PLAN 32). `CLAUDE.md` keeps the index and the house rules, this file keeps
> the full record for one department. Every bullet records a decision, a measurement or a defect: edit it the way you
> would edit code, and add new findings here, not in `CLAUDE.md`.
>
> **Read before touching** `core/webpush.py`, `core/whatsapp.py`, `api/notify_routes.py`, the push and WhatsApp
> parts of `core/alerts.py` (`build_alert_push`, `_push_morning`), `frontend/public/sw.js`, `lib/push.ts`,
> `pages/jobs/AlertChannels.tsx`, or the `push_subscriptions` / `whatsapp_contacts` tables. What the morning alert
> itself decides (the fit bar, "new", the email) is in `job-search.md`; what it charges is in `cost-and-quota.md`;
> what the two privacy doors wipe is in `data-and-privacy.md`; the other fixed-host door is *The network door* in
> `inbox.md`.

## Web push (PLAN 32, 2026-09-27)

**What it does.** The daily alert (`alerts.run_alert`, cron `/api/jobs/alerts/cron` at 06:00 UTC) now also shows a
notification on every device the owner turned on in Settings (`#alerts`, "Also send to this device"), in addition to
the email. It is the email's own content decision and nothing more: a morning pushes exactly when its `worth` list
(new jobs at or above the bar) is non-empty, whether or not the email itself went out, and the notification carries
the count and the best of those jobs by `displayed_score`: title, company and match, the three things the email
already prints.

- **The words** (`alerts.build_alert_push`, pure, smoke 34b). One job: "A new job for you" / "משרה חדשה בשבילך",
  body "Backend Engineer · Acme · 75% match" / "… · התאמה 75%". Several: "3 new jobs for you" / "3 משרות חדשות
  בשבילך", body "Best: Data Engineer · Gamma · 90% match" / "הכי מתאימה: …". Measured for the lock screen: titles
  16-20 characters, bodies 35-46 characters with an ordinary title, so Android's collapsed line (about 40) still
  shows the job; the title is clipped at 60 and the company at 40 (with "…"), so the longest body is at most 128
  characters, the job's name always first, and a payload stays far inside one 4096-byte push record. A Hebrew notification carries `dir: "rtl"`
  and `lang: "he"`.
- **Each device in its own language.** `push_subscriptions.lang` is the app's language on that device when it was
  turned on, and AlertsCard re-sends it (an upsert) whenever Settings opens in another language, but ONLY for a
  device the server already holds: after "Delete all my data" this browser's old subscription must not quietly
  come back. So a language switched elsewhere reaches notifications the next time Settings is opened.
- **Where a tap lands.** One job opens the email's own link for it (`_job_link`, `/jobs?open=<posting, quoted
  whole>`) with the app's address taken off (`_push_path`), because the service worker opens it on its own
  origin; several open `/jobs`, the matches. No `APP_BASE_URL` opens `/jobs`, never the posting's own site. Driven in
  Chrome: a push dispatched to the real registered `/sw.js` showed "3 משרות חדשות בשבילך" (rtl, `he`, the app icon),
  and a tap moved the open Settings window to `/jobs?open=…`, which the Jobs page resolved and took out of the
  address as it does for the email (`lib/openJob.ts`).
- **The fit bar's number.** The email printed `round(m.overall)`, Python's half-to-even: 74 for a 74.5 that the bar,
  the app and now the notification call 75. Both email bodies use `displayed_score` now (smoke 34b pins the 74.5).

**Why no `pywebpush`.** Checked on PyPI 2026-09-27: 2.5.0 requires `aiohttp`, `requests`, `py-vapid`, `http-ece` and
`cryptography>=47`, which pulls aiohttp's own tree (multidict, yarl, frozenlist, aiosignal, attrs, propcache,
aiohappyeyeballs) into a serverless bundle, and it sends through `requests`, a second HTTP stack outside the door
below. What it does is about eighty lines on the `cryptography` package this app already pins (`cryptography==49.0.0`
in `requirements.txt`): VAPID (RFC 8292) as an ES256 JWT, `Authorization: vapid t=<jwt>, k=<public key>`, audience =
the endpoint's origin, 12 hours; and RFC 8291 message encryption over RFC 8188 `aes128gcm`, one record. **No new
dependency.** The arithmetic is pinned to RFC 8291 Appendix A byte for byte (smoke 34a), and a round trip is decrypted
by the test with the `cryptography` package's own HKDF, so webpush is never graded with its own helper.

### The push door

A subscription's `endpoint` is a URL the BROWSER hands the server, so it is a caller-supplied URL: accepted blindly,
"turn notifications on" would be a way to make this server POST to any address, cloud metadata included.
`webpush.push_endpoint_allowed` is the one test, and it is run when a device is stored (`POST /push/devices`, 400
`push_endpoint`) AND again inside `webpush._post`, the only function in the app that talks to a push service:

- `https` only; no userinfo; no port but 443; the netloc must be exactly the host (or `host:443`); a path is required;
  no whitespace, control character or backslash; at most 2048 characters.
- The host must be one of `PUSH_HOSTS`: `fcm.googleapis.com` (Chrome, Edge on Android, Samsung Internet, Opera,
  Brave), `updates.push.services.mozilla.com` (Firefox), `web.push.apple.com` (Safari 16+ on macOS, iOS/iPadOS 16.4+
  as a Home Screen app); or end in one of `PUSH_HOST_SUFFIXES` after whole DNS labels: `.notify.windows.com` (Edge on
  Windows, per-region hosts such as `wns2-par02p.notify.windows.com`) and `.push.services.mozilla.com`. A suffix never
  matches itself or a lookalike (`notify.windows.com`, `evil-notify.windows.com`), and an IP literal matches nothing.
- A redirect is an error, never followed (`_NoRedirect`); nothing a push service answers is read beyond its status;
  10-second timeout; a failed connection is status 0.
- **This is NOT `job_match._http_get`, and must not be "fixed" into it**: `net_guard` can prove an address is
  public, while only an allowlist proves it is a PUSH SERVICE. It is the Google door's reasoning (`inbox.md`), with one
  difference that makes the second check load-bearing: here the URL does come from a caller, so a row that ever
  slipped past the subscribe check still cannot be sent to.
- Pinned by smoke 34a: the accepted list (one endpoint per real service, the false-positive half) beside the refused
  one (`fcm.googleapis.com.evil.com`, `evil-notify.windows.com`, the bare suffix, http, `169.254.169.254`, `[::1]`,
  `127.0.0.1:8000`, userinfo, `:8443`, a trailing dot, no path, a backslash, a space, 2100 characters); `_post`
  refusing cloud metadata before its transport is reached; and an AST pin that every `urlopen` / `build_opener` /
  `.open` / `Request` in `webpush.py` is inside `_post`, which only `send_to` calls (the detector probed on a
  synthetic leak). `_transport` is the offline seam.
- **Measured live on 2026-09-27** with the door itself: FCM answers **410** and Mozilla **404** to a well-signed push
  for a token they do not know, both of which delete the row. The browser pass drove the same thing end to end:
  "Send a test notification" for a made-up FCM endpoint came back `gone`, the server deleted the row and the switch
  went off.

**What a push service's answer does to a device** (`webpush.record_result`): 2xx sets `last_success_at` and resets
`failure_count`; 404 or 410 deletes the row at once (the browser dropped the subscription); an endpoint the door
refuses is deleted too; anything else, a connection failure included, counts, and `MAX_FAILURES` (5) in a row drops
it. That last rule is what cleans up after a VAPID key rotation, where every old subscription answers 403 for ever.
**With push switched OFF on the server nothing is attempted and nothing counts**: `notify_user` returns before it
touches a row, because counting "no keys" as a failure would slowly delete every device during a configuration gap
(smoke 34c pins the row untouched; the mutation that dropped the check was caught only once that was added).

**One browser, one owner.** A browser profile holds one subscription, so `endpoint_key` (sha256 of the endpoint) is
unique across users and an endpoint another account turns on MOVES to it with a clean record: the first account's
alerts stop reaching a browser someone else now uses. Signing out drops this browser's subscription locally
(`lib/session.ts`, bounded to 1.5 s, no request: a call there could 401 after a closed account and race the sign-out
to /login), so the next push to it answers 410 and the server deletes the row itself. At most `MAX_DEVICES` (10) per
user; past it the device that last worked longest ago goes.

### The service worker

`frontend/public/sw.js` handles `push` (always shows a notification: `userVisibleOnly`) and `notificationclick`
(an open JobFinder window navigates to the target and comes forward; else a new one opens), and nothing else:
**no `fetch` handler and no cache**, so every request still goes to the network exactly as before it existed and no
deploy can leave a stale asset on anyone's device. `install` calls `skipWaiting` and `activate` claims the clients,
which costs nothing without a fetch handler and lets a tap navigate a tab opened before the worker. A target that
resolves to another origin, or no URL, opens `/jobs`.

- **Registered only on the tap that turns notifications on** (`lib/push.ts` `turnOn`), never on page load. The
  permission prompt is `turnOn`'s FIRST awaited step: a prompt after an await no longer belongs to the tap (Safari
  refuses it, Chrome quiets sites that ask on load). check-mirrors 91 pins both and that nothing else under `src/`
  asks or registers.
- **Vercel serves it with no change to `vercel.json`**: Vite copies `public/sw.js` to `dist/sw.js`, and the frontend
  service's `/(.*)` → `/index.html` rewrite applies only when no file matches (that is how `/manifest.webmanifest`
  is served today). Measured on production 2026-09-27: a static file comes with `Cache-Control: public, max-age=0,
  must-revalidate`, which is what a worker script wants (browsers also bypass the HTTP cache for worker updates older
  than 24 hours). Scope `/`, because the file is at the root; no `Service-Worker-Allowed` header is needed. Before
  this deploy `/sw.js` answered the SPA's `index.html` as `text/html`, which is why the registration must never be
  attempted on a deploy that lacks the file.

### The page

AlertsCard reads `GET /push/devices` and this browser's own subscription (`currentSubscription`, read-only) IN THE
SAME `Promise.all` as the alert, so the card appears whole and nothing under it moves (check-mirrors 91 (c)). The row
(`PushRow` in `pages/jobs/AlertChannels.tsx`) is drawn only when the server says `configured`. It is Settings'
switch shape (`role="switch"` on a button, 44 px), and says in one line why it cannot be used where it cannot:

- **iPhone or iPad outside a Home Screen app** (all iOS browsers are WebKit): "On iPhone, add JobFinder to your Home
  Screen first (Share, then Add to Home Screen) and turn this on from there." Web push reaches only an installed web
  app on iOS/iPadOS 16.4 or later.
- **No Push API**: "This browser can't show notifications from websites."
- **Permission denied** (at rest, or on the tap): the blocked-site sentence; **prompt closed**: tap again;
  **subscribe failed** (a private window, no push service): try again or another browser; **an endpoint the server's
  allowlist refuses**: "This browser's notification service isn't supported."
- On: "Send a test notification" (a toast for `sent`; `gone` turns the switch off and drops the local subscription;
  `failed` / `network` say try later), and "Also on N other devices" with the full plural set.

Measured with Playwright (Chrome) at 390 × 664 and 360 × 664, English and Hebrew: no horizontal overflow
(`scrollWidth == clientWidth`), the switch and the test button each 44 px tall, nothing clipped; the row is 74 px
off, 122 px on, 94 px as the iOS line in English and 74 px in Hebrew; at 1440 × 900 it is one 57 px row. Chrome under
automation refuses a real push subscription ("Registration failed - permission denied" even with the permission
granted), so the pass replaced `PushManager.subscribe` in the page with one returning a real WebCrypto P-256 key and
an FCM endpoint: the POST reached the backend, which validated and stored it; the language refresh moved the row to
`he` when the page was opened in Hebrew; turning it off deleted the row. **A real phone receiving a real push has
not been observed yet**: that is the owner's first step below.

### Cost, privacy and config

- **Pushing never charges a use.** The morning's `job_alert` use is still kept only when the EMAIL went out; a
  morning that pushed but could not email gives its use back like any morning that mailed nothing (smoke 34c).
  "Send a test notification" reaches no model and takes no use; it has its own daily cap, `push_test`
  (`DAILY_PUSH_TEST_CAP`, 10), because each tap is one real POST to a push service, and it is classed
  `net_capped:push_test` in smoke 32.13. The device list, turning on and turning off are `free`.
- **Both privacy doors delete the devices** (`push_subscriptions`, reported as `push_devices` in
  `DeleteMyDataResult`), so a wiped account's phone stops getting alerts, not only forgets them
  (`data-and-privacy.md`). The privacy page says who delivers notifications (`privacy.store.push`, both locales).
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`mailto:` or `https:`). All three unset, or a pair whose
  halves do not belong together, is "push off": `/push/devices` answers `configured: false` and no switch is drawn.
  The keys are base64url, the raw 65-byte public point and the raw 32-byte private scalar (a PEM private key is read
  too). Sentry's scrubber redacts both keys by name (`key`).

**The owner's steps to switch it on (VAPID):**
1. Generate a key pair on your machine (never commit it):
   `cd backend` then `.\.venv\Scripts\python.exe -m app.core.webpush --generate-keys`
   (or `npx web-push generate-vapid-keys`). It prints `VAPID_PUBLIC_KEY=…` and `VAPID_PRIVATE_KEY=…`.
2. Vercel → project **jobfinder** → Settings → Environment Variables → Add, for **Production**:
   `VAPID_PUBLIC_KEY` = the first value; `VAPID_PRIVATE_KEY` = the second, with **Sensitive** switched on;
   `VAPID_SUBJECT` = `mailto:` followed by an address a push service can write to (for example
   `mailto:ramibaryhe@gmail.com`), Sensitive too if you prefer.
3. Redeploy production (the next push to `main` does it).
4. Check: signed in, `https://jobfinder-hazel-pi.vercel.app/api/push/devices` answers `"configured": true`.
5. On the phone: Android, open the site in Chrome; iPhone, first Share → Add to Home Screen and open JobFinder from
   the Home Screen. Then Settings → Email alerts → "Also send to this device" → Allow → "Send a test notification".
6. Do not rotate the pair lightly: new keys orphan every subscription (each answers 403 and is dropped after five
   tries), so every device has to be turned on again.

**Known limits, recorded.** `pushsubscriptionchange` (a browser replacing a subscription by itself, Firefox mostly)
is not handled: the old endpoint answers 410, its row goes, and the switch on that device reads off until it is tapped
again. "Sign out of other devices" does not stop notifications on those devices (only a sign-out ON the device does,
or the next 410). A test counts toward its daily cap even when the push service refuses it. The language follows the
app only when Settings is opened.

**Pinned by** smoke 34 (+20: 34a the RFC vector, VAPID, the allowlist, the door, the network AST pin; 34b the words,
the deep link, the email's 75; 34c push off, turning on, the subscribe door, the test, another account's device, the
morning in two languages, the bar and the charge, pruning, the test's cap, one browser one owner, both privacy doors,
and the sweep reaching only its recorder), smoke 32.13 (the four routes classed and driven), and check-mirrors 91.
Twelve planted defects each turned smoke red (a suffix without its label rule, an exact host read as a prefix, no
second check in `_post`, a push with no keys, the wipe skipping the table, a 410 kept, a push below the bar, `round()`
in the words, no key validation, any account's device, a wrong RFC info string, a push that keeps the use).
