// Frontend mirror checks. Run from frontend/ (wired into `npm run build`):
//   node scripts/check-mirrors.js
//
// This repo has 5,000+ backend smoke checks and, until now, ZERO frontend
// assertions — so a whole class of defect had nothing watching it. Every check
// below is pinned to a bug that actually shipped:
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
import { createRequire } from "node:module";
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

/**
 * Top-level keys of the `setTailorState({...})` reset inside a named
 * `state/tailorStore.ts` function.
 *
 * ONE definition, shared by checks 12 and 13, for check 6's reason: all three
 * functions it is pointed at (`applyBlockEdit`, `adoptMaster`, `startTailor`)
 * answer the same question — "the document or the review just changed, so what
 * on screen now describes something that no longer exists?" — and two copies of
 * the parser could disagree about the same source while both stayed green.
 * `read` is called lazily so a missing file lands in a check's own try/catch as
 * a loud `fail`, not as an unhandled throw at import time.
 */
const resetKeys = (fn, what) =>
  topLevelKeys(
    blockAfter(
      blockAfter(read("state/tailorStore.ts"), `export function ${fn}`, what),
      "setTailorState(",
      `${fn} reset`,
    ),
  );

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

// ---- 5. the block-edit vocabulary has labels in both locales -------------- //
// The sheet renders t(`edit.blocks.<kind>`) and t(`edit.fields.<key>`). A kind
// or field added to `lib/resumeBlocks.ts` without a label prints the raw key on
// screen — to a Hebrew user, in the primary market — and nothing goes red.
try {
  const blocks = read("lib/resumeBlocks.ts");
  const at = blocks.indexOf("export type BlockKind =");
  if (at === -1) throw new Error("could not find the BlockKind union");
  const kinds = [...blocks.slice(at, blocks.indexOf(";", at)).matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  const fa = blocks.indexOf("export const BLOCK_FIELD_KEYS = [");
  if (fa === -1) throw new Error("could not find BLOCK_FIELD_KEYS");
  const fields = [...blocks.slice(fa, blocks.indexOf("]", fa)).matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  if (kinds.length < 10 || fields.length < 20)
    throw new Error(`parsed only ${kinds.length} kinds / ${fields.length} field keys`);

  for (const loc of ["en", "he"]) {
    const edit = JSON.parse(read(`locales/${loc}/tailor.json`)).edit || {};
    const missingKinds = kinds.filter((k) => !edit.blocks?.[k]);
    const missingFields = fields.filter((k) => !edit.fields?.[k]);
    if (missingKinds.length)
      fail(`locales/${loc}/tailor.json: edit.blocks.{${missingKinds.join(", ")}} missing — the sheet title would render a raw key.`);
    if (missingFields.length)
      fail(`locales/${loc}/tailor.json: edit.fields.{${missingFields.join(", ")}} missing — that field would render a raw key as its label.`);
  }
} catch (e) {
  fail(`block-edit label check could not run: ${e.message}`);
}

// ---- 6. `dkey` has exactly one definition -------------------------------- //
// The view mints block paths and the writer resolves them. Two copies of the
// key function that drift means the view emits a path the writer cannot find,
// and the symptom is a sheet that opens empty on exactly one skill.
try {
  if (!read("lib/resumeBlocks.ts").includes("export const dkey"))
    throw new Error("lib/resumeBlocks.ts no longer exports dkey");
  const view = read("components/ResumeView.tsx");
  if (!/from "\.\.\/lib\/resumeBlocks"/.test(view))
    fail("components/ResumeView.tsx must import dkey from lib/resumeBlocks — it mints the paths the writer resolves.");
  if (/const\s+dkey\s*=/.test(decomment(view)))
    fail("components/ResumeView.tsx declares its own dkey — there must be exactly one, in lib/resumeBlocks.ts, or the view and the writer drift.");
} catch (e) {
  fail(`dkey single-definition check could not run: ${e.message}`);
}

// ---- 7. the view's path grammar is a subset of BLOCK_PATTERNS ------------- //
// A new section that ships a tappable, focusable block whose sheet is EMPTY is
// invisible to tsc, because paths are strings.
try {
  const blocks = read("lib/resumeBlocks.ts");
  const pa = blocks.indexOf("export const BLOCK_PATTERNS = [");
  if (pa === -1) throw new Error("could not find BLOCK_PATTERNS");
  const known = new Set(
    [...blocks.slice(pa, blocks.indexOf("]", pa)).matchAll(/"([^"]+)"/g)].map((m) => m[1]),
  );
  if (known.size < 10) throw new Error(`BLOCK_PATTERNS parsed as ${known.size} entries`);

  const view = decomment(read("components/ResumeView.tsx"));
  const emitted = [...view.matchAll(/blkProps\(\s*(`[^`]*`|"[^"]*")/g)].map((m) =>
    m[1].slice(1, -1).replace(/\$\{[^}]*\}/g, "*"),
  );
  if (emitted.length < 14)
    throw new Error(`found only ${emitted.length} blkProps call sites — the extraction has stopped matching`);

  const unknown = [...new Set(emitted)].filter((p) => !known.has(p));
  if (unknown.length)
    fail(
      `components/ResumeView.tsx emits block path(s) ${unknown.map((p) => `\`${p}\``).join(", ")} ` +
        `that lib/resumeBlocks.ts cannot read or write. Add them to BLOCK_PATTERNS and to ` +
        `readBlock/writeBlock, or the block is tappable and its editor opens empty.`,
    );
} catch (e) {
  fail(`block-path grammar check could not run: ${e.message}`);
}

// ---- 8. en <-> he key parity --------------------------------------------- //
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

/**
 * Does a dotted `key` resolve in a parsed locale bundle?
 *
 * A COUNTED label exists ONLY under its plural suffixes, so a plain path lookup
 * would report a correctly-translated key as missing. Restricted to the real
 * i18next suffixes so `nav.more` cannot be satisfied by an unrelated
 * `nav.more_menu`.
 *
 * ONE definition, shared by checks 9 and 16: two scrapes of two different files
 * against two different namespaces, but the same question about the same
 * lookup rules — and two copies of this would be free to disagree about the
 * same bundle while both stayed green.
 */
function resolvesIn(bundle, key) {
  const parts = key.split(".");
  const leaf = parts.pop();
  const parent = parts.reduce((o, k) => (o == null ? o : o[k]), bundle);
  if (parent == null || typeof parent !== "object") return false;
  return (
    parent[leaf] !== undefined ||
    Object.keys(parent).some((k) => k.startsWith(`${leaf}_`) && PLURAL.test(k))
  );
}
try {
  const dir = (loc) => path.join(SRC, "locales", loc);
  // Union of BOTH directories, not readdir("en") alone: driving the loop off
  // one side means a namespace deleted from THAT side is never looked at, so
  // its orphaned twin keeps shipping as a chunk nothing reads. (22.9 deleted
  // home.json; deleting only the en half would have been silently green.)
  const json = (loc) => fs.readdirSync(dir(loc)).filter((f) => f.endsWith(".json"));
  const files = [...new Set([...json("en"), ...json("he")])].sort();
  if (!files.length) throw new Error("no locale files found under locales/en or locales/he");

  for (const f of files) {
    const hePath = path.join(dir("he"), f);
    if (!fs.existsSync(path.join(dir("en"), f))) {
      fail(`locales/en/${f} missing — locales/he/${f} has no English twin.`);
      continue;
    }
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

// ---- 9. nav destinations resolve, nav labels exist ------------------------ //
// 22.9 rewired every nav destination and renamed two locale keys, and `tsc` can
// see NEITHER: a route path is a string and a labelKey is a string. The two
// failure shapes this pins:
//   (a) a nav `to:` no <Route path> declares. NavLink's isActive is simply never
//       true, so the tab sits permanently unlit, and the tap falls through
//       App.tsx's catch-all to the MARKETING landing — which reads to the user
//       as having been logged out. Green build, no runtime error.
//   (b) a labelKey with no key in common.json. The tab renders the literal
//       "nav.resume" at 12px, in Hebrew. Check 8 stays green because en and he
//       are still in parity WITH EACH OTHER, and checks 2/3/5 only read
//       tailor.json.
// Scoped to AppLayout.tsx. The original reason was that BuilderPage called
// t("nav.back") against the BUILDER namespace, so a repo-wide scrape would
// false-positive on legitimate input — and a check that fires on correct code
// is worse than no check. 23.4 DELETED BuilderPage, so that exception is gone
// and `t("nav.*")` outside this file now returns nothing at all.
// Left scoped anyway, deliberately: widening it would be a behaviour change
// with no defect behind it, and every check in this file is pinned to a bug
// that actually shipped. If a second file ever grows a nav block, widen it
// then — and re-read this note first.
try {
  const app = read("App.tsx");
  const routes = [...app.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]);
  if (routes.length < 15) throw new Error(`parsed only ${routes.length} <Route path=> entries in App.tsx`);
  if (!routes.includes("*")) throw new Error("App.tsx has no catch-all — this check's premise is gone");
  const declared = routes
    .filter((r) => r !== "*")
    .map((r) => new RegExp(`^${r.replace(/:[^/]+/g, "[^/]+")}$`));

  const layout = read("layouts/AppLayout.tsx");
  // Both spellings: `to: "/x"` in the nav tables, `to="/x"` on the logo Links
  // and the Tools NavItem. A dead logo link is the same bug as a dead tab.
  const fromTables = [...layout.matchAll(/\bto:\s*"(\/[^"]*)"/g)].map((m) => m[1]);
  const fromJsx = [...layout.matchAll(/\bto="(\/[^"]*)"/g)].map((m) => m[1]);
  if (!fromTables.length) throw new Error('parsed no `to: "/…"` nav-table destinations in AppLayout.tsx');
  if (!fromJsx.length) throw new Error('parsed no `to="/…"` link destinations in AppLayout.tsx');
  const dests = [...fromTables, ...fromJsx];
  for (const d of new Set(dests)) {
    if (!declared.some((re) => re.test(d)))
      fail(`AppLayout navigates to "${d}", which App.tsx does not route — it falls through the catch-all to the marketing landing and reads as being logged out.`);
  }

  // Guard the two scrapes SEPARATELY. A floor on the sum is not a fail-loud
  // guard: `labelKey` could stop matching entirely and the t("nav.*") hits
  // alone would still clear it. What must be caught is either regex going to
  // zero — a renamed property, or a different call shape — not the count
  // drifting when a nav entry is legitimately added or removed.
  const fromTable = [...layout.matchAll(/\blabelKey:\s*"([^"]+)"/g)].map((m) => m[1]);
  // `[,)]`, not just `)`. The original required a closing paren immediately
  // after the string, so ANY nav label with interpolation -- t("nav.x", {...}) --
  // was invisible to this check. `nav.kitsAwaiting` was added with a count and
  // sailed straight past a green build with no key in either locale.
  const fromCalls = [...layout.matchAll(/\bt\("(nav\.[^"]+)"\s*[,)]/g)].map((m) => m[1]);
  if (!fromTable.length) throw new Error("parsed no `labelKey:` entries in AppLayout.tsx");
  if (!fromCalls.length) throw new Error('parsed no t("nav.*") calls in AppLayout.tsx');
  const labels = [...fromTable, ...fromCalls];
  for (const loc of ["en", "he"]) {
    const common = JSON.parse(read(`locales/${loc}/common.json`));
    for (const key of new Set(labels)) {
      // `resolvesIn` handles the counted-label case: a plural key exists only
      // under its suffixes, so a plain path lookup calls a translated string
      // missing.
      if (!resolvesIn(common, key))
        fail(`locales/${loc}/common.json is missing "${key}" — the nav would render the raw key.`);
    }
  }
} catch (e) {
  fail(`nav destination/label check could not run: ${e.message}`);
}

// ---- 10. the keyword matcher finds Hebrew behind a prefix ----------------- //
// `countOccurrences("פייתון", "ניסיון רב בפייתון")` returned 0 while the
// backend's `_keyword_present` reports the same text as covered — so a chip
// rendered inside the green "Matched" group carrying "משרה 2 · אתם 0". Hebrew's
// inseparable prefixes (ב/ל/ה/ו/מ/ש) glue straight onto the noun, and the
// boundary lookbehind was counting them as word characters.
//
// Check 4 could never have caught this: it forbids computing a STATUS in
// TypeScript and says nothing about a count.
//
// The false-positive half is pinned in the SAME table on purpose. "Make the
// Hebrew case pass" is trivially satisfied by deleting the guards altogether,
// which would silently start reporting "Java" inside "JavaScript" — a guard
// that fires on legitimate input is worse than no guard.
//
// The classes and the boundary shape are parsed out of the shipped source
// rather than restated here, so this cannot drift into testing its own copy.
try {
  const kwSrc = read("lib/keywords.ts");
  const lead = kwSrc.match(/const LEAD_CLASS = "([^"]+)"/);
  const word = kwSrc.match(/const WORD_CLASS = "([^"]+)"/);
  const tpl = kwSrc.match(
    /new RegExp\(\s*`\(\?<!\[\$\{(\w+)\}\]\)\$\{escaped\}\(\?!\[\$\{(\w+)\}\]\)`/,
  );
  if (!lead || !word) throw new Error("could not parse LEAD_CLASS / WORD_CLASS out of lib/keywords.ts");
  if (!tpl) throw new Error("could not parse the keywordRegex boundary template — its shape changed");
  // The captures are FILE text, so `\\u0590` is two characters; JSON.parse
  // turns them back into the one-backslash string the module builds at runtime.
  const classes = { LEAD_CLASS: JSON.parse(`"${lead[1]}"`), WORD_CLASS: JSON.parse(`"${word[1]}"`) };
  const behind = classes[tpl[1]];
  const ahead = classes[tpl[2]];
  if (!behind || !ahead) throw new Error(`keywordRegex uses unknown classes ${tpl[1]} / ${tpl[2]}`);
  const count = (k, text) => {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (text.match(new RegExp(`(?<![${behind}])${esc}(?![${ahead}])`, "gi")) ?? []).length;
  };
  const CASES = [
    // must match — a Hebrew prefix is a prefix, not part of the word
    ["פייתון", "עבודה עם פייתון", 1],
    ["פייתון", "ניסיון רב בפייתון ובסיסי נתונים", 1],
    ["ניהול", "אחראי לניהול צוות", 1],
    ["React", "Built with React and Node", 1],
    // must NOT match — the guards that make the matcher worth having
    ["Java", "Strong JavaScript background", 0],
    ["Script", "Strong JavaScript background", 0],
    ["ניהו", "אחראי לניהול צוות", 0],
  ];
  for (const [k, text, want] of CASES) {
    const got = count(k, text);
    if (got !== want) {
      fail(
        `lib/keywords.ts: "${k}" in "${text}" counted ${got}, expected ${want}. ` +
          (want === 1
            ? "A keyword the backend reports as covered would show a résumé/JD count of zero beside it."
            : "The boundary guard stopped firing — this matcher would report a substring as a match."),
      );
    }
  }
} catch (e) {
  fail(`keyword matcher check could not run: ${e.message}`);
}

// ---- 11. no reveal animates its own height -------------------------------- //
// CLAUDE.md forbids animating `height: "auto"` on a click-to-open element, and
// the reason is measured, not stylistic: framer-motion tweens height from 0 to
// the measured value, and on a page that re-renders mid-tween (Jobs subscribes
// to two external stores) the element is left frozen at the interpolated px
// value with `overflow-hidden` clipping its content.
//
// This shipped SEVEN times. Disclosure documented the defect and was fixed;
// the pattern then came back in JobsPage (the Replace panel froze at 80px over
// a 287px dropzone, so the master résumé could not be changed at all, and the
// Customize panel froze at 78px over 280px of fields, so the search settings
// read as deleted), AlertsCard x2, TailorPage, MatchReport and marketing/FAQ.
// tsc cannot see it — it is a string inside a prop object.
//
// Deliberately scoped to an `animate`/`exit`/`initial` prop: a CSS `height:
// auto` in a className or a style object is ordinary layout and must not fire.
try {
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".tsx")) files.push(full);
    }
  })(SRC);
  if (files.length < 20) throw new Error(`only found ${files.length} .tsx files under src`);

  // `animate={{ ... height: "auto" ... }}` — the motion prop, not a stylesheet.
  const MOTION_HEIGHT = /\b(?:animate|initial|exit)\s*=\s*\{\{[^}]*\bheight\s*:\s*["']auto["']/;
  let scanned = 0;
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    scanned++;
    if (MOTION_HEIGHT.test(src)) offenders.push(path.relative(SRC, f).split(path.sep).join("/"));
  }
  if (scanned === 0) throw new Error("scanned no files");
  for (const o of offenders) {
    fail(
      `${o}: animates height:"auto" in a motion prop. This wedges — the element ` +
        `freezes at an interpolated height with its content clipped, so the panel ` +
        `never opens. Render conditionally and use the house \`animate-fade-up\` ` +
        `(opacity + transform), the way ui/Disclosure.tsx does.`,
    );
  }

  // Both directions: the detector must actually fire on the shape it forbids,
  // or this check passes for ever by never matching anything.
  const PROBE_BAD = `<motion.div animate={{ opacity: 1, height: "auto" }} />`;
  const PROBE_OK = `<div className="h-auto" style={{ height: "auto" }} />`;
  if (!MOTION_HEIGHT.test(PROBE_BAD)) fail("check 11 cannot detect its own defect shape");
  if (MOTION_HEIGHT.test(PROBE_OK)) fail("check 11 fires on a plain CSS height:auto");
} catch (e) {
  fail(`height-animation check could not run: ${e.message}`);
}

// ---- 12. a replaced master résumé reaches the document -------------------- //
// The master résumé is cached in TWO module-level bindings: `useMasterResume`'s
// `cache` and `tailorStore`'s `resume`. Only the first had a way in from
// outside, and `TailorPage`'s loader early-returns the moment the second is
// set — so uploading a new CV on the Jobs page (Replace), restoring a version
// or saving from the skills editor left /app painting, TAILORING and
// downloading the file that had just been replaced, until a full page reload.
// The user's report was exactly that: "I add a new resume, the Resume page
// still shows the old one, and Tailor uses the old one." Reproduced in the
// browser with a no-reload sentinel before it was fixed.
//
// `tsc` cannot see any of it — both caches are correctly typed and correctly
// written; the defect is that one of them is never written at all.
//
// The third assertion is the one that will still be true in a year: the reset
// list is DERIVED from `applyBlockEdit`, not restated here. Both functions
// answer the same question ("the document changed — what on screen is now
// describing a résumé that no longer exists?"), so a field added to one and
// forgotten in the other is the next `mergeResumes` bug in a new costume.
try {
  const store = read("state/tailorStore.ts");
  const hook = read("hooks/useMasterResume.ts");

  if (!/export function adoptMaster\s*\(/.test(store)) {
    fail(
      "state/tailorStore.ts: no exported `adoptMaster` — the document surface has " +
        "no way to be told the stored master résumé was replaced.",
    );
  }

  // The call belongs INSIDE setMaster, not at its call sites: every caller of
  // setMaster is by definition a replacement of the stored master.
  const setMasterBody = blockAfter(hook, "const setMaster = useCallback", "setMaster body");
  if (!/\bsetMasters\s*\(/.test(setMasterBody)) {
    throw new Error("parsed something that is not setMaster (no setMasters call in it)");
  }
  if (!/\badoptMaster\s*\(/.test(setMasterBody)) {
    fail(
      "hooks/useMasterResume.ts: setMaster does not call adoptMaster. A résumé " +
        "replaced anywhere but /app (upload / version restore / skills editor) will " +
        "not reach the document — it keeps painting, tailoring and downloading the " +
        "old file until a full page reload.",
    );
  }

  const edited = resetKeys("applyBlockEdit", "applyBlockEdit");
  const adopted = resetKeys("adoptMaster", "adoptMaster");
  if (edited.length < 6) throw new Error(`parsed only ${edited.length} applyBlockEdit reset fields`);
  if (adopted.length < 12) throw new Error(`parsed only ${adopted.length} adoptMaster reset fields`);

  const missed = edited.filter((k) => !adopted.includes(k));
  if (missed.length) {
    fail(
      `state/tailorStore.ts: adoptMaster leaves ${missed.map((k) => `\`${k}\``).join(", ")} ` +
        "set from the résumé it just replaced, while applyBlockEdit clears " +
        `${missed.length > 1 ? "them" : "it"} for the same reason. A fit score, a tailor ` +
        "diff or a fabrication warning would stay on screen describing a document that " +
        "no longer exists.",
    );
  }

  // Both directions: the subset comparison must actually catch an omission, or
  // this passes for ever by comparing two lists it failed to parse.
  if (["result", "fit"].filter((k) => !["result"].includes(k)).length !== 1) {
    fail("check 12 cannot detect a missing reset field");
  }
  if (["result"].filter((k) => !["result", "fit"].includes(k)).length !== 0) {
    fail("check 12 reports a missing reset field when none is missing");
  }
} catch (e) {
  fail(`master-résumé adoption check could not run: ${e.message}`);
}

// ---- 13. a re-tailor clears everything describing the PREVIOUS run -------- //
// `startTailor` runs on the MASTER every time — it never reads
// `result.tailored_resume` — so pressing Tailor again is a fresh run, not a
// compounding one. What it did NOT do was clear the state describing the run it
// replaces. Five keys survived: `savedAppId`, `applyClicked`, `applied`, `fit`
// and `checkedFor`.
//
// The sharpest of them shipped: with `savedAppId` still set, `save()` takes its
// `savedAppId !== null` short-circuit and toasts "Already in your tracker"
// while writing NOTHING — so the tracker row keeps the PREVIOUS tailored
// résumé, for the PREVIOUS job, and the green toast says it worked.
//
// DERIVED from `adoptMaster`, never restated. Both functions answer the same
// question — "what on screen now describes something that no longer exists?" —
// and the only difference is that a résumé swap also replaces the master while
// a tailor replaces only the review. So the expected list is adoptMaster's
// minus the six master-identity keys, and a field added to adoptMaster forces a
// decision here instead of quietly going stale. Same shape as check 12; `tsc`
// sees none of it, because every key is correctly typed and correctly optional.
try {
  // The six keys that identify the MASTER RÉSUMÉ. `adoptMaster` clears them
  // because the file itself was replaced; `startTailor` must NOT, because
  // tailoring never writes the master (Phase 22: master ⇒ edit, tailored ⇒
  // review). Everything else adoptMaster clears is a statement about a finished
  // run, and startTailor owes it exactly the same treatment.
  const MASTER_ONLY = ["resume", "savedResume", "ledger", "masterLabel", "editUndo", "editError"];
  const adopted = resetKeys("adoptMaster", "adoptMaster");
  const started = resetKeys("startTailor", "startTailor");
  if (adopted.length < 12) throw new Error(`parsed only ${adopted.length} adoptMaster reset fields`);
  if (started.length < 10) throw new Error(`parsed only ${started.length} startTailor reset fields`);

  const stale = adopted.filter((k) => !MASTER_ONLY.includes(k) && !started.includes(k));
  if (stale.length) {
    fail(
      `state/tailorStore.ts: startTailor leaves ${stale.map((k) => `\`${k}\``).join(", ")} ` +
        "describing the PREVIOUS tailor run, while adoptMaster clears " +
        `${stale.length > 1 ? "them" : "it"} for the same reason. This is the shipped ` +
        'defect: with `savedAppId` still set, save() short-circuits and toasts "Already ' +
        'in your tracker" while writing NOTHING — the tracker row keeps the previous ' +
        "tailored résumé, for the previous job.",
    );
  }

  // The five that actually shipped stale, pinned by name as well as by
  // derivation. Deliberately redundant with the subset above: that one goes
  // green the moment a key leaves BOTH functions, and these five are the ones
  // whose removal has to be a decision somebody makes on purpose.
  const SHIPPED_STALE = ["savedAppId", "applyClicked", "applied", "fit", "checkedFor"];
  const regressed = SHIPPED_STALE.filter((k) => !started.includes(k));
  if (regressed.length) {
    fail(
      `state/tailorStore.ts: startTailor no longer resets ${regressed.map((k) => `\`${k}\``).join(", ")}. ` +
        'These five are the shipped defect — a re-tailor that toasts "Already in your ' +
        "tracker\" and writes nothing, and a fit reading and 'applied' badge belonging to " +
        "the job the user just stopped aiming at.",
    );
  }

  // Both directions, in this file's own literal-array style: the subset
  // comparison must catch an omission and must NOT report one when there is
  // none, or it passes for ever by comparing two lists it failed to parse.
  if (["savedAppId", "fit"].filter((k) => !["savedAppId"].includes(k)).length !== 1) {
    fail("check 13 cannot detect a reset field startTailor forgot");
  }
  if (["savedAppId"].filter((k) => !["savedAppId", "fit"].includes(k)).length !== 0) {
    fail("check 13 reports a forgotten reset field when none is missing");
  }
} catch (e) {
  fail(`re-tailor reset check could not run: ${e.message}`);
}

// ---- 14. the analysed-JD reuse is captured BEFORE the reset --------------- //
// Check 13 forces `checkedFor: null` into `startTailor`'s reset, and that
// creates an ordering trap directly underneath it. The reuse lookup — "have we
// already paid to read this exact posting?" — used to live inside the async
// IIFE, i.e. AFTER the reset, reading `state.checkedFor` from the module
// binding. Leave it there and it reads the value this very call just nulled,
// always misses, and re-spends a credit on `analyzeJD` — while the overlay's
// own cost line promises "tailoring afterwards doesn't charge again".
//
// Nothing else can see this. Both orderings compile, both type-check, and the
// symptom is a silent extra model call, not an error.
try {
  const body = blockAfter(
    read("state/tailorStore.ts"),
    "export function startTailor",
    "startTailor body",
  );
  // ONE index comparison, used for the real assertion AND for both probes, so
  // the probes cannot certify a matcher the assertion does not use.
  const order = (src) => {
    const capture = src.indexOf("const sameJd");
    const reset = src.indexOf("setTailorState(");
    return { capture, reset, ok: capture !== -1 && reset !== -1 && capture < reset };
  };
  const got = order(body);
  if (got.capture === -1)
    throw new Error("no `const sameJd` in startTailor — the capture this check guards is gone");
  if (got.reset === -1)
    throw new Error("no `setTailorState(` in startTailor — its reset is gone");
  if (!got.ok) {
    fail(
      "state/tailorStore.ts: startTailor reads the analysed-JD reuse AFTER its own " +
        "reset. The reset nulls `checkedFor`, so the lookup reads the value this call " +
        "just cleared, never reuses the posting it already paid to read, and spends a " +
        "second credit on analyzeJD — contradicting the overlay's cost line.",
    );
  }
  if (order("setTailorState({ checkedFor: null });\nconst sameJd = state.checkedFor === x;").ok) {
    fail("check 14 cannot detect the reversed order — its index comparison is broken");
  }
  if (!order("const sameJd = state.checkedFor === x;\nsetTailorState({ checkedFor: null });").ok) {
    fail("check 14 fires on the correct order");
  }
} catch (e) {
  fail(`analysed-JD reuse ordering check could not run: ${e.message}`);
}

// ---- 15. the overlay never shows a fit reading over a tailored document --- //
// The overlay reseeds its draft from `jdText` on open, so after a tailor
// `cached` was TRUE and the panel painted `fit.fit_score` — a reading taken
// against the MASTER (TailorPage passes `resume={resume}`). Directly below it
// on the page, `ScoreCard` was painting `result.score_after.fit_score` for the
// TAILORED document. Two unlabelled "Recruiter fit" rings, different numbers,
// different documents — the exact thing "two numbers on two clocks, never a
// blended one" exists to prevent, and a comparison the invariant refuses to
// dress up as improvement (two samples at temperature 0.3 are not a
// measurement).
//
// `tsc` is quiet: both readings are correctly typed `FitCheckResult` numbers.
try {
  const overlay = read("components/TailorOverlay.tsx");
  const sliced = decomment(overlay).match(/\bconst cached\s*=([^;]*);/);
  if (!sliced)
    throw new Error("could not slice the `const cached =` binding out of TailorOverlay.tsx");
  // POLARITY, not presence. `/\bhasResult\b/` pinned only that the identifier
  // APPEARS, and `const cached = hasResult && …` — one deleted character —
  // sailed past it while producing the exact two-unlabelled-rings state this
  // check's own message describes, inverted: cached is true only once a result
  // is up, which is precisely when the reading belongs to the other document.
  // The guard has to be a NEGATION of the flag, so that is what is matched.
  const GUARDED = /(^|[^A-Za-z0-9_$])!\s*hasResult\b/;
  if (!GUARDED.test(sliced[1])) {
    fail(
      "components/TailorOverlay.tsx: `cached` is not guarded on `!hasResult`, so the " +
        "overlay can paint a fit reading taken against the MASTER while ScoreCard " +
        "below paints the TAILORED document's — two unlabelled recruiter-fit rings, " +
        "different numbers, different documents.",
    );
  }
  // The same defect one file over, and a presence test cannot see it either:
  // `hasResult={false}` passes `includes("hasResult={")` while hard-wiring the
  // overlay into believing a result is never up — which re-opens the two-rings
  // state from the other end. The prop has to be DERIVED from `result`, the one
  // binding that actually knows.
  const DERIVED = /\bresult\b/;
  const page = decomment(read("pages/TailorPage.tsx"));
  const passed = /\bhasResult=\{([^}]*)\}/.exec(page);
  if (!passed) {
    fail(
      "pages/TailorPage.tsx: <TailorOverlay> is not passed `hasResult`, so the overlay " +
        "cannot tell that a tailor result is on screen and re-aims at the posting it " +
        "already tailored for.",
    );
  } else if (!DERIVED.test(passed[1])) {
    fail(
      `pages/TailorPage.tsx: hasResult={${passed[1].trim()}} is not derived from \`result\`. ` +
        "A constant satisfies the prop and tells the overlay a lie: it goes on painting the " +
        "master's fit reading over a tailored document, beside ScoreCard's reading of the " +
        "tailored one.",
    );
  }

  // Both directions on a fixture — INCLUDING the inverted one, so the detector
  // cannot silently stop matching its own defect shape and cannot quietly go
  // back to accepting the polarity it exists to forbid.
  const PROBE_UNGUARDED = " !!fit && checkedFor !== null && checkedFor === draft.trim()";
  const PROBE_INVERTED = " hasResult && !!fit && checkedFor === draft.trim()";
  const PROBE_GUARDED = " !hasResult && !!fit && checkedFor === draft.trim()";
  if (GUARDED.test(PROBE_UNGUARDED)) fail("check 15 accepts an unguarded `cached` expression");
  if (GUARDED.test(PROBE_INVERTED))
    fail("check 15 accepts an INVERTED `cached` guard — it is pinning the identifier, not the polarity");
  if (!GUARDED.test(PROBE_GUARDED)) fail("check 15 cannot recognise the guard it requires");
  if (DERIVED.test("false")) fail("check 15 accepts a hard-wired `hasResult={false}`");
  if (!DERIVED.test("!!result")) fail("check 15 cannot recognise the derived `hasResult` it requires");
} catch (e) {
  fail(`overlay fit-reading check could not run: ${e.message}`);
}

// ---- 16. the tailor overlay's own locale keys resolve in both locales ----- //
// Nothing covered these. Check 8 is parity-only, so a key missing from en AND
// he alike is green; check 9 is deliberately scoped to AppLayout.tsx. So a
// typo'd `overlay.openDifferent` renders the raw key at 12px, in Hebrew, on the
// primary control of the primary page, with a green build behind it — the same
// failure shape check 9 was written for, one file over.
//
// PER-FILE FLOORS, not one on the sum — check 22's shape, for the reason check
// 22 records and this check then repeated. `TailorOverlay.tsx` alone supplies
// 15 of the 19 keys, so `TailorPage.tsx`'s six calls could go COMPLETELY dark
// and a floor of 10 on the total still cleared. Proven: with TailorPage's calls
// renamed to `tx(`, deleting `discard.cta` AND `discard.title` from BOTH
// locales left the build green — and `discard.title` is the heading of the
// confirm dialog standing between the user and throwing a finished review away.
// That is check 9's lesson (guard each scrape separately) arriving a third time.
try {
  // Floors set just under what each file carries today (6 and 15), so a
  // legitimately added or removed string does not trip them but a call shape
  // going dark does.
  const files = [
    ["pages/TailorPage.tsx", 4],
    ["components/TailorOverlay.tsx", 12],
  ];
  // `[,)]`, not just `)`, for check 9's reason: t("overlay.openFor", { title })
  // takes an interpolation object, and a `)`-only matcher is blind to exactly
  // the calls most likely to be renamed.
  const CALL = /\bt\("((?:overlay|discard)\.[^"]+)"\s*[,)]/g;
  const keys = new Set();
  for (const [f, floor] of files) {
    const here = [...decomment(read(f)).matchAll(CALL)].map((m) => m[1]);
    if (here.length < floor)
      throw new Error(
        `scraped only ${here.length} literal t("overlay.*")/t("discard.*") keys from ${f} (expected at least ${floor}) — the call shape changed`,
      );
    for (const k of here) keys.add(k);
  }

  for (const loc of ["en", "he"]) {
    const ns = JSON.parse(read(`locales/${loc}/tailor.json`));
    for (const key of keys) {
      if (!resolvesIn(ns, key))
        fail(
          `locales/${loc}/tailor.json is missing "${key}" — the tailor overlay renders ` +
            "the raw key. Check 8 stays green while both locales are equally wrong.",
        );
    }
  }
} catch (e) {
  fail(`tailor overlay label check could not run: ${e.message}`);
}

// ---- 17. an override survives a decision toggle (EXECUTED, not parsed) ---- //
// The one check in this file that RUNS the shipped code, because the property
// it pins cannot be seen by reading either module.
//
// `mergeForReview` rebuilds the effective résumé on every accept and decline,
// and a rejected removal is spliced back at `k = Math.min(oi, list.length)` —
// so every later entry in that section shifts. With a tailored résumé that
// drops experience[0]:
//     nothing rejected   →  resume.experience[1].company === "Gamma"
//     exp.rm.0 rejected  →  resume.experience[1].company === "Beta"
// `@exp.1` is a DIFFERENT JOB in the two states. So a per-application edit
// stored against a block PATH writes the user's own sentence onto someone
// else's bullet the first time any add or removal in that section is toggled —
// silent corruption of the most valuable object they own. Storing it against
// the SOURCE ANCHOR the same walk emits is what fixes it.
//
// BOTH HALVES ARE ASSERTED, and the second is the one that makes the first
// worth having: an override keyed by anchor must land on the same CONTENT in
// both decision states, AND an override keyed by the raw path must land on
// different content. Without the false-positive half, "make the anchor case
// pass" is trivially satisfied by deleting the anchors and keying by path
// again, because with nothing rejected the two are the same string.
//
// esbuild is what compiles this project already; a bundle + run measures ~60 ms.
// If it ever stops resolving, this check fails LOUDLY rather than quietly
// skipping — that is the whole file's rule.
//
// It is a DECLARED devDependency, and that declaration is load-bearing. This
// `require` used to resolve only because npm hoisted vite's transitive copy into
// the top-level `node_modules`: nothing in package.json asked for esbuild, so a
// vite bump that nested or renamed its copy would take this check offline on
// CI — where the loud failure is a red build nobody asked for, on a file nobody
// touched. Pinned to the version already installed; there is nothing to install.
try {
  const esbuild = createRequire(import.meta.url)("esbuild");
  const built = esbuild.buildSync({
    // A virtual entry, so ONE bundle carries both modules' runtime exports.
    stdin: {
      contents:
        `export { mergeForReview, blocksByEdit, blockContainsValue, blockSubtreeContainsValue } from "./lib/resumeDiff";\n` +
        `export { applyOverrides } from "./lib/resumeOverrides";\n`,
      resolveDir: SRC,
      sourcefile: "check-mirrors-probe.ts",
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    target: "node18",
    logLevel: "silent",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", built.outputFiles[0].text)(
    mod,
    mod.exports,
    createRequire(import.meta.url),
  );
  const { mergeForReview, applyOverrides, blocksByEdit, blockContainsValue, blockSubtreeContainsValue } =
    mod.exports;
  for (const [name, fn] of Object.entries({
    mergeForReview,
    applyOverrides,
    blocksByEdit,
    blockContainsValue,
    blockSubtreeContainsValue,
  })) {
    if (typeof fn !== "function") throw new Error(`the bundle did not export ${name}`);
  }

  const R = (over) => ({
    contact: { name: "A B", email: "", phone: "", location: "", linkedin: "", website: "" },
    headline: "",
    summary: "",
    skills: [],
    skill_groups: [],
    experience: [],
    education: [],
    projects: [],
    certifications: [],
    languages: [],
    military_service: [],
    ...over,
  });
  const job = (company, bullets) => ({
    company,
    title: "Engineer",
    location: "",
    start_date: "2020",
    end_date: "2021",
    bullets,
  });
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const gamma = (r) => r.experience.find((e) => e.company === "Gamma");
  const beta = (r) => r.experience.find((e) => e.company === "Beta");

  const original = R({
    experience: [job("Acme", ["acme one"]), job("Beta", ["beta one"]), job("Gamma", ["gamma one"])],
  });
  const tailored = R({
    experience: [job("Beta", ["beta one"]), job("Gamma", ["gamma one, rewritten by the AI"])],
  });
  const A = mergeForReview(original, tailored, new Set()); // nothing rejected
  const B = mergeForReview(original, tailored, new Set(["exp.rm.0"])); // the removal put back

  // The premise. If these ever stop differing the merge has changed shape and
  // everything below is measuring nothing.
  if (A.resume.experience[1].company !== "Gamma" || B.resume.experience[1].company !== "Beta")
    throw new Error("the index-shift fixture no longer shifts — this check's premise is gone");
  if (A.sources["@exp.1"] === B.sources["@exp.1"])
    throw new Error("`sources` does not re-resolve across decision states — nothing here is being tested");

  const MINE = "a sentence I typed myself";
  const byAnchor = { "exp.2.b.0": { bullet: MINE } };
  const oa = applyOverrides(A.resume, A.sources, byAnchor, A.blocks);
  const ob = applyOverrides(B.resume, B.sources, byAnchor, B.blocks);
  if (!eq(gamma(oa.resume).bullets, [MINE]) || !eq(gamma(ob.resume).bullets, [MINE])) {
    fail(
      "lib/resumeOverrides.ts: an override keyed by SOURCE ANCHOR did not land on the same " +
        "bullet in both decision states. A hand-edit on the tailored document is supposed to " +
        "survive every later accept and decline; this is the merge's index shift reaching the " +
        "user's own text.",
    );
  }
  if (!eq(beta(ob.resume).bullets, ["beta one"])) {
    fail(
      "lib/resumeOverrides.ts: applying one override also rewrote a DIFFERENT job's bullet. " +
        "The anchor resolved to the wrong path.",
    );
  }

  // The false-positive half: the naive design, keyed by the rendered path.
  const ident = (s) => Object.fromEntries(Object.keys(s).map((p) => [p, p]));
  const byPath = { "@exp.1.b.0": { bullet: MINE } };
  const pa = applyOverrides(A.resume, ident(A.sources), byPath, A.blocks);
  const pb = applyOverrides(B.resume, ident(B.sources), byPath, B.blocks);
  if (eq(pa.resume.experience[1], pb.resume.experience[1])) {
    fail(
      "check 17's false-positive half stopped firing: an override keyed by the raw PATH " +
        "`@exp.1.b.0` now lands on the same content in both decision states, which means the " +
        "fixture no longer reproduces the index shift and the anchor half proves nothing.",
    );
  }

  // Idempotent: applying the same map twice is the same document. The page
  // re-runs this on every render of a merged résumé.
  const twice = applyOverrides(oa.resume, oa.sources, byAnchor, oa.blocks);
  if (!eq(twice.resume, oa.resume))
    fail("lib/resumeOverrides.ts: applyOverrides is not idempotent — a re-render would keep changing the document.");

  // A keyed rename MOVES its own path, so the map has to follow it or the mark
  // and the review jump are left pointing at a chip that no longer exists.
  const S = mergeForReview(R({ skills: ["Python", "Go"] }), R({ skills: ["Python", "Go"] }), new Set());
  if (S.sources["@skills.go"] !== "skills.item.go")
    throw new Error(`a skill's source anchor is ${S.sources["@skills.go"]}, not skills.item.go`);
  const ren = applyOverrides(S.resume, S.sources, { "skills.item.go": { skill: "Golang" } }, S.blocks);
  if (!ren.resume.skills.includes("Golang"))
    fail("lib/resumeOverrides.ts: renaming a skill through an override did not reach `skills`.");
  if (ren.sources["@skills.golang"] !== "skills.item.go" || "@skills.go" in ren.sources) {
    fail(
      "lib/resumeOverrides.ts: a keyed rename left `sources` pointing at the old path " +
        "(`@skills.python` stops existing the instant it becomes `Python 3`), so the mark and the " +
        "review jump would follow a chip that is no longer there.",
    );
  }

  // Empty means remove, and the bullets after it shift — so every path-keyed
  // map has to be re-indexed or the NEXT override is stored under its
  // neighbour's anchor, which is this module's own defect in miniature.
  const E = mergeForReview(
    R({ experience: [job("Acme", ["b0", "b1", "b2"])] }),
    R({ experience: [job("Acme", ["b0", "b1", "b2"])] }),
    new Set(),
  );
  const rem = applyOverrides(E.resume, E.sources, { "exp.0.b.1": { bullet: "   " } }, E.blocks);
  if (!eq(rem.resume.experience[0].bullets, ["b0", "b2"]))
    fail("lib/resumeOverrides.ts: clearing a bullet through an override did not remove it (empty-means-remove).");
  if (rem.sources["@exp.0.b.1"] !== "exp.0.b.2") {
    fail(
      "lib/resumeOverrides.ts: `sources` was not re-indexed after a bullet removal. The bullet " +
        "that slid up one slot still carries its old neighbour's anchor, so the next hand-edit on " +
        "it is stored against the wrong coordinate.",
    );
  }
  // TWO removals in one entry, which is the only thing that can see the
  // descending sort. Ascending, removing `@exp.0.b.0` first slides b1 and b2
  // down, so the second removal deletes b2 and the survivor is the wrong one.
  const rem2 = applyOverrides(
    E.resume,
    E.sources,
    { "exp.0.b.0": { bullet: "" }, "exp.0.b.1": { bullet: "" } },
    E.blocks,
  );
  if (!eq(rem2.resume.experience[0].bullets, ["b2"])) {
    fail(
      "lib/resumeOverrides.ts: two removals in one entry left " +
        `${JSON.stringify(rem2.resume.experience[0].bullets)} instead of ["b2"]. Removing a bullet ` +
        "shifts the ones after it, so removals have to run LAST and in descending index order — " +
        "otherwise the second one deletes whichever line slid into that slot.",
    );
  }

  // THE VANISH RULE: an anchor with nowhere to land is skipped, never applied
  // somewhere else and never deleted.
  const van = applyOverrides(A.resume, A.sources, { "exp.9.b.9": { bullet: MINE } }, A.blocks);
  if (!eq(van.resume, A.resume))
    fail("lib/resumeOverrides.ts: an override whose anchor resolves to nothing changed the document anyway.");

  // A FLAGGED VALUE IN A BULLET OF AN ADDED ENTRY IS STILL ON THE DOCUMENT.
  //
  // `blocksByEdit` resolves an added entry to its META path (`@exp.1`), whose
  // readable fields are title/employer/location/dates — while the edit's own
  // text folds the entry's BULLETS in. So a fabrication flag on a number living
  // in a bullet was matched against the edit and then looked for in the meta
  // line alone, found nothing, and rendered "Nothing flagged is on your CV any
  // more" over a CV that still carried it. Both halves are asserted here,
  // because the fix is only meaningful as the DIFFERENCE between them.
  const ADD = mergeForReview(
    R({ experience: [job("Alpha", ["a1"])] }),
    R({ experience: [job("Alpha", ["a1"]), job("Beta", ["Grew ARR 300% as lead"])] }),
    new Set(),
  );
  const added = ADD.edits.find((e) => e.kind === "added");
  const addedPath = blocksByEdit(ADD.blocks)[added?.id];
  if (!added || !addedPath) throw new Error("the added-entry fixture produced no added edit with a block");
  if (!added.after.includes("300%"))
    throw new Error("the added-entry fixture's edit text does not fold its bullets in — it cannot exercise this");
  if (blockContainsValue(ADD.resume, addedPath, "300%")) {
    throw new Error(
      "blockContainsValue now reads an entry's bullets, so this check no longer measures anything. " +
        "It exists to prove the SUBTREE reader is what finds them.",
    );
  }
  if (!blockSubtreeContainsValue(ADD.resume, addedPath, "300%")) {
    fail(
      "lib/resumeDiff.ts: blockSubtreeContainsValue misses a value in a BULLET of an added entry. " +
        "ChangeLog resolves a fabrication flag with it, so the trust panel would go mint and say " +
        '"Nothing flagged is on your CV any more" while the invented number is still on the page.',
    );
  }
  // The false-positive half, in the same check: a value that is genuinely absent
  // must stay absent, or "find the bullet" is satisfied by answering true.
  if (blockSubtreeContainsValue(ADD.resume, addedPath, "999 unrelated"))
    fail("lib/resumeDiff.ts: blockSubtreeContainsValue reports a value the entry does not contain.");

  // AN ENTRY-LEVEL SCALAR EDIT MUST NOT OWN ITS ENTRY'S BULLETS.
  //
  // `exp.0.title` anchors to the ENTRY, `exp.0`, so an ungated prefix walk made
  // the review row about a job TITLE own every hand-edit on that job's bullets:
  // the title change became undecidable behind a "Yours" badge, and both of that
  // row's buttons cleared the bullet override — one tap silently deleting a
  // sentence typed on a different line. Only a WHOLE-ENTRY edit owns a subtree,
  // and `editAnchors[id] === id` is the discriminator, because `editSrc(id, id)`
  // at the add/remove sites is the only thing that registers an edit under its
  // own id. Asserted here as a property of the MERGE, so TailorPage's gate keeps
  // a fact to stand on.
  const SC = mergeForReview(
    R({ experience: [job("Alpha", ["a1", "a2"])] }),
    R({ experience: [{ ...job("Alpha", ["a1", "a2"]), title: "Senior Engineer" }] }),
    new Set(),
  );
  const scalar = Object.entries(SC.editAnchors).find(([id]) => id.endsWith(".title"));
  if (!scalar) throw new Error("the scalar-edit fixture produced no `*.title` edit to measure");
  if (scalar[0] === scalar[1]) {
    fail(
      "lib/resumeDiff.ts: an entry-level SCALAR edit is now anchored under its own id, which is the " +
        "signal TailorPage's `ownsAnchor` uses to mean 'this edit is the whole entry'. That row would " +
        "take ownership of every hand-edit on the entry's bullets, and its buttons would delete them.",
    );
  }
  const wholeEntry = Object.entries(ADD.editAnchors).find(([id, a]) => id === a);
  if (!wholeEntry) {
    fail(
      "lib/resumeDiff.ts: an ADDED entry is no longer anchored under its own id, so a hand-edit on one " +
        "of its bullets belongs to no review row — the row keeps a live Accept/Reject and declining it " +
        "discards the user's text with no badge and no note.",
    );
  }
} catch (e) {
  fail(`override anchor-stability check could not run: ${e.message}`);
}

// ---- 18. every BlockMark has a name in both locales ----------------------- //
// `blkProps` renders t(`review.mark.<mark>`) as the marked block's title — its
// accessible name, and the only thing that says what a coloured bar MEANS to a
// reader who cannot see the colour. A member added to the union without a label
// prints the raw key as a tooltip, in Hebrew. Check 8 stays green: en and he
// are still in parity with each other.
try {
  const view = read("components/ResumeView.tsx");
  const at = view.indexOf("export type BlockMark =");
  if (at === -1) throw new Error("could not find the BlockMark union");
  const marks = [...view.slice(at, view.indexOf(";", at)).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (marks.length < 3) throw new Error(`parsed only ${marks.length} BlockMark members`);
  if (!/title:\s*mark\s*\?\s*t\(`review\.mark\.\$\{mark\}`\)/.test(view))
    throw new Error("ResumeView no longer names a marked block with t(`review.mark.${mark}`)");

  for (const loc of ["en", "he"]) {
    const ns = JSON.parse(read(`locales/${loc}/tailor.json`));
    const missing = marks.filter((m) => !resolvesIn(ns, `review.mark.${m}`));
    if (missing.length)
      fail(
        `locales/${loc}/tailor.json: review.mark.{${missing.join(", ")}} missing — a marked block on ` +
          "the document would carry the raw key as its accessible name.",
      );
  }
} catch (e) {
  fail(`block-mark label check could not run: ${e.message}`);
}

// ---- 19. the merge anchors each contact bit to its OWN block -------------- //
// `mergeResumes` used to anchor all five non-name contact edits to the fused
// `@contact` path — the only @contact literal in the file. But `ResumeView`
// renders that fused line ONLY when the document is not editable; when it IS,
// it emits five separate `@contact.<field>` blocks. So the moment editing was
// switched on for a tailored document (23.7), a contact mark pointed at a node
// that does not exist and `showInDoc` scrolled to a selector matching nothing —
// while ChangeLog still drew its Crosshair, because that button gates on the id
// having ANY anchor. A visible button that silently does nothing is the one
// thing ChangeLog's own doc comment forbids.
//
// Check 7 cannot see this: the path is emitted by resumeDiff.ts, not by the
// view, and check 7 compares the STAR form anyway.
//
// DERIVED, not restated: the merge must build its loop from `CONTACT_FIELDS`,
// the same array `RE_CONTACT` is built from, so the paths it mints and the
// paths `readBlock` resolves cannot drift by one word.
try {
  const blocks = read("lib/resumeBlocks.ts");
  const ca = blocks.indexOf("export const CONTACT_FIELDS = [");
  if (ca === -1) throw new Error("could not find CONTACT_FIELDS");
  const fields = [...blocks.slice(ca, blocks.indexOf("]", ca)).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (fields.length < 5) throw new Error(`CONTACT_FIELDS parsed as ${fields.length} entries`);

  const diff = decomment(read("lib/resumeDiff.ts"));
  if (!/import\s*\{[^}]*\bCONTACT_FIELDS\b[^}]*\}\s*from\s*"\.\/resumeBlocks"/.test(diff))
    fail(
      "lib/resumeDiff.ts must import CONTACT_FIELDS from ./resumeBlocks — a hand-kept twin of the " +
        "contact field list drifts, and the symptom is a review jump to a block that is not there.",
    );
  if (!/\.\.\.CONTACT_FIELDS/.test(diff))
    fail("lib/resumeDiff.ts no longer builds its contact loop from CONTACT_FIELDS.");
  // The template is CLOSED — the trailing backtick, not just the `${` prefix.
  // Matching the prefix only accepted `@contact.${f}zzz`, a path `readBlock`
  // cannot resolve, which is the very failure this check exists to catch: the
  // Crosshair renders and scrolls to nothing.
  if (!/anchor\(\s*`@contact\.\$\{\w+\}`/.test(diff))
    fail(
      "lib/resumeDiff.ts does not anchor each contact bit to its own `@contact.<field>` block. On an " +
        "editable document those five blocks are what exists, and ChangeLog's Crosshair would " +
        "scroll to nothing while still rendering.",
    );
  if (!/src\(\s*`@contact\.\$\{\w+\}`/.test(diff))
    fail(
      "lib/resumeDiff.ts emits no SOURCE ANCHOR for the per-field contact blocks, so typing in the " +
        "phone number on a tailored document has no stable coordinate to be stored against.",
    );

  // One id is now anchored to TWO paths (per-field, then the fused line), so
  // the reverse index has to keep the FIRST — the one an editable sheet has.
  const firstWins = (src) => /for\s*\(const id of ids\)\s*if\s*\(!\(id in out\)\)/.test(src);
  if (!firstWins(diff))
    fail(
      "lib/resumeDiff.ts: blocksByEdit is last-wins again. The fused `@contact` anchor is emitted " +
        "after the per-field ones, so it would overwrite them and the review jump would target a " +
        "node that only exists on a read-only document.",
    );
  // Both directions, on the two shapes it has to tell apart.
  if (firstWins("for (const id of ids) out[id] = path;"))
    fail("check 19 accepts a last-wins blocksByEdit");
  if (!firstWins("for (const id of ids) if (!(id in out)) out[id] = path;"))
    fail("check 19 cannot recognise the first-wins form it requires");
} catch (e) {
  fail(`contact anchor check could not run: ${e.message}`);
}

// ---- 20. the override store stays an OVERLAY ----------------------------- //
// (a) `tailorOverrides` is derived from the `rejectedEdits` reset list rather
//     than a hand-kept set of call sites: both answer the same question ("the
//     diff changed — what on screen now describes something that no longer
//     exists?"), so a fifth reset added for one and not the other leaves a
//     hand-edit anchored into a diff that is gone.
// (b) `setBlockOverride` sets `tailorOverrides` and NOTHING else. `writeDraft`
//     mirrors the MASTER's local draft and `draftOver` spreads that draft over
//     the master, so a per-application edit reaching it would have
//     DraftRestoreBar offer to restore a tailored CV as the user's real résumé.
//     `applyBlockEdit` is worse still: it nulls result/tailoredFrom/
//     rejectedEdits, so one keystroke through it destroys the review.
//
// BOTH HALVES READ THE PATCH WITH `patchKeys`, NOT `topLevelKeys`, and that is
// the correction that matters. `topLevelKeys` is strictly LINE-oriented, so a
// patch folded onto one line contributes only its FIRST key and every key after
// it is invisible — which took both halves of this check offline in the same
// way, and both were proven green with the defect in:
//   (a) `discardTailorResult` and `setTargetJob`, each folded to one line with
//       `tailorOverrides: {}` deleted. The reset drops out of `clearing`
//       entirely and is then free to stop clearing the overrides.
//   (b) `setTailorState({ tailorOverrides: {…}, editUndo: null });` on one
//       line — exactly, and only, the write (b) exists to forbid.
// A floor on the count cannot see either: four of five resets still clears any
// floor of four. Raising the floor would not help and a count-based completeness
// guard is WORSE than useless here — it fires on correct code the moment
// `rejectedEdits` is the first key on a folded line, and a guard that fires on
// legitimate input is worse than no guard.
try {
  const store = read("state/tailorStore.ts");
  const fnAt = (i) => {
    const m = [...store.slice(0, i).matchAll(/export function (\w+)/g)].pop();
    return m ? m[1] : "(module scope)";
  };
  /**
   * Depth-0 keys of an object-literal body, INDEPENDENT OF THE NEWLINES.
   *
   * Strip every nested {…}/[…]/(…) innermost-first, then read the keys off
   * whatever commas survive at depth 0. `decomment` runs first and is not
   * optional: a full-line comment inside a reset ("…typed into. They are an
   * overlay on a diff, and the diff is…") carries commas, and the fragment after
   * one swallows the key that follows it.
   *
   * Deliberately NOT folded into `topLevelKeys`. That one also parses a TS
   * interface body for check 1, where members are separated by `;` rather than
   * `,` — splitting on commas would report `ResumeModel` as a single field and
   * check 1 would pass by never firing, which is the 21.7 failure mode with a
   * fix attached.
   */
  const patchKeys = (inner) => {
    let flat = decomment(inner);
    let prev;
    do {
      prev = flat;
      flat = flat.replace(/\{[^{}[\]()]*\}|\[[^{}[\]()]*\]|\([^{}[\]()]*\)/g, "");
    } while (flat !== prev);
    return flat
      .split(",")
      .map((s) => /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(s))
      .filter(Boolean)
      .map((m) => m[1]);
  };
  const resets = [];
  for (let i = store.indexOf("setTailorState("); i !== -1; i = store.indexOf("setTailorState(", i + 1)) {
    // The raw slice is kept alongside the parsed keys for the completeness
    // cross-check below — the parser and the text have to agree about the file.
    const src = blockAfter(store.slice(i), "setTailorState(", "a setTailorState call");
    resets.push({ fn: fnAt(i), src, keys: patchKeys(src) });
  }
  const clearing = resets.filter((r) => r.keys.includes("rejectedEdits"));
  // TWO guards, and they catch different things.
  //
  // The floor is only the "the scrape went dark entirely" alarm: rename
  // `setTailorState` and `resets` is empty, `clearing` is empty, and every
  // comparison below is vacuously true.
  if (clearing.length < 4)
    throw new Error(`found only ${clearing.length} setTailorState resets that clear rejectedEdits`);
  // The second is the SCAN'S OWN COMPLETENESS: every reset whose TEXT mentions
  // `rejectedEdits` must be one the PARSER also read it out of. The two now
  // agree by construction, which is the point — this is the assertion that says
  // so, and it is what turns a future parser regression into a loud failure
  // instead of a check that quietly stops covering a reset. `mentions` counts
  // reset SLICES, never the file, so the state interface's own
  // `rejectedEdits: string[]` and the initial-state literal cannot inflate it.
  const mentions = resets.filter((r) => /\brejectedEdits\s*:/.test(r.src));
  if (clearing.length !== mentions.length)
    throw new Error(
      `${mentions.length} setTailorState resets mention \`rejectedEdits\` but ${clearing.length} parsed as ` +
        `clearing it — the patch parser has stopped agreeing with the file it reads (${mentions
          .filter((r) => !r.keys.includes("rejectedEdits"))
          .map((r) => `\`${r.fn}\``)
          .join(", ") || "no named function"})`,
    );
  const missed = clearing.filter((r) => !r.keys.includes("tailorOverrides")).map((r) => r.fn);
  if (missed.length) {
    fail(
      `state/tailorStore.ts: ${[...new Set(missed)].map((f) => `\`${f}\``).join(", ")} clears ` +
        "`rejectedEdits` but not `tailorOverrides`. Both describe the same diff, so the hand-edits " +
        "would outlive the review they were typed into and re-apply against a different one.",
    );
  }

  const body = blockAfter(store, "export function setBlockOverride", "setBlockOverride body");
  // ONE predicate, used by the assertion and by both probes, so the probes
  // cannot certify a matcher the assertion does not use.
  const taints = (src) => ["writeDraft(", "applyBlockEdit("].filter((c) => src.includes(c));
  const found = taints(body);
  if (found.length)
    fail(
      `state/tailorStore.ts: setBlockOverride calls ${found.join(" and ")}. An application-only edit ` +
        "must not reach the master's local draft (DraftRestoreBar would offer to restore a tailored " +
        "CV as the real résumé) and must never reach applyBlockEdit (which nulls `result` and " +
        "destroys the review being edited).",
    );
  const patch = patchKeys(blockAfter(body, "setTailorState(", "setBlockOverride patch"));
  if (!patch.includes("tailorOverrides"))
    throw new Error(
      "setBlockOverride does not set tailorOverrides — this check is pointed at the wrong function. " +
        "(A spread argument lands here too, and it hides what is being set.)",
    );
  const extra = patch.filter((k) => k !== "tailorOverrides");
  if (extra.length)
    fail(
      `state/tailorStore.ts: setBlockOverride also sets ${extra.map((k) => `\`${k}\``).join(", ")}. ` +
        "It may set `tailorOverrides` and nothing else — writing `resume` would copy the flattened " +
        "tailored CV over the master (a tailored résumé carries no skill_groups), and touching " +
        "`editUndo` would put an application-only edit on the master's undo stack.",
    );
  if (taints("setTailorState({ tailorOverrides: next }); writeDraft(next);").length !== 1)
    fail("check 20 cannot detect a setBlockOverride that writes the master draft");
  if (taints("setTailorState({ tailorOverrides: next });").length !== 0)
    fail("check 20 fires on a clean setBlockOverride");
  // The flattener, in both directions, on the ONE-LINE shape the line-oriented
  // parser was blind to — the probe that would have caught both holes.
  const ONE_LINE_OK = " tailorOverrides: { ...state.tailorOverrides, [anchor]: values } ";
  const ONE_LINE_BAD = " tailorOverrides: { ...state.tailorOverrides, [anchor]: values }, editUndo: null ";
  if (patchKeys(ONE_LINE_OK).join() !== "tailorOverrides")
    fail("check 20 cannot read a one-line setBlockOverride patch that is legitimately clean");
  if (patchKeys(ONE_LINE_BAD).join() !== "tailorOverrides,editUndo")
    fail("check 20 cannot see a second key folded onto the same line — the write it exists to forbid");
  // …and the same, on (a)'s shape: a folded RESET must still be read key by key,
  // in both directions, or the fold silently un-covers it again.
  const FOLDED = ' result: null, rejectedEdits: [], coverLetterText: "" ';
  if (!patchKeys(FOLDED).includes("rejectedEdits"))
    fail("check 20 cannot read a reset folded onto one line — the shape that hid the defect");
  if (patchKeys(FOLDED).includes("tailorOverrides"))
    fail("check 20 reports a key a folded reset does not set — it would fire on correct code");
  // A comment inside a patch carries commas, and the fragment after one used to
  // swallow the key that followed it. Pinned because `decomment` looks removable.
  if (!patchKeys(" rejectedEdits: [],\n // an overlay on a diff, and the diff is what this discards\n tailorOverrides: {},").includes("tailorOverrides"))
    fail("check 20 loses a key that follows a comma inside a comment — decomment is load-bearing");
  // …and the nested-group stripping, which the two ONE_LINE fixtures above pass
  // either way and therefore do not pin. A NESTED key read as a top-level one is
  // this check's own false-positive shape: it invents an "also sets `keep`" out
  // of a value nobody wrote at depth 0.
  if (patchKeys(" tailorOverrides: { ...o, [anchor]: values, keep: 1 } ").join() !== "tailorOverrides")
    fail("check 20 reads a NESTED key as a top-level one — its {…}/[…]/(…) stripping has stopped working");
} catch (e) {
  fail(`override store check could not run: ${e.message}`);
}

// ---- 21. adding stays MASTER-only on the document ------------------------- //
// 23.7 split `editable` into `isMaster` (this document IS the saved résumé) and
// `canEditDoc` (there is a document at all). Typing on the paper moved to the
// second; ADDING must stay on the first, and the reason is the fabrication
// guard rather than caution: it ran against `result.tailored_resume`, so a
// claim typed in afterwards carries no verdict at all while ScoreCard goes on
// rendering `result.fabrication_flags` beside it. An added block also exists in
// neither the original nor the tailored résumé, so it has no source anchor to
// be stored against.
//
// `tsc` sees nothing here: both flags are booleans and every prop is optional.
try {
  const page = decomment(read("pages/TailorPage.tsx"));
  const gate = (src, prop) => {
    const m = new RegExp(`\\b${prop}=\\{([^}]*)\\}`).exec(src);
    return m ? m[1] : null;
  };
  if (!/const isMaster\s*=/.test(page)) throw new Error("pages/TailorPage.tsx no longer declares `isMaster`");
  if (!/const canEditDoc\s*=/.test(page)) throw new Error("pages/TailorPage.tsx no longer declares `canEditDoc`");

  // POLARITY, not presence. `/\bisMaster\b/` pinned only that the flag is
  // MENTIONED, so `onAdd={!isMaster ? addToResume : undefined}` — one character —
  // passed green while putting the add controls on the tailored document ONLY:
  // exactly, and only, where a newly typed claim carries no fabrication verdict
  // and has no source anchor to be stored against. So the gate must OPEN with
  // its flag, which is also the one shape every one of these props uses today.
  const opensWith = (flag) => new RegExp(`^\\s*${flag}\\s*\\?`);
  const MASTER_ONLY = opensWith("isMaster");
  const DOC_EDITABLE = opensWith("canEditDoc");

  for (const prop of ["onAdd", "onAddNamed", "onAddSkill", "onAddBullet", "onReplace"]) {
    const g = gate(page, prop);
    if (g === null) throw new Error(`could not find ${prop}={…} in TailorPage.tsx`);
    if (!MASTER_ONLY.test(g) || /\bcanEditDoc\b/.test(g))
      fail(
        `pages/TailorPage.tsx: ${prop}={${g.trim()}} is not gated on \`isMaster ? …\`. On a tailored ` +
          "document that adds a claim the fabrication guard never saw, directly above a panel still " +
          "reporting the guard's verdict on a different set of words — and an added block has no " +
          "source anchor, so the edit could not be stored anywhere stable either.",
      );
  }
  // The other half, or "make it pass" is satisfied by never letting the
  // document be edited at all.
  for (const prop of ["onInlineCommit", "onEditBlock"]) {
    const g = gate(page, prop);
    if (g === null) throw new Error(`could not find ${prop}={…} in TailorPage.tsx`);
    if (!DOC_EDITABLE.test(g))
      fail(
        `pages/TailorPage.tsx: ${prop}={${g.trim()}} is no longer gated on \`canEditDoc ? …\`, so the ` +
          "tailored document is read-only again and 23.7's whole point is gone.",
      );
  }
  // The extractor, in both directions, on the two shapes it has to tell apart.
  if (gate('<X onAdd={isMaster ? add : undefined} />', "onAdd") !== "isMaster ? add : undefined")
    fail("check 21's gate extractor cannot read a prop it is pointed at");
  if (gate('<X onAddSkill={isMaster ? s : undefined} />', "onAdd") !== null)
    fail("check 21's gate extractor matches onAddSkill when asked for onAdd");
  // …and the POLARITY, in both directions, on the same two predicates the
  // assertions use — so neither can quietly go back to pinning the identifier.
  if (!MASTER_ONLY.test("isMaster ? add : undefined"))
    fail("check 21 cannot recognise the master-only gate it requires");
  if (MASTER_ONLY.test("!isMaster ? add : undefined"))
    fail("check 21 accepts an INVERTED add gate — it is pinning the identifier, not the polarity");
  if (!DOC_EDITABLE.test("canEditDoc ? commit : undefined"))
    fail("check 21 cannot recognise the editable gate it requires");
  if (DOC_EDITABLE.test("!canEditDoc ? commit : undefined"))
    fail("check 21 accepts an INVERTED editing gate — the same one-character inversion, one flag over");
} catch (e) {
  fail(`add-control gating check could not run: ${e.message}`);
}

// ---- 22. the review + document-editing vocabulary resolves --------------- //
// The same gap check 16 was written for, one namespace over, and 23.7 widened
// it by a dozen keys: the third review-row state (`review.yours*`,
// `review.useAi`, `review.useOriginal`) and the tailored document's own copy
// (`edit.tailoredHint`, `edit.tailoredNoAdd`, `edit.yours*`). Check 8 is
// parity-only, so a key renamed in code and in NEITHER locale is green; checks
// 2/3/5 read only the derived vocabularies (sections, groups, block kinds and
// field keys) and none of these is derived from anything.
//
// Separate from check 16 rather than folded into it, deliberately: that one is
// scoped to the overlay's two files and has its own floor.
//
// PER-FILE FLOORS, not one on the sum. A floor on the total is not a fail-loud
// guard — this check was written with one and its own probe walked straight
// past it: changing ChangeLog's call shape so that NONE of its 26 keys were
// scraped still left 15 from the other two files, and the build stayed green
// while the whole review panel went unguarded. That is check 9's lesson
// (guard each scrape separately) arriving a second time.
//
// Literal calls only. `t(\`review.kind.${edit.kind}\`)` and
// `t(\`edit.fields.${key}\`)` are template literals with no fixed key to look
// up, and both are already pinned by checks 2 and 5.
//
// EVERY file that renders one of these keys has to be in the list, and two were
// missing. `ResumeEditBar.tsx` carries fourteen of them and `BlockEditSheet.tsx`
// three, and nothing scanned either: deleting `edit.langWarnTitle` from BOTH
// locales left the build green — and that key is the TITLE of the confirm
// dialog standing between the user and overwriting the wrong-language master
// résumé, so the dialog would ask for that decision under the string
// "edit.langWarnTitle", at 12px, in Hebrew. `edit.apply` and `edit.remove` — the
// sheet's two verbs, one of them destructive — were green as well. A per-file
// floor is no protection when the file is not in the list at all.
try {
  // Floors set just under what each file carries today, so a legitimately
  // added or removed string does not trip them but a call shape going dark does.
  const files = [
    ["pages/TailorPage.tsx", 4],
    ["components/ChangeLog.tsx", 15],
    ["components/ResumeView.tsx", 6],
    ["components/ResumeEditBar.tsx", 12],
    ["components/BlockEditSheet.tsx", 3],
    // The review drawer. Its `doc.review.*` scalars were guarded by NOTHING
    // until 2026-09-04: check 27 covers `doc.review.checks.<id>.{label,how}`
    // only, and check 8 stays green while a key is missing from BOTH locales,
    // which is exactly how a literal like `doc.review.upTo` would ship as a raw
    // key at 12px in Hebrew.
    ["components/ReviewPanel.tsx", 9],
    ["components/DocumentPanel.tsx", 2],
  ];
  // `[,)]` for check 9's reason: a counted or interpolated label —
  // t("edit.yours", { count }) — is exactly the kind most likely to be renamed,
  // and a `)`-only matcher is blind to it.
  // `doc\.review` before `review` in the alternation would still match the
  // shorter branch first on a `doc.review.*` key, so the prefix is spelled out
  // as its own branch and the regex is anchored by `t("`.
  const CALL = /\bt\("((?:doc\.review|review|edit)\.[^"]+)"\s*[,)]/g;
  const keys = new Set();
  for (const [f, floor] of files) {
    const here = [...decomment(read(f)).matchAll(CALL)].map((m) => m[1]);
    if (here.length < floor)
      throw new Error(
        `scraped only ${here.length} literal t("doc.review.*")/t("review.*")/t("edit.*") keys from ${f} (expected at least ${floor}) — the call shape changed`,
      );
    for (const k of here) keys.add(k);
  }

  for (const loc of ["en", "he"]) {
    const ns = JSON.parse(read(`locales/${loc}/tailor.json`));
    for (const key of keys) {
      if (!resolvesIn(ns, key))
        fail(
          `locales/${loc}/tailor.json is missing "${key}" — the review panel or the document would ` +
            "render the raw key. Check 8 stays green while both locales are equally wrong.",
        );
    }
  }
} catch (e) {
  fail(`review/edit label check could not run: ${e.message}`);
}

// ---- 23. the eleven template specs still match templates.py -------------- //
// "Some templates aren't right like it's shown in the example; in the example
// there's a format and in real it gives another format." Three surfaces have to
// know what a template looks like BEFORE the backend renders anything — the
// landing's miniatures, the picker's thumbnails and the document on /app — and
// each grew its own hand-copy of
// `backend/app/render/templates.py::TemplateSpec`. Two had already drifted: the
// miniature's `classic` drew skills as an inline comma run against the file's
// chips, and TemplateThumb's `modern` band meta is #9EC4B8 against
// band_meta="9CC6B9". `tsc` sees none of it — both sides are correctly typed
// strings and numbers describing different documents.
//
// SCOPE. This reads `lib/templateSpecs.ts`, the one mirror the miniatures now
// draw from. `TemplateThumb.tsx` still carries its own constants and is NOT
// read here, so the picker's eleven thumbnails are still guarded by nothing;
// point that file at TEMPLATE_SPECS and it comes under this check for free,
// which is the whole reason the mirror is a module and not a local table.
//
// PURE NODE, no interpreter, deliberately. check-mirrors runs FIRST in
// `npm run build` and on every Vercel CI build, where there is no Python venv,
// so shelling out to the interpreter would be a check that cannot run in CI —
// i.e. one that has stopped firing, the 21.7 failure mode this file exists for.
// templates.py is parsed as a literal instead: `#` comments stripped without
// touching a `#` inside a string, `name: type = default` read out of the
// dataclass body, `TEMPLATES` brace-matched and each entry's kwargs read, then
// the defaults folded under the overrides exactly as the dataclass folds them.
// That fold is the point rather than a detail: `entry` defaults to "split" and
// `list_cols` to 1 while nine and eleven templates respectively override them,
// so a mirror carrying defaults of its own is wrong on precisely the fields
// nobody wrote down.
//
// DEGRADES LOUDLY, and only on ENOENT. `vercel.json` roots the frontend service
// at `frontend/`; if `../backend` is not in that build's context the Python half
// prints a skip naming the path it looked for, and the frontend-only half — the
// three id lists, the picker's PDF-only list, both locales — still runs. Every
// other failure, a parse that comes up short included, is a red build. GitHub
// Actions checks the whole repo out and runs `npm run build` from frontend/ on
// every push and PR, so the comparison has a home that does not depend on how
// Vercel packages a service.
const TEMPLATES_PY = path.join(HERE, "..", "..", "backend", "app", "render", "templates.py");
// Set when the Python half is skipped, so the summary line admits it too — a
// warning above a final "mirrors ok" is a warning somebody reads as noise.
let templateSkip = null;
try {
  // --- the TS mirror, EXECUTED rather than parsed (check 17's mechanism) ----
  // Parsing it would have to re-implement the `...TEMPLATE_SPEC_DEFAULTS`
  // spread, which is the exact fold this check exists to compare. Running it
  // gives the object the app itself renders from. `ResumeTemplate` is a TYPE
  // import there, so the bundle pulls in neither axios nor `import.meta.env`.
  const esbuild = createRequire(import.meta.url)("esbuild");
  const built = esbuild.buildSync({
    stdin: {
      contents: `export { TEMPLATE_SPECS, TEMPLATE_IDS, PDF_ONLY } from "./lib/templateSpecs";\n`,
      resolveDir: SRC,
      sourcefile: "check-mirrors-templates.ts",
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    target: "node18",
    logLevel: "silent",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", built.outputFiles[0].text)(
    mod,
    mod.exports,
    createRequire(import.meta.url),
  );
  const { TEMPLATE_SPECS, TEMPLATE_IDS, PDF_ONLY } = mod.exports;
  if (!TEMPLATE_SPECS || typeof TEMPLATE_SPECS !== "object")
    throw new Error("lib/templateSpecs.ts did not export TEMPLATE_SPECS");
  if (typeof PDF_ONLY !== "function") throw new Error("lib/templateSpecs.ts did not export PDF_ONLY");
  if (!Array.isArray(TEMPLATE_IDS)) throw new Error("lib/templateSpecs.ts did not export TEMPLATE_IDS");
  const ids = Object.keys(TEMPLATE_SPECS);
  if (ids.length < 11) throw new Error(`TEMPLATE_SPECS carries only ${ids.length} templates`);
  if (Object.keys(TEMPLATE_SPECS[ids[0]]).length < 30)
    throw new Error(`TEMPLATE_SPECS["${ids[0]}"] carries only ${Object.keys(TEMPLATE_SPECS[ids[0]]).length} fields`);

  const missingFrom = (a, b) => a.filter((x) => !b.includes(x));

  // --- (b) one id set, three places ---------------------------------------
  // An id in RESUME_TEMPLATES with no spec is a thumbnail that cannot be drawn;
  // an id in the mirror the backend has never heard of sends a template name
  // `get_template` silently falls back to DEFAULT_TEMPLATE for. (The `Record<
  // ResumeTemplate, TemplateSpec>` annotation makes tsc agree about the first
  // two; the Python leg below is the one nothing else can see.)
  const client = /export const RESUME_TEMPLATES = \[([\s\S]*?)\]/.exec(read("api/client.ts"));
  if (!client) throw new Error("could not find RESUME_TEMPLATES in api/client.ts");
  const picker = [...client[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (picker.length < 11) throw new Error(`parsed only ${picker.length} RESUME_TEMPLATES ids`);
  for (const [what, gone] of [
    ["lib/templateSpecs.ts has no spec for", missingFrom(picker, ids)],
    ["api/client.ts's RESUME_TEMPLATES does not list", missingFrom(ids, picker)],
  ]) {
    if (gone.length)
      fail(
        `${what} ${gone.map((i) => `\`${i}\``).join(", ")}. The picker, the landing and the ` +
          "renderers have to agree on one id set — an unlisted id is unpickable, and an " +
          "unmirrored one draws no thumbnail.",
      );
  }
  // TEMPLATE_IDS is what the landing maps over, so its ORDER is the display
  // order the picker also claims to use. Compared as a sequence, not a set.
  if (TEMPLATE_IDS.join() !== picker.join())
    fail(
      `lib/templateSpecs.ts: TEMPLATE_IDS is [${TEMPLATE_IDS.join(", ")}] but RESUME_TEMPLATES is ` +
        `[${picker.join(", ")}] — the landing and the picker would show the same eleven templates ` +
        "in two different orders.",
    );

  // --- (e) the picker's PDF-only list -------------------------------------
  // A third sidebar template added to the backend would otherwise ship with no
  // "PDF only" badge, no picker desc warning, no TailorPage docxFallback note
  // and no XrayResult docxDiffers line — four warnings failing silently at
  // once. The Python leg of this is the `layout` row of the field comparison
  // below, so this stays honest even when the Python half is skipped.
  const pickerSrc = read("components/TemplatePicker.tsx");
  const pdfOnly = /PDF_ONLY_TEMPLATES[^=]*=\s*\[([^\]]*)\]/.exec(pickerSrc);
  if (!pdfOnly) throw new Error("could not find PDF_ONLY_TEMPLATES in components/TemplatePicker.tsx");
  const declared = [...pdfOnly[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (!declared.length) throw new Error("PDF_ONLY_TEMPLATES parsed as empty");
  const twoColumn = ids.filter((id) => PDF_ONLY(id));
  if (declared.join() !== twoColumn.join())
    fail(
      `components/TemplatePicker.tsx: PDF_ONLY_TEMPLATES is [${declared.join(", ")}] but the specs ` +
        `say [${twoColumn.join(", ")}] render two columns. Every surface that offers a .docx warns ` +
        "off this one list, so a missing id silently drops four warnings at once.",
    );

  // --- (f) both locales name every template -------------------------------
  // Check 8 only proves en and he agree WITH EACH OTHER, so a template added to
  // neither renders "download.templates.x.name" as its own label, at 12px, in
  // both languages.
  for (const loc of ["en", "he"]) {
    const tailor = JSON.parse(read(`locales/${loc}/tailor.json`));
    const marketing = JSON.parse(read(`locales/${loc}/marketing.json`));
    for (const id of ids) {
      for (const key of [`download.templates.${id}.name`, `download.templates.${id}.desc`]) {
        if (!resolvesIn(tailor, key))
          fail(`locales/${loc}/tailor.json is missing "${key}" — the picker would render the raw key.`);
      }
      for (const key of [`templates.${id}.name`, `templates.${id}.desc`]) {
        if (!resolvesIn(marketing, key))
          fail(`locales/${loc}/marketing.json is missing "${key}" — the landing would render the raw key.`);
      }
    }
  }

  // --- templates.py, parsed as a literal -----------------------------------
  let raw = null;
  try {
    raw = fs.readFileSync(TEMPLATES_PY, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    templateSkip = `${TEMPLATES_PY} not readable`;
    console.warn(
      `\n  ! check 23 DEGRADED: ${TEMPLATES_PY} is not readable from this build, so the eleven\n` +
        `    template specs in lib/templateSpecs.ts were NOT compared against the renderers'\n` +
        `    source. The id sets, the PDF-only list and both locales were still checked.\n` +
        `    This is expected only where the frontend is built without the repo around it;\n` +
        `    CI (.github/workflows/ci.yml) checks the whole repo out, so the comparison runs there.\n`,
    );
  }

  if (raw !== null) {
    /** Python `#` comments, stripped without touching a `#` inside a string. */
    const decommentPy = (src) => {
      let out = "";
      let i = 0;
      let quote = null;
      while (i < src.length) {
        const c = src[i];
        if (quote) {
          if (c === "\\" && quote.length === 1) {
            out += src.slice(i, i + 2);
            i += 2;
            continue;
          }
          if (src.startsWith(quote, i)) {
            out += quote;
            i += quote.length;
            quote = null;
            continue;
          }
          out += c;
          i++;
          continue;
        }
        if (c === '"' || c === "'") {
          const triple = src.slice(i, i + 3);
          quote = triple === '"""' || triple === "'''" ? triple : c;
          out += quote;
          i += quote.length;
          continue;
        }
        if (c === "#") {
          while (i < src.length && src[i] !== "\n") i++;
          continue;
        }
        out += c;
        i++;
      }
      return out;
    };

    /** The balanced block that opens at `src[open]` — `{`, `(` or `[`. */
    const balanced = (src, open) => {
      const close = { "{": "}", "(": ")", "[": "]" }[src[open]];
      if (!close) throw new Error(`templates.py: expected a bracket at offset ${open}`);
      let depth = 0;
      for (let i = open; i < src.length; i++) {
        if (src[i] === src[open]) depth++;
        else if (src[i] === close) {
          depth--;
          if (depth === 0) return src.slice(open + 1, i);
        }
      }
      throw new Error(`templates.py: unbalanced ${src[open]} at offset ${open}`);
    };

    /** Split on top-level commas — a tuple default and a kwargs list both need it. */
    const splitTop = (src) => {
      const out = [];
      let depth = 0;
      let quote = null;
      let cur = "";
      for (const c of src) {
        if (quote) {
          cur += c;
          if (c === quote) quote = null;
          continue;
        }
        if (c === '"' || c === "'") {
          quote = c;
          cur += c;
          continue;
        }
        if ("([{".includes(c)) depth++;
        else if (")]}".includes(c)) depth--;
        if (c === "," && depth === 0) {
          out.push(cur);
          cur = "";
          continue;
        }
        cur += c;
      }
      out.push(cur);
      return out.map((s) => s.trim()).filter(Boolean);
    };

    // Two sentinels rather than `undefined`, so "templates.py gives this no
    // default" and "this parser cannot read that literal" stay distinguishable
    // from "the value is absent" all the way to the comparison.
    const NO_DEFAULT = Symbol("no default");
    const UNREAD = Symbol("unread literal");
    const literal = (text) => {
      const s = text.trim();
      if (/^"[^"]*"$/.test(s) || /^'[^']*'$/.test(s)) return s.slice(1, -1);
      if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
      if (s === "True") return true;
      if (s === "False") return false;
      if (s.startsWith("(") && s.endsWith(")")) {
        const items = splitTop(s.slice(1, -1)).map(literal);
        return items.some((v) => v === UNREAD) ? UNREAD : items;
      }
      return UNREAD; // `A4_W`, and anything else this parser deliberately does not read
    };

    const py = decommentPy(raw);
    const classAt = py.indexOf("class TemplateSpec:");
    const dictAt = py.search(/^TEMPLATES\s*:\s*dict\[[^\]]*\]\s*=\s*\{/m);
    if (classAt === -1) throw new Error("templates.py has no `class TemplateSpec:`");
    if (dictAt === -1) throw new Error("templates.py has no `TEMPLATES: dict[...] = {`");

    // (a) fail-loud floors. A parser that quietly reads two fields and reports
    // no drift is the 21.7 defect, not a passing check.
    const fields = new Map();
    for (const line of py.slice(classAt, dictAt).split("\n")) {
      const m = /^ {4}([a-z_][a-z0-9_]*)\s*:\s*([^=\n]+?)(?:\s*=\s*(.*?))?\s*$/.exec(line);
      if (m) fields.set(m[1], m[3] === undefined ? NO_DEFAULT : literal(m[3]));
    }
    const defaults = [...fields].filter(([, v]) => v !== NO_DEFAULT).length;
    if (fields.size < 40 || defaults < 30)
      throw new Error(
        `parsed only ${fields.size} TemplateSpec fields (${defaults} with defaults) out of templates.py — ` +
          "the dataclass body has stopped matching this parser",
      );

    const overrides = {};
    const dict = balanced(py, py.indexOf("{", dictAt));
    for (const m of dict.matchAll(/"([a-z0-9_]+)"\s*:\s*TemplateSpec\(/g)) {
      const kw = {};
      for (const arg of splitTop(balanced(dict, m.index + m[0].length - 1))) {
        const a = /^([a-z_][a-z0-9_]*)\s*=\s*([\s\S]+)$/.exec(arg);
        if (!a) throw new Error(`templates.py: could not read \`${arg}\` in TemplateSpec("${m[1]}")`);
        kw[a[1]] = literal(a[2]);
      }
      if (kw.id !== m[1])
        throw new Error(`templates.py: TEMPLATES["${m[1]}"] carries id=${JSON.stringify(kw.id)}`);
      overrides[m[1]] = kw;
    }
    const pyIds = Object.keys(overrides);
    if (pyIds.length < 11)
      throw new Error(`parsed only ${pyIds.length} entries out of templates.py's TEMPLATES dict`);

    for (const [what, gone] of [
      ["lib/templateSpecs.ts has no spec for", missingFrom(pyIds, ids)],
      ["templates.py does not define", missingFrom(ids, pyIds)],
    ]) {
      if (gone.length)
        fail(
          `${what} ${gone.map((i) => `\`${i}\``).join(", ")}. An id the backend has and the frontend ` +
            "does not is unpickable; an id only the frontend has sends a name `get_template` " +
            "silently falls back to DEFAULT_TEMPLATE for.",
        );
    }

    // (c)/(d) the field map, declared ONCE. Only the irregular names are listed;
    // every other field is the snake_case of its own name, and a name that does
    // not resolve to a real field is REPORTED — that is what a rename in
    // templates.py looks like from here, and it would otherwise compare as
    // trivially absent on both sides.
    const FIELD = {
      mx: "margin_lr_pt",
      my: "margin_tb_pt",
      body: "body_size",
      head: "heading_size",
      name: "name_size",
      meta: "meta_size",
      tracking: "heading_tracking",
      serif: "pdf_family",
    };
    const pyName = (k) => FIELD[k] ?? k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

    // `serif` is the one mirrored field that is not a copy: no face templates.py
    // names can be web-loaded here (fonts.css ships Inter + Heebo only, and Lato
    // and Spectral are PDF-EMBEDDED), so the screen reproduces the CATEGORY.
    // Both sets are listed so a family the frontend has never heard of throws
    // instead of being silently sorted into sans.
    const SERIF_FAMILIES = new Set(["Spectral"]);
    const SANS_FAMILIES = new Set(["Lato"]);
    const DERIVE = { serif: (v) => SERIF_FAMILIES.has(v) };
    for (const id of pyIds) {
      const family = overrides[id].pdf_family ?? fields.get("pdf_family");
      if (!SERIF_FAMILIES.has(family) && !SANS_FAMILIES.has(family))
        throw new Error(
          `templates.py: ${id} sets pdf_family=${JSON.stringify(family)}, which this check cannot ` +
            "classify as serif or sans — add it to SERIF_FAMILIES / SANS_FAMILIES after deciding " +
            "which one the miniatures should draw",
        );
    }

    // templates.py stores colours bare, these are CSS values, and both sides
    // spell the same number in different ways (0.60 vs 0.6).
    const norm = (v) =>
      typeof v === "string" && /^#?[0-9a-f]{6}$/i.test(v) ? v.replace(/^#/, "").toUpperCase() : v;
    const same = (a, b) => {
      if (Array.isArray(a) || Array.isArray(b))
        return (
          Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]))
        );
      return norm(a) === norm(b);
    };

    // The comparator folds defaults under overrides on every call, so the probe
    // below can mutate the parsed source in memory and see the difference.
    const show = (v) => (Array.isArray(v) ? `[${v.join(", ")}]` : JSON.stringify(v));
    const compare = () => {
      const out = [];
      for (const id of ids) {
        if (!overrides[id]) continue; // already reported as a missing id
        const effective = { ...Object.fromEntries(fields), ...overrides[id] };
        for (const [key, mine] of Object.entries(TEMPLATE_SPECS[id])) {
          const field = pyName(key);
          if (!fields.has(field)) {
            out.push(`${id}.${key} mirrors \`${field}\`, which templates.py no longer has`);
            continue;
          }
          const theirs = effective[field];
          if (theirs === UNREAD)
            throw new Error(`templates.py: this check cannot read the value of \`${field}\``);
          if (theirs === NO_DEFAULT) {
            out.push(`${id} does not set \`${field}\`, and templates.py gives it no default`);
            continue;
          }
          const want = DERIVE[key] ? DERIVE[key](theirs) : theirs;
          if (!same(mine, want))
            out.push(
              `${id}.${key} is ${show(mine)}, templates.py says ${field}=${show(theirs)}` +
                (DERIVE[key] ? ` (⇒ ${show(want)})` : ""),
            );
        }
      }
      return out;
    };

    const drift = compare();
    for (const d of drift) {
      fail(
        `lib/templateSpecs.ts: ${d}. The mirror is what the landing's miniatures, the picker's ` +
          "thumbnails and the document draw from, so this is a preview that lies about the file " +
          "the user downloads.",
      );
    }

    // Both directions, on the comparator the assertion actually uses: mutate one
    // parsed value in memory, expect exactly that one extra mismatch, restore,
    // expect the original count back. A comparator that cannot fire on its own
    // defect shape passes for ever.
    const probeId = ids.find((id) => overrides[id] && typeof overrides[id].accent === "string");
    if (!probeId) throw new Error("no template sets `accent` — this probe has nothing to mutate");
    const keep = overrides[probeId].accent;
    overrides[probeId].accent = keep === "000000" ? "FFFFFF" : "000000";
    const probed = compare();
    overrides[probeId].accent = keep;
    if (probed.length !== drift.length + 1 || !probed.some((p) => p.startsWith(`${probeId}.accent `)))
      fail("check 23's comparator cannot see a drifted value — changing templates.py's accent in memory changed nothing it reports");
    if (compare().length !== drift.length)
      fail("check 23's comparator does not fold the defaults fresh — it is reading state left over from the probe");
    // …and the two helpers the comparison rests on, in both directions.
    if (!same("#1F3A5F", "1f3a5f")) fail("check 23 cannot see through a leading `#` on a colour");
    if (same("#1F3A5F", "1F3A60")) fail("check 23 calls two different colours equal");
    if (!same(0.6, 0.6) || same(0.6, 0.62)) fail("check 23 cannot compare two numbers");
    if (!same(["a", "b"], ["a", "b"]) || same(["a"], ["a", "b"]))
      fail("check 23 cannot compare `sidebar_keys` element by element");
    if (!fields.has(pyName("headingShortPt")))
      fail("check 23's camelCase → snake_case map no longer resolves a field it is pointed at");
    if (fields.has(pyName("headingShortPtz")))
      fail("check 23 resolves a field templates.py does not have — a rename would compare as absent on both sides");
  }
} catch (e) {
  fail(`template spec mirror check could not run: ${e.message}`);
}

// ---- 24. the document is drawn in the template it will be downloaded as ---- //
// "In the example there's a format and in real it gives another format."
// `DocumentPanel` holds the template choice and hands it to `usePdfPreview`,
// `useXray`, both `downloadResume` calls and `XrayResult` — and did not hand it
// to `<ResumeView>`. So the sheet was hard-wired to ONE look for all eleven
// templates: `.sheet` re-declares the palette with the classic navy, skills were
// always chips, entries always stacked, headings always tracked caps over a
// hairline. Pick Executive and you got a serif, cream, centred-name,
// split-entry, no-heading-rule PDF while the page you EDIT ON stayed sans,
// white, left-aligned, chipped and ruled. Every other surface honoured the
// choice; the one the user works on did not.
//
// `tsc` cannot see any of it: `template` is an OPTIONAL prop, so the omission
// compiles, renders and silently defaults to classic. That is the same shape as
// check 12 — both sides correctly typed, one of them simply never written.
try {
  const panel = decomment(read("components/DocumentPanel.tsx"));
  const view = decomment(read("components/ResumeView.tsx"));

  // (a) the mount itself. Sliced to the element so a `template={template}`
  // anywhere else in the file — the download call, the x-ray — cannot stand in
  // for it.
  const mount = (src) => {
    const at = src.indexOf("<ResumeView");
    if (at === -1) throw new Error("could not find the <ResumeView> mount in DocumentPanel.tsx");
    const end = src.indexOf("/>", at);
    if (end === -1) throw new Error("the <ResumeView> mount in DocumentPanel.tsx never closes");
    return src.slice(at, end);
  };
  const PASSES = /\btemplate\s*=\s*\{\s*template\s*\}/;
  if (!PASSES.test(mount(panel)))
    fail(
      "components/DocumentPanel.tsx: <ResumeView> is not given `template={template}`, so the page " +
        "the user edits on renders as `classic` whatever the picker, the PDF preview, the ATS " +
        "x-ray and the Download button are using. Pass it — the prop is optional, so nothing else " +
        "will tell you.",
    );

  // (b) …and the view has somewhere to put it, from the ONE mirror. A palette
  // hand-copied back into this file is how the three previews drifted apart in
  // the first place (check 6's single-definition rule, applied to colours).
  const props = topLevelKeys(blockAfter(view, "interface Props", "ResumeView Props"));
  if (props.length < 8) throw new Error(`parsed only ${props.length} ResumeView props`);
  if (!props.includes("template"))
    fail("components/ResumeView.tsx: Props declares no `template`, so the document cannot honour one.");
  if (!/from\s+"\.\.\/lib\/templateSpecs"/.test(view) || !view.includes("TEMPLATE_SPECS"))
    fail(
      "components/ResumeView.tsx does not read TEMPLATE_SPECS from lib/templateSpecs — the document " +
        "would be drawing from something check 23 does not compare against templates.py.",
    );
  const OWN_PALETTE = /\b[A-Za-z_$][\w$]*\s*:\s*"#[0-9a-fA-F]{3,8}"/;
  if (OWN_PALETTE.test(view))
    fail(
      "components/ResumeView.tsx hard-codes a colour as a `field: \"#hex\"` pair. Every colour on " +
        "the document comes from lib/templateSpecs (check 23 pins that against templates.py); a " +
        "local one is a fourth hand-copy waiting to drift.",
    );

  // (c) the abstention. The page reproduces the template but NOT the embedded
  // typeface and NOT `layout="sidebar"` (which sections land in the rail is a
  // reportlab measurement with a demote pass, so a DOM guess would show
  // sections the real file moved out). Check 8 only proves en and he agree WITH
  // EACH OTHER, so a note dropped from both files turns the preview back into
  // an unqualified claim in both languages at once.
  for (const loc of ["en", "he"]) {
    const tailor = JSON.parse(read(`locales/${loc}/tailor.json`));
    for (const key of ["doc.screen.note", "doc.screen.icons", "doc.screen.twoColumn"]) {
      if (!resolvesIn(tailor, key))
        fail(
          `locales/${loc}/tailor.json is missing "${key}" — the document would claim to be the ` +
            "file without naming what it cannot reproduce.",
        );
    }
  }

  // Both directions, on the real matchers: strip the prop out of a copy of the
  // source and the check must fire; a detector that cannot match its own defect
  // shape passes for ever.
  if (PASSES.test(mount(panel.replace(/\btemplate=\{template\}/, ""))))
    fail("check 24 cannot see a <ResumeView> mount that was never given a template");
  if (!PASSES.test('<ResumeView resume={r} template={template} surface="sheet" />'))
    fail("check 24 does not recognise a mount that DOES pass the template");
  if (!OWN_PALETTE.test('const T = { accent: "#1F3A5F" };'))
    fail("check 24 cannot detect a hand-copied palette");
  if (OWN_PALETTE.test('mixed("#FFFFFF", spec.accent, 0.12)'))
    fail("check 24 fires on a colour that is an ARGUMENT, not a table entry");
} catch (e) {
  fail(`document-template check could not run: ${e.message}`);
}

// ---- 25. a new item arrives EMPTY (EXECUTED, not parsed) ----------------- //
// The foot-of-paper add control wrote English placeholder text into the user's
// own résumé. Three of the seven rows — skill, certification, language — are
// addressed by their VALUE (`@skills.python` IS the skill), so an empty one has
// no path at all: `dkey("")` is `""` and `RE_KEYED` needs a character after the
// dot. `insertBlock` answered that by inventing a key it could use, appending
// the literal strings "New skill" / "New certification" / "New language".
//
// That is a fabricated claim on the document the user is about to send. It was
// committed to the store by `applyBlockEdit` on the same tick, so it rendered
// as a chip, went into the DOCX and the PDF, and reached the tracker row — with
// no Save and no confirmation anywhere. `check_fabrication` cannot see it: the
// ledger is built FROM the master, so the app's own truthfulness guard
// certifies the invented string clean. And it was never translated, so a Hebrew
// CV grew English text. CLAUDE.md states the opposite as an invariant in two
// places ("A new item arrives empty, never placeholder-filled" and "a
// placeholder rendered as text is committable").
//
// EXECUTED rather than parsed, check 17's mechanism for check 17's reason: the
// property is about what ends up in the MODEL, and reading the source cannot
// tell an honest insert from one that writes a string somewhere the reader is
// not looking. So the shipped module is bundled and driven, and the assertion
// is made on the résumé that comes back rather than on the code that made it.
//
// FOUR PROPERTIES, and each is a different way this could regress:
//
//  (a) THE KIND LISTS PARTITION `INSERT_KINDS`. Every one of the seven rows is
//      covered by exactly one of the two halves. Without this, "make the check
//      pass" is satisfied by quietly dropping a kind out of both lists — the
//      row keeps rendering, and nothing below ever looks at it.
//  (b) AN ENTRY IS BORN BLANK, measured over the WHOLE MODEL, not over the
//      fields this check happens to know about. Every string in the résumé
//      before and after the insert has to be the same multiset of non-empty
//      values, so a placeholder in ANY field of ANY entry kind — including a
//      field added years from now — fires this.
//  (c) A KEYED KIND WRITES THE USER'S TEXT AND NOTHING ELSE. Blank in, nothing
//      out (not an empty item either: both renderers draw a bullet glyph for a
//      blank list item and a chip for a blank skill, which is why
//      `BlockDraft.removable` exists). Typed in, and the ONLY non-empty string
//      anywhere in the résumé is the one the user typed.
//  (d) EVERY PATH THESE RETURN RESOLVES. This is the trap the placeholder
//      existed to avoid, so it is the one a fix is most likely to fall into:
//      inserting `""` instead makes the path `@skills.`, `readBlock` returns
//      null, the caller focuses nothing and the sheet opens empty. An
//      unaddressable blank is a different bug, not a fix.
try {
  const esbuild = createRequire(import.meta.url)("esbuild");
  const built = esbuild.buildSync({
    stdin: {
      contents:
        `export { INSERT_KINDS, NAMED_INSERT_KINDS, isNamedInsert, insertBlock, insertNamed, ` +
        `readBlock, removeBlock } from "./lib/resumeBlocks";\n`,
      resolveDir: SRC,
      sourcefile: "check-mirrors-insert-probe.ts",
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    target: "node18",
    logLevel: "silent",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", built.outputFiles[0].text)(
    mod,
    mod.exports,
    createRequire(import.meta.url),
  );
  const { INSERT_KINDS, NAMED_INSERT_KINDS, isNamedInsert, insertBlock, insertNamed, readBlock, removeBlock } =
    mod.exports;
  for (const [name, fn] of Object.entries({ isNamedInsert, insertBlock, insertNamed, readBlock, removeBlock })) {
    if (typeof fn !== "function") throw new Error(`the bundle did not export ${name}`);
  }
  if (!Array.isArray(INSERT_KINDS) || INSERT_KINDS.length < 7)
    throw new Error(`INSERT_KINDS came back as ${INSERT_KINDS?.length} entries`);
  if (!Array.isArray(NAMED_INSERT_KINDS) || NAMED_INSERT_KINDS.length < 3)
    throw new Error(`NAMED_INSERT_KINDS came back as ${NAMED_INSERT_KINDS?.length} entries`);

  // (a) the partition, off the module's own predicate rather than a second copy
  // of the rule — `isNamedInsert` is what the view branches on, so this cannot
  // certify a split the control does not use.
  const named = INSERT_KINDS.filter((k) => isNamedInsert(k));
  const entries = INSERT_KINDS.filter((k) => !isNamedInsert(k));
  if (named.length !== NAMED_INSERT_KINDS.length || named.some((k) => !NAMED_INSERT_KINDS.includes(k)))
    throw new Error(
      `isNamedInsert and NAMED_INSERT_KINDS disagree (${named.join("/")} vs ${NAMED_INSERT_KINDS.join("/")}) — ` +
        "the add control and this check would be looking at different rows",
    );
  if (entries.length + named.length !== INSERT_KINDS.length || entries.length < 4)
    throw new Error(`the kind split does not cover INSERT_KINDS (${entries.length} + ${named.length})`);

  /** Every string anywhere in the model, non-empty only, sorted. */
  const textOf = (v, out = []) => {
    if (typeof v === "string") {
      if (v.trim()) out.push(v.trim());
    } else if (Array.isArray(v)) for (const x of v) textOf(x, out);
    else if (v && typeof v === "object") for (const x of Object.values(v)) textOf(x, out);
    return out.sort();
  };
  const BLANK = {
    contact: { name: "", email: "", phone: "", location: "", linkedin: "", website: "" },
    headline: "",
    summary: "",
    skills: [],
    skill_groups: [],
    experience: [],
    education: [],
    projects: [],
    certifications: [],
    languages: [],
    military_service: [],
  };
  // The premise: a résumé with nothing in it says nothing. If this ever stops
  // holding, every comparison below is measuring the fixture, not the insert.
  if (textOf(BLANK).length !== 0) throw new Error("the blank fixture is not blank — this check's premise is gone");

  // (b) an entry is born blank, and (d) its path resolves.
  for (const kind of entries) {
    const res = insertBlock(BLANK, kind);
    if (!res.ok) throw new Error(`insertBlock("${kind}") failed outright`);
    const draft = readBlock(res.resume, res.path);
    if (!draft)
      fail(
        `lib/resumeBlocks.ts: insertBlock("${kind}") returned \`${res.path}\`, which readBlock cannot ` +
          "resolve. The caller focuses that path and opens its editor, so the user taps Add and gets " +
          "a block that is on the paper and cannot be typed into.",
      );
    const said = textOf(res.resume);
    if (said.length) {
      fail(
        `lib/resumeBlocks.ts: insertBlock("${kind}") put ${said.map((s) => `"${s}"`).join(", ")} into the ` +
          "résumé. A new item must arrive EMPTY — a placeholder is a fabricated claim the moment it " +
          "reaches a renderer, it is committed to the store with no Save, it is in the download, and " +
          "check_fabrication cannot flag it because the ledger is built FROM the master.",
      );
    }
  }

  // (c) a keyed kind writes the user's text and nothing else, and (d) again.
  const MINE = "Kubernetes";
  for (const kind of named) {
    for (const blank of ["", "   "]) {
      const res = insertNamed(BLANK, kind, blank);
      // Either refusal shape is fine; what may not happen is a write.
      const after = res && res.ok ? textOf(res.resume) : [];
      if (after.length)
        fail(
          `lib/resumeBlocks.ts: insertNamed("${kind}", ${JSON.stringify(blank)}) wrote ` +
            `${after.map((s) => `"${s}"`).join(", ")} to the résumé. Nothing typed means nothing added — ` +
            "an add the user abandons must cost the document nothing.",
        );
    }
    const res = insertNamed(BLANK, kind, MINE);
    if (!res.ok) throw new Error(`insertNamed("${kind}", "${MINE}") refused a perfectly good word`);
    const said = textOf(res.resume);
    const minted = said.filter((s) => s !== MINE);
    if (minted.length)
      fail(
        `lib/resumeBlocks.ts: insertNamed("${kind}") also wrote ${minted.map((s) => `"${s}"`).join(", ")}, ` +
          "which the user did not type. The only string a keyed add may put on the CV is the one it " +
          "was handed — anything else is a claim invented on the user's behalf, in English, on a " +
          "résumé that may be Hebrew.",
      );
    if (!said.includes(MINE))
      fail(`lib/resumeBlocks.ts: insertNamed("${kind}") did not store the text it was given.`);
    const draft = readBlock(res.resume, res.path);
    if (!draft)
      fail(
        `lib/resumeBlocks.ts: insertNamed("${kind}") returned \`${res.path}\`, which readBlock cannot ` +
          "resolve — so the chip the user just created cannot be edited or removed.",
      );
    // A duplicate is not an edit: the SAME object comes back, which is how the
    // caller keeps it off the undo stack (`insertSkill`'s documented contract).
    const again = insertNamed(res.resume, kind, MINE);
    if (!again.ok || again.resume !== res.resume)
      fail(
        `lib/resumeBlocks.ts: adding "${MINE}" twice as a ${kind} did not return the SAME résumé object, ` +
          "so a duplicate would burn an undo slot and the caller cannot tell 'already there' from 'added'.",
      );
  }

  // The other direction, on the real assertions: the defect this check was
  // written for, reproduced. A detector that cannot match its own defect shape
  // passes for ever.
  const placebo = { ...BLANK, skills: ["New skill"] };
  if (!textOf(placebo).includes("New skill"))
    fail("check 25's text scraper cannot see a placeholder that WAS written into the résumé");
  if (textOf({ ...BLANK, experience: [{ company: "", title: "", bullets: [] }] }).length)
    fail("check 25's text scraper reports content in a genuinely blank entry — it would fire on correct code");
} catch (e) {
  fail(`empty-insert check could not run: ${e.message}`);
}

// --------------------------------------------------------------------------- //
// `backend/app/core/resume_review.py`, read as a LITERAL. ONE loader and ONE
// tuple parser, shared by checks 26 and 27.
//
// PURE NODE, no interpreter, on check 23's terms and for check 23's reason:
// check-mirrors runs FIRST in `npm run build` and on every Vercel CI build,
// where there is no Python venv — so shelling out to the interpreter would be a
// check that cannot run in CI, i.e. one that has stopped firing, which is the
// 21.7 failure mode this whole file exists for.
//
// DEGRADES LOUDLY, and only on ENOENT. `vercel.json` roots the frontend service
// at `frontend/`, so `../backend` may not be in that build's context; every
// other failure — a permissions error, a parse that comes up short — is a red
// build. GitHub Actions checks the whole repo out and runs `npm run build` from
// frontend/ on every push and PR, so both comparisons have a home that does not
// depend on how Vercel packages a service. The skip is remembered so the final
// summary line admits it too: a warning printed above a bare "mirrors ok" is a
// warning somebody reads as noise.
//
// ONE loader rather than one per check, for check 6's reason: two readers of the
// same file are free to disagree about it while both stay green. It is called
// lazily so a missing file lands in a check's own try/catch, and a non-ENOENT
// failure re-throws there as a loud `fail`.
const RESUME_REVIEW_PY = path.join(HERE, "..", "..", "backend", "app", "core", "resume_review.py");
let reviewSkip = null;
let reviewSrcCache; // undefined = not attempted yet, null = ENOENT
function reviewSource() {
  if (reviewSrcCache !== undefined) return reviewSrcCache;
  try {
    reviewSrcCache = fs.readFileSync(RESUME_REVIEW_PY, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    reviewSrcCache = null;
    reviewSkip = `${RESUME_REVIEW_PY} not readable`;
    console.warn(
      `\n  ! checks 26 + 27 DEGRADED: ${RESUME_REVIEW_PY} is not readable from this build, so the\n` +
        `    review's path grammar was NOT compared against lib/resumeBlocks.ts and its check ids\n` +
        `    were NOT resolved against either locale. The frontend halves — the BLOCK_PATTERNS\n` +
        `    floor and ReviewPanel's own call shape — still ran.\n` +
        `    This is expected only where the frontend is built without the repo around it;\n` +
        `    CI (.github/workflows/ci.yml) checks the whole repo out, so both run there.\n`,
    );
  }
  return reviewSrcCache;
}

/**
 * The entries of a `NAME: tuple[str, ...] = (` literal in resume_review.py,
 * written one quoted entry per line.
 *
 * Deliberately a LINE grammar rather than a bracket matcher plus a regex sweep.
 * A `#` comment inside the tuple can hold a parenthesis AND a quoted string, so
 * a balanced scan would need the whole Python-string-aware decommenter check 23
 * carries, and a bare `matchAll(/"([^"]+)"/g)` over the slice would happily
 * scrape a shape out of a comment ABOUT a shape — which is the 21.7 shape: a
 * mirror comparing one side against a sentence.
 *
 * Every line inside is classified as blank, comment, or exactly one entry, and
 * anything else THROWS naming the line it choked on. So a reformat that packs
 * two entries onto one line is a red build carrying an instruction, never a
 * silently short list that compares equal by accident.
 */
function pyTuple(src, name) {
  const open = new RegExp(`^${name}\\b[^=\\n]*=\\s*\\(\\s*$`, "m").exec(src);
  if (!open)
    throw new Error(`resume_review.py has no \`${name} … = (\` opening a one-entry-per-line tuple`);
  const items = [];
  for (const raw of src.slice(open.index + open[0].length).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === ")") return items;
    const m = /^"([^"]*)"\s*,?\s*(?:#.*)?$/.exec(line);
    if (!m)
      throw new Error(
        `resume_review.py: cannot read \`${line}\` inside ${name} — this parser wants exactly one ` +
          "quoted entry per line (see check 26 on why it is a line grammar, not a bracket matcher)",
      );
    items.push(m[1]);
  }
  throw new Error(`resume_review.py: ${name} is never closed by a \`)\` on its own line`);
}

// ---- 26. the block-path grammar is ONE grammar --------------------------- //
// `POST /tools/review` answers with findings whose `path` is a BLOCK PATH, and
// the two halves of that contract are written in different languages: Python
// EMITS the path (`resume_review.PATH_SHAPES`) and TypeScript RESOLVES it
// (`readBlock`, whose grammar is `BLOCK_PATTERNS`). The grammar is shared state.
//
// A shape only Python has is A REVIEW ROW THAT JUMPS NOWHERE. `ReviewPanel`
// computes `anchored = !!f.path && !!readBlock(resume, f.path)` and renders an
// unresolvable finding as a plain `<div>` — no Crosshair, not tappable — so the
// user is told which bullet is too long and given no way to reach it, silently,
// on the one surface whose entire promise is that it points at the paper. A
// shape only TypeScript has is the same defect reversed: a block the document
// can edit that the review can never talk about.
//
// Neither compiler can see it: a path is a string on both sides, so `tsc` is
// quiet and so is anything pointed at the Python.
//
// SET equality, and ORDER deliberately NOT asserted. Both lists' comments claim
// "in order" and that is worth keeping, because it is what lets the two be read
// side by side — but nothing behaves differently if one is permuted, and a check
// that fires on a permutation is a guard firing on legitimate input. (Contrast
// check 23's TEMPLATE_IDS, where the order IS the display order, so a
// permutation really does show the same eleven templates two different ways.)
//
// BLOCK_PATTERNS is extracted with check 7's two lines, character for character,
// and that sameness is the point rather than laziness: two different readers of
// one list are free to disagree about it while both stay green, which is the
// very drift this check exists to prevent.
//
// THE `dkey` HALF is the other thing that can break every keyed finding at once,
// and it breaks them QUIETLY. A keyed path resolves by VALUE, not by index —
// `readBlock` matches `dkey(value) === key` — so `@skills.<verbatim text>`,
// `@cert.*` and `@lang.*` resolve at all only because both sides normalise
// identically. `dkey` has exactly ONE definition and check 6 pins that it stays
// in TypeScript, so resume_review.py carries a mirror; this half compares what
// the two sources actually DO instead of trusting the comment that says they
// agree. The two locale-aware folds are rejected outright, because that is the
// specific desync both doc comments already name: a Turkish-locale dotted İ.
//
// FALSE POSITIVE, named: a `dkey` rewritten in an idiom neither table knows —
// say TS `.split(/\s+/).join(" ")` where there is a `.replace(/\s+/g, " ")`
// today — goes RED although nothing has drifted. That is deliberate, and the
// message says which table to teach. The alternative is a recogniser that
// quietly stops matching one side and then reports parity between two things it
// can no longer read, which is the failure mode this file was written for. Both
// idioms that exist in this repo today are already in the tables.
try {
  const blocks = read("lib/resumeBlocks.ts");
  const pa = blocks.indexOf("export const BLOCK_PATTERNS = [");
  if (pa === -1) throw new Error("could not find BLOCK_PATTERNS in lib/resumeBlocks.ts");
  const ts = [...blocks.slice(pa, blocks.indexOf("]", pa)).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  // Floor set just under the fifteen shapes both sides carry today: adding a
  // sixteenth to both is fine, a parser that has stopped matching is not.
  if (ts.length < 14) throw new Error(`BLOCK_PATTERNS parsed as ${ts.length} entries`);

  const src = reviewSource();
  if (src !== null) {
    const py = pyTuple(src, "PATH_SHAPES");
    if (py.length < 14) throw new Error(`PATH_SHAPES parsed as ${py.length} entries`);

    // A duplicate would let set-equality pass while one side quietly carries a
    // shape twice, so membership is not the only thing compared.
    for (const [what, list] of [
      ["lib/resumeBlocks.ts's BLOCK_PATTERNS", ts],
      ["resume_review.py's PATH_SHAPES", py],
    ]) {
      const seen = new Set();
      const dupes = list.filter((p) => (seen.has(p) ? true : (seen.add(p), false)));
      if (dupes.length)
        fail(`${what} lists ${[...new Set(dupes)].map((p) => `\`${p}\``).join(", ")} more than once.`);
    }

    const onlyPy = py.filter((p) => !ts.includes(p));
    const onlyTs = ts.filter((p) => !py.includes(p));
    if (onlyPy.length)
      fail(
        `resume_review.py emits block path shape(s) ${onlyPy.map((p) => `\`${p}\``).join(", ")} that ` +
          "lib/resumeBlocks.ts cannot resolve. Add them to BLOCK_PATTERNS and to readBlock/writeBlock, " +
          "or every finding at that shape is a review row listed with no Crosshair and no way to reach " +
          "the text it is about.",
      );
    if (onlyTs.length)
      fail(
        `lib/resumeBlocks.ts resolves block path shape(s) ${onlyTs.map((p) => `\`${p}\``).join(", ")} ` +
          "that resume_review.py's PATH_SHAPES does not list. PATH_SHAPES is the review's whole " +
          "vocabulary, so that part of the document is one the review can never point at — and the " +
          "smoke check that asserts every emitted path matches a shape stays green either way.",
      );

    // --- the `dkey` mirror -------------------------------------------------
    // The normalisation each side performs, read off its own source. Two known
    // idioms per operation, because there are two in this repo: an explicit
    // trim/collapse pair, and the split-and-rejoin that does both at once
    // (Python's `" ".join(s.split())` is exactly that).
    const OPS = {
      ts: {
        empty: /(?:\?\?|\|\|)\s*""/,
        trim: /\.trim\(\)|\.split\(\s*\/\\s\+\/\s*\)/,
        collapse:
          /\.replace\(\s*\/\\s\+\/[gimsuy]*\s*,\s*" "\s*\)|\.split\(\s*\/\\s\+\/\s*\)[^\n]*\.join\(\s*" "\s*\)/,
        lower: /\.toLowerCase\(\s*\)/,
      },
      py: {
        empty: /\bor\s+""/,
        trim: /\.strip\(\s*\)|\.split\(\s*\)/,
        collapse: /" "\.join\([^\n]*\.split\(\s*\)\)|re\.sub\(\s*r?"\\s\+"\s*,\s*" "/,
        lower: /\.lower\(\s*\)/,
      },
    };
    // The fold both doc comments forbid by name, one per language.
    const POISON = { ts: /toLocaleLowerCase/, py: /\.casefold\(/ };
    const WHERE = { ts: "lib/resumeBlocks.ts", py: "resume_review.py" };
    const opsOf = (side, text) =>
      new Set(
        Object.entries(OPS[side])
          .filter(([, re]) => re.test(text))
          .map(([k]) => k),
      );

    const tsDef = /export const dkey\s*=\s*([^;]+);/.exec(blocks);
    if (!tsDef) throw new Error("lib/resumeBlocks.ts no longer defines `export const dkey = …;`");

    // The RETURN STATEMENT only, never the whole function. `dkey`'s docstring
    // NAMES `toLocaleLowerCase` and `.lower()` in prose — it is the comment that
    // warns against the locale-aware fold — so a body-wide scan would read the
    // warning as the implementation and the poison test would fire on the very
    // sentence that prevents the defect.
    const defAt = src.search(/^def dkey\b/m);
    if (defAt === -1) throw new Error("resume_review.py no longer defines `def dkey`");
    const after = src.slice(defAt);
    const tail = after.slice(after.indexOf("\n") + 1);
    const nextTop = tail.search(/^\S/m);
    const fnBody = nextTop === -1 ? tail : tail.slice(0, nextTop);
    const returns = [...fnBody.matchAll(/^[ \t]+return\s+(.+?)\s*$/gm)].map((m) => m[1]);
    if (returns.length !== 1)
      throw new Error(
        `resume_review.py: def dkey has ${returns.length} return statements and this check reads ` +
          "exactly one — a dkey with a branch is not a mirror of a one-expression arrow function",
      );

    const body = { ts: tsDef[1], py: returns[0] };
    const ops = { ts: opsOf("ts", body.ts), py: opsOf("py", body.py) };
    for (const side of ["ts", "py"]) {
      if (POISON[side].test(body[side]))
        fail(
          `${WHERE[side]}: dkey uses a locale-aware case fold. Both definitions document why it must ` +
            "not: a Turkish-locale dotted İ folds differently on the two sides, and every @skills / " +
            "@cert / @lang finding then resolves on one side and not the other.",
        );
      // Fail-loud floor, per side. Three named operations have to be VISIBLE in
      // the source; if one is not, either dkey stopped normalising or it was
      // rewritten in an idiom this check cannot read, and both are a human
      // decision rather than something to report as parity.
      for (const need of ["trim", "collapse", "lower"])
        if (!ops[side].has(need))
          throw new Error(
            `${WHERE[side]}: dkey does not visibly ${need} (\`${body[side].trim()}\`) — either it ` +
              "stopped normalising, or it uses an idiom missing from check 26's OPS table. Add the " +
              "idiom, or fix the definition; do not delete the assertion.",
          );
    }
    const drift = [...new Set([...ops.ts, ...ops.py])].filter((o) => ops.ts.has(o) !== ops.py.has(o));
    if (drift.length)
      fail(
        `dkey has drifted: {${drift.join(", ")}} happens on one side only — lib/resumeBlocks.ts does ` +
          `{${[...ops.ts].sort().join(", ")}} and resume_review.py does {${[...ops.py].sort().join(", ")}}. ` +
          "A keyed block path is matched `dkey(value) === key`, so every @skills / @cert / @lang finding " +
          "the review emits resolves to nothing on exactly the entries the two disagree about — listed, " +
          "unanchored, with no error anywhere.",
      );

    // Both directions, on the recogniser the assertions actually use: the two
    // real definitions, the alternate idiom each table claims to know, and a
    // reduced form that must NOT be read as doing more than it does. A detector
    // that cannot match its own defect shape passes for ever.
    for (const [side, probe, want] of [
      ["ts", `(s ?? "").trim().replace(/\\s+/g, " ").toLowerCase()`, ["collapse", "empty", "lower", "trim"]],
      [
        "ts",
        `(s ?? "").split(/\\s+/).filter(Boolean).join(" ").toLowerCase()`,
        ["collapse", "empty", "lower", "trim"],
      ],
      ["ts", `s.trim().toLowerCase()`, ["lower", "trim"]],
      ["py", `" ".join((s or "").split()).lower()`, ["collapse", "empty", "lower", "trim"]],
      ["py", `re.sub(r"\\s+", " ", s or "").strip().lower()`, ["collapse", "empty", "lower", "trim"]],
      ["py", `(s or "").strip().lower()`, ["empty", "lower", "trim"]],
    ]) {
      const got = [...opsOf(side, probe)].sort();
      if (got.join(",") !== want.join(","))
        fail(
          `check 26's ${side} dkey recogniser reads \`${probe}\` as {${got.join(", ")}} — it should ` +
            `read {${want.join(", ")}}, so it can no longer tell one normalisation from another.`,
        );
    }
    if (!POISON.ts.test("s.toLocaleLowerCase()") || POISON.ts.test("s.toLowerCase()"))
      fail("check 26 cannot tell toLocaleLowerCase from toLowerCase");
    if (!POISON.py.test("s.casefold()") || POISON.py.test("s.lower()"))
      fail("check 26 cannot tell casefold from lower");
  }
} catch (e) {
  fail(`block-path grammar mirror check could not run: ${e.message}`);
}

// ---- 27. every review check id has a label AND a how in both locales ----- //
// The checks 2 / 3 / 5 / 18 family, one namespace over and one language
// further: the vocabulary is declared in PYTHON. `ReviewPanel` renders
// t(`<prefix>.${f.id}.label`) as a row's title and t(`<prefix>.${f.id}.how`,
// f.args) as the whole of its advice, so an id added to `CHECK_IDS` with no copy
// renders "doc.review.checks.<id>.label" at 12px as the ONLY thing that row
// says — in Hebrew, in the primary market. `data.skipped` maps the same `.label`
// key, so a skipped id with no copy prints the raw key inside a sentence about
// what could NOT be checked, which is the one row a reader has to be able to
// read: unknown is never clean, and it cannot say so as a raw key.
//
// CHECK 8 CANNOT SEE THIS, and that is the whole reason this family exists:
// check 8 compares en against he, so it stays GREEN whenever a key is missing
// from BOTH sides — which is exactly the shape a new check id ships in. Nobody
// adds a backend id and then writes only the Hebrew half.
//
// Check 22 cannot see it either, from the other end: these are TEMPLATE literals
// with no fixed key to look up, and check 22 is scoped to literal `t("review.*")`
// / `t("edit.*")` calls for exactly that reason.
//
// The PREFIX is DERIVED from ReviewPanel.tsx, not written down here, so renaming
// the namespace moves the assertion with the code instead of quietly pointing
// this check at a subtree nothing reads any more. It is `doc.review.checks` and
// not `review.checks` because ChangeLog already owns `review.*` (check 22
// scrapes it): a collision there would have two panels sharing one subtree, and
// each would look correct on its own.
//
// FALSE POSITIVE, named: exactly ONE prefix may be in use. If a second per-id
// table is ever rendered from this file through t(`<other>.${id}.label`), this
// check THROWS rather than guesses — demanding that both `<other>` and
// `doc.review.checks` resolve for every CHECK_IDS entry would fire on legitimate
// copy that was never meant to have a twin.
try {
  const prefixesIn = (text, leaf) =>
    new Set(
      [
        ...text.matchAll(
          new RegExp("\\bt\\(\\s*`([A-Za-z][\\w.]*)\\.\\$\\{[^}]*\\}\\." + leaf + "`", "g"),
        ),
      ].map((m) => m[1]),
    );
  // The scraper, both directions, before it is trusted with the real file.
  if (![...prefixesIn("t(`a.b.${f.id}.label`)", "label")].includes("a.b"))
    fail("check 27's prefix scraper cannot read the call shape ReviewPanel writes");
  if (prefixesIn('t("a.b.label")', "label").size)
    fail(
      "check 27's prefix scraper accepts a LITERAL key as a per-id table — a literal has no id to " +
        "expand, and check 22 already covers those.",
    );

  const panel = decomment(read("components/ReviewPanel.tsx"));
  const at = { label: prefixesIn(panel, "label"), how: prefixesIn(panel, "how") };
  if (!at.label.size || !at.how.size)
    throw new Error(
      "components/ReviewPanel.tsx no longer renders both t(`<prefix>.${id}.label`) and " +
        "t(`<prefix>.${id}.how`) — this check no longer guards what it thinks it guards",
    );
  if (at.label.size !== 1 || at.how.size !== 1 || !at.label.has([...at.how][0]))
    throw new Error(
      "components/ReviewPanel.tsx renders per-id copy under more than one prefix (label: " +
        `${[...at.label].join(", ")}; how: ${[...at.how].join(", ")}) — teach check 27 which one ` +
        "carries CHECK_IDS instead of letting it guess",
    );
  const prefix = [...at.label][0];

  const src = reviewSource();
  if (src !== null) {
    const ids = pyTuple(src, "CHECK_IDS");
    // Floor well under the twenty-six ids today: a check table shrinks by one
    // when a check is deleted, and it does not shrink to two without a parser
    // having stopped matching.
    if (ids.length < 20) throw new Error(`CHECK_IDS parsed as ${ids.length} entries`);
    const seen = new Set();
    const dupes = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    if (dupes.length)
      fail(
        `resume_review.py: CHECK_IDS lists ${[...new Set(dupes)].map((i) => `\`${i}\``).join(", ")} ` +
          "twice — the passed / skipped / found partition the module accounts for on every run cannot hold.",
      );

    for (const loc of ["en", "he"]) {
      const ns = JSON.parse(read(`locales/${loc}/tailor.json`));
      const missing = [];
      for (const id of ids) {
        for (const leaf of ["label", "how"]) {
          if (!resolvesIn(ns, `${prefix}.${id}.${leaf}`)) missing.push(`${id}.${leaf}`);
        }
      }
      if (missing.length)
        fail(
          `locales/${loc}/tailor.json: ${prefix}.{${missing.join(", ")}} missing — ReviewPanel would ` +
            "render the raw key as that row's title, or as the whole of its advice. Check 8 stays " +
            "green while both locales are equally wrong.",
        );
    }
  }
} catch (e) {
  fail(`review check-id copy check could not run: ${e.message}`);
}

// ---- report --------------------------------------------------------------- //
if (problems.length) {
  console.error("\nMirror checks FAILED:\n");
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  process.exit(1);
}
console.log(
  `mirrors ok — ${sectionKeys.length} edit sections, en/he parity across all namespaces` +
    (templateSkip ? ` — but the template specs were NOT compared (${templateSkip})` : "") +
    (reviewSkip ? ` — and the review mirrors were NOT compared (${reviewSkip})` : ""),
);
