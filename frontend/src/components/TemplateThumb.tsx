import { cn } from "../lib/cn";
import type { ResumeTemplate } from "../api/client";

/**
 * A hand-drawn SVG miniature of one résumé template.
 *
 * Pure and dependency-free on purpose: no <img>, no network request, no
 * framer-motion — it renders eleven pages of rects and lines, so the picker
 * costs nothing to paint and works offline. Each miniature copies the real
 * STRUCTURAL signature of its template (the band, the rail, the two columns,
 * the heading-rule style, the centred serif name), not just its hue: someone
 * glancing at the row has to tell the eleven apart WITHOUT reading the names.
 *
 * The whole sheet is mirrored under RTL (`rtl:-scale-x-100`) so a rail that
 * hugs the text start in Hebrew hugs the right edge, exactly like the rendered
 * PDF does.
 *
 * Coordinate system is one page: 132 × 186 (≈3:4), 10pt margins.
 */

const PAPER = "#FFFFFF";
const STRONG = "#3F4854"; // role titles / dark headings
const BODY = "#AAB3C0"; // body copy
const FAINT = "#D3D9E1"; // dates, contact bits
const WHITE = "#FFFFFF";
const BLACK = "#1A1A1A";

/** Accent per template — the same colours the renderers print with. */
export const TEMPLATE_ACCENTS: Record<ResumeTemplate, string> = {
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

interface BarProps {
  x: number;
  y: number;
  w: number;
  h?: number;
  fill?: string;
  o?: number;
  rx?: number;
}

/** One line of "text". */
function Bar({ x, y, w, h = 2.4, fill = BODY, o, rx }: BarProps) {
  return (
    <rect x={x} y={y} width={w} height={h} rx={rx ?? Math.min(h / 2, 1.2)} fill={fill} opacity={o} />
  );
}

/** A hairline / rule — square ends, unlike the rounded text bars. */
function Rule({ x, y, w, h = 0.9, fill, o }: BarProps & { fill: string }) {
  return <rect x={x} y={y} width={w} height={h} fill={fill} opacity={o} />;
}

// Ragged right edge, so a block of bars reads as prose rather than a barcode.
const RUN = [1, 0.93, 0.98, 0.86, 0.96, 0.9];

/** A paragraph: `n` ragged lines. */
function Para({
  x,
  y,
  w,
  n,
  gap = 5.4,
  h = 2.4,
  fill = BODY,
  o,
}: Omit<BarProps, "rx"> & { n: number; gap?: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <Bar key={i} x={x} y={y + i * gap} w={w * RUN[i % RUN.length]} h={h} fill={fill} o={o} />
      ))}
    </>
  );
}

/** A name set in serif: the bar plus bracket "feet" at both ends. */
function SerifName({ cx, y, w, h = 6, fill }: { cx: number; y: number; w: number; h?: number; fill: string }) {
  const x = cx - w / 2;
  return (
    <>
      <rect x={x} y={y} width={w} height={h} rx={0.6} fill={fill} />
      <rect x={x - 1.8} y={y - 1.3} width={1.8} height={h + 2.6} rx={0.4} fill={fill} opacity={0.5} />
      <rect x={x + w} y={y - 1.3} width={1.8} height={h + 2.6} rx={0.4} fill={fill} opacity={0.5} />
    </>
  );
}

/* eslint-disable react/jsx-key -- fragments below are static, not lists */
function art(id: ResumeTemplate, a: string) {
  switch (id) {
    // 1col, tinted header card, full-width rules under headings.
    case "classic":
      return (
        <>
          <rect x={8} y={8} width={116} height={32} rx={2} fill={a} opacity={0.13} />
          <rect x={8} y={8} width={116} height={32} rx={2} fill="none" stroke={a} strokeOpacity={0.2} strokeWidth={0.8} />
          <Bar x={14} y={15} w={52} h={5.5} fill={a} />
          <Bar x={14} y={24} w={34} h={2.8} />
          <Bar x={14} y={31} w={62} h={2.2} fill={FAINT} />
          {[50, 96, 142].map((y) => (
            <g key={y}>
              <Bar x={10} y={y} w={28} h={4} fill={a} />
              <Rule x={10} y={y + 7} w={112} fill={a} o={0.45} />
              <Para x={10} y={y + 12} w={112} n={5} />
            </g>
          ))}
        </>
      );

    // 1col, full-bleed dark colour band, short thick accent underlines.
    case "modern":
      return (
        <>
          <rect x={0} y={0} width={132} height={46} fill={MODERN_BAND} />
          <Bar x={10} y={13} w={56} h={6} fill={WHITE} />
          <Bar x={10} y={23} w={38} h={3} fill={WHITE} o={0.62} />
          <Bar x={10} y={31} w={64} h={2.4} fill={WHITE} o={0.4} />
          {[58, 100, 142].map((y) => (
            <g key={y}>
              <Bar x={10} y={y} w={26} h={4} fill={a} />
              <Bar x={10} y={y + 6.5} w={19} h={2.8} fill={a} rx={1} />
              <Para x={10} y={y + 13} w={112} n={5} />
            </g>
          ))}
        </>
      );

    // 2col, narrow rail at the text start, full-width header card.
    case "split":
      return (
        <>
          <rect x={8} y={8} width={116} height={28} rx={2} fill={a} opacity={0.13} />
          <rect x={8} y={8} width={116} height={28} rx={2} fill="none" stroke={a} strokeOpacity={0.2} strokeWidth={0.8} />
          <Bar x={14} y={14} w={50} h={5.5} fill={a} />
          <Bar x={14} y={23} w={32} h={2.6} />
          <Bar x={14} y={29} w={58} h={2.2} fill={FAINT} />
          <rect x={8} y={42} width={34} height={136} rx={2} fill={a} opacity={0.10} />
          {[48, 84, 120].map((y, i) => (
            <g key={y}>
              <Bar x={12} y={y} w={[20, 18, 22][i]} h={3.2} fill={a} />
              <Para x={12} y={y + 8} w={26} n={[4, 4, 3][i]} gap={5} h={2.2} />
            </g>
          ))}
          <Rule x={45.5} y={42} w={0.9} h={136} fill={a} o={0.4} />
          {[46, 96, 140].map((y) => (
            <g key={y}>
              <Bar x={50} y={y} w={24} h={3.6} fill={a} />
              <Rule x={50} y={y + 6} w={74} h={0.8} fill={a} o={0.3} />
              <Para x={50} y={y + 11} w={74} n={5} gap={5} h={2.2} />
            </g>
          ))}
        </>
      );

    // 2col, a filled colour panel running the full height of the page.
    case "panel":
      return (
        <>
          <rect x={0} y={0} width={48} height={186} fill={a} />
          <Bar x={7} y={14} w={32} h={5} fill={WHITE} />
          <Bar x={7} y={23} w={24} h={2.6} fill={WHITE} o={0.6} />
          <Rule x={7} y={31} w={18} h={0.8} fill={WHITE} o={0.45} />
          {[40, 76, 112].map((y, i) => (
            <g key={y}>
              <Bar x={7} y={y} w={[20, 18, 22][i]} h={3} fill={WHITE} o={0.85} />
              <Para x={7} y={y + 7} w={34} n={[4, 4, 5][i]} gap={5} h={2.2} fill={WHITE} o={0.45} />
            </g>
          ))}
          {[14, 62, 110, 154].map((y, i) => (
            <g key={y}>
              <Bar x={56} y={y} w={24} h={3.8} fill={a} />
              <Rule x={56} y={y + 6.4} w={68} h={0.8} fill={a} o={0.28} />
              <Para x={56} y={y + 11.5} w={68} n={[5, 5, 5, 3][i]} gap={5.2} />
            </g>
          ))}
        </>
      );

    // 1col, a vertical rail with one dot per role, no heading rules.
    case "timeline":
      return (
        <>
          <Bar x={10} y={12} w={58} h={5.5} fill={a} />
          <Bar x={10} y={21} w={36} h={2.8} />
          <Bar x={10} y={28} w={64} h={2.2} fill={FAINT} />
          <Rule x={18} y={44} w={0.9} h={132} fill={a} o={0.45} />
          {[46, 80, 114, 148].map((y) => (
            <g key={y}>
              <circle cx={18.45} cy={y + 2.5} r={3.4} fill={a} />
              <circle cx={18.45} cy={y + 2.5} r={1.3} fill={PAPER} />
              <Bar x={28} y={y} w={52} h={4} fill={STRONG} />
              <Bar x={28} y={y + 7} w={34} h={2.2} fill={FAINT} />
              <Para x={28} y={y + 13} w={94} n={3} gap={5} />
            </g>
          ))}
        </>
      );

    // Centred serif name between two rules, no heading rules, cream paper.
    case "executive":
      return (
        <>
          <Rule x={14} y={20} w={104} fill={a} o={0.5} />
          <SerifName cx={66} y={27} w={64} fill={a} />
          <Bar x={46} y={38} w={40} h={2.6} />
          <Rule x={14} y={47} w={104} fill={a} o={0.5} />
          <Bar x={38} y={53} w={56} h={2.2} fill={FAINT} />
          {[66, 108, 150].map((y) => (
            <g key={y}>
              <Bar x={12} y={y} w={30} h={3.8} fill={a} />
              <Para x={12} y={y + 8} w={108} n={5} gap={5.2} />
            </g>
          ))}
        </>
      );

    // Centred serif name, centred title-case headings over a hairline.
    case "ivy":
      return (
        <>
          <SerifName cx={66} y={13} w={68} fill={a} />
          <Bar x={37} y={24} w={58} h={2.3} fill={FAINT} />
          {[40, 88, 136].map((y) => (
            <g key={y}>
              <Bar x={48} y={y} w={36} h={3.4} fill={a} />
              <Rule x={10} y={y + 6} w={112} h={0.7} fill={a} o={0.3} />
              <Para x={10} y={y + 11} w={112} n={6} gap={5.2} />
            </g>
          ))}
        </>
      );

    // 1col, heavy 2pt black rules, dense, rust accent.
    case "ledger":
      return (
        <>
          <Bar x={10} y={11} w={62} h={6} fill={BLACK} rx={0.5} />
          <Bar x={10} y={21} w={52} h={2.2} fill={FAINT} />
          <Rule x={10} y={27} w={112} h={2.4} fill={BLACK} />
          {[34, 72, 110, 148].map((y, i) => (
            <g key={y}>
              <Bar x={10} y={y} w={26} h={3.6} fill={a} />
              <Rule x={10} y={y + 6} w={112} h={1.8} fill={BLACK} />
              <Para x={10} y={y + 11.5} w={112} n={[5, 5, 5, 4][i]} gap={4.6} h={2.2} />
            </g>
          ))}
        </>
      );

    // 1col, soft green header card, short accent underlines.
    case "student":
      return (
        <>
          <rect x={8} y={8} width={116} height={32} rx={2} fill={STUDENT_BAND} />
          <Bar x={14} y={15} w={50} h={5.5} fill={a} />
          <Bar x={14} y={24} w={34} h={2.8} fill={a} o={0.5} />
          <Bar x={14} y={31} w={60} h={2.2} fill={BODY} />
          {[50, 96, 142].map((y) => (
            <g key={y}>
              <Bar x={10} y={y} w={28} h={4} fill={a} />
              <Bar x={10} y={y + 6.5} w={14} h={2} fill={a} o={0.75} rx={1} />
              <Para x={10} y={y + 13} w={112} n={5} />
            </g>
          ))}
        </>
      );

    // 1col, dense, a 2pt accent bar beside each heading.
    case "compact":
      return (
        <>
          <Bar x={10} y={10} w={56} h={5} fill={STRONG} />
          <Bar x={10} y={19} w={68} h={2.2} fill={FAINT} />
          {[30, 68, 106, 144].map((y) => (
            <g key={y}>
              <Bar x={10} y={y - 0.5} w={3.2} h={5.4} fill={a} rx={1} />
              <Bar x={16} y={y} w={26} h={4} fill={STRONG} />
              <Para x={10} y={y + 8} w={112} n={6} gap={4.6} h={2.2} />
            </g>
          ))}
        </>
      );

    // 1col, no colour, headings hung in the start margin, en-dash bullets.
    case "minimal":
      return (
        <>
          <Bar x={8} y={12} w={54} h={5} fill={a} />
          <Bar x={8} y={21} w={48} h={2.2} fill="#9CA3AF" />
          {[38, 88, 138].map((y) => (
            <g key={y}>
              <Bar x={6} y={y} w={18} h={3} fill="#6B7280" />
              {[0, 1, 2, 3].map((j) => (
                <g key={j}>
                  <rect x={32} y={y + j * 11 + 0.6} width={4} height={1.2} fill="#9CA3AF" />
                  <Bar x={39} y={y + j * 11} w={85} h={2.3} />
                  <Bar x={39} y={y + j * 11 + 4.6} w={62} h={2.3} />
                </g>
              ))}
            </g>
          ))}
        </>
      );
  }
}
/* eslint-enable react/jsx-key */

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
        className="block h-auto w-full rtl:-scale-x-100"
      >
        <rect x={0} y={0} width={132} height={186} fill={TEMPLATE_PAPER[id] ?? PAPER} />
        {art(id, TEMPLATE_ACCENTS[id])}
      </svg>
    </span>
  );
}
