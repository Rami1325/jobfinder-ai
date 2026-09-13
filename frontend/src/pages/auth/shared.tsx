import { useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff } from "lucide-react";
import { safeNext } from "../../lib/safeNext";

/**
 * What every auth page shares: the card, a labelled field, the email and
 * password inputs, and the message slots.
 *
 * Not promoted to components/ui. These are specific to a form a thumb fills in
 * on a phone: 44px controls, left-to-right fields inside a Hebrew page, and
 * autocomplete hints. The app's dense tool forms want none of that.
 */

/**
 * The input class for every auth field: name, email, password and code.
 *
 * It matches what styles.css's global `input[type="text"]` rule forces. That
 * selector outranks a utility class, so a type="text" input gets `padding:
 * 10px`, `background: var(--bg)` and `font: inherit` whatever its classes say.
 * A SHOWN password is a type="text" input, so with `inputCls`' px-3 and
 * bg-bg-soft, pressing "show" moved the text 2px and changed the background
 * under the user's thumb. Written to the same values (px-2.5, bg-bg,
 * text-base), every field looks the same in every state.
 */
export const authInputCls =
  "block h-11 w-full rounded-lg border border-line bg-bg px-2.5 text-base text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none disabled:opacity-50";

/** A text link with a 44px tap target and no 44px look. */
export const authLinkCls =
  "inline-flex min-h-[44px] items-center rounded font-medium text-accent-soft hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70";

/** A link that is the page's main way on, drawn like the primary Button. A
 * link, not a Button inside a Link: that nests a button in an anchor, which is
 * two focus stops and one of them invalid. */
export const primaryLinkCls =
  "flex min-h-[44px] w-full items-center justify-center rounded-lg border border-transparent bg-accent px-4 text-sm font-semibold text-white shadow-glow transition-colors hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

/** The validated `?next=` destination (see lib/safeNext). */
export function useNext(): string {
  const [params] = useSearchParams();
  return safeNext(params.get("next"));
}

/** A client-side pre-check only, so an obvious typo gets a translated sentence
 * without a round trip. The server decides what a valid address is. */
export function looksLikeEmail(value: string): boolean {
  const v = value.trim();
  const at = v.indexOf("@");
  return (
    at > 0 &&
    at === v.lastIndexOf("@") &&
    v.indexOf(".", at + 2) > at + 1 &&
    !v.endsWith(".") &&
    !v.includes(" ")
  );
}

/** Characters as the server counts them: code points, not UTF-16 units. The
 * "8 characters" pre-check must not refuse a password the server accepts. */
export function charCount(value: string): number {
  return [...value].length;
}

export function AuthCard({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="animate-fade-up">
      <h1 className="text-2xl font-bold tracking-tight text-ink rtl:tracking-normal">{title}</h1>
      {sub && <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{sub}</p>}
      <div className="mt-5 rounded-xl2 border border-line bg-gradient-to-b from-panel to-panel/85 p-5 shadow-panel">
        {children}
      </div>
    </div>
  );
}

/** Label above, control below, optional hint under it. `trailing` sits at the
 * label's inline end (the "Forgot password?" link). */
export function Field({
  id,
  label,
  hint,
  trailing,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="flex items-end justify-between gap-3">
        <label htmlFor={id} className="pb-1.5 text-sm font-medium text-ink">
          {label}
        </label>
        {trailing}
      </div>
      {children}
      {hint && <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">{hint}</p>}
    </div>
  );
}

/** An address is typed left to right in either language, so the field is
 * `dir="ltr"`. In a Hebrew page the caret otherwise starts at the right, and
 * the `@` and the dots are reordered around the Latin text while it is typed.
 * No capitalising and no autocorrect: a phone that turns "rami@" into "Rami@"
 * has changed the address. */
export function EmailInput({
  id,
  value,
  onChange,
  disabled,
  autoFocus,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <input
      id={id}
      type="email"
      dir="ltr"
      inputMode="email"
      autoComplete="email"
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      autoFocus={autoFocus}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={authInputCls}
    />
  );
}

export function PasswordInput({
  id,
  value,
  onChange,
  autoComplete,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: "current-password" | "new-password";
  disabled?: boolean;
}) {
  const { t } = useTranslation("auth");
  const [shown, setShown] = useState(false);
  const label = shown ? t("fields.hidePassword") : t("fields.showPassword");
  return (
    // LTR as a whole, not only the input. The toggle sits at the box's end, and
    // inside a Hebrew page the end of an RTL box is its LEFT edge, which is
    // where this left-to-right field starts its text, under the button.
    <div dir="ltr" className="relative">
      <input
        id={id}
        type={shown ? "text" : "password"}
        dir="ltr"
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={authInputCls}
        // Inline, because a SHOWN password is a type="text" input, and the
        // global rule's padding outranks any class. Room for the 44px toggle.
        style={{ paddingRight: "2.75rem" }}
      />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={label}
        title={label}
        className="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-r-lg text-ink-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70"
      >
        {shown ? <EyeOff size={17} aria-hidden /> : <Eye size={17} aria-hidden />}
      </button>
    </div>
  );
}

/** The error slot. The live region is ALWAYS in the DOM and only its content
 * changes. A region that mounts together with its message is often not
 * announced at all, and on a form this is the one sentence that has to be
 * heard. */
export function FormError({ message }: { message: string }) {
  return (
    <div aria-live="polite">
      {message && (
        <p className="mt-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm leading-relaxed text-danger">
          {message}
        </p>
      )}
    </div>
  );
}

/** The same slot for good news ("a new code is on its way"). */
export function FormNotice({ message }: { message: string }) {
  return (
    <div aria-live="polite">
      {message && (
        <p className="mt-4 rounded-lg border border-mint/40 bg-mint/10 px-3 py-2 text-sm leading-relaxed text-mint">
          {message}
        </p>
      )}
    </div>
  );
}
