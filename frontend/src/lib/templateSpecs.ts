import type { ResumeTemplate } from "../api/client";

/**
 * The frontend's ONE mirror of `backend/app/render/templates.py::TemplateSpec`.
 *
 * Three surfaces have to know what a template looks like before the backend
 * renders anything — the landing's miniatures, the picker's thumbnails and the
 * document on `/app` — and each of them used to carry its own hand-copy. They
 * had already drifted: this table's own `classic` said skills were an inline
 * comma run while templates.py says chips, and TemplateThumb's `modern` band
 * meta was #9EC4B8 against `band_meta="9CC6B9"`. A preview that lies about the
 * download is worse than no preview on a product whose whole pitch is that the
 * two agree.
 *
 * check-mirrors 23 compares every field below against the effective value
 * parsed out of templates.py — dataclass defaults folded under each template's
 * overrides — for all eleven ids, so a change there fails the frontend build
 * until this file follows it.
 *
 * TWO DELIBERATE DIFFERENCES from the Python, both mechanical and both handled
 * by the check:
 *   - colours carry a leading "#", because these are CSS/SVG values and
 *     templates.py stores them bare. The comparator normalises.
 *   - `serif` is DERIVED from `pdf_family` (Spectral is the only serif face in
 *     the bundled set). The exact face cannot be reproduced on screen at all —
 *     fonts.css ships Inter + Heebo and nothing else, and Lato and Spectral are
 *     PDF-EMBEDDED, not web-loaded — so a surface drawing from this table
 *     reproduces the serif/sans CATEGORY and leaves the face to the file.
 *
 * Everything else is field for field, INCLUDING the defaults: this table's
 * defaults are the dataclass's defaults, so a template that stays silent about
 * a field in Python stays silent about it here and the two "effective value"
 * calculations cannot disagree. That is not cosmetic — `entry` defaults to
 * "split" and `list_cols` to 1 in the dataclass while nine templates and eleven
 * templates respectively override them, so a mirror with its own defaults would
 * be wrong on exactly the fields nobody wrote down.
 *
 * Deliberately NOT mirrored: the font families themselves, page size, and `id`
 * (the key is the id).
 */
export interface TemplateSpec {
  /* --- palette (CSS hex; templates.py stores these without the "#") ------- */
  /** Section headings + employer/institution names. The one field with no
   *  Python default — every template must state its own. */
  accent: string;
  ink: string;
  muted: string;
  /** Hairlines under the header and section headings. */
  rule: string;
  /** A tint of the accent, for chip fills and the sidebar panel. */
  accentSoft: string;

  /* --- type + page, in points, straight from TemplateSpec ---------------- */
  /** margin_lr_pt. */
  mx: number;
  /** margin_tb_pt. */
  my: number;
  /** body_size. */
  body: number;
  /** heading_size. */
  head: number;
  /** name_size. */
  name: number;
  /** meta_size. */
  meta: number;
  /** heading_tracking, pt. */
  tracking: number;
  /** name_tracking, pt — negative on every template; names are set tight. */
  nameTracking: number;
  nameCentered: boolean;
  /** page_w_pt. Eleven templates are A4; `standard` is US Letter, because the
   *  document it reproduces is. Only the "short" heading mark reads it — its
   *  width is a SHARE of the text column — but it is mirrored rather than
   *  hard-coded so that claim cannot quietly stop being true. */
  pageW: number;
  /** leading_ratio: the body line height as a multiple of `body`. 0 = the
   *  tight/normal rule both renderers apply (1.26 when `tight`, else 1.36). */
  leadingRatio: number;
  /** rhythm, pt: [section-before, section-after, entry-before, bullet-after,
   *  heading-to-its-rule, header-after]. [] = the renderers' own constants; a
   *  SHORTER array states only its leading elements. */
  rhythm: readonly number[];
  /** name_color; "" = `ink`. */
  nameColor: string;
  /** The target-title line under the name. `headlineSize` 0 = the derived size
   *  (body + 1.2 on a band, + 0.8 otherwise); `headlineColor` "" = `accent`. */
  headlineBold: boolean;
  headlineColor: string;
  headlineSize: number;
  headlineTracking: number;
  /** Which contact details the header prints, in order. [] = the built-in
   *  email, phone, location, linkedin, website. */
  contactOrder: readonly string[];
  /** DERIVED from pdf_family: true where the bundled Latin face is a serif. */
  serif: boolean;
  /** Compact vertical rhythm (the Israeli one-pager convention). */
  tight: boolean;

  /* --- header ------------------------------------------------------------ */
  /** AUTHORITATIVE in both renderers: the only thing either asks about the
   *  header hairline. "plain" draws none. */
  header: "rule" | "plain" | "band";
  headerRulePt: number;
  headerRuleAccent: boolean;
  /** Band fill; "" means use `accent` — see `bandFill`. */
  bandBg: string;
  bandInk: string;
  bandSub: string;
  bandMeta: string;

  /* --- section headings --------------------------------------------------- */
  heading: "rule" | "short" | "bar" | "plain" | "hung" | "centered";
  headingBarW: number;
  /** Added to `head`. */
  headingBump: number;
  headingRulePt: number;
  /** "" means the `rule` hairline colour — see `headingRuleFill`. */
  headingRuleColor: string;
  /** Width of the "short" underline. */
  headingShortPt: number;
  /** How far a "hung" heading sits out into the start margin. */
  headingHangPt: number;
  /** A no-op in Hebrew either way — both renderers branch on direction first. */
  headingCase: "upper" | "title";
  /** Which set of section names this template prints — see
   *  `backend/app/render/labels.py`. "short" is the standard one; "full" is the
   *  longer business wording ("Professional Summary", "Core Expertise"). */
  labelSet: "short" | "full";
  /** The inline separator between the parts of the contact line, an entry's
   *  meta run and the languages line. "" = each site's own default, which is
   *  not one string. */
  metaSep: string;
  /** The separator's colour; "" = the mix of `muted` and `rule` both renderers
   *  compute. */
  sepColor: string;

  /* --- body grammar ------------------------------------------------------- */
  entry: "split" | "stack" | "run";
  skills: "inline" | "chips" | "labeled";
  /** A project's description paragraph. `descSize` 0 = `body`. */
  descSize: number;
  descIndentPt: number;
  /** Certifications / languages in N columns. Capped at 2. */
  listCols: 1 | 2;
  bulletGlyph: string;
  bulletScale: number;
  bulletAccent: boolean;
  /** A vertical hairline down the entries, with a dot per role in the PDF. */
  rail: boolean;

  /* --- two-column (PDF only) ---------------------------------------------- */
  layout: "single" | "sidebar";
  sidebarRatio: number;
  sidebarGutter: number;
  sidebarPanel: boolean;
  sidebarKeys: readonly string[];
  /** Template id the DOCX renders instead; "" = render as-is. */
  docxFallback: string;

  /* --- PDF-only ornament -------------------------------------------------- */
  // Each of these carries no text and its absence changes nothing the document
  // SAYS, which is the whole reason the DOCX is allowed to omit them (21.8).
  // A surface drawing from this table may take the same carve-out.
  contactIcons: boolean;
  dateIcon: boolean;
  /** A full-bleed paper tint; "" = white. */
  pageBg: string;
  /** The candidate's name at the foot of every page. PDF ONLY, and NOT an
   *  ornament carve-out — it carries text, so the Word file genuinely says one
   *  thing less. A deliberate, user-made divergence; see `footer_name` in
   *  templates.py. This surface draws none either: the document on screen is
   *  one continuous sheet with no page boundaries to foot. */
  footerName: boolean;
  footerSize: number;
  footerColor: string;
}

/**
 * The dataclass's own defaults, so "what does this template actually render
 * with" is computed the same way on both sides. `accent` is the one field with
 * no default in Python, which is why it is the one field omitted here.
 */
export const TEMPLATE_SPEC_DEFAULTS: Omit<TemplateSpec, "accent"> = {
  ink: "#1A1A1A",
  muted: "#5C6470",
  rule: "#D5D9E0",
  accentSoft: "",
  mx: 54,
  my: 46,
  body: 10.2,
  head: 9.5,
  name: 22,
  meta: 9,
  tracking: 1,
  nameTracking: 1,
  nameCentered: true,
  pageW: 595.276,
  leadingRatio: 0,
  rhythm: [],
  nameColor: "",
  headlineBold: false,
  headlineColor: "",
  headlineSize: 0,
  headlineTracking: 0.3,
  contactOrder: [],
  serif: false,
  tight: false,
  header: "rule",
  headerRulePt: 0.8,
  headerRuleAccent: false,
  bandBg: "",
  bandInk: "#FFFFFF",
  bandSub: "#D6E2EE",
  bandMeta: "#A9BED2",
  heading: "rule",
  headingBarW: 3,
  headingBump: 0,
  headingRulePt: 0.6,
  headingRuleColor: "",
  headingShortPt: 32,
  headingHangPt: 44,
  headingCase: "upper",
  labelSet: "short",
  metaSep: "",
  sepColor: "",
  entry: "split",
  skills: "inline",
  descSize: 0,
  descIndentPt: 0,
  listCols: 1,
  bulletGlyph: "•",
  bulletScale: 1,
  bulletAccent: false,
  rail: false,
  layout: "single",
  sidebarRatio: 0.32,
  sidebarGutter: 20,
  sidebarPanel: false,
  sidebarKeys: ["skills", "education", "certifications", "languages"],
  docxFallback: "",
  contactIcons: false,
  dateIcon: false,
  pageBg: "",
  footerName: false,
  footerSize: 7.5,
  footerColor: "#787878",
};

const D = TEMPLATE_SPEC_DEFAULTS;

/**
 * Twelve templates, in the picker's display order (`RESUME_TEMPLATES` in
 * api/client.ts). Each entry states exactly what its Python twin overrides and
 * nothing else, so the two tables read side by side.
 */
export const TEMPLATE_SPECS: Record<ResumeTemplate, TemplateSpec> = {
  // The DEFAULT since 2026-09-06, and the one entry here that mirrors a
  // REPRODUCTION rather than a design: every number came off a real document.
  // `pdf_family` is base-14 Helvetica, which is a sans, so `serif` stays false —
  // and the face itself is the file's, exactly as it is for Lato and Spectral.
  standard: {
    ...D, accent: "#232323", ink: "#000000", muted: "#000000", rule: "#A8A8A8", accentSoft: "#F0F0F0",
    mx: 40.3, my: 36, body: 9.0, head: 10.0, name: 19, meta: 8.5, tracking: 0, nameTracking: 0,
    pageW: 612, leadingRatio: 1.167, rhythm: [6.3, 5.9, 4.3, 1.7, 0, 0],
    nameColor: "#191919",
    headlineBold: true, headlineColor: "#414141", headlineSize: 10.5, headlineTracking: 0,
    contactOrder: ["location", "phone", "email", "linkedin", "website"],
    header: "plain",
    heading: "rule", headingRulePt: 0.75, headingRuleColor: "#A8A8A8",
    labelSet: "full", metaSep: "  |  ", sepColor: "#000000",
    entry: "run", skills: "labeled", listCols: 1,
    descSize: 8.5, descIndentPt: 8.65,
    footerName: true,
  },
  classic: {
    ...D, accent: "#1F3A5F", ink: "#111827", muted: "#5C6470", rule: "#DFE3E9", accentSoft: "#E9EEF4",
    mx: 58, my: 46, body: 10.4, head: 11.0, name: 27, meta: 8.8, tracking: 0.8, nameTracking: -0.3,
    nameCentered: false,
    header: "band", bandBg: "#EDF1F6", bandInk: "#14243A", bandSub: "#1F3A5F", bandMeta: "#4A5A72",
    heading: "rule", headingRulePt: 0.5,
    entry: "stack", skills: "chips", listCols: 2,
    bulletScale: 0.62, bulletAccent: true,
    contactIcons: true, dateIcon: true,
  },
  modern: {
    ...D, accent: "#0E7A5F", ink: "#14181F", muted: "#59616E", rule: "#D9E2DE", accentSoft: "#E4F1EC",
    mx: 58, my: 46, body: 10.4, head: 11.0, name: 28, meta: 8.8, tracking: 0.8, nameTracking: -0.4,
    nameCentered: false,
    header: "band", bandBg: "#0B5344", bandInk: "#FFFFFF", bandSub: "#BFDDD2", bandMeta: "#9CC6B9",
    heading: "short", headingRulePt: 1.4, headingRuleColor: "#0E7A5F", headingShortPt: 32,
    entry: "stack", skills: "chips", listCols: 2,
    bulletScale: 0.62, bulletAccent: true,
    contactIcons: true, dateIcon: true,
  },
  split: {
    ...D, accent: "#15476B", ink: "#111827", muted: "#59616E", rule: "#DCE2E8", accentSoft: "#E7EEF4",
    mx: 48, my: 44, body: 10.1, head: 10.8, name: 27, meta: 8.6, tracking: 0.7, nameTracking: -0.3,
    nameCentered: false,
    header: "band", bandBg: "#EBF0F5", bandInk: "#10283D", bandSub: "#15476B", bandMeta: "#4C5F73",
    heading: "short", headingRulePt: 1.3, headingRuleColor: "#15476B", headingShortPt: 26,
    entry: "stack", skills: "chips", listCols: 1,
    bulletScale: 0.6, bulletAccent: true,
    contactIcons: true,
    layout: "sidebar", sidebarRatio: 0.31, sidebarGutter: 20, docxFallback: "classic",
  },
  panel: {
    ...D, accent: "#15476B", ink: "#111827", muted: "#59616E", rule: "#C3D4E1", accentSoft: "#DCE8F1",
    mx: 48, my: 44, body: 10.1, head: 10.6, name: 27, meta: 8.6, tracking: 0.7, nameTracking: -0.3,
    nameCentered: false,
    header: "band", bandBg: "#123C5C", bandInk: "#FFFFFF", bandSub: "#BBD3E4", bandMeta: "#94B2C9",
    heading: "bar", headingBump: 0.6, headingBarW: 2.6,
    entry: "stack", skills: "chips", listCols: 1,
    bulletScale: 0.6, bulletAccent: true,
    contactIcons: true,
    layout: "sidebar", sidebarRatio: 0.3, sidebarGutter: 22, sidebarPanel: true, docxFallback: "modern",
  },
  timeline: {
    ...D, accent: "#2A5D7C", ink: "#121821", muted: "#5A626E", rule: "#D9E0E6", accentSoft: "#E8EFF4",
    mx: 56, my: 46, body: 10.3, head: 11.0, name: 27, meta: 8.6, tracking: 0.9, nameTracking: -0.3,
    nameCentered: false,
    header: "rule", headerRulePt: 1.6, headerRuleAccent: true,
    heading: "plain",
    entry: "stack", rail: true, skills: "inline", listCols: 2,
    bulletScale: 0.6, bulletAccent: true,
  },
  executive: {
    ...D, accent: "#16304B", ink: "#1B1B18", muted: "#5A5F6A", rule: "#D8D0C2", accentSoft: "#EFE9DE",
    mx: 70, my: 54, body: 10.4, head: 11.4, name: 29, meta: 8.8, tracking: 0.4, nameTracking: -0.2,
    nameCentered: true, serif: true,
    header: "rule", headerRulePt: 1.5,
    heading: "plain", headingCase: "title",
    entry: "split", skills: "inline", listCols: 2,
    bulletGlyph: "—", bulletScale: 0.58,
    pageBg: "#FDFBF4",
  },
  ivy: {
    ...D, accent: "#1B2430", ink: "#121820", muted: "#6A717B", rule: "#C9CED6", accentSoft: "#ECEEF1",
    mx: 64, my: 50, body: 10.3, head: 11.6, name: 26, meta: 8.8, tracking: 0.3, nameTracking: -0.2,
    nameCentered: true, serif: true,
    header: "plain",
    heading: "centered", headingCase: "title", headingRulePt: 0.6,
    entry: "split", skills: "inline", listCols: 2,
    bulletScale: 0.58,
  },
  ledger: {
    ...D, accent: "#B4451F", ink: "#151515", muted: "#6A6A6A", rule: "#D8D8D8", accentSoft: "#F6E9E2",
    mx: 50, my: 42, body: 10.0, head: 11.2, name: 26, meta: 8.6, tracking: 0.6, nameTracking: -0.2,
    nameCentered: false,
    header: "rule", headerRulePt: 2.0, headerRuleAccent: true,
    heading: "rule", headingRulePt: 2.0, headingRuleColor: "#1A1A1A",
    entry: "stack", skills: "chips", listCols: 2,
    bulletScale: 0.55, bulletAccent: true,
  },
  student: {
    ...D, accent: "#2E6B4F", ink: "#121A16", muted: "#5B6560", rule: "#D9E4DD", accentSoft: "#E8F1EC",
    mx: 62, my: 50, body: 10.6, head: 11.2, name: 27, meta: 8.8, tracking: 0.8, nameTracking: -0.3,
    nameCentered: false,
    header: "band", bandBg: "#E8F1EC", bandInk: "#14301F", bandSub: "#2E6B4F", bandMeta: "#47604F",
    heading: "short", headingRulePt: 1.4, headingRuleColor: "#2E6B4F", headingShortPt: 30,
    entry: "stack", skills: "chips", listCols: 2,
    bulletScale: 0.62, bulletAccent: true,
    contactIcons: true, dateIcon: true,
  },
  compact: {
    ...D, accent: "#27405C", ink: "#141922", muted: "#5A626E", rule: "#DCE0E6", accentSoft: "#E7ECF2",
    mx: 46, my: 34, body: 9.9, head: 10.4, name: 22, meta: 8.4, tracking: 0.6, nameTracking: -0.2,
    nameCentered: false,
    header: "rule", headerRulePt: 1.6, headerRuleAccent: true,
    heading: "bar", headingBarW: 2.4,
    entry: "stack", skills: "inline", listCols: 2,
    bulletScale: 0.58, bulletAccent: true,
    tight: true,
  },
  minimal: {
    ...D, accent: "#374151", ink: "#111827", muted: "#6B7280", rule: "#E4E7EB", accentSoft: "#EDEFF2",
    mx: 84, my: 54, body: 10.6, head: 10.6, name: 30, meta: 8.8, tracking: 1.0, nameTracking: -0.5,
    nameCentered: false,
    header: "plain",
    heading: "hung", headingHangPt: 58,
    entry: "stack", skills: "inline", listCols: 2,
    bulletGlyph: "–", bulletScale: 0.8,
  },
};

/**
 * Every template id, in the picker's display order.
 *
 * Derived from the table rather than hand-listed, and NOT re-exported from
 * `api/client`: `AccessGate` aside, the landing must not pull axios and every
 * typed endpoint wrapper into the marketing chunk to draw eleven thumbnails
 * (see the note on `lib/accessCode.ts`). `ResumeTemplate` is a TYPE import
 * here, so nothing at runtime crosses that line.
 */
export const TEMPLATE_IDS = Object.keys(TEMPLATE_SPECS) as ResumeTemplate[];

/** `TemplateSpec.pdf_only` — the sidebar renders in the PDF only, and the DOCX
 *  falls back to the single-column sibling named by `docxFallback`. */
export const PDF_ONLY = (id: ResumeTemplate): boolean => TEMPLATE_SPECS[id].layout !== "single";

/** `TemplateSpec.band_fill`. */
export const bandFill = (s: TemplateSpec): string => s.bandBg || s.accent;

/** `TemplateSpec.head_rule_fill`. A "short" heading's underline IS the accent
 *  mark, so it falls back to the accent rather than to the hairline colour. */
export const headingRuleFill = (s: TemplateSpec): string =>
  s.headingRuleColor || (s.heading === "short" ? s.accent : s.rule);
