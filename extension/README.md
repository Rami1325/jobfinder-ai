# JobFinder Job Clipper (Chrome extension)

Clips the job posting on the current page into your JobFinder **application tracker** with one click, then hands off to the web app. Built for LinkedIn and the Israeli boards (Drushim, JobMaster, AllJobs, Comeet careers pages), with a generic fallback for everything else. Hebrew UI included (the extension follows Chrome's UI language); all fields are `dir="auto"`, so RTL postings display correctly.

**v1 scope: clip-to-tracker only.** No autofill, no in-page overlay, no tailoring from the popup.

## What it does

1. Open a job posting, click the extension icon.
2. The popup extracts **job title / company / description / URL** from the page (site-specific selectors, generic fallback) and shows them in editable fields.
3. **Save to tracker** POSTs the job to your JobFinder backend (`POST /applications`, status `saved`, authenticated with the `X-App-Key` header).
4. On success you get an **Open tracker** link straight into `{App URL}/tracker`.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this `extension/` folder.
4. Pin the extension for one-click clipping.

There is no build step — plain HTML/CSS/JS, no dependencies, no icons in v1.

## Configure (required for the public deployment)

Right-click the extension icon → **Options** (or the gear in the popup):

- **App URL** — default `https://jobfinder-hazel-pi.vercel.app`. For local dev: `http://localhost:5173`.
- **API URL** — leave empty to use App URL + `/api`. For local dev set `http://localhost:8000`.
- **Access code** — the deployment's `APP_ACCESS_CODE`. **Without it every save returns 401** on the public instance. Locally (no access code configured on the backend) it can stay empty.
- **Test connection** pings `GET {API URL}/health` to confirm the server is reachable (it does not validate the access code — a wrong code shows up as a 401 on the first save).

Settings are stored in `chrome.storage.sync`, so they roam with your Chrome profile.

## Custom domain note

The extension calls the API directly from the popup, which bypasses CORS **only for hosts listed in `host_permissions`** in `manifest.json`. Out of the box that is the Vercel deployment plus `localhost:8000` / `127.0.0.1:8000`. If you point it at any other domain, add that origin (e.g. `"https://jobs.example.com/*"`) to `host_permissions` in `manifest.json` and reload the extension — otherwise saves will fail as network errors.

## Supported sites (extraction quality)

| Site | Title | Company | Description |
| --- | --- | --- | --- |
| linkedin.com (logged-in + guest pages) | dedicated selectors | dedicated selectors | dedicated selectors |
| drushim.co.il | `h1` | fallback | dedicated selectors |
| jobmaster.co.il | `h1` / `.jobTitle` | fallback | description + requirements concatenated |
| alljobs.co.il | `h1` | fallback | dedicated selectors |
| comeet careers pages | `h1` | fallback | best effort |
| everything else | `document.title` | empty | full page text (trimmed to 15k chars) |

Everything is editable in the popup before saving, so a weak extraction is a paste away from correct.

## Known compromises (v1)

- **Selector fragility**: job boards change markup without notice. The extractor never throws (it falls back to page title + full page text), but per-board selectors will need occasional maintenance.
- **Company name on Israeli boards** mostly falls back to empty — board markup rarely labels it consistently; edit it in the popup.
- **Test connection checks reachability only**, not the access code (`/health` is unauthenticated by design).
- **Comeet `COMPANY_DATA`** (the JS global on Comeet careers sites) is not readable from the isolated content-script world; extraction there is DOM-selector best effort.
- **No duplicate detection**: clipping the same job twice creates two tracker rows (the backend dedupes only job-search history, not manual saves).

## Follow-ups (post-v1)

- Deep **Tailor handoff**: "Save & tailor" that opens `/app` with the clipped JD pre-filled.
- Per-board **selector hardening** (JSON-LD `JobPosting` parsing would cover most boards generically).
- **Firefox port** (MV3 with `browser.*` polyfill; storage.sync + scripting APIs are compatible).
- Optional **autofill** of application forms — explicitly out of scope for v1.
