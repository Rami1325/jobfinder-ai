// A one-line, plain-language "why you fit" summary for a job card, derived
// deterministically from the keyword match the scorer already computed — no
// extra LLM call. Complements the colored KeywordChips with a scannable
// sentence and makes the gap explicit ("what to close before applying").
//
// Callers pass their own namespaced `t` (jobs); that namespace carries the
// `fit.*` keys. Skill names are usually English even in the Hebrew UI, so
// a plain comma join reads fine LTR or RTL (the caller wraps it in dir="auto").

type TFn = (key: string, opts?: Record<string, unknown>) => string;

export function fitReason(
  matched: string[] | undefined,
  gaps: string[] | undefined,
  t: TFn,
): string {
  const strong = (matched ?? []).filter(Boolean).slice(0, 3);
  const gap = (gaps ?? []).filter(Boolean).slice(0, 2);
  // Gaps alone still say something: the compact job row (PLAN 31.2/5) dropped
  // the keyword chips that used to show them, so a posting that matched none
  // of its top terms would otherwise say nothing at all about why.
  if (strong.length === 0) return gap.length > 0 ? t("fit.gapOnly", { skills: gap.join(", ") }) : "";
  let s = t("fit.strongOn", { skills: strong.join(", ") });
  if (gap.length > 0) s += " · " + t("fit.gap", { skills: gap.join(", ") });
  return s;
}
