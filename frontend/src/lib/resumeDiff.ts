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

export type EditKind = "edited" | "added" | "removed";

export type EditSection =
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
): { edits: ResumeEdit[]; resume: ResumeModel } {
  const edits: ResumeEdit[] = [];

  /** Scalar field: record an edit when changed, return the effective value. */
  function pick(id: string, section: EditSection, context: string, before: string, after: string): string {
    if (same(before, after)) return after;
    edits.push({ id, section, context, kind: "edited", before, after });
    return isRejected(id) ? before : after;
  }

  /** Unordered string list (skills, certifications): per-item add/remove. */
  function mergeStringList(idBase: string, section: EditSection, orig: string[], tail: string[]): string[] {
    const okeys = orig.map(lkey);
    const tkeys = tail.map(lkey);
    const out: string[] = [];
    tail.forEach((s, ti) => {
      if (okeys.includes(tkeys[ti])) {
        out.push(s);
        return;
      }
      const id = `${idBase}.add.${tkeys[ti]}`;
      edits.push({ id, section, context: "", kind: "added", before: "", after: s });
      if (!isRejected(id)) out.push(s);
    });
    orig.forEach((s, oi) => {
      if (tkeys.includes(okeys[oi])) return;
      const id = `${idBase}.rm.${okeys[oi]}`;
      edits.push({ id, section, context: "", kind: "removed", before: s, after: "" });
      if (isRejected(id)) out.push(s);
    });
    return out;
  }

  /** Bullet list inside a matched entry: pair by similarity, then merge. */
  function mergeBullets(idBase: string, section: EditSection, context: string, orig: string[], tail: string[]): string[] {
    const { tailMatch, removed } = pairEntries(orig, tail, bulletScore, 0.3);
    const out: string[] = [];
    tail.forEach((t, ti) => {
      const oi = tailMatch[ti];
      if (oi === null) {
        const id = `${idBase}.b.add.${ti}`;
        edits.push({ id, section, context, kind: "added", before: "", after: t });
        if (!isRejected(id)) out.push(t);
      } else if (same(orig[oi], t)) {
        out.push(t);
      } else {
        const id = `${idBase}.b.${oi}`;
        edits.push({ id, section, context, kind: "edited", before: orig[oi], after: t });
        out.push(isRejected(id) ? orig[oi] : t);
      }
    });
    for (const oi of removed) {
      const id = `${idBase}.b.rm.${oi}`;
      edits.push({ id, section, context, kind: "removed", before: orig[oi], after: "" });
      if (isRejected(id)) out.splice(Math.min(oi, out.length), 0, orig[oi]);
    }
    return out;
  }

  // --- summary --------------------------------------------------------- //
  const summary = pick("summary", "summary", "", original.summary, tailored.summary);

  // --- skills ---------------------------------------------------------- //
  const skills = mergeStringList("skills", "skills", original.skills, tailored.skills);

  // --- experience ------------------------------------------------------ //
  const experience: Experience[] = [];
  {
    const orig = original.experience;
    const tail = tailored.experience;
    const { tailMatch, removed } = pairEntries(orig, tail, expScore, 0.5);
    tail.forEach((t, ti) => {
      const oi = tailMatch[ti];
      if (oi === null) {
        const id = `exp.add.${ti}`;
        edits.push({ id, section: "experience", context: "", kind: "added", before: "", after: formatExperience(t) });
        if (!isRejected(id)) experience.push(t);
        return;
      }
      const o = orig[oi];
      const ctx = [o.title, o.company].filter(Boolean).join(" · ");
      experience.push({
        company: pick(`exp.${oi}.company`, "experience", ctx, o.company, t.company),
        title: pick(`exp.${oi}.title`, "experience", ctx, o.title, t.title),
        location: pick(`exp.${oi}.location`, "experience", ctx, o.location, t.location),
        start_date: pick(`exp.${oi}.start`, "experience", ctx, o.start_date, t.start_date),
        end_date: pick(`exp.${oi}.end`, "experience", ctx, o.end_date, t.end_date),
        bullets: mergeBullets(`exp.${oi}`, "experience", ctx, o.bullets, t.bullets),
      });
    });
    for (const oi of removed) {
      const id = `exp.rm.${oi}`;
      edits.push({ id, section: "experience", context: "", kind: "removed", before: formatExperience(orig[oi]), after: "" });
      if (isRejected(id)) experience.splice(Math.min(oi, experience.length), 0, orig[oi]);
    }
  }

  // --- projects -------------------------------------------------------- //
  const projects: Project[] = [];
  {
    const orig = original.projects;
    const tail = tailored.projects;
    const { tailMatch, removed } = pairEntries(orig, tail, projScore, 0.5);
    tail.forEach((t, ti) => {
      const oi = tailMatch[ti];
      if (oi === null) {
        const id = `proj.add.${ti}`;
        edits.push({ id, section: "projects", context: "", kind: "added", before: "", after: formatProject(t) });
        if (!isRejected(id)) projects.push(t);
        return;
      }
      const o = orig[oi];
      const ctx = o.name;
      projects.push({
        name: pick(`proj.${oi}.name`, "projects", ctx, o.name, t.name),
        description: pick(`proj.${oi}.desc`, "projects", ctx, o.description, t.description),
        bullets: mergeBullets(`proj.${oi}`, "projects", ctx, o.bullets, t.bullets),
      });
    });
    for (const oi of removed) {
      const id = `proj.rm.${oi}`;
      edits.push({ id, section: "projects", context: "", kind: "removed", before: formatProject(orig[oi]), after: "" });
      if (isRejected(id)) projects.splice(Math.min(oi, projects.length), 0, orig[oi]);
    }
  }

  // --- education ------------------------------------------------------- //
  const education: Education[] = [];
  {
    const orig = original.education;
    const tail = tailored.education;
    const { tailMatch, removed } = pairEntries(orig, tail, eduScore, 0.5);
    tail.forEach((t, ti) => {
      const oi = tailMatch[ti];
      if (oi === null) {
        const id = `edu.add.${ti}`;
        edits.push({ id, section: "education", context: "", kind: "added", before: "", after: formatEducation(t) });
        if (!isRejected(id)) education.push(t);
        return;
      }
      const o = orig[oi];
      const ctx = [o.degree, o.institution].filter(Boolean).join(" · ");
      education.push({
        institution: pick(`edu.${oi}.institution`, "education", ctx, o.institution, t.institution),
        degree: pick(`edu.${oi}.degree`, "education", ctx, o.degree, t.degree),
        field: pick(`edu.${oi}.field`, "education", ctx, o.field, t.field),
        start_date: pick(`edu.${oi}.start`, "education", ctx, o.start_date, t.start_date),
        end_date: pick(`edu.${oi}.end`, "education", ctx, o.end_date, t.end_date),
        details: pick(`edu.${oi}.details`, "education", ctx, o.details, t.details),
      });
    });
    for (const oi of removed) {
      const id = `edu.rm.${oi}`;
      edits.push({ id, section: "education", context: "", kind: "removed", before: formatEducation(orig[oi]), after: "" });
      if (isRejected(id)) education.splice(Math.min(oi, education.length), 0, orig[oi]);
    }
  }

  // --- certifications -------------------------------------------------- //
  const certifications = mergeStringList("cert", "certifications", original.certifications, tailored.certifications);

  // --- military service ------------------------------------------------ //
  const military: MilitaryService[] = [];
  {
    const orig = original.military_service ?? [];
    const tail = tailored.military_service ?? [];
    const { tailMatch, removed } = pairEntries(orig, tail, milScore, 0.5);
    tail.forEach((t, ti) => {
      const oi = tailMatch[ti];
      if (oi === null) {
        const id = `mil.add.${ti}`;
        edits.push({ id, section: "militaryService", context: "", kind: "added", before: "", after: formatMilitary(t) });
        if (!isRejected(id)) military.push(t);
        return;
      }
      const o = orig[oi];
      const ctx = [o.role, o.unit].filter(Boolean).join(" · ");
      military.push({
        unit: pick(`mil.${oi}.unit`, "militaryService", ctx, o.unit, t.unit),
        role: pick(`mil.${oi}.role`, "militaryService", ctx, o.role, t.role),
        rank: pick(`mil.${oi}.rank`, "militaryService", ctx, o.rank, t.rank),
        start_date: pick(`mil.${oi}.start`, "militaryService", ctx, o.start_date, t.start_date),
        end_date: pick(`mil.${oi}.end`, "militaryService", ctx, o.end_date, t.end_date),
        bullets: mergeBullets(`mil.${oi}`, "militaryService", ctx, o.bullets, t.bullets),
      });
    });
    for (const oi of removed) {
      const id = `mil.rm.${oi}`;
      edits.push({ id, section: "militaryService", context: "", kind: "removed", before: formatMilitary(orig[oi]), after: "" });
      if (isRejected(id)) military.splice(Math.min(oi, military.length), 0, orig[oi]);
    }
  }

  // --- languages ------------------------------------------------------- //
  const languages: LanguageSkill[] = [];
  {
    const orig = original.languages ?? [];
    const tail = tailored.languages ?? [];
    const usedO = new Set<number>();
    tail.forEach((t) => {
      const oi = orig.findIndex((o, i) => !usedO.has(i) && lkey(o.language) === lkey(t.language));
      if (oi === -1) {
        const id = `lang.add.${lkey(t.language)}`;
        edits.push({ id, section: "languages", context: "", kind: "added", before: "", after: formatLanguage(t) });
        if (!isRejected(id)) languages.push(t);
        return;
      }
      usedO.add(oi);
      const o = orig[oi];
      if (same(o.level, t.level)) {
        languages.push(t);
      } else {
        const id = `lang.${lkey(o.language)}`;
        edits.push({ id, section: "languages", context: "", kind: "edited", before: formatLanguage(o), after: formatLanguage(t) });
        languages.push(isRejected(id) ? o : t);
      }
    });
    orig.forEach((o, oi) => {
      if (usedO.has(oi)) return;
      const id = `lang.rm.${lkey(o.language)}`;
      edits.push({ id, section: "languages", context: "", kind: "removed", before: formatLanguage(o), after: "" });
      if (isRejected(id)) languages.push(o);
    });
  }

  // --- contact (the AI must never touch it — surface it loudly if it did) //
  const contact = { ...tailored.contact };
  (["name", "email", "phone", "location", "linkedin", "website"] as const).forEach((f) => {
    contact[f] = pick(`contact.${f}`, "contact", "", original.contact[f], tailored.contact[f]);
  });

  return {
    edits,
    resume: {
      contact,
      summary,
      skills,
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

/** Whether a fabrication flag's value lives inside this edit's new text. */
export function editContainsValue(edit: ResumeEdit, value: string): boolean {
  return !!edit.after && lkey(edit.after).includes(lkey(value));
}
