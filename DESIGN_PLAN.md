# Design Plan — "Precision Instrument"

Making JobFinder feel premium and alive, with inspiration from
[reactbits.dev](https://reactbits.dev) (the component vocabulary) and
[fable-25.netlify.app](https://fable-25.netlify.app) (the craft standard).

Researched 2026-07-10 against branch `feature/competitive-overhaul`.

> **Status (2026-07-10): implemented.** Phases A–F shipped in commits
> `cd5cf55` (foundation) through `41e921f` (small surfaces). E5 was skipped —
> the landing has no honest numeric stats to animate. C2 became select-driven
> card glides (the board has no real drag). D1 turned out better than planned:
> the search already streams SSE progress, so the ticker is genuinely live.
> Verified in-browser: dark + light themes, Hebrew RTL, reduced-motion paths,
> full tailor run with the VERIFIED stamp landing, zero console errors.

---

## 1. The thesis

The two sites teach different lessons:

- **ReactBits** is a parts catalog — 150+ animated components (text effects, cursors,
  card treatments, backgrounds). The trap is sprinkling: a site that uses ten of them
  reads as a demo reel, not a product.
- **Fable-25** is 92 sites that each commit to **one concept executed completely**, down
  to the microcopy. Helios Station is a solar-observatory dashboard where every number
  ticks live; Form 27-B/6 is a municipal permit that literally *stamps you APPROVED* in
  triplicate; Terminus is a transit authority with a split-flap departures board; Büro
  Otto is Swiss restraint where one red dot carries the whole identity.

JobFinder already has its concept — it just hasn't been pushed into the motion design yet:
**the fabrication guard**. The product's soul is *verification*. So the design north star:

> **JobFinder is a precision instrument for an honest job hunt.**
> Every animation reports a real state: a score arriving, a claim verified, a status
> flipping, a board being scanned. Gauges sweep. Numbers tick. Stamps land.

This gives us a filter for every ReactBits component: *does it read as the instrument
working, or as decoration?* Decoration gets cut.

## 2. What's already shipped (don't re-add)

| Piece | Where |
|---|---|
| `TiltedCard` (3D tilt + cursor caption) | Home quick actions, Tools grid |
| `SpotlightCard` (cursor glow surface) | base of TiltedCard |
| `BorderGlow` | Jobs search panel |
| `LightPillar` WebGL background (lazy, pausable) | Marketing layout only |
| `CountUp`, `ProgressRing` (animated sweep + synced number) | Home tiles, ScoreCard, Hero mock |
| `hover-lift` on buttons/card icons, fade-up/stagger entrances, Reveal on marketing | global |
| Semantic token system, designed light theme, reduced-motion kill switch | `styles.css` / `tailwind.config.js` |

The foundation is genuinely good. What's missing is (a) micro-feedback on interaction,
(b) a **signature moment** on each core surface, and (c) the Fable-grade world-building
details (live status chips, mechanical transitions, deadpan microcopy).

## 3. The plan

Each item: **what → where → inspiration → effort (S/M/L) → priority (P0 highest)**.

### Phase A — Motion foundation (system-wide, quick wins)

**A1. Motion tokens.** Add named durations/easings to `tailwind.config.js`
(`--ease-out-quint: cubic-bezier(.22,1,.36,1)` is already used ad-hoc everywhere — name
it once) plus a 150/250/450 ms duration scale. All later work uses these.
→ `tailwind.config.js`, `styles.css` · S · **P0**

**A2. ClickSpark on primary actions.** Port ReactBits *Click Spark* (tiny radial
accent-colored sparks on click, canvas-free SVG version) and mount it inside `Button`
variant="primary" only. Feedback, not confetti: 4–6 sparks, 300 ms, accent color.
Skipped under reduced motion.
→ `src/components/ui/ClickSpark.tsx`, wire into `Button.tsx` · S · **P0**

**A3. Animated sidebar active pill.** Replace the static active bar in `NavItem` with a
framer-motion `layoutId` pill that *slides* between nav entries (Linear-style). 200 ms,
ease-out-quint. This single change makes the whole app shell feel alive.
→ `src/layouts/AppLayout.tsx` · S · **P0**

**A4. Route transitions.** 150–200 ms fade+4px-rise on `<Outlet>` content via
`AnimatePresence mode="wait"`. Product register: fast, never choreographed.
→ `src/App.tsx` / `AppLayout.tsx` · S · **P1**

**A5. Numbers are always alive.** Anywhere a metric can change (tracker counts, ATS scan
score, match scores in lists), render through `CountUp` with tabular-nums. Audit pass.
→ `TrackerAnalytics.tsx`, `MatchReport.tsx`, `AtsToolPage.tsx` · S · **P1**

### Phase B — The Guard moment (Tailor flow — the signature)

This is the product's champagne moment and no competitor can copy it honestly.

**B1. The VERIFIED stamp.** Fable's Form 27-B/6 stamps you APPROVED; JobFinder stamps
your kit VERIFIED. When tailoring finishes with `fabrication_flags.length === 0`, an
ink-stamp ("VERIFIED — FACTS LEDGER", circular border, slight rotation) **lands** on the
GuardTile: spring scale from 1.4→1 with a 6° rotation settle and a one-frame squash —
the visual thunk of a rubber stamp. Flags > 0 → red "NEEDS REVIEW" stamp instead.
Works beautifully in both themes (ink on the light paper theme is *chef's kiss*).
Reduced motion: crossfade. Reuse on `KitReviewPage` for approved kits.
→ new `src/components/ui/Stamp.tsx`, used in `ScoreCard.tsx` (GuardTile), `KitReviewPage.tsx` · M · **P0**

**B2. Score-reveal choreography.** One orchestrated beat (the register allows delight at
moments): before-ring sweeps at 50% opacity → connecting arrow draws → after-ring sweeps
with the number overshooting by +2 then settling → delta pill pops → stamp lands last.
Total ≤ 1.8 s, each stage driven by the previous one's completion. Today all four rings
fire simultaneously; sequencing is what makes it feel earned.
→ `ScoreCard.tsx` · M · **P0**

**B3. Rewritten-line decrypt.** In the ChangeLog/diff, the first time a tailored bullet
appears, resolve it ReactBits *Decrypted Text*-style: 350 ms scramble → final text,
staggered 40 ms per line, once per mount. It honestly dramatizes "the machine rewrote
this — and here is exactly what it wrote."
→ `src/components/ChangeLog.tsx` (+ small `DecryptText.tsx`) · M · **P1**

**B4. Guard microcopy (Fable voice).** Deadpan lines where the guard reports:
clean → "Nothing invented. We checked." · flagged → "2 claims we couldn't find in your
resume. They don't ship until you approve them." Copy lives in i18n files, EN + HE.
→ `frontend/src/locales/*` · S · **P1**

### Phase C — Tracker as departures board (Terminus + Helios)

**C1. Split-flap status flip.** When an application's status changes (select or drag),
the status chip does a mechanical half-flip (CSS `rotateX` 3D flip with a hard midpoint,
90 ms per half — the Terminus split-flap read). Column counts tick via CountUp.
→ `TrackerPage.tsx` status chip component · M · **P0**

**C2. Drag physics.** While dragging a kanban card: 2° tilt in the drag direction +
shadow lift; on drop, spring-settle and the receiving column header pulses once in
accent. framer-motion `layout` animations; no new deps.
→ `TrackerPage.tsx` · M · **P1**

**C3. Mission-control analytics strip.** Restyle `TrackerAnalytics` toward Helios:
tabular-nums metrics, tiny inline SVG sparklines (applications/week, responses/week), a
live status chip — `● 3 AWAITING REPLY` / `● ALL QUIET` — and a compact, color-coded
recent-activity log (status changes with relative timestamps). Dense but legible;
no terminal cosplay, keep Inter.
→ `TrackerAnalytics.tsx`, new `ui/Sparkline.tsx` · M–L · **P1**

### Phase D — Jobs search that feels like scanning (radar, honestly)

The multi-board fan-out takes real seconds — the one place ambient motion is *honest*.

**D1. Per-board scan ticker.** While searching, show a board-by-board rows list
(LinkedIn / Drushim / Comeet / JobMaster / Greenhouse): each row `SCANNING…` with a
sweeping shimmer → flips (split-flap again) to `12 FOUND` or a quiet `—` on failure.
This *visualizes an actual architecture feature* (per-board failure isolation). If the
API doesn't stream per-board completion yet, add board names + counts to the search
response; interim: resolve all rows when the response lands, staggered 120 ms.
→ `JobsPage.tsx`, possibly `backend app/core/job_search.py` (per-board counts) · M · **P0**

**D2. Results entrance.** ReactBits *Animated List*: results stagger in 40 ms apart,
score badges CountUp, and the **top match only** gets the existing `BorderGlow`.
→ `JobsPage.tsx` · S · **P1**

**D3. Radar sweep loader.** Inside the search panel while scanning: a small conic-
gradient radar sweep (pure CSS, accent at 8% opacity) behind the ticker. Kill under
reduced motion.
→ `JobsPage.tsx` · S · **P2**

### Phase E — Landing (brand register: allowed to go bigger)

**E1. Hero headline entrance.** ReactBits *Split Text / Blur Text*: words rise + unblur,
80 ms stagger, once. Replace the current whole-block fades.
→ `marketing/Hero.tsx` · S · **P1**

**E2. Kill the gradient text.** `bg-clip-text` gradient on the hero highlight is the #1
AI-landing tell (and a design-guideline ban). Replace with solid `accent` + weight, or a
single *Shiny Text* sheen that sweeps **once** on load, then rests solid.
→ `Hero.tsx` · S · **P0**

**E3. The mock demonstrates the guard.** The hero product-mock is static proof — make it
*perform* the pitch on a loop while in view: before-ring sweeps → after-ring sweeps → the
"blocked" line types in and gets struck through in red as a small "GUARD" tag stamps
next to it → hold 3 s → reset. This is Fable's "show the machine working" applied to our
own product. Pause off-screen (IntersectionObserver) and under reduced motion.
→ `Hero.tsx` · M · **P0**

**E4. Ambient texture, not more WebGL.** LightPillar already owns the background. Add at
most a fine noise grain (CSS, 2% opacity) so panels don't feel airbrushed; skip Aurora/
Particles/Beams — they'd fight the pillar.
→ `MarketingLayout.tsx` · S · **P2**

**E5. Stats strip counts on scroll.** FreeScanStrip / any marketing numbers: CountUp
when scrolled into view, once.
→ `marketing/*` · S · **P2**

### Phase F — Small-surface delight (one beat each)

- **F1. Interview questions type themselves** — ReactBits *Text Type* cursor-typed
  question reveal (fast, 20 ms/char, skippable by click). → `InterviewPage.tsx` · S · **P2**
- **F2. Tools grid → bento** — keep TiltedCards but break the uniform 3-col grid: one
  wide featured cell (ATS scan) + regular cells (Magic Bento structure, minus the
  particles). Uniform card grids are the tell; the layout shift is free. → `ToolsPage.tsx` · S · **P2**
- **F3. Theme toggle morph** — sun↔moon path morph + a 250 ms cross-fade of the page
  (`::view-transition` if available). → `ThemeToggle.tsx` · S · **P2**
- **F4. Toast entrances** — slide+spring from the edge, success toasts get one ClickSpark
  burst. → `ui/Toast.tsx` · S · **P2**
- **F5. Logo's accent dot** — Büro Otto's red dot lesson: give the Logo dot one spring
  bounce on route change (the only "personality" motion in the shell). → `Logo.tsx` · S · **P2**

## 4. Guardrails (what we deliberately do NOT do)

1. **No WebGL inside the app register.** LightPillar stays marketing-only. App pages get
   CSS/SVG/framer-motion only — the app must stay instant on weak laptops.
2. **No decorative backgrounds on product pages** — no Aurora/Particles/Silk behind the
   tracker. Fable's dashboards are dark *and plain*; the data is the texture.
3. **Product motion ≤ 250 ms** except the two sanctioned moments (score reveal, stamp).
4. **Reduced motion is a feature.** The global kill switch exists; every new component
   still needs a designed static/crossfade fallback, not a frozen mid-state (reveals must
   never gate visibility).
5. **RTL:** every directional effect (shimmer sweeps, slide-ins, radar sweep, arrows)
   flips under `dir="rtl"`. Test each phase in Hebrew.
6. **No new heavy deps.** framer-motion covers everything above; ReactBits components are
   copied in as source (that's their model) and adapted to our tokens. No GSAP.
7. **Both themes, every time.** Glows read in dark; the light theme swaps to ink +
   paper shadows (tokens already do this — new effects must use tokens, never raw hex).

## 5. Suggested implementation order

| PR | Contents | Feel-delta per effort |
|---|---|---|
| 1 | A1 + A2 + A3 + A4 (motion tokens, ClickSpark, nav pill, route fades) | Huge — the shell feels alive in a day |
| 2 | B1 + B2 (stamp + score choreography) | The signature moment |
| 3 | C1 + C2 (status flip + drag physics) | Tracker satisfaction |
| 4 | D1 + D2 (scan ticker + results stagger) | The wait becomes the show |
| 5 | E2 + E3 + E1 (landing: kill gradient text, living mock, headline) | Marketing credibility |
| 6 | B3, B4, C3, F* | Layered craft |

Verification per PR: `npm run build` (0 errors), manual pass in dark + light + Hebrew RTL
+ `prefers-reduced-motion`, and no horizontal overflow on mobile (existing invariant).

## 6. Component shopping list (ReactBits → JobFinder)

| ReactBits component | Our adaptation | Used by |
|---|---|---|
| Click Spark | `ui/ClickSpark.tsx`, accent tokens | A2, F4 |
| Decrypted Text | `ui/DecryptText.tsx`, once-per-mount | B3 |
| Split/Blur Text | `marketing/SplitText.tsx` | E1 |
| Shiny Text | one-shot sheen | E2 |
| Animated List | stagger pattern only (no new component) | D2 |
| Text Type | `ui/TypeText.tsx`, skippable | F1 |
| Magic Bento | layout idea only, no particles | F2 |
| Count Up / Counter | already have `CountUp` — reuse | A5, C1, E5 |

Fable-25 contributions (patterns, not code): the stamp (Form 27-B/6), split-flap status
(Terminus), mission-control density + live chips (Helios), one-accent restraint + live
clock voice (Büro Otto), instrument gauges with status chips (Chronarium), deadpan
institutional microcopy (everywhere).
