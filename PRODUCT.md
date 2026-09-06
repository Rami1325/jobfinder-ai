# Product

> Inferred from the codebase (CLAUDE.md, landing copy, feature set) on 2026-07-10.
> Review the Users / Brand Personality / Anti-references sections and correct anything off.

## Register

product

(The `/` marketing landing is a **brand** sub-surface and may take brand-register liberties;
everything under `/app`, `/jobs`, `/tracker`, `/interview`, `/tools` is product register.)

## Users

Active job seekers — English and Hebrew speaking (the UI is bilingual, RTL first-class),
many applying to Israeli boards (Drushim, JobMaster, Comeet) and global ones (LinkedIn,
Greenhouse). They are mid-application-grind: stressed, juggling dozens of postings,
skeptical of AI tools that invent experience. The job to be done: get more interviews
from the same true facts — tailor, apply, track, follow up.

## Product Purpose

JobFinder tailors a master resume to specific job descriptions, scores the match before
and after, and — its one differentiator no competitor shows — runs a **fabrication guard**
that diffs every tailored claim against a facts ledger derived from the original resume.
It also finds jobs across boards, ranks them by fit, builds application kits, auto-submits
guard-clean Comeet kits, preps interviews, and tracks the pipeline. Success looks like:
interviews booked, zero fabricated claims ever shipped.

## Brand Personality

Honest, precise, calm. "Verified" is the emotional core — the product is the anti-hype
job tool. Confidence comes from showing the machine's work (scores, diffs, flags), not
from marketing adjectives. Three words: **honest · precise · alive**.

## Anti-references

- "Beat the ATS" growth-hack tools — screaming urgency, fake scarcity, testimonial walls.
- Generic AI-SaaS landing slop — purple gradient heroes, glassmorphism cards, orbiting blobs.
- Anything that implies the product will exaggerate on the user's behalf.

## Design Principles

1. **Proof over promise.** Show the guard working (stamps, diffs, live flags) — never just claim honesty.
2. **Motion is state.** Every animation reports something real: a score arriving, a status changing, a claim verified. No decorative motion inside the app register.
3. **Dense but legible.** Job hunting is data work. Respect attention: tabular numerals, tight scales, clear hierarchy (Helios-style "mission control", not terminal cosplay).
4. **One signature moment per surface.** Each page earns a single orchestrated beat (score reveal, stamp landing, board flip); everything else stays 150–250 ms.
5. **Deadpan copy.** The voice is dry and specific ("We won't invent a promotion for you"), never hype.

## Accessibility & Inclusion

- WCAG AA contrast in both themes (the light "warm paper" palette is already AA-tuned).
- Full `prefers-reduced-motion` fallbacks — a global kill switch exists in `styles.css`; every new effect must also degrade gracefully (fade instead of choreography).
- RTL/Hebrew is first-class: directional motion (sweeps, slides, arrows) must flip with `dir`, and Heebo carries Hebrew text.
- Hover-only effects (tilt, spotlight, captions) are pointer-gated; touch users get flat equivalents.
