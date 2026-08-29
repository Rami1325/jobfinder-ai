import { useId, useMemo, type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useTranslation } from "react-i18next";
import type { ResumeTemplate } from "../../api/client";
import { TEMPLATE_SPECS, bandFill, headingRuleFill } from "../../lib/templateSpecs";

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
 * They are also HONEST miniatures, not decoration. Every geometric fact they
 * draw — page size, margins, type sizes, palette, header treatment, heading
 * treatment, entry grammar, column count, bullet glyph — comes from
 * `lib/templateSpecs.ts`, the ONE frontend mirror of the real `TemplateSpec`
 * values in `backend/app/render/templates.py`, and check-mirrors 23 fails the
 * build when the two drift. The table used to live in this file and had
 * already drifted (`classic` drew an inline skills run against the file's
 * chips): a thumbnail that lies about the download is worse than no thumbnail
 * on a page whose entire pitch is honesty. The vertical rhythm, the section
 * order and the entry grammar come from `pdf_renderer.py` itself (`_Sheet`,
 * `entry()`, `section_order()`) and are still transcribed by hand below.
 *
 * WHAT IS DRAWN. Real `<text>`, not grey bars — one fixed, invented demo CV
 * (see DEMO) laid out by a miniature version of the PDF engine: measure, wrap,
 * stack, and stop when the page is full. Every template gets the SAME words,
 * so the eleven thumbnails differ only in design, and a dense template
 * (compact, ledger) visibly fits more of them than a roomy one (minimal,
 * executive). That difference is the whole point of the set.
 *
 * TEXT AT 4px. A thumbnail is ~260px wide, so 10pt body type lands at about
 * 4.4 CSS px. That is deliberate: what has to survive is the TEXTURE of a real
 * document — real word gaps, real line rag, headings that say EXPERIENCE,
 * employers, date ranges — and zoomed in it has to hold up as a plausible CV.
 * Every run is measured with a Helvetica-metrics table and drawn with
 * `textLength`/`lengthAdjust`, so a line can never overflow its column even if
 * the visitor's browser falls back to a font we did not measure.
 *
 * RTL. The callers mirror the whole sheet (`rtl:-scale-x-100`), which is where
 * the PDF puts the sidebar and the start margin in Hebrew. Mirrored glyphs
 * would be unreadable, so each run is flipped back about its own box — the
 * sheet mirrors, the words do not. The demo copy stays English in both
 * locales on purpose: it is document CONTENT (like a screenshot), not UI
 * chrome, and it must be identical in all eleven tiles to be a fair
 * comparison. The only localized strings here are the accessibility ones.
 */

/* -------------------------------------------------------------------------- */
/* The demo résumé                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One invented, deliberately generic candidate. Not a real person: the address
 * is on the reserved `example.com` domain and the phone number is a blank
 * range, and the SVG says so in its `<desc>`.
 *
 * The same object feeds all eleven templates. If you change a word here, every
 * thumbnail changes with it — which is the property that makes the set a
 * comparison of DESIGNS rather than of copy.
 */
const DEMO = {
  name: "MAYA ELDAR",
  headline: "Senior Product Manager · B2B SaaS",
  contact: [
    "maya.eldar@example.com",
    "+972 54-000-0000",
    "Tel Aviv",
    "linkedin.com/in/mayaeldar",
  ],
  summary:
    "Product manager with eight years taking B2B tools from first customer to " +
    "steady revenue. I work close to the engineers and closer to the users, and " +
    "I measure whether the thing shipped actually changed a number.",
  // Flat, comma-delimited skills — the shape `build_skills` renders, grouped
  // Product → Technical → Leadership so the order still reads as curated.
  skills: [
    "discovery",
    "roadmapping",
    "pricing",
    "A/B testing",
    "analytics",
    "SQL",
    "Figma",
    "Amplitude",
    "Jira",
    "REST APIs",
    "stakeholder alignment",
    "hiring",
    "mentoring",
  ],
  experience: [
    {
      title: "Senior Product Manager",
      company: "Latitude",
      location: "Tel Aviv",
      dates: "2022 – Present",
      bullets: [
        "Led the billing rebuild that cut involuntary churn from 4.1% to 1.6% in two quarters.",
        "Took the onboarding flow from eleven screens to four; activation rose 34%.",
        "Run a weekly call with six enterprise accounts, which is where the roadmap actually comes from.",
      ],
    },
    {
      title: "Product Manager",
      company: "Northwind",
      location: "Tel Aviv",
      dates: "2019 – 2022",
      bullets: [
        "Shipped the reporting suite that became the reason 40% of renewals cited for staying.",
        "Replaced a quarterly release train with continuous delivery, cutting lead time from 38 days to 4.",
      ],
    },
    {
      title: "Associate Product Manager",
      company: "Kestrel",
      location: "Remote",
      dates: "2017 – 2019",
      bullets: ["Owned the mobile checkout rewrite; cart abandonment fell 12 points."],
    },
  ],
  projects: [
    {
      name: "Pricing Sandbox",
      description:
        "An internal tool that lets sales model a discount and see the margin " +
        "impact before the call, not after it.",
    },
    {
      name: "Churn Signals",
      description:
        "A weekly digest that ranks accounts by risk and says which behaviour " +
        "changed, so CS opens the right conversation.",
    },
  ],
  education: [
    {
      degree: "B.Sc. Industrial Engineering",
      institution: "Technion",
      dates: "2013 – 2017",
    },
  ],
  languages: ["Hebrew (native)", "English (fluent)"],
} as const;

/** Section labels, straight from `app/render/labels.py` (English half). */
const LABEL = {
  summary: "Summary",
  skills: "Skills",
  experience: "Experience",
  projects: "Projects",
  education: "Education",
  languages: "Languages",
} as const;

/* -------------------------------------------------------------------------- */
/* The page                                                                    */
/* -------------------------------------------------------------------------- */

// A4 at 1pt = 1 SVG unit, rounded — the sheet is scaled by the viewBox, so the
// fractions templates.py carries (595.276 x 841.890) buy nothing here.
const A4_W = 596;
const A4_H = 842;

/* -------------------------------------------------------------------------- */
/* Type metrics                                                                */
/* -------------------------------------------------------------------------- */

const SANS = '"Lato","Helvetica Neue",Helvetica,Arial,sans-serif';
const SERIF = 'Spectral,"Iowan Old Style",Georgia,"Times New Roman",serif';

/**
 * Advance widths for ASCII 32–126, in 1/1000 em, from the Helvetica AFM — the
 * closest widely available stand-in for Lato, and the metric family every
 * fallback in the sans stack is built on.
 *
 * The estimate only has to be good enough to break lines and to give each line
 * an honest rag: `textLength` pins the drawn width to whatever we measured, so
 * a browser that substitutes a different face still cannot overflow a column.
 */
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/** The handful of non-ASCII characters this demo actually uses. */
const WIDE: Record<number, number> = {
  0x00a0: 278, // nbsp
  0x00b7: 333, // ·
  0x2013: 556, // –
  0x2014: 1000, // —
  0x2019: 191, // ’
  0x2022: 350, // •
};

function adv(str: string, size: number, bold: boolean, serif: boolean, tracking = 0): number {
  let em = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    em += c >= 32 && c < 127 ? HELV[c - 32] : WIDE[c] ?? 550;
  }
  let w = (em / 1000) * size;
  // Spectral/Georgia set a touch narrower than Helvetica at the same size;
  // both bold faces set wider. Two constants beat a second 95-entry table.
  if (serif) w *= bold ? 0.95 : 0.9;
  if (bold) w *= 1.055;
  return w + tracking * Math.max(0, str.length - 1);
}

/** Greedy word wrap — the same shape as `_wrap_lines` in the PDF renderer. */
function wrapText(
  str: string,
  width: number,
  size: number,
  bold: boolean,
  serif: boolean,
): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of str.split(" ")) {
    const next = cur ? `${cur} ${word}` : word;
    if (cur && adv(next, size, bold, serif) > width) {
      out.push(cur);
      cur = word;
    } else {
      cur = next;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Blend two hex colours — the rail colour is the accent mixed 45% into white. */
function mix(a: string, b: string, t: number): string {
  const parse = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [r1, g1, b1] = parse(a);
  const [r2, g2, b2] = parse(b);
  const ch = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return `#${ch(r1, r2)}${ch(g1, g2)}${ch(b1, b2)}`;
}

/** One drawable strip of the page: `before` is its space-before, `h` its own
 *  height (space-after folded in), `sec` marks a section heading. */
interface Item {
  before: number;
  h: number;
  sec?: boolean;
  draw: (top: number) => void;
}

export default function ResumeMiniature({
  template,
  label,
  className,
  flagBullet = false,
  struck = false,
}: {
  template: ResumeTemplate;
  /** Accessible name. Decorative-only usage should pass nothing. */
  label?: string;
  className?: string;
  /**
   * Draw one bullet in the first role as a fabrication-guard catch: the line
   * in danger red, and a strike rule that animates across it when `struck`.
   */
  flagBullet?: boolean;
  struck?: boolean;
}) {
  const reduce = useReducedMotion();
  const { t, i18n } = useTranslation("marketing");
  const uid = useId();
  const s = TEMPLATE_SPECS[template];
  // The callers mirror the sheet with `rtl:-scale-x-100`, which fires off the
  // document `dir` i18n sets for Hebrew. `put` reads this to flip each run
  // back, so the two must agree on what "RTL" means.
  const rtl = (i18n.language || "en").toLowerCase().startsWith("he");

  const { nodes, strike } = useMemo(() => {
    const out: ReactNode[] = [];
    let k = 0;
    const key = () => `n${k++}`;
    let strikeRect: { x: number; y: number; w: number } | null = null;

    // --- rhythm, from `_Sheet` -------------------------------------------
    const lead = s.body * (s.tight ? 1.26 : 1.36);
    const secBefore = s.tight ? 8 : 12;
    const secAfter = s.tight ? 3.5 : 5;
    const entryBefore = s.tight ? 4.5 : 7;
    const bulletAfter = s.tight ? 0.5 : 1.2;
    const font = s.serif ? SERIF : SANS;
    const ascent = (size: number) => size * (s.serif ? 0.7 : 0.74);
    const sepColor = mix(s.muted, s.rule, 0.55);

    const cw = A4_W - s.mx * 2;
    const bottom = A4_H - s.my;

    const rect = (x: number, y: number, w: number, h: number, fill: string, o = 1, r = 0) =>
      out.push(
        <rect key={key()} x={x} y={y} width={Math.max(0, w)} height={Math.max(0, h)} rx={r} fill={fill} opacity={o} />,
      );

    /**
     * Draw one run of text whose box starts at `left` on the LTR sheet, and
     * return its measured width.
     *
     * RTL: the caller mirrors the whole SVG, so the run is flipped back about
     * the far edge of its own box (`p = left + w`). The box lands exactly
     * where the mirror puts it — start margin on the right — and the words
     * inside still read left to right, which is what a Latin run inside a
     * Hebrew page does.
     */
    const put = (
      str: string,
      left: number,
      baseline: number,
      size: number,
      fill: string,
      opt: { bold?: boolean; opacity?: number; tracking?: number; maxW?: number } = {},
    ): number => {
      const bold = !!opt.bold;
      const tracking = opt.tracking ?? 0;
      const natural = adv(str, size, bold, s.serif, tracking);
      const w = opt.maxW ? Math.min(natural, opt.maxW) : natural;
      if (!str || w <= 0) return 0;
      const p = left + w;
      out.push(
        <text
          key={key()}
          x={rtl ? p : left}
          y={baseline}
          transform={rtl ? `translate(${p * 2} 0) scale(-1 1)` : undefined}
          fontFamily={font}
          fontSize={size}
          fontWeight={bold ? 700 : 400}
          fill={fill}
          fillOpacity={opt.opacity ?? 1}
          letterSpacing={tracking || undefined}
          textLength={w}
          lengthAdjust="spacingAndGlyphs"
        >
          {str}
        </text>,
      );
      return w;
    };

    const measure = (str: string, size: number, bold = false, tracking = 0) =>
      adv(str, size, bold, s.serif, tracking);

    /**
     * A `·`-joined run of differently coloured pieces — "Latitude · Tel Aviv ·
     * 2022 – Present". In RTL the pieces are laid out back to front so that,
     * once the sheet mirrors, they read in their original order flush to the
     * start (right) edge.
     */
    interface Seg {
      t: string;
      size: number;
      fill: string;
      bold?: boolean;
    }
    const putSegments = (parts: Seg[], left: number, baseline: number, sep = " · ") => {
      const live = parts.filter((p) => p.t);
      if (!live.length) return;
      const order = rtl ? [...live].reverse() : live;
      const gap = measure(sep, live[0].size);
      let x = left;
      order.forEach((p, i) => {
        if (i > 0) {
          const dot = measure("·", p.size);
          put("·", x + (gap - dot) / 2, baseline, p.size, sepColor, { opacity: 0.9 });
          x += gap;
        }
        x += put(p.t, x, baseline, p.size, p.fill, { bold: p.bold });
      });
    };

    // --- header ----------------------------------------------------------
    const band = s.header === "band";
    // A band anchors the name hard to the top-start corner; centring inside it
    // reads like a certificate. (`pdf_renderer._build_flow`.)
    const centred = !band && s.nameCentered;
    const headlineSize = s.body + (band ? 1.2 : 0.8);
    const nameLead = s.name * 1.18;
    const headlineLead = (s.body + 0.8) * 1.35;
    const metaLead = s.meta * (band ? 1.5 : 1.45);

    const contactLine = DEMO.contact.join(" · ");
    const headH = nameLead + 1 + 1 + headlineLead + 1 + metaLead;
    const bandH = band ? headH + s.my * 0.72 + s.my * 0.62 : 0;

    if (band) rect(0, 0, A4_W, bandH, bandFill(s), 1, 0);

    let hy = band ? s.my * 0.72 : s.my;
    const place = (w: number) => (centred ? s.mx + (cw - w) / 2 : s.mx);

    const nameW = measure(DEMO.name, s.name, true, s.nameTracking);
    put(DEMO.name, place(nameW), hy + ascent(s.name), s.name, band ? s.bandInk : s.ink, {
      bold: true,
      tracking: s.nameTracking,
      maxW: cw,
    });
    hy += nameLead + 2;

    const headlineW = measure(DEMO.headline, headlineSize, false, 0.3);
    put(DEMO.headline, place(headlineW), hy + ascent(headlineSize), headlineSize, band ? s.bandSub : s.accent, {
      tracking: 0.3,
      maxW: cw,
    });
    hy += headlineLead + 1;

    const contactW = measure(contactLine, s.meta);
    putSegments(
      DEMO.contact.map((t) => ({ t, size: s.meta, fill: band ? s.bandMeta : s.muted })),
      place(Math.min(contactW, cw)),
      hy + ascent(s.meta),
    );
    hy += metaLead;

    if (!band && s.header === "rule") {
      hy += 6;
      rect(s.mx, hy, cw, s.headerRulePt, s.headerRuleAccent ? s.accent : s.rule);
      hy += s.headerRulePt;
    } else if (!band) {
      // Without a rule to separate it, the header needs the air itself.
      hy += 5;
    }
    // A band bleeds to the page edges and the body starts 4pt under it;
    // otherwise the header is simply the top of the same flow as the body.
    const bodyTop = band ? bandH + 4 : hy;

    // --- section heading, in whichever shape this template uses -----------
    const headingItem = (labelKey: keyof typeof LABEL, x: number, w: number): Item => {
      const size = s.head + s.headingBump;
      const bar = s.heading === "bar";
      const ruled = s.heading === "rule" || s.heading === "short" || s.heading === "centered";
      const gap = ruled ? s.headingRulePt + 4 : 0;
      const before = secBefore + (bar ? 3 : 0);
      const after = secAfter + (bar ? 1 : 0);
      const h = (bar ? size * 1.34 : size * 1.15 + gap) + after;
      const text = s.headingCase === "title" ? LABEL[labelKey] : LABEL[labelKey].toUpperCase();
      const ruleColor = headingRuleFill(s);
      // `short` and `hung` set the label in ink and let the accent live in the
      // mark beside it; every other shape colours the label itself.
      const color = bar || s.heading === "short" || s.heading === "hung" ? s.ink : s.accent;
      return {
        before,
        h,
        sec: true,
        draw: (top) => {
          if (bar) {
            const bh = size * 1.34;
            rect(x, top + bh * 0.16, s.headingBarW, bh * 0.7, s.accent);
            put(text, x + s.headingBarW + 7, top + bh * 0.72, size, color, {
              bold: true,
              tracking: s.tracking,
              maxW: w - s.headingBarW - 7,
            });
            return;
          }
          const tw = measure(text, size, true, s.tracking);
          if (s.heading === "hung") {
            // Out in the start margin, aligned to its INNER edge so a long
            // label grows away from the text column.
            put(text, Math.max(4, x - 8 - tw), top + ascent(size), size, color, {
              bold: true,
              tracking: s.tracking,
            });
            return;
          }
          const tx = s.heading === "centered" ? x + (w - tw) / 2 : x;
          put(text, tx, top + ascent(size), size, color, { bold: true, tracking: s.tracking, maxW: w });
          if (!ruled) return;
          const ry = top + h - after - 1.5 - s.headingRulePt;
          const rw = s.heading === "short" ? Math.min(s.headingShortPt, w) : w;
          rect(x, ry, rw, s.headingRulePt, ruleColor);
        },
      };
    };

    const paraItem = (
      str: string,
      x: number,
      w: number,
      opt: { size?: number; fill?: string; before?: number; after?: number; opacity?: number } = {},
    ): Item => {
      const size = opt.size ?? s.body;
      const lines = wrapText(str, w, size, false, s.serif);
      return {
        before: opt.before ?? 0,
        h: lines.length * lead + (opt.after ?? 0),
        draw: (top) =>
          lines.forEach((ln, i) =>
            put(ln, x, top + ascent(size) + i * lead, size, opt.fill ?? s.ink, {
              opacity: opt.opacity,
              maxW: w,
            }),
          ),
      };
    };

    // --- entries ----------------------------------------------------------
    // The timeline rail lives in the MARGIN gutter, so it costs the column no
    // width. One continuous line spanning the whole Experience block, plus a
    // dot per role — exactly `_Text._draw_rail`.
    let railFrom = Infinity;
    let railTo = -Infinity;
    const railDots: number[] = [];
    const railSpan = (top: number, bot: number) => {
      railFrom = Math.min(railFrom, top);
      railTo = Math.max(railTo, bot);
    };

    const bulletItem = (
      str: string,
      x: number,
      w: number,
      last: boolean,
      flagged: boolean,
      rail: boolean,
    ): Item => {
      const indent = s.body * 1.05;
      const lines = wrapText(str, w - indent, s.body, false, s.serif);
      const col = flagged ? "#C2344A" : s.bulletAccent ? s.accent : s.muted;
      return {
        before: 0,
        h: lines.length * lead + (last ? 0 : bulletAfter),
        draw: (top) => {
          if (rail) railSpan(top, top + lines.length * lead);
          const base = top + ascent(s.body);
          put(s.bulletGlyph, x, base, s.body * s.bulletScale, col, { opacity: flagged ? 1 : 0.9 });
          lines.forEach((ln, i) => {
            const lw = put(ln, x + indent, base + i * lead, s.body, flagged ? "#C2344A" : s.ink, {
              opacity: flagged ? 1 : 0.92,
              maxW: w - indent,
            });
            if (flagged && i === 0) {
              strikeRect = { x: x + indent, y: base - s.body * 0.28, w: lw };
            }
          });
        },
      };
    };

    interface EntryData {
      title: string;
      dates: string;
      secondary: Seg[];
      bullets: string[];
      body?: string;
    }

    const entryItems = (
      e: EntryData,
      x: number,
      w: number,
      first: boolean,
      rail: boolean,
      flagIndex = -1,
    ): Item[] => {
      const items: Item[] = [];
      if (s.entry === "stack") {
        // The dates ride the meta line: a short title used to leave the widest
        // dead space on the page between itself and a flush-right date.
        const size = s.body + 0.9;
        const titleLead = size * 1.3;
        items.push({
          before: first ? 0 : entryBefore + 1.5,
          h: titleLead,
          draw: (top) => {
            if (rail) {
              railSpan(top, top + titleLead);
              railDots.push(top + size * 0.62);
            }
            put(e.title, x, top + ascent(size), size, s.ink, { bold: true, maxW: w });
          },
        });
        const parts: Seg[] = [...e.secondary];
        if (parts[0]) parts[0] = { ...parts[0], bold: true };
        if (e.dates) parts.push({ t: e.dates, size: s.meta, fill: s.muted });
        if (parts.some((p) => p.t)) {
          items.push({
            before: 0,
            h: lead + 1.5,
            draw: (top) => {
              if (rail) railSpan(top, top + lead);
              putSegments(parts, x, top + ascent(s.body), "  ·  ");
            },
          });
        }
      } else {
        // Title at the text start, dates flush to the far margin — a tab stop
        // in the DOCX, a drawn string in the PDF.
        items.push({
          before: first ? 0 : entryBefore,
          h: lead,
          draw: (top) => {
            const base = top + ascent(s.body);
            const dw = e.dates ? measure(e.dates, s.meta) : 0;
            put(e.title, x, base, s.body, s.ink, { bold: true, maxW: w - dw - 8 });
            if (e.dates) put(e.dates, x + w - dw, base, s.meta, s.muted);
          },
        });
        if (e.secondary.some((p) => p.t)) {
          items.push({
            before: 0,
            h: lead,
            draw: (top) => putSegments(e.secondary, x, top + ascent(s.body)),
          });
        }
      }
      if (e.body) items.push(paraItem(e.body, x, w, { fill: s.muted, after: bulletAfter }));
      e.bullets.forEach((b, i) =>
        items.push(bulletItem(b, x, w, i === e.bullets.length - 1, i === flagIndex, rail)),
      );
      return items;
    };

    // --- skills ----------------------------------------------------------
    const chipsItem = (labels: readonly string[], x: number, w: number): Item => {
      const size = s.meta + 0.4;
      const pad = 5.2;
      const gap = 4.6;
      const chipH = size * 1.72;
      const rows: { t: string; w: number }[][] = [];
      let cur: { t: string; w: number }[] = [];
      let cwid = 0;
      for (const t of labels) {
        const width = measure(t, size) + 2 * pad;
        if (cur.length && cwid + gap + width > w) {
          rows.push(cur);
          cur = [];
          cwid = 0;
        }
        cur.push({ t, w: width });
        cwid += (cwid ? gap : 0) + width;
      }
      if (cur.length) rows.push(cur);
      return {
        before: 0,
        h: rows.length * (chipH + gap) - gap,
        draw: (top) => {
          let y = top;
          for (const row of rows) {
            let x0 = x;
            for (const chip of row) {
              out.push(
                <rect
                  key={key()}
                  x={x0}
                  y={y}
                  width={chip.w}
                  height={chipH}
                  rx={2.6}
                  fill="none"
                  stroke={s.rule}
                  strokeWidth={0.6}
                />,
              );
              put(chip.t, x0 + pad, y + chipH * 0.69, size, s.ink, { maxW: chip.w - 2 * pad });
              x0 += chip.w;
            }
            y += chipH + gap;
          }
        },
      };
    };

    /** Two-column bulleted list — `_ColumnList`, used for the short sections. */
    const columnListItem = (labels: readonly string[], x: number, w: number, cols: number): Item => {
      const gap = 16;
      const colW = (w - gap * (cols - 1)) / cols;
      const indent = s.body * 1.05;
      const cells = labels.map((t) => wrapText(t, colW - indent, s.body, false, s.serif));
      const rowLines: number[] = [];
      for (let r = 0; r < cells.length; r += cols) {
        rowLines.push(Math.max(...cells.slice(r, r + cols).map((c) => c.length)));
      }
      return {
        before: 0,
        h: rowLines.reduce((a, b) => a + b, 0) * lead,
        draw: (top) => {
          let y = top;
          for (let r = 0, row = 0; r < cells.length; r += cols, row++) {
            cells.slice(r, r + cols).forEach((linesOf, ci) => {
              const cx = x + ci * (colW + gap);
              put(s.bulletGlyph, cx, y + ascent(s.body), s.body * s.bulletScale, s.bulletAccent ? s.accent : s.muted, {
                opacity: 0.9,
              });
              linesOf.forEach((ln, li) =>
                put(ln, cx + indent, y + ascent(s.body) + li * lead, s.body, s.ink, {
                  opacity: 0.92,
                  maxW: colW - indent,
                }),
              );
            });
            y += rowLines[row] * lead;
          }
        },
      };
    };

    const skillsItems = (x: number, w: number): Item[] => [
      headingItem("skills", x, w),
      s.skills === "chips"
        ? chipsItem(DEMO.skills, x, w)
        : // Comma-separated on purpose: it is what ATS keyword parsers split on.
          paraItem(DEMO.skills.join(", "), x, w),
    ];

    const educationItems = (x: number, w: number): Item[] => [
      headingItem("education", x, w),
      ...DEMO.education.flatMap((e, i) =>
        entryItems(
          {
            title: e.degree,
            dates: e.dates,
            secondary: [{ t: e.institution, size: s.body, fill: s.accent }],
            bullets: [],
          },
          x,
          w,
          i === 0,
          false,
        ),
      ),
    ];

    const languagesItems = (x: number, w: number): Item[] => [
      headingItem("languages", x, w),
      s.skills === "chips"
        ? chipsItem(DEMO.languages, x, w)
        : columnListItem(DEMO.languages, x, w, s.listCols),
    ];

    // --- the sidebar geometry (PDF-only templates) -----------------------
    const sidebar = s.layout === "sidebar";
    const sideW = sidebar ? (cw - s.sidebarGutter) * s.sidebarRatio : 0;
    // A hung heading lives in the MARGIN, so it costs the column no width.
    const colX = sidebar ? s.mx + sideW + s.sidebarGutter : s.mx;
    const colW = sidebar ? cw - s.sidebarGutter - sideW : cw;
    // In LTR the sidebar sits at the text start; the whole SVG mirrors in RTL,
    // which is exactly where the PDF puts it in Hebrew.
    const sideX = s.mx;

    if (sidebar && s.sidebarPanel) {
      // The panel bleeds to the foot of the page, under the band.
      rect(sideX - 10, bodyTop - 4, sideW + 20, A4_H - (bodyTop - 4), s.accentSoft, 1, 0);
    }

    // --- the flow ---------------------------------------------------------
    // Section order is `section_order.EXPERIENCED_ORDER` — Maya has eight
    // years, so Experience leads and Education follows it. In the two sidebar
    // templates, `TemplateSpec.sidebar_keys` moves skills/education/languages
    // into the rail and leaves the career story in the main column.
    const main: Item[] = [
      headingItem("summary", colX, colW),
      paraItem(DEMO.summary, colX, colW),
      ...(sidebar ? [] : skillsItems(colX, colW)),
      headingItem("experience", colX, colW),
      ...DEMO.experience.flatMap((e, i) =>
        entryItems(
          {
            title: e.title,
            dates: e.dates,
            secondary: [
              { t: e.company, size: s.body, fill: s.accent },
              { t: e.location, size: s.meta, fill: s.muted },
            ],
            bullets: [...e.bullets],
          },
          colX,
          colW,
          i === 0,
          s.rail,
          flagBullet && i === 0 ? 1 : -1,
        ),
      ),
      headingItem("projects", colX, colW),
      ...DEMO.projects.flatMap((p, i) =>
        entryItems(
          { title: p.name, dates: "", secondary: [], bullets: [], body: p.description },
          colX,
          colW,
          i === 0,
          false,
        ),
      ),
      ...(sidebar ? [] : educationItems(colX, colW)),
      ...(sidebar ? [] : languagesItems(colX, colW)),
    ];

    const side: Item[] = sidebar
      ? [...skillsItems(sideX, sideW), ...educationItems(sideX, sideW), ...languagesItems(sideX, sideW)]
      : [];

    /**
     * Lay a column out and draw as much of it as the page holds.
     *
     * Truncation is per template, not per section: a dense template fits more
     * of the same copy than a roomy one, which is the difference the whole set
     * exists to show. A heading left stranded at the foot with nothing under
     * it is dropped — the renderer's `KeepTogether` makes the same promise.
     *
     * Whatever room is left over is then spread across the section gaps, up to
     * 60% of one gap each. A one-page CV that stops two thirds down is honest
     * but reads as a broken thumbnail; the type and the margins never move.
     */
    const layout = (items: Item[], top: number) => {
      const kept: Item[] = [];
      let y = top;
      for (const it of items) {
        if (y + it.before + it.h > bottom) break;
        y += it.before + it.h;
        kept.push(it);
      }
      while (kept.length && kept[kept.length - 1].sec) {
        const last = kept.pop()!;
        y -= last.before + last.h;
      }
      const gaps = kept.filter((it, i) => it.sec && i > 0).length;
      const extra = gaps ? Math.min(secBefore * 0.6, Math.max(0, bottom - y) / gaps) : 0;
      let dy = top;
      kept.forEach((it, i) => {
        dy += it.before + (it.sec && i > 0 ? extra : 0);
        it.draw(dy);
        dy += it.h;
      });
    };

    layout(main, bodyTop);
    if (sidebar) layout(side, bodyTop);

    if (s.rail && railTo > railFrom) {
      const railColor = mix(s.accent, "#ffffff", 0.45);
      const rx = colX - 13;
      rect(rx - 0.35, railFrom, 0.7, railTo - railFrom, railColor);
      railDots.forEach((cy) =>
        out.push(<circle key={key()} cx={rx} cy={cy} r={2.1} fill={railColor} />),
      );
    }

    return { nodes: out, strike: strikeRect as { x: number; y: number; w: number } | null };
  }, [template, s, flagBullet, rtl]);

  // Assistive-tech copy. It is read aloud, so it is a user-visible string and
  // lives in the locale bundles like every other one.
  const note = t("templates.sample.note");
  const title = label ?? t("templates.sample.title");

  return (
    <svg
      viewBox={`0 0 ${A4_W} ${A4_H}`}
      className={className}
      role="img"
      aria-labelledby={label ? `${uid}-t ${uid}-d` : undefined}
      aria-hidden={label ? undefined : true}
      focusable="false"
      style={{
        shapeRendering: "geometricPrecision",
        textRendering: "geometricPrecision",
        // The sheet mirrors in RTL, but every run inside it is Latin and is
        // positioned by hand. Without this the `dir="rtl"` document leaks in,
        // `text-anchor: start` silently means the RIGHT edge, and every line
        // lands one line-width off. Direction is a property of the DOCUMENT
        // being drawn, not of the UI drawing it.
        direction: "ltr",
        unicodeBidi: "isolate",
      }}
    >
      <title id={`${uid}-t`}>{title}</title>
      <desc id={`${uid}-d`}>{note}</desc>
      <rect x={0} y={0} width={A4_W} height={A4_H} fill={s.pageBg || "#FFFFFF"} />
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
