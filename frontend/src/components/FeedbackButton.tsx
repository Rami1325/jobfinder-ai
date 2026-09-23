import { useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { sendFeedback } from "../api/client";
import { Button, Modal, useToast } from "./ui";

/** Floating friends-beta feedback pill, mounted once in AppLayout. Sits at the
 * bottom end corner (z-40: above content, below modals at z-50 / toasts at 60).
 *
 * The privacy wipe used to hang off the bottom of this dialog (PLAN 7.5). It
 * moved to Settings' Danger zone in 23.5: an irreversible account action buried
 * under "Send feedback" is somewhere nobody looking for it would think to open,
 * and somewhere a user typing feedback could find it by accident. The
 * `privacy.*` keys are unchanged and Settings reuses them verbatim. */
export default function FeedbackButton() {
  const { t } = useTranslation();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

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
        // The visible label is `hidden sm:inline`, so below `sm` this button was
        // an icon with no name: a screen reader announced "button" (PLAN 31.1/9).
        aria-label={t("feedback.button")}
        className="fixed bottom-[calc(4.25rem+env(safe-area-inset-bottom))] end-4 z-40 flex items-center gap-1.5 rounded-full border border-line bg-panel px-3 py-2.5 text-sm font-medium text-ink-muted shadow-panel transition-colors hover:border-accent/50 hover:text-ink sm:px-3.5 lg:bottom-4"
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
      </Modal>
    </>
  );
}
