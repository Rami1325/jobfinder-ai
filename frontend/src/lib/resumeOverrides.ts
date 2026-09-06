// Per-application edits to a TAILORED document — the layer that lets `/app` be
// typed on while a tailor result is up, without a single character reaching the
// master resume.
//
// WHY THIS IS NOT KEYED BY BLOCK PATH, which is the obvious design and is the
// one that corrupts data. `mergeForReview` rebuilds the effective resume on
// every accept and decline, and a rejected removal is spliced back in at
// `k = Math.min(oi, list.length)` — so every later entry in that section
// shifts. Proven by bundling and RUNNING the shipped merge: with a tailored
// resume that drops `experience[0]`,
//     nothing rejected   →  resume.experience[1].company === "Gamma"
//     exp.rm.0 rejected  →  resume.experience[1].company === "Beta"
// `@exp.1` is a different job in the two states, and the identical splice runs
// for projects, education, military and, one level down, bullets. An override
// keyed by path therefore writes the user's own sentence onto a DIFFERENT
// bullet the first time any add or removal in that section is toggled — silent
// corruption of the most valuable object they own, which is the failure class
// this codebase refuses outright.
//
// So the key is a SOURCE ANCHOR: the coordinate of the block in the ORIGINAL /
// TAILORED resume, emitted by the same walk that emits the paths (one walk, so
// they cannot disagree) and frozen for as long as a result is up. It carries NO
// `@` prefix, which is the correct side of the boundary the path grammar draws
// — an anchor names an original coordinate, a path names a rendered one, and
// the two must never be silently swappable.
//
// Pure: no React, no i18n, no network. That is not incidental — it is what lets
// `scripts/check-mirrors.js` bundle this file together with `resumeDiff.ts` and
// EXECUTE both, which is the only way to pin a property about index stability.
import { readBlock, removeBlock, writeBlock, type Values } from "./resumeBlocks";
import type { BlockAnchors, BlockSources } from "./resumeDiff";
import type { ResumeModel } from "../types";

/** Source anchor → the values the user typed into that block. */
export type Overrides = Record<string, Values>;

/**
 * A line the USER deleted from this application's CV, by clearing it.
 *
 * Returned rather than merely done, because the alternative is a deletion nobody
 * can see or undo. `applyOverrides` is the only thing that knows a blank value
 * became a removal; the document cannot say so (the block is gone) and the review
 * panel cannot either (an anchor missing from `sources` looks exactly like a block
 * a DECLINED change took off the page — the two causes were indistinguishable, so
 * the user's own deletion was reported as "a declined change removed the line it
 * was on" and offered two buttons that both silently put it back).
 */
export interface RemovedBlock {
  /** The coordinate the user's blank value was stored against. */
  anchor: string;
  /** Where it stood in this merge, immediately before it was removed. */
  path: string;
  /** Its own words, as the document still had them. Read from the PRE-override
   * resume, which is the last place they exist. */
  text: string;
}

/**
 * Values as one line, in the document's own words.
 *
 * ONE definition. The deleted-lines list, the "your edits" list and the removal
 * record all name the same blocks, and three joins would be free to describe the
 * same line three ways. It takes bare `{ value }` records rather than a
 * `BlockDraft` so the one case with no block left to read — a hand-edit the vanish
 * rule is holding — can name itself by the values the user typed, through this
 * same function instead of a fourth join beside it.
 */
export function blockText(fields: readonly { value?: string }[] | null | undefined): string {
  return (fields ?? []).map((f) => (f.value ?? "").trim()).filter(Boolean).join(" · ");
}

/**
 * Where a write to `path` LANDS, which is not always where it started.
 *
 * A keyed block's path is derived from its own VALUE — `@lang.hebrew` stops
 * existing the instant it becomes "Arabic" — so a rename MOVES the block, and a
 * caller that spotlights the path it wrote to is naming a node that is no longer
 * there: the confirmation bloom silently does not play. `writeBlock` already
 * answers this (it hands the moved path back for exactly this reason) and it is
 * the single writer, so this asks it rather than re-deriving the key. The resume
 * it is asked about is thrown away.
 */
export function movedPath(resume: ResumeModel, path: string, values: Values): string {
  const r = writeBlock(resume, path, values);
  return r.ok ? r.path : path;
}

/** Every value blank. The empty-means-remove rule reads this. */
const blank = (values: Values) => Object.values(values).every((v) => !(v ?? "").trim());

/** Trailing index of a path (`@exp.0.b.3` → 3); -1 for a keyed path. */
const tailIndex = (path: string): number => {
  const m = /\.(\d+)$/.exec(path);
  return m ? Number(m[1]) : -1;
};

/** Move one key of a path-indexed map, keeping the rest in place. */
function rekey<T>(map: Record<string, T>, from: string, to: string): Record<string, T> {
  if (!(from in map)) return map;
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(map)) out[k === from ? to : k] = v;
  return out;
}

/**
 * Re-key one path-indexed map after `removed` was deleted from the document.
 *
 * Removing a bullet shifts every LATER bullet in the same entry down by one, so
 * a map keyed by rendered path is stale the instant it happens. The stale
 * `sources` is the serious half and the reason this exists: the NEXT override
 * on a shifted bullet would be stored under its neighbour's anchor, which is
 * exactly the index instability this whole module defeats. `blocks` is re-keyed
 * with it so the review marks do not slide onto the wrong line either.
 *
 * A keyed removal (a skill, a certification, a language) shifts nothing — the
 * paths are keys, not slots — so it takes the plain delete branch.
 */
function reindex<T>(map: Record<string, T>, removed: string): Record<string, T> {
  const bullet = /^(@(?:exp|proj|mil)\.\d+\.b\.)(\d+)$/.exec(removed);
  const out: Record<string, T> = {};
  const gone = bullet ? Number(bullet[2]) : -1;
  for (const [k, v] of Object.entries(map)) {
    if (k === removed) continue;
    if (bullet && k.startsWith(bullet[1])) {
      const rest = k.slice(bullet[1].length);
      if (/^\d+$/.test(rest) && Number(rest) > gone) {
        out[`${bullet[1]}${Number(rest) - 1}`] = v;
        continue;
      }
    }
    out[k] = v;
  }
  return out;
}

/**
 * Apply the user's own edits over the accept/decline merge.
 *
 * THE ORDER IS THE ALGORITHM:
 *  1. Invert `sources` to anchor → path, resolved against the PRE-override
 *     resume. This is where the index instability dies: an anchor resolves to
 *     whatever path its block landed on in THIS merge.
 *  2. Partition into value writes and removals, reusing the empty-means-remove
 *     rule verbatim (`readBlock(...)?.removable` plus a blank value) rather
 *     than inventing a marker for it.
 *  3. Value writes. These never shift a sibling's path — `writeBlock` only
 *     replaces in place — EXCEPT a keyed rename, which hands back a moved path;
 *     that move is carried into the returned maps so the mark and the review
 *     jump follow the renamed chip.
 *  4. Removals LAST, descending by resolved index, because removing a bullet
 *     shifts the ones after it.
 *
 * `writeBlock` / `removeBlock` stay the only writers and `readBlock` the only
 * reader, per the single-writer rule. Nothing here rebuilds a `ResumeModel`
 * field by field, which is also what keeps it incapable of dropping a field the
 * way the merge once dropped `headline`.
 *
 * THE VANISH RULE: an anchor that resolves to no path is SKIPPED, never
 * deleted. Its block is not on the page right now — a declined addition, a
 * re-accepted removal — and dropping the user's text on a reversible toggle is
 * the failure being avoided. Undo the toggle and the text comes back. The
 * review panel says so rather than leaving it a surprise.
 *
 * `removed` is the fifth thing that has to come back out. It is the only record
 * that a blank value was a DELETION rather than a vanish, and without it the two
 * are string-identical downstream: both leave an anchor with no path. See
 * `RemovedBlock`.
 */
export function applyOverrides(
  resume: ResumeModel,
  sources: BlockSources,
  overrides: Overrides,
  blocks: BlockAnchors = {},
): {
  resume: ResumeModel;
  sources: BlockSources;
  blocks: BlockAnchors;
  removed: RemovedBlock[];
} {
  const anchors = Object.keys(overrides);
  if (anchors.length === 0) return { resume, sources, blocks, removed: [] };

  const byAnchor: Record<string, string> = {};
  for (const [path, anchor] of Object.entries(sources)) {
    if (!(anchor in byAnchor)) byAnchor[anchor] = path;
  }

  const writes: { path: string; values: Values }[] = [];
  // The anchor rides along: it is what the caller classifies by, and it cannot be
  // recovered afterwards — `reindex` has dropped the path by then.
  const removals: { anchor: string; path: string; text: string }[] = [];
  for (const anchor of anchors) {
    const path = byAnchor[anchor];
    if (!path) continue; // the vanish rule
    const draft = readBlock(resume, path);
    if (!draft) continue; // the anchor resolved to a path the document lost
    if (draft.removable && blank(overrides[anchor])) removals.push({ anchor, path, text: blockText(draft.fields) });
    else writes.push({ path, values: overrides[anchor] });
  }

  let out = resume;
  let nextSources = sources;
  let nextBlocks = blocks;

  for (const w of writes) {
    const r = writeBlock(out, w.path, w.values);
    if (!r.ok) continue;
    out = r.resume;
    if (r.path && r.path !== w.path) {
      nextSources = rekey(nextSources, w.path, r.path);
      nextBlocks = rekey(nextBlocks, w.path, r.path);
    }
  }

  const removed: RemovedBlock[] = [];
  for (const rm of [...removals].sort((a, b) => tailIndex(b.path) - tailIndex(a.path))) {
    const r = removeBlock(out, rm.path);
    // Only a removal that actually happened is reported: a line still on the page
    // must never appear in a list headed "you deleted this".
    if (!r.ok) continue;
    out = r.resume;
    nextSources = reindex(nextSources, rm.path);
    nextBlocks = reindex(nextBlocks, rm.path);
    removed.push(rm);
  }

  return { resume: out, sources: nextSources, blocks: nextBlocks, removed };
}
