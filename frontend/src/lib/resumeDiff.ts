// Deterministic diff between the original and AI-tailored résumé, plus the
// accept/reject merge. The LLM's changelog is free text and can't be trusted
// for before/after pairs, so we compute them structurally: one merge walk
// emits the edit list AND builds the effective résumé, guaranteeing that what
// the review UI shows is exactly what accept/reject applies.
import type {
  Education,
  Experience,
  LanguageSkill,
  MilitaryService,
  Project,
  ResumeModel,
} from "../types";
import { countOccurrences } from "./keywords";
import { CONTACT_FIELDS, readBlock, type ContactField } from "./resumeBlocks";

export type EditKind = "edited" | "added" | "removed";

/**
 * Edit ids, keyed by where they land in the RENDERED (effective) résumé.
 *
 * Path grammar — indices are into the document ON SCREEN, not the original:
 *   `@headline` · `@summary` · `@contact` · `@contact.name`
 *   `@exp.<k>` · `@exp.<k>.b.<j>`     (same for `@proj`, `@mil`)
 *   `@edu.<k>`
 *   `@skills.<lkey>` · `@cert.<lkey>` · `@lang.<lkey>`
 *
 * **The `@` is mandatory and is not decoration.** Without it `exp.0.b.1` is
 * simultaneously a valid EDIT ID (original indices) and a valid PATH (effective
 * indices) — string-identical, different meaning, silently swappable.
 *
 * **Unordered lists are keyed, never indexed**, for two independent reasons: a
 * restored removal is appended at the END of the merged list rather than its old
 * slot, and `ResumeView` re-partitions `skills` through `skill_groups`, so a
 * skill's rendered position is not its index here.
 */
export type BlockAnchors = Record<string, string[]>;

/**
 * Block path → SOURCE ANCHOR: where that block came from in the ORIGINAL or
 * TAILORED résumé, rather than where it landed on screen.
 *
 * **Paths are not stable across accept/decline, and anchors are.** A rejected
 * removal is spliced back at `k = Math.min(oi, list.length)`, so every later
 * entry in that section shifts — proven by executing this module: with a
 * tailored résumé that drops `experience[0]`, `@exp.1` is "Gamma" with nothing
 * rejected and "Beta" with `exp.rm.0` rejected. The same splice runs for
 * projects, education, military and, one level down, bullets. So anything the
 * USER writes over the merged document has to be stored against this
 * coordinate; keyed by path it would land on a different bullet the first time
 * any add or removal in that section is toggled.
 *
 * The grammar is the EDIT-ID grammar, extended to blocks no edit touched
 * (`pick` returns early for an unchanged field and `mergeBullets` mints no id
 * for an unchanged bullet, so ids alone cannot key every block). It carries NO
 * `@` prefix, and that is the correct side of the boundary `BlockAnchors`
 * documents: an anchor names an original coordinate, a path names a rendered
 * one, and the two must never be silently swappable.
 *
 * Unlike `blocks`, this is emitted for EVERY block the walk produces — touched
 * or not. `anchor()` skips the empty ones; `src()` never does.
 */
export type BlockSources = Record<string, string>;

export type EditSection =
  | "headline"
  | "summary"
  | "skills"
  | "experience"
  | "projects"
  | "education"
  | "certifications"
  | "militaryService"
  | "languages"
  | "contact";

export interface ResumeEdit {
  /** Stable id derived from the ORIGINAL résumé's structure, so it survives
   * decision changes (the pairing is deterministic and decision-independent). */
  id: string;
  section: EditSection;
  /** Where in the résumé, e.g. "Engineer · Acme Corp". Empty for top-level fields. */
  context: string;
  kind: EditKind;
  before: string; // "" for added
  after: string; // "" for removed
}

const norm = (s: string) => (s ?? "").trim().replace(/\s+/g, " ");
const same = (a: string, b: string) => norm(a) === norm(b);
const lkey = (s: string) => norm(s).toLowerCase();

// Same token class as lib/keywords.ts (mirrors the backend scorer): Latin,
// digits, +#. and the Hebrew block, so Hebrew bullets pair correctly.
const TOKEN_RE = /[a-z0-9+#.֐-׿]+/gi;

function tokenSet(s: string): Set<string> {
  return new Set((s.toLowerCase().match(TOKEN_RE) ?? []).map((t) => t));
}

/** Dice coefficient over word-token sets — how likely `b` is a rewrite of `a`. */
function similarity(a: string, b: string): number {
  if (same(a, b)) return 1;
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return (2 * inter) / (ta.size + tb.size);
}

/**
 * Greedy best-match pairing between two entry lists. Returns, for each
 * tailored index, the matched original index (or null = added), plus the
 * original indices nothing matched (= removed).
 */
function pairEntries<T>(
  orig: T[],
  tail: T[],
  score: (o: T, t: T) => number,
  threshold: number,
): { tailMatch: (number | null)[]; removed: number[] } {
  const tailMatch: (number | null)[] = tail.map(() => null);
  const usedO = new Set<number>();
  const cands: { s: number; oi: number; ti: number }[] = [];
  orig.forEach((o, oi) =>
    tail.forEach((t, ti) => {
      const s = score(o, t);
      if (s >= threshold) cands.push({ s, oi, ti });
    }),
  );
  // Best score first; ties go to the pair that moved least.
  cands.sort((a, b) => b.s - a.s || Math.abs(a.ti - a.oi) - Math.abs(b.ti - b.oi));
  for (const c of cands) {
    if (usedO.has(c.oi) || tailMatch[c.ti] !== null) continue;
    usedO.add(c.oi);
    tailMatch[c.ti] = c.oi;
  }
  return { tailMatch, removed: orig.map((_, i) => i).filter((i) => !usedO.has(i)) };
}

const bulletScore = (o: string, t: string) => similarity(o, t);
const expScore = (o: Experience, t: Experience) =>
  o.company && lkey(o.company) === lkey(t.company)
    ? 1
    : similarity(`${o.company} ${o.title}`, `${t.company} ${t.title}`);
const projScore = (o: Project, t: Project) =>
  o.name && lkey(o.name) === lkey(t.name) ? 1 : similarity(`${o.name} ${o.description}`, `${t.name} ${t.description}`);
const eduScore = (o: Education, t: Education) =>
  o.institution && lkey(o.institution) === lkey(t.institution)
    ? 1
    : similarity(`${o.institution} ${o.degree}`, `${t.institution} ${t.degree}`);
const milScore = (o: MilitaryService, t: MilitaryService) =>
  o.unit && lkey(o.unit) === lkey(t.unit) ? 1 : similarity(`${o.unit} ${o.role}`, `${t.unit} ${t.role}`);

const dateRange = (start: string, end: string) => [start, end].filter(Boolean).join("–");

function formatExperience(e: Experience): string {
  const head = [[e.title, e.company].filter(Boolean).join(" — "), dateRange(e.start_date, e.end_date)]
    .filter(Boolean)
    .join(" · ");
  return [head, ...e.bullets.map((b) => `• ${b}`)].join("\n");
}
function formatProject(p: Project): string {
  return [[p.name, p.description].filter(Boolean).join(" — "), ...p.bullets.map((b) => `• ${b}`)].join("\n");
}
function formatEducation(e: Education): string {
  return [[e.degree, e.field].filter(Boolean).join(", "), e.institution, dateRange(e.start_date, e.end_date), e.details]
    .filter(Boolean)
    .join(" · ");
}
function formatMilitary(m: MilitaryService): string {
  const head = [[m.role, m.unit].filter(Boolean).join(" — "), m.rank, dateRange(m.start_date, m.end_date)]
    .filter(Boolean)
    .join(" · ");
  return [head, ...m.bullets.map((b) => `• ${b}`)].join("\n");
}
const formatLanguage = (l: LanguageSkill) => [l.language, l.level].filter(Boolean).join(" — ");

/**
 * The single merge walk. Emits every edit and simultaneously builds the
 * effective résumé where each edit takes its tailored value when accepted
 * and its original value when rejected.
 */
function mergeResumes(
  original: ResumeModel,
  tailored: ResumeModel,
  isRejected: (id: string) => boolean,
): {
  edits: ResumeEdit[];
  resume: ResumeModel;
  blocks: BlockAnchors;
  sources: BlockSources;
  editAnchors: Record<string, string>;
} {
  const edits: ResumeEdit[] = [];
  const blocks: BlockAnchors = {};
  const sources: BlockSources = {};
  const editAnchors: Record<string, string> = {};
  /** Record `ids` against an OUTPUT block path, skipping empty ones. */
  const anchor = (path: string, ids: string[]) => {
    if (ids.length) blocks[path] = ids;
  };
  /** Record the SOURCE ANCHOR of an output block path. The sibling of
   * `anchor()`, and the difference is the whole point: this one NEVER skips.
   * An untouched block still needs a stable coordinate, because the user can
   * type on it too. */
  const src = (path: string, from: string) => {
    sources[path] = from;
  };
  /** The anchor of an edit whose block may not be in the output AT ALL — a
   * declined addition, an accepted removal. `blocks` only names blocks that
   * exist, so it cannot answer "where did the hand-edit on the thing this
   * review row describes go?" for exactly the two cases the vanish rule is
   * about. Every other edit's anchor falls out of `blocks` + `sources` for
   * free, in the fill-in pass at the end of the walk. */
  const editSrc = (id: string, from: string) => {
    editAnchors[id] = from;
  };

  /** Scalar field: record an edit when changed, return the effective value.
   * `sink` collects the ids that landed, so the caller can anchor them to the
   * output block it is building. */
  function pick(
    id: string,
    section: EditSection,
    context: string,
    before: string,
    after: string,
    sink?: string[],
  ): string {
    if (same(before, after)) return after;
    edits.push({ id, section, context, kind: "edited", before, after });
    sink?.push(id);
    return isRejected(id) ? before : after;
  }

  /** Unordered string list (skills, certifications): per-item add/remove.
   * `ids` is index-aligned with `out` — see `mergeBullets` for why. `src` is
   * kept in the same lockstep: the item's own KEY, taken from the list it came
   * from (which is frozen while a result is up), so a later hand-rename of the
   * chip does not move the anchor out from under the text that renamed it. */
  function mergeStringList(
    idBase: string,
    section: EditSection,
    orig: string[],
    tail: string[],
  ): { out: string[]; ids: string[][]; src: string[] } {
    const okeys = orig.map(lkey);
    const tkeys = tail.map(lkey);
    const out: string[] = [];
    const ids: string[][] = [];
    const srcs: string[] = [];
    tail.forEach((s, ti) => {
      if (okeys.includes(tkeys[ti])) {
        out.push(s);
        ids.push([]);
        srcs.push(`${idBase}.item.${tkeys[ti]}`);
        return;
      }
      const id = `${idBase}.add.${tkeys[ti]}`;
      edits.push({ id, section, context: "", kind: "added", before: "", after: s });
      editSrc(id, `${idBase}.item.${tkeys[ti]}`);
      if (!isRejected(id)) {
        out.push(s);
        ids.push([id]);
        srcs.push(`${idBase}.item.${tkeys[ti]}`);
      }
    });
    orig.forEach((s, oi) => {
      if (tkeys.includes(okeys[oi])) return;
      const id = `${idBase}.rm.${okeys[oi]}`;
      edits.push({ id, section, context: "", kind: "removed", before: s, after: "" });
      editSrc(id, `${idBase}.item.${okeys[oi]}`);
      if (isRejected(id)) {
        out.push(s);
        ids.push([id]);
        srcs.push(`${idBase}.item.${okeys[oi]}`);
      }
    });
    return { out, ids, src: srcs };
  }

  /** Bullet list inside a matched entry: pair by similarity, then merge.
   *
   * `ids` is maintained in LOCKSTEP with `out` — every push and every splice
   * touches both. That is what makes an edit id addressable by its position in
   * the rendered document: edit ids index the ORIGINAL résumé, the document
   * shows the EFFECTIVE one, and a restored removal is spliced back in at an
   * index that shifts everything after it. Deriving the mapping afterwards
   * would mean re-deriving the pairing; carrying it along costs nothing.
   */
  function mergeBullets(
    idBase: string,
    section: EditSection,
    context: string,
    orig: string[],
    tail: string[],
  ): { out: string[]; ids: string[][]; src: string[] } {
    const { tailMatch, removed } = pairEntries(orig, tail, bulletScore, 0.3);
    const out: string[] = [];
    const ids: string[][] = [];
    // Third array, same lockstep, and it is the one that is filled for the
    // UNCHANGED case too — the branch that mints no id at all. A bullet nobody
    // touched is still a bullet the user can type on.
    const srcs: string[] = [];
    tail.forEach((t, ti) => {
      const oi = tailMatch[ti];
      if (oi === null) {
        const id = `${idBase}.b.add.${ti}`;
        edits.push({ id, section, context, kind: "added", before: "", after: t });
        editSrc(id, id);
        if (!isRejected(id)) {
          out.push(t);
          ids.push([id]);
          srcs.push(id);
        }
      } else if (same(orig[oi], t)) {
        out.push(t);
        ids.push([]);
        srcs.push(`${idBase}.b.${oi}`);
      } else {
        const id = `${idBase}.b.${oi}`;
        edits.push({ id, section, context, kind: "edited", before: orig[oi], after: t });
        out.push(isRejected(id) ? orig[oi] : t);
        ids.push([id]);
        srcs.push(id);
      }
    });
    for (const oi of removed) {
      const id = `${idBase}.b.rm.${oi}`;
      edits.push({ id, section, context, kind: "removed", before: orig[oi], after: "" });
      editSrc(id, id);
      if (isRejected(id)) {
        const k = Math.min(oi, out.length);
        out.splice(k, 0, orig[oi]);
        ids.splice(k, 0, [id]);
        srcs.splice(k, 0, id);
      }
    }
    return { out, ids, src: srcs };
  }

  /** Entry sections share one shape: a parallel id array per output entry, and
   * a parallel bullet-id array per output entry — plus the two SOURCE ANCHOR
   * twins of each. Emitting the paths is the same loop every time, so it lives
   * here rather than four times below. */
  function anchorEntries(
    prefix: string,
    entryIds: string[][],
    bulletIds: string[][][] = [],
    entrySrc: string[] = [],
    bulletSrc: string[][] = [],
  ) {
    entryIds.forEach((ids, k) => {
      anchor(`${prefix}.${k}`, ids);
      if (entrySrc[k]) src(`${prefix}.${k}`, entrySrc[k]);
      (bulletIds[k] ?? []).forEach((bids, j) => anchor(`${prefix}.${k}.b.${j}`, bids));
      (bulletSrc[k] ?? []).forEach((from, j) => src(`${prefix}.${k}.b.${j}`, from));
    });
  }

  // --- headline -------------------------------------------------------- //
  // The target-title line is a CLAIM the guard reads (for rank), so it has to
  // be diffable and rejectable like anything else. Leaving it out of this walk
  // silently DELETED it from the effective résumé the moment one edit was
  // rejected — and from the download, the tracker row and the cover letter
  // with it. Optional on older rows, hence the ?? "".
  const headlineIds: string[] = [];
  const headline = pick("headline", "headline", "", original.headline ?? "", tailored.headline ?? "", headlineIds);
  anchor("@headline", headlineIds);
  src("@headline", "headline");

  // --- summary --------------------------------------------------------- //
  const summaryIds: string[] = [];
  const summary = pick("summary", "summary", "", original.summary, tailored.summary, summaryIds);
  anchor("@summary", summaryIds);
  src("@summary", "summary");

  // --- skills ---------------------------------------------------------- //
  const skillsMerged = mergeStringList("skills", "skills", original.skills, tailored.skills);
  const skills = skillsMerged.out;
  skillsMerged.out.forEach((s, k) => {
    anchor(`@skills.${lkey(s)}`, skillsMerged.ids[k] ?? []);
    src(`@skills.${lkey(s)}`, skillsMerged.src[k]);
  });

  // Groups are presentation, so there is nothing here to accept or reject —
  // but they may never claim a skill the merge dropped: the backend's
  // flat-union validator only ever ADDS, so a stale group item resurrects the
  // skill it names on the next round trip and silently undoes the rejection.
  // Tailored résumés carry no groups by design, so this is a no-op for the
  // tailor path and only does work when the base document is a grouped master.
  const skillKeys = new Set(skills.map(lkey));
  const skill_groups = tailored.skill_groups
    ?.map((g) => ({ ...g, items: g.items.filter((k) => skillKeys.has(lkey(k))) }))
    .filter((g) => g.items.length > 0);

  // --- experience ------------------------------------------------------ //
  const experience: Experience[] = [];
  const expIds: string[][] = [];
  const expBulletIds: string[][][] = [];
  const expSrc: string[] = [];
  const expBulletSrc: string[][] = [];
  {
    const orig = original.experience;
    const tail = tailored.experience;
    const { tailMatch, removed } = pairEntries(orig, tail, expScore, 0.5);
    tail.forEach((t, ti) => {
      const oi = tailMatch[ti];
      if (oi === null) {
        const id = `exp.add.${ti}`;
        edits.push({ id, section: "experience", context: "", kind: "added", before: "", after: formatExperience(t) });
        editSrc(id, id);
        if (!isRejected(id)) {
          experience.push(t);
          expIds.push([id]);
          expBulletIds.push(t.bullets.map(() => []));
          expSrc.push(id);
          expBulletSrc.push(t.bullets.map((_, j) => `${id}.b.${j}`));
        }
        return;
      }
      const o = orig[oi];
      const ctx = [o.title, o.company].filter(Boolean).join(" · ");
      const sink: string[] = [];
      // Built field-by-field first so the edit ORDER stays "fields, then
      // bullets" — the review panel lists a group in edit order.
      const entry: Experience = {
        company: pick(`exp.${oi}.company`, "experience", ctx, o.company, t.company, sink),
        title: pick(`exp.${oi}.title`, "experience", ctx, o.title, t.title, sink),
        location: pick(`exp.${oi}.location`, "experience", ctx, o.location, t.location, sink),
        start_date: pick(`exp.${oi}.start`, "experience", ctx, o.start_date, t.start_date, sink),
        end_date: pick(`exp.${oi}.end`, "experience", ctx, o.end_date, t.end_date, sink),
        bullets: [],
      };
      const b = mergeBullets(`exp.${oi}`, "experience", ctx, o.bullets, t.bullets);
      entry.bullets = b.out;
      experience.push(entry);
      expIds.push(sink);
      expBulletIds.push(b.ids);
      expSrc.push(`exp.${oi}`);
      expBulletSrc.push(b.src);
    });
    for (const oi of removed) {
      const id = `exp.rm.${oi}`;
      edits.push({ id, section: "experience", context: "", kind: "removed", before: formatExperience(orig[oi]), after: "" });
      editSrc(id, id);
      if (isRejected(id)) {
        const k = Math.min(oi, experience.length);
        experience.splice(k, 0, orig[oi]);
        expIds.splice(k, 0, [id]);
        expBulletIds.splice(k, 0, orig[oi].bullets.map(() => []));
        expSrc.splice(k, 0, id);
        expBulletSrc.splice(k, 0, orig[oi].bullets.map((_, j) => `${id}.b.${j}`));
      }
    }
    anchorEntries("@exp", expIds, expBulletIds, expSrc, expBulletSrc);
  }

  // --- projects -------------------------------------------------------- //
  const projects: Project[] = [];
  const projIds: string[][] = [];
  const projBulletIds: string[][][] = [];
  const projSrc: string[] = [];
  const projBulletSrc: string[][] = [];
  {
    const orig = original.projects;
    const tail = tailored.projects;
    const { tailMatch, removed } = pairEntries(orig, tail, projScore, 0.5);
    tail.forEach((t, ti) => {
      const oi = tailMatch[ti];
      if (oi === null) {
        const id = `proj.add.${ti}`;
        edits.push({ id, section: "projects", context: "", kind: "added", before: "", after: formatProject(t) });
        editSrc(id, id);
        if (!isRejected(id)) {
          projects.push(t);
          projIds.push([id]);
          projBulletIds.push(t.bullets.map(() => []));
          projSrc.push(id);
          projBulletSrc.push(t.bullets.map((_, j) => `${id}.b.${j}`));
        }
        return;
      }
      const o = orig[oi];
      const ctx = o.name;
      const sink: string[] = [];
      const entry: Project = {
        name: pick(`proj.${oi}.name`, "projects", ctx, o.name, t.name, sink),
        description: pick(`proj.${oi}.desc`, "projects", ctx, o.description, t.description, sink),
        bullets: [],
      };
      const b = mergeBullets(`proj.${oi}`, "projects", ctx, o.bullets, t.bullets);
      entry.bullets = b.out;
      projects.push(entry);
      projIds.push(sink);
      projBulletIds.push(b.ids);
      projSrc.push(`proj.${oi}`);
      projBulletSrc.push(b.src);
    });
    for (const oi of removed) {
      const id = `proj.rm.${oi}`;
      edits.push({ id, section: "projects", context: "", kind: "removed", before: formatProject(orig[oi]), after: "" });
      editSrc(id, id);
      if (isRejected(id)) {
        const k = Math.min(oi, projects.length);
        projects.splice(k, 0, orig[oi]);
        projIds.splice(k, 0, [id]);
        projBulletIds.splice(k, 0, orig[oi].bullets.map(() => []));
        projSrc.splice(k, 0, id);
        projBulletSrc.splice(k, 0, orig[oi].bullets.map((_, j) => `${id}.b.${j}`));
      }
    }
    anchorEntries("@proj", projIds, projBulletIds, projSrc, projBulletSrc);
  }

  // --- education ------------------------------------------------------- //
  const education: Education[] = [];
  const eduIds: string[][] = [];
  const eduSrc: string[] = [];
  {
    const orig = original.education;
    const tail = tailored.education;
    const { tailMatch, removed } = pairEntries(orig, tail, eduScore, 0.5);
    tail.forEach((t, ti) => {
      const oi = tailMatch[ti];
      if (oi === null) {
        const id = `edu.add.${ti}`;
        edits.push({ id, section: "education", context: "", kind: "added", before: "", after: formatEducation(t) });
        editSrc(id, id);
        if (!isRejected(id)) {
          education.push(t);
          eduIds.push([id]);
          eduSrc.push(id);
        }
        return;
      }
      const o = orig[oi];
      const ctx = [o.degree, o.institution].filter(Boolean).join(" · ");
      const sink: string[] = [];
      education.push({
        institution: pick(`edu.${oi}.institution`, "education", ctx, o.institution, t.institution, sink),
        degree: pick(`edu.${oi}.degree`, "education", ctx, o.degree, t.degree, sink),
        field: pick(`edu.${oi}.field`, "education", ctx, o.field, t.field, sink),
        start_date: pick(`edu.${oi}.start`, "education", ctx, o.start_date, t.start_date, sink),
        end_date: pick(`edu.${oi}.end`, "education", ctx, o.end_date, t.end_date, sink),
        details: pick(`edu.${oi}.details`, "education", ctx, o.details, t.details, sink),
      });
      eduIds.push(sink);
      eduSrc.push(`edu.${oi}`);
    });
    for (const oi of removed) {
      const id = `edu.rm.${oi}`;
      edits.push({ id, section: "education", context: "", kind: "removed", before: formatEducation(orig[oi]), after: "" });
      editSrc(id, id);
      if (isRejected(id)) {
        const k = Math.min(oi, education.length);
        education.splice(k, 0, orig[oi]);
        eduIds.splice(k, 0, [id]);
        eduSrc.splice(k, 0, id);
      }
    }
    anchorEntries("@edu", eduIds, [], eduSrc);
  }

  // --- certifications -------------------------------------------------- //
  const certsMerged = mergeStringList("cert", "certifications", original.certifications, tailored.certifications);
  const certifications = certsMerged.out;
  certsMerged.out.forEach((c, k) => {
    anchor(`@cert.${lkey(c)}`, certsMerged.ids[k] ?? []);
    src(`@cert.${lkey(c)}`, certsMerged.src[k]);
  });

  // --- military service ------------------------------------------------ //
  const military: MilitaryService[] = [];
  const milIds: string[][] = [];
  const milBulletIds: string[][][] = [];
  const milSrc: string[] = [];
  const milBulletSrc: string[][] = [];
  {
    const orig = original.military_service ?? [];
    const tail = tailored.military_service ?? [];
    const { tailMatch, removed } = pairEntries(orig, tail, milScore, 0.5);
    tail.forEach((t, ti) => {
      const oi = tailMatch[ti];
      if (oi === null) {
        const id = `mil.add.${ti}`;
        edits.push({ id, section: "militaryService", context: "", kind: "added", before: "", after: formatMilitary(t) });
        editSrc(id, id);
        if (!isRejected(id)) {
          military.push(t);
          milIds.push([id]);
          milBulletIds.push(t.bullets.map(() => []));
          milSrc.push(id);
          milBulletSrc.push(t.bullets.map((_, j) => `${id}.b.${j}`));
        }
        return;
      }
      const o = orig[oi];
      const ctx = [o.role, o.unit].filter(Boolean).join(" · ");
      const sink: string[] = [];
      const entry: MilitaryService = {
        unit: pick(`mil.${oi}.unit`, "militaryService", ctx, o.unit, t.unit, sink),
        role: pick(`mil.${oi}.role`, "militaryService", ctx, o.role, t.role, sink),
        rank: pick(`mil.${oi}.rank`, "militaryService", ctx, o.rank, t.rank, sink),
        start_date: pick(`mil.${oi}.start`, "militaryService", ctx, o.start_date, t.start_date, sink),
        end_date: pick(`mil.${oi}.end`, "militaryService", ctx, o.end_date, t.end_date, sink),
        bullets: [],
      };
      const b = mergeBullets(`mil.${oi}`, "militaryService", ctx, o.bullets, t.bullets);
      entry.bullets = b.out;
      military.push(entry);
      milIds.push(sink);
      milBulletIds.push(b.ids);
      milSrc.push(`mil.${oi}`);
      milBulletSrc.push(b.src);
    });
    for (const oi of removed) {
      const id = `mil.rm.${oi}`;
      edits.push({ id, section: "militaryService", context: "", kind: "removed", before: formatMilitary(orig[oi]), after: "" });
      editSrc(id, id);
      if (isRejected(id)) {
        const k = Math.min(oi, military.length);
        military.splice(k, 0, orig[oi]);
        milIds.splice(k, 0, [id]);
        milBulletIds.splice(k, 0, orig[oi].bullets.map(() => []));
        milSrc.splice(k, 0, id);
        milBulletSrc.splice(k, 0, orig[oi].bullets.map((_, j) => `${id}.b.${j}`));
      }
    }
    anchorEntries("@mil", milIds, milBulletIds, milSrc, milBulletSrc);
  }

  // --- languages ------------------------------------------------------- //
  const languages: LanguageSkill[] = [];
  const langIds: string[][] = [];
  {
    const orig = original.languages ?? [];
    const tail = tailored.languages ?? [];
    const usedO = new Set<number>();
    tail.forEach((t) => {
      const oi = orig.findIndex((o, i) => !usedO.has(i) && lkey(o.language) === lkey(t.language));
      if (oi === -1) {
        const id = `lang.add.${lkey(t.language)}`;
        edits.push({ id, section: "languages", context: "", kind: "added", before: "", after: formatLanguage(t) });
        editSrc(id, `lang.item.${lkey(t.language)}`);
        if (!isRejected(id)) {
          languages.push(t);
          langIds.push([id]);
        }
        return;
      }
      usedO.add(oi);
      const o = orig[oi];
      if (same(o.level, t.level)) {
        languages.push(t);
        langIds.push([]);
      } else {
        const id = `lang.${lkey(o.language)}`;
        edits.push({ id, section: "languages", context: "", kind: "edited", before: formatLanguage(o), after: formatLanguage(t) });
        languages.push(isRejected(id) ? o : t);
        langIds.push([id]);
      }
    });
    orig.forEach((o, oi) => {
      if (usedO.has(oi)) return;
      const id = `lang.rm.${lkey(o.language)}`;
      edits.push({ id, section: "languages", context: "", kind: "removed", before: formatLanguage(o), after: "" });
      editSrc(id, `lang.item.${lkey(o.language)}`);
      if (isRejected(id)) {
        languages.push(o);
        langIds.push([id]);
      }
    });
    // Keyed, never indexed — a restored removal is APPENDED, so the anchor has
    // to be the language's own key rather than its slot.
    languages.forEach((l, k) => {
      anchor(`@lang.${lkey(l.language)}`, langIds[k] ?? []);
      src(`@lang.${lkey(l.language)}`, `lang.item.${lkey(l.language)}`);
    });
  }

  // --- contact (the AI must never touch it — surface it loudly if it did) //
  //
  // TWO anchorings per bit, and the order between them is load-bearing.
  // `ResumeView` renders the fused `@contact` line only when the document is
  // NOT editable; when it IS, it emits five separate `@contact.<field>` blocks.
  // This walk used to anchor all five non-name edits to the fused path alone,
  // so the moment editing was switched on for a tailored document a contact
  // mark pointed at a node that does not exist — and ChangeLog still rendered
  // its Crosshair, because that button gates on the id having ANY anchor. A
  // visible button that silently does nothing is the one thing ChangeLog's own
  // doc comment forbids. `blocksByEdit` is FIRST-wins, so emitting the
  // per-field path first is what makes the id resolve to the block that exists.
  //
  // The field list is DERIVED from `CONTACT_FIELDS` — the same array
  // `RE_CONTACT` is built from — so the paths this mints and the paths
  // `readBlock` resolves cannot drift by one word. `name` is prepended because
  // it is its own block on the title line, which is why that array excludes it.
  const contact = { ...tailored.contact };
  const contactSink: string[] = [];
  (["name", ...CONTACT_FIELDS] as ("name" | ContactField)[]).forEach((f) => {
    const sink: string[] = [];
    contact[f] = pick(`contact.${f}`, "contact", "", original.contact[f], tailored.contact[f], sink);
    src(`@contact.${f}`, `contact.${f}`);
    anchor(`@contact.${f}`, sink);
    // The fused line carries the UNION of the five, not whichever one changed
    // last: the old code re-assigned `blocks["@contact"]` once per field, so
    // with two contact bits rewritten only the second was reachable from it.
    if (f !== "name") contactSink.push(...sink);
  });
  src("@contact", "contact");
  anchor("@contact", contactSink);

  // Every edit that is NOT an add or a remove has a block in the output, so its
  // anchor falls out of the two maps above for nothing. First-wins, for
  // `blocksByEdit`'s reason: the per-field contact block is emitted before the
  // fused one and is the one an editable sheet actually renders.
  for (const [path, ids] of Object.entries(blocks)) {
    const from = sources[path];
    if (!from) continue;
    for (const id of ids) if (!(id in editAnchors)) editAnchors[id] = from;
  }

  return {
    edits,
    blocks,
    sources,
    editAnchors,
    resume: {
      contact,
      headline,
      summary,
      skills,
      skill_groups,
      experience,
      education,
      projects,
      certifications,
      military_service: military,
      languages,
    },
  };
}

/** All edits the AI made, in résumé order. */
export function diffResumes(original: ResumeModel, tailored: ResumeModel): ResumeEdit[] {
  return mergeResumes(original, tailored, () => false).edits;
}

/** The effective résumé after applying the user's accept/reject decisions. */
export function applyEditDecisions(
  original: ResumeModel,
  tailored: ResumeModel,
  rejected: ReadonlySet<string>,
): ResumeModel {
  return mergeResumes(original, tailored, (id) => rejected.has(id)).resume;
}

/**
 * The effective résumé, its edits, AND where each edit lands in it — the one
 * call the review surface wants, because all three come out of a single walk
 * and therefore cannot disagree.
 *
 * `blocks` maps an OUTPUT block path to the edit ids that touch it. Paths index
 * the document being RENDERED, not the original résumé, which is the whole
 * point: edit ids carry original indices and the rendered document is the
 * tailored one with restored removals spliced back in.
 *
 * An edit with no entry here has no block in the document — a removal that
 * stayed removed is the common case, and it is correct that it cannot be
 * anchored: it is not on the page.
 *
 * `sources` is the same map read the other way: OUTPUT path → the coordinate
 * that block came FROM. It is what makes the document editable while a result
 * is up, because a per-application edit stored against a path lands on the
 * wrong bullet the moment a decision shifts an index. `editAnchors` is its
 * companion for the review panel — edit id → the anchor of the block that edit
 * describes, filled even when that block is not in the output at all.
 */
export function mergeForReview(
  original: ResumeModel,
  tailored: ResumeModel,
  rejected: ReadonlySet<string>,
): {
  resume: ResumeModel;
  edits: ResumeEdit[];
  blocks: BlockAnchors;
  sources: BlockSources;
  editAnchors: Record<string, string>;
} {
  return mergeResumes(original, tailored, (id) => rejected.has(id));
}

/** The reverse index: edit id → the block path it lands in.
 *
 * FIRST-wins, deliberately. One id can now be anchored to two paths: the
 * contact walk emits `@contact.<field>` and then the fused `@contact`, because
 * the document renders one or the other depending on whether it is editable.
 * The per-field block is emitted first and is the one an editable sheet has, so
 * first-wins is what stops the review jump pointing at a node that is not
 * there. Nothing else emits two anchors for one id. */
export function blocksByEdit(blocks: BlockAnchors): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, ids] of Object.entries(blocks)) for (const id of ids) if (!(id in out)) out[id] = path;
  return out;
}

// --------------------------------------------------------------------- //
// Word-level inline diff for the before/after display
// --------------------------------------------------------------------- //
export interface DiffSeg {
  text: string;
  op: "same" | "add" | "del";
}

/** LCS over word tokens (whitespace preserved); merges adjacent same-op runs. */
export function wordDiff(before: string, after: string): { before: DiffSeg[]; after: DiffSeg[] } {
  const a = before.split(/(\s+)/).filter((t) => t.length);
  const b = after.split(/(\s+)/).filter((t) => t.length);
  const m = a.length;
  const n = b.length;
  // DP table for LCS length; token counts are small (bullets), so O(m·n) is fine.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const beforeSegs: DiffSeg[] = [];
  const afterSegs: DiffSeg[] = [];
  const push = (list: DiffSeg[], text: string, op: DiffSeg["op"]) => {
    const last = list[list.length - 1];
    if (last && last.op === op) last.text += text;
    else list.push({ text, op });
  };
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      push(beforeSegs, a[i], "same");
      push(afterSegs, b[j], "same");
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push(beforeSegs, a[i], "del");
      i++;
    } else {
      push(afterSegs, b[j], "add");
      j++;
    }
  }
  while (i < m) push(beforeSegs, a[i++], "del");
  while (j < n) push(afterSegs, b[j++], "add");
  return { before: beforeSegs, after: afterSegs };
}

// --------------------------------------------------------------------- //
// Per-edit annotations
// --------------------------------------------------------------------- //

/** JD keywords this edit introduces (verbatim in the after-text, absent before). */
export function keywordsServed(edit: ResumeEdit, jdKeywords: string[]): string[] {
  if (!edit.after) return [];
  return jdKeywords.filter(
    (kw) => countOccurrences(kw, edit.after) > 0 && (!edit.before || countOccurrences(kw, edit.before) === 0),
  );
}

/**
 * The containment test, in ONE place.
 *
 * `editContainsValue` asks it about a wording the AI PROPOSED; `blockContainsValue`
 * asks it about the document that wording landed in. They are two readings of the
 * same string and they may never disagree — a flag row that reads "resolved" off
 * the proposal while the value is still on the paper is precisely the lie below.
 */
const holds = (text: string, value: string): boolean => !!text && lkey(text).includes(lkey(value));

/** Whether a fabrication flag's value lives inside this edit's new text. */
export function editContainsValue(edit: ResumeEdit, value: string): boolean {
  return holds(edit.after, value);
}

/**
 * Whether a flagged value is still in ONE block of the document as it now stands.
 *
 * THE DOCUMENT, NOT THE DECISION. A flag used to count as resolved when every
 * edit carrying its value was rejected, and that inference was sound for exactly
 * as long as rejecting was the only way to change a line: the guard flags a value
 * *because* it is not in the original, so putting the original back removes it.
 * Since the tailored document is typed on (23.7) a rejection and a hand-edit can
 * stand on the same block at once, and `applyOverrides` runs LAST — so the
 * override wins the PAPER while the rejection wins the FLAG ROW. Reject the
 * flagged edit, then type over the same bullet keeping the invented number, and
 * the whole trust panel went mint while the number shipped.
 *
 * Asking the block is what closes that: green now means "the value is not on the
 * line it was on", which is a statement about the file the user is about to send.
 *
 * PER BLOCK rather than over the whole résumé, and that is a false-positive
 * guard, not an economy. A `number` flag can be a bare "12" (`_NUMBER_RE` takes
 * digits on their own) and a `date` flag can be "2019" — both are substrings of
 * text that has nothing to do with them ("2012", another role's dates), so a
 * whole-document scan would leave those rows red forever no matter what the user
 * did. The line the value came from is the honest haystack. Per FIELD inside it
 * for the same reason: joining an entry's five fields lets a value straddle two
 * of them and match something nobody wrote.
 */
export function blockContainsValue(resume: ResumeModel, path: string, value: string): boolean {
  const draft = readBlock(resume, path);
  return !!draft && draft.fields.some((f) => holds(f.value, value));
}

/**
 * The same containment, over the block AND everything nested inside it.
 *
 * AN ENTRY EDIT IS NOT AN ENTRY BLOCK, and conflating the two falsely CLEARED a
 * fabrication flag. `blocksByEdit` resolves an added or removed entry to its
 * META path (`@exp.2`), whose `readBlock` fields are title/employer/location/
 * dates — but the edit's own text comes from `formatExperience`, which folds the
 * entry's BULLETS in. So the guard flagged an invented number that lives in a
 * bullet, `editContainsValue` matched it there, and `blockContainsValue` then
 * looked for it in the meta line alone, found nothing, and reported the flag
 * resolved: "Nothing flagged is on your CV any more", printed over a CV that
 * still carried it. Reproduced by executing the shipped modules.
 *
 * The bullet walk is DERIVED from `readBlock` rather than from the model: it
 * increments until the reader says there is no such bullet, so it cannot drift
 * from what the document actually addresses, and a kind with no bullets (an
 * education entry) stops at the first probe. `@…b.<j>` is `RE_BULLET`'s own
 * grammar — the reader is the only thing that decides whether a path exists.
 */
export function blockSubtreeContainsValue(
  resume: ResumeModel,
  path: string,
  value: string,
): boolean {
  if (blockContainsValue(resume, path, value)) return true;
  for (let j = 0; ; j++) {
    const bullet = readBlock(resume, `${path}.b.${j}`);
    if (!bullet) return false;
    if (bullet.fields.some((f) => holds(f.value, value))) return true;
  }
}
