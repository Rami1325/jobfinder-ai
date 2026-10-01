// "Not for me" (PLAN 31.5/4): the notice a hidden row leaves behind, with the
// wider hides it offers, and the sheet that lists every hide with a way back.
// The SERVER does all the matching (app/core/hidden_jobs.py): these components
// only say what the user chose, and `titleWords` only picks which words of a
// title to OFFER as chips, never which postings a word covers.
import { useTranslation } from "react-i18next";
import { EyeOff, X } from "lucide-react";
import { Button, Modal } from "../../components/ui";
import type { HiddenJobs } from "../../types";

/** Words too common to be worth offering as a hide: the Latin and Hebrew filler
 * of a job title. */
const FILLER = new Set([
  "and", "the", "for", "with", "from", "our", "you", "your", "all", "new",
  "של", "עם", "או", "את", "על", "לא", "גם",
]);

/** Up to four words of a title worth offering as "Hide titles with…": letters
 * only (Latin or Hebrew), three characters or more, filler dropped, first
 * spelling kept, in the title's own order. */
export function titleWords(title: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of (title || "").split(/[^\p{L}\p{N}+#]+/u)) {
    const word = raw.trim();
    const key = word.toLocaleLowerCase();
    if (word.length < 3 || FILLER.has(key) || seen.has(key) || /^\d+$/.test(word)) continue;
    seen.add(key);
    out.push(word);
    if (out.length === 4) break;
  }
  return out;
}

export interface HiddenNotice {
  title: string;
  company: string;
  /** What this notice added, as the SERVER stored it (the keys its PUT answered
   * with), so Undo takes back exactly those and the page never re-derives a key. */
  url_key: string;
  company_key: string;
  word_keys: string[];
}

/** Left where a hidden row was: what went, and the two wider hides, one tap each. */
export function NotForMeNotice({
  notice,
  onHideCompany,
  onHideWord,
  onUndo,
  onDismiss,
}: {
  notice: HiddenNotice;
  onHideCompany: () => void;
  onHideWord: (word: string) => void;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation("jobs");
  const { t: tCommon } = useTranslation("common");
  const words = titleWords(notice.title).filter((w) => !notice.word_keys.includes(w.toLocaleLowerCase()));
  // Every control on the notice is a 44 px BOX (the third tap-target pass):
  // Undo and the close sit 8 px apart and the chips wrap 6 px apart, so a layer
  // on any of them would lie over its neighbour. The notice is passing, so the
  // height it gains costs no list its place.
  const chip =
    "inline-flex min-h-11 items-center rounded-full border border-line px-3 text-xs font-medium text-ink transition-colors hover:border-accent/50 hover:bg-accent/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70";
  return (
    <div role="status" className="rounded-xl border border-line bg-panel-2/40 py-1 pe-1 ps-3 text-sm text-ink-muted">
      <div className="flex items-start gap-1">
        <EyeOff size={15} aria-hidden className="mt-3.5 shrink-0" />
        <p className="ms-1 min-w-0 flex-1 py-3" dir="auto">
          {t("hide.done", { title: notice.title })}
        </p>
        <button type="button" onClick={onUndo} className="inline-flex min-h-11 shrink-0 items-center px-2 text-xs font-semibold text-accent-soft hover:underline">
          {t("hide.undo")}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={tCommon("actions.close")}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-ink-faint hover:text-ink"
        >
          <X size={14} aria-hidden />
        </button>
      </div>
      {(notice.company && !notice.company_key) || words.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-xs">{t("hide.also")}</span>
          {notice.company && !notice.company_key && (
            <button type="button" onClick={onHideCompany} className={chip} dir="auto">
              {t("hide.alsoCompany", { company: notice.company })}
            </button>
          )}
          {words.map((w) => (
            <button key={w} type="button" onClick={() => onHideWord(w)} className={chip} dir="auto">
              {t("hide.alsoWord", { word: w })}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** "N hidden by you · Manage": said wherever a list left jobs out for the user. */
export function HiddenCount({ count, onManage }: { count: number; onManage: () => void }) {
  const { t } = useTranslation("jobs");
  if (count <= 0) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-xs text-ink-muted">
      <EyeOff size={13} aria-hidden />
      {t("hide.count", { count })}
      {/* `tap-44`: the line is text, and the lists' rows start 16-24 px away. */}
      <button type="button" onClick={onManage} className="tap-44 font-semibold text-accent-soft hover:underline">
        {t("hide.manage")}
      </button>
    </p>
  );
}

/** Every hide, each with its way back. A posting is kept by its address alone,
 * which no one can read, so the postings are one count with one "show again". */
export function HiddenManager({
  open,
  hidden,
  onChange,
  onClose,
}: {
  open: boolean;
  hidden: HiddenJobs | null;
  onChange: (next: HiddenJobs) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("jobs");
  const h = hidden ?? { urls: [], companies: [], title_words: [] };
  const empty = !h.urls.length && !h.companies.length && !h.title_words.length;
  const row = (value: string, remove: () => void) => (
    <li key={value} className="flex min-h-11 items-center justify-between gap-2 rounded-lg border border-line ps-3">
      <span className="min-w-0 truncate text-sm text-ink" dir="auto">
        {value}
      </span>
      <button
        type="button"
        onClick={remove}
        aria-label={t("hide.unhide", { value })}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-ink-muted hover:bg-panel-2 hover:text-ink"
      >
        <X size={14} aria-hidden />
      </button>
    </li>
  );
  return (
    <Modal open={open} onClose={onClose} title={t("hide.title")} maxWidth="max-w-md" sheet>
      {empty ? (
        <p className="text-sm text-ink-muted">{t("hide.none")}</p>
      ) : (
        <div className="space-y-4">
          {h.companies.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-xs font-semibold text-ink-muted">{t("hide.companies")}</h3>
              <ul className="space-y-1.5">
                {h.companies.map((c) => row(c, () => onChange({ ...h, companies: h.companies.filter((x) => x !== c) })))}
              </ul>
            </section>
          )}
          {h.title_words.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-xs font-semibold text-ink-muted">{t("hide.words")}</h3>
              <ul className="space-y-1.5">
                {h.title_words.map((w) => row(w, () => onChange({ ...h, title_words: h.title_words.filter((x) => x !== w) })))}
              </ul>
            </section>
          )}
          {h.urls.length > 0 && (
            <section className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-ink">{t("hide.postings", { count: h.urls.length })}</span>
              <Button size="sm" variant="secondary" onClick={() => onChange({ ...h, urls: [] })} className="min-h-11">
                {t("hide.showPostings")}
              </Button>
            </section>
          )}
          <p className="text-xs text-ink-faint">{t("hide.nextSearch")}</p>
        </div>
      )}
    </Modal>
  );
}
