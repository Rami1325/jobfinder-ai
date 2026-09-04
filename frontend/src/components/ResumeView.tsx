import { useRef, useState, type CSSProperties } from "react";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ResumeModel } from "../types";
import type { ResumeTemplate } from "../api/client";
import { Badge } from "./ui";
import { cn } from "../lib/cn";
import {
  CONTACT_FIELDS,
  dkey,
  inlineField,
  INSERT_KINDS,
  isNamedInsert,
  type EntryInsertKind,
  type NamedInsertKind,
} from "../lib/resumeBlocks";
import { resumeLanguage } from "../lib/lang";
import { TEMPLATE_SPECS, bandFill, headingRuleFill, type TemplateSpec } from "../lib/templateSpecs";

/**
 * `plaintext-only` is what stops a paste putting markup into a `string[]`.
 *
 * Probed rather than assumed: the attribute's INVALID-VALUE DEFAULT is
 * *inherit*, so a browser that does not know the keyword renders the block
 * silently NOT editable — a blank failure, on the one interaction this
 * document exists for. Falling back to plain `true` keeps it editable and the
 * paste handler below sanitises regardless.
 */
const EDITABLE_MODE: "plaintext-only" | true = (() => {
  if (typeof document === "undefined") return true;
  const probe = document.createElement("div");
  try {
    probe.contentEditable = "plaintext-only";
  } catch {
    return true;
  }
  return probe.contentEditable === "plaintext-only" ? "plaintext-only" : true;
})();

/** How a block relates to the tailoring — who last spoke on this line.
 * `changed` = the AI touched it and you kept the change; `restored` = every
 * edit on it was declined, so what you are reading is your original wording;
 * `yours` = you typed this yourself over the tailored draft, so it is neither
 * the AI's wording nor your original, and it outranks both. */
export type BlockMark = "changed" | "restored" | "yours";

interface Props {
  resume: ResumeModel;
  /**
   * `"panel"` is the original in-app card (the tracker's détail modal);
   * `"sheet"` is the résumé as a page — white ground, page margins, a lift.
   */
  surface?: "panel" | "sheet";
  /**
   * The template the FILE will be rendered with — and therefore the one this
   * page has to be drawn in.
   *
   * It was missing, and that was the whole defect: `DocumentPanel` held the
   * choice and handed it to the PDF preview, the x-ray and both downloads, but
   * not to the page the user edits on. So picking Executive gave you a serif,
   * cream, centred-name, split-entry PDF while the document on screen stayed
   * sans, white, left-aligned and ruled. Every other surface honoured the
   * choice; the one you work on did not.
   *
   * Only `surface="sheet"` reads it. The détail modal is a card inside the app
   * chrome, not a preview of a download, so it keeps the one look it has always
   * had and passes nothing.
   */
  template?: ResumeTemplate;
  /** Block path → how it relates to the tailoring. Paths come from
   * `resumeDiff.mergeForReview`'s `blocks`, and must use the same grammar. */
  marks?: Map<string, BlockMark>;
  /**
   * Block path → the worst thing the deterministic review found on that block.
   *
   * A SEPARATE PROP FROM `marks`, and that separation is the whole point. A Map
   * holds one value per path, and the two answer different questions about the
   * same line: `marks` says who last spoke on it (the AI, your original, you),
   * while this says a check found something wrong with it. Folding them into one
   * Map would make a bullet that the tailor rewrote AND that has no measured
   * outcome carry only whichever of the two was written last — silently.
   *
   * Painted as a small STATIC dot in the margin, through `::after` and nothing
   * else. Never an element: that `<li>` IS the `contentEditable` node for
   * `@exp.i.b.j`, so a glyph `<span>` inside it is typed over or deleted by the
   * first edit — the same reason the bullet marker is `list-style-type` and the
   * empty-field placeholder is `[data-ph]:empty::before`. And never animated:
   * nothing on the paper may move unless a value the backend returned or an edit
   * the user made caused it, and a finding appearing is neither — the panel
   * beside it is where a change of state gets announced.
   *
   * A path this document does not render simply never matches, which is the
   * "listed in the panel, unmarked on the paper" behaviour a document-level or
   * stale finding is supposed to get.
   */
  flags?: Map<string, "bad" | "warn">;
  /** The block to spotlight right now (a jump from the review panel). */
  activeBlock?: string | null;
  /** Bumped every time the caller spotlights a block, including the SAME one
   * twice running. A CSS animation restarts only when its name changes, so
   * this parity is what makes the second save to one block re-bloom. */
  activeNonce?: number;
  /** Clicking a block asks the review panel to show its change. */
  onSelectBlock?: (path: string) => void;
  /** Clicking a block opens it for editing. Takes precedence over
   * `onSelectBlock`: a tailored draft is a review surface, a master résumé is
   * an editing one, and the page decides which by passing one or the other.
   *
   * Now COMPOUND blocks only — the six that fuse several model fields into one
   * printed line. Single-field blocks are typed on directly; see
   * `onInlineCommit`. */
  onEditBlock?: (path: string) => void;
  /** A single-field block was typed in and the caret left it. `text` is already
   * trimmed and newline-free, and is guaranteed to DIFFER from what was
   * rendered — an unchanged edit never reaches here. */
  onInlineCommit?: (path: string, text: string) => void;
  /** Add a skill into a named group ("" = the trailing unlabelled block). The
   * text is already trimmed and non-empty. Absent = no add affordance
   * (read-only surfaces). */
  onAddSkill?: (groupLabel: string, text: string) => void;
  /** "+ Add to your CV" at the foot of the paper — the four ENTRY kinds, each
   * added blank and addressed positionally. Absent = no add control.
   *
   * BOTH OR NEITHER with `onAddNamed`: the control is one fixed list of seven
   * rows and it renders only when it can serve all seven, on the same reasoning
   * `editable` uses two lines up. Passing one alone would silently ship a
   * control that is three rows short of the list this file documents. */
  onAdd?: (kind: EntryInsertKind) => void;
  /** The other three rows of that same control — a skill, a certification, a
   * language — with the text the user typed into it.
   *
   * They are separated because they cannot be added the way an entry is: a
   * keyed block's path IS its own value, so there is nothing to address until
   * there is text. `insertBlock` used to mint "New skill" / "New certification"
   * / "New language" to give itself a key, which put untranslated English into
   * a Hebrew CV, live in the store and in the download with no Save. */
  onAddNamed?: (kind: NamedInsertKind, text: string) => void;
  /** Append a bullet to this entry. Rendered at the end of its own list, which
   * is the only place a user looks for it. */
  onAddBullet?: (entryPath: string) => void;
  /** One quiet line where the add control would be, for a surface that cannot
   * add. It sits there and nowhere else because that is where the question is
   * asked: the foot of the paper is the only place a user looks for "+ Add to
   * your CV", so its absence is answered in the same spot rather than left to
   * read as a missing feature. Ignored when `onAdd` is given — the control
   * itself is the better answer. */
  footNote?: string;
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

/* ===========================================================================
   The template, on the paper.
   ===========================================================================
   This page is the THIRD renderer of `TemplateSpec`'s presentation vocabulary,
   after `pdf_renderer` and `docx_renderer`, and it reads the same table they do
   (`lib/templateSpecs.ts`, pinned against templates.py by check-mirrors 23).

   What it reproduces: the palette, the serif/sans category, the heading
   grammar, the header band, the entry grammar, the rail, the skills treatment,
   the bullet glyph and the column count.

   What it does NOT, each for a stated reason and each said out loud under the
   document (`doc.screen.note` / `doc.screen.twoColumn` in DocumentPanel):
     * the exact typeface — Lato and Spectral are PDF-EMBEDDED, not web-loaded,
       and fonts.css deliberately ships only the Inter/Heebo subsets;
     * `layout="sidebar"` — which sections land in the rail is a reportlab
       MEASUREMENT with a demote pass and an early-career carve-out, so a DOM
       guess would show sections in the rail that the real file moved out. That
       is a new lie in the same class as the one this code exists to fix;
     * `contact_icons` / `date_icon` / the rail's dot in the DOCX — the 21.8
       ORNAMENT carve-out, on the same recorded reasoning, plus one specific to
       this surface: an icon element inside a contentEditable contact block
       would be typed over or deleted by the first edit.
   =========================================================================== */

/** A CSS hex ("#1F3A5F") as the space-separated RGB triplet the design tokens
 * are declared in. That form is not decoration: `rgb(var(--accent) /
 * <alpha-value>)` is what lets every `bg-accent/[0.06]` and `outline-accent/70`
 * in this file compose an alpha against the template's own colour. */
function channels(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0) as [number, number, number];
}
const triplet = (hex: string) => channels(hex).join(" ");

/** `pdf_renderer._mix` — `a` moved `t` of the way to `b`, as a token triplet.
 * Mixing is how a "reduced alpha" is expressed here: a token is three channels
 * with no alpha of its own, so the honest twin of "40% of this over that" is
 * the mix. */
function mixed(a: string, b: string, t: number): string {
  const [ar, ag, ab] = channels(a);
  const [br, bg, bb] = channels(b);
  return [ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t]
    .map((v) => Math.round(v))
    .join(" ");
}

/** Points → CSS pixels at 96dpi, floored at a hairline. Rule weights are
 * declared in points because the file is, and a 0.5pt hairline still has to be
 * one real pixel here. */
const rulePx = (pt: number) => `${Math.max(1, Math.round((pt * 4) / 3))}px`;

/** A4, the page size of every template — which is why the mirror does not carry
 * `page_w_pt`. Used only to turn a width in points into a share of the text
 * column, so the "short" heading mark keeps its proportion at 390px instead of
 * being a fixed 42px on a 336px page. */
const PAGE_W_PT = 595.276;

/**
 * Section heading, in the six shapes `TemplateSpec.heading` names — rule,
 * short, bar, plain, centered, hung.
 *
 * `spec` is absent on `surface="panel"`, which keeps the original treatment
 * (tracked caps over a hairline = `heading="rule"`, which is also what classic
 * declares, so the default template is unchanged on both surfaces).
 *
 * No `data-block` and no `blkProps`: a heading is a label the renderers print
 * from `labels.py`, not a part of the résumé, so nothing here is reachable by
 * the delegated editing handlers.
 */
function SectionHead({
  spec,
  dir,
  children,
}: {
  spec?: TemplateSpec;
  dir: "ltr" | "rtl";
  children: React.ReactNode;
}) {
  // `heading_case` is a NO-OP in Hebrew, and both renderers branch on direction
  // BEFORE they look at it: .upper() on Hebrew is wasted work and .title()
  // mangles a mixed he/en label.
  const cased = !spec
    ? "uppercase"
    : dir === "rtl"
      ? ""
      : spec.headingCase === "title"
        ? "capitalize"
        : "uppercase";
  // Every per-template number arrives as an inline style, never as a computed
  // class: Tailwind generates utilities by SCANNING THE SOURCE, so a class name
  // assembled at runtime resolves to nothing at all.
  const style: CSSProperties = {};
  let shape = "border-b border-line pb-1";
  let tone = "text-accent-soft";
  if (spec) {
    // `color=s.ink if style in ("short", "hung") else s.accent` — the two
    // treatments that carry their own accent mark set the label in ink.
    tone = spec.heading === "short" || spec.heading === "hung" ? "text-ink" : "text-accent-soft";
    shape = "";
    if (spec.heading === "rule" || spec.heading === "centered") {
      shape = spec.heading === "centered" ? "border-b pb-1 text-center" : "border-b pb-1";
      style.borderBottomWidth = rulePx(spec.headingRulePt);
      style.borderBottomColor = headingRuleFill(spec);
    } else if (spec.heading === "bar") {
      // A logical border, so the bar lands at the text start in both directions
      // with no second rule — the same free mirroring `_BarHeading` gets.
      shape = "border-s ps-2";
      style.borderInlineStartWidth = rulePx(spec.headingBarW);
      style.borderInlineStartColor = spec.accent;
    }
    // "plain" and "hung" draw no rule at all. A hung heading is PLACED by the
    // sheet root's own `sm:[&_section]:grid`: at 390px the sheet's gutter is
    // ~27px against the PDF's 84pt margin, so below `sm` there is nothing to
    // hang into and it degrades to plain, which is what it looks like anyway.
  }
  return (
    <h4
      className={cn(
        "mb-1.5 text-[11px] font-semibold",
        cased,
        tone,
        shape,
        spec ? "tracking-[var(--doc-head-tracking)]" : "tracking-[0.08em]",
        spec?.heading === "hung" && "sm:mb-0 sm:text-end",
      )}
      style={style}
    >
      {children}
      {spec?.heading === "short" && (
        // The short accent mark, as a real child rather than an `::after`: its
        // width is a SHARE of the text column (heading_short_pt over the page's
        // own text width), which an `::after` could only carry as another
        // runtime class Tailwind would never generate.
        <span
          aria-hidden="true"
          className="mt-1 block"
          style={{
            height: rulePx(spec.headingRulePt),
            width: `${((spec.headingShortPt / (PAGE_W_PT - 2 * spec.mx)) * 100).toFixed(1)}%`,
            background: headingRuleFill(spec),
          }}
        />
      )}
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

/**
 * The field half of an add affordance: type a word, commit, keep going.
 *
 * ONE definition, used by the skills row's chip AND by the foot control's three
 * keyed rows, for check 6's reason — every trap in it was paid for once already
 * and a second copy would only get to pay for them again:
 *   * a REAL `<input>`, never a contentEditable, and it carries NO `data-block`.
 *     This file's five delegated root handlers all key off
 *     `el.isContentEditable` or `closest("[data-block]")`, so the field is
 *     invisible to every one of them — including `onKeyDown`, whose
 *     `preventDefault()` on `" "` would otherwise eat the SPACE BAR in a
 *     two-word skill (it runs only AFTER the path lookup, which comes back
 *     empty here). No `data-block` is also the honest statement: this field
 *     addresses nothing on the résumé yet, and nothing is written until it does;
 *   * Escape must not be able to commit through the blur that closing MIGHT
 *     fire — browsers disagree about whether removing a focused node dispatches
 *     focusout, and the losing outcome writes a discarded word onto the CV;
 *   * `spellCheck={false} autoCapitalize="off"` or iOS rewrites "gRPC" to
 *     "GRPC" on the way in, silently, in the one place a wrong string is a
 *     wrong claim;
 *   * Enter is guarded on `isComposing`: Gboard and dictation fire keydown
 *     mid-word, so an unguarded Enter commits half a word.
 *
 * Enter commits, CLEARS and KEEPS focus. Adding ONE thing was never the ask —
 * "I want to add another skill" is a run of them, and re-opening the field
 * between each is the friction that made the panel unusable for this.
 */
function ChipInput({
  label,
  placeholder,
  dir,
  onCommit,
  onClose,
}: {
  /** The accessible name — what a screen reader announces for the field. */
  label: string;
  /** The greyed hint INSIDE the field. It is drawn by the browser and is not
   * the field's value, which is the whole distinction this component exists to
   * keep: there is nothing here to commit until the user types. */
  placeholder: string;
  dir: "ltr" | "rtl";
  /** Always trimmed and non-empty: a blank field commits NOTHING. */
  onCommit: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const discarded = useRef(false);
  const commit = () => {
    const value = text.trim();
    if (value) onCommit(value);
    setText("");
  };
  return (
    <input
      autoFocus
      value={text}
      // The PAPER's direction, like every editable node on the sheet — never
      // `dir="auto"`, which would flip the field under the caret the moment a
      // Hebrew CV's next skill happens to be spelled "React".
      dir={dir}
      spellCheck={false}
      autoCapitalize="off"
      aria-label={label}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          discarded.current = true;
          setText("");
          onClose();
        }
      }}
      onBlur={() => {
        if (!discarded.current) commit();
        discarded.current = false;
        onClose();
      }}
      className="w-28 max-w-full rounded-full border border-accent/60 bg-transparent px-2.5 py-0.5 text-xs font-medium text-ink outline-none placeholder:text-ink-faint focus:border-accent"
    />
  );
}

/**
 * The one add control, at the foot of the paper.
 *
 * A FIXED list of seven rows, not "offered iff that section is empty":
 * creating your first project and your fourth are the same action, so the list
 * must not change shape between visits and the user never learns a distinction
 * that does not exist. Sections appear and disappear on their own — ResumeView
 * renders one only when it has content, exactly as both renderers do — so
 * adding the first project IS creating the Projects section.
 *
 * A disclosure, not a modal: `Modal` binds ESC and backdrop on `window` and
 * this sits inside a page that already has one, and a bottom sheet for seven
 * words is the complication the owner asked to be rid of.
 *
 * THE SEVEN ROWS ARE TWO KINDS OF ACTION, and the split is `isNamedInsert`.
 * The four ENTRY rows add a blank entry and open its panel — an entry is
 * addressed positionally, so it can exist before it says anything. The three
 * KEYED rows have no such address (`@skills.python` IS the skill's own text),
 * so they swap the row list for this field and add nothing at all until the
 * user has typed something. They used to append "New skill" / "New
 * certification" / "New language" — untranslated English on a Hebrew CV, live
 * in the store, on the paper and in the download with no Save.
 */
function AddToResume({
  dir,
  onAdd,
  onAddNamed,
}: {
  dir: "ltr" | "rtl";
  onAdd: (kind: EntryInsertKind) => void;
  onAddNamed: (kind: NamedInsertKind, text: string) => void;
}) {
  const { t } = useTranslation("tailor");
  const [open, setOpen] = useState(false);
  const [typing, setTyping] = useState<NamedInsertKind | null>(null);
  return (
    <div className="mt-6 border-t border-line pt-4">
      <button
        type="button"
        onClick={() => {
          setTyping(null);
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-semibold text-accent-soft transition-colors hover:bg-accent/[0.07] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/70"
      >
        <Plus size={15} /> {t("edit.addTitle")}
      </button>
      {open &&
        (typing ? (
          <div className="mt-2">
            {/* The row's own noun is the placeholder and the accessible name —
                the field is cleared after every Enter, so it comes straight
                back and a run of certifications always says which run it is. */}
            <ChipInput
              label={t(`edit.add.${typing}`)}
              placeholder={t(`edit.add.${typing}`)}
              dir={dir}
              onCommit={(text) => onAddNamed(typing, text)}
              onClose={() => {
                setTyping(null);
                setOpen(false);
              }}
            />
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {INSERT_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => {
                  if (isNamedInsert(kind)) {
                    setTyping(kind);
                    return;
                  }
                  setOpen(false);
                  onAdd(kind);
                }}
                className="rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:border-accent/50 hover:bg-accent/[0.07] hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/70"
              >
                {t(`edit.add.${kind}`)}
              </button>
            ))}
          </div>
        ))}
    </div>
  );
}

/**
 * The last chip in a skills row: a dashed outline that becomes a field.
 *
 * The dashed outline is a button; the field it becomes is `ChipInput`, which is
 * shared with the foot control's three keyed rows and carries every rule this
 * interaction has to obey (a real `<input>`, no `data-block`, Escape that
 * cannot commit, `isComposing`-guarded Enter). See its own note.
 *
 * The placeholder is `edit.addSkillPlaceholder` ("New skill"), and it being a
 * PLACEHOLDER is the whole distinction this component is built around: it is
 * drawn by the browser, it is not the field's value, and there is nothing there
 * to commit until the user types. The same string as a model value would be a
 * claim on the CV.
 */
function AddSkillChip({
  label,
  dir,
  onAdd,
}: {
  label: string;
  dir: "ltr" | "rtl";
  onAdd: (text: string) => void;
}) {
  const { t } = useTranslation("tailor");
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("edit.addSkillIn", { group: label })}
        className="inline-flex items-center gap-1 rounded-full border border-dashed border-accent/45 px-2.5 py-0.5 text-xs font-medium text-accent-soft/90 transition-colors hover:border-accent/70 hover:bg-accent/[0.07] hover:text-accent-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/70"
      >
        <Plus size={12} /> {t("edit.addSkill")}
      </button>
    );
  }

  return (
    <ChipInput
      label={t("edit.addSkillIn", { group: label })}
      placeholder={t("edit.addSkillPlaceholder")}
      dir={dir}
      onCommit={onAdd}
      onClose={() => setOpen(false)}
    />
  );
}

export default function ResumeView({
  resume,
  surface = "panel",
  template = "classic",
  marks,
  flags,
  activeBlock,
  activeNonce,
  onSelectBlock,
  onEditBlock,
  onInlineCommit,
  onAddSkill,
  onAdd,
  onAddNamed,
  onAddBullet,
  footNote,
}: Props) {
  const { t, i18n } = useTranslation("tailor");
  const c = resume.contact;

  /** The paper's own direction, computed the way the RENDERERS compute it.
   *
   * This used to be `dir="auto"` on the root, which resolves from the first
   * strong character in tree order — and that is `contact.name`, which
   * `resumeLanguage` deliberately EXCLUDES (it mirrors app/core/lang.py, which
   * both renderers use). So a Hebrew CV headed with a Latin-spelled name read
   * left-to-right on screen and right-to-left in the downloaded file: the two
   * surfaces disagreed about the same document. Reproduced in a browser before
   * this line was written.
   */
  // The document is the editable MASTER. TailorPage passes both handlers
  // together (or neither), so either one answers the question.
  const editable = !!onInlineCommit || !!onEditBlock;
  /** Is there any prose to detect a language FROM? `resumeLanguage` returns
   * "en" for an empty résumé exactly as it does for an English one, so a
   * from-scratch Hebrew CV would be typed into a left-to-right page. With
   * nothing to detect, follow the interface the user chose. */
  const hasProse = !!(
    resume.summary ||
    resume.skills.length ||
    resume.experience.some((e) => e.title || e.company || e.bullets.length) ||
    resume.projects.some((x) => x.name || x.description || x.bullets.length) ||
    resume.education.some((e) => e.degree || e.field || e.institution)
  );
  const paperDir: "rtl" | "ltr" = hasProse
    ? resumeLanguage(resume) === "he"
      ? "rtl"
      : "ltr"
    : i18n.dir() === "rtl"
      ? "rtl"
      : "ltr";

  /* --- the template ------------------------------------------------------ */
  // `?? classic` is `get_template`'s own fallback: an unknown name renders the
  // default rather than nothing, so an old client or a stale stored row cannot
  // produce a blank page.
  const spec = TEMPLATE_SPECS[template] ?? TEMPLATE_SPECS.classic;
  /** Only the sheet is a preview of a file. The détail modal keeps its look. */
  const styled = surface === "sheet";
  const headSpec = styled ? spec : undefined;
  const band = styled && spec.header === "band";
  // A band anchors the name hard to the top-start corner; centring inside it
  // reads like a certificate (`_flow`'s `name_align`).
  const centred = styled && !band && spec.nameCentered;
  const railed = styled && spec.rail;
  const splitEntry = styled && spec.entry === "split";
  const inlineSkills = styled && spec.skills === "inline";
  /** Body copy. Both renderers set prose in `ink` and keep `muted` for META —
   * dates, locations, the contact line, a project's description — while this
   * sheet used ONE token for both, so the two PDF colours could not be told
   * apart here. `surface="panel"` keeps the softer prose it has always had. */
  const prose = styled ? "text-ink" : "text-ink-muted";

  /**
   * The template's palette and type, as an inline override of the tokens
   * `.sheet` declares.
   *
   * INLINE, never an edit to `.sheet` in styles.css: that block is one palette
   * for every template, and it also has to keep `color-scheme`, the scrollbar
   * thumb and `--shadow-doc`, none of which has a TemplateSpec twin. Re-
   * declaring the tokens on this element is the same mechanism `.paper` and
   * `.sheet` themselves use — every `text-ink-muted` / `border-line` /
   * `bg-accent/[0.06]` underneath re-resolves by inheritance, so not one
   * utility class in this file has to know a template exists.
   *
   * Mapped from `_Sheet` (pdf_renderer), field for field.
   */
  const sheetVars: CSSProperties | undefined = styled
    ? ({
        "--accent": triplet(spec.accent),
        // The sheet declares accent-soft as the accent already; the renderers
        // have no second accent at all.
        "--accent-soft": triplet(spec.accent),
        "--line": triplet(spec.rule),
        "--ink": triplet(spec.ink),
        "--ink-muted": triplet(spec.muted),
        // `s.sep` — separators sit between the hairline and the body grey so
        // they read as punctuation rather than as content.
        "--ink-faint": mixed(spec.muted, spec.rule, 0.55),
        // `page_bg` is the second ORNAMENT carve-out in templates.py: the PDF
        // paints executive's cream and the DOCX prints white. The screen is a
        // preview of the PDF, so it paints it.
        "--panel": triplet(spec.pageBg || "#FFFFFF"),
        // Chip fill. `accent_soft: ""` mixes in `_Sheet` at accent @ 12% over
        // white, and folding that here keeps the fallback in one place.
        "--panel-2": spec.accentSoft ? triplet(spec.accentSoft) : mixed("#FFFFFF", spec.accent, 0.12),
        // Tracking is declared in POINTS against a point type size, so it
        // travels as an em and lands correctly at any screen size. Hebrew takes
        // half of it in both renderers — it is unicase and its letterforms are
        // already open — so the same halving happens here.
        "--doc-head-tracking": `${((spec.tracking / spec.head) * (paperDir === "rtl" ? 0.5 : 1)).toFixed(3)}em`,
        "--doc-name-tracking": `${((spec.nameTracking / spec.name) * (paperDir === "rtl" ? 0.5 : 1)).toFixed(3)}em`,
        // Read by ONE zero-specificity `::marker` rule in styles.css — see
        // `listStyle` below for why the glyph may not be an element.
        "--doc-bullet": triplet(spec.bulletAccent ? spec.accent : spec.muted),
        "--doc-bullet-size": `${spec.bulletScale}em`,
      } as CSSProperties)
    : undefined;

  /**
   * The reversed-out palette for a filled header band, on the wrapper only.
   *
   * The blocks inside keep their exact className strings and their exact
   * `blkProps` calls — the colour arrives through tokens, so no block markup
   * changes at all. `--accent` is the one that is easy to miss: `blk()`'s
   * `hover:bg-accent/[0.06]` and its focus outline are the only thing that says
   * a block is editable, and on modern's and panel's dark navy the sheet's own
   * navy accent is invisible.
   */
  const bandVars: CSSProperties | undefined = band
    ? ({
        "--ink": triplet(spec.bandInk),
        "--ink-muted": triplet(spec.bandMeta),
        // The `·` separators AND `[data-ph]:empty::before`, which is the only
        // thing that makes an absent phone number discoverable — so it has to
        // stay legible on the band rather than merely dimmer than it.
        "--ink-faint": mixed(spec.bandMeta, bandFill(spec), 0.45),
        "--accent": triplet(spec.bandSub),
        "--accent-soft": triplet(spec.bandSub),
      } as CSSProperties)
    : undefined;

  /**
   * `TemplateSpec.bullet_glyph`, as `list-style-type` — NEVER an in-flow glyph
   * span inside the `<li>`, because that `<li>` IS the contentEditable node for
   * `@exp.i.b.j` and a child element in it would be typed over or deleted by
   * the first edit. Colour and size ride `--doc-bullet` / `--doc-bullet-size`
   * through one `::marker` rule for the same reason.
   *
   * Only set when the glyph is not the default disc: a browser that does not
   * know the string form of `list-style-type` falls back to `disc`, which is
   * what nine of the eleven templates draw anyway, so the two remaining
   * templates degrade to a dot rather than to nothing.
   */
  const listStyle: CSSProperties | undefined =
    styled && spec.bulletGlyph !== "•"
      ? // The trailing space is load-bearing. A STRING marker is drawn exactly
        // as written, with none of the gap `disc` gets for free, so an em dash
        // butts straight against the first word ("—Rebuilt the settlement…").
        // The PDF puts `indent=body*1.05` between the glyph and the text; this
        // is the same gap, in the only place a string marker can carry one.
        { listStyleType: `"${spec.bulletGlyph} "` }
      : undefined;

  /** `TemplateSpec.rail` — a hairline down the entries with a dot per ROLE (per
   * entry head, `rail_dot`), not per heading. In the PDF it lives in the margin
   * and costs the text column nothing; here it costs `ps-4`. The colour is
   * `_mix(accent, white, 0.45)`, which over white paper IS `accent/55`.
   * Logical properties throughout, so it mirrors in RTL with no second rule. */
  const RAIL = "border-s border-accent/55 ps-4";
  const RAIL_DOT =
    "relative before:absolute before:-start-[19px] before:top-[7px] before:h-[5px] before:w-[5px] before:rounded-full before:bg-accent/55 before:content-['']";

  /**
   * The review's dot, in the margin beside a block a check found something on.
   *
   * `::after`, NOT `::before`, and that is not a style preference — both of the
   * `::before`s on these very blocks are already spoken for. `RAIL_DOT` (four
   * of the eleven templates) draws the rail's per-entry dot through
   * `before:absolute` on `@exp.i` / `@proj.i` / `@edu.i` / `@mil.i`, which are
   * exactly the paths `dates-missing`, `entry-empty`, `edu-placeholder` and
   * `duplicate-entry` anchor to; and `styles.css`'s `.sheet [data-ph]:empty::before`
   * draws the empty-field placeholder on `@summary`, which `summary-missing`
   * anchors to. An element has ONE `::before`, so either collision would mean
   * one of the two silently disappearing — and on the placeholder it would be
   * the higher-specificity stylesheet rule that won, i.e. the flag would vanish
   * with nothing on screen to say so. A pseudo-element is equally safe from the
   * caret either way (the 23.7 rule is "never an ELEMENT" — a `<span>` glyph
   * inside a `contentEditable` block gets typed over), so `::after` costs
   * nothing and cannot collide.
   *
   * COLOUR AND POSITION ONLY, absolutely positioned in the gutter. It must not
   * change the block's own box: this sheet is measured against a real reportlab
   * page count, so a dot that reflowed the text would make the measured page
   * count wrong. And no transition, no animation, no hover response — a finding
   * arriving is not a value the user moved, and the panel beside the paper is
   * where a state change is announced.
   *
   * Two offsets, because a bullet's start edge is not where its text starts:
   * the `<ul>` carries `ps-5` and the list marker hangs in that 20px, so an
   * `item` has to clear the marker rather than sit on top of it. Both are
   * logical (`-start-`, i.e. `inset-inline-start`), so RTL mirrors with no
   * second rule.
   */
  const flagDot = (path: string, shape: "block" | "item" | "chip") => {
    const flag = flags?.get(path);
    if (!flag) return undefined;
    return cn(
      "relative after:absolute after:h-[5px] after:w-[5px] after:rounded-full after:content-['']",
      flag === "bad" ? "after:bg-danger/80" : "after:bg-warn/70",
      shape === "item"
        ? "after:top-[0.5em] after:-start-[22px]"
        : shape === "chip"
          ? // A corner pip rather than a margin dot: a chip sits in a
            // comma-joined run or a wrapped row of bordered pills, so there is
            // no reliable gutter beside it — 10px into the start would land on
            // the previous chip's last letter.
            "after:-top-[3px] after:-start-[3px]"
          : "after:top-[0.5em] after:-start-[10px]",
    );
  };

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
      // `yours` is COLOUR ONLY — the same geometry as the other two, in the
      // mint this app already uses for "you settled this". A block that
      // reflowed under the reader's finger would read as a bug on a sheet
      // measured against a real page count, and it is a resting state rather
      // than a fade, because `prefers-reduced-motion` parks an animation at its
      // `to` value and a highlight that faded out would leave those users with
      // no indication at all.
      shape === "block" && mark === "yours" && "-ms-2 border-s-2 border-mint/60 ps-2",
      shape === "item" && mark === "yours" && "marker:text-mint",
      shape === "chip" && mark === "yours" && "ring-1 ring-inset ring-mint/55",
      // The resting highlight stays a plain class so it survives the whole
      // spotlight window; the animation only governs how it ARRIVES.
      activeBlock === path && "rounded-[3px] bg-accent/10 outline outline-2 outline-offset-2 outline-accent/60",
      activeBlock === path &&
        ((activeNonce ?? 0) % 2 === 0 ? "animate-block-settle" : "animate-block-settle-alt"),
      // LAST, and on its own pseudo-element, so it can never be in a position
      // to win or lose against one of the marks above it.
      flagDot(path, shape),
    );
  };

  // ONE delegated handler rather than a handler, a role and a tabIndex on every
  // <strong>, <li> and <span> in the document.
  //
  // EXACTLY ONE OF THE TWO, and never both. Firing both was tried and REVERTED,
  // because the two handlers move the same page in opposite directions at the
  // same moment: `onEditBlock` opens `BlockEditSheet`, which is `aria-modal`
  // with `document.body.style.overflow = "hidden"`, while `onSelectBlock` ends
  // in `scrollIntoView` on a review row in a panel BELOW the document. Measured
  // in Chrome on the real page: one tap on a compound block moved `scrollTop`
  // from 0 to 246.7 *while the body was locked*, so closing the sheet dropped
  // the user into the review list, nowhere near the block they had tapped.
  //
  // It also put the pointer and the keyboard on two different behaviours for
  // one element: `onKeyDown` below has always called `onEditBlock` alone, so
  // Enter and a tap did different things to the same block. They agree again.
  //
  // What is traded away: the document→review jump for COMPOUND blocks on a
  // surface that can also edit them (on `/app` that is every surface, since
  // `canEditDoc` is just "there is a document"). It is a real loss and a
  // deliberate one — a tap that opens a form must not also scroll the page
  // behind that form's own scrim. `onSelectBlock` still runs on a surface with
  // no editor, the Crosshair still jumps review→document, and every marked block
  // still names its author through the mark's own `title`.
  //
  // A block being TYPED IN gets neither, and the caret is why: `onSelectBlock`
  // would smooth-scroll the paper out of view at the exact moment the caret
  // lands and the on-screen keyboard starts opening — the tap said "type here"
  // and the page answers by leaving.
  const onClick =
    onEditBlock || onSelectBlock
      ? (ev: React.MouseEvent) => {
          const el = ev.target as HTMLElement;
          if (el.isContentEditable) return;
          const path = el.closest<HTMLElement>("[data-block]")?.dataset.block;
          if (!path) return;
          // Both callees early-return on their own for a block they have nothing
          // to say about, so this is safe whenever the tap was not a caret
          // placement.
          if (onEditBlock) onEditBlock(path);
          else onSelectBlock?.(path);
        }
      : undefined;

  /** Snapshot the text as it stood when the caret arrived. Focus, not render:
   * after the first keystroke the DOM no longer matches the model, and the
   * comparison on commit has to be against what the user actually saw. */
  const onFocus = onInlineCommit
    ? (ev: React.FocusEvent) => {
        const el = ev.target as HTMLElement;
        if (el.isContentEditable) el.dataset.orig = el.innerText;
      }
    : undefined;

  /** Commit on blur. While the caret is in the node NOTHING re-renders — the
   * DOM node IS the draft — which is what keeps the caret alive: react-dom
   * skips a text child whose string is unchanged, so an unrelated re-render
   * (a coverage response, the spotlight timeout, a toast) cannot touch it. */
  const onBlur = onInlineCommit
    ? (ev: React.FocusEvent) => {
        const el = ev.target as HTMLElement;
        if (!el.isContentEditable) return;
        const path = el.dataset.block;
        if (!path) return;
        const original = el.dataset.orig ?? "";
        // `innerText`, not `textContent`: a stray <br> has to become a space
        // rather than fusing the words on either side of it.
        const text = el.innerText.replace(/\s+/g, " ").trim();
        if (text === original.trim()) {
          // React does not repair a DOM the browser mutated when its own string
          // is unchanged, so a whitespace-only edit would sit on the paper
          // forever. Put the rendered text back by hand.
          if (el.textContent !== original) el.textContent = original;
          return;
        }
        onInlineCommit(path, text);
      }
    : undefined;

  // Keyboard reaches the same blocks, also delegated.
  const onKeyDown =
    onEditBlock || onInlineCommit
      ? (ev: React.KeyboardEvent) => {
          const el = ev.target as HTMLElement;
          if (el.isContentEditable) {
            // THE SPACE BAR. The compound branch below preventDefaults on " ",
            // which would make space un-typeable in every editable block, in
            // both locales. Enter ends the edit instead of inserting a break —
            // guarded on isComposing, because Gboard and dictation fire keydown
            // mid-word and would commit a half-composed one.
            if (ev.key === "Enter" && !ev.nativeEvent.isComposing) {
              ev.preventDefault();
              el.blur();
            }
            return;
          }
          if (!onEditBlock) return;
          if (ev.key !== "Enter" && ev.key !== " ") return;
          const path = el.closest<HTMLElement>("[data-block]")?.dataset.block;
          if (!path) return;
          ev.preventDefault();
          onEditBlock(path);
        }
      : undefined;

  /** Paste is plain text, always. A bullet is a `string` all the way through
   * both renderers into `_wrap_lines`; pasted markup has nowhere to go and
   * would be silently serialised into the model. */
  const onPaste = onInlineCommit
    ? (ev: React.ClipboardEvent) => {
        if (!(ev.target as HTMLElement).isContentEditable) return;
        ev.preventDefault();
        const text = ev.clipboardData.getData("text/plain").replace(/\s+/g, " ");
        ev.currentTarget.ownerDocument.execCommand("insertText", false, text);
      }
    : undefined;

  /** Everything a block needs, from one path — so the path string is written
   * ONCE per block instead of twice (as `data-block` and again inside `blk`),
   * which is a whole class of silent typo removed.
   *
   * A block that is ONE model field gets a caret; the rest keep the panel. The
   * split is `inlineField`, derived from `readBlock`, so it can never drift
   * from the reader — add a second field to a block and it stops being typed
   * on, by itself.
   */
  const blkProps = (path: string, shape: "block" | "item" | "chip" = "block", extra?: string) => {
    const inline = !!onInlineCommit && !!inlineField(resume, path);
    const mark = marks?.get(path);
    const flag = flags?.get(path);
    const flagTitle = flag ? t(flag === "bad" ? "doc.review.groupBad" : "doc.review.groupWarn") : "";
    return {
      "data-block": path,
      // The review's severity, on the block itself. The dot is drawn by
      // `flagDot`'s classes rather than off this attribute, so it is not
      // load-bearing for the paint — it is here because it is the only way a
      // browser pass, a screenshot diff or a future check can ask "which blocks
      // did the review mark, and how", and a pseudo-element's colour is not
      // queryable in the DOM.
      "data-flag": flag,
      className: cn(extra, blk(path, shape)),
      // A marked block is a coloured bar and nothing else, which says "this is
      // different" without saying HOW. The title is the difference, and it is
      // also the block's accessible name for a screen reader that gets no
      // colour at all.
      //
      // BOTH, when both apply, and appended rather than one replacing the
      // other: they answer different questions ("who wrote this" and "a check
      // found something here") and picking one would silently hide the other on
      // any block that carries both. The review's half is only a SEVERITY — the
      // finding's own label and its how-sentence live in the panel, which is the
      // accessible route to what it actually says — so it reuses the panel's own
      // group headings rather than inventing a second phrasing for "to fix".
      //
      // The `mark ? t(`review.mark.${mark}`)` shape is pinned by check-mirrors
      // 18 (every BlockMark has a name in both locales, which check 8 cannot
      // see), so the flag is concatenated onto it rather than folded into a
      // join that would take that literal apart.
      title: mark
        ? t(`review.mark.${mark}`) + (flagTitle && ` · ${flagTitle}`)
        : flagTitle || undefined,
      ...(inline
        ? {
            contentEditable: EDITABLE_MODE,
            suppressContentEditableWarning: true,
            // The paper's direction, on every editable node. Never `dir="auto"`
            // — it resolves from the first strong character, so a Hebrew bullet
            // opening with "React…" would flip LTR under the caret.
            dir: paperDir,
            // iOS autocapitalises and autocorrects a contentEditable: "gRPC"
            // becomes "GRPC" and "iOS" becomes "IOS", silently, in the one
            // place a wrong string is a wrong claim.
            spellCheck: false,
            autoCapitalize: "off" as const,
          }
        : // `role="button"` is deliberately omitted on list items: putting it on
          // every <li> stops the list being a list for a screen reader.
          onEditBlock
          ? { tabIndex: 0, ...(shape !== "item" ? { role: "button" as const } : {}) }
          : {}),
    };
  };
  const contactBits = [c.email, c.phone, c.location, c.linkedin, c.website].filter(Boolean);
  const military = resume.military_service ?? [];
  const languages = resume.languages ?? [];
  const skillBlocks = skillBlocksOf(resume);

  const sections: Record<string, React.ReactNode> = {
    summary:
      resume.summary || editable ? (
        <section key="summary">
          <SectionHead spec={headSpec} dir={paperDir}>{t("sections.summary")}</SectionHead>
          <p
            {...blkProps(
              "@summary",
              "block",
              cn("text-sm", styled && spec.tight ? "leading-snug" : "leading-relaxed", prose),
            )}
            data-ph={editable ? t("edit.fields.summary") : undefined}
          >
            {resume.summary}
          </p>
        </section>
      ) : null,

    // `|| onAddSkill`: a section that renders only when it has content cannot
    // be the place you CREATE that content — the same trap the header blocks
    // have, and the same fix. Without it a from-scratch résumé has no reachable
    // way to add its first skill, and the empty synthetic block below is what
    // gives the chip somewhere to live.
    skills: skillBlocks.length > 0 || onAddSkill ? (
      <section key="skills">
        <SectionHead spec={headSpec} dir={paperDir}>{t("sections.skills")}</SectionHead>
        <div className="space-y-2">
          {(skillBlocks.length ? skillBlocks : ([["", []]] as [string, string[]][])).map(([label, items], i) => (
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
              {/* `skills="inline"` is a comma-joined RUN, which is also exactly
                  what an ATS keyword parser splits on; `skills="chips"` is the
                  bordered row. Five templates carry the first and six the
                  second, and this page drew chips for all eleven.
                  The separator sits OUTSIDE every [data-block] and TRAILS its
                  own value — the pattern and the reasoning of the five-block
                  contact line below: a leading comma would open a wrapped line
                  with punctuation. */}
              {inlineSkills ? (
                <p className={cn("text-sm", prose)}>
                  {/* `key={i}`, not `key={s}`: two skills that differ only in
                      case or punctuation share a `dkey`, so they would carry
                      the SAME data-block and `readBlock`'s `.find()` would send
                      both edits to the first one. */}
                  {items.map((s, j) => (
                    <span key={j}>
                      <span {...blkProps(`@skills.${dkey(s)}`, "chip")}>{s}</span>
                      {j < items.length - 1 && <span aria-hidden="true">, </span>}
                    </span>
                  ))}
                  {onAddSkill && (
                    <>
                      {items.length > 0 && " "}
                      <AddSkillChip
                        label={label || t("sections.skills")}
                        dir={paperDir}
                        onAdd={(text) => onAddSkill(label, text)}
                      />
                    </>
                  )}
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {items.map((s, j) => (
                    <Badge key={j} {...blkProps(`@skills.${dkey(s)}`, "chip")}>
                      {s}
                    </Badge>
                  ))}
                  {/* At the END of the row it belongs to, so the group you type
                      into is the group you were reading. The unlabelled block
                      has no name of its own, so it borrows the section heading
                      — "Add a skill to " with nothing after it is worse than
                      slightly redundant. */}
                  {onAddSkill && (
                    <AddSkillChip
                      label={label || t("sections.skills")}
                      dir={paperDir}
                      onAdd={(text) => onAddSkill(label, text)}
                    />
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    ) : null,

    experience: resume.experience.length > 0 ? (
      <section key="experience">
        <SectionHead spec={headSpec} dir={paperDir}>{t("sections.experience")}</SectionHead>
        <div className={cn("space-y-3", railed && RAIL)}>
          {/* The two entry grammars, both from `_flow.entry`:
              "stack" (9 of the 11 templates) puts the title on its own line and
              reads "Employer · Location · Dates" underneath; "split"
              (executive, ivy) keeps the title and the date range on one row with
              the dates flush to the far margin, and drops them from the meta
              line. The dates move to a SIBLING SPAN INSIDE THE SAME
              [data-block] — no field gains a data-block of its own, so
              `readBlock("@exp.i")` still returns five fields, `inlineField`
              still returns null and the entry still routes to BlockEditSheet.
              Splitting MetaLine per field is the thing that must not happen:
              it re-opens the bidi-isolate problem and buys nothing. */}
          {resume.experience.map((e, i) => {
            const dates = [e.start_date, e.end_date].filter(Boolean).join(" – ");
            return (
            <div key={i} {...blkProps(`@exp.${i}`, "block", railed ? RAIL_DOT : undefined)}>
              {splitEntry ? (
                <>
                  <div className="flex items-baseline justify-between gap-3">
                    <strong className="text-sm font-semibold text-ink">{e.title || e.company}</strong>
                    {dates && <span className="shrink-0 text-xs text-ink-muted">{dates}</span>}
                  </div>
                  <MetaLine lead={e.title ? e.company : ""} bits={[e.location]} />
                </>
              ) : (
                <>
                  <strong className="block text-sm font-semibold text-ink">{e.title || e.company}</strong>
                  <MetaLine lead={e.title ? e.company : ""} bits={[e.location, dates]} />
                </>
              )}
              <ul className={cn("mt-1 list-disc space-y-0.5 ps-5 text-sm", prose)} style={listStyle}>
                {e.bullets.map((b, j) => (
                  <li key={j} {...blkProps(`@exp.${i}.b.${j}`, "item")}>
                    {b}
                  </li>
                ))}
                {onAddBullet && (
                  <li className="list-none">
                    <button
                      type="button"
                      onClick={() => onAddBullet(`@exp.${i}`)}
                      className="-ms-5 rounded px-1 py-0.5 text-xs font-medium text-accent-soft/80 transition-colors hover:bg-accent/[0.07] hover:text-accent-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/70"
                    >
                      + {t("edit.addBullet")}
                    </button>
                  </li>
                )}
              </ul>
            </div>
            );
          })}
        </div>
      </section>
    ) : null,

    projects: resume.projects.length > 0 ? (
      <section key="projects">
        <SectionHead spec={headSpec} dir={paperDir}>{t("sections.projects")}</SectionHead>
        <div className={cn("space-y-3", railed && RAIL)}>
          {resume.projects.map((p, i) => (
            <div key={i} {...blkProps(`@proj.${i}`, "block", railed ? RAIL_DOT : undefined)}>
              <strong className="text-sm font-semibold text-ink">{p.name}</strong>
              {/* A project's description stays MUTED in both renderers — it is
                  the one piece of body copy `_flow` colours `s.muted`. */}
              {p.description && <span className="text-sm text-ink-muted"> — {p.description}</span>}
              <ul className={cn("mt-1 list-disc space-y-0.5 ps-5 text-sm", prose)} style={listStyle}>
                {p.bullets.map((b, j) => (
                  <li key={j} {...blkProps(`@proj.${i}.b.${j}`, "item")}>
                    {b}
                  </li>
                ))}
                {onAddBullet && (
                  <li className="list-none">
                    <button
                      type="button"
                      onClick={() => onAddBullet(`@proj.${i}`)}
                      className="-ms-5 rounded px-1 py-0.5 text-xs font-medium text-accent-soft/80 transition-colors hover:bg-accent/[0.07] hover:text-accent-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/70"
                    >
                      + {t("edit.addBullet")}
                    </button>
                  </li>
                )}
              </ul>
            </div>
          ))}
        </div>
      </section>
    ) : null,

    education: resume.education.length > 0 ? (
      <section key="education">
        <SectionHead spec={headSpec} dir={paperDir}>{t("sections.education")}</SectionHead>
        <div className={cn("space-y-2", railed && RAIL)}>
          {resume.education.map((e, i) => (
            <div key={i} {...blkProps(`@edu.${i}`, "block", cn("text-sm", railed && RAIL_DOT))}>
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
        <SectionHead spec={headSpec} dir={paperDir}>{t("sections.militaryService", "Military Service")}</SectionHead>
        <div className={cn("space-y-3", railed && RAIL)}>
          {military.map((m, i) => (
            <div key={i} {...blkProps(`@mil.${i}`, "block", railed ? RAIL_DOT : undefined)}>
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
              <ul className={cn("mt-1 list-disc space-y-0.5 ps-5 text-sm", prose)} style={listStyle}>
                {m.bullets.map((b, j) => (
                  <li key={j} {...blkProps(`@mil.${i}.b.${j}`, "item")}>
                    {b}
                  </li>
                ))}
                {onAddBullet && (
                  <li className="list-none">
                    <button
                      type="button"
                      onClick={() => onAddBullet(`@mil.${i}`)}
                      className="-ms-5 rounded px-1 py-0.5 text-xs font-medium text-accent-soft/80 transition-colors hover:bg-accent/[0.07] hover:text-accent-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/70"
                    >
                      + {t("edit.addBullet")}
                    </button>
                  </li>
                )}
              </ul>
            </div>
          ))}
        </div>
      </section>
    ) : null,

    certifications: resume.certifications.length > 0 ? (
      <section key="certifications">
        <SectionHead spec={headSpec} dir={paperDir}>{t("sections.certifications")}</SectionHead>
        {/* `list_cols` reaches CERTIFICATIONS and nothing else in the PDF
            (`build_certifications`), and it is capped at 2 there because wider
            grids interleave badly on text extraction. Two columns of short
            items at 390px would be four words a line, so it starts at `sm`. */}
        <ul
          className={cn(
            "list-disc space-y-0.5 ps-5 text-sm text-ink-muted",
            styled && spec.listCols === 2 && "sm:columns-2",
          )}
          style={listStyle}
        >
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
        <SectionHead spec={headSpec} dir={paperDir}>{t("sections.languages", "Languages")}</SectionHead>
        {/* "Languages ride the skills treatment" — `build_languages` draws
            chips exactly when the skills block does, and a `·`-joined line
            otherwise. Same separator rule as everywhere else on this page: it
            sits OUTSIDE every [data-block] and trails its own value. */}
        {inlineSkills ? (
          <p className={cn("text-sm", prose)}>
            {languages.map((l, i) => (
              <span key={i}>
                <span {...blkProps(`@lang.${dkey(l.language)}`, "chip")}>
                  {[l.language, l.level].filter(Boolean).join(" – ")}
                </span>
                {i < languages.length - 1 && (
                  <span aria-hidden="true" className="mx-1.5 text-ink-faint">
                    ·
                  </span>
                )}
              </span>
            ))}
          </p>
        ) : (
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
        )}
      </section>
    ) : null,
  };

  return (
    <div
      dir={paperDir}
      style={sheetVars}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
      onPaste={onPaste}
      className={cn(
        "text-ink",
        // `tight` is the Israeli one-pager convention: `_Sheet` drops
        // sec_before from 12pt to 8pt and the leading from 1.36 to 1.26.
        styled && spec.tight ? "[&_section]:mt-3.5" : "[&_section]:mt-5",
        // The serif/sans CATEGORY only. Lato and Spectral are PDF-EMBEDDED and
        // fonts.css deliberately ships nothing but the Inter/Heebo subsets, so
        // the exact face belongs to the file and the note under the document
        // says so rather than pretending otherwise.
        styled && spec.serif && "font-serif",
        // `heading="hung"` (minimal) sets its headings BESIDE the body instead
        // of above it. It is placed here, on the sections, rather than in
        // SectionHead: the sheet's own gutter is ~27px at 390px against the
        // PDF's 84pt margin, so below `sm` there is nothing to hang into and
        // the heading degrades to `plain`. Grid columns follow the writing
        // direction, so RTL mirrors with no second rule.
        styled &&
          spec.heading === "hung" &&
          "sm:[&_section]:grid sm:[&_section]:grid-cols-[5.5rem_1fr] sm:[&_section]:items-baseline sm:[&_section]:gap-x-3",
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
      {/* `header="band"`: the name, headline and contact reversed out of a
          filled rectangle that BLEEDS to the page edges — the single biggest
          visual difference between the eleven templates, and the one the screen
          had no version of at all. The negative margins are the sheet's own
          padding, spelled the same way, so the two cancel exactly; the corners
          take the sheet's own radius so the fill cannot poke past its ring.
          The blocks inside are UNTOUCHED — same classNames, same blkProps, same
          paths. The reversed-out palette arrives entirely through `bandVars`,
          which is what keeps a colour change out of the block markup. */}
      <div
        style={band ? { ...bandVars, background: bandFill(spec) } : undefined}
        className={
          cn(
            centred && "text-center",
            band &&
              "-mx-[clamp(20px,7%,56px)] -mt-[clamp(22px,5.5%,46px)] rounded-t-[3px] px-[clamp(20px,7%,56px)] pb-[clamp(18px,4.7%,39px)] pt-[clamp(22px,5.5%,46px)]",
          ) || undefined
        }
      >
      {/* On an EDITABLE document the empty state is a real placeholder — an
          empty node plus `data-ph`, drawn by CSS — never the fallback string as
          text. As text it is committable: tapping the largest target on a
          nameless CV and tapping away would write "Résumé" in as the person's
          name. As a placeholder there is nothing there to commit.
          Read-only surfaces (the tracker's détail modal, a tailored draft)
          still get the words, because they have no caret to protect. */}
      <div
        {...blkProps(
          "@contact.name",
          "block",
          // `name_tracking` is negative on every template — names are set tight
          // — and it is halved in Hebrew exactly as the renderers halve it.
          cn("text-xl font-bold text-ink", styled && "tracking-[var(--doc-name-tracking)]"),
        )}
        data-ph={editable ? t("sections.fallbackName") : undefined}
      >
        {editable ? c.name : c.name || t("sections.fallbackName")}
      </div>
      {/* Rendered even when empty while editing, or they are unreachable: a
          from-scratch résumé has no headline, no summary and no contact line,
          and a section that renders nothing cannot be tapped into. */}
      {(resume.headline || editable) && (
        <div
          {...blkProps("@headline", "block", "mt-0.5 text-sm font-medium text-accent-soft")}
          data-ph={editable ? t("edit.fields.headline") : undefined}
        >
          {resume.headline}
        </div>
      )}
      {/* FIVE blocks while editing, one fused line when not.
          The fused line was a single five-field block, so `inlineField` sent it
          to the panel and phone and location were reachable no other way — the
          reported gap. All five render even when empty, each showing its CSS
          placeholder, which is the only thing that makes an absent phone number
          discoverable at all.
          The "·" sits OUTSIDE every [data-block], so tapping it does nothing,
          and it TRAILS its own bit rather than leading the next one. That is the
          opposite of MetaLine's rule, and deliberately so: MetaLine cannot wrap
          mid-line, this row is `flex-wrap` and at 390px it breaks into four.
          With a leading dot every wrapped line opened with "· ", which reads as
          a bullet list rather than a separator — seen on the real document at a
          390px viewport. Trailing it means a line can only ever END with the
          dot, and `i < length - 1` keeps it off the last bit.
          `min-w-0 break-words` is what keeps a long URL wrapping inside
          the page instead of pushing the sheet wider.
          `blkProps` puts the explicit `paperDir` on each editable node, which is
          what keeps this split out of the bidi-isolate trap: the fragments never
          resolve their own direction. */}
      {editable ? (
        <div
          className={cn(
            "mt-0.5 flex flex-wrap items-baseline gap-x-1 gap-y-0.5 text-xs text-ink-muted",
            centred && "justify-center",
          )}
        >
          {CONTACT_FIELDS.map((k, i) => (
            <span key={k} className="inline-flex min-w-0 items-baseline gap-1">
              <span
                {...blkProps(`@contact.${k}`, "block", "min-w-0 break-words")}
                data-ph={t(`edit.fields.${k}`)}
              >
                {c[k]}
              </span>
              {i < CONTACT_FIELDS.length - 1 && (
                <span aria-hidden="true" className="text-ink-faint">
                  ·
                </span>
              )}
            </span>
          ))}
        </div>
      ) : (
        contactBits.length > 0 && (
          <div {...blkProps("@contact", "block", "mt-0.5 text-xs text-ink-muted")}>
            {contactBits.join(" · ")}
          </div>
        )
      )}
      </div>

      {/* `header="rule"` — ONE hairline under the contact block, in the accent
          when the template asks for it. `header` is authoritative in both
          renderers and "plain" (ivy, minimal) draws none; this page drew none
          for anybody, so timeline, ledger and compact were missing the 1.6-2pt
          accent rule that is most of their character. */}
      {styled && spec.header === "rule" && (
        <div
          aria-hidden="true"
          className="mt-2"
          style={{
            borderBottomStyle: "solid",
            borderBottomWidth: rulePx(spec.headerRulePt),
            borderBottomColor: spec.headerRuleAccent ? spec.accent : spec.rule,
          }}
        />
      )}

      {sectionOrder(resume).map((key) => sections[key])}

      {/* Outside every [data-block] on purpose: it emits no path, so
          check-mirrors check 7 has nothing to validate and the add control can
          never be mistaken for a part of the résumé. */}
      {onAdd && onAddNamed ? (
        <AddToResume dir={paperDir} onAdd={onAdd} onAddNamed={onAddNamed} />
      ) : (
        footNote && (
          <p className="mt-6 border-t border-line pt-4 text-xs leading-relaxed text-ink-faint">{footNote}</p>
        )
      )}
    </div>
  );
}
