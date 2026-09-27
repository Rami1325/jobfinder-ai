import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isAndroid } from "../lib/inAppBrowser";
import {
  createDictation,
  dictationLang,
  recognitionCtor,
  type DictationNote,
  type DictationState,
} from "../lib/dictation";

export interface Dictation {
  /** This browser has speech recognition. Without it nothing is drawn. */
  supported: boolean;
  listening: boolean;
  /** Why the mic last stopped, when the person should be told. */
  note: DictationNote | null;
  /** The box is not taking input (a message on its way, a scorecard up). */
  disabled: boolean;
  toggle: () => void;
  /** Stop now and keep what the box shows: call it before sending the answer. */
  cancel: () => void;
}

/**
 * The mic of one interview answer box (docs/handbook/interview.md). `value` and
 * `onChange` are the box's own state: the words heard are written through
 * `onChange`, after whatever the box held, and never over it. `question` is
 * what the answer answers, whose language the browser listens for.
 *
 * The browser's own speech service hears the audio; this hook sends nothing
 * anywhere (check-mirrors 89), and the page's own Send stays the only way the
 * answer leaves.
 */
export function useDictation({
  value,
  onChange,
  question,
  disabled = false,
}: {
  value: string;
  onChange: (text: string) => void;
  question?: string | null;
  disabled?: boolean;
}): Dictation {
  const { i18n } = useTranslation();
  const [state, setState] = useState<DictationState>({ listening: false, note: null });

  // Read through refs, so the controller made once always sees this render's
  // box, setter and language. `write` moves the ref at once: a second result can
  // arrive before React renders the first.
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const langRef = useRef(dictationLang(i18n.resolvedLanguage, question));
  langRef.current = dictationLang(i18n.resolvedLanguage, question);

  const controller = useMemo(() => {
    const ctor = typeof window === "undefined" ? null : recognitionCtor(window);
    if (!ctor) return null;
    return createDictation({
      ctor,
      read: () => valueRef.current,
      write: (text) => {
        valueRef.current = text;
        onChangeRef.current(text);
      },
      lang: () => langRef.current,
      onState: setState,
      android: typeof navigator !== "undefined" && isAndroid(navigator.userAgent),
    });
  }, []);

  // The box went away: nothing may be written into it after this.
  useEffect(() => () => controller?.cancel(), [controller]);

  // The box stopped taking input while the mic was on.
  useEffect(() => {
    if (disabled) controller?.cancel();
  }, [disabled, controller]);

  // The page went to the background (another app, a locked phone, another tab):
  // stop listening cleanly. The words already heard stay in the box.
  useEffect(() => {
    if (!controller) return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") controller.stop();
    };
    const onPageHide = () => controller.cancel();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [controller]);

  return {
    supported: controller !== null,
    listening: state.listening,
    note: state.note,
    disabled,
    toggle: () => {
      if (!controller || disabled) return;
      if (state.listening) controller.stop();
      else controller.start();
    },
    cancel: () => controller?.cancel(),
  };
}
