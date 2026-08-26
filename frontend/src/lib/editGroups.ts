// Turning the tailor's ~60 flat edits into ~12 real decisions.
//
// The review list was long because it mixed three unrelated things and asked
// the user to vote on all of them equally. The TAILOR prompt is explicitly told
// to curate projects away and reorder bullets, so a large share of the
// "removals" are editorial decisions the model was INSTRUCTED to make —
// presenting each as "accept or decline?" is both exhausting and a false
// description of what happened.
//
// THE ONE DESIGN RULE HERE: classification and attribution are separate.
//
//   * CLASSIFICATION (which bucket an edit belongs in) reads ONLY the edit
//     itself — kind, section, before, after, id. It is total and always
//     correct, because everything it claims is provable from two strings.
//
//   * ATTRIBUTION (who cut something) reads the server's reports, is partial,
//     and is allowed to say nothing. `length_report.dropped_projects` proves
//     the page budget cut a project; its ABSENCE proves nothing, because
//     `fit_to_pages` is handed the model's already-curated résumé and
//     early-exits when that output already fits. A model-omitted project and a
//     budget-dropped one are indistinguishable on the wire.
//
// Keeping those apart is what lets the panel be exhaustive about WHAT is
// missing while staying silent about WHO removed it. No badge beats a wrong
// badge, in the one panel whose entire job is not making claims it can't back.
import type { CVPlan, LengthReport, ResumeModel } from "../types";
import type { EditSection, ResumeEdit } from "./resumeDiff";

export type EditClass = "rewrite" | "curation" | "addition";

const norm = (s: string) => (s ?? "").trim().replace(/\s+/g, " ");
const lkey = (s: string) => norm(s).toLowerCase();

/** Top-of-document fields are never quiet, whatever shape the change has.
 * `contact` is the one the AI must never touch at all; headline and summary are
 * the two highest-stakes lines and there is at most one of each, so they cost
 * nothing to show. */
const ALWAYS_LOUD: ReadonlySet<EditSection> = new Set<EditSection>(["contact", "headline", "summary"]);

/**
 * The after-text is the before-text with its tail cut off — content removed,
 * nothing reworded.
 *
 * Exact for the page budget's description compression: `_first_sentences`
 * splits on `(?<=[.!?])\s+` and rejoins with a single space, so the result is
 * the whitespace-normalised prefix of the original, character for character.
 *
 * The claim this supports — "text was cut, no new wording was introduced" — is
 * provable from the two strings alone, independent of who did the cutting.
 * That is exactly why it can be routed to curation without knowing the cause.
 */
export function isTruncation(edit: ResumeEdit): boolean {
  if (edit.kind !== "edited") return false;
  const before = norm(edit.before);
  const after = norm(edit.after);
  return after.length > 0 && before.length > after.length && before.startsWith(after);
}

export function classifyEdit(edit: ResumeEdit): EditClass {
  if (edit.kind === "added") return "addition";
  if (edit.kind === "removed") return "curation";
  if (ALWAYS_LOUD.has(edit.section)) return "rewrite";
  return isTruncation(edit) ? "curation" : "rewrite";
}

/** A whole protected ENTRY vanished — a role, a degree, a service record.
 * The TAILOR prompt forbids this ("a missing role reads as a gap the candidate
 * is hiding"), so it is an anomaly rather than editing, and it never gets
 * folded into the quiet card. List items (skills, certifications, languages,
 * bullets, projects) ARE editing and do go there. */
const PROTECTED_ENTRY_RM = /^(exp|edu|mil)\.rm\.\d+$/;
export const isProtectedEntryDrop = (e: ResumeEdit): boolean => PROTECTED_ENTRY_RM.test(e.id);

/** A whole entry the AI invented — the mirror image, and just as loud. */
const ENTRY_ADD = /^(exp|proj|edu|mil)\.add\./;
export const isEntryAddition = (e: ResumeEdit): boolean => ENTRY_ADD.test(e.id);

// --------------------------------------------------------------------------- //
// Attribution — projects only, and only ever on positive evidence.
// --------------------------------------------------------------------------- //

export type CurationCause = "budget" | "plan" | "unknown";

/** Name a removed project by INDEX rather than by parsing `before`. The id
 * shape is stable (`proj.rm.${oi}`) and `oi` indexes the ORIGINAL résumé. */
const PROJ_RM = /^proj\.rm\.(\d+)$/;
export function removedProjectName(e: ResumeEdit, original: ResumeModel | null): string {
  const m = PROJ_RM.exec(e.id);
  return m && original ? (original.projects[Number(m[1])]?.name ?? "") : "";
}

/**
 * Exact `lkey` equality only. The backend's own `_name_matches` is fuzzy
 * whole-token containment; borrowing it here would badge "Ledger" as
 * budget-cut because "Ledger Sync" was — a fabricated claim in the one panel
 * that exists to avoid fabricated claims.
 */
export function curationCause(
  e: ResumeEdit,
  original: ResumeModel | null,
  report: LengthReport | undefined,
  plan: CVPlan | null | undefined,
): CurationCause {
  const name = removedProjectName(e, original);
  if (!name) return "unknown"; // only whole projects are ever attributable
  const k = lkey(name);
  // A server-side record of the cut beats the planner's stated intent.
  if ((report?.dropped_projects ?? []).some((n) => lkey(n) === k)) return "budget";
  if ((plan?.drop_projects ?? []).some((n) => lkey(n) === k)) return "plan";
  return "unknown";
}

// --------------------------------------------------------------------------- //
// Grouping
// --------------------------------------------------------------------------- //

export interface EditGroup {
  /** React key and disclosure id. */
  key: string;
  cls: EditClass;
  section: EditSection;
  /** The résumé entry this group belongs to ("Engineer · Acme Corp"), or "". */
  context: string;
  edits: ResumeEdit[];
  /** How many of these carry a fabrication flag — a group with any is never collapsed. */
  flagged: number;
  /** A whole entry appeared or vanished: always shown, never folded away. */
  loud: boolean;
}

/** The single quiet card's key, so callers can special-case its rendering. */
export const CURATION_KEY = "curation";

const LIST_SECTIONS: ReadonlySet<EditSection> = new Set<EditSection>([
  "skills",
  "certifications",
  "languages",
]);

const SECTION_RANK: Record<EditSection, number> = {
  headline: 0,
  summary: 1,
  skills: 2,
  experience: 3,
  projects: 4,
  education: 5,
  certifications: 6,
  militaryService: 7,
  languages: 8,
  contact: 9,
};

/**
 * Group edits into the cards the review panel renders.
 *
 * `isFlagged` is injected rather than imported so this module stays pure and
 * testable, and so the caller keeps ownership of the flag-matching rule (which
 * is duplicated in KitReviewPage to gate its Approve button — changing it in
 * one place only would silently desync the two).
 */
export function groupEdits(
  edits: ResumeEdit[],
  isFlagged: (e: ResumeEdit) => boolean,
): EditGroup[] {
  const byKey = new Map<string, EditGroup>();
  const order: string[] = [];

  const push = (key: string, cls: EditClass, section: EditSection, context: string, loud: boolean, e: ResumeEdit) => {
    let g = byKey.get(key);
    if (!g) {
      g = { key, cls, section, context, edits: [], flagged: 0, loud };
      byKey.set(key, g);
      order.push(key);
    }
    g.loud = g.loud || loud;
    g.edits.push(e);
    if (isFlagged(e)) g.flagged += 1;
  };

  for (const e of edits) {
    const cls = classifyEdit(e);
    if (cls === "curation") {
      if (isProtectedEntryDrop(e)) push(e.id, cls, e.section, e.context, true, e);
      // Everything else that was removed or shortened lands in ONE card.
      else push(CURATION_KEY, cls, e.section, "", false, e);
    } else if (cls === "addition") {
      // A whole invented entry is a claim, never a chip in a row of chips.
      if (isEntryAddition(e)) push(e.id, cls, e.section, e.context, true, e);
      else if (LIST_SECTIONS.has(e.section)) push(`add:${e.section}`, cls, e.section, "", false, e);
      else push(`add:${e.section}::${e.context}`, cls, e.section, e.context, false, e);
    } else {
      // One card per résumé entry, so "Engineer · Acme Corp" holds its bullets.
      push(`rw:${e.section}::${e.context}`, cls, e.section, e.context, false, e);
    }
  }

  const CLASS_RANK: Record<EditClass, number> = { rewrite: 0, addition: 1, curation: 2 };
  const groups = order.map((k) => byKey.get(k)!);
  return groups.sort((a, b) => {
    // The quiet card always sits last, whatever sections it holds.
    const aQuiet = a.key === CURATION_KEY ? 1 : 0;
    const bQuiet = b.key === CURATION_KEY ? 1 : 0;
    if (aQuiet !== bQuiet) return aQuiet - bQuiet;
    if (CLASS_RANK[a.cls] !== CLASS_RANK[b.cls]) return CLASS_RANK[a.cls] - CLASS_RANK[b.cls];
    if (SECTION_RANK[a.section] !== SECTION_RANK[b.section])
      return SECTION_RANK[a.section] - SECTION_RANK[b.section];
    return order.indexOf(a.key) - order.indexOf(b.key);
  });
}

/**
 * Which groups start open.
 *
 * A group carrying a fabrication flag is NEVER collapsed — `ScoreCard` deep-links
 * into this panel and must never land on hidden content. That is safe by
 * construction for the quiet card: flag matching requires a non-empty `after`,
 * and every member of that card is either a removal (`after === ""`) or a
 * truncation whose `after` is a prefix of text already in the ledger. The quiet
 * card provably cannot hide a flag.
 *
 * Otherwise only the top-of-document fields open: there are at most three of
 * them, they are the highest-stakes lines on the page, and a group header
 * already says what changed ("Reworded · Projects · The Daily Catch · 1
 * rewrite") so nothing is hidden by collapsing the rest. An earlier rule opened
 * every single-edit group, which on a real 8-project résumé meant seven project
 * rewrites unfurled at once — 2,100 px of default height for cards the user can
 * open in one click.
 *
 * The quiet card is never open by default. It is the one card that can be large,
 * and 25 open rows is how the panel got to 8,000 px in the first place.
 */
export function opensByDefault(g: EditGroup): boolean {
  if (g.key === CURATION_KEY) return false;
  return g.flagged > 0 || g.loud || ALWAYS_LOUD.has(g.section);
}
