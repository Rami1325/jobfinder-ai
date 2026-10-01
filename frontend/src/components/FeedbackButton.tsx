import { useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { sendFeedback } from "../api/client";
import { Button, Modal, useToast } from "./ui";

/** The friends-beta feedback dialog, and its floating pill on a desktop. Mounted
 * once in AppLayout, which holds `open`: below `lg` the pill is gone and "Send
 * feedback" is a row in the account menu (PLAN 31.2/12, owner decision 4), because
 * a pill floating over the paper on every page of a phone covered what the user
 * was reading. At `lg` the pill sits at the bottom end corner (z-40: above
 * content, below modals at z-50 / toasts at 60). check-mirrors 41 reads this
 * class: with the pill hidden below `lg`, main's padding clears the tab bar.
 *
 * The privacy wipe used to hang off the bottom of this dialog (PLAN 7.5). It
 * moved to Settings' Danger zone in 23.5: an irreversible account action buried
 * under "Send feedback" is somewhere nobody looking for it would think to open,
 * and somewhere a user typing feedback could find it by accident. The
 * `privacy.*` keys are unchanged and Settings reuses them verbatim. */
export default function FeedbackButton({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const setOpen = onOpenChange;
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
        // Named even though its label now always shows: below `sm` it used to be
        // an icon with no name, announced as "button" (PLAN 31.1/9, check 50).
        aria-label={t("feedback.button")}
        className="fixed bottom-4 end-4 z-40 hidden min-h-11 items-center gap-1.5 rounded-full border border-line bg-panel px-3.5 py-2.5 text-sm font-medium text-ink-muted shadow-panel transition-colors hover:border-accent/50 hover:text-ink lg:flex"
      >
        <MessageSquarePlus size={16} />
        <span>{t("feedback.button")}</span>
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={t("feedback.title")} maxWidth="max-w-md">
        <textarea
          dir="auto"
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
