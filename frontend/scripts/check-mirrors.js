// Frontend mirror checks. Run from frontend/ (wired into `npm run build`):
//   node scripts/check-mirrors.js
//
// This repo has 5,000+ backend smoke checks and, until now, ZERO frontend
// assertions — so a whole class of defect had nothing watching it. All three
// checks below are pinned to bugs that actually shipped:
//
//   1. `mergeResumes` (resumeDiff.ts) rebuilds the résumé field by field. When
//      `headline` and `skill_groups` were added to `ResumeModel`, nobody added
//      them here, so `applyEditDecisions` SILENTLY DELETED them — reject one AI
//      suggestion and your headline vanished from the download, the tracker row
//      and the cover letter. Both fields are optional in types.ts, so `tsc` was
//      quiet. This check is the only thing that can catch the next one.
//
//   2. Every `EditSection` needs a `sections.<key>` label in BOTH locales.
//      "contact" sat in ChangeLog's SECTION_ORDER with no label in either file,
//      so it would have rendered the raw key "sections.contact" to the user.
//
//   3. Locale key parity, en <-> he. Hebrew is the primary market; a key added
//      to one file and not the other ships an English string to a Hebrew user.
//
// Every check FAILS LOUDLY when it cannot find what it parses for. A mirror
// check that silently stops firing is worse than no check at all — that is the
// 21.7 lesson (a true-positive pin needs its own fixture, or it passes by never
// running).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src");
const read = (p) => fs.readFileSync(path.join(SRC, p), "utf8");

const problems = [];
const fail = (msg) => problems.push(msg);

/** Slice a brace-balanced block starting at the first `{` after `marker`. */
function blockAfter(src, marker, what) {
  const at = src.indexOf(marker);
  if (at === -1) throw new Error(`could not find ${what} (marker: ${marker})`);
  const open = src.indexOf("{", at);
  if (open === -1) throw new Error(`no opening brace for ${what}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces in ${what}`);
}

/** Strip // and /* *​/ comments so they can't be mistaken for fields. */
const decomment = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/** Top-level `key:` / `key?:` names, ignoring nested braces. */
function topLevelKeys(block) {
  const keys = [];
  let depth = 0;
  for (const raw of decomment(block).split("\n")) {
    const line = raw.trim();
    if (depth === 0) {
      const m = line.match(/^([A-Za-z_$][\w$]*)\s*\??\s*[:,]/);
      if (m) keys.push(m[1]);
    }
    depth += (line.match(/[{[(]/g) || []).length - (line.match(/[}\])]/g) || []).length;
  }
  return keys;
}

// ---- 1. mergeResumes rebuilds every ResumeModel field --------------------- //
try {
  const modelFields = topLevelKeys(
    blockAfter(read("types.ts"), "export interface ResumeModel", "ResumeModel"),
  );
  if (modelFields.length < 8) throw new Error(`parsed only ${modelFields.length} ResumeModel fields`);

  const diff = read("lib/resumeDiff.ts");
  const returned = topLevelKeys(blockAfter(diff, "    resume: {", "mergeResumes return"));
  if (returned.length < 8) throw new Error(`parsed only ${returned.length} merged fields`);

  const missing = modelFields.filter((f) => !returned.includes(f));
  if (missing.length) {
    fail(
      `resumeDiff.ts: mergeResumes drops ${missing.map((f) => `\`${f}\``).join(", ")} — ` +
        `applyEditDecisions() will silently delete ${missing.length > 1 ? "them" : "it"} from the ` +
        `résumé the user downloads. Add ${missing.length > 1 ? "them" : "it"} to the returned object.`,
    );
  }
} catch (e) {
  fail(`resumeDiff/types mirror check could not run: ${e.message}`);
}

// ---- 2. every EditSection has a label in both locales --------------------- //
let sectionKeys = [];
try {
  const diff = read("lib/resumeDiff.ts");
  const at = diff.indexOf("export type EditSection =");
  if (at === -1) throw new Error("could not find the EditSection union");
  const union = diff.slice(at, diff.indexOf(";", at));
  sectionKeys = [...union.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (!sectionKeys.length) throw new Error("EditSection union parsed as empty");

  for (const loc of ["en", "he"]) {
    const labels = JSON.parse(read(`locales/${loc}/tailor.json`)).sections || {};
    const missing = sectionKeys.filter((k) => !(k in labels));
    if (missing.length) {
      fail(
        `locales/${loc}/tailor.json: sections.{${missing.join(", ")}} missing — ` +
          `ChangeLog renders t("sections.<key>"), so the raw key hits the screen.`,
      );
    }
  }
} catch (e) {
  fail(`EditSection label check could not run: ${e.message}`);
}

// ---- 3. every EditClass has a group label in both locales ----------------- //
// Same class of bug as check 2, so the same shape of check: ChangeLog renders
// t(`groups.${cls}.title`), and a class added to the union without a label
// prints the raw key.
try {
  const src = read("lib/editGroups.ts");
  const at = src.indexOf("export type EditClass =");
  if (at === -1) throw new Error("could not find the EditClass union");
  const classes = [...src.slice(at, src.indexOf(";", at)).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (!classes.length) throw new Error("EditClass union parsed as empty");

  for (const loc of ["en", "he"]) {
    const groups = JSON.parse(read(`locales/${loc}/tailor.json`)).groups || {};
    const missing = classes.filter((c) => !groups[c]?.title);
    if (missing.length) {
      fail(
        `locales/${loc}/tailor.json: groups.{${missing.join(", ")}}.title missing — ` +
          `ChangeLog renders t("groups.<class>.title"), so the raw key hits the screen.`,
      );
    }
  }
} catch (e) {
  fail(`EditClass label check could not run: ${e.message}`);
}

// ---- 4. keyword STATUS is never computed client-side ---------------------- //
// `scorer._keyword_present` tries the VERBATIM phrase first — a bare substring
// test, no boundaries — and that is what makes Hebrew work: prefixes glue to the
// word (ב/ל/ה/ו/מ/ש), so the JD keyword "פייתון" has to match inside "בפייתון".
// `lib/keywords.ts`'s `keywordRegex` wraps the needle in token-boundary guards,
// which makes exactly that case MISS. A second matcher means the number on
// screen stops agreeing with the number the server computed, in the primary
// market — so coverage goes through POST /tools/coverage and nowhere else.
//
// Scoped to STATUS, deliberately: `countOccurrences` has legitimate callers
// (`resumeDiff.keywordsServed`, MatchReport's highlighter) that only ever count
// visible occurrences and never decide whether a keyword is covered.
try {
  const kwSrc = read("lib/keywords.ts");
  if (!kwSrc.includes("export function keywordRegex"))
    throw new Error("keywordRegex is gone — this check no longer guards what it thinks it guards");

  const libDir = path.join(SRC, "lib");
  const files = fs.readdirSync(libDir).filter((f) => f.endsWith(".ts"));
  if (!files.length) throw new Error("no .ts files found under src/lib");

  for (const f of files) {
    const src = decomment(read(`lib/${f}`));
    const verdict = /return\s+"(covered|partial|missing)"/.test(src);
    const named = /export\s+(?:function|const)\s+\w*(?:coverage|keywordStatus|keywordPresent)/i.test(src);
    if (verdict || named) {
      fail(
        `lib/${f}: keyword coverage is computed server-side by scorer.py::_keyword_present — ` +
          `call POST /tools/coverage instead. Its first tier is a bare substring match, which is ` +
          `what lets a Hebrew keyword match inside its prefixed form; keywordRegex's boundary ` +
          `guards make that case miss, so a second matcher shows a different number.`,
      );
    }
  }
} catch (e) {
  fail(`coverage-mirror check could not run: ${e.message}`);
}

// ---- 5. en <-> he key parity --------------------------------------------- //
// i18next plural suffixes are language-specific (Hebrew has a `_two` form that
// English does not), so compare on the stem.
const PLURAL = /_(zero|one|two|few|many|other)$/;
function flatKeys(obj, prefix = "", out = new Set()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatKeys(v, key, out);
    else out.add(key.replace(PLURAL, ""));
  }
  return out;
}
try {
  const dir = (loc) => path.join(SRC, "locales", loc);
  const files = fs.readdirSync(dir("en")).filter((f) => f.endsWith(".json"));
  if (!files.length) throw new Error("no locale files found under locales/en");

  for (const f of files) {
    const hePath = path.join(dir("he"), f);
    if (!fs.existsSync(hePath)) {
      fail(`locales/he/${f} missing — locales/en/${f} has no Hebrew twin.`);
      continue;
    }
    const en = flatKeys(JSON.parse(read(`locales/en/${f}`)));
    const he = flatKeys(JSON.parse(read(`locales/he/${f}`)));
    const onlyEn = [...en].filter((k) => !he.has(k));
    const onlyHe = [...he].filter((k) => !en.has(k));
    if (onlyEn.length) fail(`locales/he/${f}: ${onlyEn.length} key(s) missing — ${onlyEn.slice(0, 6).join(", ")}${onlyEn.length > 6 ? ", …" : ""}`);
    if (onlyHe.length) fail(`locales/en/${f}: ${onlyHe.length} key(s) missing — ${onlyHe.slice(0, 6).join(", ")}${onlyHe.length > 6 ? ", …" : ""}`);
  }
} catch (e) {
  fail(`locale parity check could not run: ${e.message}`);
}

// ---- report --------------------------------------------------------------- //
if (problems.length) {
  console.error("\nMirror checks FAILED:\n");
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  process.exit(1);
}
console.log(`mirrors ok — ${sectionKeys.length} edit sections, en/he parity across all namespaces`);
