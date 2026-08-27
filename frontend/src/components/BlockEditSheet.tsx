import { useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { Trash2, X } from "lucide-react";
import { readBlock, removeBlock, writeBlock, type Values } from "../lib/resumeBlocks";
import { Button } from "./ui";
import { cn } from "../lib/cn";
import type { ResumeModel } from "../types";

interface Props {
  /** The block being edited, or null when the sheet is closed. */
  path: string | null;
  resume: ResumeModel;
  /** Which way the DOCUMENT reads — not the UI. See the `dir` note below. */
  paperDir: "ltr" | "rtl";
  onClose: () => void;
  /** The edited résumé, plus the path to re-anchor to (a keyed rename moves it). */
  onApply: (next: ResumeModel, path: string) => void;
  /** The block no longer resolves — an index shifted under us. */
  onGone: () => void;
}

/**
 * Edit one block of the résumé.
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
export default function BlockEditSheet({ path, resume, paperDir, onClose, onApply, onGone }: Props) {
  const { t } = useTranslation("tailor");
  const titleId = useId();
  const open = path !== null;

  const draft = useMemo(() => (path ? readBlock(resume, path) : null), [resume, path]);
  const [values, setValues] = useState<Values>({});

  // Seed on open only. Re-seeding on every render would fight typing.
  useEffect(() => {
    if (!draft) return;
    setValues(Object.fromEntries(draft.fields.map((f) => [f.key, f.value])));
  }, [draft?.path]); // eslint-disable-line react-hooks/exhaustive-deps

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

  function save() {
    if (!draft) return;
    const r = writeBlock(resume, draft.path, values);
    if (!r.ok) return onGone();
    onApply(r.resume, r.path);
  }

  function remove() {
    if (!draft) return;
    const r = removeBlock(resume, draft.path);
    if (!r.ok) return onGone();
    onApply(r.resume, "");
  }

  return createPortal(
    <AnimatePresence>
      {open && draft && (
        <>
          <motion.div
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            initial={hidden}
            animate={{ x: 0, y: 0 }}
            exit={hidden}
            transition={{ type: "tween", duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className={cn(
              "fixed z-50 flex flex-col border-line bg-panel shadow-panel",
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
                className="rounded-lg p-1.5 text-ink-muted transition hover:bg-panel-2 hover:text-ink"
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
                      // the paper follows the résumé's own language.
                      dir={paperDir}
                      autoFocus={i === 0}
                      value={values[field.key] ?? ""}
                      onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                    />
                  ) : (
                    <input
                      type="text"
                      className="w-full rounded-lg border border-line bg-bg-soft px-3 py-2 text-ink outline-none transition focus:border-accent/60"
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
              {draft.removable && (
                <button
                  type="button"
                  onClick={remove}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-danger/40 px-2.5 py-1.5 text-xs font-medium text-danger transition hover:bg-danger/10"
                >
                  <Trash2 size={13} /> {t("edit.remove")}
                </button>
              )}
              <Button variant="ghost" className="ms-auto" onClick={onClose}>
                {t("edit.cancel")}
              </Button>
              <Button onClick={save}>{t("edit.apply")}</Button>
            </footer>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}
