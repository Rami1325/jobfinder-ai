import { type FormEvent, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { KeyRound } from "lucide-react";
import { ACCESS_CODE_KEY, UNAUTHORIZED_EVENT } from "../api/client";
import { Button } from "./ui";

/** Full-screen overlay shown when the API rejects a request with 401
 * (deployed instances require an access code). The code is stored per
 * device; submitting reloads so the failed page re-fetches cleanly. */
export default function AccessGate() {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(UNAUTHORIZED_EVENT, show);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, show);
  }, []);

  if (!open) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    localStorage.setItem(ACCESS_CODE_KEY, code.trim());
    window.location.reload();
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-xl2 border border-line bg-panel p-6 shadow-panel"
      >
        <div className="mb-2 flex items-center gap-2 text-lg font-semibold text-ink">
          <KeyRound size={18} className="text-accent" /> Access code
        </div>
        <p className="mb-4 text-sm text-ink-muted">
          This JobFinder instance is private. Enter the access code to continue —
          it&apos;s remembered on this device.
        </p>
        <input
          autoFocus
          type="password"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Access code"
          className="mb-4 w-full rounded-lg border border-line bg-bg-soft px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none"
        />
        <Button type="submit" className="w-full">
          Unlock
        </Button>
      </form>
    </div>,
    document.body,
  );
}
