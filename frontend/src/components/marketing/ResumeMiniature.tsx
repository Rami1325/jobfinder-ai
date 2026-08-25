import { useMemo, type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";

/**
 * Hand-drawn résumé thumbnails — the landing's most important asset.
 *
 * The competitor shows real documents on every screen and we showed none, so
 * the page now leads with the thing we actually sell: a rendered A4 page.
 *
 * These are inline SVG, not images: the app must stay self-contained (no
 * network requests, nothing to 404, no build step to keep in sync), and
 * vectors stay crisp at any thumbnail size.
 *
 * They are also HONEST miniatures, not decoration. Every geometric fact in
 * SPECS below — page size, margins, type sizes, palette, header treatment,
 * heading treatment, entry grammar, column count, bullet glyph — is
 * transcribed from the real `TemplateSpec` values in
 * `backend/app/render/templates.py`. When a template changes there, or one is
 * added, update SPECS to match: a thumbnail that lies about the download is
 * worse than no thumbnail on a page whose entire pitch is honesty.
 *
 * A small layout engine walks down the page emitting "text" as runs of word
 * blocks (real text reads as words with gaps, not as solid bars) and keeps
 * emitting roles until the page is full, so every template renders as a
 * complete page and the dense ones visibly fit more.
 */

export type MiniatureTemplate =
  | "classic"
  | "modern"
  | "split"
  | "panel"
  | "timeline"
  | "executive"
  | "ivy"
  | "ledger"
  | "student"
  | "compact"
  | "minimal";

/** Same ids and same order as `RESUME_TEMPLATES` in api/client.ts. */
export const MINIATURE_TEMPLATES: readonly MiniatureTemplate[] = [
  "classic",
  "modern",
  "split",
  "panel",
  "timeline",
  "executive",
  "ivy",
  "ledger",
  "student",
  "compact",
  "minimal",
] as const;

/** Templates whose sidebar is PDF-only (the DOCX renders a single-column sibling). */
export const PDF_ONLY_TEMPLATES: readonly MiniatureTemplate[] = ["split", "panel"] as const;

interface Spec {
  accent: string;
  ink: string;
  muted: string;
  rule: string;
  accentSoft: string;
  /** Points, straight from TemplateSpec. */
  mx: number;
  my: number;
  body: number;
  head: number;
  name: number;
  meta: number;
  nameCentered: boolean;
  tracking: number;
  header: "rule" | "plain" | "band";
  headerRulePt: number;
  headerRuleAccent: boolean;
  bandBg?: string;
  bandInk?: string;
  bandSub?: string;
  bandMeta?: string;
  heading: "rule" | "short" | "bar" | "plain" | "hung" | "centered";
  headingRulePt: number;
  headingRuleColor?: string;
  headingShortPt: number;
  headingBarW: number;
  headingHangPt: number;
  headingCase: "upper" | "title";
  entry: "split" | "stack";
  skills: "inline" | "chips";
  listCols: 1 | 2;
  layout: "single" | "sidebar";
  sidebarRatio: number;
  sidebarGutter: number;
  sidebarPanel: boolean;
  rail: boolean;
  bullet: "dot" | "dash";
  bulletAccent: boolean;
  pageBg: string;
  tight: boolean;
}

const A4_W = 596;
const A4_H = 842;

const BASE = {
  headerRulePt: 0.8,
  headerRuleAccent: false,
  headingRulePt: 0.6,
  headingShortPt: 32,
  headingBarW: 3,
  headingHangPt: 44,
  headingCase: "upper",
  entry: "stack",
  skills: "inline",
  listCols: 2,
  layout: "single",
  sidebarRatio: 0.31,
  sidebarGutter: 20,
  sidebarPanel: false,
  rail: false,
  bullet: "dot",
  bulletAccent: false,
  pageBg: "#ffffff",
  tight: false,
  nameCentered: false,
} as const;

const SPECS: Record<MiniatureTemplate, Spec> = {
  classic: {
    ...BASE, accent: "#1F3A5F", ink: "#111827", muted: "#5C6470", rule: "#DFE3E9", accentSoft: "#E9EEF4",
    mx: 58, my: 46, body: 10.4, head: 11.0, name: 27, meta: 8.8, tracking: 0.8,
    header: "band", bandBg: "#EDF1F6", bandInk: "#14243A", bandSub: "#1F3A5F", bandMeta: "#4A5A72",
    heading: "rule", headingRulePt: 0.5, listCols: 2, bulletAccent: true,
  },
  modern: {
    ...BASE, accent: "#0E7A5F", ink: "#14181F", muted: "#59616E", rule: "#D9E2DE", accentSoft: "#E4F1EC",
    mx: 58, my: 46, body: 10.4, head: 11.0, name: 28, meta: 8.8, tracking: 0.8,
    header: "band", bandBg: "#0B5344", bandInk: "#FFFFFF", bandSub: "#BFDDD2", bandMeta: "#9CC6B9",
    heading: "short", headingRulePt: 1.4, headingRuleColor: "#0E7A5F", headingShortPt: 32,
    skills: "chips", listCols: 2, bulletAccent: true,
  },
  split: {
    ...BASE, accent: "#15476B", ink: "#111827", muted: "#59616E", rule: "#DCE2E8", accentSoft: "#E7EEF4",
    mx: 48, my: 44, body: 10.1, head: 10.8, name: 27, meta: 8.6, tracking: 0.7,
    header: "band", bandBg: "#EBF0F5", bandInk: "#10283D", bandSub: "#15476B", bandMeta: "#4C5F73",
    heading: "short", headingRulePt: 1.3, headingRuleColor: "#15476B", headingShortPt: 26,
    skills: "chips", listCols: 1, bulletAccent: true,
    layout: "sidebar", sidebarRatio: 0.31, sidebarGutter: 20,
  },
  panel: {
    ...BASE, accent: "#15476B", ink: "#111827", muted: "#59616E", rule: "#C3D4E1", accentSoft: "#DCE8F1",
    mx: 48, my: 44, body: 10.1, head: 10.6, name: 27, meta: 8.6, tracking: 0.7,
    header: "band", bandBg: "#123C5C", bandInk: "#FFFFFF", bandSub: "#BBD3E4", bandMeta: "#94B2C9",
    heading: "bar", headingBarW: 2.6, headingRulePt: 0.6,
    skills: "chips", listCols: 1, bulletAccent: true,
    layout: "sidebar", sidebarRatio: 0.3, sidebarGutter: 22, sidebarPanel: true,
  },
  timeline: {
    ...BASE, accent: "#2A5D7C", ink: "#121821", muted: "#5A626E", rule: "#D9E0E6", accentSoft: "#E8EFF4",
    mx: 56, my: 46, body: 10.3, head: 11.0, name: 27, meta: 8.6, tracking: 0.9,
    header: "rule", headerRulePt: 1.6, headerRuleAccent: true,
    heading: "plain", headingRulePt: 0.6, rail: true, listCols: 2, bulletAccent: true,
  },
  executive: {
    ...BASE, accent: "#16304B", ink: "#1B1B18", muted: "#5A5F6A", rule: "#D8D0C2", accentSoft: "#EFE9DE",
    mx: 70, my: 54, body: 10.4, head: 11.4, name: 29, meta: 8.8, tracking: 0.4,
    nameCentered: true, header: "rule", headerRulePt: 1.5,
    heading: "plain", headingRulePt: 0.6, headingCase: "title",
    entry: "split", listCols: 2, bullet: "dash", pageBg: "#FDFBF4",
  },
  ivy: {
    ...BASE, accent: "#1B2430", ink: "#121820", muted: "#6A717B", rule: "#C9CED6", accentSoft: "#ECEEF1",
    mx: 64, my: 50, body: 10.3, head: 11.6, name: 26, meta: 8.8, tracking: 0.3,
    nameCentered: true, header: "plain",
    heading: "centered", headingRulePt: 0.6, headingCase: "title",
    entry: "split", listCols: 2,
  },
  ledger: {
    ...BASE, accent: "#B4451F", ink: "#151515", muted: "#6A6A6A", rule: "#D8D8D8", accentSoft: "#F6E9E2",
    mx: 50, my: 42, body: 10.0, head: 11.2, name: 26, meta: 8.6, tracking: 0.6,
    header: "rule", headerRulePt: 2.0, headerRuleAccent: true,
    heading: "rule", headingRulePt: 2.0, headingRuleColor: "#1A1A1A",
    skills: "chips", listCols: 2, bulletAccent: true,
  },
  student: {
    ...BASE, accent: "#2E6B4F", ink: "#121A16", muted: "#5B6560", rule: "#D9E4DD", accentSoft: "#E8F1EC",
    mx: 62, my: 50, body: 10.6, head: 11.2, name: 27, meta: 8.8, tracking: 0.8,
    header: "band", bandBg: "#E8F1EC", bandInk: "#14301F", bandSub: "#2E6B4F", bandMeta: "#47604F",
    heading: "short", headingRulePt: 1.4, headingRuleColor: "#2E6B4F", headingShortPt: 30,
    skills: "chips", listCols: 2, bulletAccent: true,
  },
  compact: {
    ...BASE, accent: "#27405C", ink: "#141922", muted: "#5A626E", rule: "#DCE0E6", accentSoft: "#E7ECF2",
    mx: 46, my: 34, body: 9.9, head: 10.4, name: 22, meta: 8.4, tracking: 0.6,
    header: "rule", headerRulePt: 1.6, headerRuleAccent: true,
    heading: "bar", headingBarW: 2.4, headingRulePt: 0.6,
    listCols: 2, bulletAccent: true, tight: true,
  },
  minimal: {
    ...BASE, accent: "#374151", ink: "#111827", muted: "#6B7280", rule: "#E4E7EB", accentSoft: "#EDEFF2",
    mx: 84, my: 54, body: 10.6, head: 10.6, name: 30, meta: 8.8, tracking: 1.0,
    header: "plain", heading: "hung", headingHangPt: 58, headingRulePt: 0.6,
    listCols: 2, bullet: "dash",
  },
};

/** Deterministic PRNG so a thumbnail draws identically on every render. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export default function ResumeMiniature({
  template,
  label,
  className,
  flagBullet = false,
  struck = false,
}: {
  template: MiniatureTemplate;
  /** Accessible name. Decorative-only usage should pass nothing. */
  label?: string;
  className?: string;
  /**
   * Draw one bullet in the first role as a fabrication-guard catch: a danger
   * dot, and a strike rule that animates across it when `struck` is true.
   */
  flagBullet?: boolean;
  struck?: boolean;
}) {
  const reduce = useReducedMotion();
  const s = SPECS[template];

  const { nodes, strike } = useMemo(() => {
    const next = rng(seedOf(template));
    const out: ReactNode[] = [];
    let k = 0;
    const key = () => `n${k++}`;
    const lead = s.tight ? 1.3 : 1.48;
    const bottom = A4_H - s.my;
    const cw = A4_W - s.mx * 2;
    let strikeRect: { x: number; y: number; w: number } | null = null;

    const rect = (x: number, y: number, w: number, h: number, fill: string, o = 1, r = h * 0.3) =>
      out.push(<rect key={key()} x={x} y={y} width={Math.max(0, w)} height={h} rx={r} fill={fill} opacity={o} />);

    /** One ragged run of word blocks — real text reads as words, not bars. */
    const line = (x: number, y: number, maxW: number, size: number, fill: string, o: number, fill_ = 1) => {
      const target = maxW * fill_;
      const h = Math.max(1.5, size * 0.56);
      const gap = size * 0.36;
      let cx = 0;
      while (cx < target - size) {
        let w = size * (1.5 + next() * 3.4);
        if (cx + w > target) w = target - cx;
        if (w < size * 0.9) break;
        rect(x + cx, y, w, h, fill, o, h * 0.34);
        cx += w + gap;
      }
    };

    /** Tracked caps drawn letter-by-letter, so the template's tracking shows. */
    const caps = (x: number, y: number, letters: number, size: number, fill: string) => {
      const w = size * 0.5;
      const h = size * 0.6;
      const step = w + s.tracking + size * 0.13;
      for (let i = 0; i < letters; i++) {
        // Title case: only the first letter is full height.
        const lh = s.headingCase === "title" && i > 0 ? h * 0.76 : h;
        rect(x + i * step, y + (h - lh), w, lh, fill, 0.95, lh * 0.24);
      }
      return letters * step - (s.tracking + size * 0.13);
    };

    // ---- header ---------------------------------------------------------
    let y = s.my;
    const nameH = s.name * 0.7;

    if (s.header === "band") {
      // A filled rectangle that bleeds to the page edges.
      const bandH = s.my + nameH + s.name * 0.42 + s.meta * 1.5 + s.meta * 1.5 + s.my * 0.45;
      rect(0, 0, A4_W, bandH, s.bandBg!, 1, 0);
      y = s.my * 0.92;
      const nw = cw * 0.46;
      rect(s.nameCentered ? s.mx + (cw - nw) / 2 : s.mx, y, nw, nameH, s.bandInk!, 1, nameH * 0.18);
      y += nameH + s.name * 0.34;
      const hw = cw * 0.3;
      rect(s.nameCentered ? s.mx + (cw - hw) / 2 : s.mx, y, hw, s.meta * 0.6, s.bandSub!, 0.95);
      y += s.meta * 1.6;
      let bx = s.mx;
      [0.16, 0.12, 0.1, 0.14].forEach((f) => {
        rect(bx, y, cw * f, s.meta * 0.5, s.bandMeta!, 0.95);
        bx += cw * f + s.meta * 0.9;
      });
      y = bandH + s.my * 0.75;
    } else {
      const nw = cw * (s.nameCentered ? 0.44 : 0.4);
      rect(s.nameCentered ? s.mx + (cw - nw) / 2 : s.mx, y, nw, nameH, s.ink, 1, nameH * 0.18);
      y += nameH + s.name * 0.36;
      const hw = cw * 0.28;
      rect(s.nameCentered ? s.mx + (cw - hw) / 2 : s.mx, y, hw, s.meta * 0.58, s.accent, 0.9);
      y += s.meta * 1.7;
      const bits = [0.16, 0.12, 0.1, 0.14].map((f) => cw * f);
      const bw = bits.reduce((a, b) => a + b, 0) + bits.length * s.meta * 0.9;
      let bx = s.nameCentered ? s.mx + (cw - bw) / 2 : s.mx;
      bits.forEach((w) => {
        rect(bx, y, w, s.meta * 0.5, s.muted, 0.78);
        bx += w + s.meta * 0.9;
      });
      y += s.meta * 1.4;
      if (s.header === "rule") {
        rect(s.mx, y, cw, s.headerRulePt, s.headerRuleAccent ? s.accent : s.rule, 1, 0);
        y += s.headerRulePt;
      }
      y += s.my * 0.42;
    }
    const bodyTop = y;

    // ---- section heading, in whichever shape this template uses ----------
    const heading = (x: number, w: number, yy: number, letters: number): number => {
      const size = s.head * 0.86;
      const capH = size * 0.6;
      const rc = s.headingRuleColor ?? (s.heading === "short" ? s.accent : s.rule);
      if (s.heading === "bar") {
        rect(x, yy, s.headingBarW, capH, s.accent, 1, 0);
        caps(x + s.headingBarW + size * 0.45, yy, letters, size, s.accent);
        return yy + capH + size * 0.75;
      }
      if (s.heading === "centered") {
        const cwid = letters * (size * 0.5 + s.tracking + size * 0.13);
        caps(x + (w - cwid) / 2, yy, letters, size, s.accent);
        let ny = yy + capH + size * 0.4;
        rect(x, ny, w, s.headingRulePt, rc, 1, 0);
        return ny + s.headingRulePt + size * 0.6;
      }
      const width = caps(x, yy, letters, size, s.accent);
      let ny = yy + capH;
      if (s.heading === "rule") {
        ny += size * 0.4;
        rect(x, ny, w, s.headingRulePt, rc, 1, 0);
        ny += s.headingRulePt;
      } else if (s.heading === "short") {
        ny += size * 0.42;
        rect(x, ny, Math.min(s.headingShortPt, width * 1.1), s.headingRulePt, rc, 0.95, 0);
        ny += s.headingRulePt;
      }
      return ny + size * (s.heading === "plain" || s.heading === "hung" ? 0.5 : 0.62);
    };

    /**
     * `hung` headings live OUT in the start margin beside the body, which is
     * why minimal's side margin is so wide. Everything else shares one x.
     */
    const hung = s.heading === "hung";
    const mainX = s.mx + (hung ? s.headingHangPt : 0);
    const mainW = cw - (hung ? s.headingHangPt : 0);

    const section = (x: number, w: number, yy: number, letters: number) =>
      hung ? (caps(s.mx, yy, letters, s.head * 0.8, s.accent), yy) : heading(x, w, yy, letters);

    const para = (x: number, w: number, yy: number, count: number) => {
      for (let i = 0; i < count; i++) {
        line(x, yy, w, s.body, s.ink, 0.76, i === count - 1 ? 0.6 : 1);
        yy += s.body * lead;
      }
      return yy;
    };

    // ---- the sidebar geometry (PDF-only templates) ----------------------
    const sideW = s.layout === "sidebar" ? (cw - s.sidebarGutter) * s.sidebarRatio : 0;
    const colW = s.layout === "sidebar" ? cw - s.sidebarGutter - sideW : mainW;
    // In LTR the sidebar sits at the text start; the whole SVG mirrors in RTL,
    // which is exactly where the PDF puts it in Hebrew.
    const sideX = s.mx;
    const colX = s.layout === "sidebar" ? s.mx + sideW + s.sidebarGutter : mainX;

    if (s.layout === "sidebar" && s.sidebarPanel) {
      rect(sideX - 8, bodyTop - 10, sideW + 16, bottom - bodyTop + 20, s.accentSoft, 1, 6);
    }

    // ---- main column: SUMMARY + EXPERIENCE ------------------------------
    y = bodyTop;
    y = section(colX, colW, y, 7);
    y = para(colX, colW, y, s.tight ? 2 : 3);
    y += s.my * 0.42;

    y = section(colX, colW, y, 10);

    const railX = colX + s.body * 0.42;
    const roleX = s.rail ? colX + s.body * 1.5 : colX;
    const roleW = colW - (roleX - colX);
    const railTop = y;
    let railBottom = y;

    const bulletsPer = s.tight ? 3 : s.entry === "split" ? 3 : 3;
    const roleH = s.body * lead * (1 + bulletsPer) + s.meta * lead + s.body * 0.85;
    // Reserve room for the tail sections so the page always ends tidily.
    const tailPerSection = s.head * 2.4 + s.body * lead * 2 + s.my * 0.42;
    const tail = s.layout === "sidebar" ? 0 : tailPerSection * 2;
    let role = 0;

    // Keep emitting roles until the page is genuinely full, so every template
    // renders as a complete page and the dense ones visibly fit more. The cap
    // is only a runaway guard — `bottom - tail` is the real stop.
    while (role < 9 && y + roleH < bottom - tail) {
      if (s.rail) {
        railBottom = y + s.body * 0.34;
        out.push(
          <circle key={key()} cx={railX} cy={y + s.body * 0.3} r={s.body * 0.24} fill={s.accent} />,
        );
      }
      if (s.entry === "split") {
        // Title at the text start, dates flush to the far margin — a tab stop
        // in the DOCX, a drawn string in the PDF.
        const th = s.body * 0.62;
        rect(roleX, y, roleW * (0.34 + next() * 0.12), th, s.ink, 1, th * 0.28);
        rect(roleX + roleW - roleW * 0.19, y + th * 0.1, roleW * 0.19, s.meta * 0.5, s.muted, 0.8);
        y += s.body * lead;
        rect(roleX, y, roleW * (0.24 + next() * 0.1), s.meta * 0.56, s.accent, 0.9);
        y += s.meta * lead;
      } else {
        // One title line, then a single "Employer · Location · Dates" meta row.
        const th = s.body * 0.62;
        rect(roleX, y, roleW * (0.38 + next() * 0.14), th, s.ink, 1, th * 0.28);
        y += s.body * lead;
        let mxx = roleX;
        const segs = [0.26, 0.14, 0.18];
        segs.forEach((f, i) => {
          rect(mxx, y, roleW * f, s.meta * 0.54, i === 0 ? s.accent : s.muted, i === 0 ? 0.9 : 0.78);
          mxx += roleW * f + s.meta * 0.85;
        });
        y += s.meta * lead;
      }

      for (let b = 0; b < bulletsPer; b++) {
        const flagged = flagBullet && role === 0 && b === 1;
        const col = flagged ? "#C2344A" : s.bulletAccent ? s.accent : s.muted;
        const indent = s.body * 1.15;
        if (s.bullet === "dash") {
          rect(roleX, y + s.body * 0.26, s.body * 0.42, 1.1, col, 0.85, 0.5);
        } else {
          out.push(
            <circle key={key()} cx={roleX + s.body * 0.2} cy={y + s.body * 0.3} r={s.body * 0.17} fill={col} opacity={flagged ? 1 : 0.8} />,
          );
        }
        const lw = roleW - indent;
        line(roleX + indent, y, lw, s.body, flagged ? "#C2344A" : s.ink, flagged ? 0.85 : 0.72, b === bulletsPer - 1 ? 0.78 : 1);
        if (flagged) strikeRect = { x: roleX + indent, y: y + s.body * 0.28, w: lw * 0.82 };
        y += s.body * lead;
      }
      y += s.body * 0.85;
      role++;
    }

    if (s.rail && railBottom > railTop) {
      out.push(
        <rect key={key()} x={railX - 0.4} y={railTop} width={0.9} height={railBottom - railTop} fill={s.rule} />,
      );
    }

    // ---- skills / education / certifications ----------------------------
    const skillsBlock = (x: number, w: number, yy: number) => {
      if (s.skills === "chips") {
        // Bordered chips in a wrapping row.
        const h = s.body * 1.35;
        let cx = 0;
        let rows = 0;
        while (rows < 3) {
          const cwid = s.body * (2.6 + next() * 3);
          if (cx + cwid > w) {
            cx = 0;
            rows++;
            yy += h + s.body * 0.34;
            if (rows >= (w < 140 ? 4 : 2)) break;
          }
          out.push(
            <rect
              key={key()}
              x={x + cx}
              y={yy}
              width={cwid}
              height={h}
              rx={h * 0.5}
              fill={s.accentSoft}
              stroke={s.accent}
              strokeOpacity={0.35}
              strokeWidth={0.6}
            />,
          );
          cx += cwid + s.body * 0.34;
        }
        return yy + h + s.body * 0.5;
      }
      return para(x, w, yy, 2);
    };

    const listBlock = (x: number, w: number, yy: number, rows: number) => {
      const cols = s.listCols;
      const gw = (w - (cols - 1) * s.body) / cols;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          line(x + c * (gw + s.body), yy, gw, s.body, s.ink, 0.72, 0.85);
        }
        yy += s.body * lead;
      }
      return yy;
    };

    if (s.layout === "sidebar") {
      // Credentials live in the rail beside the career story.
      let sy = bodyTop;
      sy = section(sideX, sideW, sy, 6);
      sy = skillsBlock(sideX, sideW, sy);
      sy += s.my * 0.4;
      sy = section(sideX, sideW, sy, 9);
      for (let e = 0; e < 2 && sy + s.body * lead * 2 < bottom; e++) {
        const dh = s.body * 0.62;
        rect(sideX, sy, sideW * (0.7 + next() * 0.2), dh, s.ink, 1, dh * 0.28);
        sy += s.body * lead;
        rect(sideX, sy, sideW * 0.6, s.meta * 0.56, s.accent, 0.9);
        sy += s.meta * lead + s.body * 0.6;
      }
      sy += s.my * 0.3;
      // Certifications, then languages — the rail keeps going to the foot of
      // the page, which is the whole point of putting them there.
      for (const letters of [8, 7]) {
        if (sy + s.head * 3 + s.body * lead * 2 > bottom) break;
        sy = section(sideX, sideW, sy, letters);
        for (let i = 0; i < 3 && sy + s.body * lead < bottom; i++) {
          line(sideX, sy, sideW, s.body, s.ink, 0.7, 0.9);
          sy += s.body * lead;
        }
        sy += s.my * 0.3;
      }
    } else {
      y += s.my * 0.42 - s.body * 0.85;
      y = section(mainX, mainW, y, 6);
      y = skillsBlock(mainX, mainW, y);
      y += s.my * 0.42;
      if (y + s.head * 3 + s.body * lead * 2 < bottom) {
        y = section(mainX, mainW, y, 9);
        const dh = s.body * 0.62;
        rect(mainX, y, mainW * 0.38, dh, s.ink, 1, dh * 0.28);
        rect(mainX + mainW - mainW * 0.16, y + dh * 0.1, mainW * 0.16, s.meta * 0.5, s.muted, 0.8);
        y += s.body * lead;
        rect(mainX, y, mainW * 0.3, s.meta * 0.56, s.accent, 0.9);
        y += s.meta * lead + s.my * 0.42;
      }
      if (y + s.head * 3 + s.body * lead * 2 < bottom) {
        y = section(mainX, mainW, y, 8);
        listBlock(mainX, mainW, y, 2);
      }
    }

    return { nodes: out, strike: strikeRect };
  }, [template, s, flagBullet]);

  return (
    <svg
      viewBox={`0 0 ${A4_W} ${A4_H}`}
      className={className}
      role={label ? "img" : "presentation"}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      style={{ shapeRendering: "geometricPrecision" }}
    >
      <rect x={0} y={0} width={A4_W} height={A4_H} fill={s.pageBg} />
      {nodes}
      {strike && (
        <motion.rect
          x={strike.x}
          y={strike.y}
          height={1.8}
          rx={0.9}
          fill="#C2344A"
          initial={false}
          animate={{ width: reduce || struck ? strike.w : 0 }}
          transition={{ duration: reduce ? 0 : struck ? 0.45 : 0.2, ease: [0.22, 1, 0.36, 1] }}
        />
      )}
    </svg>
  );
}
