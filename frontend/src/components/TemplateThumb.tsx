import { Fragment, type CSSProperties, type ReactNode } from "react";
import { cn } from "../lib/cn";
import type { ResumeTemplate } from "../api/client";

/**
 * A hand-drawn SVG miniature of one resume template.
 *
 * Pure and dependency-free on purpose: no <img>, no network request, no
 * framer-motion — it renders eleven pages of vector text, so the picker costs
 * nothing to paint and works offline. Each miniature copies the real
 * STRUCTURAL signature of its template (the band, the rail, the two columns,
 * the heading-rule style, the centred serif name), not just its hue: someone
 * glancing at the row has to tell the eleven apart WITHOUT reading the names.
 *
 * It draws REAL TEXT, not grey bars. A picker full of wireframes tells you
 * nothing about what you are picking; a picker full of documents does. Every
 * template shows the SAME invented resume (`MAYA ELDAR`, below) so the eleven
 * thumbnails differ in design and only in design. The person is fictional on
 * purpose — nothing here should read as a claim about anyone real.
 *
 * At 116 px wide the type is around 2.5 px tall and reads as texture, which is
 * exactly what a page looks like from across the room; zoomed in it still has
 * to hold up as a plausible resume, so the words are the real words.
 *
 * The whole sheet is mirrored under RTL (`rtl:-scale-x-100`) so a rail that
 * hugs the text start in Hebrew hugs the right edge, exactly like the rendered
 * PDF does. Every <text> then flips back about its OWN box (`UNMIRROR`), which
 * mirrors the layout without reversing the glyphs.
 *
 * Coordinate system is one page: 132 × 186 (≈3:4), 10pt margins.
 */

const PAPER = "#FFFFFF";
const INK = "#39414E"; // body copy
const STRONG = "#1B222D"; // role titles / employers
const MUTED = "#8A93A0"; // dates, contact, meta lines
const WHITE = "#FFFFFF";
const BLACK = "#141414";

/** Accent per template — the same colours the renderers print with. */
export const TEMPLATE_ACCENTS: Record<ResumeTemplate, string> = {
  // Monochrome by design — `standard` reproduces a document that has no accent
  // colour at all, so its "accent" is the near-black its headings are set in.
  standard: "#232323",
  classic: "#1F3A5F",
  modern: "#0E7A5F",
  split: "#15476B",
  panel: "#15476B",
  timeline: "#2A5D7C",
  executive: "#16304B",
  ivy: "#1B2430",
  ledger: "#B4451F",
  student: "#2E6B4F",
  compact: "#27405C",
  minimal: "#374151",
};

/** Paper stock, where it isn't plain white. */
const TEMPLATE_PAPER: Partial<Record<ResumeTemplate, string>> = {
  executive: "#FDFBF4", // warm paper
};

const MODERN_BAND = "#0B5344";
const STUDENT_BAND = "#E8F1EC";

/** `pdf_family` in templates.py is Spectral (serif) for executive + ivy only. */
const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Arial, sans-serif";
const SERIF = "ui-serif, Georgia, 'Times New Roman', serif";

/**
 * Flip each glyph run back about its own box, so the page mirrors under RTL
 * but the words don't come out backwards. `fill-box` is what makes the origin
 * the text's own bounding box instead of the SVG viewBox.
 *
 * `direction: ltr` is not decoration. SVG resolves `text-anchor: start` against
 * the INHERITED direction, so under `dir="rtl"` every left-anchored run silently
 * became right-anchored and the whole page slid off its own edge. This sheet
 * mirrors itself, so each run must be measured left-to-right regardless.
 */
const UNMIRROR: CSSProperties = {
  transformBox: "fill-box",
  transformOrigin: "center",
  direction: "ltr",
};

/* ------------------------------------------------------------------ *
 * The demo resume. Invented, generic, and identical across all eleven.
 * ------------------------------------------------------------------ */

const NAME = "MAYA ELDAR";
const HEADLINE = "Senior Product Manager · B2B SaaS";
const HEADLINE_SHORT = "Senior Product Manager";
const CONTACT =
  "maya.eldar@example.com · +972 54-000-0000 · Tel Aviv · linkedin.com/in/mayaeldar";
const CONTACT_LINES = [
  "maya.eldar@example.com",
  "+972 54-000-0000",
  "Tel Aviv",
  "linkedin.com/in/mayaeldar",
];
/** Headline + contact on one line, for the templates whose header is two lines. */
const SUBLINE = `${HEADLINE} · maya.eldar@example.com · Tel Aviv`;

const SUMMARY =
  "Product manager with eight years taking B2B tools from first customer to steady revenue. I work close to the engineers and closer to the users, and I measure whether the thing shipped actually changed a number.";

interface Role {
  title: string;
  place: string;
  dates: string;
  bullets: string[];
}

const ROLES: Role[] = [
  {
    title: "Senior Product Manager — Latitude",
    place: "Tel Aviv",
    dates: "2022 – Present",
    bullets: [
      "Led the billing rebuild that cut involuntary churn from 4.1% to 1.6% in two quarters.",
      "Took the onboarding flow from eleven screens to four; activation rose 34%.",
      "Run a weekly call with six enterprise accounts, which is where the roadmap actually comes from.",
    ],
  },
  {
    title: "Product Manager — Northwind",
    place: "Tel Aviv",
    dates: "2019 – 2022",
    bullets: [
      "Shipped the reporting suite that became the reason 40% of renewals cited for staying.",
      "Replaced a quarterly release train with continuous delivery, cutting lead time from 38 days to 4.",
    ],
  },
  {
    title: "Associate Product Manager — Kestrel",
    place: "Remote",
    dates: "2017 – 2019",
    bullets: ["Owned the mobile checkout rewrite; cart abandonment fell 12 points."],
  },
];

const PROJECTS = [
  "Pricing Sandbox — an internal tool that lets sales model a discount and see the margin impact before the call, not after it.",
  "Churn Signals — a weekly digest that ranks accounts by risk and says which behaviour changed, so CS opens the right conversation.",
];

const SKILL_GROUPS: [string, string][] = [
  ["Product", "discovery, roadmapping, pricing, A/B testing, analytics"],
  ["Technical", "SQL, Figma, Amplitude, Jira, REST APIs"],
  ["Leadership", "stakeholder alignment, hiring, mentoring"],
];

const EDUCATION = "B.Sc. Industrial Engineering — Technion";
const EDU_DATES = "2013 – 2017";
const LANGUAGES = "Hebrew (native), English (fluent)";

/* ------------------------------------------------------------------ *
 * A very small text-flow engine.
 *
 * SVG <text> does not wrap, so lines are broken here against an average
 * advance width (`cw`, in ems). It only has to be close: the root <svg>
 * clips, so the failure mode of a bad estimate is a slightly short line,
 * never a page that breaks its container.
 * ------------------------------------------------------------------ */

function wrap(text: string, width: number, size: number, cw: number): string[] {
  const max = Math.max(6, Math.floor(width / (size * cw)));
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > max && line) {
      out.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) out.push(line);
  return out;
}

interface Flow {
  out: ReactNode[];
  /** Text start edge and measure of the current column. */
  x: number;
  width: number;
  /** Baseline of the next line. */
  y: number;
  /** Body size, line advance, section-heading size. */
  s: number;
  gap: number;
  head: number;
  fam: string;
  cw: number;
  ink: string;
  strong: string;
  muted: string;
  accent: string;
  /** Last baseline that may still be drawn. */
  bottom: number;
}

type FlowInit = Pick<Flow, "x" | "width" | "y" | "accent"> & Partial<Flow>;

function flow(init: FlowInit): Flow {
  return {
    out: [],
    s: 2.9,
    gap: 4.2,
    head: 3.5,
    fam: SANS,
    cw: 0.5,
    ink: INK,
    strong: STRONG,
    muted: MUTED,
    bottom: 178,
    ...init,
  };
}

interface TxtOpt {
  x?: number;
  y?: number;
  s?: number;
  fill?: string;
  weight?: number;
  ls?: number;
  anchor?: "start" | "middle" | "end";
  fam?: string;
  /** The italic tail of a `entry="run"` head — the one place this sheet sets
   *  a second style on one line, exactly as the renderers do. */
  italic?: boolean;
}

/** One run of text on the current (or an explicit) baseline. */
function txt(f: Flow, text: string, o: TxtOpt = {}) {
  f.out.push(
    <text
      x={o.x ?? f.x}
      y={o.y ?? f.y}
      fontSize={o.s ?? f.s}
      fontFamily={o.fam ?? f.fam}
      fontWeight={o.weight}
      letterSpacing={o.ls}
      fontStyle={o.italic ? "italic" : undefined}
      textAnchor={o.anchor}
      fill={o.fill ?? f.ink}
      style={UNMIRROR}
      className="rtl:-scale-x-100"
    >
      {text}
    </text>,
  );
}

/** Wrapped prose. Advances the baseline; stops dead at the page bottom. */
function para(f: Flow, text: string, o: TxtOpt & { width?: number; gap?: number } = {}) {
  const s = o.s ?? f.s;
  const x = o.x ?? f.x;
  const width = o.width ?? f.width - (x - f.x);
  const gap = o.gap ?? f.gap;
  for (const line of wrap(text, width, s, f.cw)) {
    if (f.y > f.bottom) return;
    txt(f, line, { ...o, x, s });
    f.y += gap;
  }
}

/** A hanging-indent list. `hang` puts the glyph OUTSIDE the text column. */
function bullets(
  f: Flow,
  items: string[],
  o: { glyph?: string; cap?: number; hang?: number; glyphFill?: string } = {},
) {
  const glyph = o.glyph ?? "•";
  const ind = o.hang != null ? 0 : f.s * 1.7;
  const gx = o.hang != null ? f.x - o.hang : f.x;
  for (const item of items.slice(0, o.cap ?? items.length)) {
    if (f.y > f.bottom - f.gap) return;
    txt(f, glyph, { x: gx, fill: o.glyphFill ?? f.muted });
    para(f, item, { x: f.x + ind, width: f.width - ind });
    f.y += 0.7;
  }
}

/** Title + dates. `split` flushes the dates to the far edge of the column. */
function entry(f: Flow, r: Role, split: boolean, run = false) {
  if (f.y > f.bottom - f.gap) return;
  if (run) {
    // entry="run": the whole head on ONE line — the bold identity, then the
    // italic circumstance immediately after it. At this size the difference
    // that reads is the density: one line per role instead of two.
    txt(f, r.title, { s: f.s + 0.35, weight: 700, fill: f.strong });
    txt(f, `  ${r.place} | ${r.dates}`, {
      x: f.x + (r.title.length + 1) * (f.s + 0.35) * f.cw,
      s: f.s - 0.15,
      italic: true,
      fill: f.strong,
    });
    f.y += f.gap;
    return;
  }
  txt(f, r.title, { s: f.s + 0.35, weight: 700, fill: f.strong });
  if (split) {
    txt(f, r.dates, { x: f.x + f.width, anchor: "end", s: f.s - 0.15, fill: f.muted });
    f.y += f.gap + 0.7;
    txt(f, r.place, { s: f.s - 0.15, fill: f.muted });
  } else {
    f.y += f.gap + 0.7;
    txt(f, `${r.place} · ${r.dates}`, { s: f.s - 0.15, fill: f.muted });
  }
  f.y += f.gap;
}

type Head = (label: string) => void;
type HeadKind = "rule" | "short" | "bar" | "plain" | "centered" | "hung";

interface HeadOpt {
  color?: string;
  ruleColor?: string;
  ruleH?: number;
  ruleO?: number;
  shortW?: number;
  barW?: number;
  hangX?: number;
  size?: number;
  after?: number;
}

/** Builds the section-heading grammar for one template. */
function headings(f: Flow, kind: HeadKind, o: HeadOpt = {}): Head {
  return (label) => {
    if (f.y > f.bottom - f.gap) return;
    const s = o.size ?? f.head;
    const color = o.color ?? f.accent;
    const after = o.after ?? 3.6;
    switch (kind) {
      case "rule": {
        txt(f, label, { s, weight: 700, ls: 0.35, fill: color });
        f.y += 2.5;
        f.out.push(
          <rect
            x={f.x}
            y={f.y}
            width={f.width}
            height={o.ruleH ?? 0.8}
            fill={o.ruleColor ?? color}
            opacity={o.ruleO ?? 0.45}
          />,
        );
        f.y += (o.ruleH ?? 0.8) + after;
        break;
      }
      case "short": {
        txt(f, label, { s, weight: 700, ls: 0.35, fill: color });
        f.y += 2.5;
        f.out.push(
          <rect x={f.x} y={f.y} width={o.shortW ?? 19} height={o.ruleH ?? 2.2} rx={1} fill={color} />,
        );
        f.y += (o.ruleH ?? 2.2) + after;
        break;
      }
      case "bar": {
        const bw = o.barW ?? 3;
        f.out.push(
          <rect x={f.x} y={f.y - s * 0.82} width={bw} height={s * 1.05} rx={0.9} fill={color} />,
        );
        txt(f, label, { x: f.x + bw + 2.6, s, weight: 700, ls: 0.3, fill: f.strong });
        f.y += after + 1.6;
        break;
      }
      case "plain": {
        txt(f, label, { s, weight: 700, ls: 0.35, fill: color });
        f.y += after + 1.6;
        break;
      }
      case "centered": {
        txt(f, label, {
          x: f.x + f.width / 2,
          anchor: "middle",
          s,
          weight: 700,
          ls: 0.3,
          fill: color,
        });
        f.y += 2.5;
        f.out.push(
          <rect
            x={f.x}
            y={f.y}
            width={f.width}
            height={o.ruleH ?? 0.7}
            fill={o.ruleColor ?? color}
            opacity={o.ruleO ?? 0.3}
          />,
        );
        f.y += (o.ruleH ?? 0.7) + after;
        break;
      }
      case "hung": {
        // The heading sits in the start margin, level with the first body
        // line — so it deliberately does NOT advance the baseline.
        txt(f, label, { x: o.hangX ?? f.x - 33, s, weight: 700, ls: 0.3, fill: color });
        break;
      }
    }
  };
}

interface BodyOpt {
  glyph?: string;
  hang?: number;
  split?: boolean;
  cap?: number;
  projects?: boolean;
  skills?: boolean;
  education?: boolean;
  title?: boolean;
  sectionGap?: number;
  /** `TemplateSpec.label_set` — the longer business wording `standard` prints.
   *  Only the four headings the two sets disagree about are listed; the rest are
   *  the same word in both. */
  full?: boolean;
  /** entry="run": the whole entry head on one line. */
  run?: boolean;
}

/** The main column: the same document, told in one template's grammar. */
function body(f: Flow, h: Head, o: BodyOpt = {}) {
  const sg = o.sectionGap ?? 3.2;
  const L = (upper: string, title: string) => (o.title ? title : upper);

  h(o.full ? "PROFESSIONAL SUMMARY" : L("SUMMARY", "Summary"));
  para(f, SUMMARY);
  f.y += sg;

  h(o.full ? "PROFESSIONAL EXPERIENCE" : L("EXPERIENCE", "Experience"));
  for (const r of ROLES) {
    if (f.y > f.bottom - f.gap * 2) break;
    entry(f, r, !!o.split, !!o.run);
    bullets(f, r.bullets, { glyph: o.glyph, hang: o.hang, cap: o.cap ?? 2 });
    f.y += 1.2;
  }
  f.y += sg - 1.2;

  // Each remaining section is emitted only if its heading would get content
  // under it: a heading orphaned at the page break reads as a rendering bug.
  if (o.projects && room(f, f.gap * 2)) {
    h(o.full ? "SELECTED PROJECTS" : L("PROJECTS", "Projects"));
    bullets(f, PROJECTS, { glyph: o.glyph, hang: o.hang });
    f.y += sg;
  }
  if (o.skills !== false && room(f, f.gap)) {
    h(o.full ? "CORE EXPERTISE" : L("SKILLS", "Skills"));
    for (const [group, list] of SKILL_GROUPS) para(f, `${group}: ${list}`);
    f.y += sg;
  }
  if (o.education !== false && room(f, f.gap * 2)) {
    h(L("EDUCATION", "Education"));
    txt(f, EDUCATION, { weight: 700, fill: f.strong });
    txt(f, EDU_DATES, { x: f.x + f.width, anchor: "end", s: f.s - 0.15, fill: f.muted });
    f.y += f.gap + 0.7;
    txt(f, LANGUAGES, { s: f.s - 0.15, fill: f.muted });
    f.y += f.gap;
  }
}

/** The rail column of a two-column template: contact, skills, the short facts. */
function railColumn(f: Flow, h: Head) {
  h("CONTACT");
  for (const line of CONTACT_LINES) para(f, line);
  f.y += 3;
  h("SKILLS");
  for (const [group, list] of SKILL_GROUPS) {
    txt(f, group, { weight: 700, fill: f.strong });
    f.y += f.gap;
    para(f, list);
    f.y += 1.4;
  }
  f.y += 1.8;
  h("EDUCATION");
  para(f, EDUCATION);
  txt(f, EDU_DATES, { fill: f.muted });
  f.y += f.gap + 2.6;
  h("LANGUAGES");
  para(f, LANGUAGES);
}

/** Is there room for a heading plus `need` of content? */
function room(f: Flow, need: number) {
  return f.y + f.head + 3 + need <= f.bottom;
}

function keyed(nodes: ReactNode[]) {
  return nodes.map((n, i) => <Fragment key={i}>{n}</Fragment>);
}

function art(id: ResumeTemplate, a: string) {
  switch (id) {
    // 1col, tinted header card, full-width rules under headings.
    case "classic": {
      const f = flow({ x: 10, width: 112, y: 48, accent: a });
      f.out.push(
        <rect x={8} y={8} width={116} height={32} rx={2} fill={a} opacity={0.13} />,
        <rect
          x={8}
          y={8}
          width={116}
          height={32}
          rx={2}
          fill="none"
          stroke={a}
          strokeOpacity={0.2}
          strokeWidth={0.8}
        />,
      );
      txt(f, NAME, { x: 14, y: 20, s: 7, weight: 700, ls: 0.5, fill: a });
      txt(f, HEADLINE, { x: 14, y: 27.5, s: 3, fill: STRONG });
      txt(f, CONTACT, { x: 14, y: 34.5, s: 2.3, fill: MUTED });
      body(f, headings(f, "rule"));
      return keyed(f.out);
    }

    // 1col, full-bleed dark colour band, short thick accent underlines.
    case "modern": {
      const f = flow({ x: 10, width: 112, y: 56, accent: a });
      f.out.push(<rect x={0} y={0} width={132} height={46} fill={MODERN_BAND} />);
      txt(f, NAME, { x: 10, y: 20, s: 7, weight: 700, ls: 0.5, fill: WHITE });
      txt(f, HEADLINE, { x: 10, y: 28, s: 3.1, fill: "#BFDDD2" });
      txt(f, CONTACT, { x: 10, y: 35.5, s: 2.3, fill: "#9EC4B8" });
      body(f, headings(f, "short", { shortW: 19, ruleH: 2.4 }));
      return keyed(f.out);
    }

    // 2col, narrow rail at the text start, full-width header card.
    case "split": {
      const out: ReactNode[] = [
        <rect x={8} y={8} width={116} height={28} rx={2} fill={a} opacity={0.13} />,
        <rect
          x={8}
          y={8}
          width={116}
          height={28}
          rx={2}
          fill="none"
          stroke={a}
          strokeOpacity={0.2}
          strokeWidth={0.8}
        />,
        <rect x={8} y={42} width={34} height={136} rx={2} fill={a} opacity={0.1} />,
        <rect x={45.5} y={42} width={0.9} height={136} fill={a} opacity={0.4} />,
      ];
      const head = flow({ x: 14, width: 104, y: 19, accent: a, out });
      txt(head, NAME, { s: 6.5, weight: 700, ls: 0.45, fill: a });
      txt(head, HEADLINE, { y: 26.5, s: 2.9, fill: STRONG });
      txt(head, CONTACT, { y: 33, s: 2.3, fill: MUTED });

      const rail = flow({
        x: 12,
        width: 26,
        y: 49,
        accent: a,
        s: 2.3,
        gap: 3.4,
        head: 2.8,
        out,
      });
      railColumn(rail, headings(rail, "short", { shortW: 9, ruleH: 1.4, after: 2.6 }));

      const main = flow({
        x: 50,
        width: 74,
        y: 49,
        accent: a,
        s: 2.7,
        gap: 4,
        head: 3.2,
        out,
      });
      body(main, headings(main, "short", { shortW: 15, ruleH: 2, after: 3.2 }), {
        projects: true,
        skills: false,
        education: false,
      });
      return keyed(out);
    }

    // 2col, a filled colour panel running the full height of the page.
    case "panel": {
      const out: ReactNode[] = [<rect x={0} y={0} width={48} height={186} fill={a} />];
      const rail = flow({
        x: 7,
        width: 34,
        y: 17,
        accent: WHITE,
        s: 2.4,
        gap: 3.5,
        head: 2.9,
        ink: "#DCE9F2",
        strong: WHITE,
        muted: "#A9C4D9",
        out,
      });
      txt(rail, NAME, { s: 5, weight: 700, ls: 0.3, fill: WHITE });
      txt(rail, HEADLINE_SHORT, { y: 24, s: 2.4, fill: "#BBD3E4" });
      out.push(<rect x={7} y={31} width={18} height={0.8} fill={WHITE} opacity={0.45} />);
      rail.y = 41;
      railColumn(rail, headings(rail, "plain", { color: WHITE, after: 2.4 }));

      const main = flow({
        x: 56,
        width: 68,
        y: 16,
        accent: a,
        s: 2.75,
        gap: 4,
        head: 3.3,
        out,
      });
      body(main, headings(main, "bar", { barW: 2.6 }), {
        projects: true,
        skills: false,
        education: false,
      });
      return keyed(out);
    }

    // 1col, a vertical rail with one dot per block, no heading rules.
    case "timeline": {
      const f = flow({ x: 28, width: 94, y: 48, accent: a, s: 2.85, gap: 4.15, head: 3.4 });
      txt(f, NAME, { x: 10, y: 17, s: 6.8, weight: 700, ls: 0.45, fill: a });
      txt(f, HEADLINE, { x: 10, y: 25, s: 3, fill: STRONG });
      txt(f, CONTACT, { x: 10, y: 32, s: 2.3, fill: MUTED });

      const dots: number[] = [];
      const plain = headings(f, "plain");
      body(
        f,
        (label) => {
          if (f.y > f.bottom - f.gap) return;
          dots.push(f.y - 1.1);
          plain(label);
        },
        { cap: 2 },
      );
      const top = (dots[0] ?? 48) - 4;
      f.out.unshift(
        <rect x={18} y={top} width={0.9} height={176 - top} fill={a} opacity={0.45} />,
      );
      for (const cy of dots) {
        f.out.push(
          <circle cx={18.45} cy={cy} r={3.2} fill={a} />,
          <circle cx={18.45} cy={cy} r={1.2} fill={TEMPLATE_PAPER.timeline ?? PAPER} />,
        );
      }
      return keyed(f.out);
    }

    // Centred serif name between two rules, no heading rules, cream paper.
    case "executive": {
      const f = flow({
        x: 12,
        width: 108,
        y: 66,
        accent: a,
        s: 3,
        gap: 4.4,
        head: 3.5,
        fam: SERIF,
        cw: 0.51,
        ink: "#3B3B36",
        strong: "#1B1B18",
      });
      f.out.push(
        <rect x={14} y={20} width={104} height={0.9} fill={a} opacity={0.5} />,
        <rect x={14} y={47} width={104} height={0.9} fill={a} opacity={0.5} />,
      );
      txt(f, NAME, { x: 66, y: 33, anchor: "middle", s: 7.4, ls: 1.1, fill: a });
      txt(f, HEADLINE, { x: 66, y: 41.5, anchor: "middle", s: 3, fill: "#5A5F6A" });
      txt(f, CONTACT, { x: 66, y: 55, anchor: "middle", s: 2.4, fill: "#6E7078" });
      body(f, headings(f, "plain", { after: 3 }), { title: true, glyph: "—", cap: 2 });
      return keyed(f.out);
    }

    // Centred serif name, centred title-case headings over a hairline.
    case "ivy": {
      const f = flow({
        x: 10,
        width: 112,
        y: 42,
        accent: a,
        s: 2.95,
        gap: 4.35,
        head: 3.4,
        fam: SERIF,
        cw: 0.51,
        ink: "#333A44",
        strong: "#121820",
      });
      txt(f, NAME, { x: 66, y: 19, anchor: "middle", s: 7.4, ls: 1.1, fill: a });
      txt(f, HEADLINE, { x: 66, y: 26.5, anchor: "middle", s: 2.9, fill: "#4B535E" });
      txt(f, CONTACT, { x: 66, y: 33, anchor: "middle", s: 2.4, fill: "#6A717B" });
      body(f, headings(f, "centered"), { title: true, split: true, cap: 2 });
      return keyed(f.out);
    }

    // 1col, heavy 2pt black rules, dense, rust accent.
    case "ledger": {
      const f = flow({
        x: 10,
        width: 112,
        y: 35,
        accent: a,
        s: 2.7,
        gap: 3.85,
        head: 3.3,
        ink: "#33373B",
        strong: BLACK,
      });
      txt(f, NAME, { y: 17, s: 6.6, weight: 700, ls: 0.4, fill: BLACK });
      txt(f, SUBLINE, { y: 24, s: 2.4, fill: "#6A6A6A" });
      f.out.push(<rect x={10} y={27} width={112} height={2.4} fill={BLACK} />);
      body(f, headings(f, "rule", { ruleColor: BLACK, ruleH: 1.8, ruleO: 1, after: 3.2 }), {
        cap: 3,
        sectionGap: 2.6,
      });
      return keyed(f.out);
    }

    // 1col, soft green header card, short accent underlines.
    case "student": {
      const f = flow({ x: 10, width: 112, y: 48, accent: a });
      f.out.push(<rect x={8} y={8} width={116} height={32} rx={2} fill={STUDENT_BAND} />);
      txt(f, NAME, { x: 14, y: 20, s: 7, weight: 700, ls: 0.5, fill: a });
      txt(f, HEADLINE, { x: 14, y: 27.5, s: 3, fill: "#2F4A3C" });
      txt(f, CONTACT, { x: 14, y: 34.5, s: 2.3, fill: "#5B6560" });
      body(f, headings(f, "short", { shortW: 14, ruleH: 2 }));
      return keyed(f.out);
    }

    // 1col, dense, a 2pt accent bar beside each heading.
    case "compact": {
      const f = flow({ x: 10, width: 112, y: 30, accent: a, s: 2.7, gap: 3.85, head: 3.3 });
      txt(f, NAME, { y: 15, s: 5.6, weight: 700, ls: 0.4, fill: STRONG });
      txt(f, SUBLINE, { y: 21.5, s: 2.4, fill: MUTED });
      body(f, headings(f, "bar", { barW: 2.6, after: 3 }), { cap: 3, sectionGap: 2.6 });
      return keyed(f.out);
    }

    // 1col, no colour, headings hung in the start margin, en-dash bullets.
    // 1col, centred monochrome header with NO rule under it, full-width
    // hairlines under all-caps headings, the longer business section names, and
    // one dense column. The default, and the one thumbnail that draws a
    // reproduction rather than a design.
    case "standard": {
      const f = flow({
        x: 9,
        width: 114,
        y: 40,
        accent: a,
        s: 2.7,
        gap: 3.9,
        head: 3.1,
        ink: "#141414",
        strong: BLACK,
        muted: "#141414",
      });
      txt(f, NAME, { x: 66, y: 17, anchor: "middle", s: 6.4, weight: 700, fill: "#191919" });
      txt(f, HEADLINE, { x: 66, y: 24, anchor: "middle", s: 3.1, weight: 700, fill: "#414141" });
      txt(f, CONTACT, { x: 66, y: 30.5, anchor: "middle", s: 2.3, fill: BLACK });
      body(f, headings(f, "rule", { color: "#232323", ruleColor: "#A8A8A8", ruleH: 0.55 }), {
        full: true,
        run: true,
        cap: 2,
        sectionGap: 2.8,
      });
      return keyed(f.out);
    }

    case "minimal": {
      const f = flow({
        x: 39,
        width: 85,
        y: 36,
        accent: a,
        s: 2.8,
        gap: 4,
        head: 3,
        muted: "#9CA3AF",
      });
      txt(f, NAME, { x: 8, y: 16, s: 5.4, weight: 700, ls: 0.4, fill: a });
      txt(f, CONTACT, { x: 8, y: 23, s: 2.3, fill: "#9CA3AF" });
      body(f, headings(f, "hung", { hangX: 6, color: "#6B7280" }), {
        glyph: "–",
        hang: 7,
        cap: 2,
        sectionGap: 4.2,
      });
      return keyed(f.out);
    }
  }
}

interface TemplateThumbProps {
  id: ResumeTemplate;
  /** Classes for the paper wrapper (sizing lives on the caller). */
  className?: string;
}

export default function TemplateThumb({ id, className }: TemplateThumbProps) {
  return (
    <span
      className={cn(
        "block overflow-hidden rounded-[4px] shadow-sm ring-1 ring-black/10",
        className,
      )}
      style={{ backgroundColor: TEMPLATE_PAPER[id] ?? PAPER }}
    >
      <svg
        viewBox="0 0 132 186"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden
        focusable="false"
        // geometricPrecision keeps advance widths true at this size, which is
        // what the line-breaker above is estimating against.
        style={{ textRendering: "geometricPrecision" }}
        className="block h-auto w-full rtl:-scale-x-100"
      >
        <rect x={0} y={0} width={132} height={186} fill={TEMPLATE_PAPER[id] ?? PAPER} />
        {art(id, TEMPLATE_ACCENTS[id])}
      </svg>
    </span>
  );
}
