import { useCallback, useEffect, useRef, useState } from "react";

export type LandingMode = "dark" | "light";

const KEY = "theme";
/** Must match `.jobfinder-landing` / `.jobfinder-landing.is-light` in styles.css. */
const META: Record<LandingMode, string> = { dark: "#05090D", light: "#F7F8FA" };
/** The app's own colours, restored when the landing unmounts. */
const APP_META: Record<LandingMode, string> = { dark: "#0f1420", light: "#f6f4ef" };

function stored(): LandingMode | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

function setMeta(color: string) {
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
}

function applyRootClass(mode: LandingMode) {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(mode);
}

/**
 * The landing's theme, which is NOT quite the app's theme.
 *
 * The rule the brief asks for is "dark is the landing's art direction unless
 * the visitor has explicitly chosen otherwise", and the important half is what
 * that must not do: it must not silently write a preference. `useTheme` (the
 * app's hook) resolves an ABSENT preference from the operating system, so a
 * visitor on a light desktop would land on the pale composition without ever
 * having asked for it. Here an absent preference resolves to `dark` instead.
 *
 * While no preference is stored the hook also mirrors that choice onto <html>
 * for the LIFETIME OF THE LANDING ONLY, so the document scrollbar and the
 * browser's theme-color agree with the page — and reverts it on unmount, so
 * `/app` goes straight back to following the operating system. Nothing is
 * written to storage by that path; the revert is what keeps it honest.
 *
 * Toggling is different: a tap IS an explicit choice, so it is persisted under
 * the same `theme` key the app reads, and every route follows it from then on.
 * Note the one deliberate difference from `useTheme.toggle`, which CLEARS the
 * key when the new value happens to match the system: doing that here would
 * put the visitor straight back on the landing's dark default the moment they
 * chose light on a light machine, i.e. the control would appear to do nothing.
 */
export function useLandingTheme() {
  const [mode, setModeState] = useState<LandingMode>(() => stored() ?? "dark");
  const owned = useRef(false);

  useEffect(() => {
    if (stored()) return; // an explicit choice already drives <html>
    owned.current = true;
    applyRootClass("dark");
    setMeta(META.dark);
    return () => {
      if (!owned.current) return; // a toggle took over; leave its value alone
      owned.current = false;
      const sys: LandingMode = window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
      applyRootClass(sys);
      setMeta(APP_META[sys]);
    };
  }, []);

  const toggle = useCallback(() => {
    setModeState((prev) => {
      const next: LandingMode = prev === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(KEY, next);
      } catch {
        // Storage unavailable (private mode) — the choice still applies now.
      }
      owned.current = false;
      applyRootClass(next);
      setMeta(META[next]);
      return next;
    });
  }, []);

  // Keep the browser chrome in step with the rendered scope, including the
  // first paint after an explicitly stored preference.
  useEffect(() => {
    setMeta(META[mode]);
  }, [mode]);

  return { mode, toggle };
}
