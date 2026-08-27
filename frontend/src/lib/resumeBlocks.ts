// Reading and writing one block of the résumé, addressed by the same path the
// document renders (`@exp.2`, `@skills.python`, `@proj.0.b.1`).
//
// THE DECISION THAT MAKES THIS SMALL: the editor edits an ENTRY, not a field.
// `ResumeView` fuses several model fields into one text node in three places —
// an experience meta line is title + company + location + two dates, education
// is six fields, the contact line is five — and splitting those back apart would
// mean parsing " · " / " | " / " – " joins in reverse, plus a `dir` on every
// inline fragment, which re-opens the bidi-isolate problem the view documents.
// But `@exp.2` already addresses `resume.experience[2]` unambiguously, so
// tapping that fused line can simply open a five-field form for that job. No
// splitting, no parse-back, and better on a phone: you get labelled fields
// instead of one ambiguous string.
//
// Pure: no React, no i18n, no network. Labels are i18n KEYS; the sheet resolves
// them, which is what lets `scripts/check-mirrors.js` pin that every key it can
// emit exists in both locales.
import type { Education, Experience, MilitaryService, Project, ResumeModel } from "../types";

/**
 * The block-path key function. ONE definition — `ResumeView` imports this
 * rather than declaring a twin, and check-mirrors pins that it stays single.
 * Two copies that drift mint a path the writer cannot resolve, and the symptom
 * is a sheet that opens empty on exactly the skill they disagree about.
 *
 * Deliberately `toLowerCase`, NOT the `toLocaleLowerCase` that `skillBlocksOf`
 * uses for its own (different) key: a Turkish-locale dotted İ would desync them.
 */
export const dkey = (s: string): string => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Every path shape the document emits; `*` stands for an index or a dkey.
 *
 * check-mirrors compares this against `ResumeView`'s own emit sites, because a
 * new section would otherwise ship a focusable, tappable block whose sheet is
 * empty — and paths are strings, so `tsc` has nothing to say about it.
 */
export const BLOCK_PATTERNS = [
  "@contact.name",
  "@contact",
  "@headline",
  "@summary",
  "@skills.*",
  "@cert.*",
  "@lang.*",
  "@exp.*",
  "@exp.*.b.*",
  "@proj.*",
  "@proj.*.b.*",
  "@edu.*",
  "@mil.*",
  "@mil.*.b.*",
] as const;

/** Sheet titles resolve as `tailor:edit.blocks.<kind>`, both locales, pinned. */
export type BlockKind =
  | "name"
  | "contact"
  | "headline"
  | "summary"
  | "skill"
  | "certification"
  | "language"
  | "experience"
  | "education"
  | "project"
  | "military"
  | "bullet";

/** Field labels resolve as `tailor:edit.fields.<key>`, both locales, pinned. */
export const BLOCK_FIELD_KEYS = [
  "name",
  "email",
  "phone",
  "location",
  "linkedin",
  "website",
  "headline",
  "summary",
  "skill",
  "certification",
  "language",
  "level",
  "title",
  "company",
  "startDate",
  "endDate",
  "institution",
  "degree",
  "field",
  "details",
  "projectName",
  "description",
  "unit",
  "role",
  "rank",
  "bullet",
] as const;
export type FieldKey = (typeof BLOCK_FIELD_KEYS)[number];

/**
 * `text` is a textarea and MUST carry an explicit min-height class at the call
 * site: `styles.css` gives every bare `<textarea>` `min-height: 220px`, which
 * would make a one-line bullet 220px tall. `date` is a plain text input on
 * purpose — the model stores dates exactly as written ("2021", "today",
 * "02/2026"), and a native date picker cannot represent those.
 */
export type FieldKind = "line" | "text" | "date";

export interface BlockField {
  key: FieldKey;
  kind: FieldKind;
  value: string;
}

export interface BlockDraft {
  path: string;
  kind: BlockKind;
  fields: BlockField[];
  /**
   * Whether this block can be deleted outright. True only for items that ARE a
   * single string (a skill, a certification, a bullet) or a small pair (a
   * language). It is not a bonus feature — both renderers draw a bullet glyph
   * for an empty list item, so there is no honest "blank bullet" to store, and
   * clearing the field has to mean removal.
   *
   * Since 23.2 an ENTRY is removable too — a job, a project, a degree, a
   * service — but by a different gesture: the panel's Remove button, because
   * there is no single field to clear. This flag stays FALSE for them so the
   * empty-means-remove rule on the inline path cannot reach an entry.
   */
  removable: boolean;
}

/**
 * The one field of a block that can be edited with a caret, or null.
 *
 * DERIVED from `readBlock`, never a hand-kept list. A block is inline-editable
 * exactly when it is ONE model field — the summary, a bullet, a skill, a
 * certification, the headline, the name. The rest fuse five or six facts into
 * one printed line ("Employer · Location · Dates"), and a caret in that line
 * has nothing to write back to: splitting it needs a `dir` per fragment, which
 * opens a bidi isolate and strands the separators.
 *
 * Because the split falls out of the reader, it cannot drift from it. Adding a
 * second field to a block automatically stops it being typed on; reducing one
 * to a single field automatically starts.
 */
export function inlineField(resume: ResumeModel, path: string): BlockField | null {
  const draft = readBlock(resume, path);
  return draft && draft.fields.length === 1 ? draft.fields[0] : null;
}

export type Values = Record<string, string>;

export type WriteResult =
  | {
      ok: true;
      resume: ResumeModel;
      /** Re-anchor the selection to this: a keyed rename MOVES its own path —
       * `@skills.python` stops existing the instant it becomes "Python 3". */
      path: string;
    }
  | { ok: false; reason: "unknown-path" | "not-found" };

const f = (key: FieldKey, value: string | undefined, kind: FieldKind = "line"): BlockField => ({
  key,
  kind,
  value: value ?? "",
});

/** Replace index `i`, or drop it when `next` is null. Never mutates. */
function splice1<T>(list: T[], i: number, next: T | null): T[] {
  const out = list.slice();
  if (next === null) out.splice(i, 1);
  else out[i] = next;
  return out;
}

const RE_BULLET = /^@(exp|proj|mil)\.(\d+)\.b\.(\d+)$/;
const RE_ENTRY = /^@(exp|proj|edu|mil)\.(\d+)$/;
// `(.+)` is greedy on purpose: a dkey keeps dots, so "@skills.node.js" and
// "@cert.aws certified solutions architect" are single whole keys.
const RE_KEYED = /^@(skills|cert|lang)\.(.+)$/;

const bulletsOf = (r: ResumeModel, kind: string, i: number): string[] | null => {
  const list =
    kind === "exp" ? r.experience[i] : kind === "proj" ? r.projects[i] : (r.military_service ?? [])[i];
  return list ? list.bullets : null;
};

// --------------------------------------------------------------------------- //
// Read
// --------------------------------------------------------------------------- //

/** The fields behind a block path, or null when the path no longer resolves —
 * which happens legitimately: an index shifts when an earlier item is removed. */
export function readBlock(resume: ResumeModel, path: string): BlockDraft | null {
  const c = resume.contact;

  if (path === "@contact.name") {
    return { path, kind: "name", removable: false, fields: [f("name", c.name)] };
  }
  if (path === "@contact") {
    return {
      path,
      kind: "contact",
      removable: false,
      fields: [
        f("email", c.email),
        f("phone", c.phone),
        f("location", c.location),
        f("linkedin", c.linkedin),
        f("website", c.website),
      ],
    };
  }
  if (path === "@headline") {
    return { path, kind: "headline", removable: false, fields: [f("headline", resume.headline)] };
  }
  if (path === "@summary") {
    return { path, kind: "summary", removable: false, fields: [f("summary", resume.summary, "text")] };
  }

  const bullet = RE_BULLET.exec(path);
  if (bullet) {
    const [, kind, ei, bi] = bullet;
    const bullets = bulletsOf(resume, kind, Number(ei));
    const value = bullets?.[Number(bi)];
    if (value === undefined) return null;
    return { path, kind: "bullet", removable: true, fields: [f("bullet", value, "text")] };
  }

  const entry = RE_ENTRY.exec(path);
  if (entry) {
    const [, kind, idx] = entry;
    const i = Number(idx);
    if (kind === "exp") {
      const e = resume.experience[i];
      if (!e) return null;
      return {
        path,
        kind: "experience",
        removable: false,
        fields: [
          f("title", e.title),
          f("company", e.company),
          f("location", e.location),
          f("startDate", e.start_date, "date"),
          f("endDate", e.end_date, "date"),
        ],
      };
    }
    if (kind === "proj") {
      const p = resume.projects[i];
      if (!p) return null;
      return {
        path,
        kind: "project",
        removable: false,
        fields: [f("projectName", p.name), f("description", p.description, "text")],
      };
    }
    if (kind === "edu") {
      const e = resume.education[i];
      if (!e) return null;
      return {
        path,
        kind: "education",
        removable: false,
        fields: [
          f("degree", e.degree),
          f("field", e.field),
          f("institution", e.institution),
          f("startDate", e.start_date, "date"),
          f("endDate", e.end_date, "date"),
          f("details", e.details, "text"),
        ],
      };
    }
    const m = (resume.military_service ?? [])[i];
    if (!m) return null;
    return {
      path,
      kind: "military",
      removable: false,
      fields: [
        f("role", m.role),
        f("unit", m.unit),
        f("rank", m.rank),
        f("startDate", m.start_date, "date"),
        f("endDate", m.end_date, "date"),
      ],
    };
  }

  const keyed = RE_KEYED.exec(path);
  if (keyed) {
    const [, kind, key] = keyed;
    if (kind === "skills") {
      const value = resume.skills.find((s) => dkey(s) === key);
      if (value === undefined) return null;
      return { path, kind: "skill", removable: true, fields: [f("skill", value)] };
    }
    if (kind === "cert") {
      const value = resume.certifications.find((s) => dkey(s) === key);
      if (value === undefined) return null;
      return { path, kind: "certification", removable: true, fields: [f("certification", value)] };
    }
    const lang = (resume.languages ?? []).find((l) => dkey(l.language) === key);
    if (!lang) return null;
    return {
      path,
      kind: "language",
      removable: true,
      fields: [f("language", lang.language), f("level", lang.level)],
    };
  }

  return null;
}

// --------------------------------------------------------------------------- //
// Write
// --------------------------------------------------------------------------- //

/**
 * A skill lives in TWO places and both must be written.
 *
 * `ResumeModel`'s validator keeps `skills` as the flat union of every group's
 * items and only ever ADDS — so renaming or removing a skill in `skill_groups`
 * alone leaves the old spelling in `skills`, and the next round trip puts it
 * straight back. The deletion silently does nothing. `length_budget` documents
 * the same trap on the backend side.
 */
function writeSkill(resume: ResumeModel, key: string, next: string | null): ResumeModel {
  const i = resume.skills.findIndex((s) => dkey(s) === key);
  if (i < 0) return resume;
  const skills = splice1(resume.skills, i, next);
  const groups = (resume.skill_groups ?? []).map((g) => {
    const j = g.items.findIndex((s) => dkey(s) === key);
    return j < 0 ? g : { ...g, items: splice1(g.items, j, next) };
  });
  // A group emptied by the removal would render as a labelled block with no
  // chips, so it goes too.
  const kept = groups.filter((g) => g.items.length > 0);
  return { ...resume, skills, ...(resume.skill_groups ? { skill_groups: kept } : {}) };
}

/**
 * Replace the flat skills list, pruning `skill_groups` to match.
 *
 * The bulk twin of `writeSkill`, and it exists for exactly the same reason.
 * Writing `skills` alone leaves every removed skill alive inside its group,
 * where `ResumeModel`'s validator -- which rebuilds `skills` as the flat union
 * and only ever ADDS -- puts it straight back on the next round trip. The
 * deletion shows a success toast and does nothing.
 *
 * Skills the caller ADDS are left ungrouped on purpose: nothing may be hidden,
 * and an unclaimed skill renders in the trailing unlabelled block.
 */
export function withSkills(resume: ResumeModel, skills: string[]): ResumeModel {
  const keep = new Set(skills.map((s) => dkey(s)));
  const groups = (resume.skill_groups ?? [])
    .map((g) => ({ ...g, items: g.items.filter((s) => keep.has(dkey(s))) }))
    .filter((g) => g.items.length > 0);
  return { ...resume, skills, ...(resume.skill_groups ? { skill_groups: groups } : {}) };
}

const clean = (v: string | undefined) => (v ?? "").trim();

/** Apply the sheet's collected values to one block. */
export function writeBlock(resume: ResumeModel, path: string, values: Values): WriteResult {
  const notFound = { ok: false, reason: "not-found" } as const;

  if (path === "@contact.name") {
    return { ok: true, path, resume: { ...resume, contact: { ...resume.contact, name: clean(values.name) } } };
  }
  if (path === "@contact") {
    return {
      ok: true,
      path,
      resume: {
        ...resume,
        contact: {
          ...resume.contact,
          email: clean(values.email),
          phone: clean(values.phone),
          location: clean(values.location),
          linkedin: clean(values.linkedin),
          website: clean(values.website),
        },
      },
    };
  }
  if (path === "@headline") {
    return { ok: true, path, resume: { ...resume, headline: clean(values.headline) } };
  }
  if (path === "@summary") {
    return { ok: true, path, resume: { ...resume, summary: clean(values.summary) } };
  }

  const bullet = RE_BULLET.exec(path);
  if (bullet) {
    const [, kind, ei, bi] = bullet;
    const i = Number(ei);
    const j = Number(bi);
    const text = clean(values.bullet);
    // An empty bullet still draws its glyph in both renderers, so clearing it
    // means removing it rather than storing a blank line.
    if (!text) return removeBlock(resume, path);
    const bullets = bulletsOf(resume, kind, i);
    if (!bullets || bullets[j] === undefined) return notFound;
    const next = splice1(bullets, j, text);
    if (kind === "exp") {
      return { ok: true, path, resume: { ...resume, experience: splice1(resume.experience, i, { ...resume.experience[i], bullets: next }) } };
    }
    if (kind === "proj") {
      return { ok: true, path, resume: { ...resume, projects: splice1(resume.projects, i, { ...resume.projects[i], bullets: next }) } };
    }
    const mil = resume.military_service ?? [];
    return { ok: true, path, resume: { ...resume, military_service: splice1(mil, i, { ...mil[i], bullets: next }) } };
  }

  const entry = RE_ENTRY.exec(path);
  if (entry) {
    const [, kind, idx] = entry;
    const i = Number(idx);
    if (kind === "exp") {
      const e = resume.experience[i];
      if (!e) return notFound;
      const next: Experience = {
        ...e,
        title: clean(values.title),
        company: clean(values.company),
        location: clean(values.location),
        start_date: clean(values.startDate),
        end_date: clean(values.endDate),
      };
      return { ok: true, path, resume: { ...resume, experience: splice1(resume.experience, i, next) } };
    }
    if (kind === "proj") {
      const p = resume.projects[i];
      if (!p) return notFound;
      const next: Project = { ...p, name: clean(values.projectName), description: clean(values.description) };
      return { ok: true, path, resume: { ...resume, projects: splice1(resume.projects, i, next) } };
    }
    if (kind === "edu") {
      const e = resume.education[i];
      if (!e) return notFound;
      const next: Education = {
        ...e,
        degree: clean(values.degree),
        field: clean(values.field),
        institution: clean(values.institution),
        start_date: clean(values.startDate),
        end_date: clean(values.endDate),
        details: clean(values.details),
      };
      return { ok: true, path, resume: { ...resume, education: splice1(resume.education, i, next) } };
    }
    const mil = resume.military_service ?? [];
    const m = mil[i];
    if (!m) return notFound;
    const next: MilitaryService = {
      ...m,
      role: clean(values.role),
      unit: clean(values.unit),
      rank: clean(values.rank),
      start_date: clean(values.startDate),
      end_date: clean(values.endDate),
    };
    return { ok: true, path, resume: { ...resume, military_service: splice1(mil, i, next) } };
  }

  const keyed = RE_KEYED.exec(path);
  if (keyed) {
    const [, kind, key] = keyed;
    if (kind === "skills") {
      const text = clean(values.skill);
      if (!text) return removeBlock(resume, path);
      if (!resume.skills.some((s) => dkey(s) === key)) return notFound;
      // The path is derived from the VALUE, so a rename moves it.
      return { ok: true, path: `@skills.${dkey(text)}`, resume: writeSkill(resume, key, text) };
    }
    if (kind === "cert") {
      const text = clean(values.certification);
      if (!text) return removeBlock(resume, path);
      const i = resume.certifications.findIndex((s) => dkey(s) === key);
      if (i < 0) return notFound;
      return {
        ok: true,
        path: `@cert.${dkey(text)}`,
        resume: { ...resume, certifications: splice1(resume.certifications, i, text) },
      };
    }
    const langs = resume.languages ?? [];
    const i = langs.findIndex((l) => dkey(l.language) === key);
    if (i < 0) return notFound;
    const name = clean(values.language);
    if (!name) return removeBlock(resume, path);
    return {
      ok: true,
      path: `@lang.${dkey(name)}`,
      resume: { ...resume, languages: splice1(langs, i, { language: name, level: clean(values.level) }) },
    };
  }

  return { ok: false, reason: "unknown-path" };
}

/** Delete the item a block addresses. Only ever called for `removable` blocks. */
/** What the foot control can add. Fixed and ordered — the list never changes
 * shape between visits, so creating the FIRST project and the fourth are the
 * same action and the user never learns a distinction that does not exist. */
export const INSERT_KINDS = [
  "experience",
  "project",
  "education",
  "military",
  "skill",
  "certification",
  "language",
] as const;
export type InsertKind = (typeof INSERT_KINDS)[number];

/**
 * Add an empty thing and return the path that now addresses it.
 *
 * Empty, not placeholder-filled: a placeholder is a fabricated claim the moment
 * it reaches a renderer, and this codebase already refuses to print
 * "School or University" into a downloaded file. The caller focuses the
 * returned path — a caret for the single-field kinds, the panel for the
 * compound ones — and an insert the user abandons is cleared by the
 * empty-means-remove rule in `removeBlock`'s callers rather than by a
 * pending-state machine here.
 *
 * APPENDS, never inserts mid-list. Every existing path stays valid, so an open
 * editor cannot have an index shift out from under it — the failure `onGone`
 * exists for.
 */
export function insertBlock(resume: ResumeModel, kind: InsertKind): WriteResult {
  switch (kind) {
    case "experience": {
      const list = [...resume.experience, { company: "", title: "", location: "", start_date: "", end_date: "", bullets: [] }];
      return { ok: true, path: `@exp.${list.length - 1}`, resume: { ...resume, experience: list } };
    }
    case "project": {
      const list = [...resume.projects, { name: "", description: "", bullets: [] }];
      return { ok: true, path: `@proj.${list.length - 1}`, resume: { ...resume, projects: list } };
    }
    case "education": {
      const list = [...resume.education, { institution: "", degree: "", field: "", start_date: "", end_date: "", details: "" }];
      return { ok: true, path: `@edu.${list.length - 1}`, resume: { ...resume, education: list } };
    }
    case "military": {
      const list = [...(resume.military_service ?? []), { unit: "", role: "", rank: "", start_date: "", end_date: "", bullets: [] }];
      return { ok: true, path: `@mil.${list.length - 1}`, resume: { ...resume, military_service: list } };
    }
    case "skill": {
      // ONE field only. The flat `skills` list is what every scorer reads, and
      // a new skill belongs to no group — `skillBlocksOf` renders it in the
      // trailing unlabelled block, because nothing may be hidden.
      const name = uniqueName(resume.skills, "New skill");
      return { ok: true, path: `@skills.${dkey(name)}`, resume: { ...resume, skills: [...resume.skills, name] } };
    }
    case "certification": {
      const name = uniqueName(resume.certifications, "New certification");
      return { ok: true, path: `@cert.${dkey(name)}`, resume: { ...resume, certifications: [...resume.certifications, name] } };
    }
    case "language": {
      const list = resume.languages ?? [];
      const name = uniqueName(list.map((l) => l.language), "New language");
      return { ok: true, path: `@lang.${dkey(name)}`, resume: { ...resume, languages: [...list, { language: name, level: "" }] } };
    }
  }
}

/** Add a bullet to an existing entry, returning the new bullet's path. */
export function insertBullet(resume: ResumeModel, entryPath: string): WriteResult {
  const entry = RE_ENTRY.exec(entryPath);
  if (!entry) return { ok: false, reason: "unknown-path" };
  const [, kind, idx] = entry;
  const i = Number(idx);
  const bullets = bulletsOf(resume, kind, i);
  if (!bullets) return { ok: false, reason: "not-found" };
  const next = [...bullets, ""];
  const path = `@${kind}.${i}.b.${next.length - 1}`;
  if (kind === "exp") {
    return { ok: true, path, resume: { ...resume, experience: splice1(resume.experience, i, { ...resume.experience[i], bullets: next }) } };
  }
  if (kind === "proj") {
    return { ok: true, path, resume: { ...resume, projects: splice1(resume.projects, i, { ...resume.projects[i], bullets: next }) } };
  }
  const mil = resume.military_service ?? [];
  return { ok: true, path, resume: { ...resume, military_service: splice1(mil, i, { ...mil[i], bullets: next }) } };
}

/** A keyed block IS its own text, so a new one needs a name that does not
 * collide — two items sharing a `dkey` would share a `data-block`. */
function uniqueName(existing: string[], base: string): string {
  const taken = new Set(existing.map((x) => dkey(x)));
  if (!taken.has(dkey(base))) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(dkey(candidate))) return candidate;
  }
}

export function removeBlock(resume: ResumeModel, path: string): WriteResult {
  const notFound = { ok: false, reason: "not-found" } as const;

  const bullet = RE_BULLET.exec(path);
  if (bullet) {
    const [, kind, ei, bi] = bullet;
    const i = Number(ei);
    const j = Number(bi);
    const bullets = bulletsOf(resume, kind, i);
    if (!bullets || bullets[j] === undefined) return notFound;
    const next = splice1(bullets, j, null);
    if (kind === "exp") {
      return { ok: true, path, resume: { ...resume, experience: splice1(resume.experience, i, { ...resume.experience[i], bullets: next }) } };
    }
    if (kind === "proj") {
      return { ok: true, path, resume: { ...resume, projects: splice1(resume.projects, i, { ...resume.projects[i], bullets: next }) } };
    }
    const mil = resume.military_service ?? [];
    return { ok: true, path, resume: { ...resume, military_service: splice1(mil, i, { ...mil[i], bullets: next }) } };
  }

  // A WHOLE ENTRY. This fell through to `unknown-path` until 23.2, so a job, a
  // project, a degree or a service could not be removed from the document at
  // all — the panel's trash was gated on a `removable` flag that is false for
  // every one of them. The add control made the gap unmissable: create an
  // entry, cancel the form, and the blank stayed on the paper forever.
  const entryPath = RE_ENTRY.exec(path);
  if (entryPath) {
    const [, ekind, eidx] = entryPath;
    const ei = Number(eidx);
    if (ekind === "exp") {
      if (!resume.experience[ei]) return notFound;
      return { ok: true, path, resume: { ...resume, experience: splice1(resume.experience, ei, null) } };
    }
    if (ekind === "proj") {
      if (!resume.projects[ei]) return notFound;
      return { ok: true, path, resume: { ...resume, projects: splice1(resume.projects, ei, null) } };
    }
    if (ekind === "edu") {
      if (!resume.education[ei]) return notFound;
      return { ok: true, path, resume: { ...resume, education: splice1(resume.education, ei, null) } };
    }
    const milList = resume.military_service ?? [];
    if (!milList[ei]) return notFound;
    return { ok: true, path, resume: { ...resume, military_service: splice1(milList, ei, null) } };
  }

  const keyed = RE_KEYED.exec(path);
  if (keyed) {
    const [, kind, key] = keyed;
    if (kind === "skills") {
      if (!resume.skills.some((s) => dkey(s) === key)) return notFound;
      return { ok: true, path, resume: writeSkill(resume, key, null) };
    }
    if (kind === "cert") {
      const i = resume.certifications.findIndex((s) => dkey(s) === key);
      if (i < 0) return notFound;
      return { ok: true, path, resume: { ...resume, certifications: splice1(resume.certifications, i, null) } };
    }
    const langs = resume.languages ?? [];
    const i = langs.findIndex((l) => dkey(l.language) === key);
    if (i < 0) return notFound;
    return { ok: true, path, resume: { ...resume, languages: splice1(langs, i, null) } };
  }

  return { ok: false, reason: "unknown-path" };
}
