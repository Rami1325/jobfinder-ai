import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "theme";
/** Keep in sync with --bg in styles.css and the inline script in index.html. */
const THEME_COLORS: Record<Theme, string> = { dark: "#0f1420", light: "#f6f4ef" };

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function storedTheme(): Theme | null {
  try {
    const t = localStorage.getItem(STORAGE_KEY);
    return t === "light" || t === "dark" ? t : null;
  } catch {
    return null;
  }
}

function currentTheme(): Theme {
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(theme);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", THEME_COLORS[theme]);
}

/**
 * Light/dark theme state. The inline script in index.html applies the initial
 * class before first paint; this hook mirrors it, toggles it, and persists an
 * explicit choice to localStorage ("light" | "dark"). When the choice matches
 * the system preference the stored value is cleared so the app keeps
 * following the OS.
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(currentTheme);

  // Follow live system-preference changes while the user has no explicit choice.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      if (storedTheme()) return;
      const next = systemTheme();
      applyTheme(next);
      setTheme(next);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      try {
        if (next === systemTheme()) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Storage unavailable (private mode) — theme still applies for this session.
      }
      applyTheme(next);
      return next;
    });
  }, []);

  return { theme, toggle };
}
