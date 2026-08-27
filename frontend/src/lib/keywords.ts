
// Mirrors the backend scorer's tokenizer (app/core/scorer.py::_WORD_RE): Latin
// word chars, digits, +#. (C++, C#, .NET) plus the Hebrew block so Hebrew
// keywords count correctly. Used as a boundary class so "Java" ≠ "JavaScript".
const WORD_CLASS = "a-z0-9+#.\\u0590-\\u05FF";

/** The same class MINUS the Hebrew block, used for the LOOKBEHIND only.
 *
 * Hebrew's inseparable prefixes (ב/ל/ה/ו/מ/ש) glue straight onto the noun, so
 * a symmetric boundary made every prefixed occurrence invisible: `countOccur-
 * rences("פייתון", "ניסיון רב בפייתון")` returned 0, and so did "לניהול" for
 * "ניהול". The backend's `_keyword_present` tries the verbatim phrase FIRST
 * and therefore reports those same words as covered — which is how a chip
 * ended up in the green Matched group reading "משרה 2 · אתם 0".
 *
 * Dropping Hebrew from the lookbehind alone is the narrow fix. The lookahead
 * keeps the whole class, so a longer Hebrew word that merely STARTS with the
 * keyword still will not match, and the Latin half of the lookbehind still
 * keeps "Script" out of "JavaScript" (while "Java" ≠ "JavaScript" was always
 * the lookahead's job, not the lookbehind's).
 *
 * This is a matcher for HIGHLIGHTING and for mention counts in the posting.
 * Coverage STATUS is still computed server-side only — see CLAUDE.md and
 * check-mirrors check 4. */
const LEAD_CLASS = "a-z0-9+#.";

/** Case-insensitive whole-phrase matcher with token boundaries. */
export function keywordRegex(keyword: string): RegExp | null {
  const kw = keyword.trim();
  if (!kw) return null;
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![${LEAD_CLASS}])${escaped}(?![${WORD_CLASS}])`, "gi");
}

/** Verbatim (whole-phrase) occurrence count of a keyword in free text. */
export function countOccurrences(keyword: string, text: string): number {
  const re = keywordRegex(keyword);
  if (!re || !text) return 0;
  return (text.match(re) ?? []).length;
}

