import { useState } from "react";
import { MessageSquarePlus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { deleteMyData, sendFeedback } from "../api/client";
import { Button, Modal, useToast } from "./ui";

/** Floating friends-beta feedback pill, mounted once in AppLayout. Sits at the
 * bottom end corner (z-40: above content, below modals at z-50 / toasts at 60). */
export default function FeedbackButton() {
  const { t } = useTranslation();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  // Privacy wipe (PLAN 7.5): two-step confirm so a stray click can't erase data.
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [wiping, setWiping] = useState(false);

  async function wipe() {
    if (wiping) return;
    setWiping(true);
    try {
      await deleteMyData();
      toast("success", t("privacy.wiped"));
      // Every client store (master résumé, kits, search results) is now stale —
      // a clean reload is the honest reset.
      setTimeout(() => window.location.assign("/jobs"), 800);
    } catch {
      toast("error", t("privacy.wipeError"));
      setWiping(false);
    }
  }

  async function submit() {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await sendFeedback(window.location.pathname, trimmed);
      setOpen(false);
      setText("");
      toast("success", t("feedback.sent"));
    } catch {
      toast("error", t("feedback.error"));
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-4 end-4 z-40 flex items-center gap-1.5 rounded-full border border-line bg-panel px-3 py-2.5 text-sm font-medium text-ink-muted shadow-panel transition-colors hover:border-accent/50 hover:text-ink sm:px-3.5"
      >
        <MessageSquarePlus size={16} />
        <span className="hidden sm:inline">{t("feedback.button")}</span>
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={t("feedback.title")} maxWidth="max-w-md">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("feedback.placeholder")}
          className="min-h-[120px] w-full resize-y rounded-xl border border-line bg-bg-soft p-4 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/25"
        />
        <div className="mt-4 flex justify-end">
          <Button onClick={submit} loading={sending} disabled={!text.trim()}>
            {t("feedback.send")}
          </Button>
        </div>
        <div className="mt-6 border-t border-line pt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            {t("privacy.title")}
          </p>
          {!confirmWipe ? (
            <button
              onClick={() => setConfirmWipe(true)}
              className="mt-2 inline-flex items-center gap-1.5 text-xs text-ink-muted transition-colors hover:text-danger"
            >
              <Trash2 size={13} /> {t("privacy.wipeCta")}
            </button>
          ) : (
            <div className="mt-2 space-y-2">
              <p className="text-xs text-danger">{t("privacy.wipeConfirmBody")}</p>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="danger" onClick={wipe} loading={wiping}>
                  {t("privacy.wipeConfirm")}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setConfirmWipe(false)} disabled={wiping}>
                  {t("privacy.wipeCancel")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
