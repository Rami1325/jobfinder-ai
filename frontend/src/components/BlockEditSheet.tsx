import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { Trash2, X } from "lucide-react";
import { isEntryKind, readBlock, removeBlock, writeBlock, type Values } from "../lib/resumeBlocks";
import { Button } from "./ui";
import { cn } from "../lib/cn";
import { useDialogFocus } from "../hooks/useDialogFocus";
import type { ResumeModel } from "../types";

interface Props {
  /** The block being edited, or null when the sheet is closed. */
  path: string | null;
  resume: ResumeModel;
  /** Which way the DOCUMENT reads — not the UI. See the `dir` note below. */
  paperDir: "ltr" | "rtl";
  onClose: () => void;
  /** The edited resume, plus the path to re-anchor to (a keyed rename moves it). */
  onApply: (next: ResumeModel, path: string) => void;
  /**
   * The TAILORED document: hand back the raw VALUES for this block instead of a
   * whole resume, because the page stores them as an override keyed by the
   * block's source anchor rather than writing them into a resume that is
   * recomputed on every accept and decline. Entry granularity is exactly what
   * this sheet already edits ("the sheet edits an ENTRY, not a field"), so the
   * override grain and the panel's grain are the same thing.
   *
   * When given it REPLACES `onApply` — `onApply` writes the master.
   */
  onApplyValues?: (values: Values, path: string) => void;
  /** The block no longer resolves — an index shifted under us. */
  onGone: () => void;
}

/**
 * Edit one block of the resume.
 *
 * COMPOUND BLOCKS ONLY, since 23.1. A block that is ONE model field is typed
 * on directly in the document; this panel is for the six that fuse several
 * facts into a single printed line — the job header, a degree, the contact
 * line, the project heading, a language. "Employer · Location · Dates" is five
 * model fields in one text node, and a caret in it has nothing to write back
 * to: splitting it needs a `dir` per fragment, which opens a bidi isolate and
 * strands the separators.
 *
 * THE OLD JUSTIFICATION HERE WAS FALSE, and it is worth recording rather than
 * quietly deleting. It read: "at 390px an A4 page renders at about 45% scale,
 * so body text is roughly 6px — there is nothing to click accurately." That is
 * true of the PDF <iframe> in DocumentPanel and was applied to the wrong
 * surface. Measured on the running app at a 390px viewport: `.sheet` is
 * `transform: none`, 347.3px wide, with 14px body text. ResumeView is a
 * reflowing column at full readable size, which is why typing on it works.
 * What DOES survive: there is no hover on a phone, and a toolbar pinned near
 * the caret fights the on-screen keyboard — so this stayed a sheet rather than
 * becoming a popover, and inline editing grew no toolbar at all.
 *
 * The same component serves both geometries: a bottom sheet below `lg`, a side
 * panel above it.
 *
 * NOT built on `Modal`: that one is `items-start justify-center` with no
 * `max-h` and no internal scroller, so a long entry pushes its own Save button
 * off the screen.
 *
 * ANIMATION IS TRANSFORM AND OPACITY ONLY. Never `height: "auto"` — this is
 * exactly the click-to-open case that wedged `Disclosure` at `height: 0px` with
 * its content present underneath, and the fixed `max-h` plus an inner
 * `overflow-y-auto` is the layout anyway.
 */
export default function BlockEditSheet({
  path,
  resume,
  paperDir,
  onClose,
  onApply,
  onApplyValues,
  onGone,
}: Props) {
  const { t } = useTranslation("tailor");
  const titleId = useId();
  const open = path !== null;
  // Tab stays in the sheet and focus returns to the paper when it closes; the
  // first field's `autoFocus` still takes focus on open (the hook leaves it).
  const sheetRef = useRef<HTMLDivElement>(null);

  const draft = useMemo(() => (path ? readBlock(resume, path) : null), [resume, path]);
  const [values, setValues] = useState<Values>({});

  // Seed on open only. Re-seeding on every render would fight typing.
  useEffect(() => {
    if (!draft) return;
    setValues(Object.fromEntries(draft.fields.map((f) => [f.key, f.value])));
  }, [draft?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  useDialogFocus(open && !!draft, sheetRef);

  // An index can shift out from under an open sheet (a bullet above it was
  // removed). Say so rather than silently editing the wrong thing.
  useEffect(() => {
    if (open && !draft) onGone();
  }, [open, draft, onGone]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  // A transform is PHYSICAL, so the axis and sign are computed rather than
  // written as a class — the same reason the app's drawer and toasts do it.
  const rtlChrome = typeof document !== "undefined" && document.documentElement.dir === "rtl";
  const wide = typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches;
  const hidden = wide ? { x: rtlChrome ? "-100%" : "100%" } : { y: "100%" };

  /**
   * On the TAILORED document an entry can be blanked but not removed, and the
   * blanked husk ships. This is the gap that closes it.
   *
   * The trash is correctly hidden on the override path (see the footer's note),
   * but Apply was not: `applyOverrides` decides write-vs-remove with the same
   * `readBlock(...).removable` rule the inline path uses, and `removable` is
   * FALSE for every entry — so an all-blank entry override fell through to the
   * WRITE branch. Executed, that produces
   * `{"company":"","title":"","location":"","start_date":"","end_date":"","bullets":["…","…"]}`
   * — a nameless job with two bullets under it, printed into both downloads and
   * stored on the tracker row as what was sent.
   *
   * REFUSED, rather than taught to mean removal, and the choice is the same one
   * the trash's own note already made: an anchor names a coordinate in the
   * original/tailored resume, where "not present" is ALREADY what a declined
   * addition and an accepted removal mean, so a removal override would be a
   * second grammar for an idea the anchor space can already express — two
   * mechanisms answering "is this entry on the page", free to disagree. The
   * fallthrough had to go either way: silently meaning "keep an empty one" is
   * the worst of the three.
   *
   * Live, not on tap. The consequence is stated while it is still true and
   * clears itself the moment any field has a character in it, which is the same
   * order the danger zone uses — say what will happen before the press, not
   * after it.
   */
  // `values` starts `{}` and is filled by a passive effect keyed on the draft's
  // path, so on the first render after the panel opens EVERY field reads empty —
  // and without this guard the refusal painted itself, disabled Apply included,
  // over fields that were about to be populated. `seeded` asks whether the
  // effect has run, not whether the fields are blank: a key is PRESENT once
  // seeded even when its value is "", which is exactly the distinction between
  // "the user emptied this" and "we have not looked yet".
  const seeded = !!draft && draft.fields.some((f) => f.key in values);
  const blankEntry =
    !!onApplyValues &&
    !!draft &&
    seeded &&
    isEntryKind(draft.kind) &&
    draft.fields.every((f) => !(values[f.key] ?? "").trim());

  function save() {
    if (!draft || blankEntry) return;
    // The tailored path never builds a resume here: the page applies these
    // values over a merge it recomputes itself, so handing it a finished resume
    // would be handing it something the next accept/decline throws away.
    if (onApplyValues) return onApplyValues(values, draft.path);
    const r = writeBlock(resume, draft.path, values);
    if (!r.ok) return onGone();
    onApply(r.resume, r.path);
  }

  function remove() {
    if (!draft) return;
    // On the tailored document a removal IS an override whose values are all
    // blank — the same empty-means-remove rule the inline path uses, which is
    // why the button below is offered only for `removable` blocks there.
    if (onApplyValues) {
      return onApplyValues(Object.fromEntries(draft.fields.map((f) => [f.key, ""])), draft.path);
    }
    const r = removeBlock(resume, draft.path);
    if (!r.ok) return onGone();
    onApply(r.resume, "");
  }

  return createPortal(
    <AnimatePresence>
      {open && draft && (
        <>
          {/* z-50, the app's modal layer, NOT z-40. The scrim and the panel are
              one dialog and must share a layer: at 40 the app header (sticky,
              its own stacking context) painted over the dim, leaving a bright
              and fully tappable 56px strip on top of an aria-modal dialog. The
              panel below stays on top of the scrim by DOM order — it is the
              later sibling at the same z — which is the same trick `Modal`
              uses with its single z-50 wrapper. */}
          <motion.div
            className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
          <motion.div
            ref={sheetRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            initial={hidden}
            animate={{ x: 0, y: 0 }}
            exit={hidden}
            transition={{ type: "tween", duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className={cn(
              "fixed z-50 flex flex-col border-line bg-panel shadow-panel outline-none",
              // dvh, not vh: on a phone the visual viewport shrinks when the
              // keyboard opens, and vh does not notice.
              "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-xl2 border-t",
              "lg:inset-y-0 lg:end-0 lg:start-auto lg:max-h-none lg:w-[26rem] lg:rounded-none lg:border-s lg:border-t-0",
            )}
          >
            <header className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
              <h2 id={titleId} className="text-base font-semibold text-ink">
                {t(`edit.blocks.${draft.kind}`)}
              </h2>
              <button
                type="button"
                onClick={onClose}
                aria-label={t("edit.cancel")}
                className="tap-44 rounded-lg p-1.5 text-ink-muted transition hover:bg-panel-2 hover:text-ink"
              >
                <X size={18} />
              </button>
            </header>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
              {draft.fields.map((field, i) => (
                <label key={field.key} className="block">
                  <span className="mb-1 block text-xs font-medium text-ink-muted">
                    {t(`edit.fields.${field.key}`)}
                  </span>
                  {field.kind === "text" ? (
                    <textarea
                      // Explicit min-height: a bare textarea inherits a 220px
                      // floor from the global stylesheet, which would make a
                      // one-line bullet fill the sheet.
                      className="min-h-[7.5rem] w-full rounded-lg border border-line bg-bg-soft px-3 py-2 text-ink outline-none transition focus:border-accent/60"
                      // EXPLICIT dir, never dir="auto": auto resolves from the
                      // first strong character, so a Hebrew bullet that starts
                      // with "React" flips LTR under the caret and flips back
                      // when you delete it. The chrome follows the UI locale;
                      // the paper follows the resume's own language.
                      dir={paperDir}
                      autoFocus={i === 0}
                      value={values[field.key] ?? ""}
                      onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                    />
                  ) : (
                    <input
                      type="text"
                      className="min-h-11 w-full rounded-lg border border-line bg-bg-soft px-3 py-2 text-ink outline-none transition focus:border-accent/60"
                      dir={paperDir}
                      autoFocus={i === 0}
                      value={values[field.key] ?? ""}
                      onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                    />
                  )}
                </label>
              ))}
            </div>

            {/* The safe-area padding is why Save clears the home indicator. */}
            <footer className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
              {/* `w-full` so it takes a line of its own above the buttons, and
                  real text rather than a `title` on the disabled Apply: a
                  tooltip does not exist on the phone this document is read on.
                  Static markup, no reveal — a height tween on a conditional
                  inside a flex footer is check 11's defect one more time. */}
              {blankEntry && (
                <p className="w-full text-xs leading-relaxed text-danger">
                  {t("edit.tailoredNoBlankEntry")}
                </p>
              )}
              {/* `removable` is FALSE for every entry, by design — it governs
                  the inline empty-means-remove rule, which must never be able
                  to delete a job by clearing one of its five fields. Gating the
                  button on it alone meant `removeBlock`'s RE_ENTRY branch was
                  unreachable and a role added by mistake could not be taken off
                  the document at all. This is the gesture 23.2 said it had. */}
              {/* `!onApplyValues` on the entry half, and it is not caution.
                  `removable` is false for every entry, so an entry deletion has
                  to go through `removeBlock` — and an override cannot express
                  it: the anchor names a coordinate in the original/tailored
                  resume, where "not present" is already what a declined
                  addition and an accepted removal mean. Offering it on the
                  per-application overlay would need a second, contradictory
                  grammar for the same idea. On the tailored document the trash
                  therefore appears only where empty-means-remove can say it. */}
              {(draft.removable || (!onApplyValues && isEntryKind(draft.kind))) && (
                <button
                  type="button"
                  onClick={remove}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-danger/40 px-2.5 py-1.5 text-xs font-medium text-danger transition hover:bg-danger/10"
                >
                  <Trash2 size={13} /> {t("edit.remove")}
                </button>
              )}
              <Button variant="ghost" className="ms-auto" onClick={onClose}>
                {t("edit.cancel")}
              </Button>
              <Button onClick={save} disabled={blankEntry}>
                {t("edit.apply")}
              </Button>
            </footer>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}
