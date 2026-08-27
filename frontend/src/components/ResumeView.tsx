import { useTranslation } from "react-i18next";
import type { ResumeModel } from "../types";
import { Badge } from "./ui";
import { cn } from "../lib/cn";
import { dkey } from "../lib/resumeBlocks";

/** How a block relates to the tailoring. `changed` = the AI touched it and you
 * kept the change; `restored` = every edit on it was declined, so what you are
 * reading is your original wording. */
export type BlockMark = "changed" | "restored";

interface Props {
  resume: ResumeModel;
  /**
   * `"panel"` is the original in-app card (the tracker's détail modal);
   * `"sheet"` is the résumé as a page — white ground, page margins, a lift.
   */
  surface?: "panel" | "sheet";
  /** Block path → how it relates to the tailoring. Paths come from
   * `resumeDiff.mergeForReview`'s `blocks`, and must use the same grammar. */
  marks?: Map<string, BlockMark>;
  /** The block to spotlight right now (a jump from the review panel). */
  activeBlock?: string | null;
  /** Clicking a block asks the review panel to show its change. */
  onSelectBlock?: (path: string) => void;
  /** Clicking a block opens it for editing. Takes precedence over
   * `onSelectBlock`: a tailored draft is a review surface, a master résumé is
   * an editing one, and the page decides which by passing one or the other. */
  onEditBlock?: (path: string) => void;
}



/**
 * Mirror of `app/core/section_order.py` (PLAN 17.5) — Education outranks
 * Experience on an early-career résumé. Duplicated rather than fetched so the
 * preview can never lay out differently from the file the user downloads; the
 * Python side is the source of truth and is pinned by the smoke test.
 */
const EARLY_CAREER_YEARS = 3;
const STUDY_WINDOW_YEARS = 6;
const EXPERIENCED_ORDER = [
  "summary", "skills", "experience", "projects", "education", "military",
  "certifications", "languages",
] as const;
const EARLY_CAREER_ORDER = [
  "summary", "skills", "education", "experience", "projects", "military",
  "certifications", "languages",
] as const;
const CURRENT_RE = /present|current|now|today|ongoing|היום|כיום|הווה/i;

/**
 * Mirror of `app/core/skills.py::skill_blocks` (21.8), duplicated for the same
 * reason the section order is: the preview must never describe the Skills
 * section differently from the file the user downloads. Two properties carry
 * the weight and are the ones to preserve if this is ever edited — with no
 * groups it returns exactly the old flat block, and whatever the groups do not
 * claim is emitted as a trailing UNLABELLED block, because `resume.skills` is
 * the flat surface the scorer and the ATS x-ray read and a skill that renders
 * nowhere is an x-ray "missing" on the document we told the user to send.
 */
function skillBlocksOf(resume: ResumeModel): [string, string[]][] {
  const live = resume.skills.map((s) => s.trim()).filter(Boolean);
  const groups = resume.skill_groups ?? [];
  if (groups.length === 0) return live.length > 0 ? [["", live]] : [];

  const blocks: [string, string[]][] = [];
  const claimed = new Set<string>();
  for (const group of groups) {
    const items: string[] = [];
    const seen = new Set<string>();
    for (const raw of group.items) {
      const item = (raw || "").trim();
      const key = item.toLocaleLowerCase();
      if (!item || seen.has(key)) continue;
      seen.add(key);
      claimed.add(key);
      items.push(item);
    }
    if (items.length > 0) blocks.push([(group.label || "").trim(), items]);
  }
  const leftover = live.filter((s) => !claimed.has(s.toLocaleLowerCase()));
  if (leftover.length > 0) blocks.push(["", leftover]);
  return blocks;
}

/** Years of work, measured over the UNION of the roles so concurrent jobs are
 * not double counted. Year precision is enough to pick a layout. */
function yearsOfExperience(resume: ResumeModel): number {
  const yearOf = (d: string): number | null => {
    const m = /(?:19|20)\d{2}/.exec(d || "");
    return m ? Number(m[0]) : null;
  };
  const spans = resume.experience
    .map((e) => {
      const start = yearOf(e.start_date);
      if (start === null) return null;
      const end =
        yearOf(e.end_date) ??
        (!e.end_date || CURRENT_RE.test(e.end_date) ? new Date().getFullYear() : null);
      return end !== null && end > start ? ([start, end] as [number, number]) : null;
    })
    .filter((s): s is [number, number] => s !== null)
    .sort((a, b) => a[0] - b[0]);
  if (spans.length === 0) return 0;
  let total = 0;
  let [lo, hi] = spans[0];
  for (const [a, b] of spans.slice(1)) {
    if (a > hi) {
      total += hi - lo;
      [lo, hi] = [a, b];
    } else {
      hi = Math.max(hi, b);
    }
  }
  return total + hi - lo;
}

function sectionOrder(resume: ResumeModel): readonly string[] {
  if (resume.education.length === 0) return EXPERIENCED_ORDER; // nothing to promote
  if (resume.experience.length === 0) return EARLY_CAREER_ORDER;
  const thisYear = new Date().getFullYear();
  const yearOf = (d: string): number | null => {
    const m = /(?:19|20)\d{2}/.exec(d || "");
    return m ? Number(m[0]) : null;
  };
  const studying = resume.education.some((e) => {
    const end = (e.end_date || "").trim();
    if (CURRENT_RE.test(end) || /expected|צפוי/i.test(end)) return true;
    const endYear = yearOf(end);
    if (endYear !== null) return endYear > thisYear;
    // A blank end date only means "still there" when the studies began
    // recently; on an old degree it just means the field was never filled in.
    const start = yearOf(e.start_date);
    return !end && start !== null && thisYear - start <= STUDY_WINDOW_YEARS;
  });
  return studying || yearsOfExperience(resume) < EARLY_CAREER_YEARS
    ? EARLY_CAREER_ORDER
    : EXPERIENCED_ORDER;
}

/** Section heading — small uppercase accent label with a hairline underline,
 * matching the premium surfaces (replaces the old `.resume-view h4`). */
function SectionHead({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="mb-1.5 border-b border-line pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-accent-soft">
      {children}
    </h4>
  );
}

/**
 * The meta line under an entry title: "Employer · Location · Dates".
 * Mirrors `_Segments` in the PDF renderer — the employer carries the weight and
 * the accent, the rest is muted, and separators only appear BETWEEN parts (a
 * dot in front of the first surviving bit is the easy bug here).
 */
function MetaLine({ lead = "", bits = [] }: { lead?: string; bits?: (string | undefined)[] }) {
  const parts = [lead, ...bits].filter((b): b is string => Boolean(b && b.trim()));
  if (parts.length === 0) return null;
  return (
    <div className="text-xs text-ink-muted">
      {parts.map((bit, i) => (
        <span key={`${bit}-${i}`}>
          {i > 0 && <span className="mx-1.5 text-ink-faint">·</span>}
          <span className={i === 0 && lead ? "font-semibold text-accent-soft" : undefined}>{bit}</span>
        </span>
      ))}
    </div>
  );
}

export default function ResumeView({
  resume,
  surface = "panel",
  marks,
  activeBlock,
  onSelectBlock,
  onEditBlock,
}: Props) {
  const { t } = useTranslation("tailor");
  const c = resume.contact;

  /** Marker + spotlight for one block. Every marker uses LOGICAL properties
   * (`border-s`, `-ms`, `ps`) so RTL mirrors without a second rule. A bullet
   * marks its own glyph rather than growing a start-bar, which would collide
   * with the list's `ps-5` indent. */
  // An editable block has to LOOK editable. Phase 22's whole premise is that
  // the page IS the CV and you change it in place — and nothing on the paper
  // said so: `blkProps` puts tabIndex={0} and role="button" on nearly every
  // block whenever `onEditBlock` is set, while this file contained no hover,
  // active or focus state at all. Invisible on a phone; a WCAG 2.4.7 failure
  // (focusable control, no visible focus indicator) on a desktop.
  //
  // Two rules hold the shape of the fix:
  //  * Colour and outline ONLY — never a border, padding or size change. This
  //    sheet is measured against a real reportlab page count, and a block that
  //    reflows under the reader's finger reads as a bug.
  //  * `active:` is not a nicety on touch. A phone has no hover, and a tap
  //    leaves `:hover` stuck on the last element tapped, so the press state is
  //    the only honest feedback a thumb gets.
  // The tint resolves through `.sheet`'s own --accent (the classic template's
  // navy), so it belongs to the document rather than to the app chrome.
  const editable = !!onEditBlock;
  const blk = (path: string, shape: "block" | "item" | "chip" = "block") => {
    const mark = marks?.get(path);
    return cn(
      onSelectBlock && "cursor-pointer",
      editable && "transition-colors duration-150",
      editable &&
        shape !== "chip" &&
        "rounded-[3px] hover:bg-accent/[0.06] active:bg-accent/[0.13]",
      editable &&
        shape === "chip" &&
        "hover:ring-1 hover:ring-inset hover:ring-accent/40 active:ring-1 active:ring-inset active:ring-accent/70",
      editable &&
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/70",
      shape === "block" && mark === "changed" && "-ms-2 border-s-2 border-accent/50 ps-2",
      shape === "block" && mark === "restored" && "-ms-2 border-s-2 border-warn/60 ps-2",
      shape === "item" && mark === "changed" && "marker:text-accent",
      shape === "item" && mark === "restored" && "marker:text-warn",
      shape === "chip" && mark === "changed" && "ring-1 ring-inset ring-accent/45",
      shape === "chip" && mark === "restored" && "ring-1 ring-inset ring-warn/55",
      activeBlock === path && "rounded-[3px] bg-accent/10 outline outline-2 outline-offset-2 outline-accent/60",
    );
  };

  // ONE delegated handler rather than a handler, a role and a tabIndex on every
  // <strong>, <li> and <span> in the document.
  const act = onEditBlock ?? onSelectBlock;
  const onClick = act
    ? (ev: React.MouseEvent) => {
        const path = (ev.target as HTMLElement).closest<HTMLElement>("[data-block]")?.dataset.block;
        if (path) act(path);
      }
    : undefined;
  // Keyboard reaches the same blocks, also delegated. Only EDITABLE blocks
  // become focusable: a jump target is a convenience, an editor is an action.
  const onKeyDown = onEditBlock
    ? (ev: React.KeyboardEvent) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        const path = (ev.target as HTMLElement).closest<HTMLElement>("[data-block]")?.dataset.block;
        if (!path) return;
        ev.preventDefault();
        onEditBlock(path);
      }
    : undefined;

  /** Everything a block needs, from one path — so the path string is written
   * ONCE per block instead of twice (as `data-block` and again inside `blk`),
   * which is a whole class of silent typo removed. */
  const blkProps = (path: string, shape: "block" | "item" | "chip" = "block", extra?: string) => ({
    "data-block": path,
    className: cn(extra, blk(path, shape)),
    // `role="button"` is deliberately omitted on list items: putting it on every
    // <li> stops the list being a list for a screen reader.
    ...(onEditBlock ? { tabIndex: 0, ...(shape !== "item" ? { role: "button" as const } : {}) } : {}),
  });
  const contactBits = [c.email, c.phone, c.location, c.linkedin, c.website].filter(Boolean);
  const military = resume.military_service ?? [];
  const languages = resume.languages ?? [];
  const skillBlocks = skillBlocksOf(resume);

  const sections: Record<string, React.ReactNode> = {
    summary: resume.summary ? (
      <section key="summary">
        <SectionHead>{t("sections.summary")}</SectionHead>
        <p {...blkProps("@summary", "block", "text-sm leading-relaxed text-ink-muted")}>
          {resume.summary}
        </p>
      </section>
    ) : null,

    skills: skillBlocks.length > 0 ? (
      <section key="skills">
        <SectionHead>{t("sections.skills")}</SectionHead>
        <div className="space-y-2">
          {skillBlocks.map(([label, items], i) => (
            <div
              key={label || `unlabelled-${i}`}
              // The trailing unlabelled block (the skills no group claimed)
              // needs more air than the gap between groups, or it reads as one
              // more row of the group above it. The PDF renderer gives it the
              // same extra `entry_before` for the same reason.
              className={!label && i > 0 ? "pt-2" : undefined}
            >
              {/* Not uppercased, unlike the section heading above it: a group
                  label is the user's own taxonomy, copied verbatim from their
                  résumé, and both renderers print it as written. */}
              {label && <p className="mb-1 text-xs font-semibold text-accent">{label}</p>}
              <div className="flex flex-wrap gap-1.5">
                {items.map((s) => (
                  <Badge key={s} {...blkProps(`@skills.${dkey(s)}`, "chip")}>
                    {s}
                  </Badge>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    ) : null,

    experience: resume.experience.length > 0 ? (
      <section key="experience">
        <SectionHead>{t("sections.experience")}</SectionHead>
        <div className="space-y-3">
          {/* Mirrors the renderers' stacked entry (TemplateSpec.entry="stack",
              the default in 9 of the 11 templates): the title on its own line,
              then one meta line reading "Employer · Location · Dates". The old
              preview joined "title — company" and pushed "location | dates"
              flush right, which is a layout no download has produced since the
              entry grammar changed. */}
          {resume.experience.map((e, i) => (
            <div key={i} {...blkProps(`@exp.${i}`, "block")}>
              <strong className="block text-sm font-semibold text-ink">{e.title || e.company}</strong>
              <MetaLine
                lead={e.title ? e.company : ""}
                bits={[e.location, [e.start_date, e.end_date].filter(Boolean).join(" – ")]}
              />
              <ul className="mt-1 list-disc space-y-0.5 ps-5 text-sm text-ink-muted">
                {e.bullets.map((b, j) => (
                  <li key={j} {...blkProps(`@exp.${i}.b.${j}`, "item")}>
                    {b}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    ) : null,

    projects: resume.projects.length > 0 ? (
      <section key="projects">
        <SectionHead>{t("sections.projects")}</SectionHead>
        <div className="space-y-3">
          {resume.projects.map((p, i) => (
            <div key={i} {...blkProps(`@proj.${i}`, "block")}>
              <strong className="text-sm font-semibold text-ink">{p.name}</strong>
              {p.description && <span className="text-sm text-ink-muted"> — {p.description}</span>}
              <ul className="mt-1 list-disc space-y-0.5 ps-5 text-sm text-ink-muted">
                {p.bullets.map((b, j) => (
                  <li key={j} {...blkProps(`@proj.${i}.b.${j}`, "item")}>
                    {b}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    ) : null,

    education: resume.education.length > 0 ? (
      <section key="education">
        <SectionHead>{t("sections.education")}</SectionHead>
        <div className="space-y-2">
          {resume.education.map((e, i) => (
            <div key={i} {...blkProps(`@edu.${i}`, "block", "text-sm")}>
              <strong className="font-semibold text-ink">
                {[e.degree, e.field].filter(Boolean).join(", ") || e.institution}
              </strong>
              <span className="text-ink-muted">
                {" "}
                {[e.institution, [e.start_date, e.end_date].filter(Boolean).join(" – ")]
                  .filter(Boolean)
                  .join(" | ")}
              </span>
              {e.details && <div className="text-ink-muted">{e.details}</div>}
            </div>
          ))}
        </div>
      </section>
    ) : null,

    military: military.length > 0 ? (
      <section key="military">
        {/* defaultValue fallbacks: catalog keys pending (locale files owned by the frontend pass) */}
        <SectionHead>{t("sections.militaryService", "Military Service")}</SectionHead>
        <div className="space-y-3">
          {military.map((m, i) => (
            <div key={i} {...blkProps(`@mil.${i}`, "block")}>
              <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5">
                <strong className="text-sm font-semibold text-ink">
                  {[m.role, m.unit].filter(Boolean).join(" — ")}
                </strong>
                <span className="text-xs text-ink-muted">
                  {[m.rank, [m.start_date, m.end_date].filter(Boolean).join(" – ")]
                    .filter(Boolean)
                    .join(" | ")}
                </span>
              </div>
              <ul className="mt-1 list-disc space-y-0.5 ps-5 text-sm text-ink-muted">
                {m.bullets.map((b, j) => (
                  <li key={j} {...blkProps(`@mil.${i}.b.${j}`, "item")}>
                    {b}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    ) : null,

    certifications: resume.certifications.length > 0 ? (
      <section key="certifications">
        <SectionHead>{t("sections.certifications")}</SectionHead>
        <ul className="list-disc space-y-0.5 ps-5 text-sm text-ink-muted">
          {resume.certifications.map((cert, i) => (
            <li key={i} {...blkProps(`@cert.${dkey(cert)}`, "item")}>
              {cert}
            </li>
          ))}
        </ul>
      </section>
    ) : null,

    languages: languages.length > 0 ? (
      <section key="languages">
        <SectionHead>{t("sections.languages", "Languages")}</SectionHead>
        <div className="flex flex-wrap gap-1.5">
          {languages.map((l, i) => (
            <Badge
              key={i}
              {...blkProps(`@lang.${dkey(l.language)}`, "chip")}
            >
              {[l.language, l.level].filter(Boolean).join(" – ")}
            </Badge>
          ))}
        </div>
      </section>
    ) : null,
  };

  return (
    <div
      // `dir="auto"` must stay on the element that CONTAINS the text, or a
      // Hebrew résumé stops resolving RTL. Per-block dir is deliberately not
      // added: it would need the fused meta lines split first, and `dir` on an
      // inline element opens a bidi isolate that strands the "·" separators.
      dir="auto"
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={cn(
        "text-ink [&_section]:mt-5",
        surface === "sheet"
          ? // A page, not a card: white ground, near-square corners, proportional
            // margins (~the renderers' 9.7% / 5.5%), and a measure near 65-70
            // characters instead of the 130 a full-width column would give. The
            // ring is not decoration — the app has a real light theme where the
            // shadow alone is invisible.
            "sheet mx-auto w-full max-w-[46rem] rounded-[3px] bg-panel px-[clamp(20px,7%,56px)] py-[clamp(22px,5.5%,46px)] shadow-doc ring-1 ring-black/10"
          : "rounded-xl border border-line bg-bg-soft p-5",
      )}
    >
      <div {...blkProps("@contact.name", "block", "text-xl font-bold text-ink")}>
        {c.name || t("sections.fallbackName")}
      </div>
      {resume.headline && (
        <div
          {...blkProps("@headline", "block", "mt-0.5 text-sm font-medium text-accent-soft")}
        >
          {resume.headline}
        </div>
      )}
      {contactBits.length > 0 && (
        <div {...blkProps("@contact", "block", "mt-0.5 text-xs text-ink-muted")}>
          {contactBits.join(" · ")}
        </div>
      )}

      {sectionOrder(resume).map((key) => sections[key])}
    </div>
  );
}
