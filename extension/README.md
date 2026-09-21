# JobFinder Job Clipper (Chrome extension)

Clips the job posting on the current page into your JobFinder **application tracker** with one click, hands off to the web app, and — since v0.2 — **autofills application forms from your approved application kits** (PLAN 8.3 assisted apply). Built for LinkedIn and the Israeli boards (Drushim, JobMaster, AllJobs, Comeet careers pages), with a generic fallback for everything else. Hebrew UI included (the extension follows Chrome's UI language); all fields are `dir="auto"`, so RTL postings display correctly.

## What it does

**Clip (v1):**

1. Open a job posting, click the extension icon.
2. The popup extracts **job title / company / description / URL** from the page (site-specific selectors, generic fallback) and shows them in editable fields.
3. **Save to tracker** POSTs the job to your JobFinder backend (`POST /applications`, status `saved`, authenticated with the `X-App-Key` header).
4. On success you get an **Open tracker** link straight into `{App URL}/tracker`.
5. **Save & tailor** does the same save, then opens `{App URL}/app?tailor_app=<id>` — the Tailor page loads the clipped JD (title, company, link, description) ready to run.

**Assisted apply (v0.2, PLAN 8.3):**

1. When you have **approved application kits** (Jobs → Kits → Review → Approve), the popup shows an *Assisted apply* section: a kit picker (pre-selected when a kit's URL matches the current page) and a resume format choice (PDF/DOCX).
2. **Autofill this page** fetches the approved kit's final artifacts — the reviewer's effective resume and cover letter (`GET /applications/{id}`) — renders the resume file (`POST /render`), and fills the apply form on the page:
   - **Contact fields** by label/attribute heuristics, English + Hebrew (first/last/full name incl. שם פרטי/שם משפחה, email, phone, LinkedIn, website, city). React-controlled inputs (LinkedIn, Greenhouse) are set via the native value setter + `input`/`change` events.
   - **Resume file** attached to the file input labeled resume/CV/קורות חיים (or the only non-cover-letter file input) via `DataTransfer`.
   - **Cover letter** pasted into a textarea explicitly labeled as one.
3. **It never clicks submit.** You review the form and send it yourself — ToS-safe everywhere, including LinkedIn.

**Since Phase 30 the AI answers cost monthly uses.** One use covers up to 6 screening answers for about 3 hours, so a normal autofill spends 1. Clipping a job to the tracker, and attaching a resume rendered from an already-approved kit, cost no uses.

**Since v0.4 the autofill says why a question was left blank.** When the API refuses an answer, the summary line turns amber (`warn`) and names the reason in the web app's own words, in English or Hebrew:
- no uses left this month (`429 monthly_limit`): "Questions left blank: you've used all your uses for September. More on October 1.";
- today's AI requests used up (`429 daily_limit`): "…you've used all 150 AI requests for today. Try again tomorrow.";
- a wrong or replaced extension key (`401`), a server it cannot reach, or any other error, with its status code.

A refusal that would repeat (the month or the day is used up, the key is dead, or the request itself is refused) **stops the autofill after that one request** instead of asking for every question, because each refused request still counts against the server's daily AI limit. A 400 or a 5xx skips only that question. The autofill asks at most 4 times per click, refused requests included. Answers it already drafted are still written in, and the refusal text itself is never put into the employer's form; it appears only in the popup. It never decides from a count before asking: an open screening pass (shared with the web app's Screening tool) still answers at 0 uses left.

**Installed copies do not update themselves.** The extension is loaded unpacked, so **an install older than 0.4.0 stays silent**: at `monthly_limit` it fills no answers, says nothing, and keeps asking for every question. To update, replace the `extension/` folder with the new one and press **Reload** on its card in `chrome://extensions`; the card's version then reads 0.4.0. (0.3 shipped the screening answers without changing the version, so 0.2.0 on the card means 0.3 or older.)

Safety rails built into the filler: it only touches fields inside an open dialog or a form that has a file upload (so page search boxes are never filled), skips invisible fields (honeypots), never overwrites anything you already typed, and fills each field kind at most once. If the popup finds a **processed-but-unreviewed** kit for the current job, it links you to its review page instead.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this `extension/` folder.
4. Pin the extension for one-click clipping.

There is no build step — plain HTML/CSS/JS, no dependencies, no icons in v1. To update an installed copy, replace the folder and press **Reload** on the extension's card: nothing updates it for you.

## Configure (required for the public deployment)

Right-click the extension icon → **Options** (or the gear in the popup):

- **App URL** — default `https://jobfinder-hazel-pi.vercel.app`. For local dev: `http://localhost:5173`.
- **API URL** — leave empty to use App URL + `/api`. For local dev set `http://localhost:8000`.
- **Access code** — your personal extension key. **Without it every save returns 401** on the public instance. Locally (no access code configured on the backend) it can stay empty.
  - For an **email account**, copy it from the web app: Settings → the extension key (show / copy / replace). It is replaced whenever you reset your password, change it, or use "sign out of other devices", so paste the new one in after any of those.
  - For an **invite-code account** it is that invite code, and for the admin it is the deployment's `APP_ACCESS_CODE`, which never rotates.
- **Test connection** pings `GET {API URL}/health` to confirm the server is reachable (it does not validate the access code — a wrong code shows up as a 401 on the first save).

Settings are stored in `chrome.storage.sync`, so they roam with your Chrome profile.

## Custom domain note

The extension calls the API directly from the popup, which bypasses CORS **only for hosts listed in `host_permissions`** in `manifest.json`. Out of the box that is the Vercel deployment plus `localhost:8000` / `127.0.0.1:8000`. If you point it at any other domain, add that origin (e.g. `"https://jobs.example.com/*"`) to `host_permissions` in `manifest.json` and reload the extension — otherwise saves will fail as network errors.

## Supported sites (extraction quality)

| Site | Title | Company | Description |
| --- | --- | --- | --- |
| linkedin.com (logged-in + guest pages) | selectors → tab-title parse | selectors → tab-title parse | selectors → "About the job" heading walk |
| drushim.co.il | `h1` | `p.view-on-submit` | `.jobDes` + `.job-requirements` |
| jobmaster.co.il | `h1` / `.jobTitle` | fallback | description + requirements concatenated |
| alljobs.co.il | `h1` | fallback | dedicated selectors |
| comeet careers pages | `h1` | fallback | best effort |
| everything else | JSON-LD → `document.title` | JSON-LD → empty | JSON-LD → full page text (trimmed to 15k chars) |

Any board that embeds a JSON-LD `JobPosting` (`<script type="application/ld+json">`) is parsed from that first wherever the selectors miss — it survives markup redesigns.

Everything is editable in the popup before saving, so a weak extraction is a paste away from correct.

**LinkedIn's 2026 shell** (rolling out mid-2026) hashes all class names, so the old selectors miss; there the extractor parses the tab title for job title + company and finds the description structurally via the "About the job" heading. That section renders lazily — **scroll the description into view before clipping** for the full text; the popup retries extraction for ~4.5s (`partial` flag) before settling for the visible summary.

Live-verified 2026-07-05 against a real logged-in LinkedIn posting (new shell: title/company/full 3.3k-char description) and a real Drushim posting (Hebrew title, company, clean description + requirements), plus a real `POST /applications` round-trip against the production API.

## Assisted-apply notes

- **Cross-origin iframes**: some company sites embed their ATS form in an iframe from another domain (e.g. `boards.greenhouse.io`). `activeTab` only grants the top-level origin, so those frames can't be filled — open the form's own page (the iframe's URL / the board-hosted apply link) and autofill there. The popup attempts `allFrames` injection first and falls back to the top frame.
- **Custom upload widgets**: boards that build their uploader without a real `<input type="file">` (drag-drop canvases, JS pickers) won't take the file — the summary line tells you what was and wasn't filled, attach manually there.
- **LinkedIn Easy Apply** email is a dropdown of your verified addresses; it is selected only when one of them matches the kit resume's email, otherwise it's left as-is.

## Known compromises (v1)

- **Selector fragility**: job boards change markup without notice. The extractor never throws (it falls back to JSON-LD, then page title + full page text), but per-board selectors will need occasional maintenance.
- **Company name on some Israeli boards** falls back to empty — board markup rarely labels it consistently; edit it in the popup.
- **Test connection checks reachability only**, not the access code (`/health` is unauthenticated by design).
- **Comeet `COMPANY_DATA`** (the JS global on Comeet careers sites) is not readable from the isolated content-script world; extraction there is DOM-selector best effort.
- **Duplicate detection is a warning, not a block**: when the tab's URL matches an existing tracker application the popup shows "already in your tracker" with a tracker link, but saving again is still allowed (some people track one posting per stage).

## Follow-ups (post-v1)

- ~~Deep **Tailor handoff**: "Save & tailor" that opens `/app` with the clipped JD pre-filled.~~ — done 2026-07-06 (v0.2).
- ~~JSON-LD `JobPosting` parsing~~ — done 2026-07-05 (generic path + gap-filler on all boards).
- ~~Optional **autofill** of application forms~~ — done 2026-07-06 (v0.2 assisted apply, PLAN 8.3).
- ~~**Screening-question autofill**~~ — done 2026-07-21 (v0.3, PLAN 11.5): after the contact fill, free-text application questions (label with "?"/why/describe/מדוע/ספרו… — cover letter excluded) are collected per frame, answered honestly via `POST /tools/screening-answer` grounded in the kit's resume + JD (capped at 4 per page), and written back React-safely. Answers land in the form for the user to REVIEW — the extension still never clicks submit.
- ~~**Say why an answer was refused**~~ — done 2026-09-21 (v0.4): see "Since v0.4" above. `frontend/scripts/check-mirrors.js` check 35 loads this folder's `popup.js` into a node vm and drives the autofill against stubbed responses in both languages, and checks both `messages.json` files against each other and against every key the code uses. A change here fails the web app's build until that check agrees.
- **Firefox port** (MV3 with `browser.*` polyfill; storage.sync + scripting APIs are compatible).
- Per-board **apply-form selector refresh cadence**. ~~Duplicate-clip detection~~ — done 2026-07-06 (URL-matched warning + tracker link).
