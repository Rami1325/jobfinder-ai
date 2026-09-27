# Alerts on the phone — web push and WhatsApp

> **Handbook file.** Added on 2026-09-27 (PLAN 32). `CLAUDE.md` keeps the index and the house rules, this file keeps
> the full record for one department. Every bullet records a decision, a measurement or a defect: edit it the way you
> would edit code, and add new findings here, not in `CLAUDE.md`.
>
> **Read before touching** `core/webpush.py`, `core/whatsapp.py`, `api/notify_routes.py`, the push and WhatsApp
> parts of `core/alerts.py` (`build_alert_push`, `_push_morning`), `frontend/public/sw.js`, `lib/push.ts`,
> `pages/jobs/AlertChannels.tsx`, the `push_subscriptions` / `whatsapp_contacts` tables or `users.whatsapp_enabled`.
> The owner's steps for both channels are at the end of each section. What the morning alert
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

**Pinned (web push) by** smoke 34 (+20: 34a the RFC vector, VAPID, the allowlist, the door, the network AST pin; 34b the words,
the deep link, the email's 75; 34c push off, turning on, the subscribe door, the test, another account's device, the
morning in two languages, the bar and the charge, pruning, the test's cap, one browser one owner, both privacy doors,
and the sweep reaching only its recorder), smoke 32.13 (the four routes classed and driven), and check-mirrors 91.
Twelve planted defects each turned smoke red (a suffix without its label rule, an exact host read as a prefix, no
second check in `_post`, a push with no keys, the wipe skipping the table, a 410 kept, a push below the bar, `round()`
in the words, no key validation, any account's device, a wrong RFC info string, a push that keeps the use).

## WhatsApp (PLAN 32, part 2, 2026-09-28)

**Built, OFF by default, and off for everyone the admin did not choose.** The same morning list (the email's `worth`,
its count and its best job) as the owner's approved WhatsApp template, through Meta's WhatsApp Cloud API. Three
switches must all be on before one message is sent, because Meta bills every delivered template message to the OWNER:

1. **The server**: `whatsapp.configured()` needs `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TEMPLATE_NAME`
   (the digest) and `WHATSAPP_CODE_TEMPLATE_NAME` (the verification code's AUTHENTICATION template), and an API version
   and phone number id of the plain shape the URL may carry. Any one missing is off: `GET /whatsapp` answers
   `available: false` and the Settings row is not drawn.
2. **The account**: `whatsapp.allowed()`, the admin always, anyone else only after `PATCH /admin/users/{id}`
   `{"whatsapp_enabled": true}` (`users.whatsapp_enabled`, a shim column backfilled false). `WHATSAPP_ACCESS=all`
   opens it to everyone, the Gmail allowlist's shape. Taking the grant away stops the mornings at once.
3. **The person**: a number typed with the explicit opt-in ticked (the sentence names JobFinder, WhatsApp and the way
   out, Meta's opt-in rule), then the six-digit code WhatsApp delivered typed back. A number nobody proved is never sent
   a digest: a typo would bill the owner to message a stranger, and Meta lowers the number's quality rating for it.

**Why verification needs a SECOND template.** Meta allows a one-time code only in an AUTHENTICATION template
("Only authentication templates can be used to send a one-time passcode… Marketing and utility templates cannot",
template categorization guidelines), whose text is Meta's own ("<code> is your verification code.") with a
copy-code button. So `WHATSAPP_CODE_TEMPLATE_NAME` is the fourth required variable; the code is sent as the body
parameter AND the button parameter. It is six digits, stored only as an HMAC (`sessions.hkey`), valid ten minutes,
five wrong tries per code; a code that failed to send leaves nothing pending.

**The WhatsApp door** (`whatsapp._http`): https only, the host must be `graph.facebook.com` (a constant, never a
caller's URL), no userinfo, no port but 443, a redirect is an error, 15 s, JSON; the URL is
`https://graph.facebook.com/<WHATSAPP_API_VERSION>/<WHATSAPP_PHONE_NUMBER_ID>/messages`, each part validated by
pattern (`v26.0`, digits), and the recipient is a body field. It is the Google door's shape (a fixed host proves it
IS Meta), and like it must never be routed through `job_match._http_get`. Pinned by smoke 35a: a lookalike host,
http, cloud metadata, userinfo and another port refused before the transport, the network opened only inside
`_http` (the push door's AST reader), and `_http` called only by `_send`.

**What a send answer does** (`whatsapp.SendResult`, Meta's error codes read from `error.code`): 131026 (not on
WhatsApp) and 131050 (the person stopped marketing messages from this business) turn the number back to unproven and
not opted in, so nothing is sent to it again until the person sets it up anew; 131049 / 131056 / 130429 are rate
limits; 132000-132016 a template problem; 131042 no working payment method; 190 an expired token; anything else is
`failed`, and no answer `network`. The page says each one in a sentence, never the code. The log line carries the HTTP
status and Meta's numeric code only: Meta's message text can quote the number.

**The words** (`alerts.whatsapp_best_line`, the notification's choice of job): the digest template's two NAMED
variables are `{{job_count}}` and `{{top_job}}`, "Backend Engineer at Acme (86% match)" in English and "Backend
Engineer · Acme · התאמה 86%" in Hebrew, the language version by the person's app language when they set it up, among
`WHATSAPP_TEMPLATE_LANGS` (default `en,he`). "Send a test message" sends the digest template once with
`job_count` 1 and a job marked "(test)" / "(ניסיון)".

**Charging, decided with the owner's rule** ("a morning charges only when it mails something"; `cost-and-quota.md`):
a WhatsApp message IS a message sent, so a morning keeps its one `job_alert` use when it emailed OR WhatsApped jobs,
and a morning that sent nothing gives it back, as before. The owner's own money is bounded by the admin's grant (he
chooses who gets it), by one digest per person per morning (the cron runs once a day), and by the `whatsapp` daily cap
on codes and tests (`DAILY_WHATSAPP_CAP`, 5, admins exempt). No WhatsApp route charges a monthly use; the code and the
test are `net_capped:whatsapp` in smoke 32.13, the status, the code check and the removal `free`.

**Privacy.** The number is personal data: `whatsapp_contacts` is deleted by both privacy doors (reported as
`whatsapp`), by "Stop and remove", and the privacy page says the number goes to WhatsApp (Meta) with each alert
(`privacy.store.whatsapp`, both locales). A number stays stored when the admin takes the grant away (it is then
unused, and the privacy doors still delete it); the Settings row is hidden then, so it cannot be removed from there.

**The page** (`WhatsAppRow`, read in the alerts card's one `Promise.all`, drawn only when `available`): the number
(`type=tel`, `dir=ltr`, the Israeli local form accepted: `050-123-4567`, `+972 50…`, a kept trunk 0, `00972…` and
Hebrew-keyboard bidi marks all read as `+972501234567`) with the opt-in checkbox, Send code disabled until it is
ticked; then "We sent a code to +972… on WhatsApp", the code (numeric, `one-time-code`), Confirm, Send a new code,
Change number; then "Alerts also go to +972… on WhatsApp", Send a test message, Stop and remove. The number is
isolated (FSI…PDI) inside the Hebrew sentence. Measured with Playwright (Chrome) against the real backend with Meta
replaced by a recorder, at 390 × 664 and 360 × 664 in English and Hebrew and at 1440 × 900: no horizontal overflow,
every control and the opt-in's whole sentence at least 44 px tall, nothing clipped; the row is 226-257 px while the
number is typed (the opt-in wraps to three lines in Hebrew at 360), 223 px with the code, 135-207 px once on (the two
buttons wrap at 360 in Hebrew). The code went to `972501234567` in the authentication template, a wrong code said
"4 tries left", the right one verified, and the test went in the digest template with its two named values.

**Pinned by** smoke 35 (+15: the numbers both ways, off by default and each variable, the door and its AST pin, the
digest's words and named variables; off unless configured AND granted, the grant and the opt-in and the number
refusals, the code in the authentication template in Hebrew stored as an HMAC, a wrong / right / spent code, the test
in the digest template, a WhatsApp-only morning keeping its use, nothing below the bar or after the grant is taken
away, 131050 stopping the number, 131026 leaving no code pending, the daily cap, removal and both privacy doors, and
the sweep reaching only its fake Meta), smoke 32.13 (five routes classed and driven), and check-mirrors 92. Twelve
planted defects each turned smoke red (the code template not required, no grant check, a WhatsApp morning refunded,
no proven-number check, an opt-out kept, the wipe skipping the table, no host check, the trunk 0, no attempt count,
no opt-in check, a message below the bar, a failed code left pending).

### What Meta requires (researched 2026-09-27, Meta's own pages)

Read in a browser on 2026-09-27; every fact below is from the page named. Meta rewrites these pages often, so re-read
before relying on a number.

- **Setup** (Get Started, updated 2026-06-16: developers.facebook.com/documentation/business-messaging/whatsapp/get-started):
  a Meta developer account; an app with the "Connect with customers through WhatsApp" use case; a business portfolio
  (Business Manager), existing or new; a Messaging account (what used to be the WABA; its id is the old WABA id,
  whatsapp-business-accounts/); a phone number; a payment method. A **System User** token for a direct developer,
  with `business_management`, `whatsapp_business_management` and `whatsapp_business_messaging`, and an expiry you
  choose (access-tokens, updated 2026-09-19); a user token "expires quickly".
- **The phone number** (business-phone-numbers/phone-numbers): "cannot be used with WhatsApp Messenger"; "Numbers
  already in use with WhatsApp cannot be registered unless they are deleted first"; it must be yours, with a country
  and area code, able to receive an SMS or a voice call; a two-step PIN is required. Keeping one number on both the
  WhatsApp Business app and the API needs Embedded Signup, open to Solution Partners and Tech Providers only, so in
  practice: a new number (a cheap second SIM or eSIM), never the owner's personal WhatsApp number.
- **Display name**: no review is needed to start sending; review starts once the business is eligible for higher
  limits (facebook.com/business/help/338047025165344). It must relate to the business name, and a personal name must
  show the nature of the business; no generic words, "Official", Meta/WhatsApp, or a URL
  (facebook.com/business/help/757569725593362). "JobFinder", shown on the app's own site, fits.
- **Business verification is NOT required**: without it the limit is 250 unique users outside the 24-hour window per
  moving 24 hours, and 250 templates (messaging-limits; templates/overview). Verification wants documents of a legal
  business (incorporation, registration, tax document, business bank statement; a utility bill is not accepted,
  facebook.com/business/help/159334372093366), so an individual with no registered business probably cannot verify;
  for 5 to 100 users it does not matter.
- **Pricing** (pricing, updated 2026-09-10): per delivered message since 2025-07-01. Marketing is always charged;
  utility and authentication are charged outside the 24-hour customer service window. Israel is a market of its own.
  **Israel, USD per delivered message, rate card effective 2026-07-01 (unchanged on the 2026-10-01 card): marketing
  $0.0353, utility $0.0053, authentication $0.0053**; from 2026-10-01 service messages are charged at $0.0053 too,
  with 1,000 free service messages a month per number (pricing/non-template-messages, updated 2026-08-25), and a
  payment method must be on file by 2026-09-30 or Meta stops delivering service messages. The old 1,000 free
  conversations are gone. Rate cards come in USD and other currencies, not ILS. Utility tiers start past 100,000
  messages a month.
- **The 24-hour window** (messages/send-messages): a message or call from the person opens 24 hours in which any
  free-form message may be sent; outside it only approved templates. A morning digest is outside it by nature.
- **The category decides the price, and the digest is MARKETING** (template-categorization, updated 2026-09-15).
  Utility must be non-promotional AND specific to or requested by the user; but "Retargeting: Promote or recommend
  offers, products, or services… These are marketing even if requested by users", with Meta's own example "We found a
  {{car}} that meets your saved search". A job-match digest is that pattern. A template submitted as utility that Meta
  judges marketing is approved as marketing; repeated mislabelling leads to caps and a portfolio restriction.
  **Budget at $0.0353.** Marketing limits: a per-user limit that follows each person's engagement (a blocked send is
  131049, retry after 24 h), and marketing templates are not delivered to US numbers
  (templates/marketing-templates/per-user-limits).
- **Opt-in** (getting-opt-in, updated 2026-06-16): it must say the person is opting in to receive messages and name
  the business, and comply with the law; opt-out requests (on or off WhatsApp) must be honoured
  (whatsappbusiness.com/policy). The Settings sentence does both, and a person who stops the messages inside
  WhatsApp (131050) is taken off.
- **Templates' variables** (templates/overview; supported-languages): named parameters (`{{job_count}}`), lowercase
  and underscores, sent in any order with `parameter_name`; language codes `en` and `he` must match an approved
  version exactly (else 132001). A body may not start or end with a variable. The latest Graph API version is v26.0
  (2026-07-29, graph-api/changelog/versions); the default here is `v26.0`, and `WHATSAPP_API_VERSION` changes it.

**Expected cost, one digest per person per morning, 30 days, Israel** (marketing, $0.0353; utility shown for
comparison, which Meta will likely refuse for this template): 5 people: 150 messages, **$5.30** a month (utility
$0.80); 20 people: 600, **$21.18** ($3.18); 100 people: 3,000, **$105.90** ($15.90). Plus one authentication message
($0.0053) per code and one digest per test message. A morning with nothing above the bar sends nothing and costs
nothing. The 250-unique-users-a-day limit without business verification is far above this.

### The owner's steps for WhatsApp

1. **A phone number** that has never been on WhatsApp (or delete its WhatsApp account first): a second SIM or an
   eSIM that can receive an SMS or a call. Not your personal WhatsApp number.
2. **developers.facebook.com** → My Apps → Create app → use case **"Connect with customers through WhatsApp"** →
   pick or create a **business portfolio** (your name is fine) → in **WhatsApp → API Setup**, connect a Messaging
   account, **Add phone number** (display name **JobFinder**, category e.g. "Professional services"), verify it by
   SMS, and set its two-step PIN.
3. **Payment method**: Business Settings → Billing / WhatsApp accounts → add a card, **before 2026-09-30**.
   Nothing is charged until messages are delivered. (Check the "Payment Issue" banner Meta showed on your account on
   2026-09-27 first.)
4. **Two templates** (WhatsApp Manager → Message templates → Create), each with an English (`en`) AND a Hebrew
   (`he`) version under the same name:
   - `job_digest`, category **Marketing** (Meta will classify a saved-search digest as marketing anyway), parameter
     type **Named**:
     - en body: `JobFinder: new jobs that match your search this morning: {{job_count}}. Best match: {{top_job}}. Open JobFinder to see them all.`
     - he body: `JobFinder: משרות חדשות שמתאימות לחיפוש שלך הבוקר: {{job_count}}. ההתאמה הכי טובה: {{top_job}}. פתחו את JobFinder כדי לראות את כולן.`
     - (the count stands alone after a colon, so one job and ten read the same way in both languages)
     - examples for review: `job_count` = `3`; `top_job` = `Backend Engineer at Acme (86% match)` /
       `Backend Engineer · Acme · התאמה 86%`.
     - footer (en / he): `Turn this off in JobFinder Settings.` / `אפשר לכבות את זה בהגדרות של JobFinder.`
     - optional button, Visit website, static URL: `https://jobfinder-hazel-pi.vercel.app/jobs`, text
       `Open JobFinder` / `פתיחת JobFinder`.
   - `jobfinder_code`, category **Authentication**: Meta writes the text ("<code> is your verification code."),
     choose **Copy code**, tick the security line, expiry 10 minutes.
   Wait for both to show **Approved**, in both languages.
5. **A permanent token**: Business Settings → Users → **System users** → Add (Admin) → Assign assets: the app and
   the WhatsApp account (full control) → **Generate token** for the app with `business_management`,
   `whatsapp_business_management` and `whatsapp_business_messaging`, expiry "Never" (or long, and note the date).
6. **Vercel** → project **jobfinder** → Settings → Environment Variables → Production, each **Sensitive**:
   `WHATSAPP_TOKEN` = the system user token; `WHATSAPP_PHONE_NUMBER_ID` = the **Phone number ID** shown in API Setup
   (digits, not the phone number); `WHATSAPP_TEMPLATE_NAME` = `job_digest`; `WHATSAPP_CODE_TEMPLATE_NAME` =
   `jobfinder_code`. Optional: `WHATSAPP_TEMPLATE_LANGS` (default `en,he`; set `en` if only English was approved),
   `WHATSAPP_API_VERSION` (default `v26.0`), `DAILY_WHATSAPP_CAP` (default 5). Redeploy.
7. **Grant yourself first** (the admin always may): Settings → Email alerts → "Also send on WhatsApp" → your number,
   tick, Send code, type it, Send a test message. Then grant each person you want to pay for:
   `PATCH https://jobfinder-hazel-pi.vercel.app/api/admin/users/<id>` with header `X-App-Key: <your access code>` and
   body `{"whatsapp_enabled": true}` (their id is in `GET /api/admin/users`); `{"whatsapp_enabled": false}` stops them.
8. **Watch the bill** in WhatsApp Manager → Insights for the first weeks; at 20 people expect about $21 a month.
