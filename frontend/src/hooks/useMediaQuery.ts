import { useEffect, useState } from "react";

/** Whether a media query matches, kept live. For a choice between two SHAPES
 * that must not both be mounted (the tracker's board or its phone list, a
 * picker inline or as a bottom sheet), where hiding one with CSS would still
 * run its effects and register its layout ids. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatches(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return matches;
}
