// Frontend mirror checks. Run from frontend/ (wired into `npm run build`):
//   node scripts/check-mirrors.js
//
// This repo has 5,000+ backend smoke checks and, until now, ZERO frontend
// assertions — so a whole class of defect had nothing watching it. Every check
// below is pinned to a bug that actually shipped:
//
//   1. `mergeResumes` (resumeDiff.ts) rebuilds the resume field by field. When
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
// Line endings are normalised on read: git stores LF, but a Windows checkout with
// core.autocrlf writes CRLF, and a planted string written with "\n" then never
// matched (checks 58, 59, 68, 73, 77, 78 and 89 failed on such a checkout, green
// in CI). What a check reads is the text, not the platform's line terminator.
const read = (p) => fs.readFileSync(path.join(SRC, p), "utf8").replace(/\r\n/g, "\n");

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
        `resume the user downloads. Add ${missing.length > 1 ? "them" : "it"} to the returned object.`,
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
//
// It renders t(`groups.${cls}.count`, { count }) beside it, for EVERY class,
// and `groups.curation` carried only a title until 2026-09-23 (PLAN 31.1/2): a
// whole role, degree or service left out, the one curation the review makes
// loud, printed "groups.curation.count" at 390 px. Check 8 stayed green because
// both locales missed it together. The count needs its full plural set: English
// one/other, Hebrew one/two/other (a missing `_two` prints the raw key for 2).
try {
  const src = read("lib/editGroups.ts");
  const at = src.indexOf("export type EditClass =");
  if (at === -1) throw new Error("could not find the EditClass union");
  const classes = [...src.slice(at, src.indexOf(";", at)).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (!classes.length) throw new Error("EditClass union parsed as empty");
  const log = decomment(read("components/ChangeLog.tsx"));
  if (!/t\(`groups\.\$\{g\.cls\}\.count`/.test(log))
    throw new Error("could not find ChangeLog's t(`groups.${g.cls}.count`) call — if the count moved, move this check with it");
  const forms = { en: ["one", "other"], he: ["one", "two", "other"] };

  for (const loc of ["en", "he"]) {
    const groups = JSON.parse(read(`locales/${loc}/tailor.json`)).groups || {};
    const missing = classes.filter((c) => !groups[c]?.title);
    if (missing.length) {
      fail(
        `locales/${loc}/tailor.json: groups.{${missing.join(", ")}}.title missing — ` +
          `ChangeLog renders t("groups.<class>.title"), so the raw key hits the screen.`,
      );
    }
    for (const c of classes) {
      const gaps = forms[loc].filter((f) => typeof groups[c]?.[`count_${f}`] !== "string");
      if (gaps.length)
        fail(
          `locales/${loc}/tailor.json: groups.${c}.count is missing ${gaps.map((f) => `_${f}`).join(", ")} — ` +
            `ChangeLog renders t(\`groups.\${g.cls}.count\`) for every class, so a group of that size prints the raw key.`,
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

/**
 * App.tsx's `<Route path>` list, read with the shape every route keeps: `path`
 * as its FIRST attribute, which App.tsx asks for beside the account routes.
 *
 * ONE definition, shared by checks 9 and 32(a), for `resolvesIn`'s reason: both
 * ask "does the app route this path?", and two copies of the reader or of the
 * matcher would be free to disagree about the same path while both stayed
 * green. `read` runs inside each check's own try, so a missing file is a loud
 * `fail`, not a crash at import time.
 */
function appRoutes() {
  const app = read("App.tsx");
  const routes = [...app.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]);
  if (routes.length < 15) throw new Error(`parsed only ${routes.length} <Route path=> entries in App.tsx`);
  if (!routes.includes("*")) throw new Error("App.tsx has no catch-all — this check's premise is gone");
  return { app, routes };
}

/** A declared path as an exact matcher, where a `:param` stands for one segment. */
const routePattern = (r) => new RegExp(`^${r.replace(/:[^/]+/g, "[^/]+")}$`);

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
  const { routes } = appRoutes();
  const declared = routes.filter((r) => r !== "*").map(routePattern);

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
            ? "A keyword the backend reports as covered would show a resume/JD count of zero beside it."
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
// a 287px dropzone, so the master resume could not be changed at all, and the
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

// ---- 12. a replaced master resume reaches the document -------------------- //
// The master resume is cached in TWO module-level bindings: `useMasterResume`'s
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
// describing a resume that no longer exists?"), so a field added to one and
// forgotten in the other is the next `mergeResumes` bug in a new costume.
try {
  const store = read("state/tailorStore.ts");
  const hook = read("hooks/useMasterResume.ts");

  if (!/export function adoptMaster\s*\(/.test(store)) {
    fail(
      "state/tailorStore.ts: no exported `adoptMaster` — the document surface has " +
        "no way to be told the stored master resume was replaced.",
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
      "hooks/useMasterResume.ts: setMaster does not call adoptMaster. A resume " +
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
        "set from the resume it just replaced, while applyBlockEdit clears " +
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
  fail(`master-resume adoption check could not run: ${e.message}`);
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
// resume, for the PREVIOUS job, and the green toast says it worked.
//
// DERIVED from `adoptMaster`, never restated. Both functions answer the same
// question — "what on screen now describes something that no longer exists?" —
// and the only difference is that a resume swap also replaces the master while
// a tailor replaces only the review. So the expected list is adoptMaster's
// minus the six master-identity keys, and a field added to adoptMaster forces a
// decision here instead of quietly going stale. Same shape as check 12; `tsc`
// sees none of it, because every key is correctly typed and correctly optional.
try {
  // The keys that identify the MASTER RESUME. `adoptMaster` clears them
  // because the file itself was replaced; `startTailor` must NOT, because
  // tailoring never writes the master (Phase 22: master ⇒ edit, tailored ⇒
  // review). Everything else adoptMaster clears is a statement about a finished
  // run, and startTailor owes it exactly the same treatment. The last four are
  // the master's autosave (PLAN 31.6/2): the version and slot the document was
  // made from, and how its save stands. A tailor that reset them would make the
  // next edit's save name no version, or forget a refusal still unanswered.
  const MASTER_ONLY = [
    "resume", "savedResume", "ledger", "masterLabel", "editUndo", "editError",
    "masterStamp", "masterSlot", "masterSave", "masterConflict",
  ];
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
        "tailored resume, for the previous job.",
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
// always misses, and re-reads the posting with `analyzeJD`. That second reading
// is a different JD, and the server keys the tailor a fit check includes by the
// JD that check returned (Phase 30 / B4.4), so the tailor uses a second use while
// the overlay's note says "tailoring this job afterwards is included".
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
        "just cleared and analyses the posting the fit check already read a second " +
        "time. The tailor then sends a different JD from the one that check's included " +
        "tailor is keyed by, and uses a second use while the overlay says it is included.",
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
// `mergeForReview` rebuilds the effective resume on every accept and decline,
// and a rejected removal is spliced back at `k = Math.min(oi, list.length)` —
// so every later entry in that section shifts. With a tailored resume that
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
  // re-runs this on every render of a merged resume.
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
//     DraftRestoreBar offer to restore a tailored CV as the user's real resume.
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
        "CV as the real resume) and must never reach applyBlockEdit (which nulls `result` and " +
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
        "tailored CV over the master (a tailored resume carries no skill_groups), and touching " +
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
// 23.7 split `editable` into `isMaster` (this document IS the saved resume) and
// `canEditDoc` (there is a document at all). Typing on the paper moved to the
// second; ADDING must stay on the first, and the reason is the fabrication
// guard rather than caution: it ran against `result.tailored_resume`, so a
// claim typed in afterwards carries no verdict at all while ScoreCard goes on
// rendering `result.fabrication_flags` beside it. An added block also exists in
// neither the original nor the tailored resume, so it has no source anchor to
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
// resume, so the dialog would ask for that decision under the string
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
    // The tailored draft's summary line over the paper (PLAN 31.3/3): every
    // word of it is a `review.summary.*` key and it was in no list.
    ["components/DraftSummary.tsx", 6],
  ];
  // `[,)]` for check 9's reason: a counted or interpolated label —
  // t("edit.yours", { count }) — is exactly the kind most likely to be renamed,
  // and a `)`-only matcher is blind to it.
  // `doc\.review` before `review` in the alternation would still match the
  // shorter branch first on a `doc.review.*` key, so the prefix is spelled out
  // as its own branch and the regex is anchored by `t("`.
  // `doc.changes` since PLAN 31.3/3: the drawer's second pane names itself
  // with it, in DocumentPanel, which this check already reads.
  const CALL = /\bt\("((?:doc\.review|doc\.changes|review|edit)\.[^"]+)"\s*[,)]/g;
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
  if (ids.length < 12) throw new Error(`TEMPLATE_SPECS carries only ${ids.length} templates`);
  if (Object.keys(TEMPLATE_SPECS[ids[0]]).length < 45)
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
  if (picker.length < 12) throw new Error(`parsed only ${picker.length} RESUME_TEMPLATES ids`);
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

  // --- (f2) both locales carry every LABEL SET a template prints ----------
  // `TemplateSpec.label_set` chooses which table of section names a template
  // renders, and the document on /app has to print the same ones the file does.
  // Check 8 cannot see a gap here: a key missing from BOTH locales leaves them
  // in perfect parity with each other, and the heading renders as
  // `sections.full.skills` at 12px, in Hebrew.
  //
  // The eight keys are the eight sections `section_order` emits. `militaryService`
  // is camelCase here and `military` in Python — the only name that differs, and
  // it differs because this side reads i18next keys and that side reads
  // `labels.py`. The floor below is what stops a typo silently checking nothing.
  const SECTION_KEYS = [
    "summary",
    "skills",
    "experience",
    "projects",
    "education",
    "militaryService",
    "certifications",
    "languages",
  ];
  const labelSets = [...new Set(ids.map((id) => TEMPLATE_SPECS[id].labelSet))];
  if (!labelSets.includes("short") || labelSets.length < 2)
    throw new Error(
      `lib/templateSpecs.ts declares label sets [${labelSets.join(", ")}] — this check is ` +
        "pointed at a field that has stopped having more than one value",
    );
  for (const loc of ["en", "he"]) {
    const tailor = JSON.parse(read(`locales/${loc}/tailor.json`));
    for (const key of SECTION_KEYS) {
      if (!resolvesIn(tailor, `sections.${key}`))
        throw new Error(
          `locales/${loc}/tailor.json has no "sections.${key}" — this check's key list has ` +
            "stopped matching the sections the document renders",
        );
      for (const set of labelSets) {
        if (set === "short") continue;
        if (!resolvesIn(tailor, `sections.${set}.${key}`))
          fail(
            `locales/${loc}/tailor.json is missing "sections.${set}.${key}". A template ` +
              `declaring labelSet="${set}" would render that raw key as its section heading, ` +
              "and check 8 stays green because en and he are missing it together.",
          );
      }
    }
  }

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

    const py = decommentPy(raw);
    // Two sentinels rather than `undefined`, so "templates.py gives this no
    // default" and "this parser cannot read that literal" stay distinguishable
    // from "the value is absent" all the way to the comparison.
    const NO_DEFAULT = Symbol("no default");
    const UNREAD = Symbol("unread literal");
    // templates.py's own module-level numeric constants — `A4_W, A4_H = ...` and
    // `LETTER_W, LETTER_H = ...`. Parsed rather than restated: page size became
    // mirrorable when `standard` arrived on US Letter, and a hard-coded copy of
    // 595.276 here would be a second declaration of the very thing this check
    // exists to compare. Anything else stays UNREAD and throws if mirrored.
    const CONSTS = new Map();
    for (const m of py.matchAll(/^([A-Z][A-Z0-9_]*(?:\s*,\s*[A-Z][A-Z0-9_]*)*)\s*=\s*(.+)$/gm)) {
      const names = m[1].split(",").map((n) => n.trim());
      const values = m[2].split(",").map((v) => v.trim());
      if (names.length !== values.length) continue;
      names.forEach((n, i) => {
        if (/^-?\d+(?:\.\d+)?$/.test(values[i])) CONSTS.set(n, Number(values[i]));
      });
    }
    const literal = (text) => {
      const s = text.trim();
      if (/^"[^"]*"$/.test(s) || /^'[^']*'$/.test(s)) return s.slice(1, -1);
      if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
      if (CONSTS.has(s)) return CONSTS.get(s);
      if (s === "True") return true;
      if (s === "False") return false;
      if (s.startsWith("(") && s.endsWith(")")) {
        const items = splitTop(s.slice(1, -1)).map(literal);
        return items.some((v) => v === UNREAD) ? UNREAD : items;
      }
      return UNREAD; // `A4_W`, and anything else this parser deliberately does not read
    };

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
    if (fields.size < 55 || defaults < 45)
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
    if (pyIds.length < 12)
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
      pageW: "page_w_pt",
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
    // "Helvetica" names no font FILE: it resolves through the base-14 fallback,
    // which is how `standard` gets Arial/Liberation Sans metrics. Still a sans,
    // and still a face this screen cannot load — the mirror reproduces the
    // CATEGORY for it exactly as it does for the two bundled families.
    const SANS_FAMILIES = new Set(["Lato", "Helvetica"]);
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
// own resume. Three of the seven rows — skill, certification, language — are
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
// is made on the resume that comes back rather than on the code that made it.
//
// FOUR PROPERTIES, and each is a different way this could regress:
//
//  (a) THE KIND LISTS PARTITION `INSERT_KINDS`. Every one of the seven rows is
//      covered by exactly one of the two halves. Without this, "make the check
//      pass" is satisfied by quietly dropping a kind out of both lists — the
//      row keeps rendering, and nothing below ever looks at it.
//  (b) AN ENTRY IS BORN BLANK, measured over the WHOLE MODEL, not over the
//      fields this check happens to know about. Every string in the resume
//      before and after the insert has to be the same multiset of non-empty
//      values, so a placeholder in ANY field of ANY entry kind — including a
//      field added years from now — fires this.
//  (c) A KEYED KIND WRITES THE USER'S TEXT AND NOTHING ELSE. Blank in, nothing
//      out (not an empty item either: both renderers draw a bullet glyph for a
//      blank list item and a chip for a blank skill, which is why
//      `BlockDraft.removable` exists). Typed in, and the ONLY non-empty string
//      anywhere in the resume is the one the user typed.
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
  // The premise: a resume with nothing in it says nothing. If this ever stops
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
          "resume. A new item must arrive EMPTY — a placeholder is a fabricated claim the moment it " +
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
            `${after.map((s) => `"${s}"`).join(", ")} to the resume. Nothing typed means nothing added — ` +
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
          "resume that may be Hebrew.",
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
        `lib/resumeBlocks.ts: adding "${MINE}" twice as a ${kind} did not return the SAME resume object, ` +
          "so a duplicate would burn an undo slot and the caller cannot tell 'already there' from 'added'.",
      );
  }

  // The other direction, on the real assertions: the defect this check was
  // written for, reproduced. A detector that cannot match its own defect shape
  // passes for ever.
  const placebo = { ...BLANK, skills: ["New skill"] };
  if (!textOf(placebo).includes("New skill"))
    fail("check 25's text scraper cannot see a placeholder that WAS written into the resume");
  if (textOf({ ...BLANK, experience: [{ company: "", title: "", bullets: [] }] }).length)
    fail("check 25's text scraper reports content in a genuinely blank entry — it would fire on correct code");
} catch (e) {
  fail(`empty-insert check could not run: ${e.message}`);
}

// --------------------------------------------------------------------------- //
// The backend's Python source, read as a LITERAL. ONE loader and ONE tuple
// parser, shared by checks 26, 27, 32(b) and 32(j).
//
// PURE NODE, no interpreter, on check 23's terms and for check 23's reason:
// check-mirrors runs FIRST in `npm run build` and on every Vercel CI build,
// where there is no Python venv — so shelling out to the interpreter would be a
// check that cannot run in CI, i.e. one that has stopped firing, which is the
// 21.7 failure mode this whole file exists for.
//
// DEGRADES LOUDLY, and only when `backend/` ITSELF is absent. `vercel.json`
// roots the frontend service at `frontend/`, so `../backend` may not be in that
// build's context, and that is the one legitimate reason not to read a file. A
// `backend/` that is here WITHOUT the file is a red build: that is a file that
// moved or was renamed, and a check that skips on it has quietly stopped
// guarding anything. (Checks 26 and 27 used to skip on the file's own ENOENT;
// Phase 30's 32(b) asked for the stricter rule, and one loader has one rule.)
// Every other failure, a permissions error or a parse that comes up short, is
// red too. GitHub Actions checks the whole repo out and runs `npm run build`
// from frontend/ on every push and PR, so the comparisons have a home that does
// not depend on how Vercel packages a service. A skip is remembered so the final
// summary line admits it: a warning printed above a bare "mirrors ok" is a
// warning somebody reads as noise.
//
// ONE loader rather than one per check, for check 6's reason: two readers of the
// same file are free to disagree about it while both stay green. It is called
// lazily, so a missing file lands in the calling check's own try/catch as a
// loud `fail`.
const BACKEND_DIR = path.join(HERE, "..", "..", "backend");
const pySkips = new Set(); // the checks that read no Python because backend/ is absent
const pyCache = new Map(); // path under backend/ -> its source
function pySource(relPath, who) {
  if (!fs.existsSync(BACKEND_DIR)) {
    if (!pySkips.has(who))
      console.warn(
        `\n  ! ${who} DEGRADED: ${BACKEND_DIR} is not in this build, so backend/${relPath} was NOT\n` +
          `    read and its Python half did not run. Its frontend half still ran.\n` +
          `    This is expected only where the frontend is built without the repo around it;\n` +
          `    CI (.github/workflows/ci.yml) checks the whole repo out, so it runs there.\n`,
      );
    pySkips.add(who);
    return null;
  }
  if (pyCache.has(relPath)) return pyCache.get(relPath);
  let src;
  try {
    src = fs.readFileSync(path.join(BACKEND_DIR, ...relPath.split("/")), "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    throw new Error(
      `backend/ is in this build but backend/${relPath} is not, so ${who} has nothing to read. ` +
        "The file moved or was renamed: point the check at its new home, do not delete the assertion",
    );
  }
  pyCache.set(relPath, src);
  return src;
}

/**
 * The entries of a `NAME … = (` tuple literal in a backend Python file, written
 * one quoted entry per line. `file` names that file in every message. The
 * opening line may end in a `#` comment (quota.py's FEATURES says there who
 * reads it); two entries may never share a line.
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
function pyTuple(src, name, file) {
  const open = new RegExp(`^${name}\\b[^=\\n]*=\\s*\\(\\s*(?:#.*)?$`, "m").exec(src);
  if (!open)
    throw new Error(`${file} has no \`${name} … = (\` opening a one-entry-per-line tuple`);
  const items = [];
  for (const raw of src.slice(open.index + open[0].length).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === ")") return items;
    const m = /^"([^"]*)"\s*,?\s*(?:#.*)?$/.exec(line);
    if (!m)
      throw new Error(
        `${file}: cannot read \`${line}\` inside ${name} — this parser wants exactly one ` +
          "quoted entry per line (see check 26 on why it is a line grammar, not a bracket matcher)",
      );
    items.push(m[1]);
  }
  throw new Error(`${file}: ${name} is never closed by a \`)\` on its own line`);
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

  const src = pySource("app/core/resume_review.py", "check 26");
  if (src !== null) {
    const py = pyTuple(src, "PATH_SHAPES", "resume_review.py");
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

  const src = pySource("app/core/resume_review.py", "check 27");
  if (src !== null) {
    const ids = pyTuple(src, "CHECK_IDS", "resume_review.py");
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

// ---- literal t() calls, by the namespace their binding names ------------- //
// ONE definition, shared by checks 28 and 29, for `resolvesIn`'s reason: two
// scrapes of different files asking the same question ("which bundle does
// this call read?") must not be free to answer it differently. Check 28 wrote
// this reader for the landing, and the account pages need exactly the same one.
//
// THE NAMESPACE IS READ OFF THE BINDING, not guessed from the key's prefix.
// A prefix table was the first attempt and it is wrong in a way this repo has
// paid for before: `footer` exists in BOTH bundles (common carries the link
// labels, marketing the nav landmark and the blurb), so the table reported a
// key that resolves perfectly as missing. The binder does know — `useTranslation()`
// is the `common` default and `useTranslation("marketing")` is not — so the
// declaration is parsed and every call is looked up in ITS OWN namespace.
const BIND = /const\s*\{\s*t(?:\s*:\s*(\w+))?\s*\}\s*=\s*useTranslation\(\s*(?:"(\w+)")?\s*\)/g;
// Literal calls only: a template literal has no fixed key to look up, and the
// two on the landing (`templates.${id}.name`, `landing.faq.q${k}`) are pinned
// elsewhere — by check 23, and by keeping every FAQ row's keys in parity.
const CALL = /\b(\w+)\(\s*"([A-Za-z][\w.]*)"\s*[,)]/g;

/** `[file, namespace, key]` for every literal translation call in `f`.
 *
 * Throws — each check's own try turns that into a loud `fail` — when the file
 * declares no binding, binds one identifier to two namespaces, or yields fewer
 * calls than its `floor`. A per-file floor, for check 22's reason: a floor on
 * the sum is not fail-loud, because the other files carry the total past it
 * while one file's call shape has gone dark.
 *
 * `source`, when given, is read instead of the file, so a check can probe this
 * reader on a fixture and still report it under a file name. */
function boundCalls(f, floor, source) {
  const src = decomment(source ?? read(f));
  // Both regexes are shared and global, and `matchAll` COPIES `lastIndex`, so a
  // `.test` or `.exec` anywhere else (check 28's binding probe leaves BIND at 47)
  // would start this read part-way into the file. No real file has a binding in
  // its first 47 characters, which is how that survived; 32(d)'s short fixture
  // does, and read no binding at all. Reset here, where the reads happen.
  BIND.lastIndex = 0;
  CALL.lastIndex = 0;
  const binders = new Map();
  for (const m of src.matchAll(BIND)) {
    const name = m[1] || "t";
    const ns = m[2] || "common";
    // One identifier, two namespaces in the same file — a second component
    // in the file binding `t` to `marketing` while the exported one binds it
    // to `common`. Nothing here can tell those calls apart, and quietly
    // picking the last declaration checks half the file against the wrong
    // bundle, so it is refused rather than guessed. Rename the second binder.
    if (binders.has(name) && binders.get(name) !== ns)
      throw new Error(
        `${f} binds \`${name}\` to both "${binders.get(name)}" and "${ns}" — ` +
          "rename one so each identifier means one namespace",
      );
    binders.set(name, ns);
  }
  if (binders.size === 0)
    throw new Error(`${f} declares no useTranslation binding — the call shape changed`);
  const here = [...src.matchAll(CALL)].filter((m) => binders.has(m[1]));
  if (here.length < floor)
    throw new Error(
      `scraped only ${here.length} literal translation calls from ${f} ` +
        `(expected at least ${floor}) — the call shape changed`,
    );
  return here.map((m) => [f, binders.get(m[1]), m[2]]);
}

// ---- a counted key is only as good as its plural set ---------------------- //
// ONE definition, shared by checks 31 and 32(d), for `resolvesIn`'s reason: two
// checks asking "can this bundle render this key for every count?" must not be
// free to answer it differently. Check 31 wrote it for the Jobs page's counted
// sentences, and the monthly-uses notes are counted the same way.
//
// The plural forms i18next asks for in each UI locale. A FIXED table, never
// `Intl.PluralRules` read at build time: the build machine's ICU is not the
// user's browser, and older CLDR gave Hebrew a `many` form that CLDR 48 (Node
// 24, ICU 78: one, two, other) no longer has, so reading the runtime would make
// a verdict depend on which Node ran the build. `_zero` is optional.
const PLURAL_FORMS = { en: ["one", "other"], he: ["one", "two", "other"] };
const PLURAL_FORM = /^(?:zero|one|two|few|many|other)$/;

/** What a page needs of one key in one locale's bundle: [] when it can render
 * the key for every count, otherwise each reason it cannot. `resolvesIn`
 * accepts a key when ANY suffixed form exists, while i18next 26 has no
 * fallback to `_other`: it tries the form the count selects, then the bare key,
 * then the fallback language. So a missing `_other` renders the raw key, and a
 * missing Hebrew `_two` renders the ENGLISH sentence on the Hebrew page, and
 * check 8 stays green on both because it compares stems. */
function keyProblems(b, key, loc, surface = "the Jobs page") {
  if (!resolvesIn(b, key))
    return [
      `is missing "${key}" — ${surface} would render the raw key. Check 8 stays green while both ` +
        "locales are equally wrong.",
    ];
  const parts = key.split(".");
  const leaf = parts.pop();
  const parent = parts.reduce((o, k) => o[k], b);
  // A plain key: i18next reads it whatever the count.
  if (parent[leaf] !== undefined) return [];
  const forms = new Set(
    Object.keys(parent)
      .filter((k) => k.startsWith(`${leaf}_`))
      .map((k) => k.slice(leaf.length + 1))
      .filter((form) => PLURAL_FORM.test(form)),
  );
  const gaps = PLURAL_FORMS[loc].filter((form) => !forms.has(form));
  return gaps.length
    ? [
        `has "${key}" without its ${gaps.map((g) => `_${g}`).join(" / ")} form — i18next has no fallback to ` +
          "_other, so that count renders in English or as the raw key. Check 8 compares stems and stays green.",
      ]
    : [];
}

/** A deep copy of bundle `b` with `key`'s `_<form>` deleted: the probe fixture
 * for a plural set that lost one form. */
function withoutForm(b, key, form) {
  const copy = JSON.parse(JSON.stringify(b));
  const parts = key.split(".");
  const leaf = parts.pop();
  delete parts.reduce((o, k) => o[k], copy)[`${leaf}_${form}`];
  return copy;
}

// ---- 28. the landing's own copy resolves in both locales ----------------- //
// The landing is the largest surface in the app whose strings were guarded by
// NOTHING. Check 8 is parity-only, so a key missing from en AND he is green;
// checks 16 and 22 are scoped to the tailor namespace; check 9 is deliberately
// scoped to AppLayout.tsx, so the landing's own header — which carries the
// whole public nav — sits outside it.
//
// This is not hypothetical. The 2026-09-06 redesign consolidated the old `faq`
// block into `landing.faq` and left `t("faq.kicker")` behind in LandingFaq, so
// the section rendered the literal string "faq.kicker" as its eyebrow, on the
// page whose entire job is the first impression. Every other check was green.
//
// Two namespaces, because the landing legitimately reads both: `marketing` for
// its own copy and `common` for the shared nav/header/footer vocabulary. The
// prefix decides which file a key is looked up in, so a key moved between
// namespaces without its call site moving fails HERE rather than at 12px in
// Hebrew.
//
// PER-FILE FLOORS, for check 22's reason: a floor on the sum is not fail-loud,
// because the other files carry the total past it while one file's call shape
// has gone dark.
try {
  const files = [
    ["pages/Landing.tsx", 1],
    ["components/landing/LandingHeader.tsx", 8],
    ["components/landing/LandingHero.tsx", 8],
    ["components/landing/TemplateStage.tsx", 6],
    ["components/landing/HowItWorks.tsx", 8],
    ["components/landing/FeatureList.tsx", 3],
    ["components/landing/ScanBand.tsx", 4],
    ["components/landing/LandingFaq.tsx", 2],
    ["components/landing/ClosingSection.tsx", 9],
  ];
  const seen = [];
  for (const [f, floor] of files) seen.push(...boundCalls(f, floor));

  const bundles = {};
  for (const loc of ["en", "he"])
    for (const ns of ["marketing", "common"])
      bundles[`${loc}/${ns}`] = JSON.parse(read(`locales/${loc}/${ns}.json`));

  for (const [f, ns, key] of seen) {
    if (!bundles[`en/${ns}`]) {
      fail(`${f} reads namespace "${ns}", which this check does not load — add its bundle.`);
      continue;
    }
    for (const loc of ["en", "he"])
      if (!resolvesIn(bundles[`${loc}/${ns}`], key))
        fail(
          `locales/${loc}/${ns}.json is missing "${key}" (used by ${f}) — the landing would ` +
            "render the raw key. Check 8 stays green while both locales are equally wrong.",
        );
  }

  // Both directions: the matcher must fire on the shape it guards and must not
  // fire on the template literals it deliberately cannot resolve.
  const PROBE_OK = 't("landing.hero.line1")';
  const PROBE_TEMPLATE = "t(`landing.faq.q${k}`)";
  const PROBE_BIND = 'const { t: tm } = useTranslation("marketing");';
  CALL.lastIndex = 0;
  if (!CALL.test(PROBE_OK)) fail("check 28 cannot detect its own call shape");
  CALL.lastIndex = 0;
  if (CALL.test(PROBE_TEMPLATE)) fail("check 28 fires on a template literal, which has no fixed key");
  BIND.lastIndex = 0;
  const probe = BIND.exec(PROBE_BIND);
  if (!probe || probe[1] !== "tm" || probe[2] !== "marketing")
    fail("check 28 cannot read a renamed namespace binding, so every key behind one goes unchecked");
} catch (e) {
  fail(`landing copy check could not run: ${e.message}`);
}

// ---- 29. the account pages' own copy resolves in both locales ----------- //
// Phase 29 added /login, /signup, /verify, /forgot, /reset and /privacy, and
// gave Settings an account half: well over a hundred strings in a new `auth`
// namespace and in `settings`, and NOTHING resolved either namespace against
// the code that reads it. Check 8 is parity-only, so a key missing from en AND
// he is green; 16 and 22 read tailor.json; 28 reads the landing's two bundles;
// 9 is scoped to AppLayout.tsx. The login form is the first screen a new user
// sees, often in Hebrew, and a raw `login.forgot` at 14px on it would be check
// 28's `faq.kicker` one page over.
//
// The same reader as check 28 (`boundCalls`), plus three things the landing
// did not need:
//   - Bundles load ON DEMAND, by the namespace each binding names. These files
//     read `auth`, `settings`, `tracker` and `common`, and a file that starts
//     reading another namespace has to be resolved against it, not waved
//     through.
//   - EVERY file under pages/auth/ must be registered below. A floor table
//     lists files, so a page added next to the others would be guarded by
//     nothing while the build stayed green. Walking the directory turns an
//     unregistered file into a failure instead of a gap.
//   - THE ERROR TABLE. The pages show server codes through lib/apiError.ts,
//     which looks each sentence up by a key held in a table. A code mapped to
//     a key that exists in neither locale would put the raw key in a form's
//     error slot, and no scrape of the pages can see that. Every "errors.*"
//     literal in that file is resolved against auth.json as well.
//
// THE INBOX UI (components/inbox/, Phase 29 F2) is registered and walked the
// same way. It reads `tracker` and `settings`, which nothing resolved before
// either, and its labels are exactly the strings this check exists for: an
// email-kind badge on a tracker card at 12px, where a raw
// `inbox.kinds.interview` is the first thing a Hebrew reader would see after a
// sync. Its kind and status labels are LITERAL calls inside a `switch`
// (components/inbox/shared.tsx) so that this scrape can resolve every one; a
// template literal would be invisible here.
//
// A floor is never registered ahead of its file: `read` throws on a missing
// file, and this check would go red on a tree with nothing wrong in it.
//
// CONTINUE WITH GOOGLE (Phase 30 F) adds two files. pages/auth/GoogleButton.tsx
// is inside a walked directory, so leaving it out is a failure by itself.
// components/GoogleNotice.tsx is NOT, so this table is the only thing that
// resolves its copy, and 32(k) holds both to the table.
//
// Floors sit just under what each file carries today, so adding or removing a
// string does not trip them but a call shape going dark does. Module-level so
// 32(k) can read the same table this check resolves against.
const ACCOUNT_COPY_FILES = [
  ["pages/auth/shared.tsx", 2],
  ["pages/auth/LoginPage.tsx", 15],
  ["pages/auth/SignupPage.tsx", 16],
  ["pages/auth/VerifyPage.tsx", 28],
  ["pages/auth/ForgotPage.tsx", 8],
  ["pages/auth/ResetPage.tsx", 10],
  ["pages/auth/GoogleButton.tsx", 6],
  ["layouts/AuthLayout.tsx", 2],
  ["pages/PrivacyPage.tsx", 20],
  ["pages/SettingsPage.tsx", 60],
  ["components/GoogleNotice.tsx", 2],
  ["components/inbox/shared.tsx", 30],
  ["components/inbox/InboxBar.tsx", 22],
  ["components/inbox/InboxReviewSheet.tsx", 20],
  ["components/inbox/InboxSettingsCard.tsx", 38],
  ["components/inbox/EmailTimeline.tsx", 3],
];
try {
  const files = ACCOUNT_COPY_FILES;

  // Every source file under these directories must be in the table above.
  // Each carries the fewest files it can hold before the walk is reading the
  // wrong place: a directory that moved would otherwise walk nothing, flag
  // nothing, and pass for ever.
  const WALKED = [
    ["pages/auth", 6],
    ["components/inbox", 5],
  ];
  const SOURCE_FILE = /\.tsx?$/;
  const registered = new Set(files.map(([f]) => f));
  for (const [dir, least] of WALKED) {
    const found = fs
      .readdirSync(path.join(SRC, ...dir.split("/")))
      .filter((name) => SOURCE_FILE.test(name))
      .map((name) => `${dir}/${name}`);
    if (found.length < least)
      throw new Error(`found only ${found.length} source files under ${dir} — the files moved`);
    for (const f of found)
      if (!registered.has(f))
        fail(
          `${f} is not registered in check 29, so its copy is resolved against nothing — ` +
            "a missing key would render raw on a green build. Add it to the table with a floor.",
        );
  }

  const seen = [];
  for (const [f, floor] of files) seen.push(...boundCalls(f, floor));

  const bundles = new Map();
  const bundle = (loc, ns) => {
    const id = `${loc}/${ns}`;
    if (!bundles.has(id)) {
      const p = path.join(SRC, "locales", loc, `${ns}.json`);
      bundles.set(id, fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null);
    }
    return bundles.get(id);
  };

  const reportedBundles = new Set();
  for (const [f, ns, key] of seen)
    for (const loc of ["en", "he"]) {
      const b = bundle(loc, ns);
      if (!b) {
        // Once per file and bundle, not once per key: one wrong namespace is
        // one defect, and twenty copies of the sentence would bury the rest.
        const id = `${f}|${loc}/${ns}`;
        if (!reportedBundles.has(id))
          fail(`${f} reads namespace "${ns}", but locales/${loc}/${ns}.json does not exist.`);
        reportedBundles.add(id);
        continue;
      }
      if (!resolvesIn(b, key))
        fail(
          `locales/${loc}/${ns}.json is missing "${key}" (used by ${f}) — the page would render ` +
            "the raw key. Check 8 stays green while both locales are equally wrong.",
        );
    }

  const ERROR_KEY = /"(errors\.[A-Za-z][\w.]*)"/g;
  const errorKeys = [...decomment(read("lib/apiError.ts")).matchAll(ERROR_KEY)].map((m) => m[1]);
  if (errorKeys.length < 20)
    throw new Error(
      `scraped only ${errorKeys.length} "errors.*" keys from lib/apiError.ts (expected at least 20) — ` +
        "the error table changed shape",
    );
  for (const loc of ["en", "he"]) {
    const b = bundle(loc, "auth");
    if (!b) {
      fail(`locales/${loc}/auth.json does not exist, and lib/apiError.ts reads every account error from it.`);
      continue;
    }
    for (const key of new Set(errorKeys))
      if (!resolvesIn(b, key))
        fail(
          `locales/${loc}/auth.json is missing "${key}" (mapped in lib/apiError.ts) — that server ` +
            "error would put the raw key in the form's error slot.",
        );
  }

  // Both directions, for every matcher this check adds: each must fire on the
  // shape it guards and stay quiet on the shape it must not read.
  ERROR_KEY.lastIndex = 0;
  if (!ERROR_KEY.test('i18n.t("errors.weakPassword.tooShort", { ns: "auth" })'))
    fail("check 29 cannot detect a key in the error table");
  ERROR_KEY.lastIndex = 0;
  if (ERROR_KEY.test('i18n.t("dailyLimit.search", { ns: "common" })'))
    fail("check 29 reads keys from outside the error table");
  if (!SOURCE_FILE.test("VerifyPage.tsx") || !SOURCE_FILE.test("shared.ts") || SOURCE_FILE.test("notes.md"))
    fail("check 29's directory walk would miss a page, or count a file that is not one");
  const authBundle = bundle("en", "auth");
  if (!authBundle || !resolvesIn(authBundle, "login.title") || resolvesIn(authBundle, "login.__no_such_key__"))
    fail("check 29's lookup cannot tell a present key from a missing one, so it would pass for ever");
} catch (e) {
  fail(`account copy check could not run: ${e.message}`);
}

// ---- 30. the account + tracker fixes from the Phase 29 review ------------- //
//
// Each probe below reproduced its defect on the committed code (it went red
// first) and pins the legitimate case beside the catch, because a guard that
// also fires on real input is worse than none. EXECUTED where the logic is a
// function (check 17's mechanism), a source pin only where the defect is a
// component's wiring that no node process can render.
//
//   F1 safeNext returned the browser-NORMALISED path, so `/.//evil.com` came
//      back as `//evil.com`, which `location.assign` follows off-site.
//   F2 the privacy, Settings and landing copy said non-job mail never reaches
//      any AI; mail with a job word in it does, to decide.
//   F3 the Interviews tile counted `interviewed` alone while the funnel beside
//      it counted `interviewed || status === "interview"`.
//   F4 a resume draft left by one account was offered to the next account to
//      sign in on the same device.
//   F5 a dead session on /verify printed the gate's raw English 401 detail.
//   F6 a password reset dropped `next` and always landed on /app.
//   F7 an inbox-made card was dated by the UTC day while its own emails were
//      dated by the local day.
//   F8 a failed Gmail connect was consumed from the URL and never shown when
//      the Settings card rendered nothing.
//   F9 the extension-key rotation and the Google revoke result were dropped.
//
// Extended in Phase 30 (D), same method: the confirmation link opened in a
// browser without its account's session, below the F2 block.
//
// Extended again by the PHASE 30 REVIEW, same method — each reproduced on the
// committed code before it was fixed:
//   P1 the emailed confirmation link's card was titled "Your session ended" on
//      a device that had never held a session.
//   P2 with the pool empty, the alerts card explained its disabled Run now in
//      the last line of the card, below the customize hint.
//   P3 the scan's closing card promised a tailored rewrite and navigated to
//      the job search.
//   P4 the cover letter lowered this posting's remaining changes for refusals
//      the server's pass never saw, which can disable a call it would serve.
//   P5 safeNext had no length ceiling at all, while its backend twin now does.

/** Bundle `contents` (resolved from src/) and run it. `stubs` maps an import
 * path as written to the object it should return: `../i18n` cannot run in
 * node (import.meta.glob), and none of these probes needs a real catalogue.
 * `define` is esbuild's, for a module that reads `import.meta.env` at load
 * (api/client.ts), which a cjs bundle would otherwise read as undefined. */
function runProbeBundle(name, contents, stubs = {}, define = {}) {
  const esbuild = createRequire(import.meta.url)("esbuild");
  const built = esbuild.buildSync({
    stdin: { contents, resolveDir: SRC, sourcefile: `check-mirrors-${name}.ts`, loader: "tsx" },
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    target: "node18",
    logLevel: "silent",
    external: Object.keys(stubs),
    jsx: "automatic",
    define,
  });
  const mod = { exports: {} };
  const req = createRequire(import.meta.url);
  new Function("module", "exports", "require", built.outputFiles[0].text)(mod, mod.exports, (id) =>
    id in stubs ? stubs[id] : req(id),
  );
  return mod.exports;
}

/** The whole source of the function declared at `marker`, to its closing brace
 * at the declaration's own indent. Not `blockAfter`: that stops at the FIRST
 * `{`, which for `function X({ a }: { a: T }) {` is the destructured props, so
 * a pin reading the body would read the parameter list and pass or fail on
 * nothing. Throws when the marker is gone, rather than pinning an empty string. */
function fnSource(src, marker) {
  const s = src.replace(/\r\n/g, "\n");
  const at = s.indexOf(marker);
  if (at === -1) throw new Error(`could not find ${marker}`);
  const lineStart = s.lastIndexOf("\n", at) + 1;
  const indent = s.slice(lineStart, at).match(/^[ \t]*/)[0];
  // A brace that ENDS its line: a multi-line props type closes with `}: {` at
  // the same indent, and stopping there would read the signature, not the body.
  const close = new RegExp(`\\n${indent}\\}(?=\\n|$)`, "g");
  close.lastIndex = at;
  const m = close.exec(s);
  if (!m) throw new Error(`no closing brace at the indent of ${marker}`);
  return s.slice(at, m.index);
}

// fnSource's own two directions: it must reach past a multi-line props type to
// the body, and must stop at the function's end rather than the file's.
{
  const probe =
    "function A({\n  x,\n}: {\n  x: number;\n}) {\n  const body = 1;\n}\nfunction B() {\n  const other = 2;\n}\n";
  const a = fnSource(probe, "function A");
  if (!a.includes("const body") || a.includes("const other"))
    fail("check 30's fnSource cannot slice a function with a multi-line signature");
}

/** A Storage stand-in, so the localStorage-backed helpers run in node. */
function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    _map: m,
  };
}

const ORIGIN = "https://app.example";
const savedGlobals = { window: globalThis.window, localStorage: globalThis.localStorage };
globalThis.window = { location: { origin: ORIGIN, pathname: "/login", search: "", hash: "" } };
globalThis.localStorage = memoryStorage();
globalThis.window.localStorage = globalThis.localStorage;

// F1 + F6: lib/safeNext.ts
try {
  const sn = runProbeBundle("safenext", `export * from "./lib/safeNext";\n`);
  if (typeof sn.safeNext !== "function") throw new Error("lib/safeNext.ts no longer exports safeNext");
  // Every one of these resolves to `//evil.com` in a browser's URL parser.
  for (const evil of ["/.//evil.com", "/%2e//evil.com", "/..//evil.com", "/app/..//evil.com", "/%2E%2E//evil.com"]) {
    const got = sn.safeNext(evil);
    if (got !== "/app")
      fail(
        `safeNext(${JSON.stringify(evil)}) returned ${JSON.stringify(got)} — location.assign follows ` +
          "that off this origin after sign-in. It must be /app.",
      );
  }
  // The legitimate half: a real in-app destination survives whole, the query
  // the extension hands off through included.
  for (const [value, want] of [
    ["/app?tailor_app=42", "/app?tailor_app=42"],
    ["/settings#danger", "/settings#danger"],
    ["/tracker?inbox=connected", "/tracker?inbox=connected"],
    ["/jobs/../tracker", "/tracker"],
  ]) {
    const got = sn.safeNext(value);
    if (got !== want)
      fail(`safeNext(${JSON.stringify(value)}) returned ${JSON.stringify(got)}, not ${JSON.stringify(want)} — the fix refuses a real destination`);
  }
  for (const value of ["//evil.com", "/login", "https://evil.com"])
    if (sn.safeNext(value) !== "/app") fail(`safeNext(${JSON.stringify(value)}) is no longer refused`);

  // P5: the ceiling. The backend twin (`sessions.safe_next`) carries the same
  // 512, and there it is load-bearing — Phase 30's anonymous
  // POST /auth/google/start STORES the `next` it is handed, and the callback
  // rebuilds its redirect from the stored copy, so an unbounded value is
  // megabytes written into the database by a caller with no account and a
  // Location header an HTTP client refuses outright. Measured here before the
  // fix: a 120,016-character path came back byte-identical.
  const oversize = `/app?tailor_app=${"a".repeat(600)}`;
  if (sn.safeNext(oversize) !== "/app")
    fail(
      `safeNext() handed back a ${oversize.length}-character destination instead of /app. The backend twin ` +
        "refuses one, and a `next` this side follows while the other refuses it is exactly the disagreement " +
        "lib/safeNext.ts exists to prevent.",
    );
  // …and the legitimate half: a long but real destination still survives whole,
  // or the ceiling is refusing links people actually follow.
  const longReal = `/tracker?inbox=connected&note=${"a".repeat(400)}`;
  if (sn.safeNext(longReal) !== longReal)
    fail(`safeNext() refused a real ${longReal.length}-character in-app destination; the ceiling is too low`);

  // F6: a validated next remembered at /forgot is used after the reset.
  localStorage.clear();
  if (typeof sn.rememberResetNext !== "function" || typeof sn.takeResetNext !== "function") {
    fail(
      "a password reset forgets where the visitor was going: lib/safeNext.ts has no " +
        "rememberResetNext/takeResetNext, so /reset always lands on /app and the extension's " +
        "/app?tailor_app=<id> handoff is lost.",
    );
  } else {
    sn.rememberResetNext("/app?tailor_app=42");
    const first = sn.takeResetNext();
    if (first !== "/app?tailor_app=42")
      fail(`takeResetNext() returned ${JSON.stringify(first)} after remembering /app?tailor_app=42`);
    if (sn.takeResetNext() !== "/app") fail("takeResetNext() does not forget the value once it has been used");
    // Storage is not trusted: a value planted there is validated on the way out.
    localStorage.setItem(sn.RESET_NEXT_KEY, JSON.stringify({ next: "/.//evil.com", at: Date.now() }));
    if (sn.takeResetNext() !== "/app") fail("takeResetNext() follows an unsafe stored value");
    localStorage.setItem(sn.RESET_NEXT_KEY, JSON.stringify({ next: "/tracker", at: Date.now() - 2 * 3600_000 }));
    if (sn.takeResetNext() !== "/app") fail("takeResetNext() follows a value older than the reset link's hour");
    sn.rememberResetNext("/app");
    if (localStorage.getItem(sn.RESET_NEXT_KEY) !== null)
      fail("rememberResetNext stores the default destination, which is nothing to remember");
  }
} catch (e) {
  fail(`safeNext probe could not run: ${e.message}`);
}

// F4: lib/draft.ts
try {
  localStorage.clear();
  const dr = runProbeBundle("draft", `export * from "./lib/draft";\n`);
  const master = (summary) => ({
    contact: { name: "A B", email: "", phone: "", location: "", linkedin: "", website: "" },
    headline: "",
    summary,
    skills: [],
    skill_groups: [],
    experience: [],
    education: [],
    projects: [],
    certifications: [],
    languages: [],
    military_service: [],
  });
  dr.noteDraftOwner?.(7);
  dr.writeDraft(master("Account seven's unsaved edit"));
  dr.noteDraftOwner?.(9); // a different account signs in on this device
  const d = dr.readDraft();
  if (dr.offerDraft(d, master("Account nine's master")))
    fail(
      "a resume draft written by one account is offered to the next account that signs in on this " +
        "device (lib/draft.ts). It must remember its owner and be discarded for anyone else.",
    );
  else if (localStorage._map.has("jobfinder.resumeDraft"))
    fail("a draft that belongs to another account is refused but kept on the device; it must be discarded");
  // The legitimate half: the same account gets its own work back.
  localStorage.clear();
  dr.noteDraftOwner?.(7);
  dr.writeDraft(master("Account seven's unsaved edit"));
  if (!dr.offerDraft(dr.readDraft(), master("Account seven's master")))
    fail("the owner check refuses a draft to the account that wrote it");
  // Unknown is not a match, and not a mismatch either: nothing is offered, nothing deleted.
  dr.noteDraftOwner?.(null);
  if (dr.offerDraft(dr.readDraft(), master("Account seven's master")))
    fail("a draft is offered while nobody is known to be signed in");
  if (!localStorage._map.has("jobfinder.resumeDraft"))
    fail("a draft is deleted merely because the signed-in account is not known yet");
} catch (e) {
  fail(`draft owner probe could not run: ${e.message}`);
}

// F5: lib/apiError.ts
try {
  const ae = runProbeBundle("apierror", `export * from "./lib/apiError";\n`, {
    // `t` at the top level too: esbuild's node-mode interop hands a default
    // import the whole CommonJS module, whatever `__esModule` says.
    "../i18n": { __esModule: true, t: (k) => `T:${k}`, default: { t: (k) => `T:${k}` } },
  });
  const err = (status, detail) => ({ response: { status, data: { detail } } });
  const gate401 = err(401, "Access code required.");
  const shown = ae.apiErrorMessage(gate401, "fallback");
  if (shown === "Access code required.")
    fail(
      "a 401 from the access gate shows its raw English detail (\"Access code required.\") in the " +
        "form — on /verify in Hebrew too. It must read as a translated \"your session ended\".",
    );
  if (typeof ae.isSessionEnded !== "function") fail("lib/apiError.ts has no isSessionEnded for the pages to branch on");
  else {
    if (!ae.isSessionEnded(gate401)) fail("isSessionEnded misses the gate's 401");
    if (!ae.isSessionEnded(err(400, { code: "session_required" }))) fail("isSessionEnded misses session_required");
    for (const [label, e] of [
      ["a wrong code", err(400, { code: "invalid_code", attempts_left: 3 })],
      ["an unverified account", err(403, { code: "email_unverified" })],
      ["a rate limit", err(429, { code: "too_many_attempts", retry_after: 30 })],
      ["a dropped connection", { message: "Network Error" }],
    ])
      if (ae.isSessionEnded(e)) fail(`isSessionEnded fires on ${label}, which is not a session ending`);
  }
  // The legitimate half: a plain-string detail that is NOT a 401 still reads as sent.
  if (ae.apiErrorMessage(err(400, "That file is not a resume."), "fallback") !== "That file is not a resume.")
    fail("the 401 mapping swallows ordinary string details too");
} catch (e) {
  fail(`session-ended probe could not run: ${e.message}`);
}

// F3 + F7: hooks/useTrackerMetrics.ts, rendered for real (a hook needs a render).
try {
  const tm = runProbeBundle(
    "metrics",
    `import { createElement } from "react";\n` +
      `import { renderToString } from "react-dom/server";\n` +
      `import * as m from "./hooks/useTrackerMetrics";\n` +
      `export * from "./hooks/useTrackerMetrics";\n` +
      `export function measure(apps) { let out; const P = () => { out = m.useTrackerMetrics(apps); return null; };` +
      ` renderToString(createElement(P)); return out; }\n`,
  );
  const row = (o) => ({ status: "saved", interviewed: false, created_at: "2026-09-01T10:00:00", ...o });
  const dragged = [row({ status: "interview" }), row({ status: "applied" })];
  const got = tm.measure(dragged);
  if (got.interviews !== 1)
    fail(
      `the Interviews tile reads ${got.interviews} for a card sitting in the Interview column with ` +
        "interviewed=false, while the funnel counts it — one definition, interviewed || status === \"interview\".",
    );
  const legit = tm.measure([row({ status: "rejected", interviewed: true }), row({ status: "applied" }), row({})]);
  if (legit.interviews !== 1) fail(`the Interviews tile reads ${legit.interviews} where exactly one row was interviewed`);
  const none = tm.measure([row({})]);
  if (none.interviewRate !== null || none.responseRate !== null)
    fail("a tracker with nothing applied reports a rate instead of null — unknown is not zero");
  const analytics = decomment(read("components/TrackerAnalytics.tsx"));
  if (/a\.interviewed\s*\|\|\s*a\.status/.test(analytics) || !/\bisInterviewed\b/.test(analytics))
    fail("TrackerAnalytics restates the interviews rule instead of reading isInterviewed from useTrackerMetrics");

  // F7: one local day for an inbox-made card and its own email.
  const prevTZ = process.env.TZ;
  process.env.TZ = "Asia/Jerusalem";
  try {
    const email = row({ source: "email", applied_at: null, created_at: "2026-09-12T22:30:00" });
    const receivedAt = "2026-09-12T22:30:00+00:00";
    const cardDay = new Date(tm.dateOfRecord(email)).getDate();
    const emailDay = new Date(receivedAt).getDate();
    if (new Date(receivedAt).getTimezoneOffset() === 0)
      throw new Error("process.env.TZ did not take effect, so the day comparison proves nothing");
    if (cardDay !== emailDay)
      fail(
        `an inbox-made card is dated the ${cardDay}th while its own email reads the ${emailDay}th: ` +
          "its naive created_at is UTC and was parsed as local time.",
      );
    // The legitimate half: rows that already state an offset, and rows no
    // email made, keep exactly the value they had.
    const manual = row({ source: "", created_at: "2026-09-12T22:30:00" });
    if (tm.dateOfRecord(manual) !== "2026-09-12T22:30:00") fail("dateOfRecord rewrote a row the inbox did not make");
    const stated = row({ source: "email", created_at: "2026-09-12T22:30:00+00:00" });
    if (tm.dateOfRecord(stated) !== "2026-09-12T22:30:00+00:00") fail("dateOfRecord rewrote a timestamp that states its offset");
    const sent = row({ source: "email", applied_at: "2026-09-10T08:00:00+00:00" });
    if (tm.dateOfRecord(sent) !== "2026-09-10T08:00:00+00:00") fail("dateOfRecord no longer prefers applied_at");
  } finally {
    if (prevTZ === undefined) delete process.env.TZ;
    else process.env.TZ = prevTZ;
  }
} catch (e) {
  fail(`tracker metrics probe could not run: ${e.message}`);
}

// F9: lib/authResults.ts (the response readers) and their call sites.
try {
  let ar = null;
  try {
    ar = runProbeBundle("authresults", `export * from "./lib/authResults";\n`);
  } catch {
    fail(
      "the extension-key rotation and the Google revoke result are dropped: there is no " +
        "lib/authResults.ts to read extension_key_rotated or google_revoked.",
    );
  }
  if (ar) {
    const r1 = ar.readKeyRotation({ ok: true, extension_key_rotated: true, key: "NEWKEY" });
    if (!r1.rotated || r1.key !== "NEWKEY") fail("readKeyRotation misses a rotation that carries its key");
    const r2 = ar.readKeyRotation({ ok: true, extension_key_rotated: true });
    if (!r2.rotated || r2.key !== "") fail("readKeyRotation misreads a rotation without a key");
    for (const body of [{ ok: true }, { extension_key_rotated: false, key: "X" }, null, { extension_key_rotated: "yes" }]) {
      const r = ar.readKeyRotation(body);
      if (r.rotated || r.key) fail(`readKeyRotation claims a rotation for ${JSON.stringify(body)}`);
    }
    if (ar.readGoogleRevoked({ disconnected: true, google_revoked: false }) !== false)
      fail("readGoogleRevoked misses a failed revoke");
    if (ar.readGoogleRevoked({ disconnected: true, google_revoked: true }) !== true)
      fail("readGoogleRevoked misreads a successful revoke");
    // An older response says nothing, which is unknown, never a failure to warn about.
    if (ar.readGoogleRevoked({ disconnected: true, events_deleted: 0 }) !== null)
      fail("readGoogleRevoked reads a response without the field as a result");
    localStorage.clear();
    ar.markKeyRotated();
    if (!ar.keyRotatedNotice()) fail("markKeyRotated leaves no notice for Settings to show");
    ar.clearKeyRotated();
    if (ar.keyRotatedNotice()) fail("clearKeyRotated leaves the notice up");
  }
  const settings = decomment(read("pages/SettingsPage.tsx"));
  for (const fn of ["function PasswordChange", "function OtherDevices"]) {
    const body = fnSource(settings, fn);
    if (!/readKeyRotation\(/.test(body)) fail(`SettingsPage ${fn.slice(9)} ignores extension_key_rotated`);
    if (!/ACCESS_CODE_KEY/.test(body)) fail(`SettingsPage ${fn.slice(9)} does not store a returned key for an invite-code device`);
  }
  const reset = decomment(read("pages/auth/ResetPage.tsx"));
  if (!/readKeyRotation\(/.test(reset)) fail("ResetPage ignores extension_key_rotated");
  const card = decomment(read("components/inbox/InboxSettingsCard.tsx"));
  if (!/readGoogleRevoked\(/.test(card) || !/href=\{GOOGLE_PERMISSIONS_URL\}/.test(card))
    fail("InboxSettingsCard does not tell the user when Google access could not be revoked, with the permissions link");
  if (ar && ar.GOOGLE_PERMISSIONS_URL !== "https://myaccount.google.com/permissions")
    fail(`GOOGLE_PERMISSIONS_URL is ${JSON.stringify(ar.GOOGLE_PERMISSIONS_URL)}, not Google's permissions page`);
} catch (e) {
  fail(`account result probe could not run: ${e.message}`);
}

// F5, F6, F8: the page wiring no node process can render.
try {
  const verify = decomment(read("pages/auth/VerifyPage.tsx"));
  for (const [what, marker] of [
    ["the link confirm", "function ConfirmLink"],
    ["Send a new code", "async function resend"],
    ["Change email", "function ChangeEmail"],
  ]) {
    const body = fnSource(verify, marker);
    if (!/isSessionEnded\(/.test(body))
      fail(`/verify: ${what} does not branch on a dead session, so it prints the server's raw 401 detail`);
  }
  const forgot = decomment(read("pages/auth/ForgotPage.tsx"));
  if (!/rememberResetNext\(/.test(forgot)) fail("/forgot does not remember the validated next");
  if (!/withNext\(\s*"\/login"/.test(forgot)) fail("/forgot links back to /login without next");
  const resetPage = decomment(read("pages/auth/ResetPage.tsx"));
  if (!/takeResetNext\(/.test(resetPage) || /assign\(\s*"\/app"\s*\)/.test(resetPage))
    fail("/reset lands on a hard-coded /app instead of the remembered next");
  const login = decomment(read("pages/auth/LoginPage.tsx"));
  if (/to="\/forgot"/.test(login) || !/withNext\(\s*"\/forgot"/.test(login))
    fail("/login's Forgot password link drops next");

  // F8: the callback toast must fire before the card's early returns.
  const card = decomment(read("components/inbox/InboxSettingsCard.tsx"));
  const early = card.indexOf("if (!status) return null");
  if (early === -1) throw new Error("InboxSettingsCard no longer has its `if (!status) return null` early return");
  const toastAt = card.search(/toast\(\s*"error"\s*,\s*callbackMessage\(/);
  if (toastAt === -1 || toastAt > early)
    fail(
      "a failed Gmail connect (?inbox=<code>) is shown only inside a card that can render nothing, " +
        "and the flag is already gone from the URL. Toast it before the early returns.",
    );
  // The detector itself, both directions.
  const PROBE = /toast\(\s*"error"\s*,\s*callbackMessage\(/;
  if (!PROBE.test('toast("error", callbackMessage(callback))') || PROBE.test('toast("error", t("inbox.saveError"))'))
    fail("check 30's callback-toast detector cannot tell its call shape from another toast");
} catch (e) {
  fail(`account page wiring check could not run: ${e.message}`);
}

// F2: copy that makes a claim about what the code does.
try {
  const locale = (loc, ns) => JSON.parse(fs.readFileSync(path.join(SRC, "locales", loc, `${ns}.json`), "utf8"));
  const at = (obj, key) => key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
  // `forbid` is the false claim; `need` is the part of the true statement that
  // makes it true. Both, because deleting the sentence would satisfy `forbid`.
  const MAIL = {
    en: { forbid: /all other mail|personal mail|mail that is not about/i, need: /\bAI model\b/i },
    he: { forbid: /שאר הדואר|מיילים אישיים|מיילים שלא קשורים/, need: /מודל/ },
  };
  // Phase 30 / D15 is the same class pointing the OTHER way. The CV scan moved
  // INTO the tools menu as `POST /tools/scan`, and it is the one tool there that
  // reaches no model at all — `app/core/free_scan.py` imports a tokenizer and the
  // scorer and no client — so a sentence about what "the AI tools" send has to
  // name it as the exception, or the page claims we send a file we never send.
  const SCAN = {
    en: { forbid: /\b(?:every|all)(?:\s+of)?\s+(?:the\s+)?(?:AI\s+)?tools?\b/i, need: /\bscan\b[^.]*\b(?:reaches no AI|no AI service)/i },
    he: { forbid: /כל הכלים|כל כלי ה-AI/, need: /סריקת קורות החיים[^.]*(?:לא מגיעה|אינה מגיעה)/ },
  };
  const RULES = [
    ["auth", "privacy.ai.tools", SCAN],
    ["auth", "privacy.gmail.skips", MAIL],
    ["settings", "inbox.read2", MAIL],
    ["marketing", "landing.faq.a7", MAIL],
    [
      "auth",
      "privacy.store.security",
      {
        en: { forbid: /one-way key/i, need: /30 days after (?:that |the )?session ends/i },
        he: { forbid: /חד-כיווני/, need: /30 (?:יום|ימים) אחרי ש/ },
      },
    ],
    ["settings", "inbox.autoSyncHint", { en: { forbid: /whenever you open/i, need: /30 minutes/ }, he: { forbid: /בכל פעם/, need: /30 דקות/ } }],
  ];
  const claimProblem = (text, rule) =>
    typeof text !== "string" ? "is missing" : rule.forbid.test(text) ? "makes the false claim" : !rule.need.test(text) ? "lacks the true statement" : "";
  for (const [ns, key, byLoc] of RULES)
    for (const loc of ["en", "he"]) {
      const why = claimProblem(at(locale(loc, ns), key), byLoc[loc]);
      if (why)
        fail(
          `locales/${loc}/${ns}.json "${key}" ${why}. The CV scan is scored in our own code and reaches no ` +
            "AI service; alert digests and mail clearly not about an " +
            "application are skipped before any AI; other possibly-job mail is read by an AI model to decide; " +
            "the security log keeps a coarse network hint and device type for 30 days after the session ends; " +
            "auto-sync runs on opening the tracker only when the last sync is over 30 minutes old.",
        );
    }
  // Both directions on the matcher: the old sentence fails, a true one passes.
  if (!claimProblem("Job alerts and all other mail are skipped before any AI sees them.", MAIL.en))
    fail("check 30's copy rule passes the old false sentence");
  if (claimProblem("Digests are skipped before any AI sees them. Other possibly-job emails are read by an AI model to decide.", MAIL.en))
    fail("check 30's copy rule refuses a true sentence");
  if (!claimProblem("Tailoring, interview practice and the other AI tools send the resume and job text you give them to OpenAI to produce the result.", SCAN.en))
    fail("check 30's copy rule passes the sentence that leaves the deterministic CV scan inside \"the other AI tools\"");
  if (claimProblem("The other AI tools send your text to OpenAI. The CV scan is the exception: it reaches no AI service.", SCAN.en))
    fail("check 30's copy rule refuses a true sentence about the scan");
} catch (e) {
  fail(`privacy copy check could not run: ${e.message}`);
}

// D (Phase 30): the confirmation link works on any device, after a log in.
//
// Opened in a browser with no session of its account, the link is 400
// session_required, and FIXB B1 keeps that rule so a squatter's link still
// cannot verify on a stranger's click. Until D the page showed "session ended"
// with a Log in link and DROPPED the link's token on the way, so the log in
// that followed landed on the 6-digit code the person did not have in front of
// them. Signed in to ANOTHER account it was worse: /login forwards a verified
// visitor straight to `next`, so that Log in link never reached a form at all.
//
//   D1 ConfirmLink keeps the token (lib/verifyLink.ts), asks /auth/me who this
//      browser is before rendering, and never sends the reader to /login by
//      itself: logging in here and entering the code where they signed up are
//      both ways on, and only the reader knows which device they are holding.
//   D3 EnterCode spends a kept token at mount. Never through `redirected()`,
//      which sends session_required to /login: a kept link that belongs to
//      another account would bounce a person who has just logged in straight
//      back out, for ever. And its "verified" outcome is not gated on the
//      effect's `live` flag: the token is forgotten once it verified, so a
//      dropped result would leave nothing to move the page on.
//   The shared sign-out (lib/session.ts) never touches sessionStorage, or "Log
//   out and continue" would forget the very link it continues with. That pin is
//   only as good as there being ONE sign-out, so that is pinned too.

/** The balanced `opener(...)` call around index `at` in `src` (from the last
 * `opener` before `at` to its matching close paren), or null when `at` is in
 * none. String literals are skipped, so a paren inside a message cannot end
 * the call early. `opener` must end with "(". */
function enclosingCall(src, at, opener) {
  for (let start = src.lastIndexOf(opener, at); start !== -1; start = start ? src.lastIndexOf(opener, start - 1) : -1) {
    let depth = 0;
    for (let i = start + opener.length - 1; i < src.length; i++) {
      const c = src[i];
      if (c === '"' || c === "'" || c === "`") {
        for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) {
        if (at < i) return src.slice(start, i + 1);
        break;
      }
    }
  }
  return null;
}

/** What is wrong with ConfirmLink's session-ended branch, given its source. */
function confirmLinkProblems(body) {
  const out = [];
  if (!/\brememberVerifyLink\(/.test(body))
    out.push(
      "does not keep the link's token when this browser holds no session of its account (rememberVerifyLink), " +
        "so the log in that follows lands on the 6-digit code instead of finishing",
    );
  if (!/\bgetAuthMe\(/.test(body))
    out.push(
      "does not ask /auth/me who this browser is before showing the card, so a browser signed in to another " +
        "account gets a Log in link that /login forwards straight past",
    );
  if (/\bassign\(\s*(?:withNext\(\s*)?["'`]\/login\b/.test(body))
    out.push(
      "sends the browser to /login by itself. It must show the card and let the reader choose: log in on this " +
        "device, or enter the code where they signed up",
    );
  return out;
}

/** What is wrong with the way EnterCode spends a kept link, given its source. */
function storedLinkProblems(body) {
  const at = body.search(/\bconsumeStoredLink\(/);
  if (at === -1)
    return [
      "does not spend a confirmation link kept before logging in (consumeStoredLink), so the person types " +
        "the code the link already carried",
    ];
  const effect = enclosingCall(body, at, "useEffect(");
  if (effect === null) return ["spends the kept link outside a mount effect; it must run when the page opens"];
  const out = [];
  if (/\bredirected\(/.test(effect))
    out.push(
      "routes the kept link's outcome through redirected(), which sends session_required to /login: a link " +
        "that belongs to another account bounces a person who has just logged in back out, for ever",
    );
  const after = effect.slice(effect.search(/\bconsumeStoredLink\(/));
  const verified = after.search(/["']verified["']/);
  const move = verified === -1 ? -1 : after.slice(verified).search(/\bassign\(/);
  if (move === -1) out.push('does not move the page on when the kept link comes back "verified"');
  else if (/\blive\b/.test(after.slice(0, verified + move)))
    out.push(
      'gates the "verified" move on the effect\'s `live` flag. The token is already forgotten, so a dropped ' +
        "result leaves a verified account sitting on the code form",
    );
  return out;
}

const savedSessionStorage = globalThis.sessionStorage;
try {
  globalThis.sessionStorage = memoryStorage();
  globalThis.window.sessionStorage = globalThis.sessionStorage;
  let vl = null;
  try {
    vl = runProbeBundle("verifylink", `export * from "./lib/verifyLink";\n`);
  } catch (e) {
    fail(
      "a confirmation link opened before logging in is lost on the way: there is no lib/verifyLink.ts to " +
        `keep its token for this tab (${String(e.message).split("\n")[0]}).`,
    );
  }
  if (vl) {
    for (const fn of ["rememberVerifyLink", "peekVerifyLink", "consumeStoredLink"])
      if (typeof vl[fn] !== "function") throw new Error(`lib/verifyLink.ts does not export ${fn}`);
    const KEY = "jf-verify-link";
    const tab = () => globalThis.sessionStorage;
    // The shape secrets.token_urlsafe(32) mints: 43 base64url characters.
    const TOKEN = "q3Zt_8mB-Lx2vR9pYw4KdN7cHs1uJf6eGa0oTi5bWnE";

    // A round trip, kept for THIS TAB, and looking at it does not spend it.
    const devicesBefore = localStorage._map.size;
    vl.rememberVerifyLink(TOKEN);
    if (vl.peekVerifyLink() !== TOKEN) fail("peekVerifyLink does not return the token rememberVerifyLink kept");
    if (vl.peekVerifyLink() !== TOKEN) fail("peekVerifyLink forgets a token it only looked at");
    if (!tab()._map.has(KEY))
      fail(`rememberVerifyLink does not keep the token under sessionStorage "${KEY}"`);
    if (localStorage._map.size !== devicesBefore)
      fail("rememberVerifyLink writes to localStorage: a confirmation link must stay in the tab that opened it");

    // A bad shape and a stale entry read as nothing, and are dropped.
    const planted = (value) => {
      tab().clear();
      tab().setItem(KEY, value);
      return vl.peekVerifyLink();
    };
    for (const [label, value] of [
      ["a token with characters no link carries", JSON.stringify({ token: "abc/../x?y=1&z=2", at: Date.now() })],
      ["a token over 128 characters", JSON.stringify({ token: "a".repeat(129), at: Date.now() })],
      ["an entry that is not JSON", "{not json"],
      ["an entry with no time", JSON.stringify({ token: TOKEN })],
      ["a token stored two hours ago", JSON.stringify({ token: TOKEN, at: Date.now() - 2 * 3600_000 })],
    ]) {
      if (planted(value) !== null) fail(`peekVerifyLink returns ${label}`);
      else if (tab()._map.has(KEY)) fail(`peekVerifyLink refuses ${label} but leaves it stored`);
    }
    // The legitimate half: the longest token the server accepts, and one a minute old.
    if (planted(JSON.stringify({ token: "b".repeat(128), at: Date.now() })) !== "b".repeat(128))
      fail("peekVerifyLink refuses a 128-character token, which the server still reads");
    if (planted(JSON.stringify({ token: TOKEN, at: Date.now() - 60_000 })) !== TOKEN)
      fail("peekVerifyLink refuses a token kept a minute ago");
    tab().clear();
    vl.rememberVerifyLink("not a token!");
    if (tab()._map.has(KEY)) fail("rememberVerifyLink keeps a value that is not a link token");

    // consumeStoredLink: "none", "verified" and "failed", and what each leaves behind.
    const err = (status, detail) => ({ response: { status, data: { detail } } });
    let sent = [];
    const answer = (value) => async (token) => {
      sent.push(token);
      return value;
    };
    tab().clear();
    const none = await vl.consumeStoredLink(answer({ verified: true, signed_in: true }));
    if (none !== "none" || sent.length)
      fail(`consumeStoredLink with nothing kept returned ${JSON.stringify(none)} after ${sent.length} request(s); it must be "none" and send nothing`);
    vl.rememberVerifyLink(TOKEN);
    sent = [];
    const ok = await vl.consumeStoredLink(answer({ verified: true, signed_in: true }));
    if (ok !== "verified") fail(`consumeStoredLink returned ${JSON.stringify(ok)} for a link that verified`);
    if (sent.length !== 1 || sent[0] !== TOKEN) fail("consumeStoredLink does not send the kept token, exactly once");
    if (tab()._map.has(KEY)) fail("a kept link that verified is not forgotten, so it would be sent again");
    for (const [label, thrown, kept] of [
      ["a 400 session_required (another account is signed in)", err(400, { code: "session_required" }), true],
      ["a dropped connection", { message: "Network Error" }, true],
      ["a server error", err(500, "Internal Server Error"), true],
      ["a 400 used", err(400, { code: "used" }), false],
      ["a 400 expired", err(400, { code: "expired" }), false],
      ["a 400 invalid", err(400, { code: "invalid" }), false],
    ]) {
      tab().clear();
      vl.rememberVerifyLink(TOKEN);
      let out;
      try {
        out = await vl.consumeStoredLink(async () => {
          throw thrown;
        });
      } catch (e) {
        fail(`consumeStoredLink rejects on ${label} (${e?.message ?? e}); it must never throw`);
        continue;
      }
      if (out !== "failed") fail(`consumeStoredLink returned ${JSON.stringify(out)} for ${label}, not "failed"`);
      if (kept && !tab()._map.has(KEY))
        fail(`consumeStoredLink forgets the kept link on ${label}, which a log out and a log in could still spend`);
      if (!kept && tab()._map.has(KEY))
        fail(`consumeStoredLink keeps the link after ${label}: it is spent, and would be sent on every visit`);
    }
    // It never rejects, whatever the verifier or the storage does.
    for (const [label, verify] of [
      ["a verifier that throws before it returns a promise", () => {
        throw new Error("boom");
      }],
      ["a verifier that rejects with nothing", () => Promise.reject(null)],
      ["a verifier that resolves with nothing", async () => undefined],
      ["a 200 that is not verified", async () => ({ verified: false, signed_in: false })],
    ]) {
      tab().clear();
      vl.rememberVerifyLink(TOKEN);
      try {
        const out = await vl.consumeStoredLink(verify);
        if (out !== "failed") fail(`consumeStoredLink returned ${JSON.stringify(out)} for ${label}, not "failed"`);
      } catch (e) {
        fail(`consumeStoredLink rejects for ${label} (${e?.message ?? e}); it must never throw`);
      }
    }
    const blocked = () => {
      throw new Error("storage is blocked");
    };
    globalThis.sessionStorage = { getItem: blocked, setItem: blocked, removeItem: blocked, clear: blocked };
    globalThis.window.sessionStorage = globalThis.sessionStorage;
    try {
      vl.rememberVerifyLink(TOKEN);
      if (vl.peekVerifyLink() !== null) fail("peekVerifyLink returns a token from storage it cannot read");
      const out = await vl.consumeStoredLink(answer({ verified: true, signed_in: true }));
      if (out !== "none") fail(`consumeStoredLink returned ${JSON.stringify(out)} with storage blocked, not "none"`);
    } catch (e) {
      fail(`lib/verifyLink.ts throws when sessionStorage is blocked (${e.message}); the code form must still open`);
    }
  }
} catch (e) {
  fail(`verify link probe could not run: ${e.message}`);
} finally {
  globalThis.sessionStorage = savedSessionStorage;
  if (globalThis.window) delete globalThis.window.sessionStorage;
}

try {
  const verify = decomment(read("pages/auth/VerifyPage.tsx"));
  for (const p of confirmLinkProblems(fnSource(verify, "function ConfirmLink"))) fail(`/verify: the link confirm ${p}.`);
  for (const p of storedLinkProblems(fnSource(verify, "function EnterCode"))) fail(`/verify: the code page ${p}.`);

  // Both detectors, both directions, on fixtures: each fires on its defect and
  // stays quiet on the shipped shape.
  const CONFIRM_OK =
    "function ConfirmLink() {\n  try { await verifyEmail({ token }); } catch (err) {\n" +
    "    if (isSessionEnded(err)) { rememberVerifyLink(token); setEnded(await getAuthMe()); }\n  }\n" +
    '  const leave = () => void signOut(withNext("/login", next));\n  const stay = () => window.location.assign(next);\n}\n';
  if (confirmLinkProblems(CONFIRM_OK).length)
    fail(`check 30's link-confirm detector refuses the shipped shape: ${confirmLinkProblems(CONFIRM_OK)[0]}`);
  const AUTO = CONFIRM_OK.replace(
    "setEnded(await getAuthMe());",
    'const me = await getAuthMe(); if (!me.authenticated) window.location.assign(withNext("/login", next));',
  );
  if (confirmLinkProblems(AUTO).length !== 1 || confirmLinkProblems(CONFIRM_OK.replace("rememberVerifyLink(token);", "")).length !== 1)
    fail("check 30's link-confirm detector misses an automatic /login, or a token that is not kept");

  const ENTER_OK =
    "function EnterCode() {\n  useEffect(() => {\n    let live = true;\n    getAuthMe().then(async (m) => {\n" +
    "      if (!live) return;\n      const link = await consumeStoredLink((token) => verifyEmail({ token }));\n" +
    '      if (link === "verified") window.location.assign(next);\n      else if (live) setMe(m);\n    });\n' +
    "  }, [next]);\n  function redirected(err) { return false; }\n  async function submitCode() { if (redirected(err)) return; }\n}\n";
  if (storedLinkProblems(ENTER_OK).length)
    fail(`check 30's kept-link detector refuses the shipped shape: ${storedLinkProblems(ENTER_OK)[0]}`);
  for (const [label, defect] of [
    ["an outcome routed through redirected()", ENTER_OK.replace("else if (live) setMe(m);", 'else if (link === "failed") redirected(link);')],
    ["a verified move gated on live", ENTER_OK.replace('if (link === "verified")', 'if (link === "verified" && live)')],
    ["a spend outside a mount effect", ENTER_OK.replace("useEffect(() => {", "(async () => {")],
  ])
    if (storedLinkProblems(defect).length === 0) fail(`check 30's kept-link detector misses ${label}`);

  // lib/session.ts: the ONE sign-out, and it leaves this tab's storage alone.
  const TOUCHES_TAB = /\bsessionStorage\b/;
  if (!TOUCHES_TAB.test("sessionStorage.clear();") || TOUCHES_TAB.test(decomment("// never sessionStorage\nconst a = 1;\n")))
    fail("check 30's sessionStorage detector cannot tell a call from a comment");
  if (!fs.existsSync(path.join(SRC, "lib", "session.ts"))) {
    fail("there is no lib/session.ts: the sign-out /verify's \"Log out and continue\" needs is not shared");
  } else {
    const session = decomment(read("lib/session.ts"));
    if (!/export\s+async\s+function\s+signOut\s*\(\s*\w+/.test(session))
      fail("lib/session.ts does not export the shared signOut(destination)");
    if (TOUCHES_TAB.test(session))
      fail(
        "lib/session.ts touches sessionStorage: \"Log out and continue\" on /verify would forget the confirmation " +
          "link this tab is keeping, and the log in that follows could not finish confirming.",
      );
  }
  const definers = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(SRC, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name) && /\b(?:function\s+signOut\s*\(|(?:const|let)\s+signOut\s*=)/.test(decomment(read(rel))))
        definers.push(rel);
    }
  };
  walk("");
  if (definers.join() !== "lib/session.ts")
    fail(
      `signOut is defined in ${definers.join(", ") || "no file"}; there must be exactly one, in lib/session.ts. ` +
        "A second copy is the one a new store is forgotten in, and the sessionStorage pin guards only one.",
    );
} catch (e) {
  fail(`verify link wiring check could not run: ${e.message}`);
}

globalThis.window = savedGlobals.window;
globalThis.localStorage = savedGlobals.localStorage;

// P1-P4: the rest of the Phase 30 review's frontend fixes. Source pins, because
// each is a component's wiring rather than a function a node process can call;
// the one predicate that IS a function is executed by 32(c).
try {
  // P1. Two cards on /verify say a session ended. Only one of them is about a
  // session that ended: the other is the emailed link, opened in whatever
  // browser the mail app owns, which never held a session of that account — so
  // "Your session ended" there reads as "you were logged out" to someone who
  // never logged in, and it is the first thing they read. Driven in a fresh
  // context with no cookie ever set, that card rendered "Your session ended"
  // over the new any-device instruction.
  const verify = decomment(read("pages/auth/VerifyPage.tsx"));
  const cardTitle = (text, subKey) => {
    const m = new RegExp(
      `<AuthCard\\s+title=\\{t\\("(verify\\.[^"]+)"\\)\\}\\s*sub=\\{t\\("${subKey.replace(/\./g, "\\.")}"\\)\\}`,
    ).exec(text);
    return m ? m[1] : null;
  };
  const linkTitle = cardTitle(verify, "verify.endedLinkBody");
  const codeTitle = cardTitle(verify, "verify.endedBody");
  if (!linkTitle || !codeTitle) {
    fail(
      "check 30 cannot read /verify's two session-ended cards (the emailed link's and the code form's), so " +
        "the title rule below is reading nothing",
    );
  } else {
    if (linkTitle === codeTitle)
      fail(
        `/verify gives both session-ended cards the title "${linkTitle}". The emailed link opens in a browser ` +
          "that never held a session, so a title asserting one ended is false for the case Part D exists to " +
          "serve. Give the link branch its own title and leave that one where a session really did end.",
      );
    for (const [what, key] of [
      ["the emailed link's card", linkTitle],
      ["the expired code form's card", codeTitle],
    ])
      for (const loc of ["en", "he"]) {
        const auth = JSON.parse(read(`locales/${loc}/auth.json`));
        if (!resolvesIn(auth, key))
          fail(`locales/${loc}/auth.json is missing "${key}", the title of ${what} on /verify.`);
      }
  }
  // The reader, both directions, on fixtures.
  const CARDS = (a, b) =>
    `<AuthCard title={t("${a}")} sub={t("verify.endedLinkBody")}>\n` +
    `<AuthCard title={t("${b}")} sub={t("verify.endedBody")}>\n`;
  if (cardTitle(CARDS("verify.endedLinkTitle", "verify.endedTitle"), "verify.endedLinkBody") !== "verify.endedLinkTitle")
    fail("check 30's /verify card reader cannot pair a title with its own sub-line");
  if (cardTitle(CARDS("verify.endedTitle", "verify.endedTitle"), "verify.endedBody") !== "verify.endedTitle")
    fail("check 30's /verify card reader cannot read the shape it forbids, so it would pass for ever");

  // P2. WHERE the alerts card's paused line renders, not only that it resolves.
  // With the pool empty it was the last line of the card, under the customize
  // hint, while a ticked "Email me new jobs" and a disabled Run now sat at the
  // top with nothing to account for them — measured at 390px in both locales.
  // It belongs beside the controls it explains.
  const alerts = decomment(read("pages/jobs/AlertsCard.tsx"));
  const runNowAt = alerts.indexOf("uses.runNow");
  const pausedAt = alerts.indexOf("uses.alertPaused");
  const customizeAt = alerts.indexOf('t("alerts.customize")');
  if (runNowAt === -1 || pausedAt === -1 || customizeAt === -1)
    fail(
      "check 30 cannot find the alerts card's Run now note, its paused line or its customize toggle, so the " +
        "ordering rule below is reading nothing",
    );
  else if (!(runNowAt < pausedAt && pausedAt < customizeAt))
    fail(
      "pages/jobs/AlertsCard.tsx renders the paused line away from the controls it explains. It must sit just " +
        "after Run now's own note and before the customize toggle: at the foot of the card the reader meets " +
        "an enabled toggle and a dead button first, and the one sentence that accounts for both is the " +
        "furthest thing from them.",
    );

  // P3. The scan's closing card names tailoring specifically ("Tailoring
  // rewrites your resume for this exact job", under "Get the full tailored
  // rewrite"), and tailoring is /app. It pointed at /jobs, the search — and
  // since Phase 30 the scan is the landing's main secondary door, so this is
  // the first navigation many brand-new accounts take.
  const scan = decomment(read("pages/ScanPage.tsx"));
  const links = [...scan.matchAll(/<Link\s+to="([^"]+)"/g)].map((m) => m[1]);
  if (links.length !== 1)
    fail(
      `check 30 reads ${links.length} <Link to="…"> in pages/ScanPage.tsx, not the one closing-card call to ` +
        "action, so its destination is pinned by nothing",
    );
  else if (links[0] !== "/app")
    fail(
      `pages/ScanPage.tsx sends "Get the full tailored rewrite" to ${links[0]}. Tailoring is /app; the copy ` +
        "above the button promises a tailored rewrite, so any other destination is a promise the tap does " +
        "not keep.",
    );

  // P4. The cover letter holds its own count of what this posting's pass has
  // left, and it lowered that count for every failure but the monthly limit —
  // measured, `isMonthlyLimit` is false for a 422, a 400, a 401, a 403 and a
  // dropped connection alike, none of which reached the pass. Only a 5xx is
  // raised from inside it. 32(c) executes the predicate; this pins the branch.
  const letter = decomment(read("components/CoverLetter.tsx"));
  const GATED = /else if \(\s*isServerFailure\(\s*e\s*\)\s*\)\s*setPass\(/;
  if (!/setPass\(\(p\)/.test(letter))
    fail("check 30 cannot find CoverLetter's local pass decrement, so the rule below is reading nothing");
  else if (!GATED.test(letter))
    fail(
      "components/CoverLetter.tsx lowers this posting's remaining changes without asking whether the server's " +
        "pass ever saw the failure (isServerFailure). A 400, a 422, a 401, a 403 or a request that never got " +
        "a response spent no slot, and counting one drives the count to 0 early — which at 0 uses left " +
        "disables Generate on a call the server would still have included.",
    );
  if (GATED.test("if (isMonthlyLimit(e)) setPass(null);\n      else setPass((p) => p);"))
    fail("check 30's cover-letter reader accepts an ungated decrement");
  if (!GATED.test("else if (isServerFailure(e))\n        setPass((p) => p);"))
    fail("check 30's cover-letter reader cannot read the gated decrement it requires");
} catch (e) {
  fail(`Phase 30 review fix check could not run: ${e.message}`);
}

// ---- 31. the Jobs page's search and card copy resolves in both locales --- //
// Phase 30 Part J gave the Jobs page's filtered list a third reason: a
// worldwide posting in a country where pay is well below Israel's is hidden
// before it takes a slot, with a counted sentence over the list
// (`search.filteredMarket`) and a note on each revealed row (`card.marketNote`).
// And NOTHING resolved the `jobs` namespace against the code that reads it.
// Check 8 is parity-only, so a key missing from en AND he is green; 16 and 22
// read tailor.json; 28 reads the landing's bundles; 29 the account pages' and
// the inbox's; 9 is scoped to AppLayout.tsx. A new counted key ships in exactly
// that shape, and a raw `search.filteredMarket` in amber above the list would
// be check 28's `faq.kicker` on the page the daily alert's reader opens.
//
// The same reader as 28 and 29 (`boundCalls`), so every key is looked up in
// the namespace its own `useTranslation` binding names (`jobs` in both files
// today), with bundles loaded on demand, check 29's way.
//
// SCOPED to `search.*` and `card.*` in these two files: the prefixes the
// filtered list and its rows read. Every other literal key in both files
// resolved when this check was written, so a wider scope is a free follow-up,
// not a defect this check is hiding.
//
// TWO floors per file. The first is `boundCalls`' own, on every literal call
// the binding reads. The second is on the scoped subset, for check 22's reason
// one level down: JobsPage.tsx carries far more literal calls outside
// `search.*` than inside it (60 against 22 when this was written), so a floor
// on the total would stay satisfied while every call this check exists for had
// gone dark.
//
// Not seen, by design, exactly as in 28: a template literal (`card.geo.${key}`)
// has no fixed key, and neither does a ternary argument
// (`t(show ? "search.geoHide" : "search.geoShow")`) or a `<Trans i18nKey>`.
// The keys the pay filter added are written as plain literal calls so that
// this check can see them.
try {
  // [file, floor on every literal call, floor on the search.* / card.* calls].
  // Floors sit just under what each file carries today (69 and 22 in
  // JobsPage.tsx since PLAN 31.4/5 deleted the Kits tab with its calls, 38 and
  // 37 in cards.tsx), check 29's convention: adding or removing a string does
  // not trip them, a call shape going dark does.
  const files = [
    ["pages/JobsPage.tsx", 60, 19],
    ["pages/jobs/cards.tsx", 34, 33],
  ];
  const IN_SCOPE = /^(?:search|card)\./;
  // What the Jobs page needs of one key in one locale's bundle is the shared
  // `keyProblems` above, which 32(d) asks of the monthly-uses notes as well.

  const bundles = new Map();
  const bundle = (loc, ns) => {
    const id = `${loc}/${ns}`;
    if (!bundles.has(id)) {
      const p = path.join(SRC, "locales", loc, `${ns}.json`);
      bundles.set(id, fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null);
    }
    return bundles.get(id);
  };

  for (const [f, floorAll, floorScoped] of files) {
    const scoped = boundCalls(f, floorAll).filter(([, , key]) => IN_SCOPE.test(key));
    if (scoped.length < floorScoped)
      throw new Error(
        `scraped only ${scoped.length} literal search.* / card.* calls from ${f} ` +
          `(expected at least ${floorScoped}) — the call shape changed, so this check would pass by never firing`,
      );
    // Once per key: cards.tsx reads `card.untitled` four times, and one
    // missing key is one defect, not four copies of the same sentence.
    const keys = new Map();
    for (const [, ns, key] of scoped) keys.set(`${ns}|${key}`, [ns, key]);
    const missingBundle = new Set();
    for (const [ns, key] of keys.values())
      for (const loc of ["en", "he"]) {
        const b = bundle(loc, ns);
        if (!b) {
          if (!missingBundle.has(`${loc}/${ns}`))
            fail(`${f} reads namespace "${ns}", but locales/${loc}/${ns}.json does not exist.`);
          missingBundle.add(`${loc}/${ns}`);
        } else {
          for (const problem of keyProblems(b, key, loc)) fail(`locales/${loc}/${ns}.json ${problem} (used by ${f})`);
        }
      }
  }

  // Both directions, for every part this check adds to the shared reader.
  // The scope filter keeps the keys it exists for and drops their neighbours...
  for (const key of ["search.filteredMarket", "card.marketNote"])
    if (!IN_SCOPE.test(key)) fail(`check 31's scope filter drops "${key}", a key it exists to resolve`);
  for (const key of ["cards.title", "searching.now", "history.card", "tabs.search"])
    if (IN_SCOPE.test(key)) fail(`check 31's scope filter reads "${key}", which is outside search.* and card.*`);
  // ...the reader sees the two call shapes those keys are written in, a
  // counted call and an interpolated one...
  for (const probe of [
    't("search.filteredMarket", { count: market })',
    't("card.marketNote", { location: job.location })',
  ]) {
    CALL.lastIndex = 0;
    if (!CALL.test(probe))
      fail(`check 31's reader cannot see ${probe}, so the key behind it would be resolved against nothing`);
  }
  // ...and the lookup resolves a key that exists ONLY under its plural
  // suffixes, as every counted sentence does, while refusing a missing one.
  const jobsEn = bundle("en", "jobs");
  if (!jobsEn || !resolvesIn(jobsEn, "search.geoFiltered") || resolvesIn(jobsEn, "search.__no_such_key__"))
    fail("check 31's lookup cannot tell a counted key from a missing one in jobs.json, so it would pass for ever");
  // ...and a counted key is only as good as its plural set. `resolvesIn` accepts
  // a key when ANY suffixed form exists, while i18next 26 has no fallback to
  // `_other`: it tries the form the count selects, then the bare key, then the
  // fallback language. Measured on these bundles: with `filteredMarket_other`
  // gone a count of 3 renders the raw key in both locales, and with the Hebrew
  // `_two` gone a count of 2 renders the ENGLISH sentence on the Hebrew page.
  // Check 8 stays green on both, because it compares stems.
  const jobsHe = bundle("he", "jobs");
  const COUNTED = "search.filteredMarket";
  if (!jobsEn || !jobsHe || keyProblems(jobsEn, COUNTED, "en").length || keyProblems(jobsHe, COUNTED, "he").length)
    fail(`check 31 refuses the real ${COUNTED} plural sets, which are complete in both locales`);
  for (const [loc, b, form, harm] of [
    ["en", jobsEn, "other", "a count of 3 renders the raw key"],
    ["he", jobsHe, "two", "a count of 2 renders the English sentence"],
    ["he", jobsHe, "other", "a count of 3 renders the English sentence"],
  ])
    if (b && !keyProblems(withoutForm(b, COUNTED, form), COUNTED, loc).length)
      fail(`check 31 passes a ${loc} ${COUNTED} with no _${form} form, although ${harm}`);
  // ...while a plain interpolated key is never asked for plural forms.
  if (
    (jobsEn && keyProblems(jobsEn, "card.marketNote", "en").length) ||
    (jobsHe && keyProblems(jobsHe, "card.marketNote", "he").length)
  )
    fail("check 31 asks the plain card.marketNote for plural forms it does not need");

  // A passing `test` on a /g regex leaves `lastIndex` past the match, and
  // `matchAll` COPIES it, so the next `boundCalls` would start scraping at
  // that offset instead of at the top of its file. `boundCalls` now resets both
  // of its regexes itself (32(d) found BIND left at 47 by check 28's binding
  // probe), so this reset is a belt: it hands CALL back at zero to anything that
  // reads it directly after this check.
  CALL.lastIndex = 0;
} catch (e) {
  fail(`jobs copy check could not run: ${e.message}`);
}

// ---- 31, continued: the filtered banner says what its rows say ----------- //
// "Every job we found states a hiring restriction abroad" is a claim about EVERY
// row under it. Its guard used to list the other reasons one by one (`closed ===
// 0 && market === 0`), which goes false the moment a row arrives with a reason it
// does not list: a tab opened before a deploy, reading a newer backend's
// response, printed that sentence over rows that state no restriction at all.
// The defect `market` itself had one release earlier, one reason later.
//
// So the counting lives in `filteredSummary` (pages/jobs/shared.ts) and is
// EXECUTED here, check 17's mechanism, over every mix of up to two rows across
// the five shapes a response can carry: no `reason` (a pre-Phase-28 row, which
// IS a restriction), the three this build names, and one it has never heard of,
// each with and without a ranked match and a skipped posting. Then two source
// pins, because an executed helper the page does not call guards nothing: the
// page counts through it, and shows the "every job" sentence exactly when it
// says so, in that polarity.
try {
  const { filteredSummary } = runProbeBundle(
    "filtered-summary",
    'export { filteredSummary } from "./pages/jobs/shared";',
  );
  if (typeof filteredSummary !== "function") throw new Error("pages/jobs/shared.ts exports no filteredSummary");

  // "work_mode" and "not_remote" (2026-09-22) are two more reasons the build
  // names, each with its own counted sentence over the list.
  const SHAPES = [undefined, "restriction", "closed", "market", "work_mode", "not_remote", "some_future_reason"];
  const mixes = SHAPES.flatMap((a) => [[a], ...SHAPES.map((b) => [a, b])]);
  const wrong = [];
  for (const matches of [0, 1])
    for (const skipped of [0, 1])
      for (const reasons of mixes) {
        const got = filteredSummary({
          matches: Array(matches).fill({}),
          skipped,
          filtered: reasons.map((reason) => (reason === undefined ? {} : { reason })),
        });
        const restricted = reasons.filter((r) => r === undefined || r === "restriction").length;
        const want = {
          restricted,
          closed: reasons.filter((r) => r === "closed").length,
          market: reasons.filter((r) => r === "market").length,
          workMode: reasons.filter((r) => r === "work_mode").length,
          notRemote: reasons.filter((r) => r === "not_remote").length,
          // The sentence's own claim: nothing ranked, nothing skipped, and every
          // row under it states a restriction.
          everyRestricted: matches === 0 && skipped === 0 && restricted === reasons.length,
        };
        const off = Object.keys(want).filter((k) => got[k] !== want[k]);
        if (off.length)
          wrong.push(`${JSON.stringify({ matches, skipped, reasons })} gave ${off.map((k) => `${k}=${got[k]}`).join(", ")}`);
      }
  if (wrong.length)
    fail(
      `the Jobs page's filtered banner misdescribes its rows in ${wrong.length} of ${mixes.length * 4} mixes — ` +
        wrong.slice(0, 3).join("; "),
    );
  // The two directions this exists for, named so a regression reads as itself.
  const unknownMix = filteredSummary({
    matches: [],
    skipped: 0,
    filtered: [{ reason: "restriction" }, { reason: "some_future_reason" }],
  });
  if (unknownMix.everyRestricted)
    fail("the Jobs page says every job states a hiring restriction over a row whose reason this build has never heard of");
  const legacy = filteredSummary({ matches: [], skipped: 0, filtered: [{}, { reason: "restriction" }] });
  if (!legacy.everyRestricted || legacy.restricted !== 2)
    fail("the Jobs page stopped reading a row with no reason as the restriction it was dropped for");

  const page = decomment(read("pages/JobsPage.tsx"));
  if (!/\bfilteredSummary\(\s*searchResult\s*\)/.test(page))
    fail("JobsPage.tsx no longer counts its filtered banner through filteredSummary, so the pin above guards nothing it shows");
  // Polarity, not presence (checks 15 and 21): an inverted `!everyRestricted ?`
  // must not pass, while a destructured or a member read both may.
  const EVERY = /(?:^|[^!\w.])(?:\w+\.)?everyRestricted\s*\?\s*t\("search\.geoAllFiltered"\)/;
  if (!EVERY.test(page))
    fail("JobsPage.tsx no longer shows search.geoAllFiltered exactly when everyRestricted is true");
  for (const [probe, want] of [
    ['{everyRestricted ? t("search.geoAllFiltered")', true],
    ['{summary.everyRestricted ? t("search.geoAllFiltered")', true],
    ['{!everyRestricted ? t("search.geoAllFiltered")', false],
    ['{!summary.everyRestricted ? t("search.geoAllFiltered")', false],
  ])
    if (EVERY.test(probe) !== want) fail(`check 31's polarity pin reads ${probe} the wrong way round`);
} catch (e) {
  fail(`jobs banner check could not run: ${e.message}`);
}

// ---- 32(a). a public call to action is a sign-up door --------------------- //
// Phase 30 is login first: "All the buttons that let the user use the app first
// ask him to login or signup", the CV scan included. The landing and the
// marketing shell are the pages a signed-out visitor reads, and the production
// probe behind that decision (2026-09-15) found /scan fully usable from them
// with no account, and two "Tailor my resume" buttons on /app, which greets a
// NEW visitor with "Welcome back" instead of sign-up.
//
// Nothing watched where those links point. Check 9 is scoped to AppLayout.tsx,
// check 28 resolves the landing's copy but not its targets, and `tsc` sees
// nothing: a destination is a string. So a button pointed straight back at a
// feature route builds green and opens the feature to anyone.
//
// The walk is every .ts/.tsx under components/landing/ and components/marketing/,
// plus layouts/MarketingLayout.tsx and pages/Landing.tsx. Three rules:
//   1. A string target (`to="…"`, `to: "…"`, `href="/…"`, `href: "/…"`) is a
//      door a signed-out visitor may use as they are: /, /privacy, /login,
//      /signup, or /app (an "Open app" link for a returning user, whom
//      AppLayout's guard sends to /login), or an in-page `#` anchor.
//   2. A feature is reached through `signupFor("<route>")`, and that route,
//      stripped of `?…` and `#…`, is a destination App.tsx declares: never the
//      catch-all, never an auth page (safeNext refuses those as a `next` and
//      lands on /app), and never a redirect (a second trip through sign-up).
//   3. Any other `to={…}` or `to: …` fails unless it is a registered
//      pass-through: a component forwarding a `to` it was handed. A type
//      annotation (`to: string`) and a number (a keyframe's `to: 1`) are not
//      targets.
// Rule 1 cannot tell a call to action's /app from an "Open app" link's, so the
// two "Tailor my resume" buttons that moved from /app to /signup are not pinned
// here. Every link that names a FEATURE route is.
try {
  const { app, routes } = appRoutes();

  // Derived, never restated: the list safeNext itself refuses as a `next`.
  const authDecl = read("lib/safeNext.ts").match(/export const AUTH_PAGES\s*=\s*\[([^\]]*)\]/);
  if (!authDecl) throw new Error("could not find `export const AUTH_PAGES = [...]` in lib/safeNext.ts");
  const authPages = [...authDecl[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (!authPages.includes("/signup"))
    throw new Error(`read AUTH_PAGES as [${authPages.join(", ")}] from lib/safeNext.ts, with no /signup`);

  // The catch-all is itself a <Navigate>, so finding it proves this reads the shape.
  const redirects = [...app.matchAll(/<Route\s+path="([^"]+)"\s+element=\{\s*<Navigate\b/g)].map((m) => m[1]);
  if (!redirects.includes("*"))
    throw new Error("read no `<Route path=… element={<Navigate …>}>` redirects in App.tsx, not even the catch-all");

  const destinations = routes
    .filter((r) => r !== "*" && !authPages.includes(r) && !redirects.includes(r))
    .map(routePattern);

  const DOORS = new Set(["/", "/privacy", "/login", "/signup", "/app"]);
  // Keyed by file, so the same expression anywhere else is still refused.
  const PASS_THROUGH = {
    "components/landing/ui.tsx": ["to"],
    "components/landing/FeatureList.tsx": ["f.to"],
    "components/landing/LandingFaq.tsx": ["more.to"],
  };
  const QUOTED = /^(["'])(.*)\1$/;
  const SIGNUP = /^signupFor\(\s*(["'])(.*?)\1\s*\)$/;

  // THE HELPER ITSELF, and not only its name. Rule 2 reads the route inside
  // signupFor("…") and trusts the rest to the helper, so its BODY was the one
  // indirection nothing here looked at: changed to `return dest;`, every public
  // call to action becomes the bare feature route again and AppLayout's guard
  // greets a brand-new visitor with "Welcome back" — the exact defect the
  // 2026-09-15 production probe recorded. Measured on this tree before this
  // pin: with that one-line mutation in place, check-mirrors printed
  // "mirrors ok" and the build stayed green.
  const HELPER = "components/landing/ui.tsx";
  const signupHelper = (text) => {
    const m = text.match(
      /export function signupFor\(\s*(\w+)\s*:\s*string\s*\)\s*:\s*string\s*\{\s*return\s+withNext\(\s*"\/signup"\s*,\s*(\w+)\s*\)\s*;?\s*\}/,
    );
    return !!m && m[1] === m[2];
  };
  if (!signupHelper(decomment(read(HELPER))))
    fail(
      `${HELPER}: signupFor no longer reads \`return withNext("/signup", <its own argument>)\`. Every public ` +
        "call to action goes through it, so a body that hands back the bare route — or /login, or a fixed " +
        "destination — reopens the feature to a signed-out visitor with 32(a), check 9 and tsc all green.",
    );
  // Both directions on fixtures: the reader must read the shipped helper and
  // refuse each way the body can stop being a sign-up door.
  const HELPER_OK = 'export function signupFor(dest: string): string {\n  return withNext("/signup", dest);\n}\n';
  if (!signupHelper(HELPER_OK)) fail("check 32(a)'s signupFor reader cannot read the shipped helper");
  for (const [label, mutant] of [
    ["a body that hands back the bare route", HELPER_OK.replace('withNext("/signup", dest)', "dest")],
    ["a body that sends the visitor to /login", HELPER_OK.replace('"/signup"', '"/login"')],
    ["a body that drops the destination", HELPER_OK.replace(", dest)", ', "/app")')],
    ["a body that forwards some other value", HELPER_OK.replace("(dest: string)", "(dest: string, other: string)").replace(", dest)", ", other)")],
  ])
    if (signupHelper(mutant)) fail(`check 32(a)'s signupFor reader accepts ${label}`);

  /** The text inside the `{…}` that opens at `open`, skipping braces in strings. */
  const braced = (src, open) => {
    let depth = 0;
    let quote = null;
    for (let i = open; i < src.length; i++) {
      const c = src[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return src.slice(open + 1, i);
    }
    throw new Error("unbalanced `to={…}` expression");
  };

  /** Every link target in one source, judged by the three rules. */
  const judgeTargets = (label, raw) => {
    const src = decomment(raw);
    const out = { targets: 0, passes: [], problems: [] };
    const literal = (value, shape) => {
      out.targets++;
      if (!DOORS.has(value) && !value.startsWith("#"))
        out.problems.push(
          `${label}: ${shape} sends a signed-out visitor straight to "${value}". A public link that ` +
            'starts a feature is a sign-up door, signupFor("<route>") from components/landing/ui.tsx; ' +
            "only /, /privacy, /login, /signup, /app and #anchors are linked directly.",
        );
    };
    const signup = (dest) => {
      out.targets++;
      const bare = dest.replace(/[?#].*$/, "");
      if (!destinations.some((re) => re.test(bare)))
        out.problems.push(
          `${label}: signupFor("${dest}") names no destination App.tsx routes, so after signing up ` +
            "the visitor lands on the catch-all, on /app (an auth page is refused as `next`) or back " +
            "in sign-up (a redirect). Name the feature's own <Route path>.",
        );
    };
    const expression = (expr, shape) => {
      const e = expr.trim();
      let m;
      if ((m = e.match(QUOTED))) return literal(m[2], shape);
      if ((m = e.match(SIGNUP))) return signup(m[2]);
      out.targets++;
      if ((PASS_THROUGH[label] || []).includes(e)) out.passes.push(e);
      else
        out.problems.push(
          `${label}: ${shape} links through \`${e}\`, which this check cannot read. Use a string ` +
            '(/, /privacy, /login, /signup, /app or a #anchor) or signupFor("<route>"); a component ' +
            "that forwards a `to` it was handed is registered in check 32(a)'s PASS_THROUGH.",
        );
    };

    for (const m of src.matchAll(/\bto=(["'])(.*?)\1/g)) literal(m[2], `to="${m[2]}"`);
    for (const m of src.matchAll(/\bhref(?:=|:\s*)(["'])(\/.*?)\1/g)) literal(m[2], `href "${m[2]}"`);
    for (const m of src.matchAll(/\bto=\{/g)) {
      const e = braced(src, m.index + m[0].length - 1);
      expression(e, `to={${e.trim()}}`);
    }
    // `to:` with no space before the colon is a property or a type annotation.
    // A ternary (`ok ? to : "/signup"`) is spaced, and is not read as either.
    for (const m of src.matchAll(/\bto\??:[ \t]*([^,;}\n]*)/g)) {
      const value = m[1].trim();
      if (/^string\b/.test(value) || /^-?\d/.test(value)) continue;
      expression(value, `to: ${value}`);
    }
    return out;
  };

  // [path under src/, how many of its files must carry a link target]. A floor
  // counts only files that carry one: most of the landing is canvas and copy.
  const WALK = [
    ["components/landing", 8],
    ["components/marketing", 1],
    ["layouts/MarketingLayout.tsx", 1],
    ["pages/Landing.tsx", 0],
  ];
  const seenPasses = {};
  for (const [entry, floor] of WALK) {
    const full = path.join(SRC, entry);
    const files = [];
    if (fs.statSync(full).isDirectory())
      (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (/\.tsx?$/.test(e.name)) files.push(p);
        }
      })(full);
    else files.push(full);
    let carrying = 0;
    for (const f of files) {
      const label = path.relative(SRC, f).split(path.sep).join("/");
      const judged = judgeTargets(label, fs.readFileSync(f, "utf8"));
      if (judged.targets) carrying++;
      seenPasses[label] = judged.passes;
      for (const p of judged.problems) fail(p);
    }
    if (carrying < floor)
      throw new Error(
        `only ${carrying} file(s) under ${entry} carry a link target (expected at least ${floor}), ` +
          "so the walk or the link shape changed and the rules are reading nothing",
      );
  }
  // A stale registration is either dead weight or the sign that a component's
  // link prop was renamed, which leaves every link through it unread.
  for (const [file, exprs] of Object.entries(PASS_THROUGH))
    for (const e of exprs)
      if (!(seenPasses[file] || []).includes(e))
        fail(
          `check 32(a) registers \`to={${e}}\` in ${file}, which no longer has it. Remove the entry, ` +
            "or the link prop was renamed and every link through it is now unread.",
        );

  // Both directions, on every build: each rule must fire on the shape it forbids
  // and stay quiet on the shape it allows, or it passes for ever by never firing.
  const PROBES = [
    ['<Cta to="/scan">', false],
    ['<Cta to={signupFor("/tools/scann")}>', false],
    ['<Link to="/privacy">', true],
    ['{ key: "interview", to: signupFor("/interview"), icon: MessagesSquare }', true],
    ['<Cta to={signupFor("/interview?from=landing#top")}>', true],
    ['<Cta to={signupFor("/login")}>', false],
    ['<Cta to={signupFor("/home")}>', false],
    ['<a href="/jobs">', false],
    ['{ href: "/jobs", key: "header.jobs" }', false],
    ['<Link to="#faq">', true],
    ["<Cta to={SCAN_URL}>", false],
    ["<Link to={f.to}>", false],
  ];
  for (const [src, allowed] of PROBES) {
    const { targets, problems } = judgeTargets("probe.tsx", src);
    if (!targets) fail(`check 32(a) reads no link target in its own probe ${src}`);
    else if (allowed && problems.length) fail(`check 32(a) fires on a link it must allow: ${src}`);
    else if (!allowed && !problems.length) fail(`check 32(a) cannot detect its own defect shape: ${src}`);
  }
  if (judgeTargets("probe.tsx", "interface P { to: string; more?: { to: string } }").targets)
    fail("check 32(a) reads a type annotation as a link target");
  if (judgeTargets("probe.tsx", 'const dest = ok ? to : "/scan";').targets)
    fail("check 32(a) reads a ternary as a `to:` property");
} catch (e) {
  fail(`public link target check could not run: ${e.message}`);
}

// ---- 32(b). every monthly-use feature has a name in both locales ---------- //
// Phase 30 gives every account one shared pool of monthly uses, and the Settings
// plan card spells out where this month's went: `uses.features.<id>` per
// feature, "Tailored jobs 3 · Job searches 2". The ids are declared in PYTHON,
// as `quota.FEATURES`, so tsc cannot see a new one, and check 8 stays green
// while a name is missing from BOTH locales: a new charge would print
// "uses.features.x" at 12px in Hebrew on the one card whose job is to say what
// a use was spent on.
//
// Read with check 26's line grammar, which is why FEATURES is written one entry
// per line. Floor 13, today's count: a parser that stopped matching reads
// nothing, and nothing then goes red.
//
// Degrades only when backend/ is ABSENT. A backend/ without app/core/quota.py is
// a red build (pySource): that is a file that moved.
const CLAUSE = /[,;،]/;
try {
  const src = pySource("app/core/quota.py", "check 32(b)");
  if (src !== null) {
    const ids = pyTuple(src, "FEATURES", "quota.py");
    if (ids.length < 13)
      throw new Error(`quota.py's FEATURES parsed as ${ids.length} entries (expected at least 13)`);
    const seen = new Set();
    const dupes = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    if (dupes.length)
      fail(`quota.py lists ${[...new Set(dupes)].map((i) => `\`${i}\``).join(", ")} in FEATURES more than once.`);
    // The plan card renders "<label> <count>" and joins the rows with " · ",
    // so a label that is a CLAUSE swallows the number it is handed: "Screening
    // answers, extension autofill included 3 · Job searches 2" reads as a
    // sentence about the extension rather than as this month's three (measured
    // in both locales). A feature name is a NAME; anything it needs to add goes
    // in its own line, which is where uses.plan.screeningNote now is.
    const labelAt = (cat, id) => `uses.features.${id}`.split(".").reduce((o, k) => (o == null ? o : o[k]), cat);
    for (const loc of ["en", "he"]) {
      const common = JSON.parse(read(`locales/${loc}/common.json`));
      const missing = ids.filter((id) => !resolvesIn(common, `uses.features.${id}`));
      if (missing.length)
        fail(
          `locales/${loc}/common.json: uses.features.{${missing.join(", ")}} missing — the plan card would ` +
            "print the raw key as the name of what a use was spent on. Check 8 stays green while both " +
            "locales are equally wrong.",
        );
      const clause = ids.filter((id) => CLAUSE.test(String(labelAt(common, id) ?? "")));
      if (clause.length)
        fail(
          `locales/${loc}/common.json: uses.features.{${clause.join(", ")}} reads as a clause rather than a ` +
            "name, and the plan card appends this month's count straight onto it, so the number is read as " +
            "part of the sentence. Keep the label a name and give the rest its own line.",
        );
    }
  }
  // The clause reader, both directions: it must fire on the label that shipped
  // and stay quiet on the name that replaced it, or "keep the labels short" is
  // satisfied by a detector that never fires.
  if (!CLAUSE.test("Screening answers, extension autofill included") || CLAUSE.test("Screening answers"))
    fail("check 32(b)'s clause detector cannot tell a label that is a clause from one that is a name");
  if (!CLAUSE.test("תשובות סינון, כולל מילוי אוטומטי בתוסף") || CLAUSE.test("תשובות סינון"))
    fail("check 32(b)'s clause detector does not read the Hebrew label the same way");
  // The reader, both directions, on FEATURES' own shape: a comment on the
  // opening line and a comment between entries are read past, and two entries
  // packed onto one line are refused rather than half-read.
  const probe =
    'FEATURES = (   # one quoted entry per line (32(b))\n    "tailor",\n    # a note with "quotes" (and parens)\n    "scan",\n)\n';
  if (pyTuple(probe, "FEATURES", "probe.py").join() !== "tailor,scan")
    fail("check 32(b)'s tuple reader cannot read FEATURES' own shape (a comment on the opening line)");
  let packed = false;
  try {
    pyTuple('FEATURES = (\n    "tailor", "scan",\n)\n', "FEATURES", "probe.py");
  } catch {
    packed = true;
  }
  if (!packed) fail("check 32(b)'s tuple reader half-reads two entries packed onto one line instead of refusing them");
  // The loader's rule, in the direction that matters: with backend/ present, a
  // file that is not there is an error, never a skip.
  if (fs.existsSync(BACKEND_DIR)) {
    let refused = false;
    try {
      pySource("app/core/__check_mirrors_no_such_file__.py", "check 32(b)'s loader probe");
    } catch {
      refused = true;
    }
    if (!refused)
      fail("pySource skips a file backend/ does not have, so a moved quota.py would switch check 32(b) off silently");
  }
} catch (e) {
  fail(`monthly-use feature name check could not run: ${e.message}`);
}

// ---- 32(c). a monthly-limit refusal says when uses come back (EXECUTED) ---- //
// Phase 30's 429 `monthly_limit` carries the numbers a sentence needs:
// `{code, feature, plan, limit, used, remaining, resets_on}`. Through the old
// table it fell to the caller's generic failure line (or, read as the daily cap,
// "try again tomorrow", which is false for a month), and `isSessionEnded` must
// not read it as a dead session either, or /verify's "log in again" state would
// answer a spent month.
//
// Four new daily caps arrive with it (upload, jd_analyze, search_context and the
// scan's own), and each needs its own line: an action the table does not name
// falls back to the generic sentence, which is the defect LIMIT_KEYS was written
// to stop ("you're out of searches" said to someone who hit another cap).
//
// EXECUTED, F5's mechanism, with an i18n stub that RECORDS what it is asked, so
// the probe sees the month and the date the sentence is handed, not just its key.
try {
  const asked = [];
  const commonKeys = new Set();
  const i18nStub = {
    __esModule: true,
    language: "en",
    t: (key, opts) => {
      asked.push([key, opts || {}]);
      if (opts?.ns === "common") commonKeys.add(key);
      return `T:${key}`;
    },
  };
  i18nStub.default = i18nStub;
  const ae = runProbeBundle("apierror-uses", `export * from "./lib/apiError";\n`, { "../i18n": i18nStub });
  for (const name of ["apiErrorMessage", "isSessionEnded"])
    if (typeof ae[name] !== "function") throw new Error(`lib/apiError.ts no longer exports ${name}`);
  const err = (status, detail) => ({ response: { status, data: { detail } } });
  const LIMIT = {
    code: "monthly_limit",
    feature: "tailor",
    plan: "free",
    limit: 10,
    used: 10,
    remaining: 0,
    resets_on: "2026-10-01",
  };
  const render = (e) => {
    asked.length = 0;
    const text = ae.apiErrorMessage(e, "FALLBACK");
    const last = asked[asked.length - 1] || [undefined, {}];
    return { text, opts: last[1] };
  };

  const spent = render(err(429, LIMIT));
  if (spent.text !== "T:uses.limitReached" || spent.opts.ns !== "common") {
    fail(
      `a 429 monthly_limit renders ${JSON.stringify(spent.text)} instead of common's "uses.limitReached" — ` +
        "the user is told something failed, or that a daily cap resets tomorrow, when the month's uses ran out.",
    );
  } else {
    if (!/Sep/i.test(spent.opts.month ?? "") || !/Oct/i.test(spent.opts.date ?? "") || !/\b1\b/.test(spent.opts.date ?? ""))
      fail(
        `for resets_on 2026-10-01 the monthly-limit sentence is handed month=${JSON.stringify(spent.opts.month)} ` +
          `and date=${JSON.stringify(spent.opts.date)}; it must name the month that ran out (September) and ` +
          "the day uses come back (October 1).",
      );
    // December rolls into January: the month that ran out is the one BEFORE resets_on.
    const dec = render(err(429, { ...LIMIT, resets_on: "2027-01-01" }));
    if (!/Dec/i.test(dec.opts.month ?? "") || !/Jan/i.test(dec.opts.date ?? ""))
      fail(
        `for resets_on 2027-01-01 the sentence is handed month=${JSON.stringify(dec.opts.month)} and ` +
          `date=${JSON.stringify(dec.opts.date)}; it must be December and January 1.`,
      );
    i18nStub.language = "he";
    const he = render(err(429, LIMIT));
    i18nStub.language = "en";
    const HEBREW = /[֐-׿]/;
    if (!HEBREW.test(he.opts.month ?? "") || !HEBREW.test(he.opts.date ?? ""))
      fail(
        `in Hebrew the monthly-limit sentence is handed month=${JSON.stringify(he.opts.month)} and ` +
          `date=${JSON.stringify(he.opts.date)}; both must be formatted in Hebrew, or an English month name ` +
          "lands in the middle of a right-to-left sentence.",
      );
  }
  // No readable date is still the monthly limit, and never "More on ." or an Invalid Date.
  const bare = render(err(429, { ...LIMIT, resets_on: "" }));
  if (
    !/^T:uses\./.test(bare.text) ||
    (bare.text === "T:uses.limitReached" && !bare.opts.date) ||
    /Invalid|NaN|undefined/.test(JSON.stringify(bare.opts))
  )
    fail(
      `a monthly_limit with no resets_on renders ${JSON.stringify(bare.text)} with ${JSON.stringify(bare.opts)}; ` +
        "it must still be a uses.* sentence, and one that promises no date it does not have.",
    );

  if (typeof ae.isMonthlyLimit !== "function") {
    fail("lib/apiError.ts exports no isMonthlyLimit, so a page cannot tell a spent month from any other refusal");
  } else {
    if (!ae.isMonthlyLimit(err(429, LIMIT))) fail("isMonthlyLimit misses a 429 monthly_limit");
    for (const [label, e] of [
      ["the daily cap", err(429, { code: "daily_limit", action: "tailor", cap: 3 })],
      ["a sign-in throttle", err(429, { code: "too_many_attempts", retry_after: 30 })],
      ["a dropped connection", { message: "Network Error" }],
    ])
      if (ae.isMonthlyLimit(e)) fail(`isMonthlyLimit fires on ${label}, which is not the monthly limit`);
  }
  if (ae.isSessionEnded(err(429, LIMIT)))
    fail("isSessionEnded reads a spent month as a dead session, so /verify would ask a signed-in account to log in again");

  // The predicate a session pass's own count rests on (Phase 30 review, known
  // item 5). `pass_charged` runs AFTER the handler's own checks, so a 5xx is
  // the only failure that can have spent a slot: a 400, a 422, the gate's
  // 401/403, a daily-cap 429 and a request that never got a response all left
  // the pass untouched. Measured before this existed: `isMonthlyLimit` is false
  // for every one of them, so the cover letter's `else` branch lowered its
  // remaining changes on all of them — and at 0 uses left a local count
  // reaching 0 DISABLES Generate, on a call the server would still have
  // included for free. Check 30 pins the branch; this pins the predicate.
  if (typeof ae.isServerFailure !== "function") {
    fail(
      "lib/apiError.ts exports no isServerFailure, so a caller holding a session pass cannot tell a failure " +
        "raised inside the pass from a refusal the pass never saw",
    );
  } else {
    for (const [label, e] of [
      ["a 502 raised inside the pass", err(502, "Cover letter failed.")],
      ["a 503", err(503, "Unavailable.")],
    ])
      if (!ae.isServerFailure(e)) fail(`isServerFailure misses ${label}, so a slot the pass really spent is never counted`);
    for (const [label, e] of [
      ["a 422 refused before the pass", err(422, [{ msg: "field required" }])],
      ["a 400 from the handler's own checks", err(400, "Job description required.")],
      ["the gate's 401", err(401, "Access code required.")],
      ["a 403", err(403, { code: "email_unverified" })],
      ["the daily cap", err(429, { code: "daily_limit", action: "tailor", cap: 3 })],
      ["a spent month", err(429, LIMIT)],
      ["a dropped connection", { message: "Network Error" }],
    ])
      if (ae.isServerFailure(e))
        fail(
          `isServerFailure fires on ${label}, which never reached the pass — counting it can disable a call ` +
            "the server would have served",
        );
  }

  // The daily cap keeps its own line beside the monthly one.
  const dailyTailor = render(err(429, { code: "daily_limit", action: "tailor", cap: 3 }));
  if (dailyTailor.text !== "T:dailyLimit.tailor")
    fail(`the daily tailor cap now renders ${JSON.stringify(dailyTailor.text)} instead of dailyLimit.tailor`);

  // Phase 30's five daily caps: each its own sentence, none the generic one.
  const lines = new Map();
  for (const action of ["upload", "jd_analyze", "search_context", "scan", "fetch"]) {
    const got = render(err(429, { code: "daily_limit", action, cap: 5 })).text;
    if (!/^T:dailyLimit\./.test(got) || got === "T:dailyLimit.generic")
      fail(
        `the daily "${action}" cap renders ${JSON.stringify(got)}: lib/apiError.ts's LIMIT_KEYS must name it ` +
          "(B4.6), or the user reads the generic line.",
      );
    else if ([...lines.values()].includes(got)) fail(`the daily "${action}" cap shares ${got} with another action`);
    lines.set(action, got);
  }
  // …and the false-positive half: an action this build has never heard of is
  // still the generic line, never another action's sentence.
  const unknown = render(err(429, { code: "daily_limit", action: "some_future_cap", cap: 5 })).text;
  if (unknown !== "T:dailyLimit.generic")
    fail(`a daily cap this build has never heard of renders ${JSON.stringify(unknown)} instead of dailyLimit.generic`);

  // Every common key the probe was handed resolves in both locales.
  for (const loc of ["en", "he"]) {
    const common = JSON.parse(read(`locales/${loc}/common.json`));
    for (const key of commonKeys)
      if (!resolvesIn(common, key))
        fail(`locales/${loc}/common.json is missing "${key}" (rendered by lib/apiError.ts) — the refusal would show the raw key.`);
  }
} catch (e) {
  fail(`monthly-limit message probe could not run: ${e.message}`);
}

// ---- 32(c), continued: a Google refusal says what happened (EXECUTED) ------ //
// Continue with Google comes back to /login or /signup as `?google=<code>`
// (Phase 30 E2). That is a redirect, so the code arrives with no JSON detail and
// never passes through `apiErrorMessage`: `googleErrorMessage` reads its own
// table, GOOGLE_ERROR_KEYS. Its own and not AUTH_ERROR_KEYS, because two of the
// callback's codes (`expired`, `signup_closed`) already name other sentences
// there, and one object literal cannot hold both.
//
// The code is read from an address anyone can type, so an unknown one, and one
// named after something every object inherits, must land on the generic
// sentence. A plain `TABLE[code]` hands i18next Object's own `constructor` for
// `?google=constructor`.
//
// Beside it, the three account sentences Phase 30 adds to the ordinary path:
// `password_not_set` (a Google-only account has no password to change, E4),
// `google_disabled` (the start route before sign-in is configured), and a failed
// password login, which names Continue with Google only on a server offering it.

/** `[code, key]` for every entry of lib/apiError.ts's GOOGLE_ERROR_KEYS, read as
 * a literal. ONE reader, shared by 32(c) and 32(g), for `resolvesIn`'s reason.
 * Throws on a line inside the table it cannot read, so a changed shape is a
 * loud failure rather than a shorter list. */
function googleErrorTable(source) {
  const body = blockAfter(decomment(source ?? read("lib/apiError.ts")), "const GOOGLE_ERROR_KEYS", "GOOGLE_ERROR_KEYS");
  const entries = [];
  for (const raw of body.split("\n")) {
    const line = raw.replace(/\s\/\/.*$/, "").trim();
    if (!line) continue;
    const m = /^"?([a-z][a-z_]*)"?\s*:\s*"([^"]+)"\s*,?$/.exec(line);
    if (!m) throw new Error(`GOOGLE_ERROR_KEYS has a line check 32 cannot read: ${line}`);
    entries.push([m[1], m[2]]);
  }
  return entries;
}

try {
  const TABLE_PROBE =
    "const GOOGLE_ERROR_KEYS: Record<string, string> = {\n  // a note, not a row\n" +
    '  expired: "errors.google.expired",\n  too_many_attempts: "errors.google.too_many_attempts", // E3\n};\n';
  if (googleErrorTable(TABLE_PROBE).map(([c]) => c).join() !== "expired,too_many_attempts")
    fail("check 32(c)'s GOOGLE_ERROR_KEYS reader misreads a table with a comment line and a trailing comment");
  let refused = false;
  try {
    googleErrorTable('const GOOGLE_ERROR_KEYS = {\n  ...OTHER_KEYS,\n  expired: "errors.google.expired",\n};\n');
  } catch {
    refused = true;
  }
  if (!refused) fail("check 32(c)'s GOOGLE_ERROR_KEYS reader skips a row it cannot read instead of refusing it");

  const asked = [];
  const i18nStub = {
    __esModule: true,
    language: "en",
    t: (key, opts) => {
      asked.push([key, opts || {}]);
      return `T:${key}`;
    },
  };
  i18nStub.default = i18nStub;
  const ae = runProbeBundle("apierror-google", `export * from "./lib/apiError";\n`, { "../i18n": i18nStub });
  const authKeys = new Set();
  /** What `fn` rendered, and the namespace of the last key it asked for. */
  const say = (fn) => {
    asked.length = 0;
    const text = fn();
    // Strings only: a table read as `TABLE[code]` hands i18next a FUNCTION for
    // `?google=constructor`, and collecting that would make the resolve loop
    // below throw, reporting "could not run" in place of the real defect.
    for (const [key, opts] of asked) if (opts.ns === "auth" && typeof key === "string") authKeys.add(key);
    return { text, ns: (asked[asked.length - 1] || [undefined, {}])[1].ns };
  };
  const err = (status, detail) => ({ response: { status, data: { detail } } });

  const table = googleErrorTable();
  if (table.length < 14)
    throw new Error(`read only ${table.length} rows out of GOOGLE_ERROR_KEYS; the Google callback sends 14 codes (spec F3)`);
  if (typeof ae.googleErrorMessage !== "function") {
    fail("lib/apiError.ts exports no googleErrorMessage, so /login?google=<code> has nothing to say what happened with");
  } else {
    const generic = say(() => ae.googleErrorMessage("a_code_this_build_has_never_heard_of"));
    if (!/^T:errors\.google\./.test(generic.text) || generic.ns !== "auth")
      fail(
        `googleErrorMessage falls back to ${JSON.stringify(generic.text)}; an unknown code must get a generic ` +
          "errors.google.* sentence from auth.json, never the raw code.",
      );
    for (const [code, key] of table) {
      const got = say(() => ae.googleErrorMessage(code));
      if (got.text !== `T:${key}` || got.ns !== "auth")
        fail(`googleErrorMessage("${code}") renders ${JSON.stringify(got.text)}, not auth's "${key}" from its own table.`);
      if (got.text === generic.text)
        fail(`googleErrorMessage("${code}") renders the generic fallback, so the table row for it does nothing.`);
    }
    // The false-positive half of "falls back": hostile codes from a hand-typed URL.
    for (const hostile of ["", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
      let got;
      try {
        got = say(() => ae.googleErrorMessage(hostile));
      } catch (e) {
        fail(`googleErrorMessage(${JSON.stringify(hostile)}) throws (${e.message}); /login?google=${hostile} would break the page.`);
        continue;
      }
      if (got.text !== generic.text)
        fail(
          `googleErrorMessage(${JSON.stringify(hostile)}) renders ${JSON.stringify(got.text)} instead of the generic ` +
            "sentence: a ?google= value anyone can type reaches a property every object inherits.",
        );
    }
  }

  for (const [label, e, want] of [
    ["a Google-only account asked to change its password", err(400, { code: "password_not_set" }), "T:errors.passwordNotSet"],
    ["the start route before sign-in is configured", err(404, { code: "google_disabled" }), "T:errors.google.disabled"],
  ]) {
    const got = say(() => ae.apiErrorMessage(e, "FALLBACK"));
    if (got.text !== want)
      fail(`${label} renders ${JSON.stringify(got.text)}, not ${want}: AUTH_ERROR_KEYS must map it (spec F3).`);
  }

  if (typeof ae.loginErrorMessage !== "function") {
    fail("lib/apiError.ts exports no loginErrorMessage, so a failed password login cannot mention Continue with Google");
  } else {
    const wrong = err(400, { code: "invalid_credentials" });
    const offered = say(() => ae.loginErrorMessage(wrong, true, "FALLBACK")).text;
    if (offered !== "T:errors.invalidCredentialsGoogle")
      fail(
        `a failed password login on a server offering Google renders ${JSON.stringify(offered)}, not ` +
          "errors.invalidCredentialsGoogle: someone who signed up with Google is told only that the password is wrong.",
      );
    // The twin: no Google on this server, no Google in the sentence.
    const plain = say(() => ae.loginErrorMessage(wrong, false, "FALLBACK")).text;
    if (plain !== "T:errors.invalidCredentials")
      fail(`a failed password login with Google off renders ${JSON.stringify(plain)}, not errors.invalidCredentials`);
    // Every other refusal reads exactly as apiErrorMessage reads it.
    for (const e of [err(429, { code: "too_many_attempts", retry_after: 120 }), err(403, { code: "email_unverified" }), { message: "Network Error" }]) {
      const viaLogin = say(() => ae.loginErrorMessage(e, true, "FALLBACK")).text;
      const viaApi = say(() => ae.apiErrorMessage(e, "FALLBACK")).text;
      if (viaLogin !== viaApi)
        fail(`loginErrorMessage renders ${JSON.stringify(viaLogin)} where apiErrorMessage renders ${JSON.stringify(viaApi)}`);
    }
  }

  // Every auth key the probe was handed resolves in both locales.
  for (const loc of ["en", "he"]) {
    const auth = JSON.parse(read(`locales/${loc}/auth.json`));
    for (const key of authKeys)
      if (!resolvesIn(auth, key))
        fail(`locales/${loc}/auth.json is missing "${key}" (rendered by lib/apiError.ts); the page would show the raw key.`);
  }
} catch (e) {
  fail(`Google refusal message probe could not run: ${e.message}`);
}

// ---- 32(d). every monthly-uses sentence resolves in both locales ----------- //
// Phase 30 prices each counted control where it sits: a line under the button
// ("This uses 1 of the 3 you have left this month"), one in the account menu,
// the alerts card's paused line, the kit batch's cap, the cover letter's
// changes and the Settings plan card. Every one is a `uses.*` key in
// common.json, and NOTHING resolved them against the code that reads them:
// check 8 is parity-only, so a key missing from en AND he is green; 16 and 22
// read tailor.json, 28 the landing, 29 the account pages, 31 the Jobs page's
// search.* / card.*; and 32(c) executes lib/apiError.ts but sees only the keys
// its own probe reaches. A missing key renders raw at 12px under the very
// button it prices, in Hebrew.
//
// The same reader as 28, 29 and 31 (`boundCalls`), so each call is looked up in
// the namespace its own binding names, and a `uses.*` key read through a binding
// to any OTHER namespace fails: C8 puts every one in common.json, so a
// component bound to `jobs` reads them through a separately named
// `useTranslation()` binding. lib/apiError.ts has no binding (it calls
// `i18n.t("uses.…", { ns: "common" })`) and has its own matcher.
//
// Counted keys are held to their whole plural set by the shared `keyProblems`:
// the batch cap is `_one` / `_other` in English and `_one` / `_two` / `_other`
// in Hebrew, and a missing Hebrew `_two` puts the English sentence on the
// Hebrew page for a batch of two.
//
// PER-FILE FLOORS, for check 22's reason. And EVERY file that reads a `uses.*`
// key must be registered: the source tree is walked, check 29's way, so a new
// surface reading one fails until it is in the table instead of shipping
// guarded by nothing. `t("common:uses.…")`, the key-prefixed spelling, is
// refused outright, because no scrape here can see it.
try {
  // [file, floor on its literal uses.* calls, keys it must keep reading].
  // Floors sit just under what each file carries, check 29's convention.
  const FILES = [
    ["components/UsesNote.tsx", 8, []],
    // The account line and, since PLAN 31.2/8, the phone header's uses left.
    ["layouts/AppLayout.tsx", 3, ["uses.headerLeft", "uses.headerNone"]],
    ["pages/jobs/AlertsCard.tsx", 3, []],
    // The first-run sheet (PLAN 31.5/2): each choice's cost and the account's count.
    ["components/FirstRunSheet.tsx", 2, ["uses.oneUse", "uses.account"]],
    // The Settings plan card (C6).
    ["pages/SettingsPage.tsx", 5, []],
    // `uses.batchCap` by name: the cap is what keeps a batch from asking for
    // more uses than are left, and its sentence is the one place that says so.
    ["pages/jobs/kits.tsx", 1, ["uses.batchCap"]],
    ["components/CoverLetter.tsx", 1, []],
    // The overlay's line before a reading, required BY NAME: that state had no
    // line at all once (Phase 30 review, known item 4). Since PLAN 31.3/1 it
    // has one button, Check fit, and `uses.fitThenTailor` prices it AND says
    // what it buys, the tailor that follows. Its predecessor, `fitOrTailor`,
    // priced two buttons the dialog no longer offers side by side.
    ["components/TailorOverlay.tsx", 1, ["uses.fitThenTailor"]],
    // The job page's Tailor (PLAN 31.4): it opens the tailor dialog, whose first
    // step is the fit check, so it is priced by the same sentence, by name.
    ["pages/JobPage.tsx", 1, ["uses.fitThenTailor"]],
    // The review panel's own zero line, required by name for the same reason:
    // the generic one lists "the review" among what stays free, directly under
    // the one button in that panel that spends.
    ["components/ReviewPanel.tsx", 2, ["uses.outRewrites"]],
  ];
  const API_ERROR = "lib/apiError.ts";
  const API_FLOOR = 2;
  // The fewest source files src/ can hold before the walk is reading the wrong
  // place: a tree that moved would otherwise walk nothing and pass for ever.
  const WALK_FLOOR = 120;
  const IS_USES = /^uses\./;
  const SURFACE = "the note beside a counted control";
  const common = {
    en: JSON.parse(read("locales/en/common.json")),
    he: JSON.parse(read("locales/he/common.json")),
  };

  /** Every reason the `uses.*` calls among `calls` ([file, ns, key]) cannot render. */
  const usesProblems = (calls) => {
    const out = [];
    const seen = new Set();
    for (const [f, ns, key] of calls) {
      if (!IS_USES.test(key)) continue;
      if (ns !== "common") {
        out.push(
          `${f} reads "${key}" through a binding to "${ns}", but every uses.* key lives in common.json — ` +
            "read it through a separately named useTranslation() binding, or it renders the raw key.",
        );
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      for (const loc of ["en", "he"])
        for (const p of keyProblems(common[loc], key, loc, SURFACE))
          out.push(`locales/${loc}/common.json ${p} (used by ${f})`);
    }
    return out;
  };

  for (const [f, floor, required] of FILES) {
    let uses;
    try {
      uses = boundCalls(f, 0).filter(([, , key]) => IS_USES.test(key));
    } catch (e) {
      fail(`check 32(d) cannot read ${f}: ${e.message}`);
      continue;
    }
    if (uses.length < floor)
      fail(
        `scraped only ${uses.length} literal uses.* calls from ${f} (expected at least ${floor}) — its notes ` +
          "went dark, or the call shape changed and this check would pass by never firing.",
      );
    for (const key of required)
      if (!uses.some(([, , k]) => k === key))
        fail(`${f} no longer reads "${key}" through a common binding, so its sentence is guarded by nothing here.`);
    for (const p of usesProblems(uses)) fail(p);
  }

  // lib/apiError.ts: no binding, a namespace option instead.
  const API_CALL = /\bi18n\.t\(\s*"(uses\.[A-Za-z][\w.]*)"\s*,\s*\{\s*ns:\s*"(\w+)"/g;
  const ANY_USES = /"uses\.[A-Za-z][\w.]*"/g;
  const apiSrc = decomment(read(API_ERROR));
  const apiCalls = [...apiSrc.matchAll(API_CALL)].map((m) => [API_ERROR, m[2], m[1]]);
  const spelled = (apiSrc.match(ANY_USES) || []).length;
  if (apiCalls.length < API_FLOOR)
    fail(
      `scraped only ${apiCalls.length} i18n.t("uses.…", { ns }) calls from ${API_ERROR} ` +
        `(expected at least ${API_FLOOR}) — the call shape changed.`,
    );
  if (spelled > apiCalls.length)
    fail(
      `${API_ERROR} spells ${spelled - apiCalls.length} uses.* key(s) in a shape check 32(d) cannot read — it ` +
        'reads i18n.t("uses.…", { ns: "…", … }) with the namespace first.',
    );
  for (const p of usesProblems(apiCalls)) fail(p);

  // Every file that reads a uses.* key is registered above.
  const PREFIXED = /["'`]common:uses\./;
  const USES_CALL = /\b\w+\(\s*"uses\.[A-Za-z]/;
  const registered = new Set([...FILES.map(([f]) => f), API_ERROR]);
  const walk = (dir) =>
    fs.readdirSync(dir ? path.join(SRC, ...dir.split("/")) : SRC, { withFileTypes: true }).flatMap((d) => {
      const rel = dir ? `${dir}/${d.name}` : d.name;
      if (d.isDirectory()) return d.name === "locales" ? [] : walk(rel);
      return /\.tsx?$/.test(d.name) ? [rel] : [];
    });
  const sources = walk("");
  if (sources.length < WALK_FLOOR)
    throw new Error(`walked only ${sources.length} source files under src/ (expected at least ${WALK_FLOOR}) — the tree moved`);
  for (const f of sources) {
    const src = decomment(read(f));
    if (PREFIXED.test(src))
      fail(
        `${f} spells a uses.* key as "common:uses.…", which no check can resolve — read it through a ` +
          "useTranslation() binding instead.",
      );
    else if (USES_CALL.test(src) && !registered.has(f))
      fail(
        `${f} reads a uses.* key but is not registered in check 32(d), so its copy is resolved against ` +
          "nothing — add it to the table with a floor.",
      );
  }

  // Both directions, for every matcher this check adds. Keys that existed before
  // this check did, so the probes judge the matchers and not the copy.
  const probeProblems = usesProblems(
    boundCalls(
      "check-32d-probe.tsx",
      0,
      'const { t } = useTranslation("jobs");\nconst { t: tCommon } = useTranslation();\n' +
        't("uses.limitReached");\ntCommon("uses.limitReached");\ntCommon("uses.account", { count: 3, remaining: 2 });\n',
    ),
  );
  if (probeProblems.length !== 1 || !probeProblems[0].includes('binding to "jobs"'))
    fail(
      "check 32(d) misjudges a fixture with one uses.* key behind a jobs binding and two behind a common " +
        `one: ${JSON.stringify(probeProblems)}`,
    );
  for (const [loc, form] of [["en", "other"], ["he", "two"], ["he", "other"]])
    if (!keyProblems(withoutForm(common[loc], "uses.account", form), "uses.account", loc, SURFACE).length)
      fail(`check 32(d) passes a ${loc} uses.account with no _${form} form`);
  if (keyProblems(common.en, "uses.account", "en").length || keyProblems(common.he, "uses.account", "he").length)
    fail("check 32(d) refuses the real uses.account plural sets, which are complete in both locales");
  const apiProbe = new RegExp(API_CALL.source);
  const okProbe = apiProbe.exec('i18n.t("uses.limitReached", { ns: "common", month, date })');
  if (!okProbe || okProbe[1] !== "uses.limitReached" || okProbe[2] !== "common")
    fail("check 32(d)'s apiError matcher cannot read its own call shape");
  if (apiProbe.test('i18n.t("dailyLimit.search", { ns: "common", cap })'))
    fail("check 32(d)'s apiError matcher reads a key outside uses.*");
  if (!PREFIXED.test('t("common:uses.runNow")') || PREFIXED.test('t("common:actions.save")'))
    fail("check 32(d)'s prefixed-spelling detector cannot tell common:uses.* from another common key");
  if (!USES_CALL.test('tCommon("uses.plan.title")') || USES_CALL.test("tCommon(`uses.features.${id}`)"))
    fail("check 32(d)'s walk would miss a literal uses.* call, or fire on a template literal it cannot resolve");
} catch (e) {
  fail(`monthly-uses copy check could not run: ${e.message}`);
}

// ---- 32(e). the uses store: when a counted control is out (EXECUTED) ------- //
// `lib/usesStore.ts` holds what this page knows about the month's uses, and its
// `outFor` is the ONE thing allowed to disable a counted control. Wrong in either
// direction costs something real: out too eagerly locks a user out of a call the
// server would serve for free (a screening pass with answers left, a tailor the
// fit check already paid for); out too lazily only lets the server refuse. So
// every "covered" case is pinned beside the case that is not.
//
// Time comes from `Date.now()` alone, so the probe drives the clock by replacing
// it. A pass's deadline is set on ARRIVAL from the relative seconds the server
// sends, so a phone whose clock is wrong cannot end a pass early.
//
// The store schedules one re-emit at the earliest pass deadline on a REAL timer:
// `resetUses()` in `finally` is what lets this build exit, instead of waiting an
// hour for a pass the probe opened.
//
// Then the wiring, because an executed store nothing writes to guards nothing
// (check 31's words): the /auth/me answer, the response headers on the axios
// path and on the search stream, the 429 in the shared onRejected, and the
// dropped-stream sentence.
try {
  const us = runProbeBundle("uses-store", `export * from "./lib/usesStore";\n`);
  for (const name of ["setUsage", "noteUsesHeaders", "noteMonthlyLimit", "outFor", "getUsesState", "resetUses"])
    if (typeof us[name] !== "function") throw new Error(`lib/usesStore.ts does not export ${name}`);
  const realNow = Date.now;
  let clock = Date.UTC(2026, 8, 15, 12, 0, 0);
  Date.now = () => clock;
  try {
    const HOUR = 3600;
    const LIMIT_DETAIL = {
      code: "monthly_limit",
      feature: "tailor",
      plan: "free",
      limit: 10,
      used: 10,
      remaining: 0,
      resets_on: "2026-10-01",
    };
    const usage = (over = {}) => ({
      plan: "free",
      limit: 10,
      used: 10,
      remaining: 0,
      resets_on: "2026-10-01",
      by_feature: {},
      passes: {},
      ...over,
    });
    const pass = (calls_left, expires_in_s) => ({ calls_left, expires_in_s });

    // At 0 left, an open screening pass covers screening, and only screening.
    us.setUsage(usage({ passes: { screening: pass(3, HOUR) } }));
    if (us.outFor("screening"))
      fail('outFor("screening") is true at 0 left with a screening pass holding 3 answers — the button is disabled for an answer the server includes.');
    if (!us.outFor("tailor"))
      fail('outFor("tailor") is false at 0 left because a SCREENING pass is open — a pass covers its own feature only.');
    clock += HOUR * 1000 + 1;
    if (!us.outFor("screening"))
      fail("a screening pass still covers after its deadline, so the button stays enabled into a certain 429.");
    clock -= HOUR * 1000 + 1;
    us.setUsage(usage({ passes: { screening: pass(0, HOUR) } }));
    if (!us.outFor("screening")) fail("a screening pass with calls_left 0 still covers.");
    // The same pass through the headers, Headers-style get() and plain-object style.
    us.setUsage(usage());
    us.noteUsesHeaders({ get: (name) => (name.toLowerCase() === "x-uses-pass" ? "screening;5;600" : null) });
    if (us.outFor("screening")) fail("an X-Uses-Pass header read through get() did not open the pass.");
    us.noteUsesHeaders({ "x-uses-pass": "screening;0;0" });
    if (!us.outFor("screening")) fail("X-Uses-Pass `screening;0;0` (the pass was closed) left it open.");

    // A per-posting inclusion: the fit check's tailor, a cover letter's changes.
    us.setUsage(usage());
    const iso = (ms) => new Date(ms).toISOString();
    if (us.outFor("tailor", iso(clock + 60_000)))
      fail('outFor("tailor", <future ISO>) is true at 0 left — the fit check already paid for this tailor.');
    if (!us.outFor("tailor", iso(clock - 60_000)))
      fail('outFor("tailor", <past ISO>) is false at 0 left — an inclusion that has ended covers nothing.');
    // Read in a zone that is not UTC: on a UTC build machine (CI) a local-time
    // parse is indistinguishable from the right one, and this would pass by
    // never firing. F7's mechanism.
    const prevTZ = process.env.TZ;
    process.env.TZ = "Asia/Jerusalem";
    try {
      if (new Date(clock).getTimezoneOffset() === 0)
        throw new Error("process.env.TZ did not take effect, so the no-offset case proves nothing");
      if (us.outFor("tailor", iso(clock + 60_000).replace(/Z$/, "")))
        fail("an included-until with no offset is read in the device's local time instead of UTC, so it ends hours early or late.");
    } finally {
      if (prevTZ === undefined) delete process.env.TZ;
      else process.env.TZ = prevTZ;
    }

    // The false-positive half: nothing else is ever out.
    us.setUsage(usage({ used: 7, remaining: 3 }));
    if (us.outFor("tailor")) fail("outFor is true with 3 uses left.");
    us.setUsage(null);
    if (us.outFor("tailor"))
      fail("outFor is true when this page does not know the count (a failed /auth/me) — unknown must never disable a control.");
    us.setUsage(usage({ plan: "unlimited", limit: null, used: 0, remaining: null }));
    if (us.outFor("tailor")) fail("outFor is true for a plan with no monthly limit.");

    // A 429 writes the numbers it carries, and never forces 0.
    us.setUsage(usage({ used: 5, remaining: 5 }));
    us.noteMonthlyLimit({ ...LIMIT_DETAIL, used: 8, remaining: 2 });
    if (us.getUsesState()?.remaining !== 2)
      fail(
        `a kits batch 429 carrying remaining 2 left the store at ${JSON.stringify(us.getUsesState()?.remaining)} — ` +
          "the writer takes the refusal's own count (the batch was bigger than what is left, not zero).",
      );
    us.resetUses();
    us.noteMonthlyLimit({ ...LIMIT_DETAIL });
    const made = us.getUsesState();
    if (!made || made.limit !== 10 || made.remaining !== 0 || made.resetsOn !== "2026-10-01")
      fail(`a 429 against an empty store left it as ${JSON.stringify(made)}; it must take limit, remaining and resets_on from the refusal.`);
    us.setUsage(usage({ used: 9, remaining: 1, passes: { screening: pass(2, HOUR), interview: pass(9, HOUR) } }));
    us.noteMonthlyLimit({ ...LIMIT_DETAIL, feature: "screening" });
    const after = us.getUsesState();
    if (after?.passes?.screening)
      fail("a 429 for screening left the screening pass open — the server just proved nothing covers that call.");
    if (!after?.passes?.interview) fail("a 429 for screening closed the INTERVIEW pass too.");

    // resets_on arrives: the last minute of the month is out, the 1st is not.
    us.setUsage(usage());
    clock = Date.UTC(2026, 8, 30, 23, 59, 0);
    if (!us.outFor("tailor")) fail("outFor is false at 0 left in the last minute of the month.");
    clock = Date.UTC(2026, 9, 1, 0, 0, 30);
    if (us.outFor("tailor")) fail("outFor is still true on the day resets_on arrives, when the month's uses are back.");
  } finally {
    us.resetUses();
    Date.now = realNow;
  }

  // The writers, as C3 names them.
  const client = decomment(read("api/client.ts"));
  for (const [marker, re, harm] of [
    ["function onRejected", /\bnoteMonthlyLimit\(\s*detail\s*\)/, "a 429 monthly_limit never reaches the uses store, so the page keeps offering a control the server refuses"],
    ["export async function getAuthMe", /\bsetUsage\(/, "the /auth/me answer never reaches the uses store, so no page knows the count"],
    ["export async function searchJobsStream", /\bnoteUsesHeaders\(\s*resp\.headers\s*\)/, "the search stream's X-Uses-Remaining is never read"],
    ["export async function searchJobsStream", /\brefreshUses\(\s*\w+\s*\)/, "an error frame does not re-read /auth/me through refreshUses, so a search the server refunded still shows its use spent"],
  ])
    if (!re.test(fnSource(client, marker)))
      fail(`api/client.ts: ${marker.replace(/^export (?:async )?/, "")} — ${harm}.`);
  // …and never through getAuthMe, which re-stamps the resume draft's owner from
  // whatever the answer says: mid-search, an expired session or another account
  // signed in from another tab would claim this tab's unsaved edits (2026-09-22).
  if (/\bgetAuthMe\(/.test(fnSource(client, "export async function searchJobsStream")))
    fail("api/client.ts: searchJobsStream calls getAuthMe, which re-stamps the resume draft's owner mid-session; use refreshUses(tabAccount())");
  const interceptor = /api\.interceptors\.response\.use\(([\s\S]*?)\n\);/.exec(client);
  if (!interceptor) throw new Error("could not find `api.interceptors.response.use(…\\n);` in api/client.ts");
  const READS_ON_SUCCESS = /^\s*\(\s*response\s*\)\s*=>\s*\{\s*noteUsesHeaders\(\s*response\.headers\s*\)/;
  if (!READS_ON_SUCCESS.test(interceptor[1]))
    fail(
      "api/client.ts: axios has no success-side interceptor reading X-Uses-Remaining and X-Uses-Pass, so a " +
        "counted call never moves the count on screen.",
    );
  if (READS_ON_SUCCESS.test("\n  undefined,\n  (error) => {\n    noteUsesHeaders(response.headers);"))
    fail("check 32(e)'s interceptor pin accepts a rejection-only interceptor");
  const store = decomment(read("state/jobSearchStore.ts"));
  if (!/\bisConnectionDropped\(/.test(store) || !/\binvalidateData\(\s*"history"\s*\)/.test(store))
    fail(
      "state/jobSearchStore.ts: a search stream that drops is reported as a generic failure and History is " +
        "not re-read, although the server may finish the search and write its jobs there.",
    );
  if (!/\bt\("search\.connectionDropped"\)/.test(decomment(read("pages/JobsPage.tsx"))))
    fail(
      "pages/JobsPage.tsx never says the connection dropped (search.connectionDropped), so a dropped search " +
        "reads as a failure and invites a second search that uses another use.",
    );
} catch (e) {
  fail(`uses store probe could not run: ${e.message}`);
}

// ---- 32(f). every tool in the menu and on the Tools page has a name -------- //
// Phase 30 moves the CV scan into the tools, and a tool is listed in TWO tables:
// AppLayout's `toolsSubNav` (the menu) and ToolsPage's `tools` (the cards). The
// menu renders its label as a TEMPLATE literal, tTools(`cards.${item.key}.title`),
// which check 9 cannot see (it resolves literal `t("nav.*")` calls), and the
// cards do the same for `.title` and `.body`. Check 8 stays green while a key is
// missing from BOTH tools.json files, so a new tool's raw key renders at 13px in
// the menu, in Hebrew.
//
// The two tables are held to ONE list as well: the menu is documented as
// mirroring the cards, and a tool in only one of them is reachable from one
// place only.
try {
  const table = (file, marker) => {
    const src = decomment(read(file));
    const at = src.indexOf(marker);
    if (at === -1) throw new Error(`could not find \`${marker}\` in ${file}`);
    const end = src.indexOf("] as const", at);
    if (end === -1) throw new Error(`\`${marker}\` in ${file} is not closed by \`] as const\``);
    const rows = rowsOf(src.slice(at, end));
    if (rows.length < 6 || rows.some((r) => !r.key || !r.to))
      throw new Error(
        `read ${rows.length} rows out of ${file}'s \`${marker}\`, not all with a key and a to — the table's shape changed`,
      );
    return rows;
  };
  const rowsOf = (text) =>
    [...text.matchAll(/\{[^{}]*\}/g)].map((m) => ({
      key: /\bkey:\s*"([^"]+)"/.exec(m[0])?.[1],
      to: /\bto:\s*"([^"]+)"/.exec(m[0])?.[1],
    }));
  const nav = table("layouts/AppLayout.tsx", "const toolsSubNav = [");
  const cards = table("pages/ToolsPage.tsx", "const tools = [");
  const pairs = (rows) => rows.map((r) => `${r.key} → ${r.to}`);
  const onlyNav = pairs(nav).filter((p) => !pairs(cards).includes(p));
  const onlyCards = pairs(cards).filter((p) => !pairs(nav).includes(p));
  if (onlyNav.length)
    fail(`layouts/AppLayout.tsx lists ${onlyNav.join(", ")} in the Tools menu, but pages/ToolsPage.tsx has no such card.`);
  if (onlyCards.length)
    fail(
      `pages/ToolsPage.tsx has a card for ${onlyCards.join(", ")} that the Tools menu in layouts/AppLayout.tsx ` +
        "does not list, so that tool is reachable from one place only.",
    );
  for (const loc of ["en", "he"]) {
    const tools = JSON.parse(read(`locales/${loc}/tools.json`));
    const missing = new Set();
    for (const r of nav) if (!resolvesIn(tools, `cards.${r.key}.title`)) missing.add(`cards.${r.key}.title`);
    // `line` since PLAN 31.7: the one line a phone shows under each name.
    for (const r of cards)
      for (const leaf of ["title", "body", "line"])
        if (!resolvesIn(tools, `cards.${r.key}.${leaf}`)) missing.add(`cards.${r.key}.${leaf}`);
    if (missing.size)
      fail(
        `locales/${loc}/tools.json is missing ${[...missing].join(", ")} — the Tools menu or the Tools page ` +
          "renders the raw key. Check 8 stays green while both locales are equally wrong.",
      );
  }
  // Both directions on the row reader and on the lookup.
  const probeRows = rowsOf('[\n  { to: "/tools/scan", key: "scan", icon: ScanSearch },\n  { icon: ScanEye, key: "xray", to: "/tools/xray" },\n]');
  if (probeRows.map((r) => `${r.key}${r.to}`).join() !== "scan/tools/scan,xray/tools/xray")
    fail("check 32(f)'s row reader cannot read a table row whichever order its properties are written in");
  const toolsEn = JSON.parse(read("locales/en/tools.json"));
  if (resolvesIn(toolsEn, "cards.__no_such_tool__.title") || !resolvesIn(toolsEn, "cards.xray.title"))
    fail("check 32(f)'s lookup cannot tell a present tool name from a missing one");
} catch (e) {
  fail(`tools label check could not run: ${e.message}`);
}

// ---- 32(g). every refusal the Google callback sends has a sentence --------- //
// The callback in auth_routes.py ALWAYS redirects, and every refusal travels as
// `?google=<code>`: the callback's own `fail("…")` codes, plus whatever
// `accounts.google_sign_in` raises as `AuthError(…, "…")`, which the callback
// passes on as `fail(exc.code)`. A code with no row in GOOGLE_ERROR_KEYS shows
// the generic sentence, which hides the one thing the person could act on
// (`not_authoritative`: use your email and password instead). tsc sees none of
// it, because the code is a string in a URL. So the codes are READ from the
// backend, never restated here, and each must map to `errors.google.<code>`,
// which must resolve in both auth.json files.
//
// `google_sign_in` hands its new-account, link and supersede branches to
// `_google_*` helpers, and two codes are raised only there (`signup_closed`,
// `too_many_attempts`). The helpers are found by the calls in its body, one
// level down, so a fourth helper is read without editing this check.
//
// Degrades only when backend/ is absent; the table's own half still runs.

/** Python source with docstrings blanked and `#` comments cut, so a sentence in
 * a docstring or a commented-out call cannot read as code. A `#` inside a
 * string is kept. */
function pyCode(src) {
  return src
    .replace(/\r\n/g, "\n")
    .replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, '""')
    .split("\n")
    .map((line) => {
      let quote = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          if (c === "\\") i++;
          else if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === "#") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

/** A top-level `def name(`, from its line to the next statement at column 0.
 * A multi-line signature closes with `) -> T:` at column 0, and that line is
 * still the def's own. */
function pyDef(src, name, file) {
  const m = new RegExp(`^def ${name}\\(`, "m").exec(src);
  if (!m) throw new Error(`backend/${file} has no top-level \`def ${name}(\` (the function moved or was renamed)`);
  const lines = src.slice(m.index).split("\n");
  let end = lines.length;
  for (let i = 1; i < lines.length; i++)
    if (/^[^\s)]/.test(lines[i])) {
      end = i;
      break;
    }
  return lines.slice(0, end).join("\n");
}

/** The quoted codes a function passes to `fail(…)`: a literal argument, or
 * either literal branch of `"a" if cond else "b"`. The condition is not a code
 * (`error == "access_denied"` is Google's word, not ours), and a non-literal
 * argument (`fail(exc.code)`) is another function's list, read separately. */
function failCodes(body) {
  const codes = new Set();
  for (const m of body.matchAll(/\bfail\(([^()\n]*)\)/g)) {
    const arg = m[1].trim();
    const ternary = /^(.*?)\s+if\s+.*\s+else\s+(.*)$/.exec(arg);
    for (const part of ternary ? [ternary[1], ternary[2]] : [arg]) {
      const lit = /^(["'])([a-z][a-z_]*)\1$/.exec(part.trim());
      if (lit) codes.add(lit[2]);
    }
  }
  return codes;
}

/** The codes a function raises as `AuthError(<status>, "<code>"…)`. */
const authErrorCodes = (body) =>
  new Set([...body.matchAll(/\bAuthError\(\s*\d+\s*,\s*(["'])([a-z][a-z_]*)\1/g)].map((m) => m[2]));

try {
  const table = new Map(googleErrorTable());
  const misnamed = (tbl) => [...tbl].filter(([code, key]) => key !== `errors.google.${code}`);
  for (const [code, key] of misnamed(table))
    fail(
      `lib/apiError.ts maps the Google code "${code}" to "${key}", not "errors.google.${code}". One sentence per ` +
        "code, named after it, is what lets this check pair the backend's codes with the copy.",
    );
  for (const loc of ["en", "he"]) {
    const auth = JSON.parse(read(`locales/${loc}/auth.json`));
    for (const [code, key] of table)
      if (!resolvesIn(auth, key))
        fail(`locales/${loc}/auth.json is missing "${key}", so /login?google=${code} would show the raw key.`);
  }

  const unmapped = (codes, tbl) => [...codes].filter((code) => !tbl.has(code));
  const routes = pySource("app/api/auth_routes.py", "check 32(g)");
  const accounts = pySource("app/core/accounts.py", "check 32(g)");
  if (routes !== null && accounts !== null) {
    const fromCallback = failCodes(pyDef(pyCode(routes), "auth_google_callback", "app/api/auth_routes.py"));
    if (fromCallback.size < 8)
      throw new Error(
        `read only ${fromCallback.size} fail("…") codes out of auth_google_callback (expected at least 8) — its call shape changed`,
      );
    const accountsCode = pyCode(accounts);
    const signIn = pyDef(accountsCode, "google_sign_in", "app/core/accounts.py");
    const helpers = [...new Set([...signIn.matchAll(/\b(_google_\w+)\(/g)].map((m) => m[1]))];
    if (helpers.length < 3)
      throw new Error(
        `google_sign_in calls only ${helpers.length} _google_* helpers (expected the signup, link and supersede branches)`,
      );
    const fromAccounts = authErrorCodes(signIn);
    for (const helper of helpers)
      for (const code of authErrorCodes(pyDef(accountsCode, helper, "app/core/accounts.py"))) fromAccounts.add(code);
    if (fromAccounts.size < 6)
      throw new Error(
        `read only ${fromAccounts.size} AuthError codes out of google_sign_in and its helpers (expected at least 6)`,
      );
    for (const code of unmapped(new Set([...fromCallback, ...fromAccounts]), table))
      fail(
        `the Google callback can send ?google=${code}, and lib/apiError.ts's GOOGLE_ERROR_KEYS has no row for it: ` +
          "the page would show the generic sentence instead of saying what happened.",
      );
  }

  // Both directions on every reader, on fixtures shaped like the real files.
  const ROUTE_PROBE = [
    '@router.get("/auth/google/callback")',
    "def auth_google_callback(",
    "    request: Request,",
    '    code: str = "",',
    ") -> RedirectResponse:",
    '    """Every refusal is fail("from_a_docstring")."""',
    "    def fail(reason: str) -> RedirectResponse:",
    '        auth_throttle.record(db, "google_fail", key)  # fail("from_a_comment")',
    '        return leave("/login?google=" + quote(reason, safe=""))',
    "    if error:",
    '        return fail("cancelled" if error == "access_denied" else "google_error")',
    "    except accounts.AuthError as exc:",
    "        return fail(exc.code)",
    '    return fail("try_again")',
    "",
    "",
    '@router.get("/next")',
    "def next_route():",
    '    return fail("not_this_function")',
  ].join("\n");
  const routeRead = [...failCodes(pyDef(pyCode(ROUTE_PROBE), "auth_google_callback", "probe"))].sort().join();
  if (routeRead !== "cancelled,google_error,try_again")
    fail(
      `check 32(g)'s callback reader reads [${routeRead}] from its probe, not [cancelled,google_error,try_again]: ` +
        "it misses a ternary branch, or reads a condition, a docstring, a comment or the next function.",
    );
  const ACCOUNTS_PROBE = [
    'def google_sign_in(db, request, claims, locale=""):',
    '    """Refusals: AuthError(400, "from_a_docstring")."""',
    "    if bad:",
    '        raise AuthError(400, "token_invalid")',
    '    # raise AuthError(403, "from_a_comment")',
    "    return _google_signup(db, request)",
    "",
    "",
    "def _google_signup(",
    "    db: Session, request: Request",
    ") -> tuple[int, str, str]:",
    '    raise AuthError(429, "too_many_attempts", retry_after=attempt.retry_after)',
    "",
    "",
    "def unrelated():",
    '    raise AuthError(400, "not_reached")',
  ].join("\n");
  const probeCode = pyCode(ACCOUNTS_PROBE);
  const probeSignIn = pyDef(probeCode, "google_sign_in", "probe");
  const probeCodes = authErrorCodes(probeSignIn);
  for (const h of new Set([...probeSignIn.matchAll(/\b(_google_\w+)\(/g)].map((m) => m[1])))
    for (const c of authErrorCodes(pyDef(probeCode, h, "probe"))) probeCodes.add(c);
  if ([...probeCodes].sort().join() !== "token_invalid,too_many_attempts")
    fail(
      `check 32(g)'s account reader reads [${[...probeCodes].sort().join()}] from its probe, not ` +
        "[token_invalid,too_many_attempts]: it misses a helper's code, or reads a docstring, a comment or an unrelated function.",
    );
  const TBL = new Map([["state_invalid", "errors.google.state_invalid"]]);
  if (unmapped(new Set(["state_invalid", "not_authoritative"]), TBL).join() !== "not_authoritative")
    fail("check 32(g) cannot tell a code with a row from a code without one");
  if (misnamed(TBL).length || misnamed(new Map([["state_invalid", "errors.google.try_again"]])).length !== 1)
    fail("check 32(g)'s naming rule cannot tell a row named after its code from one borrowing another code's sentence");
} catch (e) {
  fail(`Google refusal code check could not run: ${e.message}`);
}

// ---- 32(h). uploading a resume on /jobs starts no search ------------------- //
// Before Phase 30 the first upload on the Jobs page auto-ran a job search. A
// search now uses 1 of the month's uses, and that screen sits under copy saying
// uploading is free, on the page onboarding sent every new user to: a use spent
// on a search nobody tapped. For EVERY plan, not only free ones: the admin is
// exempt whatever `plan` says, so a plan-gated auto-search would be a flow the
// owner never sees on his own account.
//
// A search starts from a tap on the control that carries its note, and nowhere
// else. Scoped to `onResumeUploaded`, because the same page legitimately starts
// one from the Find jobs button (`runSearch`), and that half is asserted too, or
// "make it pass" is satisfied by deleting search from the page.
try {
  const page = decomment(read("pages/JobsPage.tsx"));
  const SEARCH_CALL = /\b(?:startJobSearch|searchJobs|searchJobsStream)\s*\(/;
  const upload = fnSource(page, "function onResumeUploaded");
  if (!/\bpersistMaster\(/.test(upload))
    throw new Error("sliced something that is not onResumeUploaded (it never calls persistMaster)");
  const hit = SEARCH_CALL.exec(upload);
  if (hit)
    fail(
      `pages/JobsPage.tsx: onResumeUploaded calls ${hit[0]}…) — uploading a resume starts a job search that ` +
        "uses 1 of the month's uses, under copy that says uploading is free. Leave the search to the Find jobs button.",
    );
  if (!SEARCH_CALL.test(fnSource(page, "function runSearch")))
    throw new Error("runSearch no longer starts a search, so this check's scope has moved: find where the Find jobs button starts one");
  // Both directions on the detector.
  if (!SEARCH_CALL.test(upload.replace("{", "{\n    startJobSearch(r, onboardingCtx());")))
    fail("check 32(h) cannot see a search call spliced into onResumeUploaded");
  if (!SEARCH_CALL.test("void searchJobsStream(resume, null, onProgress);"))
    fail("check 32(h) misses a direct searchJobsStream call");
  if (SEARCH_CALL.test('setMode("search");\nsetShowReplace(false);'))
    fail('check 32(h) reads setMode("search") as starting a search');
} catch (e) {
  fail(`no-auto-search check could not run: ${e.message}`);
}

// ---- 32(i). no first-run dialog steers a new account off its page ---------- //
// A1 carries a destination through sign-up (the landing's scan button lands on
// /tools/scan). The first-visit modal preselected "Find matching jobs" and sent
// everyone to /jobs on its primary button, undoing A1 on every route (C7). Since
// PLAN 31.5/2 there is no modal at all: the first run is the upload. What is
// left to pin is that nothing takes its place in the shell, where it would meet
// a new account on whatever page it came to. The one first-run surface, the
// "What first?" sheet, is mounted by /app alone, over its own upload card
// (check 52), so an account that signed up for the scan lands on the scan.
try {
  const shellProblems = (src) => {
    const out = [];
    if (/\b(?:OnboardingModal|FirstRunSheet)\b/.test(src)) out.push("mounts a first-run dialog");
    if (/from\s+["'][^"']*\/onboarding["']/.test(src)) out.push("imports a first-run module");
    return out;
  };
  const found = shellProblems(decomment(read("layouts/AppLayout.tsx")));
  if (found.length)
    fail(
      `layouts/AppLayout.tsx ${found.join(" and ")}: a new account would meet it on whatever page it came to ` +
        "(C7), before any upload.",
    );
  const walkSrc = (dir) =>
    fs.readdirSync(dir ? path.join(SRC, ...dir.split("/")) : SRC, { withFileTypes: true }).flatMap((d) => {
      const rel = dir ? `${dir}/${d.name}` : d.name;
      if (d.isDirectory()) return d.name === "locales" ? [] : walkSrc(rel);
      return /\.tsx?$/.test(d.name) ? [rel] : [];
    });
  const files = walkSrc("");
  if (files.length < 100) throw new Error(`walked only ${files.length} source files under src/ — the tree moved`);
  const mounts = files.filter((f) => /<FirstRunSheet\b/.test(decomment(read(f))));
  if (mounts.join() !== "pages/TailorPage.tsx")
    fail(
      `the first-run sheet is mounted by ${JSON.stringify(mounts)}, not by pages/TailorPage.tsx alone: it belongs ` +
        "over /app's upload card, and anywhere else it steers a new account off the page it came to.",
    );
  // Both directions on the detector.
  if (!shellProblems("<OnboardingModal open={x} onClose={y} />").length ||
      !shellProblems('import { onboardingStep } from "../lib/onboarding";').length ||
      shellProblems('import { signOut } from "../lib/session";\n<GoogleNotice email="" />').length)
    fail("check 32(i)'s shell detector cannot tell a first-run dialog in the shell from the shell's own parts");
} catch (e) {
  fail(`first-run placement check (32(i)) could not run: ${e.message}`);
}

// ---- 32(j). the monthly-uses contract matches the backend's models --------- //
// Both lanes of Phase 30 build against the same shapes (spec H0), and the
// frontend half of each is hand-written in types.ts: `UsageOut` on AuthMe, the
// admin's `plan` / `uses_this_month`, the paused alert, the skipped morning, and
// the two per-posting inclusions. tsc checks the frontend against its OWN
// mirror, never against Python, so a field renamed on one side compiles green
// and reads `undefined` at runtime, which the uses store takes as "unknown" and
// answers with no note at all, silently.
//
// `UsageOut` and its pass are compared as whole field sets; the other models by
// the Phase 30 names only, because their older fields are not this check's to
// hold. The TypeScript half always runs; the Python half degrades only when
// backend/ is absent.
try {
  const tsKeys = (src, name) => {
    const m = new RegExp(`export interface ${name}\\b[^{]*\\{`).exec(src);
    if (!m) throw new Error(`types.ts has no \`export interface ${name}\``);
    return topLevelKeys(blockAfter(src.slice(m.index), "{", name));
  };
  /** Field names of a Pydantic class: its body's lines at the field indent,
   * with docstrings blanked first so a sentence in one cannot read as a field. */
  const pyFields = (src, name) => {
    const bare = src.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, '""');
    const m = new RegExp(`^class ${name}\\([^)]*\\):[ \\t]*(?:#.*)?$`, "m").exec(bare);
    if (!m) throw new Error(`models/__init__.py has no \`class ${name}(…):\``);
    const fields = [];
    for (const line of bare.slice(m.index + m[0].length).split("\n").slice(1)) {
      if (/^\S/.test(line)) break; // the next top-level statement ends the class
      const f = /^ {4}([A-Za-z_]\w*)\s*:(?!=)/.exec(line);
      if (f) fields.push(f[1]);
    }
    if (!fields.length) throw new Error(`read no fields out of class ${name} in models/__init__.py`);
    return fields;
  };

  const types = decomment(read("types.ts"));
  const WHOLE = [
    ["UsageOut", "UsageOut"],
    ["UsagePassOut", "UsagePassOut"],
  ];
  const NAMES = [
    ["AuthMe", "AuthMe", ["usage"]],
    ["UserOut", "UserOut", ["plan", "uses_this_month"]],
    ["AlertSettingsOut", "AlertSettings", ["paused_reason", "resumes_on"]],
    ["AlertRunResult", "AlertRunResult", ["skipped_reason"]],
    ["UsageOut", "UsageOut", ["passes"]],
    ["FitCheckResult", "FitCheckResult", ["tailor_included_until", "tailor_expires_in_s"]],
    ["CoverLetterResponse", "CoverLetterResponse", ["included_until", "changes_left", "expires_in_s"]],
  ];
  for (const [, ts, names] of NAMES) {
    let keys;
    try {
      keys = tsKeys(types, ts);
    } catch (e) {
      fail(`${e.message} — the backend sends it (Phase 30 contract), and nothing on this side can read it.`);
      continue;
    }
    const missing = names.filter((n) => !keys.includes(n));
    if (missing.length)
      fail(
        `types.ts: interface ${ts} has no ${missing.join(", ")} — the backend sends ${missing.length > 1 ? "them" : "it"} ` +
          "(Phase 30 contract), and a page reading through this type reads undefined.",
      );
  }

  const src = pySource("app/models/__init__.py", "check 32(j)");
  if (src !== null) {
    if (pyFields(src, "UsageOut").length < 7)
      throw new Error("read fewer than 7 fields out of models/__init__.py's UsageOut — the class body changed shape");
    for (const [py, , names] of NAMES) {
      const fields = pyFields(src, py);
      const missing = names.filter((n) => !fields.includes(n));
      if (missing.length)
        fail(
          `backend/app/models/__init__.py: class ${py} has no ${missing.join(", ")}, which types.ts mirrors — ` +
            "one side was renamed and the other was not.",
        );
    }
    for (const [py, ts] of WHOLE) {
      let keys;
      try {
        keys = tsKeys(types, ts);
      } catch (e) {
        fail(`${e.message} — it mirrors models/__init__.py's ${py}.`);
        continue;
      }
      const fields = pyFields(src, py);
      const onlyPy = fields.filter((f) => !keys.includes(f));
      const onlyTs = keys.filter((k) => !fields.includes(k));
      if (onlyPy.length || onlyTs.length)
        fail(
          `types.ts's ${ts} and models/__init__.py's ${py} disagree` +
            (onlyPy.length ? `: only Python has ${onlyPy.join(", ")}` : "") +
            (onlyTs.length ? `${onlyPy.length ? ";" : ":"} only TypeScript has ${onlyTs.join(", ")}` : "") +
            ". The uses store reads these names, and a missing one reads as unknown, with no note, silently.",
        );
    }
  }

  // Both directions on the two readers.
  const PROBE_PY =
    'class Probe(BaseModel):\n    """A docstring that says\n    plan: a sentence at the field indent."""\n\n' +
    "    limit: Optional[int] = None\n    def method(self) -> str:\n        inner: int = 1\n        return \"\"\n\n\n" +
    "class Next(BaseModel):\n    other: int = 0\n";
  if (pyFields(PROBE_PY, "Probe").join() !== "limit")
    fail("check 32(j)'s Python reader reads a docstring, a method body or the next class as a field");
  const PROBE_TS = decomment(
    "export interface Probe {\n  limit: number | null;\n  // passes: a comment, not a field\n  nested: { inner: string };\n  resets_on?: string;\n}\n",
  );
  if (tsKeys(PROBE_TS, "Probe").join() !== "limit,nested,resets_on")
    fail("check 32(j)'s TypeScript reader reads a comment or a nested key as a field, or misses an optional one");
} catch (e) {
  fail(`monthly-uses contract check could not run: ${e.message}`);
}

// ---- 32(k). the Google copy is registered where check 29 resolves it ------- //
// Check 29 resolves the account pages' copy against the files in its table, and
// fails an UNREGISTERED file only under the two directories it walks.
// components/GoogleNotice.tsx is outside both: if it left the table its
// sentences would be resolved against nothing, and the build would stay green
// while a raw `google.superseded` rendered at the top of the app. So both Google
// files are held to that table here, each with a floor that guards something.
//
// It also resolves the Phase 30 keys that sit outside every other scrape:
// /verify's other-account card (`verify.otherAccount*`, D) and the failed-login
// sentence `errors.invalidCredentialsGoogle` (F3). Onboarding's
// `onboarding.continue` (C7) left with the first-run questions (PLAN 31.5/2).
try {
  const MUST = [
    ["pages/auth/GoogleButton.tsx", 2],
    ["components/GoogleNotice.tsx", 2],
  ];
  const unregistered = (tbl) => MUST.filter(([f, least]) => !((tbl.get(f) ?? 0) >= least)).map(([f]) => f);
  for (const f of unregistered(new Map(ACCOUNT_COPY_FILES)))
    fail(
      `${f} is not in check 29's table (ACCOUNT_COPY_FILES) with a floor, so its copy is resolved against ` +
        "nothing and a missing key would render raw on a green build.",
    );
  // Both directions on the detector.
  if (unregistered(new Map([["pages/auth/GoogleButton.tsx", 6]])).join() !== "components/GoogleNotice.tsx")
    fail("check 32(k) cannot see a Google file missing from check 29's table");
  if (unregistered(new Map([["pages/auth/GoogleButton.tsx", 6], ["components/GoogleNotice.tsx", 0]])).length !== 1)
    fail("check 32(k) accepts a registration whose floor of 0 guards nothing");
  if (unregistered(new Map([["pages/auth/GoogleButton.tsx", 6], ["components/GoogleNotice.tsx", 2]])).length)
    fail("check 32(k) refuses a real registration");

  const needs = [];
  const other = boundCalls("pages/auth/VerifyPage.tsx", 1).filter(([, , key]) => /^verify\.otherAccount/.test(key));
  if (new Set(other.map(([, , key]) => key)).size < 6)
    fail(
      `pages/auth/VerifyPage.tsx reads only ${new Set(other.map(([, , key]) => key)).size} verify.otherAccount* keys ` +
        "literally (expected at least 6): the other-account card's copy moved into a shape nothing resolves.",
    );
  needs.push(...other);
  if (!/"errors\.invalidCredentialsGoogle"/.test(decomment(read("lib/apiError.ts"))))
    fail("lib/apiError.ts does not carry the literal \"errors.invalidCredentialsGoogle\", so check 29's error scrape cannot see it.");
  needs.push(["lib/apiError.ts", "auth", "errors.invalidCredentialsGoogle"]);
  for (const [f, ns, key] of needs)
    for (const loc of ["en", "he"])
      if (!resolvesIn(JSON.parse(read(`locales/${loc}/${ns}.json`)), key))
        fail(`locales/${loc}/${ns}.json is missing "${key}" (read by ${f}); the page would render the raw key.`);
} catch (e) {
  fail(`Google copy registration check could not run: ${e.message}`);
}

// ---- 32(l). Continue with Google: first, in a held slot, its result read once //
// Wiring no node process can render, each a defect that compiles green:
//   - Both pages read `?google=<code>` through ONE taker, `useTakeParam`, which
//     removes that key and nothing else. A strip that rebuilt the query from
//     scratch drops `next`, and the person lands on /app instead of where they
//     were going (the extension's /app?tailor_app=<id>). Its pure half is
//     EXECUTED.
//   - LoginPage stores `google_enabled` BEFORE its `!me.authenticated` early
//     return. After it, the button would exist only for visitors who are
//     already signed in, i.e. for nobody /login shows a form to.
//   - The button comes FIRST, above the form (PLAN 31.5/1: it is the one-tap
//     way in), and its slot is held from the first paint. /auth/me can answer
//     seconds into a cold start, and a button arriving above the form would move
//     the email field out from under a tap already on its way. That is why it
//     sat below the form until 31.5. So each page renders <GoogleButton
//     ungated, fed a state that starts `null` (not known yet), and GoogleButton
//     answers `null` with a placeholder of the button's own SLOT height and the
//     "or" divider laid out but invisible. In an embedded browser the in-app
//     note stands in for the button, and since it wraps by language (1 line in
//     Hebrew, 3 in English at 390 px, measured) it holds its own box, laid out
//     invisibly. It returns nothing only for `false` (the server does not offer
//     it, or /auth/me failed), the one case where the form moves, once, upward.
//   - GoogleNotice mounts after AppLayout's guard. In the spinner branch it would
//     take `google=superseded` out of the address and then be unmounted, and the
//     notice would never be seen.
// And the in-app browser test (lib/inAppBrowser.ts), EXECUTED with its
// false-positive half: Google refuses sign-in inside an embedded browser, and a
// marker that also matched real Chrome or Safari would take the button away
// from exactly the people it works for.
try {
  const TAKES_GOOGLE = /\buseTakeParam\(\s*"google"\s*\)/;
  /** Where the page puts `<GoogleButton`: "ok", "missing", "below" the form,
   * "gated" behind a condition (so it arrives late), "unfed" (no `enabled=`),
   * or "known" (its state does not start at null, so there is no unknown). */
  const googleFirst = (body) => {
    const form = body.indexOf("<form");
    const button = body.indexOf("<GoogleButton");
    if (form === -1 || button === -1) return "missing";
    if (button > form) return "below";
    if (/(?:&&|\?|:)\s*\(?$/.test(body.slice(0, button).replace(/\s+$/, ""))) return "gated";
    const fed = /^<GoogleButton\b[^>]*?\benabled=\{\s*(\w+)\s*\}/.exec(body.slice(button));
    if (!fed) return "unfed";
    const starts = new RegExp(`\\[\\s*${fed[1]}\\s*,\\s*\\w+\\s*\\]\\s*=\\s*useState<boolean \\| null>\\(\\s*null\\s*\\)`);
    return starts.test(body) ? "ok" : "known";
  };
  const WHY = {
    missing: "renders no <GoogleButton above a <form: Continue with Google is not on the page, or there is no form to put it over.",
    below: "renders Continue with Google BELOW its form; PLAN 31.5/1 puts the one-tap way in first.",
    gated: "renders <GoogleButton behind a condition, so it arrives above the form after /auth/me answers and moves the form under a tap.",
    unfed: "renders <GoogleButton with no enabled={…}, so the button cannot hold its slot while /auth/me is unanswered.",
    known: "feeds <GoogleButton a state that does not start at useState<boolean | null>(null), so nothing holds the slot while /auth/me is unanswered.",
  };
  for (const [f, marker] of [
    ["pages/auth/LoginPage.tsx", "export default function LoginPage"],
    ["pages/auth/SignupPage.tsx", "export default function SignupPage"],
  ]) {
    const body = fnSource(decomment(read(f)), marker);
    if (!TAKES_GOOGLE.test(body))
      fail(
        `${f} does not read ?google= through useTakeParam("google"): a refused Google sign-in says nothing, ` +
          "or its flag is stripped by hand, where next is the thing that gets lost.",
      );
    const where = googleFirst(body);
    if (where !== "ok") fail(`${f} ${WHY[where]}`);
  }

  /** Does GoogleButton hold its slot while `enabled` is null? "ok", or what gives way. */
  const slotHeld = (body) => {
    const early = [...body.matchAll(/if\s*\(([^)]*)\)\s*return\s+null\b/g)].map((m) => m[1].replace(/\s+/g, ""));
    if (early.some((c) => c !== "enabled===false")) return "collapses";
    if (!/enabled\s*===\s*null\s*\?\s*\(?\s*<Skeleton\b[^>]*\bclassName=\{\s*SLOT\s*\}/.test(body)) return "no placeholder";
    // In an embedded browser the note stands in for the button, and it wraps
    // differently per language, so it holds its OWN box, invisibly, until known.
    if (!/<InAppBrowserNote\b[^>]*\bpending=\{\s*enabled\s*===\s*null\s*\}/.test(body)) return "in-app note arrives late";
    // Not `[^>]*`: the button's `icon={<GoogleMark />}` closes a tag inside it.
    if (!/<Button\b(?:(?!<\/Button>)[\s\S])*?\bclassName=\{\s*cn\(\s*SLOT\b/.test(body)) return "button off the slot";
    // The divider: laid out in every state but `false`, invisible while null,
    // and not itself behind a condition.
    const divider = body.search(
      /<div\s+className=\{\s*cn\([^)]*enabled\s*===\s*null\s*&&\s*"invisible"\s*\)\s*\}\s*>\s*<span[^>]*\/>\s*\{t\("google\.or"\)\}/,
    );
    if (divider === -1 || /(?:&&|\?|:)\s*\(?$/.test(body.slice(0, divider).replace(/\s+$/, "")))
      return "divider arrives late";
    return "ok";
  };
  const gbSrc = decomment(read("pages/auth/GoogleButton.tsx"));
  const held = slotHeld(fnSource(gbSrc, "export default function GoogleButton"));
  if (held !== "ok")
    fail(
      `pages/auth/GoogleButton.tsx does not hold its slot while /auth/me is unanswered (${held}): the button or ` +
        "its divider would arrive above the form and move it under a tap.",
    );
  if (!/\bconst SLOT = "min-h-\[44px\]"/.test(gbSrc))
    fail('pages/auth/GoogleButton.tsx has no SLOT = "min-h-[44px]", the one height its placeholder and its button share.');
  const noteHides = (body) => /^\s*return\s*\(\s*<div\s+className=\{\s*cn\(\s*pending\s*&&\s*"invisible"\s*\)\s*\}\s*>/m.test(body);
  if (!noteHides(fnSource(gbSrc, "function InAppBrowserNote")))
    fail(
      "pages/auth/GoogleButton.tsx's InAppBrowserNote does not wrap itself in cn(pending && \"invisible\"), so in an " +
        "embedded browser the note is on show, or missing, before /auth/me says Google is offered at all.",
    );
  if (!noteHides('function InAppBrowserNote() {\n  return (\n    <div className={cn(pending && "invisible")}>\n') ||
      noteHides('function InAppBrowserNote() {\n  return (\n    <div>\n'))
    fail("check 32(l)'s note detector cannot tell a note that hides while pending from one that does not");

  /** Is `google_enabled` read before `!me.authenticated` in the /auth/me answer? */
  const enabledFirst = (body) => {
    const at = body.indexOf("getAuthMe()");
    if (at === -1) return null;
    const enabled = body.indexOf("google_enabled", at);
    const early = body.indexOf("!me.authenticated", at);
    return enabled === -1 || early === -1 ? null : enabled < early;
  };
  const order = enabledFirst(fnSource(decomment(read("pages/auth/LoginPage.tsx")), "export default function LoginPage"));
  if (order === null)
    fail(
      "pages/auth/LoginPage.tsx's /auth/me answer does not read google_enabled before an !me.authenticated check " +
        "(one of them is gone), so this check cannot tell whether a signed-out visitor sees Continue with Google.",
    );
  else if (!order)
    fail(
      "pages/auth/LoginPage.tsx reads google_enabled AFTER its !me.authenticated early return, so a signed-out " +
        "visitor, the only one /login shows a form to, never sees Continue with Google.",
    );

  // The taker: its pure half EXECUTED, and the hook wired to it.
  const tp = runProbeBundle("take-param", `export { withoutParam } from "./hooks/useTakeParam";\n`);
  if (typeof tp.withoutParam !== "function") {
    fail("hooks/useTakeParam.ts exports no withoutParam, so nothing says which parameters survive the strip");
  } else {
    for (const [search, want] of [
      ["?google=cancelled&next=%2Ftracker%3Fx%3D1", "?next=%2Ftracker%3Fx%3D1"],
      ["?next=%2Fapp%3Ftailor_app%3D42&google=not_authoritative", "?next=%2Fapp%3Ftailor_app%3D42"],
      ["?google=superseded", ""],
      ["?googled=1&google=x&my_google=2", "?googled=1&my_google=2"],
    ]) {
      const got = tp.withoutParam(search, "google");
      if (got !== want)
        fail(`withoutParam(${JSON.stringify(search)}, "google") is ${JSON.stringify(got)}, not ${JSON.stringify(want)}: next must survive, and only "google" may go.`);
    }
    // The twin: nothing to take, so nothing changes, byte for byte.
    for (const search of ["?next=%2Ftracker%3Fx%3D1", "", "?tailor_app=42"])
      if (tp.withoutParam(search, "google") !== search)
        fail(`withoutParam(${JSON.stringify(search)}, "google") rewrites an address that has no google flag in it`);
  }
  const hook = fnSource(decomment(read("hooks/useTakeParam.ts")), "export function useTakeParam");
  if (!/\bwithoutParam\(/.test(hook) || !/replace:\s*true/.test(hook))
    fail(
      "hooks/useTakeParam.ts's useTakeParam does not strip through withoutParam( with replace: true, so the flag " +
        "stays in the address (a reload repeats an old refusal) or Back returns to it.",
    );

  // GoogleNotice takes its flag the same way, and mounts after the guard.
  if (!TAKES_GOOGLE.test(decomment(read("components/GoogleNotice.tsx"))))
    fail('components/GoogleNotice.tsx does not read ?google= through useTakeParam("google")');
  const afterGuard = (body) => {
    const guard = body.indexOf("if (!authed)");
    const at = body.indexOf("<GoogleNotice");
    return guard === -1 || at === -1 ? null : at > guard;
  };
  const mounted = afterGuard(fnSource(decomment(read("layouts/AppLayout.tsx")), "export default function AppLayout"));
  if (mounted === null)
    fail("layouts/AppLayout.tsx renders no <GoogleNotice (or its `if (!authed)` guard moved): a superseded sign-up is never told its password was removed.");
  else if (!mounted)
    fail("layouts/AppLayout.tsx renders <GoogleNotice before its auth guard passes, where it strips the flag and is then unmounted.");

  // The in-app browser test, EXECUTED, with its false-positive half.
  const iab = runProbeBundle("in-app-browser", `export * from "./lib/inAppBrowser";\n`);
  for (const name of ["isInAppBrowser", "isAndroid", "chromeIntentUrl"])
    if (typeof iab[name] !== "function") throw new Error(`lib/inAppBrowser.ts exports no ${name}`);
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)";
  const WEBVIEW =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/127.0.6533.103 Mobile Safari/537.36";
  for (const [label, ua] of [
    ["Instagram on an iPhone", `${IPHONE} Mobile/15E148 Instagram 334.0.0.42.95 (iPhone15,2; iOS 17_5; en_US; en; scale=3.00; 1179x2556; 606302839)`],
    ["Facebook on an iPhone", `${IPHONE} Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.42.109;FBBV/626293066;FBDV/iPhone15,2;FBSN/iOS;FBSV/17.5]`],
    ["an Android WebView", WEBVIEW],
    ["LinkedIn on Android", `${WEBVIEW} LinkedInApp/4.1.975`],
    ["TikTok on an iPhone", `${IPHONE} Mobile/15E148 musical_ly_35.1.0 JsSdk/2.0 NetType/WIFI Channel/App Store`],
    ["LINE on an iPhone", `${IPHONE} Mobile/15E148 Safari Line/14.10.0`],
  ])
    if (!iab.isInAppBrowser(ua)) fail(`isInAppBrowser misses ${label}, where Google refuses to sign in`);
  for (const [label, ua] of [
    ["Chrome on Android", "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36"],
    ["Safari on an iPhone", `${IPHONE} Version/17.5 Mobile/15E148 Safari/604.1`],
    ["Chrome on an iPhone", `${IPHONE} CriOS/127.0.6533.107 Mobile/15E148 Safari/604.1`],
    ["Samsung Internet", "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36"],
    ["Firefox on Android", "Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0"],
    ["Edge on Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/127.0.2651.74"],
  ])
    if (iab.isInAppBrowser(ua)) fail(`isInAppBrowser fires on ${label}, a real browser, and would hide Continue with Google there`);
  if (!iab.isAndroid(WEBVIEW) || iab.isAndroid(`${IPHONE} Version/17.5 Mobile/15E148 Safari/604.1`))
    fail("isAndroid cannot tell an Android phone from an iPhone, so the Open in Chrome link goes to the wrong one");
  const intent = iab.chromeIntentUrl({
    protocol: "https:",
    host: "jobfinder.example",
    pathname: "/login",
    search: "?next=%2Ftracker%3Fx%3D1",
  });
  if (intent !== "intent://jobfinder.example/login?next=%2Ftracker%3Fx%3D1#Intent;scheme=https;package=com.android.chrome;end")
    fail(`chromeIntentUrl builds ${JSON.stringify(intent)}; it must open this page, its query included, in Chrome (spec F2)`);

  // Both directions on the three source detectors.
  const STATE = "const [googleEnabled, setGoogleEnabled] = useState<boolean | null>(null);\n";
  const FORM = '<form><Button type="submit">Log in</Button></form>';
  const BUTTON = '<GoogleButton next={next} page="login" enabled={googleEnabled} />\n';
  for (const [label, src, want] of [
    ["first, ungated, fed a null start", STATE + BUTTON + FORM, "ok"],
    ["below the form", STATE + FORM + BUTTON, "below"],
    ["behind googleEnabled &&", STATE + "{googleEnabled && " + BUTTON + "}" + FORM, "gated"],
    ["behind a multi-line && (", STATE + "{googleEnabled === true && (\n  " + BUTTON + ")}" + FORM, "gated"],
    ["with no enabled prop", STATE + '<GoogleButton next={next} page="login" />' + FORM, "unfed"],
    ["over a state that starts false", STATE.replace("useState<boolean | null>(null)", "useState(false)") + BUTTON + FORM, "known"],
    ["on a page with no button", STATE + FORM, "missing"],
  ])
    if (googleFirst(src) !== want)
      fail(`check 32(l)'s placement detector reads a button ${label} as ${googleFirst(src)}, not ${want}`);
  const GB_OK = [
    "  if (enabled === false) return null;",
    "  async function start() {\n    if (busy) return;\n  }",
    "  return (\n    <div>\n      {isInAppBrowser(userAgent) ? (\n        <InAppBrowserNote android={android} pending={enabled === null} />\n" +
      "      ) : enabled === null ? (\n        <Skeleton className={SLOT} />\n      ) : (",
    '        <Button type="button" onClick={start} className={cn(SLOT, "w-full")}>x</Button>\n      )}',
    '      <div className={cn("my-4 flex", enabled === null && "invisible")}>\n        <span aria-hidden className="h-px" />\n        {t("google.or")}',
    "      </div>\n    </div>\n  );",
  ].join("\n");
  for (const [label, src, want] of [
    ["the shipped shape", GB_OK, "ok"],
    ["one that is gone until known", GB_OK.replace("enabled === false", "!enabled"), "collapses"],
    ["one that is gone while null", GB_OK.replace("if (enabled === false) return null;", "if (enabled === false) return null;\n  if (enabled === null) return null;"), "collapses"],
    ["a null state that renders nothing", GB_OK.replace("<Skeleton className={SLOT} />", "null"), "no placeholder"],
    ["a placeholder of another height", GB_OK.replace("<Skeleton className={SLOT} />", '<Skeleton className="h-8" />'), "no placeholder"],
    ["a button off the slot's height", GB_OK.replace('className={cn(SLOT, "w-full")}', 'className="w-full"'), "button off the slot"],
    ["an in-app note shown before the answer", GB_OK.replace(" pending={enabled === null}", ""), "in-app note arrives late"],
    ["a divider only once known", GB_OK.replace(', enabled === null && "invisible"', ""), "divider arrives late"],
    ["a divider behind enabled &&", GB_OK.replace('      <div className={cn("my-4', '      {enabled && <div className={cn("my-4'), "divider arrives late"],
  ])
    if (slotHeld(src) !== want)
      fail(`check 32(l)'s slot detector reads ${label} as ${slotHeld(src)}, not ${want}`);
  const ANSWER_OK = "getAuthMe().then((me) => {\n  if (!live) return;\n  setGoogleEnabled(me.google_enabled === true);\n  if (!me.authenticated) return;\n});";
  const ANSWER_BAD = "getAuthMe().then((me) => {\n  if (!live || !me.authenticated) return;\n  setGoogleEnabled(me.google_enabled === true);\n});";
  if (enabledFirst(ANSWER_OK) !== true || enabledFirst(ANSWER_BAD) !== false)
    fail("check 32(l)'s order detector cannot tell google_enabled read before the early return from after it");
  const GUARD = "if (!authed) {\n  return <Spinner />;\n}\n";
  const NOTICE = "<GoogleNotice email={me?.email ?? \"\"} />";
  if (afterGuard(GUARD + NOTICE) !== true || afterGuard(NOTICE + GUARD) !== false)
    fail("check 32(l)'s mount detector cannot tell a notice after the guard from one before it");
  if (!TAKES_GOOGLE.test('const google = useTakeParam("google");') || TAKES_GOOGLE.test('params.get("google")') || TAKES_GOOGLE.test('useTakeParam("inbox")'))
    fail("check 32(l)'s taker detector cannot tell useTakeParam(\"google\") from a hand read or another flag");
} catch (e) {
  fail(`Google page wiring check could not run: ${e.message}`);
}

// ---- 33. AGENTS.md is CLAUDE.md under its own header ----------------------- //
// AGENTS.md is the same guidance for Codex: its own header, then CLAUDE.md from
// the `## Running the app` line onward, regenerated by the recipe its header
// quotes (`{ head -n 19 AGENTS.md; tail -n +5 CLAUDE.md; }`). Hand-copying it
// failed THREE times, and the third time it still listed four deleted modules
// and routes as live and said nothing about the gate or the monthly pool — a
// second, WRONG source of truth about who may spend the owner's money, with
// nothing in the repo comparing the two files.
//
// Three assertions: the two bodies are identical; the recipe's `head -n` count
// is the header's real length; and its `tail -n +` line is where CLAUDE.md's
// body really starts. A recipe whose numbers have gone stale regenerates a
// file with a line doubled or dropped, so the recipe is pinned as well as its
// output. Line endings are normalised, because a Windows checkout may give the
// two files different ones and that is not drift.
//
// DEGRADES LOUDLY only when NEITHER file is in this build, for pySource's
// reason: `.vercelignore` drops both from the Vercel upload, and the frontend
// service is rooted at frontend/. ONE file without the other is red, because
// that is a file that moved or was deleted. CI checks the whole repo out, so the
// comparison runs there on every push.
const ROOT_DIR = path.join(HERE, "..", "..");
const BODY_MARKER = "## Running the app";
let agentsSkip = null;
/**
 * What is wrong between AGENTS.md and CLAUDE.md, as sentences; [] when nothing is.
 * Throws when either file has no body marker, since then nothing can be compared.
 */
function agentsDrift(agentsRaw, claudeRaw) {
  const lines = (s) => s.replace(/\r\n/g, "\n").split("\n");
  const a = lines(agentsRaw);
  const c = lines(claudeRaw);
  const aAt = a.indexOf(BODY_MARKER);
  const cAt = c.indexOf(BODY_MARKER);
  if (aAt === -1) throw new Error(`AGENTS.md has no "${BODY_MARKER}" line, so its body cannot be found`);
  if (cAt === -1) throw new Error(`CLAUDE.md has no "${BODY_MARKER}" line, so its body cannot be found`);
  const out = [];
  const header = a.slice(0, aAt).join("\n");
  const head = /head -n (\d+) AGENTS\.md/.exec(header);
  const tail = /tail -n \+(\d+) CLAUDE\.md/.exec(header);
  if (!head || !tail)
    out.push("AGENTS.md's header no longer quotes its regeneration recipe (`head -n N AGENTS.md; tail -n +M CLAUDE.md`)");
  else {
    if (Number(head[1]) !== aAt)
      out.push(
        `AGENTS.md's recipe keeps its first ${head[1]} lines, but its header is ${aAt} lines long: ` +
          `set the recipe to \`head -n ${aAt}\`, or regenerating will double or drop a line`,
      );
    if (Number(tail[1]) !== cAt + 1)
      out.push(
        `AGENTS.md's recipe starts CLAUDE.md at line ${tail[1]}, but "${BODY_MARKER}" is line ${cAt + 1}: ` +
          `set the recipe to \`tail -n +${cAt + 1}\``,
      );
  }
  const aBody = a.slice(aAt);
  const cBody = c.slice(cAt);
  const n = Math.max(aBody.length, cBody.length);
  for (let i = 0; i < n; i++) {
    if (aBody[i] === cBody[i]) continue;
    const show = (s) => (s === undefined ? "(end of file)" : JSON.stringify(s.length > 100 ? `${s.slice(0, 100)}…` : s));
    out.push(
      `AGENTS.md has drifted from CLAUDE.md at CLAUDE.md line ${cAt + 1 + i}: CLAUDE.md reads ${show(cBody[i])}, ` +
        `AGENTS.md reads ${show(aBody[i])}. Regenerate it with the recipe in its header, never by hand`,
    );
    break;
  }
  return out;
}
try {
  const present = ["AGENTS.md", "CLAUDE.md"].filter((f) => fs.existsSync(path.join(ROOT_DIR, f)));
  if (present.length === 0) {
    agentsSkip = `neither AGENTS.md nor CLAUDE.md is in ${ROOT_DIR}`;
    console.warn(
      `\n  ! check 33 DEGRADED: ${agentsSkip}, so the two were NOT compared.\n` +
        `    This is expected only where the frontend is built without the repo around it;\n` +
        `    CI (.github/workflows/ci.yml) checks the whole repo out, so it runs there.\n`,
    );
  } else if (present.length === 1) {
    fail(
      `${present[0]} is in ${ROOT_DIR} and its twin is not: one of the two moved or was deleted, so check 33 ` +
        "has nothing to compare. Point the check at its new home; do not delete the assertion.",
    );
  } else {
    const readRoot = (f) => fs.readFileSync(path.join(ROOT_DIR, f), "utf8");
    for (const p of agentsDrift(readRoot("AGENTS.md"), readRoot("CLAUDE.md"))) fail(p);
  }

  // Both directions on the detector, against a synthetic pair built the way
  // the real files are: a 3-line CLAUDE.md intro and a 5-line AGENTS.md header.
  const BODY = `${BODY_MARKER}\n\nRun it.\n`;
  const CLAUDE = `# CLAUDE.md\n\nIntro.\n\n${BODY}`;
  const AGENTS = (h, t, body = BODY) =>
    `# AGENTS.md\n\nIntro.\n\n> Recipe: { head -n ${h} AGENTS.md; tail -n +${t} CLAUDE.md; }\n${body}`;
  const verdicts = [
    ["an exact copy", agentsDrift(AGENTS(5, 5), CLAUDE).length === 0],
    ["the same copy with CRLF endings", agentsDrift(AGENTS(5, 5).replace(/\n/g, "\r\n"), CLAUDE).length === 0],
    ["a changed body line", agentsDrift(AGENTS(5, 5, `${BODY_MARKER}\n\nRun it twice.\n`), CLAUDE).length === 1],
    ["a missing last line", agentsDrift(AGENTS(5, 5, `${BODY_MARKER}\n\n`), CLAUDE).length === 1],
    ["a stale head count", agentsDrift(AGENTS(19, 5), CLAUDE).length === 1],
    ["a stale tail line", agentsDrift(AGENTS(5, 4), CLAUDE).length === 1],
  ];
  for (const [label, ok] of verdicts)
    if (!ok) fail(`check 33's detector misjudges ${label}, so it cannot be trusted on the real pair`);
} catch (e) {
  fail(`AGENTS.md / CLAUDE.md comparison could not run: ${e.message}`);
}

// ---- 34. every size-limit kind the backend raises has its own sentence (EXECUTED) //
// P30-PASS-SIZE. A 413 `input_too_large` carries a `kind`, and `apiErrorMessage`
// read it as `kind === "jd" ? "jd" : "resume"`: every other kind got the CV's
// sentence — "That CV is too large to process… It was NOT saved… upload again" —
// said to someone whose practice session or screening question was too long.
// The pass inputs brought four new kinds (transcript, session, answer, question),
// and tsc sees none of it: a kind is a string inside a JSON body.
//
// So the kinds are READ from the backend, never restated here: every literal
// third argument of `require_within(…)` (or its `kind=`), every literal first
// argument of `InputTooLarge(…)`, and every `_Rule("<kind>", …)` in prompts.py's
// rule table, over every .py file under backend/app. A call whose kind is not a
// literal is allowed only where the kind is a pass-through — `require_within`'s
// own raise in limits.py and the rule-table wrapper in prompts.py — and red
// anywhere else, because this check cannot see what it raises. For each kind:
// `sizeLimit.<kind>` resolves in BOTH common.json files, and `apiErrorMessage`,
// EXECUTED with a recording i18n stub (32(c)'s mechanism), asks for exactly that
// key with the numbers. An unknown kind, and `constructor` (every object
// inherits one, so a plain `TABLE[kind]` answers it with a function), ask for
// `sizeLimit.generic`, never the CV's sentence.
//
// The client half, EXECUTED too: after a refused chat turn the mock-interview
// store takes the answer back OUT of the transcript and hands it to the draft
// (it used to stay in `turns`, so every retry re-sent it and spent another of
// the pass's calls), and a 413 of kind `transcript` marks the session full, so
// Send stops offering a call the server would refuse again.
//
// Degrades only when backend/ is absent (pySource); the frontend half then runs
// against the six kinds this build knows.

/** The arguments of the Python call whose `(` is at `open`, split at top-level
 * commas; strings and nested brackets are respected. */
function pyCallArgs(code, open) {
  const args = [];
  let depth = 0;
  let quote = null;
  let start = open + 1;
  for (let i = open + 1; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) {
        args.push(code.slice(start, i));
        return args;
      }
      depth--;
    } else if (c === "," && depth === 0) {
      args.push(code.slice(start, i));
      start = i + 1;
    }
  }
  throw new Error(`a call opened at offset ${open} is never closed`);
}

/** Every size-limit kind one Python file names, and every call whose kind is not
 * a literal (as `label(arg)` strings). Reads pyCode, so a docstring or a comment
 * never counts. A `def` or `class` line is a declaration, not a raise. `_Rule(`
 * is read only where `rules` says the rule table lives: pdf_renderer.py has a
 * `_Rule` of its own (a drawn line), and reading it as a size rule is this
 * check firing on legitimate input. */
function sizeKinds(code, rules = true) {
  const kinds = new Set();
  const opaque = [];
  for (const [re, index, label] of [
    [/\brequire_within\(/g, 2, "require_within"],
    [/\bInputTooLarge\(/g, 0, "InputTooLarge"],
    ...(rules ? [[/\b_Rule\(/g, 0, "_Rule"]] : []),
  ]) {
    for (const m of code.matchAll(re)) {
      if (/\b(?:def|class)\s+$/.test(code.slice(Math.max(0, m.index - 8), m.index))) continue;
      const args = pyCallArgs(code, m.index + m[0].length - 1).map((a) => a.trim());
      const byName = args.find((a) => /^kind\s*=/.test(a));
      const arg = byName ? byName.replace(/^kind\s*=\s*/, "") : args[index] ?? "";
      const lit = /^(["'])([a-z][a-z_]*)\1$/.exec(arg);
      if (lit) kinds.add(lit[2]);
      else opaque.push(`${label}(${arg || "no kind"})`);
    }
  }
  return { kinds, opaque };
}

/** Every .py file under backend/app, as a path relative to backend/. */
function backendPyFiles(rel = "app") {
  const out = [];
  for (const entry of fs.readdirSync(path.join(BACKEND_DIR, ...rel.split("/")), { withFileTypes: true })) {
    if (entry.name === "__pycache__") continue;
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...backendPyFiles(child));
    else if (entry.name.endsWith(".py")) out.push(child);
  }
  return out;
}

// The kinds this build knows, as the floor under the read (a reader that comes
// up short is a red build, never a shorter list) and the degraded run's list.
const SIZE_KINDS = ["resume", "jd", "transcript", "session", "answer", "question", "note", "page"];
// The two pass-throughs, where a kind is a variable by design, and the one file
// whose `_Rule(` lines are the prompt-input guard's rule table.
const OPAQUE_OK = new Set(["app/llm/limits.py InputTooLarge(kind)", "app/llm/prompts.py require_within(rule.kind)"]);
const RULES_PY = "app/llm/prompts.py";
try {
  // The reader, both directions, on a fixture shaped like the real files.
  const PROBE = [
    "def require_within(text: str, cap_kb: int, kind: str) -> None:",
    '    """Raise InputTooLarge("from_a_docstring") unless it fits."""',
    "    raise InputTooLarge(kind, size_kb=1, cap_kb=cap_kb)",
    "class _Rule(NamedTuple):",
    "    kind: str",
    'RULES = {"a": _Rule("from_table", "max_x_kb", turn_cap="max_y_kb")}',
    '# require_within(text, 1, "from_a_comment")',
    "require_within(",
    "    text,",
    "    getattr(settings, rule.cap),  # a comment, with a comma",
    '    "multi_line",',
    ")",
    'require_within(f(a, b), g("x, y"), kind="by_keyword")',
    'raise InputTooLarge("from_a_raise", size_kb=1, cap_kb=2)',
    "require_within(text, cap, rule.kind)",
  ].join("\n");
  const probe = sizeKinds(pyCode(PROBE));
  const probeKinds = [...probe.kinds].sort().join();
  if (probeKinds !== "by_keyword,from_a_raise,from_table,multi_line")
    fail(
      `check 34's reader reads [${probeKinds}] from its probe, not [by_keyword,from_a_raise,from_table,multi_line]: ` +
        "it misses a multi-line call, a keyword kind, a raise or a rule, or reads a docstring or a comment.",
    );
  if (probe.opaque.join() !== "require_within(rule.kind),InputTooLarge(kind)")
    fail(
      `check 34's reader reports [${probe.opaque.join()}] as unreadable, not [require_within(rule.kind),InputTooLarge(kind)] — ` +
        "a kind it cannot read would pass unseen, or a declaration reads as a call.",
    );
  // pdf_renderer.py's own `_Rule(` draws a line; outside the rule table it is not a size rule.
  const drawn = sizeKinds(pyCode("story.append(_Rule(s.accent if spec.header_rule_accent else s.rule))"), false);
  if (drawn.kinds.size || drawn.opaque.length)
    fail("check 34 reads a `_Rule(` outside prompts.py (pdf_renderer's drawn line) as a size rule it cannot read");

  // The backend's own kinds.
  let kinds = SIZE_KINDS;
  if (pySource("app/llm/limits.py", "check 34") !== null) {
    const found = new Set();
    const files = backendPyFiles();
    if (!files.includes(RULES_PY) || files.length < 40)
      throw new Error(`walked ${files.length} .py files under backend/app without ${RULES_PY} — the walk broke`);
    for (const rel of files) {
      const { kinds: here, opaque } = sizeKinds(pyCode(pySource(rel, "check 34")), rel === RULES_PY);
      for (const k of here) found.add(k);
      for (const o of opaque)
        if (!OPAQUE_OK.has(`${rel} ${o}`))
          fail(
            `backend/${rel} raises a size limit as ${o}, a kind check 34 cannot read: pass the kind as a string ` +
              "literal (or add a _Rule), so the build can require a sentence for it.",
          );
    }
    const missing = SIZE_KINDS.filter((k) => !found.has(k));
    if (missing.length)
      throw new Error(
        `read [${[...found].sort().join()}] out of backend/app, missing [${missing.join()}]: the reader broke, or a kind ` +
          "was renamed — rename its sentence and this floor with it",
      );
    kinds = [...found].sort();
  }

  // Each kind renders its OWN sentence, EXECUTED.
  const asked = [];
  const i18nStub = {
    __esModule: true,
    language: "en",
    t: (key, opts) => {
      asked.push([key, opts || {}]);
      return `T:${key}`;
    },
  };
  i18nStub.default = i18nStub;
  const ae = runProbeBundle("apierror-size", `export * from "./lib/apiError";\n`, { "../i18n": i18nStub });
  const err = (status, detail) => ({ response: { status, data: { detail } } });
  const render = (kind) => {
    asked.length = 0;
    const text = ae.apiErrorMessage(err(413, { code: "input_too_large", kind, size_kb: 300, cap_kb: 256 }), "FALLBACK");
    return { text, opts: (asked[asked.length - 1] || [undefined, {}])[1] };
  };
  const locales = Object.fromEntries(["en", "he"].map((loc) => [loc, JSON.parse(read(`locales/${loc}/common.json`))]));
  for (const kind of kinds) {
    const got = render(kind);
    if (got.text !== `T:sizeLimit.${kind}` || got.opts.ns !== "common")
      fail(
        `a 413 input_too_large of kind "${kind}" renders ${JSON.stringify(got.text)}, not common's "sizeLimit.${kind}": ` +
          "lib/apiError.ts's SIZE_LIMIT_KEYS must name it, or the user is told the wrong thing is too big.",
      );
    else if (got.opts.size !== 300 || got.opts.cap !== 256)
      fail(`the "${kind}" size sentence is handed size=${got.opts.size} cap=${got.opts.cap}, not the refusal's 300 and 256`);
    for (const loc of ["en", "he"])
      if (!resolvesIn(locales[loc], `sizeLimit.${kind}`))
        fail(`locales/${loc}/common.json is missing "sizeLimit.${kind}", so a "${kind}" refusal shows the raw key.`);
  }
  // …and the false-positive half: a kind this build has never heard of, and one
  // named after something every object inherits, get the generic sentence.
  for (const kind of ["some_future_kind", "constructor"]) {
    const got = render(kind).text;
    if (got !== "T:sizeLimit.generic")
      fail(
        `a 413 of the unknown kind "${kind}" renders ${JSON.stringify(got)}, not "sizeLimit.generic" — ` +
          (got === "T:sizeLimit.resume"
            ? "the CV's sentence (\"It was NOT saved… upload again\"), false for anything but a CV."
            : "the lookup must be by the table's OWN keys."),
      );
  }
  for (const loc of ["en", "he"])
    if (!resolvesIn(locales[loc], "sizeLimit.generic"))
      fail(`locales/${loc}/common.json is missing "sizeLimit.generic", the sentence for a size kind this build does not know.`);

  // The mock-interview store after a refused turn, EXECUTED.
  const sent = [];
  let reply = async () => ({ message: "", done: false });
  const clientStub = {
    __esModule: true,
    interviewChat: (_resume, _jd, turns) => {
      sent.push(turns.map((t) => t.text));
      return reply();
    },
    interviewScorecard: async () => ({ overall: 80, summary: "", strengths: [], improvements: [], question_feedback: [] }),
  };
  const st = runProbeBundle("mock-interview-store", `export * from "./state/mockInterviewStore";\n`, {
    "../api/client": clientStub,
    "../i18n": i18nStub,
  });
  for (const name of ["startMockInterview", "sendMockAnswer", "getMockInterviewState", "resetMockInterview", "takeReturnedAnswer"])
    if (typeof st[name] !== "function") throw new Error(`state/mockInterviewStore.ts no longer exports ${name}`);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const texts = () => st.getMockInterviewState().turns.map((t) => t.text).join("|");
  const refuse = (e) => async () => {
    throw e;
  };
  reply = async () => ({ message: "Q1", done: false });
  st.startMockInterview({}, "");
  await settle();
  reply = async () => ({ message: "Q2", done: false });
  st.sendMockAnswer("A1");
  await settle();
  let s = st.getMockInterviewState();
  if (texts() !== "Q1|A1|Q2" || s.returned !== "" || s.full !== false)
    fail(
      `a served answer leaves turns [${texts()}], returned ${JSON.stringify(s.returned)}, full ${s.full}; it must be ` +
        '[Q1|A1|Q2], "" and false (the false-positive half: nothing is handed back when nothing was refused)',
    );
  for (const [label, e, full, key] of [
    ["a 502", err(502, "LLM error"), false, null],
    ["a 413 of kind answer", err(413, { code: "input_too_large", kind: "answer", size_kb: 17, cap_kb: 16 }), false, "T:sizeLimit.answer"],
    ["a 413 of kind transcript", err(413, { code: "input_too_large", kind: "transcript", size_kb: 257, cap_kb: 256 }), true, "T:sizeLimit.transcript"],
  ]) {
    reply = refuse(e);
    st.sendMockAnswer("A2");
    await settle();
    s = st.getMockInterviewState();
    if (texts() !== "Q1|A1|Q2" || s.returned !== "A2")
      fail(
        `after ${label} the store holds turns [${texts()}] and returned ${JSON.stringify(s.returned)}: the refused answer ` +
          "must leave the transcript (every retry re-sent it and spent a call) and come back for the draft.",
      );
    if (s.full !== full)
      fail(`after ${label} the store's full is ${s.full}; only a 413 of kind transcript marks the session full`);
    if (key && s.error !== key) fail(`after ${label} the store shows ${JSON.stringify(s.error)}, not ${key}`);
    const taken = st.takeReturnedAnswer();
    if (taken !== "A2" || st.getMockInterviewState().returned !== "")
      fail(`takeReturnedAnswer() gave ${JSON.stringify(taken)} and left ${JSON.stringify(st.getMockInterviewState().returned)}; it must hand "A2" over once`);
  }
  const before = sent.length;
  reply = async () => ({ message: "Q3", done: false });
  st.sendMockAnswer("A3");
  await settle();
  if (sent.length !== before || texts() !== "Q1|A1|Q2")
    fail("a FULL session still sends an answer: the server would refuse it again, and each refusal spends one of the pass's calls");
  st.resetMockInterview();
  s = st.getMockInterviewState();
  if (s.full !== false || s.returned !== "") fail("resetMockInterview leaves the previous session's full or returned answer behind");

  // The page reads both: the returned answer goes back into the draft, and Send
  // stays off on a full session. A store field no component reads compiles green.
  const page = fnSource(read("pages/interview/MockInterview.tsx"), "export default function MockInterview");
  if (!/takeReturnedAnswer\(\)/.test(page))
    fail("pages/interview/MockInterview.tsx never calls takeReturnedAnswer(), so a refused answer is lost instead of returned to the draft");
  // …and takes it in a way that survives StrictMode (main.tsx). In dev, React
  // runs a MOUNTING component's effects twice over the same render's values, so
  // a page that mounts with an answer already waiting (the user left while the
  // refusal landed, then came back) ran `if (returned) setDraft(take…())` twice:
  // the first run restored the answer, the second still saw `returned` set, took
  // "" and wiped the draft. The effect is EXECUTED here, twice over one closure.
  const effects = [];
  for (const m of page.matchAll(/\buseEffect\(/g)) {
    const indent = page.slice(page.lastIndexOf("\n", m.index) + 1, m.index).match(/^[ \t]*/)[0];
    const open = page.indexOf("{", m.index);
    const close = new RegExp(`\\n${indent}\\}(?:, \\[[^\\]]*\\])?\\);`, "g");
    close.lastIndex = open;
    const end = close.exec(page);
    if (open === -1 || !end) throw new Error(`could not slice the useEffect at offset ${m.index} of MockInterview.tsx`);
    const body = page.slice(open + 1, end.index);
    if (/takeReturnedAnswer\(/.test(body)) effects.push(body);
  }
  if (effects.length !== 1)
    throw new Error(`found ${effects.length} useEffect bodies calling takeReturnedAnswer() in MockInterview.tsx, not 1`);
  const effectMod = { exports: {} };
  new Function(
    "module",
    createRequire(import.meta.url)("esbuild").transformSync(
      `module.exports = function (returned, takeReturnedAnswer, setDraft) {${effects[0]}\n};`,
      { loader: "ts" },
    ).code,
  )(effectMod);
  const mount = (returned, typed, runs) => {
    let waiting = returned;
    let draft = typed;
    const take = () => {
      const text = waiting;
      waiting = "";
      return text;
    };
    const setDraft = (v) => {
      draft = typeof v === "function" ? v(draft) : v;
    };
    for (let i = 0; i < runs; i++) effectMod.exports(returned, take, setDraft);
    return draft;
  };
  for (const [label, returned, typed, runs, want] of [
    ["once, as production runs it", "A2", "", 1, "A2"],
    ["twice on mount, as StrictMode runs it", "A2", "", 2, "A2"],
    // The false-positive half: with nothing returned, what the user typed stays.
    ["twice with nothing returned", "", "typing", 2, "typing"],
  ]) {
    const got = mount(returned, typed, runs);
    if (got !== want)
      fail(
        `MockInterview's takeReturnedAnswer effect, run ${label}, leaves the draft ${JSON.stringify(got)}, not ` +
          `${JSON.stringify(want)}: write only the text actually taken, never what a second take returns ("").`,
      );
  }
  const send =/<Button[^>]*?icon=\{<Send\b[\s\S]*?disabled=\{([^}]*)\}/.exec(page);
  if (!send) throw new Error("could not find the Send button's disabled={…} in MockInterview.tsx");
  if (!/\bfull\b/.test(send[1]))
    fail(`MockInterview's Send is disabled on {${send[1]}}, which ignores a full session`);
} catch (e) {
  fail(`size-limit sentence check could not run: ${e.message}`);
}

// ---- 35. the extension says why an answer was refused (EXECUTED) ----------- //
// P30-EXT-LIMIT. The Chrome extension's assisted apply drafts an answer to each
// free-text question on an application form through POST
// /tools/screening-answer, one request per question. Through v0.3 it read no
// refusal at all: `if (!aRes.ok) continue;` dropped a 429 monthly_limit and
// fired the NEXT question's request, each one spending a daily `llm` unit the
// server never refunds (the daily cap is counted before the monthly one); it
// counted only successes toward its four-per-click cap; and it ended on a GREEN
// "Filled 2 fields · resume attached" over empty question boxes. Reproduced by
// loading the real popup.js into a node vm, which is what (b) and (c) still do.
//
//   (a) the extension's own messages: en and he carry the same keys, each
//       message the same placeholder name -> content mapping (a Hebrew sentence
//       whose MONTH and DATE point at swapped $1/$2 loads fine and prints the
//       date where the month belongs), every $NAME$ declared and every
//       declaration printed, and every key the code reaches resolves in BOTH:
//       t() / showStatus / showMsg / getMessage literals including both arms of
//       a ternary, the keys screeningRefusal returns as DATA, data-i18n in the
//       two pages, and manifest.json's __MSG_*__. Check 8 walks
//       frontend/src/locales only, so none of this had any guard.
//   (b) screeningRefusal, EXECUTED in both languages: which refusals stop the
//       autofill, and that the sentence names the month that ran out and the
//       day the uses come back, in the language of the loaded messages. Run in
//       a zone on each side of UTC (the host's zone cannot see a formatter
//       that forgot timeZone: "UTC"), and with Chrome's own language apart
//       from the bundle it loaded (a French Chrome gets the en messages, and
//       must get an English month).
//   (c) onAutofill, EXECUTED with fetch and executeScript stubbed, west of
//       UTC: one refused request and no more, ATTEMPTS capped at four, what
//       was drafted still written, and a `warn` line that says why. The
//       all-200 run stays `ok`.
//   (d) the stale tab: uses the extension spent reach an open web tab when it is
//       shown again, through a throttled /auth/me re-read that writes the uses
//       store for the account the guard saw and nothing else. `getAuthMe` also
//       re-stamps the resume draft's owner (lib/draft.ts, check 30's F4), so
//       calling it on every return to the tab would stamp one account's draft
//       with another account's id, or with none.
//
// The extension is installed software a deploy cannot update, so a defect here
// stays in the field until its owner replaces the folder and reloads it.
//
// DEGRADES LOUDLY only when extension/ is not in this build at all, check 33's
// shape: `.vercelignore` must drop extension/ whole or not at all. Present but
// missing any file read below is red, since a moved file must move the check.
const EXT_DIR = path.join(ROOT_DIR, "extension");
const EXT_FILES = [
  "popup.js",
  "options.js",
  "popup.html",
  "options.html",
  "manifest.json",
  "_locales/en/messages.json",
  "_locales/he/messages.json",
];
let extensionSkip = null;

/** Chrome's own chrome.i18n.getMessage: `$name$` in any case -> that
 * placeholder's content, `$1`..`$9` inside the content -> the substitutions,
 * `$$` -> `$`, and "" for a message that does not exist. */
function chromeMessage(messages, key, subs) {
  const m = messages[key];
  if (!m || typeof m.message !== "string") return "";
  const list = subs === undefined || subs === null ? [] : Array.isArray(subs) ? subs.map(String) : [String(subs)];
  const ph = {};
  for (const [n, p] of Object.entries(m.placeholders || {})) ph[n.toLowerCase()] = String(p?.content ?? "");
  const inner = (s) => s.replace(/\$\$|\$([1-9])/g, (w, d) => (w === "$$" ? "$" : list[Number(d) - 1] ?? ""));
  return m.message.replace(/\$\$|\$([A-Za-z0-9_@]+)\$/g, (w, name) =>
    w === "$$" ? "$" : name.toLowerCase() in ph ? inner(ph[name.toLowerCase()]) : w,
  );
}

/** Index of the quote that closes the string opening at `i`. */
function skipQuoted(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === q) return j;
  }
  throw new Error(`unterminated string at offset ${i}`);
}

/** The top-level arguments of the call whose `(` is at `open`, and the index of
 * its closing `)`. Strings are skipped whole, so a quoted paren cannot unbalance it. */
function callParts(src, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipQuoted(src, i);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        args.push(src.slice(start, i));
        return { args, end: i };
      }
    } else if (c === "," && depth === 1) {
      args.push(src.slice(start, i));
      start = i + 1;
    }
  }
  throw new Error(`unbalanced call at offset ${open}`);
}

/** The string literals at the TOP level of one argument: both arms of a ternary
 * count, a literal inside a nested call (`el.getAttribute("data-i18n")`) does
 * not. A template literal there cannot be resolved, so it throws. */
function topLiterals(arg) {
  const out = [];
  let depth = 0;
  for (let i = 0; i < arg.length; i++) {
    const c = arg[i];
    if (c === '"' || c === "'" || c === "`") {
      const end = skipQuoted(arg, i);
      if (depth === 0 && c === "`") throw new Error(`a template-literal message key cannot be checked: ${arg.trim()}`);
      if (depth === 0) out.push(arg.slice(i + 1, end));
      i = end;
      continue;
    }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
  }
  return out;
}

/** [where, key] for every message key the extension's files reach by name.
 * `dataKeys` are the keys a function hands back as DATA (`key: "..."`), which
 * no call-site scrape can see. */
function extensionKeyRefs(files, dataKeys = []) {
  const refs = [];
  for (const [file, raw] of Object.entries(files)) {
    if (file.endsWith(".js")) {
      const src = decomment(raw);
      for (const [fn, idx, method] of [
        ["t", 0, false],
        ["showStatus", 1, false],
        ["showMsg", 1, false],
        ["getMessage", 0, true],
      ]) {
        const re = new RegExp(method ? `\\.${fn}\\s*\\(` : `(?<![\\w$.])${fn}\\s*\\(`, "g");
        for (let m; (m = re.exec(src)); ) {
          if (!method && /function\s*$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue;
          const { args } = callParts(src, m.index + m[0].length - 1);
          if (args.length > idx) for (const key of topLiterals(args[idx])) refs.push([`extension/${file} ${fn}()`, key]);
        }
      }
    } else if (file.endsWith(".html")) {
      for (const m of raw.matchAll(/data-i18n(?:-title)?="([^"]*)"/g)) refs.push([`extension/${file} data-i18n`, m[1]]);
    } else if (file.endsWith(".json")) {
      for (const m of raw.matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)) refs.push([`extension/${file} __MSG_`, m[1]]);
    }
  }
  for (const [where, key] of dataKeys) refs.push([where, key]);
  return refs;
}

/** What is wrong between the two locales and the keys the code reaches, as
 * sentences; [] when nothing is. Chrome matches placeholder names in any case. */
function extensionMessageProblems(en, he, refs) {
  const out = [];
  const tokens = (msg) =>
    new Set([...String(msg).replace(/\$\$/g, "").matchAll(/\$([A-Za-z0-9_@]+)\$/g)].map((m) => m[1].toLowerCase()));
  const phMap = (m) =>
    Object.fromEntries(Object.entries(m?.placeholders || {}).map(([n, p]) => [n.toLowerCase(), String(p?.content ?? "")]));
  for (const [loc, mine, other, otherLoc] of [
    ["en", en, he, "he"],
    ["he", he, en, "en"],
  ])
    for (const key of Object.keys(mine))
      if (!(key in other)) out.push(`extension message "${key}" is in ${loc} and not in ${otherLoc}`);
  for (const [loc, bundle] of [
    ["en", en],
    ["he", he],
  ])
    for (const [key, m] of Object.entries(bundle)) {
      if (!m || typeof m.message !== "string") {
        out.push(`extension message "${key}" (${loc}) has no message string`);
        continue;
      }
      const used = tokens(m.message);
      const declared = phMap(m);
      for (const n of used)
        if (!(n in declared))
          out.push(`extension message "${key}" (${loc}) prints $${n.toUpperCase()}$ but declares no such placeholder, so Chrome shows it raw`);
      for (const n of Object.keys(declared))
        if (!used.has(n))
          out.push(`extension message "${key}" (${loc}) declares the placeholder "${n}" and never prints it, so that value is silently dropped`);
    }
  for (const key of Object.keys(en)) {
    if (!(key in he)) continue;
    const a = phMap(en[key]);
    const b = phMap(he[key]);
    for (const n of new Set([...Object.keys(a), ...Object.keys(b)]))
      if (a[n] !== b[n])
        out.push(
          `extension message "${key}": the placeholder "${n}" is ${JSON.stringify(a[n] ?? null)} in en and ` +
            `${JSON.stringify(b[n] ?? null)} in he, so one language prints the wrong value in its place`,
        );
  }
  for (const [where, key] of refs) {
    if (key.startsWith("@@")) continue; // Chrome's predefined messages
    for (const [loc, bundle] of [
      ["en", en],
      ["he", he],
    ])
      if (!(key in bundle)) out.push(`${where} reaches the message "${key}", which ${loc} does not have, so the popup prints the raw key`);
  }
  return [...new Set(out)];
}

/** Load the REAL popup.js into a fresh vm context, with `messages` loaded as
 * the `locale` bundle. Chrome, the DOM and fetch are stubs; `env` swaps in the
 * fetch and executeScript a probe drives, and `env.uiLocale` the language
 * Chrome itself runs in. The two differ in real Chrome: a French, Russian or
 * Arabic Chrome has no bundle of its own and loads the en messages, while
 * `@@ui_locale` and `navigator.language` still say fr, ru or ar. A harness
 * that always makes them equal cannot tell a popup that reads the messages'
 * language from one that reads the UI's. The page's elements are plain objects
 * in `els`. */
function loadPopup(popupSrc, locale, messages, env = {}) {
  const vm = createRequire(import.meta.url)("node:vm");
  const uiLocale = env.uiLocale || locale;
  const uiTag = uiLocale.replace("_", "-");
  const els = {};
  const el = (id) =>
    els[id] ||
    (els[id] = {
      id,
      hidden: true,
      disabled: false,
      textContent: "",
      className: "",
      value: "",
      title: "",
      href: "",
      innerHTML: "",
      addEventListener() {},
      appendChild() {},
    });
  el("kitSelect").value = "7";
  const ctx = vm.createContext({
    console,
    URL,
    setTimeout,
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    navigator: { language: uiTag, languages: [uiTag] },
    document: {
      documentElement: {},
      addEventListener() {},
      getElementById: el,
      querySelector: (sel) => (sel.includes('name="fmt"') ? { value: "pdf" } : null),
      querySelectorAll: () => [],
      createElement: () => el(`created-${Object.keys(els).length}`),
    },
    chrome: {
      i18n: {
        getMessage: (key, subs) =>
          key === "@@ui_locale"
            ? uiLocale
            : key === "@@bidi_dir"
              ? /^(he|iw|ar|fa|ur)(?![a-z])/i.test(uiLocale)
                ? "rtl"
                : "ltr"
              : chromeMessage(messages, key, subs),
      },
      storage: {
        sync: { get: async (defaults) => ({ ...defaults, appUrl: "http://app.test", apiUrl: "http://api.test", accessCode: "K" }) },
      },
      scripting: {
        executeScript:
          env.executeScript ||
          (async () => {
            throw new Error("no page in this probe");
          }),
      },
      tabs: { query: async () => [], create() {} },
      runtime: { openOptionsPage() {} },
    },
    fetch:
      env.fetch ||
      (async (url) => {
        throw new Error(`unexpected fetch ${url}`);
      }),
  });
  vm.runInContext(popupSrc, ctx, { filename: "extension/popup.js" });
  for (const name of ["t", "onAutofill"])
    if (typeof ctx[name] !== "function")
      throw new Error(`extension/popup.js no longer declares a top-level ${name}, so the autofill cannot be driven`);
  return { ctx, els };
}

/** Run `fn` with the whole process in time zone `zone` (a vm context shares
 * it), then put the zone back. The popup's month and date must come from
 * `resets_on` in UTC, and a harness that runs in the host's zone cannot see a
 * formatter that forgot `timeZone: "UTC"`: on the owner's Asia/Jerusalem and
 * on CI's UTC, midnight UTC on the 1st is still the 1st. Only a zone WEST of
 * UTC turns it into the last day of the month before ("August", "September
 * 30"), and only a zone EAST of it catches the mirror-image mistake, a date
 * built in local time and then formatted in UTC. Deleting TZ does not reset
 * ICU (node 24), so an unset TZ is restored by setting back the zone that was
 * in effect and THEN deleting the variable. */
async function inTimeZone(zone, fn) {
  const prevEnv = process.env.TZ;
  const prevZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env.TZ = zone;
  try {
    const offset = new Date(Date.UTC(2026, 9, 1)).getTimezoneOffset();
    if (Intl.DateTimeFormat().resolvedOptions().timeZone !== zone || offset === 0)
      throw new Error(
        `process.env.TZ = "${zone}" did not take effect (${Intl.DateTimeFormat().resolvedOptions().timeZone}, offset ${offset}), ` +
          "so a month read in local time instead of UTC would pass unseen",
      );
    return await fn();
  } finally {
    process.env.TZ = prevEnv ?? prevZone;
    if (prevEnv === undefined) delete process.env.TZ;
  }
}
/** West of UTC by 7 to 8 hours, and east of it by 14: the widest pair there is. */
const EXT_ZONES = ["America/Los_Angeles", "Pacific/Kiritimati"];

try {
  const present = EXT_FILES.filter((f) => fs.existsSync(path.join(EXT_DIR, f)));
  if (!fs.existsSync(EXT_DIR)) {
    extensionSkip = `${EXT_DIR} is not in this build`;
    console.warn(
      `\n  ! check 35 DEGRADED: ${extensionSkip}, so the extension's messages and autofill were NOT checked.\n` +
        `    This is expected only where the frontend is built without the repo around it;\n` +
        `    CI (.github/workflows/ci.yml) checks the whole repo out, so it runs there.\n`,
    );
  } else if (present.length !== EXT_FILES.length) {
    fail(
      `extension/ is in this build without ${EXT_FILES.filter((f) => !present.includes(f)).join(", ")}: a file moved or ` +
        "was deleted, so check 35 has nothing to check. Point the check at the new home; do not delete the assertion.",
    );
  } else {
    const extRead = (f) => fs.readFileSync(path.join(EXT_DIR, f), "utf8");
    const popupSrc = extRead("popup.js");
    const msgs = {
      en: JSON.parse(extRead("_locales/en/messages.json")),
      he: JSON.parse(extRead("_locales/he/messages.json")),
    };
    // A missing message becomes a marker no status line can contain, so the
    // scenario still runs and reports what it did beside the missing sentence.
    const say = (loc, key, subs) => chromeMessage(msgs[loc], key, subs) || `[no "${key}" message in ${loc}]`;

    // (a) Parity, and every key the code reaches. The keys screeningRefusal and
    // its caller hand back as data are read from their own bodies.
    try {
      const dataKeys = [];
      const popupPlain = decomment(popupSrc);
      for (const fn of ["function screeningRefusal", "async function draftScreeningAnswer"]) {
        let body = "";
        try {
          body = fnSource(popupPlain, fn);
        } catch {
          fail(`extension/popup.js has no \`${fn}\`, so a refused screening answer is not read (check 35(a))`);
          continue;
        }
        for (const m of body.matchAll(/\bkey\s*:\s*(["'])([^"']+)\1/g)) dataKeys.push([`extension/popup.js ${fn.split(" ").pop()}`, m[2]]);
      }
      const files = Object.fromEntries(["popup.js", "options.js", "popup.html", "options.html", "manifest.json"].map((f) => [f, extRead(f)]));
      const refs = extensionKeyRefs(files, dataKeys);
      if (refs.length < 40) throw new Error(`only ${refs.length} message references were found in the extension; the scrape is broken`);
      for (const p of extensionMessageProblems(msgs.en, msgs.he, refs)) fail(p);
      // uiLang is how the popup knows which language Chrome loaded, so the
      // month it prints matches the sentence around it (a French Chrome gets the
      // English messages and must get an English month).
      if (msgs.en.uiLang?.message !== "en" || msgs.he.uiLang?.message !== "he")
        fail(
          `the extension's uiLang message is ${JSON.stringify(msgs.en.uiLang?.message)} in en and ` +
            `${JSON.stringify(msgs.he.uiLang?.message)} in he; it must be "en" and "he", or the dates come out in the wrong language`,
        );

      // Both directions on the detector, on a synthetic pair.
      const EN = {
        a: { message: "Hi $NAME$, on $DAY$", placeholders: { name: { content: "$1" }, day: { content: "$2" } } },
        b: { message: "B" },
      };
      const clone = (o) => JSON.parse(JSON.stringify(o));
      const withHe = (edit) => {
        const he = clone(EN);
        edit(he);
        return he;
      };
      const ternary = extensionKeyRefs({ "x.js": 'function t(key) {}\nt(ok ? "a" : "gone");\nt(el.getAttribute("data-i18n"));' });
      const verdicts = [
        ["an identical pair that also reaches @@bidi_dir and @@ui_locale", extensionMessageProblems(EN, clone(EN), [["x", "@@bidi_dir"], ["x", "@@ui_locale"], ["x", "a"]]).length === 0],
        ["a key deleted from he only", extensionMessageProblems(EN, withHe((he) => delete he.b), []).length > 0],
        ["$1 and $2 swapped in he", extensionMessageProblems(EN, withHe((he) => { he.a.placeholders = { name: { content: "$2" }, day: { content: "$1" } }; }), []).length > 0],
        ["a lower-case $name$ in both", extensionMessageProblems(withHe((x) => { x.a.message = "Hi $name$, on $day$"; }), withHe((x) => { x.a.message = "Hi $name$, on $day$"; }), []).length === 0],
        ["a $TOKEN$ with no placeholder", extensionMessageProblems(EN, withHe((he) => { he.a.message = "Hi $NAME$ $WHO$, on $DAY$"; }), []).length > 0],
        ["a placeholder the he sentence never prints", extensionMessageProblems(EN, withHe((he) => { he.a.message = "Hi $NAME$"; }), []).length > 0],
        ["both arms of a ternary scraped, and no nested literal", JSON.stringify(ternary.map((r) => r[1]).sort()) === '["a","gone"]'],
        ["a ternary arm deleted from BOTH locales", extensionMessageProblems(EN, clone(EN), ternary).length > 0],
      ];
      for (const [label, ok] of verdicts) if (!ok) fail(`check 35(a)'s detector misjudges ${label}, so it cannot be trusted on the real messages`);
    } catch (e) {
      fail(`check 35(a), the extension's messages, could not run: ${e.message}`);
    }

    // (b) screeningRefusal, EXECUTED in both languages, in a zone on each side
    // of UTC, and in Chromes whose own language has no bundle (they load en).
    try {
      const MONTHS = {
        en: { oct: ["September", "October 1"], jan: ["December", "January 1"] },
        he: { oct: ["ספטמבר", "1 באוקטובר"], jan: ["דצמבר", "1 בינואר"] },
      };
      const RUNS = [
        { loc: "en", ui: "en_US" },
        { loc: "he", ui: "he" },
        // No fr, ru or ar bundle, so Chrome loads default_locale's (en): the
        // month must be English too, never the UI's own (the uiLang rule).
        { loc: "en", ui: "fr" },
        { loc: "en", ui: "ru" },
        { loc: "en", ui: "ar" },
        // The rule is "the language of the bundle Chrome loaded", whatever the
        // UI says, and only the bundle knows which one that was. With
        // default_locale "he" (one manifest line away), a French Chrome loads
        // these, and a popup that guessed from the UI would print an English
        // month inside the Hebrew sentence.
        { loc: "he", ui: "fr" },
      ];
      for (const zone of EXT_ZONES)
        await inTimeZone(zone, async () => {
          for (const { loc, ui } of RUNS) {
            const where = `${loc} messages, a ${ui} Chrome, ${zone}`;
            const { ctx } = loadPopup(popupSrc, loc, msgs[loc], { uiLocale: ui });
            if (typeof ctx.screeningRefusal !== "function")
              throw new Error(
                "extension/popup.js declares no top-level screeningRefusal(status, detail), so a refused screening answer " +
                  "is dropped: the autofill keeps asking and ends on a green line over empty question boxes",
              );
            const read = (status, detail) => {
              const r = ctx.screeningRefusal(status, detail);
              return r === null ? null : { stop: r.stop, text: ctx.t(r.key, r.subs) };
            };
            const monthly = (resets_on) => ({ code: "monthly_limit", feature: "screening", plan: "free", limit: 10, used: 10, remaining: 0, resets_on });
            const expect = (label, got, stop, text) => {
              if (!got || got.stop !== stop || got.text !== text)
                fail(
                  `check 35(b) [${where}] ${label}: screeningRefusal gives ${JSON.stringify(got)}, expected ` +
                    `${JSON.stringify({ stop, text })}`,
                );
              if (got && /Invalid Date|undefined|NaN|null/.test(got.text))
                fail(`check 35(b) [${where}] ${label}: the sentence reads ${JSON.stringify(got.text)}`);
            };
            expect("429 monthly_limit, resets 2026-10-01", read(429, monthly("2026-10-01")), true, say(loc, "autofillOutOfUses", MONTHS[loc].oct));
            expect("429 monthly_limit, resets 2027-01-01 (the month before is December)", read(429, monthly("2027-01-01")), true, say(loc, "autofillOutOfUses", MONTHS[loc].jan));
            for (const bad of ["", "garbage", "2026-13-01", "2026-02-30", undefined])
              expect(`429 monthly_limit, resets_on ${JSON.stringify(bad)}`, read(429, monthly(bad)), true, say(loc, "autofillOutOfUsesBare"));
            expect("429 daily_limit llm 150", read(429, { code: "daily_limit", action: "llm", cap: 150 }), true, say(loc, "autofillDailyLimit", ["150"]));
            expect("429 daily_limit with no cap", read(429, { code: "daily_limit", action: "llm" }), true, say(loc, "autofillAnswersFailed", ["429"]));
            expect("401", read(401, "Access code required."), true, say(loc, "errUnauthorized"));
            // Every other client error repeats: each question carries the same resume
            // and job text, and a 429 that is not ours is not a monthly limit.
            for (const [status, detail] of [
              [413, { code: "input_too_large" }],
              [403, { code: "csrf" }],
              [404, "Not Found"],
              [405, "Method Not Allowed"],
              [422, [{ loc: ["body", "resume"], msg: "field required" }]],
              [429, { code: "too_many_attempts" }],
              [429, undefined],
              [429, "Too many requests"],
            ])
              expect(`${status} ${JSON.stringify(detail)}`, read(status, detail), true, say(loc, "autofillAnswersFailed", [String(status)]));
            // The false-positive half: this question only, and a success is no refusal.
            for (const status of [400, 500, 502, 503])
              expect(`${status} (this question only)`, read(status, { code: "x" }), false, say(loc, "autofillAnswersFailed", [String(status)]));
            for (const status of [200, 201])
              if (ctx.screeningRefusal(status, { answer: "Yes." }) !== null) fail(`check 35(b) [${where}]: screeningRefusal reads a ${status} as a refusal`);
          }
        });
    } catch (e) {
      fail(`check 35(b), what a refused screening answer says, could not run: ${e.message}`);
    }

    // (c) onAutofill, EXECUTED: the loop around the refusal.
    try {
      const M429 = [429, { detail: { code: "monthly_limit", feature: "screening", plan: "free", limit: 10, used: 10, remaining: 0, resets_on: "2026-10-01" } }];
      const D429 = [429, { detail: { code: "daily_limit", action: "llm", cap: 150 } }];
      const OK = (answer) => [200, { answer }];
      // `fill` stands in for the page: how many of a frame's answers it takes, or
      // "throw" when the frame went away before they could be written.
      const runAutofill = async (loc, frames, script, fill = (texts) => texts.length) => {
        const asked = [];
        const fills = [];
        const env = {
          fetch: async (url, init) => {
            if (url.endsWith("/tools/screening-answer")) {
              const i = asked.length;
              asked.push(JSON.parse(init.body).question);
              const step = script[i] ?? OK(`Answer ${i + 1}`);
              if (step === "throw") throw new TypeError("Failed to fetch");
              const [status, body] = step;
              return { ok: status >= 200 && status < 300, status, json: async () => body };
            }
            if (url.includes("/applications/"))
              return { ok: true, status: 200, json: async () => ({ tailored_resume: { contact: { name: "A B" } }, cover_letter: "", jd_text: "Python role at Acme." }) };
            if (url.endsWith("/render")) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) };
            throw new Error(`unexpected fetch ${url}`);
          },
          executeScript: async ({ target, func, args }) => {
            if (func.name === "fillApplicationForm") return [{ result: { fields: 2, file: true, cover: false } }];
            if (func.name === "collectScreeningQuestions")
              return frames.map((n, f) => ({
                frameId: f * 5,
                result: Array.from({ length: n }, (_, q) => ({ n: q + 1, question: `Frame ${f}, question ${q + 1}: why this role?` })),
              }));
            if (func.name === "fillScreeningAnswers") {
              const texts = args[0].map((a) => a.text);
              fills.push({ frameIds: target.frameIds ? [...target.frameIds] : null, texts });
              const took = fill(texts, target.frameIds?.[0]);
              if (took === "throw") throw new Error("Frame with ID 5 was removed.");
              return [{ result: took }];
            }
            throw new Error(`unexpected injection ${func.name}`);
          },
        };
        const { ctx, els } = loadPopup(popupSrc, loc, msgs[loc], env);
        ctx.approvedKits = [{ id: 7, application_id: 3, company: "Acme" }];
        ctx.activeTab = { id: 1 };
        // West of UTC, where a month read in local time comes out one early.
        await inTimeZone(EXT_ZONES[0], () => ctx.onAutofill());
        return {
          requests: asked.length,
          fills,
          kind: (els.applyStatus?.className ?? "").split(/\s+/),
          text: els.applyStatusText?.textContent ?? "",
        };
      };
      const scenario = async (label, loc, frames, script, want, fill) => {
        const got = await runAutofill(loc, frames, script, fill);
        const wrong = [];
        if (got.requests !== want.requests) wrong.push(`${got.requests} screening requests, not ${want.requests}`);
        if (JSON.stringify(got.fills) !== JSON.stringify(want.fills)) wrong.push(`wrote ${JSON.stringify(got.fills)}, not ${JSON.stringify(want.fills)}`);
        if (!got.kind.includes(want.kind)) wrong.push(`the status is "${got.kind.join(" ")}", not ${want.kind}`);
        for (const s of want.says || []) if (!got.text.includes(s)) wrong.push(`the status line does not say ${JSON.stringify(s)}`);
        for (const s of want.never || []) if (got.text.includes(s)) wrong.push(`the status line says ${JSON.stringify(s)}`);
        if (wrong.length) fail(`check 35(c) [${loc}] ${label}: ${wrong.join("; ")}. The line read ${JSON.stringify(got.text)}`);
      };
      const four = (k = 0) => Array.from({ length: 4 - k }, (_, i) => `Answer ${i + 1 + k}`);
      const blankSentences = (loc) => [
        say(loc, "autofillOutOfUses", loc === "en" ? ["September", "October 1"] : ["ספטמבר", "1 באוקטובר"]),
        say(loc, "autofillAnswersBlank"),
        say(loc, "autofillAnswersFailed", ["502"]),
        say(loc, "autofillAnswersUnwritten"),
      ];
      await scenario("the first answer is refused 429 monthly_limit", "en", [4, 4], [M429], {
        requests: 1,
        fills: [],
        kind: "warn",
        says: [say("en", "autofillOutOfUses", ["September", "October 1"]), say("en", "autofillReviewNote")],
      });
      await scenario("the first answer is refused 429 monthly_limit", "he", [4, 4], [M429], {
        requests: 1,
        fills: [],
        kind: "warn",
        says: [say("he", "autofillOutOfUses", ["ספטמבר", "1 באוקטובר"])],
      });
      await scenario("one answer rides the pass, then the month runs out", "en", [4, 4], [OK("First answer."), M429], {
        requests: 2,
        fills: [{ frameIds: [0], texts: ["First answer."] }],
        kind: "warn",
        says: [say("en", "autofillOutOfUses", ["September", "October 1"])],
      });
      await scenario("a 502, then answers", "en", [4, 4], [[502, { detail: "LLM error while drafting the answer" }]], {
        requests: 4,
        fills: [{ frameIds: [0], texts: four(1) }],
        kind: "warn",
        says: [say("en", "autofillAnswersFailed", ["502"])],
      });
      await scenario("the second request never reaches the server", "en", [4, 4], [OK("First answer."), "throw"], {
        requests: 2,
        fills: [{ frameIds: [0], texts: ["First answer."] }],
        kind: "warn",
        says: [say("en", "errNetwork")],
      });
      await scenario("a 200 with an empty answer", "en", [4, 4], [OK("  ")], {
        requests: 4,
        fills: [{ frameIds: [0], texts: four(1) }],
        kind: "warn",
        says: [say("en", "autofillAnswersBlank")],
      });
      await scenario("the daily limit, in the second frame", "en", [2, 3], [OK("A."), OK("B."), D429], {
        requests: 3,
        fills: [{ frameIds: [0], texts: ["A.", "B."] }],
        kind: "warn",
        says: [say("en", "autofillDailyLimit", ["150"])],
      });
      // Every answer came back, but the frame went away before they were written:
      // a green "Filled N fields" over empty boxes is what this check exists to stop.
      await scenario("every answer drafted, the frame gone before they were written", "en", [4, 4], [], {
        requests: 4,
        fills: [{ frameIds: [0], texts: four() }],
        kind: "warn",
        says: [say("en", "autofillAnswersUnwritten")],
        never: [say("en", "autofillAnswered", ["4"]), say("en", "autofillAnswersBlank")],
      }, () => "throw");
      await scenario("one frame written, the other gone", "he", [2, 3], [], {
        requests: 4,
        fills: [
          { frameIds: [0], texts: ["Answer 1", "Answer 2"] },
          { frameIds: [5], texts: ["Answer 3", "Answer 4"] },
        ],
        kind: "warn",
        says: [say("he", "autofillAnswered", ["2"]), say("he", "autofillAnswersUnwritten")],
      }, (texts, frameId) => (frameId === 5 ? "throw" : texts.length));
      await scenario("the month runs out, and the frame is gone too", "en", [4, 4], [OK("First answer."), M429], {
        requests: 2,
        fills: [{ frameIds: [0], texts: ["First answer."] }],
        kind: "warn",
        says: [say("en", "autofillOutOfUses", ["September", "October 1"]), say("en", "autofillAnswersUnwritten")],
      }, () => "throw");
      // The false-positive half: fillScreeningAnswers leaves a box the user typed
      // into alone ON PURPOSE, so writing fewer than it was handed is not a failure.
      await scenario("the user had typed into three of the boxes", "en", [4, 4], [], {
        requests: 4,
        fills: [{ frameIds: [0], texts: four() }],
        kind: "ok",
        says: [say("en", "autofillAnswered", ["1"])],
        never: blankSentences("en"),
      }, () => 1);
      // The false-positive half: every answer comes back, the line stays green
      // and names no refusal, and the cap still holds at four REQUESTS.
      await scenario("every answer comes back", "en", [4, 4], [], {
        requests: 4,
        fills: [{ frameIds: [0], texts: four() }],
        kind: "ok",
        says: [say("en", "autofillAnswered", ["4"])],
        never: blankSentences("en"),
      });
      await scenario("every answer comes back, over two frames", "he", [2, 3], [], {
        requests: 4,
        fills: [
          { frameIds: [0], texts: ["Answer 1", "Answer 2"] },
          { frameIds: [5], texts: ["Answer 3", "Answer 4"] },
        ],
        kind: "ok",
        never: blankSentences("he"),
      });
    } catch (e) {
      fail(`check 35(c), the autofill loop, could not run: ${e.message}`);
    }
  }
} catch (e) {
  fail(`check 35, the extension, could not run: ${e.message}`);
}

// (d) The stale tab, in the web app itself: it runs whether or not extension/
// is in the build.
/** What is wrong with AppLayout's return-to-the-tab refresh, as sentences. */
function staleTabProblems(layoutSrc) {
  const s = decomment(layoutSrc);
  const out = [];
  const at = s.indexOf('addEventListener("visibilitychange"');
  if (at === -1)
    return [
      'layouts/AppLayout.tsx registers no "visibilitychange" listener, so uses the extension or another tab spent never ' +
        "reach this tab's notes until a reload",
    ];
  const eff = s.lastIndexOf("useEffect(", at);
  if (eff === -1) throw new Error("AppLayout's visibilitychange listener is not inside a useEffect, so its gate and cleanup cannot be read");
  const { args, end } = callParts(s, eff + "useEffect".length);
  if (end < at) throw new Error("AppLayout's visibilitychange listener is not inside the nearest useEffect");
  const body = args[0] ?? "";
  const deps = (args[1] ?? "").trim();
  if (!/removeEventListener\(\s*"visibilitychange"/.test(body)) out.push("AppLayout's visibilitychange listener is never removed");
  if (/\bgetAuthMe\(/.test(body))
    out.push(
      "AppLayout's visibilitychange handler calls getAuthMe, which re-stamps the resume draft's owner (lib/draft.ts) from a " +
        "mid-session answer: an expired session or another account in another tab would claim this tab's draft",
    );
  if (/location\.(?:assign|replace|href)|\bnavigate\(/.test(body))
    out.push("AppLayout's visibilitychange handler redirects; AccessGate owns a session that ended, the refresh only writes the uses store");
  // The throttle, read by its SHAPE and not by its name (checks 15/21: pin which
  // way a gate points). A visibility test flipped to `!==` re-reads a HIDDEN tab
  // and never a shown one, and a dropped `last = now` leaves the throttle
  // counting from mount, so every show after the first minute re-reads
  // /auth/me. Both passed a pin that only asked for `shouldRefreshUses(`.
  //   let <last> = Date.now();                           the mount's ask counts
  //   if (!shouldRefreshUses(<now>, <last>, <visible>)) return;
  //   <last> = <now>;                                    after the gate
  //   void refreshUses(<id>);                            after the gate
  const SHAPE = 'if (!shouldRefreshUses(now, last, document.visibilityState === "visible")) return;';
  const gate = /\bif\s*\(\s*!\s*shouldRefreshUses\s*\(/.exec(body);
  let gateEnd = -1;
  if (!gate) {
    out.push(
      /\bshouldRefreshUses\s*\(/.test(body)
        ? `AppLayout's visibilitychange handler calls shouldRefreshUses, but not as \`${SHAPE}\`, so which way its gate points cannot be read`
        : "AppLayout's visibilitychange handler is not throttled by shouldRefreshUses (lib/usesStore.ts)",
    );
  } else {
    const g = callParts(body, gate.index + gate[0].length - 1);
    const ret = /^\s*\)\s*return\s*;?/.exec(body.slice(g.end + 1));
    if (!ret) out.push(`AppLayout's shouldRefreshUses gate does not return when it says no; it must read \`${SHAPE}\``);
    gateEnd = g.end + 1 + (ret ? ret[0].length : 0);
    const [nowArg = "", lastArg = "", visArg = ""] = g.args.map((a) => a.trim());
    if (g.args.length !== 3) out.push(`AppLayout calls shouldRefreshUses with ${g.args.length} arguments; it must read \`${SHAPE}\``);
    if (!/^(?:document\.visibilityState\s*===\s*(["'])visible\1|!\s*document\.hidden)$/.test(visArg))
      out.push(
        `AppLayout's shouldRefreshUses is told the tab is visible when ${JSON.stringify(visArg)}; it must be ` +
          '`document.visibilityState === "visible"` (or `!document.hidden`), or the tab re-reads its uses while HIDDEN ' +
          "and never when it is shown",
      );
    const nowOk =
      /^Date\.now\(\)$/.test(nowArg) ||
      (/^[A-Za-z_$][\w$]*$/.test(nowArg) && new RegExp(`\\bconst\\s+${nowArg}\\s*=\\s*Date\\.now\\(\\)`).test(body.slice(0, gate.index)));
    if (!nowOk) out.push(`AppLayout's shouldRefreshUses is given ${JSON.stringify(nowArg)} as the time; it must be Date.now(), or a const holding it`);
    if (!/^[A-Za-z_$][\w$]*$/.test(lastArg))
      out.push(`AppLayout's shouldRefreshUses is given ${JSON.stringify(lastArg)} as the last ask; it must be the variable the handler stamps`);
    else {
      const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const stampTo = nowOk && nowArg !== "Date.now()" ? `(?:${esc(nowArg)}|Date\\.now\\(\\))` : "Date\\.now\\(\\)";
      if (!new RegExp(`(?<![\\w$.])${esc(lastArg)}\\s*=(?!=)\\s*${stampTo}(?=\\s*[;\\n}])`).test(body.slice(gateEnd)))
        out.push(
          `AppLayout's visibilitychange handler never stamps \`${lastArg} = ${nowArg || "Date.now()"}\` after the gate, so the ` +
            "throttle counts from mount and every show after the first minute re-reads /auth/me",
        );
      if (!new RegExp(`\\blet\\s+${esc(lastArg)}\\s*=\\s*Date\\.now\\(\\)`).test(body.slice(0, gate.index)))
        out.push(`${lastArg} does not start at Date.now() in the effect: the guard's own /auth/me, just answered, is the last ask`);
    }
  }
  const call = /\brefreshUses\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(body);
  if (!call) {
    out.push("AppLayout's visibilitychange handler does not call refreshUses(<the guard's user id>)");
    return out;
  }
  if (gateEnd !== -1 && call.index < gateEnd) out.push("AppLayout's visibilitychange handler calls refreshUses before its throttle gate");
  const id = call[1];
  if (!new RegExp(`\\b${id}\\b`).test(deps))
    out.push(`AppLayout's visibilitychange effect does not depend on ${id}, the id it refreshes for (deps: ${deps || "none"})`);
  if (!new RegExp(`if\\s*\\(\\s*(?:${id}\\s*===?\\s*null|typeof\\s+${id}\\s*!==\\s*["']number["'])\\s*\\)\\s*return`).test(body))
    out.push(`AppLayout registers the visibilitychange listener without first returning when ${id} is null (the guard failed open)`);
  const state = new RegExp(`const\\s*\\[\\s*${id}\\s*,\\s*([A-Za-z_$][\\w$]*)\\s*\\]\\s*=\\s*useState`).exec(s);
  if (!state) out.push(`${id} is not the guard's own state (\`const [${id}, set…] = useState\`), so nothing ties it to /auth/me's answer`);
  else {
    const sets = [...s.matchAll(new RegExp(`\\b${state[1]}\\(([^)]*)\\)`, "g"))].map((m) => m[1].trim());
    if (!sets.length || sets.some((a) => !/^a\.user[?!]?\.id$/.test(a)))
      out.push(`${state[1]} is called with ${JSON.stringify(sets)}; it may only ever take the guard's answer, a.user.id`);
  }
  return out;
}

/** What client.ts's refreshUses may never do, read from its source, as
 * sentences. What it MUST do (write the store for the same account and for no
 * other answer) is not readable from source: `void usage; setUsage(data.usage
 * ?? null)` names both functions and writes another account's count. That half
 * is EXECUTED, by refreshUsesBehaviour below. */
function refreshUsesProblems(body) {
  const out = [];
  for (const [re, what] of [
    [/\bnoteDraftOwner\(/, "re-stamps the resume draft's owner"],
    [/localStorage\.(?:removeItem|setItem|clear)|ACCESS_CODE_KEY/, "touches the stored invite code"],
    [/location\.(?:assign|replace|href)|dispatchEvent\(/, "redirects, or raises a session event"],
    [/\bgetAuthMe\(/, "goes through getAuthMe and its side effects"],
  ])
    if (re.test(body)) out.push(`refreshUses ${what}; it may write the uses store and nothing else`);
  return out;
}

/** The world refreshUses' imports are bound to: an axios whose GET answers
 * `h.answer` (or throws it), the real usesStore with setUsage recorded, and a
 * draft owner and caches whose every touch is recorded as a side effect. */
function refreshUsesHarness(realUses) {
  const h = { answer: null, urls: [], writes: [], sideEffects: [] };
  h.reset = (answer) => Object.assign(h, { answer, urls: [], writes: [], sideEffects: [] });
  const refuse = (verb) => async (url) => {
    h.sideEffects.push(`sent ${verb} ${url}`);
    throw new Error(`no ${verb} in this probe`);
  };
  h.api = {
    get: async (url) => {
      h.urls.push(url);
      if (h.answer instanceof Error) throw h.answer;
      return { data: h.answer, headers: {} };
    },
    post: refuse("POST"),
    put: refuse("PUT"),
    delete: refuse("DELETE"),
    interceptors: { request: { use() {} }, response: { use() {} } },
  };
  h.stubs = {
    axios: { create: () => h.api, isAxiosError: () => false },
    "../lib/usesStore": { ...realUses, setUsage: (u) => void h.writes.push(u === undefined ? "<undefined>" : u) },
    "../lib/draft": { noteDraftOwner: (id) => void h.sideEffects.push(`stamped the draft owner (${id})`) },
    "../lib/dataCache": {
      cachedFetch: (_k, fn) => fn(),
      clearDataCache: () => void h.sideEffects.push("cleared the data cache"),
      invalidateData: () => void h.sideEffects.push("invalidated the data cache"),
    },
    "../hooks/useMasterResume": { resetMasterCache: () => void h.sideEffects.push("reset the master resume cache") },
  };
  return h;
}

/** Drive `refreshUses` (the real one, or a synthetic twin bound to the same
 * harness) through every answer /auth/me can give a tab it was opened for,
 * account 7, and say what it did wrong. */
async function refreshUsesBehaviour(refreshUses, h) {
  const out = [];
  const mine = { plan: "free", limit: 10, used: 4, remaining: 6, resets_on: "2026-10-01", by_feature: {}, passes: {} };
  const theirs = { ...mine, used: 9, remaining: 1 };
  const signedIn = (id, usage) => ({ authenticated: true, verified: true, method: "session", user: { id }, usage });
  for (const [label, answer, want] of [
    ["the same account", signedIn(7, mine), [mine]],
    ["another account, signed in from another tab of the same browser", signedIn(9, theirs), []],
    ["a session that ended while the tab was hidden", { authenticated: false, verified: false, method: null, user: null, usage: null }, []],
    ["the same account on a plan with no usage block", signedIn(7, null), [null]],
    ["a request that failed", new Error("Network Error"), []],
  ]) {
    h.reset(answer);
    const wrong = [];
    try {
      await refreshUses(7);
    } catch (e) {
      wrong.push(`it rejected (${e.message}), so the listener's \`void\` leaves an unhandled rejection`);
    }
    if (JSON.stringify(h.urls) !== '["/auth/me"]') wrong.push(`it asked ${JSON.stringify(h.urls)}, not /auth/me once`);
    if (JSON.stringify(h.writes) !== JSON.stringify(want))
      wrong.push(`it wrote ${JSON.stringify(h.writes)} into the uses store, not ${JSON.stringify(want)}`);
    if (h.sideEffects.length) wrong.push(`it also ${h.sideEffects.join(", ")}`);
    if (wrong.length) out.push(`refreshUses(7), answered by ${label}: ${wrong.join("; ")}`);
  }
  return out;
}

try {
  const us = runProbeBundle("uses-refresh", `export * from "./lib/usesStore";\n`);
  if (typeof us.shouldRefreshUses !== "function" || typeof us.usageIfSameUser !== "function")
    throw new Error(
      "lib/usesStore.ts exports no shouldRefreshUses / usageIfSameUser, so a tab left open never re-reads the uses " +
        "the extension or another tab spent",
    );
  const T0 = Date.UTC(2026, 8, 21, 12, 0, 0);
  for (const [label, got, want] of [
    ["visible 61 s after the last ask", us.shouldRefreshUses(T0 + 61_000, T0, true), true],
    ["visible exactly 60 s after", us.shouldRefreshUses(T0 + 60_000, T0, true), true],
    ["visible 30 s after (a tab flipped back and forth)", us.shouldRefreshUses(T0 + 30_000, T0, true), false],
    ["hidden, an hour after", us.shouldRefreshUses(T0 + 3_600_000, T0, false), false],
    ["visible, the device clock set back an hour", us.shouldRefreshUses(T0 - 3_600_000, T0, true), true],
  ])
    if (got !== want) fail(`check 35(d): shouldRefreshUses is ${got} when ${label}; it must be ${want}`);
  const usage = { plan: "free", limit: 10, used: 4, remaining: 6, resets_on: "2026-10-01", by_feature: {}, passes: {} };
  const me = (over) => ({ authenticated: true, verified: true, method: "session", user: { id: 7 }, usage, ...over });
  for (const [label, got, want] of [
    ["the same account", us.usageIfSameUser(7, me()), usage],
    ["another account signed in (another tab, the same browser)", us.usageIfSameUser(7, me({ user: { id: 9 } })), undefined],
    ["the session ended", us.usageIfSameUser(7, me({ authenticated: false, user: null, usage: null })), undefined],
    ["the guard failed open (no id)", us.usageIfSameUser(null, me()), undefined],
    ["the same account, no usage block (an exempt plan)", us.usageIfSameUser(7, me({ usage: null })), null],
    ["no answer at all", us.usageIfSameUser(7, null), undefined],
  ])
    if (JSON.stringify(got) !== JSON.stringify(want)) fail(`check 35(d): usageIfSameUser gives ${JSON.stringify(got)} for ${label}; it must give ${JSON.stringify(want)}`);

  for (const p of refreshUsesProblems(fnSource(decomment(read("api/client.ts")), "export async function refreshUses"))) fail(`api/client.ts: ${p}`);
  // The REAL refreshUses, bundled out of api/client.ts with its imports bound to
  // the harness, and EXECUTED against every answer.
  const h = refreshUsesHarness(us);
  const client = runProbeBundle("refresh-uses", `export { refreshUses } from "./api/client";\n`, h.stubs, {
    "import.meta.env": "{}",
  });
  if (typeof client.refreshUses !== "function")
    throw new Error("api/client.ts exports no refreshUses, so a tab shown again cannot re-read its uses");
  for (const p of await refreshUsesBehaviour(client.refreshUses, h)) fail(`api/client.ts: ${p}`);
  for (const p of staleTabProblems(read("layouts/AppLayout.tsx"))) fail(p);

  // Both directions on all three detectors.
  const GOOD_BODY = "{\n  const { data } = await api.get(\"/auth/me\");\n  const usage = usageIfSameUser(expectedId, data);\n  if (usage !== undefined) setUsage(usage);\n}";
  if (refreshUsesProblems(GOOD_BODY).length) fail("check 35(d)'s refreshUses detector fires on a correct body");
  for (const [label, plant] of [
    ["a draft-owner stamp", "noteDraftOwner(data.user?.id ?? null);"],
    ["a stored-code removal", "localStorage.removeItem(ACCESS_CODE_KEY);"],
    ["a redirect", 'window.location.assign("/login");'],
    ["a getAuthMe call", "await getAuthMe();"],
  ])
    if (!refreshUsesProblems(GOOD_BODY.replace("\n}", `\n  ${plant}\n}`)).length)
      fail(`check 35(d)'s refreshUses detector misses ${label}`);
  // A twin is a body bound to the same harness the real one ran against.
  const twin = (body) =>
    new Function("api", "usageIfSameUser", "setUsage", "noteDraftOwner", `return async function refreshUses(expectedId) {\n${body}\n};`)(
      h.api,
      us.usageIfSameUser,
      (u) => h.stubs["../lib/usesStore"].setUsage(u),
      (id) => h.stubs["../lib/draft"].noteDraftOwner(id),
    );
  const GOOD_TWIN =
    'try {\n  const { data } = await api.get("/auth/me");\n  const usage = usageIfSameUser(expectedId, data);\n' +
    "  if (usage !== undefined) setUsage(usage);\n} catch {}";
  const goodTwin = await refreshUsesBehaviour(twin(GOOD_TWIN), h);
  if (goodTwin.length) fail(`check 35(d)'s refreshUses behaviour probe fires on a correct body: ${goodTwin.join("; ")}`);
  for (const [label, body] of [
    ["the guard read and then ignored (`void usage; setUsage(data.usage ?? null)`)", GOOD_TWIN.replace("if (usage !== undefined) setUsage(usage);", "void usage; setUsage(data.usage ?? null);")],
    ["the guard folded into the write (`setUsage(usageIfSameUser(expectedId, data) ?? null)`)", GOOD_TWIN.replace(/const usage = [^\n]+\n\s*if \(usage !== undefined\) setUsage\(usage\);/, "setUsage(usageIfSameUser(expectedId, data) ?? null);")],
    ["a write on any answer (`if (usage) … else setUsage(null)`)", GOOD_TWIN.replace("if (usage !== undefined) setUsage(usage);", "setUsage(usage ?? null);")],
    ["no catch, so a failed request rejects", GOOD_TWIN.replace(/^try \{\n/, "").replace(/\n\} catch \{\}$/, "")],
    ["a draft-owner stamp", GOOD_TWIN.replace("if (usage !== undefined)", "noteDraftOwner(data.user?.id ?? null);\n  if (usage !== undefined)")],
  ]) {
    if (body === GOOD_TWIN) throw new Error(`check 35(d)'s plant "${label}" did not apply, so it probes nothing`);
    if (!(await refreshUsesBehaviour(twin(body), h)).length) fail(`check 35(d)'s refreshUses behaviour probe misses ${label}`);
  }

  const LAYOUT = (effect, guard = "if (a.user) setMeId(a.user.id);", fallback = "if (live) setAuthed(true);") =>
    "const [meId, setMeId] = useState<number | null>(null);\n" +
    `getAuthMe().then((a) => { ${guard} setAuthed(true); }).catch(() => { ${fallback} });\n` +
    effect;
  const EFFECT =
    "useEffect(() => {\n  if (meId === null) return;\n  let last = Date.now();\n  const onVisible = () => {\n" +
    '    if (!shouldRefreshUses(Date.now(), last, document.visibilityState === "visible")) return;\n' +
    "    last = Date.now();\n    void refreshUses(meId);\n  };\n" +
    '  document.addEventListener("visibilitychange", onVisible);\n' +
    '  return () => document.removeEventListener("visibilitychange", onVisible);\n}, [meId]);\n';
  // The same effect in AppLayout's own style: a `now` const, and `!document.hidden`.
  const EFFECT_NOW = EFFECT.replace(
    '    if (!shouldRefreshUses(Date.now(), last, document.visibilityState === "visible")) return;\n    last = Date.now();\n',
    "    const now = Date.now();\n    if (!shouldRefreshUses(now, last, !document.hidden)) return;\n    last = now;\n",
  );
  if (EFFECT_NOW === EFFECT) throw new Error("check 35(d)'s second correct layout did not apply");
  for (const [label, effect] of [
    ["the inline form", EFFECT],
    ["the `now` const and `!document.hidden` form", EFFECT_NOW],
  ]) {
    const p = staleTabProblems(LAYOUT(effect));
    if (p.length) fail(`check 35(d)'s stale-tab detector fires on a correct layout (${label}): ${p.join("; ")}`);
  }
  const plant = (effect, from, to) => {
    const out = effect.replace(from, to);
    if (out === effect) throw new Error(`check 35(d)'s stale-tab plant ${from} did not apply, so it probes nothing`);
    return out;
  };
  for (const [label, layout] of [
    ["a handler that calls getAuthMe (the draft-owner leak)", LAYOUT(plant(EFFECT, "void refreshUses(meId);", "void getAuthMe().catch(() => {});"))],
    ["a listener that is never removed", LAYOUT(plant(EFFECT, /\n  return \(\) => [^\n]+/, ""))],
    ["a gate on `authed` alone", LAYOUT(plant(EFFECT, "if (meId === null) return;", "if (!authed) return;").replace("[meId]", "[authed]"))],
    ["a handler that redirects", LAYOUT(plant(EFFECT, "void refreshUses(meId);", 'void refreshUses(meId); window.location.assign("/login");'))],
    ["no throttle", LAYOUT(plant(EFFECT, /\n    if \(!shouldRefreshUses[^\n]+/, ""))],
    ["an id set when the guard failed open", LAYOUT(EFFECT, undefined, "if (live) { setAuthed(true); setMeId(0); }")],
    ["no listener at all", LAYOUT("")],
    // The throttle's shape: each of these passed the name-only pin.
    ["the visibility test flipped (`!==`)", LAYOUT(plant(EFFECT, '=== "visible"', '!== "visible"'))],
    ["the visibility test flipped (`document.hidden`)", LAYOUT(plant(EFFECT_NOW, "!document.hidden", "document.hidden"))],
    ["the visibility test on another value (`=== \"hidden\"`)", LAYOUT(plant(EFFECT, '=== "visible"', '=== "hidden"'))],
    ["the gate's `!` dropped", LAYOUT(plant(EFFECT, "if (!shouldRefreshUses", "if (shouldRefreshUses"))],
    ["the gate not returning", LAYOUT(plant(EFFECT, /\)\) return;\n    last/, ")) {}\n    last"))],
    ["the throttle stamp deleted", LAYOUT(plant(EFFECT, "\n    last = Date.now();", ""))],
    ["the throttle stamp deleted (the `now` form)", LAYOUT(plant(EFFECT_NOW, "\n    last = now;", ""))],
    ["the throttle stamped with 0", LAYOUT(plant(EFFECT_NOW, "last = now;", "last = 0;"))],
    ["the throttle stamp compared, not assigned", LAYOUT(plant(EFFECT_NOW, "last = now;", "last == now;"))],
    ["the last ask starting at 0", LAYOUT(plant(EFFECT, "let last = Date.now();", "let last = 0;"))],
    ["refreshUses called before the gate", LAYOUT(plant(EFFECT, "  const onVisible = () => {\n", "  const onVisible = () => {\n    void refreshUses(meId);\n").replace("    last = Date.now();\n    void refreshUses(meId);\n", "    last = Date.now();\n"))],
  ])
    if (!staleTabProblems(layout).length) fail(`check 35(d)'s stale-tab detector misses ${label}`);
} catch (e) {
  fail(`check 35(d), the stale tab, could not run: ${e.message}`);
}

// ---- 36. a remounted cover letter reads its posting's pass back ------------ //
// P30-RELOAD-PASS. A cover-letter pass belongs to ONE posting, so neither
// /auth/me nor the X-Uses-Pass header lists it, and CoverLetter kept it in
// component state alone. A page that REMOUNTED the card — a reload of
// /kits/:id, whose JD the server stores, or Tracker and back on /app — forgot
// it, and at 0 uses left disabled Generate on a change the server would still
// include: the one error usesStore's header forbids a local count to make.
// Now the card asks POST /cover-letter/pass on mount, and that answer and the
// letter's own response both arrive in RELATIVE seconds, which `inclusionFrom`
// turns into a deadline on arrival, so a phone whose clock runs ahead cannot
// end the pass early either (the absolute `included_until` could).
//
// (a) EXECUTES the helper on a driven clock, the catch beside every null twin.
// (b) pins the component's wiring — it cannot be rendered in node — on the real
//     file AND on fixtures, each of which must go red on its own rule, beside
//     twins it must not refuse: until the probe (or a letter) answers, the card
//     KNOWS nothing, so it prints no note and disables nothing (unknown is never
//     zero; the server decides) — `known` starts false, and no code outside the
//     probe's effect and generate() sets it true; the probe's answer and a
//     served letter each set the pass from what came back; the probe's answer
//     makes it known and a failed probe never does, whether the failure is a
//     `.catch`, a `.finally` or `.then`'s second argument; a new posting starts
//     unknown again; Generate's `disabled=` is exactly `known && uses.out` (`!known || uses.out` names the
//     same words and disables for good after a failed probe); a letter that did
//     not answer (a 5xx, a dropped request, a finally) leaves `known` as it was,
//     and only the served letter and the monthly-limit refusal set it; and a
//     probe answer that lands after a letter started is dropped, because it
//     describes the pass before that letter took its slot. That last gate is
//     pinned by its CONTROL FLOW, not by an operator's presence: a one-character
//     inversion (`=== … return`, `alive ||`) passed an earlier draft green while
//     dropping every normal answer.
// (c) pins the wire: the client posts exactly `{ jd }` (the route forbids any
//     other field, so a `resume` beside it is a 422 and the card stays unknown
//     for ever, silently) to the path routes.py mounts.
try {
  const us = runProbeBundle("reload-pass", `export * from "./lib/usesStore";\n`);
  for (const name of ["inclusionFrom", "setUsage", "outFor", "getUsesState", "resetUses"])
    if (typeof us[name] !== "function") throw new Error(`lib/usesStore.ts does not export ${name}`);
  const realNow = Date.now;
  let clock = Date.UTC(2026, 8, 15, 12, 0, 0);
  Date.now = () => clock;
  try {
    const atZero = () => ({
      plan: "free",
      limit: 10,
      used: 10,
      remaining: 0,
      resets_on: "2026-10-01",
      by_feature: {},
      passes: {},
    });
    // The catch: at 0 left, a pass the server reported with 3 changes and 600 s covers the next change for 600 s.
    us.setUsage(atZero());
    const stored = us.getUsesState();
    const it = us.inclusionFrom({ calls_left: 3, expires_in_s: 600 });
    if (!it || it.left !== 3 || typeof it.until !== "string")
      fail(
        `inclusionFrom({calls_left: 3, expires_in_s: 600}) returned ${JSON.stringify(it)}; it must be ` +
          "{ until: <ISO deadline>, left: 3 }, the shape CoverLetter keeps and hands to useUses.",
      );
    else {
      if (us.outFor("cover_letter", it.until))
        fail(
          "at 0 uses left, a cover-letter pass the server reported open (3 changes, 600 s) does not cover the next " +
            "change — Generate is disabled on a call the server includes.",
        );
      clock += 599_000;
      if (us.outFor("cover_letter", it.until)) fail("inclusionFrom's deadline ends before the 600 s the server said.");
      clock += 2_000;
      if (!us.outFor("cover_letter", it.until))
        fail("inclusionFrom's deadline still covers after the 600 s the server said, so Generate stays on into a 429.");
    }
    if (us.getUsesState() !== stored)
      fail("inclusionFrom wrote to the uses store; it is a reading for one card, and the store's header lists every writer.");
    // The twins: nothing that is not an open pass with a change left and time left may read as one.
    for (const [label, p] of [
      ["{calls_left: 0, expires_in_s: 600}", { calls_left: 0, expires_in_s: 600 }],
      ["{calls_left: 3, expires_in_s: 0}", { calls_left: 3, expires_in_s: 0 }],
      ["{calls_left: 0, expires_in_s: 0}", { calls_left: 0, expires_in_s: 0 }],
      ["{calls_left: -1, expires_in_s: 600}", { calls_left: -1, expires_in_s: 600 }],
      ["{calls_left: 2.5, expires_in_s: 600}", { calls_left: 2.5, expires_in_s: 600 }],
      ["{} (an older backend)", {}],
      ["undefined", undefined],
      ["null", null],
    ])
      if (us.inclusionFrom(p) !== null)
        fail(`inclusionFrom(${label}) is ${JSON.stringify(us.inclusionFrom(p))}, not null — it covers a call no pass covers.`);
    // The clock rule. A device 2 hours AHEAD of the server: the server's own "10 minutes from now", read as an
    // absolute instant, has already ended there — the firing proof that the skew is real — while the same pass in
    // relative seconds covers exactly 600 s from arrival.
    clock = Date.UTC(2026, 8, 15, 14, 0, 0);
    us.setUsage(atZero());
    const serverSays = new Date(Date.UTC(2026, 8, 15, 12, 10, 0)).toISOString();
    if (!us.outFor("cover_letter", serverSays))
      throw new Error("an absolute instant 2 hours behind the device still covers, so the skewed-clock case proves nothing");
    const fast = us.inclusionFrom({ calls_left: 3, expires_in_s: 600 });
    if (!fast || us.outFor("cover_letter", fast.until))
      fail(
        "on a phone whose clock runs 2 hours ahead, inclusionFrom's deadline has already ended: it must be Date.now() " +
          "on arrival plus the server's seconds, never the server's instant.",
      );
    clock += 601_000;
    if (fast && !us.outFor("cover_letter", fast.until)) fail("on a fast clock inclusionFrom covers past its 600 s.");
    // And a device years BEHIND gets exactly 600 s too, not the years to the server's instant.
    clock = Date.UTC(2019, 0, 1, 0, 0, 0);
    us.setUsage(atZero());
    const slow = us.inclusionFrom({ calls_left: 3, expires_in_s: 600 });
    clock += 601_000;
    if (!slow || !us.outFor("cover_letter", slow.until))
      fail("on a clock years behind, inclusionFrom's deadline outlives the 600 s the server said.");
  } finally {
    us.resetUses();
    Date.now = realNow;
  }
} catch (e) {
  fail(`cover-letter pass probe (check 36a) could not run: ${e.message}`);
}

/** The index of the bracket closing the one at `open` — (, [ or { — skipping
 * quoted strings; -1 when it never closes. */
function closeOf(s, open) {
  const PAIR = { "(": ")", "[": "]", "{": "}" };
  if (!PAIR[s[open]]) throw new Error(`closeOf was pointed at ${JSON.stringify(s[open])}, which opens nothing`);
  const want = [];
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < s.length && s[i] !== ch; i++) if (s[i] === "\\") i++;
    } else if (PAIR[ch]) want.push(PAIR[ch]);
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (want.pop() !== ch) return -1;
      if (!want.length) return i;
    }
  }
  return -1;
}

/** `s` cut at every `sep` outside brackets and strings, each part trimmed. */
function splitTopLevel(s, sep) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < s.length && s[i] !== ch; i++) if (s[i] === "\\") i++;
    } else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (depth === 0 && s.startsWith(sep, i)) {
      parts.push(s.slice(from, i));
      from = i + sep.length;
      i = from - 1;
    }
  }
  parts.push(s.slice(from));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * The body of an inline callback, the text inside its braces: `(r) => { … }`,
 * `r => { … }`, `async` either way, a typed `(r: T): void => { … }`, or
 * `function (r) { … }`. null for anything else (a function passed by name, an
 * expression body), which therefore holds no sequence gate of its own.
 */
function callbackBody(cb) {
  let i = /^async\b\s*/.exec(cb)?.[0].length ?? 0;
  const fn = /^function\b\s*(?:[A-Za-z_$][\w$]*\s*)?/.exec(cb.slice(i));
  if (fn) i += fn[0].length;
  if (cb[i] === "(") {
    const shut = closeOf(cb, i);
    if (shut === -1) return null;
    i = shut + 1;
  } else {
    const id = fn ? null : /^[A-Za-z_$][\w$]*/.exec(cb.slice(i));
    if (!id) return null;
    i += id[0].length;
  }
  const head = /^\s*(?::\s*[\w$.<>[\]|, ]+?)?\s*(=>)?\s*\{/.exec(cb.slice(i));
  // An arrow needs its `=>`, and a function expression has none.
  if (!head || !head[1] === !fn) return null;
  const open = i + head[0].length - 1;
  const shut = closeOf(cb, open);
  if (shut === -1 || cb.slice(shut + 1).trim()) return null;
  return cb.slice(open + 1, shut);
}

/** Bracket depth at `idx` in `s`, counted from its start, skipping strings. */
function depthAt(s, idx) {
  let depth = 0;
  for (let i = 0; i < idx; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < idx && s[i] !== ch; i++) if (s[i] === "\\") i++;
    } else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
  }
  return depth;
}

/** Where `s` leaves the block it starts in: the first bracket it closes without opening; s.length when none. */
function blockEnd(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < s.length && s[i] !== ch; i++) if (s[i] === "\\") i++;
    } else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch) && --depth < 0) return i;
  }
  return s.length;
}

/**
 * The probe's answer callbacks and its failure handlers. Each answer is the first
 * argument of one `.then` chained on `coverLetterPass(`, as `{ text, body }`,
 * where `body` is what `callbackBody` reads (null when it reads none). They stay
 * SEPARATE: an early return exits only its own callback, and every later
 * `.then` still runs, so a check in one callback guards nothing in another. A
 * failure handler is `.then`'s second argument, a `.catch`, or a `.finally`
 * (which runs on a failure too). A `.then` after a `.catch` or a two-argument
 * `.then` runs after a failure as well, so it counts as a failure handler. An
 * awaited probe has no chain: its one answer runs from the request to the first
 * `catch`, and everything after that is failure.
 */
function probeHandlers(probe, ask) {
  const close = closeOf(probe, probe.indexOf("(", ask));
  if (close === -1) throw new Error("the cover letter's coverLetterPass( never closes");
  const answers = [];
  const failures = [];
  let at = close + 1;
  let chained = false;
  let recovered = false;
  for (let m; (m = /^\s*\.\s*(then|catch|finally)\s*\(/.exec(probe.slice(at))); ) {
    chained = true;
    const open = at + m[0].length - 1;
    const end = closeOf(probe, open);
    if (end === -1) throw new Error(`the probe's .${m[1]}( never closes`);
    const args = splitTopLevel(probe.slice(open + 1, end), ",");
    if (m[1] === "then") {
      const first = args[0] ?? "";
      if (recovered) failures.push(first);
      else answers.push({ text: first, body: callbackBody(first) });
      failures.push(...args.slice(1));
      if (args.length > 1) recovered = true;
    } else {
      failures.push(...args);
      if (m[1] === "catch") recovered = true;
    }
    at = end + 1;
  }
  if (chained) return { answers, failures };
  const failed = /\bcatch\b/.exec(probe.slice(ask));
  const awaited = failed ? probe.slice(ask, ask + failed.index) : probe.slice(ask);
  return { answers: [{ text: awaited, body: awaited }], failures: failed ? [probe.slice(ask + failed.index)] : [] };
}

/**
 * How the probe's answer drops itself when a letter started since it was sent.
 * Two shapes are accepted, and only these: an early return on `seq.current !==
 * at` (optionally `|| !alive`) before anything is applied, or the apply inside
 * `if (seq.current === at) { … }` (optionally `alive &&`). `at` is the number
 * the probe took before it asked (null when it took none, which no shape
 * accepts). The control flow is what is read, not an operator's presence:
 * `=== … return` and `!== { apply }` name the same words as the two accepted
 * shapes and drop every normal answer.
 *
 * The check must sit at the TOP LEVEL of one answer callback's body. Inside a
 * nested arrow its `return` leaves only that arrow, and under another `if` it
 * runs only when that condition holds; either way the code after it runs for a
 * dropped answer too. `guarded` is the code of that callback that runs only
 * past the check; `outside` is the rest of it, plus every OTHER answer callback
 * whole, since a later `.then` runs whether an earlier one returned or not.
 */
function sequenceGuard(answers, at) {
  const all = answers.map((a) => a.text).join("\n");
  for (const [n, { body }] of answers.entries()) {
    if (body === null) continue;
    const others = answers
      .filter((_, k) => k !== n)
      .map((a) => a.text)
      .join("\n");
    const IF = /\bif\s*\(/g;
    for (let m; (m = IF.exec(body)); ) {
      const open = m.index + m[0].length - 1;
      const close = closeOf(body, open);
      if (close === -1) throw new Error("an if ( in the probe's answer never closes");
      const cond = body.slice(open + 1, close);
      if (!/\bseq\.current\b/.test(cond) || depthAt(body, m.index) !== 0) continue;
      let j = close + 1;
      while (/\s/.test(body[j] ?? "")) j++;
      let block = null;
      let end;
      if (body[j] === "{") {
        const shut = closeOf(body, j);
        if (shut === -1) throw new Error("the block after the probe's sequence check never closes");
        block = body.slice(j + 1, shut);
        end = shut + 1;
      } else {
        const ret = /^return\s*;?/.exec(body.slice(j));
        // A lone statement under the check is neither accepted shape.
        if (!ret) return { ok: false, guarded: all, outside: "" };
        end = j + ret[0].length;
      }
      const early = block === null || /^\s*return\s*;?\s*$/.test(block);
      const norm = (t) => {
        const x = t.replace(/\s+/g, "");
        return /^\(.*\)$/.test(x) ? x.slice(1, -1) : x;
      };
      const terms = splitTopLevel(cond, early ? "||" : "&&").map(norm);
      const seq = early ? [`seq.current!==${at}`, `${at}!==seq.current`] : [`seq.current===${at}`, `${at}===seq.current`];
      const alive = early ? "!alive" : "alive";
      const ok = at !== null && terms.some((t) => seq.includes(t)) && terms.every((t) => seq.includes(t) || t === alive);
      const before = body.slice(0, m.index);
      if (!early) return { ok, guarded: block, outside: `${before}${body.slice(end)}\n${others}` };
      // An awaited answer is a slice of a larger function, not a callback: past
      // the end of the block holding the check, the return may not have skipped
      // anything (it leaves a nested function, not a block), so that is outside.
      const rest = body.slice(end);
      const stop = blockEnd(rest);
      return { ok, guarded: rest.slice(0, stop), outside: `${before}${rest.slice(stop)}\n${others}` };
    }
  }
  return { ok: false, guarded: all, outside: "" };
}

/**
 * What CoverLetter.tsx's wiring gets wrong, as rule ids; [] when nothing. THROWS
 * when a landmark the rules read is missing, so a rewrite that moves one is a
 * red build naming it rather than a rule that passes by reading nothing.
 */
function coverLetterWiring(text) {
  // Trailing // comments too (decomment takes only whole-line ones), sparing a
  // "https://" inside a string: a parenthesis in a comment would unbalance the
  // effect reader below.
  const s = decomment(text)
    .replace(/\r\n/g, "\n")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const bad = new Set();
  // A pass actually set from the answer: a `setPass(` whose argument is not the literal null.
  const APPLIES = /\bsetPass\(\s*(?!null\s*\))/;
  const known = (t) => (t.match(/\bsetKnown\(\s*true\s*\)/g) || []).length;
  if (!/\[\s*known\s*,\s*setKnown\s*\]\s*=\s*useState(?:<[^>]*>)?\(\s*false\s*\)/.test(s)) bad.add("known-starts-unknown");
  const effects = [];
  for (let at = s.indexOf("useEffect("); at !== -1; at = s.indexOf("useEffect(", at + 1)) {
    const open = at + "useEffect".length;
    let depth = 0;
    let end = -1;
    for (let i = open; i < s.length; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end === -1) throw new Error("a useEffect( in the cover letter never closes");
    effects.push(s.slice(open + 1, end));
  }
  const probe = effects.find((e) => /\bcoverLetterPass\(/.test(e));
  if (!probe) bad.add("probe-on-mount");
  else {
    const deps = /,\s*\[([^\]]*)\]\s*$/.exec(probe);
    const keys = deps ? deps[1].split(",").map((d) => d.trim()) : [];
    if (!keys.includes("posting")) bad.add("probe-on-mount");
    const ask = probe.indexOf("coverLetterPass(");
    const skip = /\bif\s*\(\s*!\s*limited\s*\)\s*return\b/.exec(probe);
    if (!skip || skip.index > ask || !keys.includes("limited")) bad.add("probe-keyed-on-limit");
    if (!/\binclusionFrom\(/.test(probe)) bad.add("probe-relative-seconds");
    const reset = /\bsetKnown\(\s*false\s*\)/.exec(probe);
    if (!reset || reset.index > ask) bad.add("probe-resets-known");
    // The number this probe takes before it asks, which its answer is compared with.
    const took = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*\+\+\s*seq\.current\b/.exec(probe);
    const { answers, failures } = probeHandlers(probe, ask);
    const guard = sequenceGuard(answers, took && took.index < ask ? took[1] : null);
    if (!guard.ok || /\bsetPass\(/.test(guard.outside)) bad.add("probe-sequence-guard");
    if (!APPLIES.test(guard.guarded)) bad.add("probe-applies");
    const onFailure = failures.reduce((n, f) => n + known(f), 0);
    if (onFailure) bad.add("probe-failure-unknown");
    // Known past the sequence check, in the callback that holds it, and nowhere
    // else in the effect: not before the request, not after a block the check
    // guards, not in another `.then` (which runs whether the check returned or not).
    if (!known(guard.guarded) || known(probe) > known(guard.guarded) + onFailure) bad.add("probe-known");
  }
  const gen = fnSource(s, "async function generate");
  const call = gen.indexOf("await coverLetter(");
  const caught = gen.indexOf("catch");
  if (call === -1 || caught === -1 || caught < call)
    throw new Error("cannot find generate()'s `await coverLetter(` and the catch after it");
  const bump = /\+\+\s*seq\.current|seq\.current\s*(?:\+\+|\+=\s*1)/.exec(gen);
  if (!bump || bump.index > call) bad.add("generate-bumps-sequence");
  const served = gen.slice(call, caught);
  // Anywhere in the card, not only in generate(): the absolute instant is the clock the pass must not read.
  if (!/\binclusionFrom\(/.test(served) || /\bincluded_until\b/.test(s)) bad.add("generate-relative-seconds");
  if (!/\bsetKnown\(\s*true\s*\)/.test(served)) bad.add("generate-known");
  if (!APPLIES.test(served)) bad.add("generate-applies");
  const limit = /\bif\s*\(\s*isMonthlyLimit\(\s*e\s*\)\s*\)\s*/.exec(gen.slice(caught));
  if (!limit) throw new Error("cannot find the `if (isMonthlyLimit(e))` branch in generate()'s catch");
  const branch = caught + limit.index + limit[0].length;
  const shut = gen[branch] === "{" ? closeOf(gen, branch) + 1 : gen.indexOf(";", branch) + 1;
  if (!shut) throw new Error("generate()'s `if (isMonthlyLimit(e))` branch never ends");
  if (!/\bsetKnown\(\s*true\s*\)/.test(gen.slice(branch, shut))) bad.add("limit-known");
  // Everywhere else in generate() no letter answered: before the request, the
  // rest of the catch, a finally. `known` stays as it was there, either way.
  if (/\bsetKnown\(/.test(gen.slice(0, call) + gen.slice(caught, branch) + gen.slice(shut)))
    bad.add("generate-failure-known");
  // Only the probe's effect and generate() may make the card known; the rules
  // above say where inside each.
  if (known(s) > known(probe ?? "") + known(gen)) bad.add("known-elsewhere");
  const click = s.indexOf("onClick={() => generate()}");
  const button = click === -1 ? -1 : s.lastIndexOf("<Button", click);
  if (button === -1) throw new Error("cannot find the Generate button (`<Button … onClick={() => generate()}`)");
  const disabled = /\bdisabled=\{([^}]*)\}/.exec(s.slice(button, click));
  // The WHOLE expression is the conjunction, in either order. Naming both words
  // is not enough: `!known || uses.out` names them and disables while the pass
  // is unknown, and for good once the probe failed.
  let expr = disabled ? disabled[1].replace(/\s+/g, "") : "";
  if (/^\(.*\)$/.test(expr)) expr = expr.slice(1, -1);
  if (expr !== "known&&uses.out" && expr !== "uses.out&&known") bad.add("button-known");
  const notes = (s.match(/<UsesNote\b/g) || []).length;
  if (!notes) throw new Error("the cover letter renders no <UsesNote");
  if ((s.match(/\{\s*known\s*&&\s*\(?\s*<UsesNote\b/g) || []).length !== notes) bad.add("note-known");
  return [...bad];
}
const COVER_WIRING_HARM = {
  "probe-on-mount":
    "never asks POST /cover-letter/pass from an effect keyed on `posting` (coverLetterPass). A remounted card — a " +
    "reload of /kits/:id, Tracker and back on /app — forgets its posting's pass, and at 0 uses left disables " +
    "Generate on a change the server would still include",
  "probe-keyed-on-limit":
    "does not ask the probe exactly while a monthly limit is known (`if (!limited) return` before coverLetterPass, " +
    "AND `limited` in the effect's deps). Without the dep, a card that mounted before the count was known never " +
    "asks once it is, and stays unknown for good; without the guard the admin pays the round trip for nothing",
  "probe-relative-seconds":
    "keeps the probe's answer without passing it through inclusionFrom, so the server's relative seconds never " +
    "become a deadline taken on arrival",
  "probe-applies":
    "never sets the pass from the probe's answer past its sequence check (a setPass( other than setPass(null)). " +
    "The card turns known with the pass it already had, which on a remount is none, so at 0 uses left it prints " +
    "'No uses left' and disables a change the server still includes: the very defect the probe exists to fix",
  "probe-resets-known":
    "does not reset `known` before asking about a posting (setKnown(false) before coverLetterPass). After a posting " +
    "change the old posting's `known` stands until the probe answers, so at 0 uses left Generate is disabled for a " +
    "posting whose pass nobody has read yet",
  "probe-known":
    "does not mark the pass known exactly where the probe's answer has passed its sequence check (setKnown(true) " +
    "past the seq.current check, in the same answer callback, and nowhere else in the effect). Missing there, the " +
    "card stays unknown until a letter comes back: <UsesNote> never renders, so the first letter's cost is never " +
    "stated before the tap, and at 0 uses with no pass Generate is never disabled. Anywhere else (before the " +
    "request, after a block the check guards, or in a later `.then`, which runs whether the check's early return " +
    "fired or not) it marks known a pass nobody read, which at 0 uses prints 'No uses left' and disables a change " +
    "the server may still include",
  "probe-failure-unknown":
    "marks the pass known when the probe FAILED (in a .catch, a .finally, or .then's second argument). With no " +
    "answer the pass reads as none, so at 0 uses left a 5xx or a dropped request prints 'No uses left' and disables " +
    "a change the server may still include — unknown is never zero",
  "probe-sequence-guard":
    "does not drop a probe answer that lands after a letter started, in one of the two shapes this check accepts: " +
    "the probe takes `const at = ++seq.current` before it asks, and its answer either returns early on " +
    "`seq.current !== at` (optionally `|| !alive`) before it applies anything, or applies itself only inside " +
    "`if (seq.current === at) { … }` (optionally `alive &&`), at the top level of the answer callback that applies. " +
    "A late answer describes the pass BEFORE that letter took its slot, and putting the slot back hides the next " +
    "letter's cost; a late 'no pass' wipes the pass the letter just opened. An inverted gate (`=== … return`, " +
    "`!== { apply }`, or `alive` read the wrong way round) drops every normal answer instead, so the card never " +
    "learns its pass before the first letter. A gate anywhere but the top level of the callback that applies is " +
    "refused: an early return leaves only its own function, so a check in a nested arrow, under another `if`, or " +
    "in an earlier `.then` (a later `.then` runs whether it returned or not) lets a dropped answer apply, and a " +
    "positive block under another `if` adds a condition that leaves some answers never applied and never known",
  "generate-bumps-sequence":
    "does not bump seq.current before a letter's request goes out, so a probe still in flight is applied after it",
  "generate-relative-seconds":
    "reads `included_until`, an absolute instant compared against the device clock, or sets the pass from a " +
    "letter's response without inclusionFrom: on a phone whose clock runs ahead the pass ends early, and at 0 uses " +
    "that disables a covered change",
  "generate-known": "does not mark the pass known after a letter came back, although that response says what it is",
  "generate-applies":
    "never sets the pass from a served letter (a setPass( other than setPass(null)). After the first letter opens " +
    "the posting's pass the card still holds none, so at 0 uses left it prints 'No uses left' and disables the " +
    "changes that pass includes",
  "known-starts-unknown":
    "does not start `known` as false (`useState(false)`). A card that mounts knowing reads the pass it has not " +
    "asked about as none, so at 0 uses left it prints 'No uses left' and disables Generate before the probe answers",
  "known-elsewhere":
    "marks the pass known outside the probe's effect and generate(). No answer stands behind that, so at 0 uses " +
    "left it reads the unread pass as none, prints 'No uses left' and disables a change the server may still include",
  "generate-failure-known":
    "sets `known` where no letter answered: before the request, in the catch outside its `isMonthlyLimit(e)` " +
    "branch, or in a finally. A 5xx or a dropped letter must leave `known` as it was. If the Generate tap dropped " +
    "the probe's answer, marking the card known on that failure reads the unread pass as none, and at 0 uses left " +
    "prints 'No uses left' and disables a change the server may still include",
  "limit-known":
    "does not mark the pass known after a monthly-limit refusal, which proves no pass covers the call — so the " +
    "card keeps Generate enabled into the same 429",
  "button-known":
    "disables Generate on something other than exactly `known && uses.out` (either order). `uses.out` alone disables " +
    "at 0 uses left while the probe is pending, and `!known || uses.out` disables while the pass is unknown and for " +
    "good once the probe failed, uses left or not: each disables a change the pass may still cover — unknown is " +
    "never zero",
  "note-known":
    "renders <UsesNote> while the pass is unknown, so at 0 uses left it prints 'No uses left' under a change the " +
    "pass may include",
};
try {
  for (const rule of coverLetterWiring(read("components/CoverLetter.tsx")))
    fail(`components/CoverLetter.tsx ${COVER_WIRING_HARM[rule] ?? rule}.`);

  // Both directions on the reader: the shipped shape passes, and each fixture
  // below goes red on ITS rule.
  const GOOD = [
    "export default function CoverLetter({ resume, jd }: Props) {",
    "  const [known, setKnown] = useState(false);",
    "  const seq = useRef(0);",
    "  useEffect(() => {",
    "    if (!limited) return;",
    "    const at = ++seq.current;",
    "    setKnown(false);",
    "    coverLetterPass(jd).then((r) => {",
    "      if (seq.current !== at) return; // a letter started (since then)",
    "      const inc = inclusionFrom(r);",
    "      setPass(inc ? { ...inc, posting } : null);",
    "      setKnown(true);",
    "    }).catch(() => {",
    "      // left unknown: the server decides",
    "    });",
    "  }, [posting, limited]);",
    "",
    "  async function generate(extra?: string) {",
    "    seq.current++;",
    "    try {",
    "      const res = await coverLetter(resume, jd, tone);",
    "      const inc = inclusionFrom({ calls_left: res.changes_left, expires_in_s: res.expires_in_s });",
    "      setPass(inc ? { ...inc, posting } : null);",
    "      setKnown(true);",
    "    } catch (e: any) {",
    "      if (isMonthlyLimit(e)) {",
    "        setPass(null);",
    "        setKnown(true);",
    "      } else if (isServerFailure(e)) setPass((p) => p);",
    "    }",
    "  }",
    "",
    "  return (",
    "    <Card>",
    "      <Button disabled={known && uses.out} onClick={() => generate()}>",
    "      </Button>",
    "      {known && (",
    '        <UsesNote feature="cover_letter" />',
    "      )}",
    "    </Card>",
    "  );",
    "}",
  ].join("\n");
  const good = coverLetterWiring(GOOD);
  if (good.length) fail(`check 36's wiring reader refuses the shape CoverLetter ships: ${good.join(", ")}`);
  const mutate = (label, from, to) => {
    const out = GOOD.replace(from, to);
    if (out === GOOD) throw new Error(`check 36's fixture "${label}" did not apply, so it proves nothing`);
    return out;
  };
  // The probe's early return and its apply, as GOOD writes them, and the same
  // apply under a block: the sequence gate's fixtures and twins rewrite these.
  const G_GUARD = "      if (seq.current !== at) return; // a letter started (since then)\n";
  const G_SET = "      const inc = inclusionFrom(r);\n      setPass(inc ? { ...inc, posting } : null);\n";
  const G_APPLY = G_SET + "      setKnown(true);\n";
  const block = (cond, inner = G_APPLY) => `      if (${cond}) {\n${inner}      }\n`;
  const G_CATCH = "    }).catch(() => {\n      // left unknown: the server decides\n    });";
  const G_TAIL = "      } else if (isServerFailure(e)) setPass((p) => p);\n    }\n";
  const FIXTURES = [
    [
      "the probe sent only inside generate()",
      mutate(
        "probe in generate",
        /  useEffect\(\(\) => \{[\s\S]*?\}, \[posting, limited\]\);\n/,
        "",
      ).replace("    seq.current++;", "    seq.current++;\n    coverLetterPass(jd);"),
      "probe-on-mount",
    ],
    ["an effect keyed without `posting`", mutate("deps", "[posting, limited]", "[limited]"), "probe-on-mount"],
    ["the probe's answer kept raw", mutate("raw", "const inc = inclusionFrom(r);", "const inc = r;"), "probe-relative-seconds"],
    ["no sequence check on the probe", mutate("no guard", "      if (seq.current !== at) return; // a letter started (since then)\n", ""), "probe-sequence-guard"],
    ["no sequence bump in generate()", mutate("no bump", "    seq.current++;\n", ""), "generate-bumps-sequence"],
    [
      "generate() reading included_until",
      mutate(
        "absolute",
        "const inc = inclusionFrom({ calls_left: res.changes_left, expires_in_s: res.expires_in_s });",
        "const inc = res.included_until ? { until: res.included_until, left: res.changes_left } : null;",
      ),
      "generate-relative-seconds",
    ],
    ["a letter that leaves the pass unknown", mutate("served", "      setKnown(true);\n    } catch", "    } catch"), "generate-known"],
    [
      "a monthly-limit branch that leaves the pass unknown",
      mutate("limit", "if (isMonthlyLimit(e)) {\n        setPass(null);\n        setKnown(true);\n      }", "if (isMonthlyLimit(e)) setPass(null);\n     "),
      "limit-known",
    ],
    ["Generate disabled on uses.out alone", mutate("button", "disabled={known && uses.out}", "disabled={uses.out}"), "button-known"],
    [
      "Generate disabled while unknown (`!known || uses.out`)",
      mutate("button or", "disabled={known && uses.out}", "disabled={!known || uses.out}"),
      "button-known",
    ],
    ["Generate disabled on either word", mutate("button either", "disabled={known && uses.out}", "disabled={known || uses.out}"), "button-known"],
    ["a note rendered while unknown", mutate("note", "{known && (", "{("), "note-known"],
    ["a probe sent with no monthly limit known", mutate("no limit guard", "    if (!limited) return;\n", ""), "probe-keyed-on-limit"],
    ["an effect keyed without `limited`", mutate("deps without limited", "[posting, limited]", "[posting]"), "probe-keyed-on-limit"],
    ["a new posting that keeps the old `known`", mutate("no reset", "    setKnown(false);\n", ""), "probe-resets-known"],
    [
      "a probe answer that leaves the pass unknown",
      mutate("probe answer", "      setKnown(true);\n    }).catch(", "    }).catch("),
      "probe-known",
    ],
    [
      "a probe marking the pass known before its sequence check",
      mutate(
        "known before guard",
        "      if (seq.current !== at) return; // a letter started (since then)\n      const inc = inclusionFrom(r);\n" +
          "      setPass(inc ? { ...inc, posting } : null);\n      setKnown(true);\n",
        "      setKnown(true);\n      if (seq.current !== at) return; // a letter started (since then)\n" +
          "      const inc = inclusionFrom(r);\n      setPass(inc ? { ...inc, posting } : null);\n",
      ),
      "probe-known",
    ],
    [
      "a failed probe read as no pass",
      mutate("probe failure", "      // left unknown: the server decides\n", "      setPass(null);\n      setKnown(true);\n"),
      "probe-failure-unknown",
    ],
    // The sequence gate by its control flow: each inversion names the same words
    // as an accepted shape and drops every normal answer, or applies a late one.
    ["an early return on `seq.current === at`", mutate("eq return", "if (seq.current !== at) return;", "if (seq.current === at) return;"), "probe-sequence-guard"],
    ["the answer applied inside `if (seq.current !== at) { … }`", mutate("neq block", G_GUARD + G_APPLY, block("seq.current !== at")), "probe-sequence-guard"],
    ["`alive` un-negated in the early return", mutate("alive or", "if (seq.current !== at) return;", "if (alive || seq.current !== at) return;"), "probe-sequence-guard"],
    ["`!alive` in the positive block's conjunction", mutate("not alive and", G_GUARD + G_APPLY, block("!alive && seq.current === at")), "probe-sequence-guard"],
    ["a probe that takes no sequence number of its own", mutate("no take", "const at = ++seq.current;", "const at = seq.current;"), "probe-sequence-guard"],
    ["the pass set before the sequence check", mutate("pass first", G_GUARD + G_SET, G_SET + G_GUARD), "probe-sequence-guard"],
    ["the pass known after the positive block, for a dropped answer too", mutate("known after block", G_GUARD + G_APPLY, block("seq.current === at", G_SET) + "      setKnown(true);\n"), "probe-known"],
    ["the pass known before the probe's request", mutate("known before ask", "    setKnown(false);\n", "    setKnown(false);\n    setKnown(true);\n"), "probe-known"],
    ["a failed probe read as no pass in `.then`'s second argument", mutate("then fail", G_CATCH, "    }, () => {\n      setPass(null);\n      setKnown(true);\n    });"), "probe-failure-unknown"],
    ["a `.finally` that marks the pass known", mutate("finally", G_CATCH, G_CATCH.replace(/;$/, ".finally(() => setKnown(true));")), "probe-failure-unknown"],
    // The gate guards only the callback it sits in, and only from its top level:
    // an early return leaves its own function, and every later `.then` still runs.
    ["a later `.then` that marks the pass known past the early return", mutate("then known", G_GUARD + G_APPLY, G_GUARD + G_SET + "    }).then(() => {\n      setKnown(true);\n"), "probe-known"],
    ["the gate filtering in its own `.then`, the apply in the next", mutate("filter then apply", G_GUARD + G_APPLY, G_GUARD + "      return r;\n    }).then((r) => {\n" + G_APPLY), "probe-sequence-guard"],
    ["the pass set in an earlier `.then` than the gate", mutate("apply then gate", G_GUARD + G_APPLY, G_SET + "    }).then(() => {\n" + G_GUARD + "      setKnown(true);\n"), "probe-sequence-guard"],
    ["the early return inside a nested arrow", mutate("nested arrow", G_GUARD, "      const stale = () => {\n        if (seq.current !== at) return;\n      };\n      stale();\n"), "probe-sequence-guard"],
    ["the early return under another condition", mutate("nested return", G_GUARD, "      if (r.calls_left > 0) {\n        if (seq.current !== at) return;\n      }\n"), "probe-sequence-guard"],
    ["the positive block under another condition", mutate("nested block", G_GUARD + G_APPLY, "      if (r.calls_left > 0) {\n" + block("seq.current === at") + "      }\n"), "probe-sequence-guard"],
    [
      "an awaited filter whose caller applies the answer it dropped",
      mutate(
        "awaited filter",
        /    coverLetterPass\(jd\)\.then\(\(r\) => \{\n[\s\S]*?\n    \}\);\n/,
        "    (async () => {\n      try {\n        const r = await (async () => {\n          const got = await coverLetterPass(jd);\n" +
          "          if (seq.current !== at) return;\n          return got;\n        })();\n" + G_APPLY +
          "      } catch {\n        // left unknown\n      }\n    })();\n",
      ),
      "probe-sequence-guard",
    ],
    // An answer read and then thrown away is the defect the probe exists to fix.
    ["the probe's answer never applied", mutate("probe no apply", G_GUARD + G_APPLY, G_GUARD + "      const inc = inclusionFrom(r);\n      setKnown(true);\n"), "probe-applies"],
    ["the probe applying `null`", mutate("probe null", G_GUARD + G_APPLY, G_GUARD + "      const inc = inclusionFrom(r);\n      setPass(null);\n      setKnown(true);\n"), "probe-applies"],
    [
      "a served letter that never sets the pass",
      mutate("letter no apply", "      setPass(inc ? { ...inc, posting } : null);\n      setKnown(true);\n    } catch", "      setKnown(true);\n    } catch"),
      "generate-applies",
    ],
    // A letter that did not answer leaves `known` as it was.
    ["the pass known at the top of generate()'s catch", mutate("catch known", "    } catch (e: any) {\n", "    } catch (e: any) {\n      setKnown(true);\n"), "generate-failure-known"],
    ["the pass known in the else after the 5xx decrement", mutate("else known", G_TAIL, G_TAIL.replace("p);\n", "p);\n      else setKnown(true);\n")), "generate-failure-known"],
    ["the pass known in generate()'s finally", mutate("finally known", G_TAIL, G_TAIL + "    finally {\n      setKnown(true);\n    }\n"), "generate-failure-known"],
    ["the pass known before the letter's request", mutate("known first", "    seq.current++;\n", "    seq.current++;\n    setKnown(true);\n"), "generate-failure-known"],
    ["the pass made unknown by a failed letter", mutate("catch unknown", "    } catch (e: any) {\n", "    } catch (e: any) {\n      setKnown(false);\n"), "generate-failure-known"],
    // Nothing but those answers may make the card known, from its first render on.
    ["a card that mounts knowing", mutate("starts known", "useState(false);", "useState(true);"), "known-starts-unknown"],
    [
      "the pass known by another effect",
      mutate("other effect", "  async function generate(", "  useEffect(() => {\n    setKnown(true);\n  }, [text]);\n\n  async function generate("),
      "known-elsewhere",
    ],
    ["included_until read outside generate()", mutate("until elsewhere", "  const seq = useRef(0);\n", "  const seq = useRef(0);\n  const until = pass?.included_until;\n"), "generate-relative-seconds"],
  ];
  for (const [label, fixture, rule] of FIXTURES) {
    const got = coverLetterWiring(fixture);
    if (!got.includes(rule))
      fail(`check 36's wiring reader accepts ${label} (it read ${JSON.stringify(got)}, not "${rule}"), so it would pass for ever`);
  }
  // The false-positive half: shapes the rules above must NOT refuse.
  const TWINS = [
    ["Generate's conjunction the other way round", mutate("twin order", "disabled={known && uses.out}", "disabled={uses.out && known}")],
    ["Generate's conjunction in parentheses, spaced", mutate("twin parens", "disabled={known && uses.out}", "disabled={ (known  &&  uses.out) }")],
    [
      "the probe's answer applied under a positive sequence check",
      mutate(
        "twin positive guard",
        "      if (seq.current !== at) return; // a letter started (since then)\n      const inc = inclusionFrom(r);\n" +
          "      setPass(inc ? { ...inc, posting } : null);\n      setKnown(true);\n",
        "      if (seq.current === at) {\n        const inc = inclusionFrom(r);\n" +
          "        setPass(inc ? { ...inc, posting } : null);\n        setKnown(true);\n      }\n",
      ),
    ],
    ["`!alive` beside the sequence check (the shape CoverLetter ships)", mutate("twin not alive", "if (seq.current !== at) return;", "if (!alive || seq.current !== at) return;")],
    ["the sequence check's operands reversed", mutate("twin reversed", "if (seq.current !== at) return;", "if (at !== seq.current || !alive) return;")],
    ["a braced early return", mutate("twin braced", "if (seq.current !== at) return;", "if (seq.current !== at) {\n        return;\n      }")],
    ["`alive &&` in the positive block", mutate("twin alive and", G_GUARD + G_APPLY, block("alive && seq.current === at"))],
    ["a failure in `.then`'s second argument that leaves the pass unknown", mutate("twin then fail", G_CATCH, "    }, () => {\n      // left unknown\n    });")],
    [
      "an awaited probe inside try/catch",
      mutate(
        "twin await",
        /    coverLetterPass\(jd\)\.then\(\(r\) => \{\n[\s\S]*?\n    \}\);\n/,
        "    (async () => {\n      try {\n        const r = await coverLetterPass(jd);\n" + G_GUARD + G_APPLY +
          "      } catch {\n        // left unknown\n      }\n    })();\n",
      ),
    ],
    ["a finally in generate() that only clears loading", mutate("twin finally", G_TAIL, G_TAIL + "    finally {\n      setLoading(false);\n    }\n")],
    // A `.then` with no gate that neither applies nor marks known, and the other ways to write the one that does.
    [
      "an earlier `.then` that only converts the answer",
      mutate(
        "twin convert",
        "    coverLetterPass(jd).then((r) => {\n" + G_GUARD + G_SET,
        "    coverLetterPass(jd).then((r) => inclusionFrom(r)).then((inc) => {\n" + G_GUARD + "      setPass(inc ? { ...inc, posting } : null);\n",
      ),
    ],
    ["a `function` expression as the answer", mutate("twin function", ".then((r) => {", ".then(function (r) {")],
    ["an `async` arrow with a bare parameter", mutate("twin async", ".then((r) => {", ".then(async r => {")],
    ["a typed parameter and return type", mutate("twin typed", ".then((r) => {", ".then((r: UsagePassOut): void => {")],
  ];
  for (const [label, fixture] of TWINS) {
    const got = coverLetterWiring(fixture);
    if (got.length) fail(`check 36's wiring reader refuses ${label}, a legitimate shape (it read ${JSON.stringify(got)})`);
  }
} catch (e) {
  fail(`cover-letter wiring check (check 36b) could not run: ${e.message}`);
}
try {
  const client = decomment(read("api/client.ts"));
  const POSTS_JD_ONLY = /\bapi\.post<[^>]*>\(\s*"\/cover-letter\/pass"\s*,\s*\{\s*jd\s*\}\s*\)/;
  if (!POSTS_JD_ONLY.test(fnSource(client, "export async function coverLetterPass")))
    fail(
      'api/client.ts: coverLetterPass does not post exactly `{ jd }` to "/cover-letter/pass". The route forbids any ' +
        "other field, so a resume beside the JD is a 422 and every card stays unknown, silently.",
    );
  if (POSTS_JD_ONLY.test('api.post<UsagePassOut>("/cover-letter/pass", { resume, jd })') ||
      !POSTS_JD_ONLY.test('api.post<UsagePassOut>("/cover-letter/pass", { jd })'))
    fail("check 36's client reader cannot tell `{ jd }` from `{ resume, jd }`");
  const routes = pySource("app/api/routes.py", "check 36");
  if (routes !== null && !/^@router\.post\(\s*"\/cover-letter\/pass"/m.test(routes))
    fail(
      'backend/app/api/routes.py mounts no POST "/cover-letter/pass", which api/client.ts calls: the probe would be ' +
        "a 404 on every mount and the card would stay unknown, silently.",
    );
} catch (e) {
  fail(`cover-letter probe route check (check 36c) could not run: ${e.message}`);
}

// ---- 37. every code the inbox sends has a sentence of its own --------------- //
// P29-INBOX-CODES. The inbox backend talks to the page in three families of
// codes, and each has a hand-written `switch` on this side that turns a code
// into a sentence:
//   - SYNC codes: `InboxSyncResult.error_code` and `InboxStatus.last_error_code`
//     (app/core/inbox_sync.py, plus the connect routes that reset `last_error`)
//     -> `useSyncErrorText` in components/inbox/shared.tsx;
//   - ROUTE REFUSALS: `HTTPException(detail={"code": …})` in
//     app/api/inbox_routes.py -> `useInboxRefusalText`, same file;
//   - CALLBACK REASONS: the `/settings?inbox=<reason>` the Gmail callback
//     redirects with -> `callbackMessage` in InboxSettingsCard.tsx.
// Nothing compared the two sides, and one drifted where a user could read it.
// FIXB B15 (1836d30) made a sync return `invite_only` for a connected user taken
// off the allowlist, three hours after the switch was written, and touched no
// frontend file. The code fell to `default`, so someone who can never sync again
// was told "The last sync ran into a problem. It tries again on the next sync."
//
// So the codes are READ from the backend, and:
//   37(a)-(c) every code in each family has a `case` of its OWN. An arm that
//      returns the generic sentence is allowed: it makes "the generic sentence
//      is right for this code" a decision a reviewer can see, instead of a
//      default nobody chose. A `case` stacked on `default:` is not an arm of its
//      own. Each `default` is pinned to its generic sentence and never to the code.
//   37(d) no file under components/inbox/ can reach `apiErrorMessage` except
//      through `useInboxRefusalText`. The name may appear only in shared.tsx's
//      plain `import { … }` and inside the hook; any other mention (a call, an
//      aliased import, `api.apiErrorMessage(…)`) and any namespace or dynamic
//      import of lib/apiError fails. Call sites that went around the hook showed
//      a refusal it translates as "please try again": a 403 invite_only on the
//      tracker's Reconnect read "Couldn't start reconnecting".
//   37(e) the other direction. Every case literal must be a code the backend
//      really sends, and so must every code a component compares with
//      `apiErrorCode(…)`, an `error_code` / `last_error_code`, a status `reason`
//      or a connection `.status`, and every member of shared.tsx's ANSWERS. A
//      backend rename otherwise leaves the comparison false for ever: the review
//      sheet's `left` would put an email that was already filed back in the
//      queue, and a renamed "needs_reauth" would hide Reconnect. Each
//      `InboxStatus.reason` must also be compared in BOTH the bar and the
//      Settings card, or a new reason hides both. A connection that is off the
//      invite list is held to its own rendering, the import line included.
//
// WHAT IS READ, AND WHAT THROWS. Python is read as text (pySource + pyCode), not
// through an AST, so every reader has a CLOSED grammar over the SITES it knows:
// at a site, a value it cannot read throws an error that names the file's own
// line. Every family also has NETS, so each other way of writing it that is named
// below throws instead of going unread. What no reader or net can see is listed
// under KNOWINGLY UNREAD, not claimed as covered.
//   - A sync code is the value written to `error_code`, `last_error` or
//     `last_error_code` in inbox_sync.py or inbox_routes.py: `x.error_code = …`
//     or a bare `error_code = …` ANYWHERE on a line (after `if x:` or `;` too),
//     an annotated default `last_error: str = …`, or an `error_code=` keyword
//     (a black-formatted continuation line, two on one line). A keyword's value
//     runs to the first top-level `,` or the `)` closing its call; a statement's
//     to its end, across lines while a bracket is open. Both branches of a
//     ternary are read and its condition is not; `X or "lit"` reads both sides.
//     A term is one of four things:
//       - a literal;
//       - `code`, allowed only inside a def that has a `code` parameter. That def
//         is an EMITTER, and the value passed as `code` at each call to it is read;
//       - `conn.status`, which reads every connection status (below) except "active";
//       - a pass-through, `result.error_code` or `conn.last_error`.
//     At an emitter's call site, `e.code` is Google's: the code argument of every
//     `GoogleAuthError(…)` in the google_oauth functions that def calls, followed
//     through google_oauth's own helpers, plus inbox_sync's `_REAUTH_CODES`. That
//     argument is read the same way (each literal branch is a code), and
//     `_error_code(…)` is the ONE open-set shape it allows.
//     NETS: an augmented or walrus write (`+=`, `:=`), a tuple assignment (the
//     field among the targets, or a tuple as the value), the field named in a
//     string (`setattr(r, "error_code", …)`, `model_copy(update={"error_code":
//     …})`), and `**` unpacked into `InboxSyncResult(…)`, `MailConnection(…)` or
//     `.values(…)`.
//   - A connection status is the value of `x.status = …` for ANY receiver (so an
//     alias `mc = conn; mc.status = …` is read), `x.status: T = …`, or a `status=`
//     keyword (`MailConnection(…, status=…)`, a bulk
//     `update(MailConnection).values(status=…)`), in the same two files. A term
//     is a literal or the `conn.status` passthrough. Not a connection's, and not
//     read: a bare local `status = …` (depth 0: inbox_routes' HTTP status), a def's
//     own `status=` default, and anything inside a class in APP_STATUS_CLASSES
//     (`_Card`, which copies an APPLICATION's status). NETS: the augmented and
//     tuple forms, and `"status"` named in a string, as for sync codes.
//   - A refusal is the detail of an `HTTPException(` in a top-level def of
//     inbox_routes.py, keyword or positional. The detail is absent, a message
//     literal (no code: lib/apiError reads one only out of an object), or a
//     dict literal with one `"code"` key. The code is a literal, or an f-string
//     with one placeholder that is a parameter of its own def (today `_finish`'s
//     `refusal`). The f-string is expanded through every call to that def: the
//     `inbox_apply.<fn>(…)` passed there, inline or through one variable, and every
//     `return` in that fn must be a string literal. `cron_unconfigured` is the one
//     server-only code, and only `def inbox_cron(` may raise it. NETS: any
//     `"code":` key in the file that no such detail carried, any `code=` keyword
//     of a `dict(…)`, and any `code=` keyword handed a string literal. Handing on
//     a variable as `code=` is not a refusal (`exchange_code(code=code)` passes
//     Google's OAuth code), and neither is a def's own `code="…"` default.
//   - A callback reason is the argument passed to a nested `def X(reason…)` inside
//     `inbox_google_callback` (today `fail` and `refuse`): a literal or a ternary
//     of literals, or, inside an emitter only, its own `reason`. The same callback's
//     `leave(path)` is read too. A literal `/settings?inbox=<reason>` is a reason;
//     `/tracker?inbox=connected` is the success; a path with no `inbox=` carries
//     none. `"/settings?inbox=" + quote(reason, …)` inside an emitter is the one
//     computed path. NET: any `?inbox=` / `&inbox=` in the file that no leave()
//     carried throws.
//   - On the page, a comparison is `===` / `!==` against a literal, directly or
//     through one `const` holding the compared value. Every `.status` so compared
//     under components/inbox is read as the connection's: no inbox component
//     compares an application's status with a literal today.
// Google's OPEN set stays on `default` by design: its own `error` strings and
// `http_<status>` arrive through `_error_code(…)` and `e.code` and never appear as
// literals here. A Google string mapped on purpose goes in GOOGLE_PASSTHROUGH.
// KNOWINGLY UNREAD (no reader, no net; rewrite into a read shape, or teach one):
//   - a sync code or a connection status written from any other module
//     (db/models.py's column defaults included), or through a name the text
//     cannot see: `setattr` with a computed name, `model_copy(update=<variable>)`,
//     `**` unpacked anywhere but the three calls above;
//   - a GoogleAuthError raised outside google_oauth (gmail_api raises its own,
//     which no emitter's `except` hands on today), or in a google_oauth function
//     reached other than by its plain name (a method, a function passed as a value);
//   - an inbox refusal raised outside inbox_routes.py (a dependency, the gate),
//     or sent from inbox_routes.py some way the nets do not name (a `code=`
//     keyword handed a variable, outside `dict(…)`);
//   - a callback redirect whose `inbox=` is not written literally (urlencode);
//   - a code or status the page compares other than with `===` / `!==` (a
//     `switch` outside the three hooks, `.includes(…)`, a lookup table);
//   - a wrapper of apiErrorMessage defined outside components/inbox.
//
// Floors sit just under today's counts. Check 29 resolves the key each arm
// returns (literal t() calls, looked up in the namespace each binding names).
// This check holds the arms to that literal shape so check 29 can see them.
// Degrades only when backend/ is absent; the frontend half (the grammar, the
// defaults, the wiring) still runs.
const INBOX_SYNC_PY = "app/core/inbox_sync.py";
const INBOX_ROUTES_PY = "app/api/inbox_routes.py";
const INBOX_APPLY_PY = "app/core/inbox_apply.py";
const GOOGLE_OAUTH_PY = "app/core/google_oauth.py";
const INBOX_SERVER_ONLY = new Set(["cron_unconfigured"]); // never reaches a browser
const GOOGLE_PASSTHROUGH = new Set(); // Google's own strings given a sentence on purpose; none today
const PY_LIT = /^(["'])([^"'\\]*)\1$/;
const SYNC_PASS = new Set(["result.error_code", "conn.last_error"]);

/** The balanced bracket that opens at `src[open]`, skipping string contents:
 * its inside, and the index just past its close. */
function pyParen(src, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c) && --depth === 0) return { inner: src.slice(open + 1, i), end: i + 1 };
  }
  throw new Error(`unbalanced bracket at \`${src.slice(open, open + 60).split("\n")[0]}\``);
}

/** An argument or parameter list split on its top-level commas (or on another
 * top-level separator: `+` splits a concatenation into its pieces). */
function pySplit(inner, sep = ",") {
  const out = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === sep && depth === 0) {
      out.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (inner.slice(start).trim()) out.push(inner.slice(start).trim());
  return out;
}

/** The first argument-shaped piece of `text`: up to a top-level `,` or the `)`
 * that closes the call it sits in. */
function pyArgHead(text) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) return text.slice(0, i);
      depth--;
    } else if (c === "," && depth === 0) return text.slice(0, i);
  }
  return text;
}

/** Per character of pyCode `code`: the bracket depth it sits at (a bracket
 * itself counts at the depth outside it) and whether it is inside a string,
 * plus `lineOf(index)`, 1-based. A string ends with its line: pyCodeLines has
 * already blanked the only strings that can span lines. */
function pyScan(code) {
  const depth = new Int32Array(code.length + 1);
  const inStr = new Uint8Array(code.length + 1);
  const starts = [0];
  let d = 0;
  let quote = null;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    depth[i] = d;
    if (c === "\n") {
      starts.push(i + 1);
      quote = null;
    } else if (quote) {
      inStr[i] = 1;
      if (c === "\\" && i + 1 < code.length && code[i + 1] !== "\n") {
        depth[i + 1] = d;
        inStr[i + 1] = 1;
        i++;
      } else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      inStr[i] = 1;
    } else if ("([{".includes(c)) d++;
    else if (")]}".includes(c)) depth[i] = d = Math.max(0, d - 1);
  }
  depth[code.length] = d;
  const lineOf = (idx) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  return { depth, inStr, lineOf };
}

/** The rest of the statement a value starts at `from`: up to the newline or `;`
 * at the depth `from` sits at, so a bracketed value may span lines. */
function pyStatementTail(code, scan, from) {
  const base = scan.depth[from];
  for (let j = from; j < code.length; j++)
    if (!scan.inStr[j] && scan.depth[j] === base && (code[j] === "\n" || code[j] === ";")) return code.slice(from, j);
  return code.slice(from);
}

/** Whether a plain `=` (not `==`, `<=`, `+=`, `:=`…) follows `from` at its own
 * depth before its statement ends: `from` is then inside an assignment's targets. */
function pyAssignsLater(code, scan, from) {
  const base = scan.depth[from];
  for (let j = from; j < code.length; j++) {
    if (scan.inStr[j]) continue;
    if (scan.depth[j] === base && (code[j] === "\n" || code[j] === ";")) return false;
    if (code[j] === "=" && scan.depth[j] === base && code[j + 1] !== "=" && !"=!<>:+-*/%&|^@".includes(code[j - 1]))
      return true;
  }
  return false;
}

/** The call whose bracket encloses index `idx` of pyCode `code`: { name, def },
 * where `name` is the dotted name before the `(` ("" for a bare bracket or a
 * list, dict or set literal) and `def` says the bracket is a def's signature.
 * null at depth 0. */
function pyCallee(code, scan, idx) {
  const d = scan.depth[idx];
  if (!d) return null;
  for (let j = idx - 1; j >= 0; j--)
    if (!scan.inStr[j] && scan.depth[j] === d - 1 && "([{".includes(code[j])) {
      const before = code.slice(Math.max(0, j - 160), j);
      const m = /([A-Za-z_][\w.]*)\s*$/.exec(before);
      if (code[j] !== "(" || !m) return { name: "", def: false };
      return { name: m[1], def: /\bdef\s+$/.test(before.slice(0, m.index)) };
    }
  return null;
}

/** 1-based [first, last] line spans of the top-level classes of pyCode `code`
 * whose names are in `names`. */
function pyClassSpans(code, names) {
  const lines = code.split("\n");
  const spans = [];
  for (const m of code.matchAll(/^class (\w+)\b/gm)) {
    if (!names.has(m[1])) continue;
    const first = code.slice(0, m.index).split("\n").length;
    let last = lines.length;
    for (let i = first; i < lines.length; i++)
      if (/^[^\s)]/.test(lines[i])) {
        last = i;
        break;
      }
    spans.push([first, last]);
  }
  return spans;
}

/** Every top-level def in pyCode `code`: name -> { body, params, line }, where
 * `line` is the 1-based line of its `def`. */
function pyDefsOf(code, file) {
  const defs = new Map();
  for (const m of code.matchAll(/^def (\w+)\(/gm)) {
    const body = pyDef(code, m[1], file);
    const params = pySplit(pyParen(body, body.indexOf("(")).inner)
      .map((p) => p.replace(/^\*+/, "").split(/[:=]/)[0].trim())
      .filter(Boolean);
    defs.set(m[1], { body, params, line: code.slice(0, m.index).split("\n").length });
  }
  return defs;
}

/** The top-level def whose body holds 1-based line `n`, or null. */
function pyHolder(defs, n) {
  for (const [name, d] of defs) if (n >= d.line && n < d.line + d.body.split("\n").length) return { name, ...d };
  return null;
}

/** Every call `name(` in `src` that is not its own `def`, as { at, args, line }. */
function pyCalls(src, name) {
  const out = [];
  for (const m of src.matchAll(new RegExp(`(?<![\\w])${name}\\(`, "g"))) {
    if (/\bdef\s+$/.test(src.slice(Math.max(0, m.index - 8), m.index))) continue;
    out.push({
      at: m.index,
      args: pySplit(pyParen(src, m.index + name.length).inner),
      line: src.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

/** The operands that can become an expression's value: both branches of a
 * ternary (never its condition) and both sides of `or`, parentheses dropped. */
function pyTerms(expr) {
  let e = expr.trim();
  while (e.startsWith("(") && pyParen(e, 0).end === e.length) e = e.slice(1, -1).trim();
  const tern = /^(.+?)\s+if\s+.+?\s+else\s+(.+)$/.exec(e);
  if (tern) return [...pyTerms(tern[1]), ...pyTerms(tern[2])];
  const parts = e.split(/\s+or\s+/);
  return parts.length > 1 ? parts.flatMap(pyTerms) : [e];
}

/** The argument a call passes for parameter `param` at position `k`: its
 * keyword form, else the k-th positional argument, else undefined. */
function pyArgFor(args, param, k) {
  const kw = args.find((a) => new RegExp(`^${param}\\s*=(?!=)`).test(a));
  if (kw) return kw.replace(/^\w+\s*=\s*/, "");
  const positional = args.filter((a) => !/^\w+\s*=(?!=)/.test(a));
  return positional[k];
}

/** Every code the google_oauth functions `entries` can raise as
 * `GoogleAuthError(<code>, …)`, following google_oauth's own defs they call.
 * The code is read like a sync term: every literal branch of a ternary or an
 * `or` is a code, the condition never. `_error_code(…)` is the ONE open-set
 * shape (Google's own `error` string, or `http_<status>`), so it adds nothing
 * and is allowed. Anything else throws and names the line. */
function googleRaised(google, entries) {
  const defs = pyDefsOf(google, GOOGLE_OAUTH_PY);
  const codes = new Set();
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name) || !defs.has(name)) continue;
    seen.add(name);
    const def = defs.get(name);
    const lines = def.body.split("\n");
    for (const call of pyCalls(def.body, "GoogleAuthError")) {
      const shown = `backend/${GOOGLE_OAUTH_PY}:${def.line + call.line - 1}: \`${lines[call.line - 1].trim()}\``;
      const arg = pyArgFor(call.args, "code", 0);
      if (arg === undefined) throw new Error(`${shown} raises a GoogleAuthError with no code, so check 37 cannot read it`);
      for (const term of pyTerms(arg)) {
        const lit = PY_LIT.exec(term);
        if (lit) {
          if (lit[2]) codes.add(lit[2]);
        } else if (!(/^_error_code\(/.test(term) && pyParen(term, term.indexOf("(")).end === term.length))
          throw new Error(
            `${shown} — the code \`${term}\` is neither a literal nor \`_error_code(…)\`, Google's open set. That ` +
              "code reaches `last_error` through `_fail(…, e.code)`, so check 37 must read it: write it as a " +
              "literal (a ternary of literals is read), or teach the reader the new shape",
          );
      }
    }
    for (const m of def.body.matchAll(/(?<![\w.])(\w+)\(/g)) queue.push(m[1]);
  }
  return { codes, seen };
}

const PY_SYNC_FIELD = "(?:error_code|last_error_code|last_error)";
const PY_AUGMENTED = "(?:\\/\\/|\\*\\*|>>|<<|:|[-+*/%&|^@])=";
// The classes whose `status` is an APPLICATION's, never a connection's: an
// inbox_sync `_Card` copies a tracker card's status to match mail against it.
const APP_STATUS_CLASSES = new Set(["_Card"]);

/**
 * 37(a)'s reader. Every code the backend can store in `InboxSyncResult.error_code`
 * or `MailConnection.last_error`, and every status a connection can be given.
 * `sources` is [[file, pyCode], …] and `google` is google_oauth.py's pyCode.
 * Returns { codes, emitters, google, statuses }.
 */
function inboxSyncCodes(sources, google) {
  const codes = new Set();
  const googleCodes = new Set();
  const statuses = new Set();
  const files = sources.map(([file, code]) => ({
    file,
    code,
    defs: pyDefsOf(code, file),
    lines: code.split("\n"),
    scan: pyScan(code),
    app: pyClassSpans(code, APP_STATUS_CLASSES),
  }));
  const queue = [];
  let useStatuses = false;
  const where = (f, n, text) => `backend/${f.file}:${n}: \`${text.trim()}\``;
  const unreadable = (f, n, text, why) =>
    new Error(
      `${where(f, n, text)} — ${why}. Check 37 reads only the shapes its header lists, so a new one ` +
        "must be taught to it (or rewritten into a known one), never left unread",
    );

  // A term that became (part of) a stored code, at line n of file f, inside def `holder`.
  const take = (term, f, n, text, holder, atCall) => {
    const lit = PY_LIT.exec(term);
    if (lit) {
      if (lit[2]) codes.add(lit[2]);
      return;
    }
    if (term === "code") {
      if (!holder || !holder.params.includes("code"))
        throw unreadable(f, n, text, "`code` here is not a parameter of the def it sits in, so nothing says what it holds");
      queue.push(holder.name);
      return;
    }
    if (!atCall && term === "conn.status") {
      useStatuses = true;
      return;
    }
    if (SYNC_PASS.has(term)) return;
    if (atCall && (term === "e.code" || term === "exc.code")) {
      const entries = holder ? [...holder.body.matchAll(/\bgoogle_oauth\.(\w+)\(/g)].map((m) => m[1]) : [];
      if (!entries.length)
        throw unreadable(f, n, text, "`e.code` is passed from a def that calls no google_oauth function");
      for (const c of googleRaised(google, entries).codes) {
        googleCodes.add(c);
        codes.add(c);
      }
      const reauth = /^_REAUTH_CODES\s*=\s*frozenset\(\{([^}]*)\}\)/m.exec(f.code);
      if (!reauth) throw unreadable(f, n, text, "`e.code` is passed through, and this file has no `_REAUTH_CODES = frozenset({…})`");
      for (const m of reauth[1].matchAll(/(["'])([a-z][a-z_]*)\1/g)) codes.add(m[2]);
      return;
    }
    throw unreadable(f, n, text, `the term \`${term}\` is not a literal, \`code\`, \`conn.status\` or a pass-through`);
  };

  // A site is found ANYWHERE in the file, not only at a line's start: after
  // `if x:` or `db.flush();` too. Its depth says what it is. Inside a bracket it
  // is a keyword (a black-formatted continuation line included), and its value
  // runs to the first top-level `,` or the `)` closing the call, so a second
  // keyword on the line is never read as part of it. At depth 0 it is a
  // statement, and its value runs to the statement's end, across lines while a
  // bracket is open. A statement assigning a tuple is refused.
  const sites = (f, re) => [...f.code.matchAll(re)].filter((m) => !f.scan.inStr[m.index]);
  const valueAt = (f, site, from, n) => {
    if (f.scan.depth[site] > 0) return pyArgHead(f.code.slice(from));
    const tail = pyStatementTail(f.code, f.scan, from);
    if (pySplit(tail).length > 1)
      throw unreadable(f, n, f.lines[n - 1], "a tuple assignment, which pairs its targets with its values by position");
    return tail;
  };
  const WRITE = new RegExp(`(?<![\\w"'])${PY_SYNC_FIELD}\\s*=(?!=)`, "g");
  const ANNOTATED = new RegExp(`^[ \\t]*(?:[A-Za-z_][\\w.]*\\.)?${PY_SYNC_FIELD}\\s*:(?!=)[^=\\n]*=(?!=)`, "gm");
  const STATUS_ATTR = /\.status\s*=(?!=)/g; // `x.status = …`, any receiver, so an alias is read
  const STATUS_ANNOTATED = /^[ \t]*[A-Za-z_][\w.]*\.status\s*:(?!=)[^=\n]*=(?!=)/gm; // `x.status: str = …`
  const STATUS_KEYWORD = /(?<![\w."'])status\s*=(?!=)/g; // at depth 0 it is a local, not a keyword
  for (const f of files) {
    const line = (m) => f.scan.lineOf(m.index);
    // Sync codes: every `=` write of the three fields, and an annotated default.
    for (const m of [...sites(f, WRITE), ...sites(f, ANNOTATED)]) {
      const n = line(m);
      const rhs = valueAt(f, m.index, m.index + m[0].length, n);
      if (!rhs.trim()) throw unreadable(f, n, f.lines[n - 1], "the value is missing");
      for (const term of pyTerms(rhs)) take(term, f, n, f.lines[n - 1], pyHolder(f.defs, n), false);
    }
    // Connection statuses: an attribute write, or a `status=` keyword (the
    // constructor, a bulk `.values(…)`), outside an application class and a
    // def's own signature. A term is a literal or the `conn.status` passthrough.
    const inApp = (n) => f.app.some(([a, b]) => n >= a && n <= b);
    const takeStatus = (term, n) => {
      const lit = PY_LIT.exec(term);
      if (lit) {
        if (lit[2]) statuses.add(lit[2]);
      } else if (term !== "conn.status")
        throw unreadable(
          f,
          n,
          f.lines[n - 1],
          `a status written as \`${term}\`, which is neither a literal nor \`conn.status\`. A status is read as a ` +
            "connection's: if this is an application's, name its class in APP_STATUS_CLASSES",
        );
    };
    for (const m of [...sites(f, STATUS_ATTR), ...sites(f, STATUS_ANNOTATED)]) {
      const n = line(m);
      if (!inApp(n)) for (const term of pyTerms(valueAt(f, m.index, m.index + m[0].length, n))) takeStatus(term, n);
    }
    for (const m of sites(f, STATUS_KEYWORD)) {
      const n = line(m);
      if (!f.scan.depth[m.index] || inApp(n) || pyCallee(f.code, f.scan, m.index)?.def) continue;
      for (const term of pyTerms(pyArgHead(f.code.slice(m.index + m[0].length)))) takeStatus(term, n);
    }
    // THE NETS: every other way to write one of these fields throws.
    const net = (m, why) => {
      throw unreadable(f, line(m), f.lines[line(m) - 1], why);
    };
    const target = (m) => f.scan.depth[m.index] === 0 && pyAssignsLater(f.code, f.scan, m.index + m[0].length);
    for (const m of sites(f, new RegExp(`(?<![\\w"'])${PY_SYNC_FIELD}\\s*${PY_AUGMENTED}`, "g")))
      net(m, "an augmented or walrus assignment, whose value depends on what was there before");
    for (const m of sites(f, new RegExp(`\\.status\\s*${PY_AUGMENTED}`, "g")))
      net(m, "an augmented assignment of a status, whose value depends on what was there before");
    for (const m of sites(f, new RegExp(`(?<![\\w"'])${PY_SYNC_FIELD}\\s*,`, "g")))
      if (target(m)) net(m, "a tuple assignment, which pairs its targets with its values by position");
    for (const m of sites(f, /\.status\s*,/g))
      if (target(m)) net(m, "a tuple assignment of a status, which pairs its targets with its values by position");
    for (const m of f.code.matchAll(/(["'])(error_code|last_error_code|last_error|status)\1/g))
      if (!m.index || !f.scan.inStr[m.index - 1])
        net(
          m,
          `the field \`${m[2]}\` is named in a string (setattr, a dict key, model_copy(update=…), .values({…})), ` +
            "which is a write check 37 cannot read",
        );
    for (const name of ["InboxSyncResult", "MailConnection", "values"])
      for (const call of pyCalls(f.code, name))
        if (call.args.some((a) => a.startsWith("**")))
          throw unreadable(f, call.line, f.lines[call.line - 1], `\`**\` unpacks fields into ${name}(…), which check 37 cannot see`);
  }

  // Each emitter's callers, until no new emitter turns up.
  const emitters = [];
  while (queue.length) {
    const name = queue.shift();
    if (emitters.includes(name)) continue;
    emitters.push(name);
    const home = files.find((f) => f.defs.has(name));
    const k = home.defs.get(name).params.indexOf("code");
    let calls = 0;
    for (const f of files)
      for (const call of pyCalls(f.code, name)) {
        calls++;
        const text = f.lines[call.line - 1];
        const arg = pyArgFor(call.args, "code", k);
        if (arg === undefined) throw unreadable(f, call.line, text, `this call to ${name} passes nothing for \`code\``);
        for (const term of pyTerms(arg)) take(term, f, call.line, text, pyHolder(f.defs, call.line), true);
      }
    if (!calls)
      throw new Error(
        `backend/${home.file}: \`${name}\` stores its \`code\` parameter as a sync code and nothing calls it, ` +
          "so this check cannot see what it is handed",
      );
  }
  if (useStatuses) for (const s of statuses) if (s !== "active") codes.add(s);
  return { codes, emitters, google: googleCodes, statuses };
}

/** One Python string literal, of either quote, escapes allowed, with an optional
 * prefix: a message detail, which carries no code (lib/apiError's codeOf reads
 * a code only out of an object detail). */
const PY_STR = /^[rRbBuUfF]{0,2}(["'])(?:\\.|(?!\1)[^\\])*\1$/;
const PY_CODE_KEY = /(["'])code\1\s*:/g;

/**
 * 37(b)'s reader. Every `{"code": …}` refusal in inbox_routes.py (pyCode
 * `routes`), with the f-string expanded through inbox_apply.py (pyCode `apply`).
 * Every `HTTPException(` in a top-level def is read: its detail, keyword or
 * positional, is absent, a message literal (no code), or a dict literal with ONE
 * `"code"` key. Anything else throws. So does any `"code":` key anywhere in the
 * file that no HTTPException detail carried (a JSONResponse, a module-level
 * raise, a class method), any `dict(code=…)`, and any `code=` keyword handed a
 * string literal: the nets the header names. Returns
 * { raised: code -> Set(def names), fns }.
 */
function inboxRefusalCodes(routes, apply) {
  const rdefs = pyDefsOf(routes, INBOX_ROUTES_PY);
  const adefs = pyDefsOf(apply, INBOX_APPLY_PY);
  const raised = new Map();
  const fns = new Set();
  const carried = new Set(); // file lines holding a "code": key a detail carried
  const add = (code, def) => {
    if (!raised.has(code)) raised.set(code, new Set());
    raised.get(code).add(def);
  };
  const flines = routes.split("\n");
  for (const [name, def] of rdefs)
    for (const call of pyCalls(def.body, "HTTPException")) {
      const n = def.line + call.line - 1;
      const at = `backend/${INBOX_ROUTES_PY}:${n}: \`${flines[n - 1].trim()}\` in ${name}`;
      if (call.args.some((a) => a.startsWith("*")))
        throw new Error(`${at} unpacks its arguments, so check 37 cannot see its detail`);
      const detail = pyArgFor(call.args, "detail", 1);
      if (detail === undefined || PY_STR.test(detail)) continue; // no detail, or a message: no code
      if (!detail.startsWith("{") || pyParen(detail, 0).end !== detail.length)
        throw new Error(
          `${at} — its detail \`${detail}\` is neither a message literal nor a \`{"code": …}\` dict literal, so ` +
            "check 37 cannot read the code it sends",
        );
      const keys = pySplit(pyParen(detail, 0).inner)
        .map((e) => /^(["'])code\1\s*:\s*([\s\S]*)$/.exec(e))
        .filter(Boolean);
      const callSrc = def.body.slice(call.at, pyParen(def.body, call.at + "HTTPException".length).end);
      const keyAt = [...callSrc.matchAll(PY_CODE_KEY)];
      if (keys.length !== 1 || keyAt.length !== 1)
        throw new Error(`${at} — a dict detail must carry exactly one "code" key, at its top level, and nowhere else in the call`);
      carried.add(def.line + def.body.slice(0, call.at + keyAt[0].index).split("\n").length - 1);
      const value = keys[0][2].trim();
      const lit = PY_LIT.exec(value);
      if (lit) {
        add(lit[2], name);
        continue;
      }
      const shown = `detail={"code": ${value}}`;
      const fstr = /^f(["'])([^"'\\]*)\1$/.exec(value);
      if (!fstr)
        throw new Error(`backend/${INBOX_ROUTES_PY}: \`${shown}\` in ${name} is neither a literal nor an f-string, so check 37 cannot read what it sends`);
      const holes = [...fstr[2].matchAll(/\{([^{}]*)\}/g)].map((h) => h[1]);
      if (holes.length !== 1 || !def.params.includes(holes[0]))
        throw new Error(
          `backend/${INBOX_ROUTES_PY}: \`${shown}\` in ${name} is an f-string check 37 cannot expand. It reads ONE ` +
            "placeholder that is a parameter of its own def, expanded through that def's callers",
        );
      const param = holes[0];
      const [pre, post] = fstr[2].split(`{${param}}`);
      let callers = 0;
      for (const [caller, cdef] of rdefs)
        for (const use of pyCalls(cdef.body, name)) {
          callers++;
          const arg = pyArgFor(use.args, param, def.params.indexOf(param)) ?? "";
          let fn = /^inbox_apply\.(\w+)\(/.exec(arg)?.[1];
          if (!fn && /^\w+$/.test(arg)) {
            const held = [...cdef.body.matchAll(new RegExp(`^\\s*${arg}\\s*=(?!=)\\s*inbox_apply\\.(\\w+)\\(`, "gm"))];
            if (held.length === 1) fn = held[0][1];
          }
          if (!fn)
            throw new Error(
              `backend/${INBOX_ROUTES_PY}: ${caller} passes \`${arg}\` to ${name} as \`${param}\`, which is neither an ` +
                "`inbox_apply.<fn>(…)` call nor one variable assigned from one, so check 37 cannot read the refusals it carries",
            );
          fns.add(fn);
          if (!adefs.has(fn)) throw new Error(`backend/${INBOX_APPLY_PY} has no top-level \`def ${fn}(\`, which ${caller} calls`);
          for (const line of adefs.get(fn).body.split("\n")) {
            const r = /^\s*return\b\s*(.*)$/.exec(line);
            if (!r) continue;
            const v = PY_LIT.exec(r[1].trim());
            if (!v)
              throw new Error(
                `backend/${INBOX_APPLY_PY}: ${fn} returns \`${r[1].trim()}\`. Every return in a refusal function must be ` +
                  'a string literal ("" is success), or check 37 cannot read the refusal it becomes',
              );
            if (v[2]) add(`${pre}${v[2]}${post}`, name);
          }
        }
      if (!callers) throw new Error(`backend/${INBOX_ROUTES_PY}: ${name} builds its refusal from \`${param}\`, and nothing calls it`);
    }
  // The nets. pyCode has blanked docstrings and cut comments already.
  //  - A "code": key no HTTPException detail carried is a refusal this reader
  //    never saw.
  //  - So is a `code=` keyword that builds a dict (`dict(code=…)`), or that is
  //    handed a string literal (`Model(code="inbox_x")`). A variable handed on
  //    as `code=` is not a refusal (`exchange_code(code=code)` passes Google's
  //    OAuth code), and neither is a def's own `code="…"` default.
  flines.forEach((line, i) => {
    if (/(["'])code\1\s*:/.test(line) && !carried.has(i + 1))
      throw new Error(
        `backend/${INBOX_ROUTES_PY}:${i + 1}: \`${line.trim()}\` carries a "code" key that is not the detail of an ` +
          "`HTTPException(` in a top-level def, so check 37 never reads the refusal it sends. Raise it as one, or " +
          "teach the reader the new shape",
      );
  });
  const scan = pyScan(routes);
  for (const m of routes.matchAll(/(?<![\w."'])code\s*=(?!=)/g)) {
    if (scan.inStr[m.index] || !scan.depth[m.index]) continue; // a local `code = …`, not a keyword
    const callee = pyCallee(routes, scan, m.index);
    if (callee?.def) continue;
    const value = pyArgHead(routes.slice(m.index + m[0].length));
    if (callee?.name === "dict" || pyTerms(value).some((t) => PY_STR.test(t))) {
      const n = scan.lineOf(m.index);
      throw new Error(
        `backend/${INBOX_ROUTES_PY}:${n}: \`${flines[n - 1].trim()}\` sends \`code=${value.trim()}\` ` +
          `${callee?.name === "dict" ? "as a dict key" : "as a literal"} that is not the detail of an \`HTTPException(\`, ` +
          "so check 37 never reads the refusal it sends. Raise it as one, or teach the reader the new shape",
      );
    }
  }
  return { raised, fns };
}

/** The defs nested in a def's `body`: [{ name, params, from, to }], where
 * from..to are the 1-based body lines from the nested `def` to the last line
 * indented deeper than it (a multi-line signature's `) -> T:` stays its own). */
function pyNestedDefs(body) {
  const lines = body.split("\n");
  const out = [];
  for (const m of body.matchAll(/^([ \t]+)def (\w+)\(/gm)) {
    const from = body.slice(0, m.index).split("\n").length;
    let to = lines.length;
    for (let i = from; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() && l.length - l.trimStart().length <= m[1].length && !/^\s*\)/.test(l)) {
        to = i;
        break;
      }
    }
    const params = pySplit(pyParen(body, m.index + m[0].length - 1).inner)
      .map((p) => p.replace(/^\*+/, "").split(/[:=]/)[0].trim())
      .filter(Boolean);
    out.push({ name: m[2], params, from, to });
  }
  return out;
}

/**
 * 37(c)'s reader. The reasons `inbox_google_callback` redirects with (pyCode
 * `routes`), read two ways:
 *   - through its nested `def X(reason…)` emitters (today `fail` and
 *     `refuse`): each call passes a literal, a ternary of literals, or, inside an
 *     emitter only, that emitter's own `reason`;
 *   - through its nested `leave(path)`: a path is string literals and at most
 *     one `quote(…)`. A literal `/settings?inbox=<reason>` is a reason,
 *     `/tracker?inbox=connected` is the success, and a path with no `inbox=`
 *     (the /login redirect) carries none. The one computed form is
 *     `"/settings?inbox=" + quote(reason, …)` inside an emitter.
 * Anything else throws. So does an `?inbox=` anywhere in the file that no
 * leave() carried: a RedirectResponse built directly, or another route's.
 * Returns { codes, emitters }.
 */
function inboxCallbackCodes(routes) {
  const body = pyDef(routes, "inbox_google_callback", INBOX_ROUTES_PY);
  const first = routes.slice(0, /^def inbox_google_callback\(/m.exec(routes).index).split("\n").length;
  const nested = pyNestedDefs(body);
  const emitters = nested.filter((d) => d.params[0] === "reason").map((d) => d.name);
  if (!emitters.length)
    throw new Error(`backend/${INBOX_ROUTES_PY}: inbox_google_callback has no nested \`def X(reason…)\` — the refusal shape changed`);
  if (!nested.some((d) => d.name === "leave"))
    throw new Error(`backend/${INBOX_ROUTES_PY}: inbox_google_callback has no nested \`def leave(\` — check 37 reads its redirects through it`);
  const inEmitter = (n) => nested.some((d) => d.params[0] === "reason" && n >= d.from && n <= d.to);
  const lines = body.split("\n");
  const at = (n) => `backend/${INBOX_ROUTES_PY}:${first + n - 1}: \`${lines[n - 1].trim()}\` in inbox_google_callback`;
  const codes = new Set();
  for (const name of emitters)
    for (const call of pyCalls(body, name)) {
      const arg = pyArgFor(call.args, "reason", 0);
      if (arg === undefined) throw new Error(`${at(call.line)} passes ${name} no reason`);
      for (const term of pyTerms(arg)) {
        const lit = PY_LIT.exec(term);
        if (lit) {
          if (lit[2]) codes.add(lit[2]);
        } else if (term !== "reason" || !inEmitter(call.line))
          throw new Error(
            `${at(call.line)} passes \`${term}\` to ${name}. A reason is a literal (or a ternary of literals), or an ` +
              "emitter forwarding its own `reason`",
          );
      }
    }
  const carried = new Set(); // file lines of every ?inbox= redirect leave() was read for
  for (const call of pyCalls(body, "leave")) {
    const arg = pyArgFor(call.args, "path", 0);
    if (arg === undefined) throw new Error(`${at(call.line)} calls leave() with no path`);
    const pieces = pySplit(arg, "+");
    const text = [];
    let quoted = null;
    for (const p of pieces) {
      const lit = PY_LIT.exec(p);
      if (lit) text.push(lit[2]);
      else if (quoted === null && /^quote\(/.test(p) && pyParen(p, 5).end === p.length) quoted = pySplit(pyParen(p, 5).inner)[0];
      else
        throw new Error(
          `${at(call.line)} — leave() is sent \`${p}\`. Check 37 reads a path built from string literals and at most ` +
            "one `quote(…)`, so that it sees every `?inbox=` reason",
        );
    }
    if (!/[?&]inbox=/.test(text.join(""))) continue; // the /login redirect: no reason
    const span = body.slice(call.at, pyParen(body, call.at + "leave".length).end).split("\n").length;
    for (let k = 0; k < span; k++) carried.add(first + call.line - 1 + k);
    if (quoted === null) {
      const reason = /^\/settings\?inbox=([A-Za-z0-9_]+)$/.exec(text.join(""));
      if (reason) codes.add(reason[1]);
      else if (text.join("") !== "/tracker?inbox=connected")
        throw new Error(
          `${at(call.line)} redirects with ?inbox= to neither \`/settings?inbox=<reason>\` (which callbackMessage ` +
            "says) nor the tracker's `?inbox=connected`",
        );
    } else if (!(pieces.length === 2 && text.join("") === "/settings?inbox=" && PY_LIT.test(pieces[0]) && quoted === "reason" && inEmitter(call.line)))
      throw new Error(
        `${at(call.line)} builds an ?inbox= path check 37 cannot read. The one computed path it reads is ` +
          '`"/settings?inbox=" + quote(reason, …)` inside an emitter',
      );
  }
  routes.split("\n").forEach((line, i) => {
    if (/[?&]inbox=/.test(line) && !carried.has(i + 1))
      throw new Error(
        `backend/${INBOX_ROUTES_PY}:${i + 1}: \`${line.trim()}\` redirects with ?inbox= without going through ` +
          "inbox_google_callback's leave(), so check 37 never reads the reason it sends",
      );
  });
  return { codes, emitters };
}

/** The non-empty `InboxStatus.reason` values `_status` can set (pyCode `routes`). */
function inboxReasons(routes) {
  const body = pyDef(routes, "_status", INBOX_ROUTES_PY);
  const reasons = new Set();
  let sites = 0;
  for (const m of body.matchAll(/(?:[(,]\s*|\.)reason\s*=(?!=)\s*/g)) {
    sites++;
    const arg = pyArgHead(body.slice(m.index + m[0].length).split("\n")[0]);
    for (const term of pyTerms(arg)) {
      const lit = PY_LIT.exec(term);
      if (!lit) throw new Error(`backend/${INBOX_ROUTES_PY}: _status sets \`reason\` from \`${term}\`, which is not a literal`);
      if (lit[2]) reasons.add(lit[2]);
    }
  }
  if (!sites) throw new Error(`backend/${INBOX_ROUTES_PY}: _status no longer sets \`reason=\` — the status shape changed`);
  return reasons;
}

const SWITCH_DEFAULT = Symbol("default");
const SWITCH_STMT = [
  [/^return\s+t\(\s*"([A-Za-z][\w.]*)"\s*\)\s*;?$/, (m) => ({ kind: "t", key: m[1] })],
  [/^return\s+""\s*;?$/, () => ({ kind: "empty" })],
  [/^return\s+apiErrorMessage\(\s*e\s*,\s*fallback\s*\)\s*;?$/, () => ({ kind: "api" })],
];

/**
 * The arms of the one `switch` inside the function declared at `marker` in `src`:
 * { arms: code -> statement, dflt, intoDefault }. A LINE grammar, for pyTuple's
 * reason: after decomment, a line inside the switch is blank, or one or more
 * `case "…":` / `default:` labels, optionally followed by exactly one of
 * `return t("key")`, `return ""` or `return apiErrorMessage(e, fallback)`.
 * Anything else throws and names the line. A case whose next statement is
 * shared with `default:` is reported in `intoDefault`, never as an arm.
 */
function switchArms(src, marker, who) {
  const fn = decomment(fnSource(src, marker));
  const at = fn.indexOf("switch (");
  if (at === -1) throw new Error(`${who} has no \`switch (\` any more — check 37 reads its arms from one`);
  const arms = new Map();
  const intoDefault = [];
  let dflt = null;
  let pending = [];
  for (const raw of blockAfter(fn.slice(at), "switch (", who).split("\n")) {
    let line = raw.trim();
    if (!line) continue;
    for (let m; (m = /^(?:case\s+"([^"]*)"|default)\s*:\s*/.exec(line)); line = line.slice(m[0].length))
      pending.push(m[1] === undefined ? SWITCH_DEFAULT : m[1]);
    if (!line) continue;
    const hit = SWITCH_STMT.map(([re, make]) => {
      const x = re.exec(line);
      return x && { ...make(x), text: line };
    }).find(Boolean);
    if (!hit)
      throw new Error(
        `${who}: cannot read \`${line}\` inside its switch. Check 37 reads a \`case "…":\` label, \`default:\`, and ` +
          'one of `return t("key")`, `return ""` or `return apiErrorMessage(e, fallback)`; keep each arm a literal ' +
          "t() call so check 29 can resolve it",
      );
    if (!pending.length) throw new Error(`${who}: \`${line}\` has no case label leading to it`);
    const withDefault = pending.includes(SWITCH_DEFAULT);
    for (const label of pending)
      if (label === SWITCH_DEFAULT) dflt = hit;
      else if (withDefault) intoDefault.push(label);
      else if (arms.has(label)) throw new Error(`${who}: case "${label}" appears twice`);
      else arms.set(label, hit);
    pending = [];
  }
  if (pending.length) throw new Error(`${who}: the switch ends on a label with no return`);
  return { arms, dflt, intoDefault };
}

/**
 * What is wrong between one switch and its backend family, as sentences. `backend`
 * is the family's Set, or null when backend/ is absent (the frontend rules
 * still run). `spec`: { who, family, dfltOk, dfltWant, empty, api }.
 */
function armProblems({ arms, dflt, intoDefault }, backend, spec) {
  const out = [];
  for (const code of intoDefault)
    out.push(
      `${spec.who}: case "${code}" falls straight into \`default:\`, so it has no sentence of its own. Give it its ` +
        "own return, even one that returns the generic sentence, so the choice is visible.",
    );
  if (!dflt) out.push(`${spec.who} has no \`default:\`, so a code this build does not know would render nothing.`);
  else if (!spec.dfltOk(dflt))
    out.push(`${spec.who}'s default returns \`${dflt.text}\`, not ${spec.dfltWant}: an unknown code gets the generic sentence, never itself.`);
  if (spec.empty && !arms.has("")) out.push(`${spec.who} has no \`case "":\`, so "no error" would print the generic error sentence.`);
  for (const [code, stmt] of arms) {
    if (code === "" && spec.empty && stmt.kind !== "empty")
      out.push(`${spec.who}: case "" returns \`${stmt.text}\`, but "" means no error and must return "".`);
    if (code !== "" && stmt.kind === "empty")
      out.push(`${spec.who}: case "${code}" returns "", which reads as "no error" for a code that is one.`);
    if (stmt.kind === "api" && !spec.api)
      out.push(`${spec.who}: case "${code}" returns apiErrorMessage, which only the refusal hook may do.`);
    const known = code === "" ? spec.empty : (backend?.has(code) ?? true) || GOOGLE_PASSTHROUGH.has(code);
    if (!known)
      out.push(
        `${spec.who}: case "${code}" is not a ${spec.family} code the backend sends (37(e), the other direction). A ` +
          "renamed code leaves this arm dead and the new one on the default. Rename it with the backend, or add a " +
          "Google string to GOOGLE_PASSTHROUGH.",
      );
  }
  if (backend)
    for (const code of [...backend].sort())
      if (!arms.has(code) && !intoDefault.includes(code))
        out.push(
          `${spec.who} has no case for the ${spec.family} code "${code}", which the backend sends, so it shows the ` +
            "default sentence. Give it an arm: its own sentence, or the generic one returned on purpose.",
        );
  return out;
}

/** Every quoted code a component compares with `apiErrorCode(…)` (refusal), an
 * `error_code` / `last_error_code` (sync), a `.reason` (reason) or a `.status`
 * (connection), directly or through one `const` holding it:
 * [{ family, code, text }]. A `.status` compared with a literal under
 * components/inbox is the CONNECTION's (`InboxStatus.status`): an application's
 * status is never compared with a literal there (the review sheet goes through
 * STATUS_OF_KIND), so one that is would be reported, loudly, as a stale status. */
function inboxComparisons(src) {
  const code = decomment(src);
  const alias = new Map();
  const familyOf = (expr) =>
    /^apiErrorCode\(/.test(expr)
      ? "refusal"
      : /\.(?:last_error_code|error_code)$/.test(expr)
        ? "sync"
        : /\.reason$/.test(expr)
          ? "reason"
          : /\.status$/.test(expr)
            ? "connection"
            : (alias.get(expr) ?? null);
  for (const m of code.matchAll(/\bconst\s+(\w+)\s*=\s*(apiErrorCode\([^()]*\)|[\w.]+)\s*;/g)) {
    const family = familyOf(m[2]);
    if (family) alias.set(m[1], family);
  }
  const found = [];
  const OPS = /(apiErrorCode\([^()]*\)|[\w.]+)\s*[!=]==?\s*"([^"]*)"|"([^"]*)"\s*[!=]==?\s*(apiErrorCode\([^()]*\)|[\w.]+)/g;
  for (const m of code.matchAll(OPS)) {
    const family = familyOf(m[1] ?? m[4]);
    if (family) found.push({ family, code: m[2] ?? m[3], text: m[0] });
  }
  return found;
}

/** What in one components/inbox file could reach `apiErrorMessage` other than
 * through `useInboxRefusalText`: [[line, text]]. That is every mention of the
 * name (a call, a method call on a namespace, an aliased import, a value passed
 * on), except, in shared.tsx only, its plain `import { … }` from lib/apiError and
 * the calls inside the hook; and every namespace or dynamic import of
 * lib/apiError, whose members the name scan cannot see. Comments are blanked
 * with their newlines kept, so the line numbers are the file's own. */
function directApiErrorCalls(file, src) {
  const kept = src
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^[ \t]*\/\/.*$/gm, "");
  const allowed = []; // [from, to) index ranges
  if (file.endsWith("/shared.tsx")) {
    const marker = "export function useInboxRefusalText";
    if (kept.includes(marker)) {
      const lo = kept.indexOf(marker);
      allowed.push([lo, lo + fnSource(kept, marker).length]);
    }
    for (const m of kept.matchAll(/\bimport\s*\{[^}]*\}\s*from\s*["'][^"']*\/lib\/apiError["']/g))
      if (!/\bapiErrorMessage\s+as\b/.test(m[0])) allowed.push([m.index, m.index + m[0].length]);
  }
  const hits = [
    ...[...kept.matchAll(/\bapiErrorMessage\b/g)].filter((m) => !allowed.some(([a, b]) => m.index >= a && m.index < b)),
    ...kept.matchAll(/\bimport\s*\*\s*as\s+\w+\s*from\s*["'][^"']*\/lib\/apiError["']/g),
    ...kept.matchAll(/\bimport\(\s*["'][^"']*\/lib\/apiError["']\s*\)/g),
  ];
  const lines = kept.split("\n");
  return hits
    .map((m) => kept.slice(0, m.index).split("\n").length)
    .sort((a, b) => a - b)
    .filter((n, i, all) => all.indexOf(n) === i)
    .map((n) => [n, lines[n - 1].trim()]);
}

/** pyCode with every line kept where it was: a multi-line docstring becomes
 * `""` plus its own newlines, so a line number this check reports is the
 * file's. (pyCode itself collapses it, which 32(g) never needed to mind.) */
const pyCodeLines = (src) =>
  pyCode(
    src
      .replace(/\r\n/g, "\n")
      .replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, (m) => `""${"\n".repeat((m.match(/\n/g) || []).length)}`),
  );

// The four backend files, read ONCE, in their own try: a file that is missing
// while backend/ is present must be one loud failure, and must not leave
// 37(b) and 37(c) quietly comparing nothing as if backend/ were absent.
// null while backend/ is absent; the sets are null where a reader threw (its
// own sub-check has already failed).
let inboxBackend = null;
try {
  const sync = pySource(INBOX_SYNC_PY, "check 37");
  const routes = pySource(INBOX_ROUTES_PY, "check 37");
  const apply = pySource(INBOX_APPLY_PY, "check 37");
  const google = pySource(GOOGLE_OAUTH_PY, "check 37");
  if (![sync, routes, apply, google].includes(null))
    inboxBackend = {
      sync: pyCodeLines(sync),
      routes: pyCodeLines(routes),
      apply: pyCodeLines(apply),
      google: pyCodeLines(google),
    };
} catch (e) {
  fail(`check 37 could not read the inbox backend: ${e.message}`);
}
const inboxFamilies = { sync: null, refusal: null, callback: null, reasons: null, statuses: null };

/** 37(e)'s rule: each comparison `found` (inboxComparisons, with its `file`)
 * whose code the backend's `sets[family]` does not hold, as sentences. */
function staleComparisons(found, sets) {
  return found
    .filter((c) => !sets[c.family].has(c.code) && !GOOGLE_PASSTHROUGH.has(c.code))
    .map(
      (c) =>
        `check 37(e): components/inbox/${c.file} compares a ${c.family} ${c.family === "connection" ? "status" : "code"} ` +
        `with "${c.code}" (\`${c.text}\`), which the backend never ${c.family === "connection" ? "writes" : "sends"}, so ` +
        "that comparison can never be true. Rename it with the backend." +
        (c.family === "connection"
          ? " (Every `.status` compared with a literal here is read as the connection's; if this one is an " +
            "application's, teach check 37 its receiver.)"
          : ""),
    );
}
const SHARED_TSX = "components/inbox/shared.tsx";
const SETTINGS_CARD_TSX = "components/inbox/InboxSettingsCard.tsx";
const SYNC_SPEC = {
  who: "useSyncErrorText (components/inbox/shared.tsx)",
  family: "sync",
  dfltOk: (d) => d.kind === "t" && d.key === "inbox.errors.generic",
  dfltWant: 'return t("inbox.errors.generic")',
  empty: true,
  api: false,
};
const REFUSAL_SPEC = {
  who: "useInboxRefusalText (components/inbox/shared.tsx)",
  family: "refusal",
  dfltOk: (d) => d.kind === "api",
  dfltWant: "return apiErrorMessage(e, fallback)",
  empty: false,
  api: true,
};
const CALLBACK_SPEC = {
  who: "callbackMessage (components/inbox/InboxSettingsCard.tsx)",
  family: "callback",
  dfltOk: (d) => d.kind === "t" && d.key === "inbox.callback.generic",
  dfltWant: 'return t("inbox.callback.generic")',
  empty: false,
  api: false,
};

// ---- 37(a). every sync code has an arm in useSyncErrorText ---- //
try {
  let codes = null;
  if (inboxBackend) {
    const got = inboxSyncCodes(
      [
        [INBOX_SYNC_PY, inboxBackend.sync],
        [INBOX_ROUTES_PY, inboxBackend.routes],
      ],
      inboxBackend.google,
    );
    if (got.codes.size < 15)
      throw new Error(`read only ${got.codes.size} sync codes out of inbox_sync.py and inbox_routes.py (expected at least 15)`);
    if (got.google.size < 2)
      throw new Error(`read only ${got.google.size} GoogleAuthError codes behind the e.code passthrough (expected at least 2)`);
    if (!got.emitters.length) throw new Error("found no def that stores its `code` parameter (expected _fail and _note_error)");
    if (!got.statuses.has("active") || !got.statuses.has("needs_reauth"))
      throw new Error(`read the connection statuses [${[...got.statuses].sort()}], without "active" and "needs_reauth"`);
    codes = got.codes;
    inboxFamilies.sync = codes;
    inboxFamilies.statuses = got.statuses;
  }
  const parsed = switchArms(read(SHARED_TSX), "export function useSyncErrorText", SYNC_SPEC.who);
  for (const p of armProblems(parsed, codes, SYNC_SPEC)) fail(`check 37(a): ${p}`);

  // The reader, both directions, on a fixture shaped like inbox_sync.py.
  const SYNC_PROBE = pyCodeLines(
    [
      "def _emit(db, result, code):",
      '    """error_code = "from_docstring"."""',
      '    # result.error_code = "from_comment"',
      '    x.error_code = "beta" if y == "not_a_code" else code',
      '    if r.error_code == "compared":',
      "        pass",
      "",
      "",
      "def run(db, r, conn):",
      '    _emit(db, r, "gamma")',
      '    result.error_code = result.error_code or "delta"',
      '    out = InboxSyncResult(user_id=1, error_code="theta")',
      // A black-formatted call: each keyword on its own continuation line, the
      // last one closing the call, and two keywords sharing a line.
      "    return InboxSyncResult(",
      "        user_id=1,",
      '        error_code="iota",',
      '        last_error="kappa")',
      "    InboxSyncResult(",
      '        error_code="mu", last_error="nu",',
      "    )",
      // A site after a colon or a semicolon, not at a line's start.
      '    if conn is None: result.error_code = "omicron"',
      '    db.flush(); r.last_error = "pi"',
      // Every way a connection gets a status: the plain write, an alias, a bulk
      // update and the constructor. A local named `status`, the page's copy of
      // the connection's, and an application card's status are not written to
      // any connection, and are not read.
      '    conn.status = "paused"',
      '    conn.status = "active"',
      "    mc = conn",
      '    mc.status = "held"',
      '    db.execute(update(MailConnection).values(status="frozen"))',
      '    db.add(MailConnection(user_id=1, status="parked"))',
      "    status = 404 if gone else 409",
      '    out.status = conn.status or ""',
      '    result.error_code = conn.status or "error"',
      "",
      "",
      "@dataclass",
      "class _Card:",
      "    status: str",
      "",
      "    @classmethod",
      "    def of(cls, app):",
      '        return cls(id=app.id, status=app.status or "saved")',
      "",
      "    def follow(self, app):",
      '        self.status = app.status or "saved"',
      "",
      "",
      "@dataclass",
      "class _Tally:",
      '    last_error: str = "rho"',
      "",
      "",
      "def _fail(db, conn, result, code, *, reauth=False):",
      '    result.error_code = "needs_reauth" if reauth else code',
      "    conn.last_error = code",
      "",
      "",
      "def _open(db, conn, result):",
      "    try:",
      "        google_oauth.refresh(token)",
      "    except google_oauth.GoogleAuthError as e:",
      "        _fail(db, conn, result, e.code, reauth=e.code in _REAUTH_CODES)",
      "",
      "",
      '_REAUTH_CODES = frozenset({"grant_gone"})',
    ].join("\n"),
  );
  // `_error_code(…)` is Google's open set and adds nothing; both branches of the
  // ternary in `refresh` are codes; `_signin_claims` is never reached.
  const GOOGLE_SRC = [
    "def _http(url):",
    "    if bad:",
    '        raise GoogleAuthError("host_not_allowed")',
    "    raise GoogleAuthError(_error_code(data, status), status)",
    "",
    "",
    "def _error_code(data, status):",
    '    return f"http_{status}"',
    "",
    "",
    "def refresh(token):",
    "    data = _http(TOKEN_URL)",
    '    raise GoogleAuthError("no_access_token" if data else "empty_reply")',
    "",
    "",
    "def _signin_claims(x):",
    '    return GoogleAuthError("token_invalid")',
  ].join("\n");
  const GOOGLE_PROBE = pyCodeLines(GOOGLE_SRC);
  const probe = inboxSyncCodes([["probe.py", SYNC_PROBE]], GOOGLE_PROBE);
  const got = [...probe.codes].sort().join();
  const want =
    "beta,delta,empty_reply,error,frozen,gamma,grant_gone,held,host_not_allowed,iota,kappa,mu,needs_reauth," +
    "no_access_token,nu,omicron,parked,paused,pi,rho,theta";
  if (got !== want)
    fail(
      `check 37(a)'s sync reader reads [${got}] from its probe, not [${want}]: it misses a ternary branch, an ` +
        "`or`, a keyword argument (on its own line, or two on one), a site after a colon or a semicolon, an " +
        "annotated default, an emitter's caller, a connection status (written through an alias, a bulk update or " +
        "the constructor), the e.code passthrough or a branch of Google's own ternary, or reads a condition, a " +
        'comparison, a docstring, a comment, "active", a local named status, an application card\'s status or a ' +
        "Google code no sync can reach.",
    );
  if ([...probe.statuses].sort().join() !== "active,frozen,held,parked,paused")
    fail(`check 37(a) reads the connection statuses [${[...probe.statuses].sort()}] from its probe, not [active,frozen,held,parked,paused]`);
  if (probe.emitters.join() !== "_emit,_fail")
    fail(`check 37(a) finds the emitters [${probe.emitters.join()}] in its probe, not [_emit,_fail]`);
  // `why`, when given, is what the refusal must say, so a probe that throws for
  // some other reason cannot pass as a pin.
  const refuses = (label, src, google = GOOGLE_PROBE, why = null) => {
    let threw = null;
    try {
      inboxSyncCodes([["probe.py", pyCodeLines(src)]], google);
    } catch (e) {
      threw = e;
    }
    if (!threw) fail(`check 37(a)'s sync reader silently reads ${label} instead of refusing it`);
    else if (why && !why.test(threw.message))
      fail(`check 37(a)'s sync reader refuses ${label} for another reason: ${threw.message}`);
  };
  // The Google side's grammar is closed too: a code held in a variable, or one
  // built as an f-string instead of through `_error_code`, is refused. Its
  // control: the same sync fixture reads cleanly beside the ordinary Google one.
  const SYNC_SRC = [
    "def _fail(db, conn, result, code, *, reauth=False):",
    "    conn.last_error = code",
    "",
    "",
    "def _open(db, conn, result):",
    "    try:",
    "        google_oauth.refresh(token)",
    "    except google_oauth.GoogleAuthError as e:",
    "        _fail(db, conn, result, e.code, reauth=e.code in _REAUTH_CODES)",
    "",
    "",
    '_REAUTH_CODES = frozenset({"grant_gone"})',
  ].join("\n");
  const control = [...inboxSyncCodes([["probe.py", pyCodeLines(SYNC_SRC)]], GOOGLE_PROBE).codes].sort().join();
  if (control !== "empty_reply,grant_gone,host_not_allowed,no_access_token")
    fail(`check 37(a)'s Google control reads [${control}], not [empty_reply,grant_gone,host_not_allowed,no_access_token]`);
  const googleWith = (line) =>
    pyCodeLines(GOOGLE_SRC.replace('raise GoogleAuthError("no_access_token" if data else "empty_reply")', line));
  const NOT_READ = /neither a literal nor `_error_code/;
  refuses("a Google code held in a variable", SYNC_SRC, googleWith('why = "no_access_token"\n    raise GoogleAuthError(why)'), NOT_READ);
  refuses("a Google code built as an f-string", SYNC_SRC, googleWith('raise GoogleAuthError(f"http_{status}")'), NOT_READ);
  refuses("a GoogleAuthError with no code", SYNC_SRC, googleWith("raise GoogleAuthError()"), /with no code/);
  refuses("a helper's return value handed to an emitter", 'def _emit(db, result, code):\n    result.error_code = code\n\n\ndef run(db, r):\n    _emit(db, r, helper())\n');
  refuses("`code` in a def with no `code` parameter", "def run(db, result):\n    result.error_code = code\n");
  refuses("a computed value", "def run(db):\n    error_code = compute()\n");
  refuses("an emitter nobody calls", "def _emit(db, result, code):\n    result.error_code = code\n");
  // The nets: every other way to write a code or a status, each for its own reason.
  const NOT_A_STATUS = /neither a literal nor `conn\.status`/;
  const TUPLE = /a tuple assignment/;
  const AUG = /an augmented/;
  const NAMED = /is named in a string/;
  const UNPACKED = /`\*\*` unpacks fields/;
  const run = (body) => `def run(db, result, conn):\n${body.map((l) => `    ${l}`).join("\n")}\n`;
  for (const [label, body, why] of [
    ["a connection status that is not a literal", ["conn.status = pick()", 'result.error_code = conn.status or "error"'], NOT_A_STATUS],
    ["an aliased status that is not a literal", ["mc = conn", "mc.status = pick()"], NOT_A_STATUS],
    ["a bulk-updated status that is not a literal", ["db.execute(update(MailConnection).values(status=pick()))"], NOT_A_STATUS],
    ["an application's status outside its class", ['card.status = app.status or "saved"'], NOT_A_STATUS],
    ["a code as the first target of a tuple", ['result.error_code, _x = "brand_new", 1'], TUPLE],
    ["a code as a later target of a tuple", ['_x, result.error_code = 1, "brand_new"'], TUPLE],
    ["a status as a target of a tuple", ['conn.status, _x = "paused", 1'], TUPLE],
    ["an augmented code", ['result.error_code += "_more"'], AUG],
    ["an augmented status", ['conn.status += "_more"'], AUG],
    ["a code set by setattr", ['setattr(result, "error_code", "brand_new")'], NAMED],
    ["a code set by model_copy", ['result = result.model_copy(update={"error_code": "brand_new"})'], NAMED],
    ["a status set by setattr", ['setattr(conn, "status", "paused")'], NAMED],
    ["a result built by unpacking", ["result = InboxSyncResult(**extra)"], UNPACKED],
    ["a bulk update built by unpacking", ["db.execute(update(MailConnection).values(**changes))"], UNPACKED],
  ])
    refuses(label, run(body), GOOGLE_PROBE, why);
  // Their false-positive twins read cleanly: a comparison, a read passed on as
  // an argument, a returned tuple, and a local named `status`.
  try {
    inboxSyncCodes(
      [
        [
          "probe.py",
          pyCodeLines(
            run([
              'if result.error_code == "x" or conn.status != "active": pass',
              "log(result.error_code, conn.status)",
              "pair = result.error_code, conn.status",
              "status = 404 if gone else 409",
              "raise HTTPException(status, detail=result.error_code)",
            ]),
          ),
        ],
      ],
      GOOGLE_PROBE,
    );
  } catch (e) {
    fail(`check 37(a)'s nets fire on code that writes no code and no status: ${e.message}`);
  }
} catch (e) {
  fail(`check 37(a) (inbox sync codes) could not run: ${e.message}`);
}

// ---- 37(b). every route refusal has an arm in useInboxRefusalText ---- //
try {
  let browser = null;
  if (inboxBackend) {
    const { raised, fns } = inboxRefusalCodes(inboxBackend.routes, inboxBackend.apply);
    if (raised.size < 10) throw new Error(`read only ${raised.size} refusal codes out of inbox_routes.py (expected at least 10)`);
    if (fns.size < 2) throw new Error(`expanded the inbox_{refusal} f-string through only ${fns.size} inbox_apply functions (expected at least 2)`);
    for (const code of INBOX_SERVER_ONLY) {
      const defs = [...(raised.get(code) ?? [])];
      if (defs.some((d) => d !== "inbox_cron"))
        fail(
          `check 37(b): "${code}" is exempt from needing a sentence only because the cron is the one route that sends ` +
            `it, and ${defs.filter((d) => d !== "inbox_cron").join(", ")} raises it too, where a browser would read it.`,
        );
    }
    browser = new Set([...raised.keys()].filter((c) => !INBOX_SERVER_ONLY.has(c)));
    inboxFamilies.refusal = browser;
  }
  const parsed = switchArms(read(SHARED_TSX), "export function useInboxRefusalText", REFUSAL_SPEC.who);
  for (const p of armProblems(parsed, browser, REFUSAL_SPEC)) fail(`check 37(b): ${p}`);

  // The reader, both directions, on fixtures shaped like the two real files.
  const ROUTES = pyCodeLines(
    [
      "def _finish(db, event, user, refusal):",
      "    if refusal:",
      '        raise HTTPException(409, detail={"code": f"inbox_{refusal}"})',
      "",
      "",
      "def route_a(db, ev, u):",
      '    """Refuses with detail={"code": "from_docstring"}."""',
      "    return _finish(db, ev, u, inbox_apply.a(db))",
      "",
      "",
      "def route_b(db, ev, u):",
      "    r = inbox_apply.b(db)",
      "    return _finish(db, ev, u, r)",
      "",
      "",
      "def route_c(db):",
      '    raise HTTPException(400, {"code": "inbox_z"})',
      "",
      "",
      "def inbox_cron(db):",
      '    raise HTTPException(503, detail={"code": "cron_unconfigured"})',
      "    raise HTTPException(401, \"Bad cron secret, don't retry.\")",
    ].join("\n"),
  );
  const APPLY = pyCodeLines(['def a(db):', '    if x:', '        return "x"', '    return ""', "", "", 'def b(db):', '    return "y"'].join("\n"));
  const probe = inboxRefusalCodes(ROUTES, APPLY);
  const got = [...probe.raised.keys()].sort().join();
  if (got !== "cron_unconfigured,inbox_x,inbox_y,inbox_z")
    fail(
      `check 37(b)'s refusal reader reads [${got}] from its probe, not [cron_unconfigured,inbox_x,inbox_y,inbox_z]: ` +
        "it misses the inline or the variable-held inbox_apply call or a positional dict detail, reads a " +
        "docstring or a plain message detail, or counts \"\" as a refusal.",
    );
  if ([...(probe.raised.get("cron_unconfigured") ?? [])].join() !== "inbox_cron")
    fail("check 37(b) cannot tell which def raises the server-only code, so it cannot hold that code to the cron");
  const refuses = (label, routes, apply, why = null) => {
    let threw = null;
    try {
      inboxRefusalCodes(pyCodeLines(routes), pyCodeLines(apply));
    } catch (e) {
      threw = e;
    }
    if (!threw) fail(`check 37(b)'s refusal reader silently reads ${label} instead of refusing it`);
    else if (why && !why.test(threw.message))
      fail(`check 37(b)'s refusal reader refuses ${label} for another reason: ${threw.message}`);
  };
  refuses(
    "a refusal function returning a helper's value",
    'def _finish(db, e, u, refusal):\n    raise HTTPException(409, detail={"code": f"inbox_{refusal}"})\n\n\ndef r(db):\n    return _finish(db, e, u, inbox_apply.a(db))\n',
    "def a(db):\n    return helper()\n",
  );
  refuses(
    "an f-string with two placeholders",
    'def _finish(db, a, b):\n    raise HTTPException(409, detail={"code": f"inbox_{a}_{b}"})\n',
    "",
  );
  refuses("a code held in a variable", 'def r(db, code):\n    raise HTTPException(409, detail={"code": code})\n', "");
  const NOT_A_DETAIL = /neither a message literal nor/;
  refuses("a detail held in a variable", "def r(db, d):\n    raise HTTPException(409, detail=d)\n", "", NOT_A_DETAIL);
  refuses("a detail built by dict()", 'def r(db):\n    raise HTTPException(409, dict(code="inbox_q"))\n', "", NOT_A_DETAIL);
  refuses(
    'a `{"code": …}` that is not an HTTPException detail',
    'def r(db):\n    return JSONResponse(status_code=409, content={"code": "inbox_q"})\n',
    "",
    /carries a "code" key that is not the detail/,
  );
  refuses(
    "a `dict(code=…)` that is not an HTTPException detail",
    'def r(db):\n    return JSONResponse(status_code=404, content={"detail": dict(code=picked)})\n',
    "",
    /sends `code=picked` as a dict key/,
  );
  refuses(
    "a literal `code=` keyword that is not an HTTPException detail",
    'def r(db):\n    return JSONResponse(status_code=404, content=Refusal(code="inbox_q").model_dump())\n',
    "",
    /sends `code="inbox_q"` as a literal/,
  );
  // Their false-positive twins: Google's OAuth code handed on by keyword, a
  // def's own default, and a local named `code` are not refusals.
  try {
    inboxRefusalCodes(
      pyCodeLines(
        [
          'def _swap(code="unused", verifier=""):',
          "    return google_oauth.exchange_code(code=code, verifier=verifier)",
          "",
          "",
          "def r(db):",
          "    code = request.query_params.get(name)",
          "    return _swap(code=code)",
        ].join("\n"),
      ),
      APPLY,
    );
  } catch (e) {
    fail(`check 37(b)'s refusal nets fire on a \`code=\` that sends no refusal: ${e.message}`);
  }
} catch (e) {
  fail(`check 37(b) (inbox refusals) could not run: ${e.message}`);
}

// ---- 37(c). every callback reason has an arm in callbackMessage ---- //
try {
  let codes = null;
  if (inboxBackend) {
    const got = inboxCallbackCodes(inboxBackend.routes);
    if (got.codes.size < 10)
      throw new Error(`read only ${got.codes.size} reasons out of inbox_google_callback (expected at least 10)`);
    codes = got.codes;
    inboxFamilies.callback = codes;
  }
  const parsed = switchArms(read(SETTINGS_CARD_TSX), "function callbackMessage", CALLBACK_SPEC.who);
  for (const p of armProblems(parsed, codes, CALLBACK_SPEC)) fail(`check 37(c): ${p}`);

  const CALLBACK_PROBE = [
    '@router.get("/inbox/google/callback")',
    "def inbox_google_callback(",
    "    request: Request,",
    '    code: str = "",',
    ") -> RedirectResponse:",
    '    """Every refusal is fail("from_a_docstring")."""',
    "    def leave(path: str) -> RedirectResponse:",
    "        return RedirectResponse(path)",
    "",
    "    def fail(reason: str) -> RedirectResponse:",
    '        return leave("/settings?inbox=" + quote(reason, safe=""))  # fail("from_a_comment")',
    "",
    "    if error:",
    '        return fail("access_denied" if error == "access_denied" else "google_error")',
    "    if caller is None:",
    '        return leave("/login?next=" + quote("/settings", safe=""))',
    "    if bad_token:",
    '        return leave("/settings?inbox=token_error")',
    "",
    "    def refuse(reason: str) -> RedirectResponse:",
    '        google_oauth.revoke(str(tokens.get("refresh_token") or ""))',
    "        return fail(reason)",
    "",
    "    if not google_oauth.grants_gmail(tokens):",
    '        return refuse("missing_scope")',
    '    return leave("/tracker?inbox=connected")',
    "",
    "",
    '@router.get("/next")',
    "def next_route():",
    '    return fail("not_this_function")',
  ].join("\n");
  const probe = inboxCallbackCodes(pyCodeLines(CALLBACK_PROBE));
  const got = [...probe.codes].sort().join();
  if (got !== "access_denied,google_error,missing_scope,token_error" || probe.emitters.join() !== "fail,refuse")
    fail(
      `check 37(c)'s callback reader reads [${got}] through [${probe.emitters.join()}] from its probe, not ` +
        "[access_denied,google_error,missing_scope,token_error] through [fail,refuse]: it misses a nested emitter, " +
        "a ternary branch or a reason leave() sends directly, or reads a condition, a docstring, a comment, " +
        "leave()'s success path, the /login redirect or the next function.",
    );
  const refusesCb = (label, src, why) => {
    let threw = null;
    try {
      inboxCallbackCodes(pyCodeLines(src));
    } catch (e) {
      threw = e;
    }
    if (!threw) fail(`check 37(c)'s callback reader silently skips ${label} instead of refusing it`);
    else if (!why.test(threw.message)) fail(`check 37(c)'s callback reader refuses ${label} for another reason: ${threw.message}`);
  };
  const direct = 'return leave("/settings?inbox=token_error")';
  const SKIPS_LEAVE = /without going through/;
  refusesCb("a reason held in a variable", CALLBACK_PROBE.replace('refuse("missing_scope")', "refuse(picked)"), /passes `picked` to refuse/);
  refusesCb("`reason` passed from outside an emitter", CALLBACK_PROBE.replace('refuse("missing_scope")', "refuse(reason)"), /passes `reason` to refuse/);
  refusesCb("a leave() whose path is a variable", CALLBACK_PROBE.replace(direct, "return leave(target)"), /leave\(\) is sent `target`/);
  refusesCb("a leave() carrying ?inbox= to another page", CALLBACK_PROBE.replace(direct, 'return leave("/jobs?inbox=token_error")'), /to neither/);
  refusesCb("an ?inbox= redirect that skips leave()", CALLBACK_PROBE.replace(direct, 'return RedirectResponse("/settings?inbox=token_error")'), SKIPS_LEAVE);
  refusesCb(
    "an ?inbox= redirect in another route",
    `${CALLBACK_PROBE}\n\n\ndef other_route():\n    return RedirectResponse("/settings?inbox=elsewhere")\n`,
    SKIPS_LEAVE,
  );
} catch (e) {
  fail(`check 37(c) (Gmail callback reasons) could not run: ${e.message}`);
}

// ---- 37(d). every inbox refusal goes through useInboxRefusalText ---- //
try {
  const dir = path.join(SRC, "components", "inbox");
  const files = fs.readdirSync(dir).filter((f) => /\.tsx?$/.test(f));
  if (files.length < 5) throw new Error(`found only ${files.length} source files under components/inbox — the files moved`);
  // Every mention, not only a plain call: an aliased import, a namespace import
  // (`api.apiErrorMessage(…)`) and a dynamic import each reach it under a name
  // a call scan never looks for.
  for (const f of files)
    for (const [n, text] of directApiErrorCalls(`components/inbox/${f}`, read(`components/inbox/${f}`)))
      fail(
        `check 37(d): components/inbox/${f}:${n} can reach apiErrorMessage without useInboxRefusalText ` +
          `(\`${text}\`), so an inbox refusal shown there skips its sentence. Call \`useInboxRefusalText()\`'s ` +
          "function instead: it falls back to apiErrorMessage for everything it does not translate.",
      );
  // Both directions, on shared.tsx's shape: its own import, the hook's default
  // and a doc comment stay quiet; a component's call, an aliased import, a
  // namespace import, a method call on it and a dynamic import each fire.
  const HOOK = [
    'import { apiErrorCode, apiErrorMessage } from "../../lib/apiError";',
    "export function useInboxRefusalText(): (e: unknown, fallback: string) => string {",
    "  return (e, fallback) => {",
    "    /** anything else goes through `apiErrorMessage(e, fallback)` */",
    "    switch (apiErrorCode(e)) {",
    "      default:",
    "        return apiErrorMessage(e, fallback);",
    "    }",
    "  };",
    "}",
    "export function Other() {",
    '  toast("error", apiErrorMessage(e, t("x")));', // 12
    "}",
    'import { apiErrorMessage as msg } from "../../lib/apiError";', // 14
    'import * as api from "../../lib/apiError";', // 15
    'const text = api.apiErrorMessage(e, t("y"));', // 16
    'const lazy = import("../../lib/apiError");', // 17
    "// apiErrorMessage in a line comment",
  ].join("\n");
  const hits = directApiErrorCalls("components/inbox/shared.tsx", HOOK).map(([n]) => n);
  if (hits.join() !== "12,14,15,16,17")
    fail(
      `check 37(d)'s detector reports [${hits.join()}] on its probe, not [12,14,15,16,17]: it fires on shared.tsx's ` +
        "own import, the hook's default or a comment, or misses a direct call, an aliased, namespace or dynamic " +
        "import, or a call through a namespace.",
    );
  const elsewhere = directApiErrorCalls("components/inbox/InboxBar.tsx", HOOK.split("\n").slice(0, 1).join("\n"));
  if (elsewhere.length !== 1)
    fail("check 37(d) lets a component other than shared.tsx import apiErrorMessage");
} catch (e) {
  fail(`check 37(d) (inbox refusal wiring) could not run: ${e.message}`);
}

// ---- 37(e). every code the page compares with is one the backend sends ---- //
try {
  const files = fs.readdirSync(path.join(SRC, "components", "inbox")).filter((f) => /\.tsx?$/.test(f));
  const seen = { sync: [], refusal: [], reason: [], connection: [] };
  const perFile = new Map();
  for (const f of files) {
    const found = inboxComparisons(read(`components/inbox/${f}`));
    perFile.set(f, found);
    for (const c of found) seen[c.family].push({ ...c, file: f });
  }
  const floors = { sync: 3, refusal: 2, reason: 2, connection: 2 };
  for (const [family, least] of Object.entries(floors))
    if (seen[family].length < least)
      throw new Error(`read only ${seen[family].length} ${family}-code comparisons under components/inbox (expected at least ${least})`);
  const ansAt = /\bconst\s+ANSWERS\s*=\s*new\s+Set\(\s*\[([^\]]*)\]\s*\)/.exec(decomment(read(SHARED_TSX)));
  if (!ansAt) throw new Error("components/inbox/shared.tsx has no `const ANSWERS = new Set([…])` any more");
  const answers = [...ansAt[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (answers.length < 2) throw new Error(`read only ${answers.length} codes out of ANSWERS (expected at least 2)`);

  if (inboxBackend) {
    const reasons = inboxReasons(inboxBackend.routes);
    if (!reasons.size) throw new Error("_status sets no non-empty reason (expected invite_only)");
    inboxFamilies.reasons = reasons;
    const sets = {
      sync: inboxFamilies.sync,
      refusal: inboxFamilies.refusal,
      reason: reasons,
      connection: inboxFamilies.statuses,
    };
    for (const [family, set] of Object.entries(sets))
      if (!set) throw new Error(`the backend's ${family} codes were not read (37(a)-(c) failed above)`);
    for (const p of staleComparisons(Object.values(seen).flat(), sets)) fail(p);
    for (const code of answers)
      if (!sets.refusal.has(code))
        fail(`check 37(e): shared.tsx's ANSWERS lists "${code}", which no inbox route sends, so its tone is never used.`);
    for (const reason of reasons)
      for (const f of ["InboxBar.tsx", "InboxSettingsCard.tsx"])
        if (!(perFile.get(f) ?? []).some((c) => c.family === "reason" && c.code === reason))
          fail(
            `check 37(e): InboxStatus.reason can be "${reason}", and components/inbox/${f} never compares with it, ` +
              "so that state renders as if nothing were wrong there. Handle it in the bar AND the Settings card.",
          );
  }

  // A CONNECTED account off the invite list (FIXB B15) is the one reason that
  // reaches a connection, and it looked healthy on both surfaces: a mint
  // "Connected" badge, a Sync button that can only be refused, and a background
  // sync on every visit, because a refused sync moves no timestamp. The
  // comparisons above are satisfied by the not-connected branches alone, so the
  // helper both surfaces read is held to its own comparison and to its callers:
  // the bar's render and its background-sync guard, and the Settings card.
  const offSrc = decomment(fnSource(read(SHARED_TSX), "export function isOffInviteList"));
  if (!/\.reason\s*===\s*"invite_only"/.test(offSrc) || !/\.provider\s*!==\s*"fake"/.test(offSrc))
    fail(
      "check 37(e): shared.tsx's isOffInviteList no longer reads `reason === \"invite_only\"` with the demo mailbox " +
        "exempt, which is the backend's own rule (inbox_sync.sync_user).",
    );
  const bar = decomment(read("components/inbox/InboxBar.tsx"));
  const guard = bar.split("\n").find((l) => /\bs\.status\s*===\s*"needs_reauth"/.test(l) && /\breturn;/.test(l)) ?? "";
  if (!/isOffInviteList\(\s*s\s*\)/.test(guard))
    fail(
      "check 37(e): InboxBar's background-sync guard does not skip a connection that is off the invite list, so " +
        "every visit fires a sync the server can only refuse.",
    );
  if ((bar.match(/\bisOffInviteList\(/g) ?? []).length < 2)
    fail("check 37(e): InboxBar does not render the off-the-invite-list state (isOffInviteList is called once or never).");
  // B15's early return never moves `window_lo_ms`, so an account taken off the
  // list mid-import keeps `backfilling` true for ever: the import line has to be
  // held off too, or the bar says "Importing your last N days" next to the
  // invite-only line, about an import that cannot run.
  const importLine = /\bconst\s+importDays\s*=([^;]*);/.exec(bar);
  if (!importLine) throw new Error("InboxBar has no `const importDays = …;` any more — the import line moved");
  if (!/^\s*offList\s*\?\s*0\s*:/.test(importLine[1]))
    fail(
      "check 37(e): InboxBar's import line is not held off for a connection that is off the invite list " +
        `(\`const importDays =${importLine[1]};\`), so it says an import is running that no sync will ever continue.`,
    );
  if (!/\bisOffInviteList\(/.test(decomment(read(SETTINGS_CARD_TSX))))
    fail("check 37(e): the Settings card shows a connection that is off the invite list as Connected.");

  // The comparison reader, both directions.
  const CMP = [
    "const code = apiErrorCode(e);",
    'const left = code === "inbox_not_reviewd" || code === "inbox_not_found";',
    'if (last.error_code === "sync_in_progress") x();',
    'if ("invite_only" !== status.reason) y();',
    'if (ev.action === "created") z();',
    '// if (status.reason === "from_a_comment") w();',
    'const reauth = !offList && status.status === "needs_reauht";',
    'if (s.status !== "active") v();',
    'if (ev.new_status === "applied") u();',
  ].join("\n");
  const found = inboxComparisons(CMP).map((c) => ({ ...c, file: "probe.tsx" }));
  const cmp = found
    .map((c) => `${c.family}:${c.code}`)
    .sort()
    .join();
  const cmpWant =
    "connection:active,connection:needs_reauht,reason:invite_only,refusal:inbox_not_found," +
    "refusal:inbox_not_reviewd,sync:sync_in_progress";
  if (cmp !== cmpWant)
    fail(
      `check 37(e)'s comparison reader reads [${cmp}] from its probe, not [${cmpWant}]: it misses a code held in a ` +
        "const, a reversed comparison or a family (a connection's status among them), or reads an unrelated " +
        "field, an email's `new_status` or a comment.",
    );
  // Its rule, both directions: the stale names fire and the real ones do not.
  const flagged = staleComparisons(found, {
    sync: new Set(["sync_in_progress"]),
    refusal: new Set(["inbox_not_review", "inbox_not_found"]),
    reason: new Set(["invite_only"]),
    connection: new Set(["active", "needs_reauth"]),
  });
  if (flagged.length !== 2 || !flagged.some((p) => p.includes('"needs_reauht"')) || !flagged.some((p) => p.includes('"inbox_not_reviewd"')))
    fail(`check 37(e) does not report exactly the two stale comparisons in its probe: [${flagged.join(" | ")}]`);
  // The rules, both directions: a stale rename fires, the real name and a
  // Google string the backend names (invalid_grant, from _REAUTH_CODES) pass,
  // and a case stacked on default is not an arm.
  const armsOf = (lines) =>
    switchArms(`export function h() {\n  return (code) => {\n    switch (code) {\n${lines.join("\n")}\n    }\n  };\n}\n`, "export function h", "probe");
  const REF = { ...REFUSAL_SPEC, who: "probe" };
  const stale = armProblems(armsOf(['      case "inbox_not_reviewd":', '        return t("k");', "      default:", "        return apiErrorMessage(e, fallback);"]), new Set(["inbox_not_review"]), REF);
  if (!stale.some((p) => p.includes('"inbox_not_reviewd" is not')) || !stale.some((p) => p.includes('"inbox_not_review", which')))
    fail("check 37(e) does not report a stale renamed arm AND the new code left on the default");
  const SYNC = { ...SYNC_SPEC, who: "probe" };
  const fine = armProblems(
    armsOf(['      case "":', '        return "";', '      case "invalid_grant":', '        return t("inbox.errors.reauth");', "      default:", '        return t("inbox.errors.generic");']),
    new Set(["invalid_grant"]),
    SYNC,
  );
  if (fine.length) fail(`check 37's rules fire on a switch with nothing wrong in it: ${fine.join(" | ")}`);
  const pairing = armProblems(armsOf(['      case "":', '        return "";', '      case "a":', '        return t("k.a");', "      default:", '        return t("inbox.errors.generic");']), new Set(["a", "b"]), SYNC);
  if (pairing.length !== 1 || !pairing[0].includes('"b"'))
    fail(`check 37 cannot tell a code with an arm from a code without one: [${pairing.join(" | ")}]`);
  const stacked = armsOf(['      case "":', '        return "";', '      case "d":', "      default:", '        return t("inbox.errors.generic");']);
  if (stacked.arms.has("d") || stacked.intoDefault.join() !== "d" || !armProblems(stacked, new Set(["d"]), SYNC).some((p) => p.includes("falls straight into")))
    fail("check 37 counts a case stacked on default: as an arm of its own");
  const both = armsOf(['      // case "c":', '      case "a": case "b": return t("k.ab");', '      case "":', '        return "";', "      default:", '        return t("inbox.errors.generic");']);
  if ([...both.arms.keys()].sort().join() !== ",a,b" || both.arms.get("a").key !== "k.ab")
    fail("check 37's switch reader misreads two labels on one line, or reads a commented-out case");
  const loose = armProblems(armsOf(['      case "":', '        return "";', '      case "x":', '        return "";', "      default:", '        return t("inbox.errors.other");']), null, SYNC);
  if (!loose.some((p) => p.includes('case "x" returns ""')) || !loose.some((p) => p.includes("default returns")))
    fail("check 37 lets a real code return \"\", or lets the default return something other than the generic sentence");
  for (const [label, bad] of [
    ["a default returning the raw code", "        return code;"],
    ["an arm computing its sentence", "        return t(`inbox.errors.${code}`);"],
  ]) {
    let threw = false;
    try {
      armsOf(['      case "x":', bad, "      default:", '        return t("inbox.errors.generic");']);
    } catch {
      threw = true;
    }
    if (!threw) fail(`check 37's switch reader accepts ${label} instead of refusing it`);
  }
  const twoFns = [
    "export function h() {",
    "  return (code) => {",
    "    switch (code) {",
    "      default:",
    '        return t("g");',
    "    }",
    "  };",
    "}",
    "export function other() {",
    "  switch (code) {",
    '    case "other_fn":',
    '      return t("k");',
    "  }",
    "}",
  ].join("\n");
  if (switchArms(twoFns, "export function h", "probe").arms.size !== 0)
    fail("check 37's switch reader reads the arms of the NEXT function");
} catch (e) {
  fail(`check 37(e) (inbox codes, the other direction) could not run: ${e.message}`);
}

// ---- 38. a remounted cover letter shows the letter it had ------------------ //
// Found beside P30-RELOAD-PASS and fixed on 2026-09-22. CoverLetter keeps its
// text in component state, seeded ONCE from `initialText`, so every page that
// can remount the card has to hand the letter back. TailorPage mounted it with
// no `initialText`, so Tracker and back on /app hid a letter the user had paid a
// use for while tailorStore still held it. KitReviewPage kept its letter in page
// state alone, so a reload of /kits/:id lost it. tsc sees neither: the prop is
// optional, and a letter kept nowhere compiles.
//
// (a) every `<CoverLetter` element under src/ passes `initialText={…}` with a
//     real expression (not "", undefined or null), and the card seeds its text
//     from that prop.
// (b) KitReviewPage restores the kit's stored letter when the kit loads, and
//     stores a new one through saveKitCoverLetter, which PUTs `{ cover_letter }`
//     to the path routes.py mounts.
try {
  /** The text of each `<CoverLetter …>` element: from the tag to the `/>` or
   * `>` that closes it at brace depth 0, so an arrow's `=>` inside a prop is not
   * read as the end. */
  const coverElements = (src) => {
    const out = [];
    const tag = /<CoverLetter(?=[\s/>])/g;
    let m;
    while ((m = tag.exec(src))) {
      let depth = 0;
      let end = -1;
      for (let i = m.index + m[0].length; i < src.length; i++) {
        const c = src[i];
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (depth === 0 && c === ">") {
          end = i;
          break;
        }
      }
      if (end === -1) throw new Error(`an unclosed <CoverLetter element at offset ${m.index}`);
      out.push(src.slice(m.index, end + 1));
    }
    return out;
  };
  /** '' when the element hands the card its letter back, else what is wrong. */
  const initialTextProblem = (el) => {
    const m = /\binitialText=\{([^}]*)\}/.exec(el);
    if (!m) return "passes no initialText";
    const expr = m[1].trim();
    if (["", '""', "''", "``", "undefined", "null"].includes(expr)) return `passes initialText={${expr}}`;
    return "";
  };

  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".tsx")) files.push(full);
    }
  })(SRC);
  let mounts = 0;
  for (const f of files) {
    const rel = path.relative(SRC, f).split(path.sep).join("/");
    if (rel === "components/CoverLetter.tsx") continue;
    for (const el of coverElements(decomment(fs.readFileSync(f, "utf8")))) {
      mounts++;
      const problem = initialTextProblem(el);
      if (problem)
        fail(
          `${rel}: <CoverLetter> ${problem}. The card keeps its letter in its own state, so when this page ` +
            "remounts it (a reload, or Tracker and back) the letter the user paid a use for is hidden. " +
            "Pass the letter this page keeps as initialText.",
        );
    }
  }
  if (mounts < 2) throw new Error(`found ${mounts} <CoverLetter> elements under src/, expected JobPage's and KitReviewPage's (the letter left TailorPage for the job's page in PLAN 31.4/4)`);
  if (!/\buseState\(\s*initialText\b/.test(decomment(read("components/CoverLetter.tsx"))))
    fail("components/CoverLetter.tsx no longer seeds its text from initialText, so no page can hand a letter back");

  // Both directions on the element reader and the rule.
  const probes = [
    ['<CoverLetter resume={r} jd={jd} onGenerated={(l) => set(l)} />', "passes no initialText"],
    ['<CoverLetter resume={r} jd={jd} initialText={""} />', 'passes initialText={""}'],
    ["<CoverLetter\n  resume={r}\n  initialText={undefined}\n/>", "passes initialText={undefined}"],
    ['<CoverLetter resume={r} onGenerated={(l) => set(l)} initialText={coverLetterText} />', ""],
    ["<CoverLetter resume={r} initialText={cover} onGenerated={onCoverGenerated} />", ""],
  ];
  for (const [el, want] of probes) {
    const got = coverElements(el);
    if (got.length !== 1 || got[0] !== el) fail(`check 38's element reader misreads ${JSON.stringify(el)}`);
    else if (initialTextProblem(got[0]) !== want)
      fail(`check 38 reads ${JSON.stringify(el)} as ${JSON.stringify(initialTextProblem(got[0]))}, not ${JSON.stringify(want)}`);
  }
  if (coverElements("<CoverLetterCard x={1} /> <CoverLetters />").length !== 0)
    fail("check 38 reads a longer component name as <CoverLetter>");

  // (b) the kit page restores the stored letter and stores a new one.
  const kitPage = decomment(read("pages/KitReviewPage.tsx"));
  if (!/\bsetCover\(\s*\w+\.cover_letter\b/.test(kitPage))
    fail(
      "pages/KitReviewPage.tsx does not set its letter from the loaded kit's cover_letter, so a reload of /kits/:id " +
        "shows an empty card over a letter the kit stored",
    );
  const [kitCard] = coverElements(kitPage);
  const handler = /\bonGenerated=\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(kitCard ?? "");
  const handlerBody = handler ? fnSource(kitPage, `function ${handler[1]}`) : (kitCard ?? "");
  if (!/\bsaveKitCoverLetter\(/.test(handlerBody))
    fail(
      "pages/KitReviewPage.tsx: the cover letter card's onGenerated does not call saveKitCoverLetter, so a new letter " +
        "lives in page state alone and a reload of /kits/:id loses it",
    );
  const client = decomment(read("api/client.ts"));
  const PUTS_LETTER = /\bapi\.put\(\s*`\/kits\/\$\{id\}\/cover-letter`\s*,\s*\{\s*cover_letter:\s*\w+\s*\}\s*\)/;
  if (!PUTS_LETTER.test(fnSource(client, "export async function saveKitCoverLetter")))
    fail("api/client.ts: saveKitCoverLetter does not PUT `{ cover_letter }` to `/kits/${id}/cover-letter`");
  if (PUTS_LETTER.test("api.put(`/kits/${id}/cover-letter`, { coverLetter })") ||
      !PUTS_LETTER.test("api.put(`/kits/${id}/cover-letter`, { cover_letter: coverLetter })"))
    fail("check 38's client reader cannot tell `{ cover_letter }` from `{ coverLetter }`");
  const routes = pySource("app/api/routes.py", "check 38");
  if (routes !== null && !/^@router\.put\(\s*"\/kits\/\{kit_id\}\/cover-letter"/m.test(routes))
    fail(
      'backend/app/api/routes.py mounts no PUT "/kits/{kit_id}/cover-letter", which api/client.ts calls: every save ' +
        "would be a 404, and the kit page would lose its letter on reload as before.",
    );
} catch (e) {
  fail(`remounted cover letter check (check 38) could not run: ${e.message}`);
}

// ---- 39. every context-overflow kind has its own sentence (EXECUTED) -------- //
// Found by P30-PASS-SIZE's review, fixed on 2026-09-22. A prompt that passes our
// caps and still does not fit the model's window is a 413 `context_exceeded`,
// and `apiErrorMessage` answered every one with "Your CV is too long for the AI
// to read in one go. Trim the oldest roles". On the mock interview's two routes
// the transcript can be the larger part of the prompt (a chat turn sends up to
// ~544 KB), so the sentence blamed the CV for a session that had grown. Those
// routes now re-raise with a `kind` (transcript, session), and each kind names
// the session and the CV together, because the model's refusal does not say
// which part was too big.
//
// Check 34 cannot see these: it reads the kinds of InputTooLarge, not of this
// exception. So the kinds are READ from every .py file under backend/app (a
// literal `kind=` or second argument of `ContextWindowExceeded(…)`; one it cannot
// read is red), and `apiErrorMessage`, EXECUTED with a recording i18n stub, must
// ask for `sizeLimit.context<Kind>` for each, resolving in both common.json
// files. The false-positive half: no kind, an unknown kind and `constructor` all
// ask for the CV's `sizeLimit.context`, which every other route means.
try {
  const CONTEXT_KINDS = ["session", "transcript"];
  /** The kinds one Python file raises ContextWindowExceeded with, and the calls
   * whose kind is not a literal. A call with no kind raises the CV's case. */
  const contextKinds = (code) => {
    const kinds = new Set();
    const opaque = [];
    for (const m of code.matchAll(/\bContextWindowExceeded\(/g)) {
      if (/\b(?:def|class)\s+$/.test(code.slice(Math.max(0, m.index - 8), m.index))) continue;
      const args = pyCallArgs(code, m.index + m[0].length - 1).map((a) => a.trim());
      const byName = args.find((a) => /^kind\s*=/.test(a));
      const arg = byName ? byName.replace(/^kind\s*=\s*/, "") : args[1] ?? "";
      if (!arg) continue;
      const lit = /^(["'])([a-z][a-z_]*)\1$/.exec(arg);
      if (lit) kinds.add(lit[2]);
      else opaque.push(arg);
    }
    return { kinds, opaque };
  };
  const probe = contextKinds(
    pyCode(
      [
        "class ContextWindowExceeded(Exception):",
        '    """ContextWindowExceeded("from_a_docstring", kind="nope")"""',
        "raise ContextWindowExceeded(str(e)) from e",
        'raise ContextWindowExceeded(str(e), kind="by_keyword") from e',
        'raise ContextWindowExceeded(f"{a}, {b}", "positional")',
        "# raise ContextWindowExceeded(x, kind=\"from_a_comment\")",
        "raise ContextWindowExceeded(str(e), kind=chosen)",
      ].join("\n"),
    ),
  );
  if ([...probe.kinds].sort().join() !== "by_keyword,positional" || probe.opaque.join() !== "chosen")
    fail(
      `check 39's reader reads [${[...probe.kinds].sort()}] and opaque [${probe.opaque}] from its probe, not ` +
        "[by_keyword,positional] and [chosen]: it misses a keyword or positional kind, or reads a docstring or a comment.",
    );

  let kinds = CONTEXT_KINDS;
  if (pySource("app/llm/limits.py", "check 39") !== null) {
    const found = new Set();
    for (const rel of backendPyFiles()) {
      const { kinds: here, opaque } = contextKinds(pyCode(pySource(rel, "check 39")));
      for (const k of here) found.add(k);
      for (const o of opaque)
        fail(
          `backend/${rel} raises ContextWindowExceeded with kind ${o}, which check 39 cannot read: pass it as a ` +
            "string literal, so the build can require a sentence for it.",
        );
    }
    const missing = CONTEXT_KINDS.filter((k) => !found.has(k));
    if (missing.length)
      throw new Error(
        `read [${[...found].sort()}] out of backend/app, missing [${missing}]: the reader broke, or a kind was renamed — ` +
          "rename its sentence and this floor with it",
      );
    kinds = [...found].sort();
  }

  const asked = [];
  const i18nStub = {
    __esModule: true,
    language: "en",
    t: (key, opts) => {
      asked.push([key, opts || {}]);
      return `T:${key}`;
    },
  };
  i18nStub.default = i18nStub;
  const ae = runProbeBundle("apierror-context", `export * from "./lib/apiError";\n`, { "../i18n": i18nStub });
  const render = (detail) => {
    asked.length = 0;
    const text = ae.apiErrorMessage({ response: { status: 413, data: { detail } } }, "FALLBACK");
    return { text, ns: (asked[asked.length - 1] || [undefined, {}])[1].ns };
  };
  const locales = Object.fromEntries(["en", "he"].map((loc) => [loc, JSON.parse(read(`locales/${loc}/common.json`))]));
  for (const kind of kinds) {
    const key = `sizeLimit.context${kind[0].toUpperCase()}${kind.slice(1)}`;
    const got = render({ code: "context_exceeded", kind });
    if (got.text !== `T:${key}` || got.ns !== "common")
      fail(
        `a 413 context_exceeded of kind "${kind}" renders ${JSON.stringify(got.text)}, not common's "${key}": ` +
          "lib/apiError.ts's CONTEXT_LIMIT_KEYS must name it, or the user is told their CV is too long when the " +
          "practice session is the larger part.",
      );
    for (const loc of ["en", "he"])
      if (!resolvesIn(locales[loc], key))
        fail(`locales/${loc}/common.json is missing "${key}", so a "${kind}" context overflow shows the raw key.`);
  }
  for (const detail of [{ code: "context_exceeded" }, { code: "context_exceeded", kind: "some_future_kind" },
    { code: "context_exceeded", kind: "constructor" }]) {
    const got = render(detail).text;
    if (got !== "T:sizeLimit.context")
      fail(`a context overflow ${JSON.stringify(detail)} renders ${JSON.stringify(got)}, not the CV's "sizeLimit.context"`);
  }
} catch (e) {
  fail(`context-overflow kind check (check 39) could not run: ${e.message}`);
}

// ---- 40. both surfaces date "New" by the role's first board date ------------ //
// Found 2026-09-21, fixed 2026-09-22. The search card's NewBadge read
// `m.first_posted_at || m.posted_at`, but the History tab's read `hit.posted_at`
// alone, because history stored no earlier date: a relisted role said "New ·
// Posted yesterday" there for up to 48 hours while the same posting on the
// search page said "Older · first posted Sep 7". Rows now store a min-merged
// `first_posted_at` (smoke pins the merge), and both badges must read it first.
// Pinned by the badge's ARGUMENT, not by the name's presence, and the field by
// both mirrors, because a renamed field compiles green and reads undefined.
try {
  const cards = decomment(read("pages/jobs/cards.tsx"));
  const row = fnSource(cards, "export function HistoryRow");
  const badge = /<NewBadge\s+postedAt=\{\s*([^}]+?)\s*\}/.exec(row);
  if (!badge) throw new Error("HistoryRow renders no <NewBadge postedAt={…}>");
  const arg = badge[1];
  const bound = /^[A-Za-z_$][\w$]*$/.test(arg)
    ? (new RegExp(`\\bconst\\s+${arg}\\s*=\\s*([^;\\n]+)`).exec(row) || [])[1] ?? ""
    : arg;
  const FIRST_THEN_OWN = /^hit\.first_posted_at\s*\|\|\s*hit\.posted_at$/;
  if (!FIRST_THEN_OWN.test(bound.trim()))
    fail(
      `pages/jobs/cards.tsx: HistoryRow's NewBadge reads ${JSON.stringify(bound.trim() || arg)}, not ` +
        "`hit.first_posted_at || hit.posted_at`, so History calls a relisted role New from this listing's own date " +
        "while the search card calls the same posting Older.",
    );
  if (!/<NewBadge\s+postedAt=\{\s*m\.first_posted_at\s*\|\|\s*m\.posted_at\s*\}/.test(cards))
    fail("pages/jobs/cards.tsx: the search card's NewBadge no longer reads `m.first_posted_at || m.posted_at`");
  if (FIRST_THEN_OWN.test("hit.posted_at") || FIRST_THEN_OWN.test("hit.posted_at || hit.first_posted_at") ||
      !FIRST_THEN_OWN.test("hit.first_posted_at || hit.posted_at"))
    fail("check 40's reader cannot tell the first board date from the listing's own");
  const hitType = blockAfter(read("types.ts"), "export interface JobSearchHit ", "JobSearchHit in types.ts");
  if (!topLevelKeys(hitType).includes("first_posted_at"))
    fail("types.ts: JobSearchHit has no first_posted_at, so HistoryRow reads undefined and falls back for ever");
  const models = pySource("app/models/__init__.py", "check 40");
  if (models !== null) {
    const out = /class JobSearchHitOut\(BaseModel\):([\s\S]*?)\n(?=class |\S)/.exec(models.replace(/\r\n/g, "\n"));
    if (!out) throw new Error("could not find class JobSearchHitOut in backend/app/models/__init__.py");
    if (!/^\s+first_posted_at:\s*str\b/m.test(out[1]))
      fail("backend JobSearchHitOut has no first_posted_at, which types.ts's JobSearchHit and HistoryRow read");
  }
} catch (e) {
  fail(`History New-badge check (check 40) could not run: ${e.message}`);
}

// ---- 41. the page's last line clears what floats at the bottom ------------- //
// Found in the Phase 29 browser pass, fixed 2026-09-22. Below `lg` the feedback
// pill floated at `bottom-[calc(4.25rem+env(safe-area-inset-bottom))]`, and
// `main` was padded `pb-24`: 6rem, under the pill's top edge (4.25rem + its own
// ~2.4rem) by 10 px at 390x844 (measured with Playwright: the /app template note's
// last line sat under it with the page scrolled to the end), and with no
// safe-area inset at all, so on an iPhone the 34 px home indicator made it 44 px
// that no scroll could bring out.
//
// Since PLAN 31.2/12 (owner decision 4, 2026-09-23) the pill is desktop-only and
// "Send feedback" is a row in the account menu below lg, so on a phone what sits
// at the bottom is the TAB BAR, 3.5rem (56 px at 390x664, measured in both
// languages). The two numbers live in two files, so the check reads both, and
// it reads the pill's own class to decide which one main must clear: a pill any
// phone or tablet shows means its offset plus its height, as before; a pill
// hidden below lg means the tab bar plus a rem. The inset is required either way.
try {
  const PILL_REM = 2.5; // py-2.5 plus a 20 px line: 2.375rem, rounded up
  const TABBAR_REM = 3.5;
  const pill = decomment(read("components/FeedbackButton.tsx"));
  const layout = decomment(read("layouts/AppLayout.tsx"));
  const pillClass = /className="([^"]*\bfixed\b[^"]*)"/.exec(pill);
  if (!pillClass) throw new Error("components/FeedbackButton.tsx has no fixed element with a literal className");
  // Hidden at the base and shown only from lg: no sm: or md: display class may
  // bring it back on a tablet, where the tab bar still shows.
  const desktopOnly = (cls) => {
    const c = cls.split(/\s+/);
    return (
      c.includes("hidden") &&
      c.some((x) => /^lg:(?:flex|inline-flex|block|inline-block|grid)$/.test(x)) &&
      !c.some((x) => /^(?:sm|md):(?:flex|inline-flex|block|inline-block|grid)$/.test(x))
    );
  };
  let needed;
  let against;
  if (desktopOnly(pillClass[1])) {
    needed = TABBAR_REM + 1;
    against = `the tab bar (${TABBAR_REM}rem + inset, and a rem to spare)`;
  } else {
    const at = /\bbottom-\[calc\(([\d.]+)rem\+env\(safe-area-inset-bottom\)\)\]/.exec(pillClass[1]);
    if (!at)
      throw new Error(
        "the feedback pill shows below lg but has no bottom-[calc(<n>rem+env(safe-area-inset-bottom))] to measure",
      );
    needed = Number(at[1]) + PILL_REM;
    against = `the feedback pill's top edge (${at[1]}rem + ${PILL_REM}rem + inset)`;
  }
  const mainTag = /<main\b[\s\S]*?>/.exec(layout);
  if (!mainTag) throw new Error("layouts/AppLayout.tsx renders no <main>");
  // The base (unprefixed) bottom padding: `pb-…` not preceded by a `sm:`/`lg:` prefix.
  const readPad = (tag) => /(?:^|[\s"'`(])pb-(\[calc\(([\d.]+)rem\+env\(safe-area-inset-bottom\)\)\]|(\d+))(?=[\s"'`)])/.exec(tag);
  const pad = readPad(mainTag[0]);
  if (!pad) throw new Error("AppLayout's <main> has no base pb-… class");
  if (pad[3] !== undefined)
    fail(
      `layouts/AppLayout.tsx: <main> is padded pb-${pad[3]}, with no safe-area inset, while what floats at the ` +
        `bottom sits above the inset: on an iPhone the page's last line stays under ${against}. ` +
        `Use pb-[calc(<at least ${needed}>rem+env(safe-area-inset-bottom))].`,
    );
  else if (Number(pad[2]) < needed)
    fail(
      `layouts/AppLayout.tsx: <main>'s bottom padding (${pad[2]}rem + inset) is under ${against}, so the ` +
        "page's last line can never scroll out from under it.",
    );
  // Both directions on both readers.
  if (readPad('<main className={cn("lg:pb-10 pt-8")}>') ||
      readPad('<main className={cn("pb-24 pt-8 lg:pb-10")}>')?.[3] !== "24" ||
      readPad('<main className={cn("pb-[calc(7.5rem+env(safe-area-inset-bottom))] pt-8")}>')?.[2] !== "7.5")
    fail("check 41's padding reader reads a prefixed lg:pb as the base padding, or misses a base one");
  if (!desktopOnly("fixed bottom-4 end-4 z-40 hidden items-center lg:flex") ||
      desktopOnly("fixed bottom-[calc(4.25rem+env(safe-area-inset-bottom))] end-4 z-40 flex lg:bottom-4") ||
      desktopOnly("fixed bottom-4 end-4 hidden sm:flex lg:flex") ||
      desktopOnly("fixed bottom-4 end-4 hidden"))
    fail("check 41's pill reader cannot tell a desktop-only pill from one a phone or tablet shows");
} catch (e) {
  fail(`bottom clearance check (check 41) could not run: ${e.message}`);
}

// ---- 42. a modal overlay takes focus, keeps it, and gives it back (EXECUTED) //
// Found in the 2026-09-21 390 px pass, fixed 2026-09-22. The review drawer is
// `aria-modal` below `lg`, yet after it opened `document.activeElement` stayed on
// the "Check my CV" pill OUTSIDE it (all four runs), so a keyboard or screen-
// reader user was left behind the overlay; `Modal` had no trap and no way back
// either. `hooks/useDialogFocus` does all three. Measured after the fix with
// Playwright at 390x844, en and he: focus lands in the drawer and in the
// feedback modal, 0 of 25 Tabs and 0 of 25 Shift+Tabs leave either, and Escape
// and the close button hand focus back to the opener. With the hook turned off
// the same script read 25 of 25 leaving and focus on the pill.
//
// (a) EXECUTES `trapTarget`, the pure step of the trap, over every case; (b)
// pins the wiring by shape: the drawer calls the hook with the breakpoint in its
// condition (it is modal below `lg` only) and the ref on the `aside`, and Modal
// with `open` and the ref on its dialog, each container focusable (`tabIndex={-1}`).
try {
  const df = runProbeBundle("dialog-focus", `export * from "./hooks/useDialogFocus";\n`);
  if (typeof df.trapTarget !== "function") throw new Error("hooks/useDialogFocus.ts does not export trapTarget");
  const a = "a", b = "b", c = "c";
  const cases = [
    [[a, b, c], c, true, false, a, "Tab on the last item wraps to the first"],
    [[a, b, c], a, true, true, c, "Shift+Tab on the first item wraps to the last"],
    [[a, b, c], b, true, false, null, "Tab in the middle is the browser's own move"],
    [[a, b, c], b, true, true, null, "Shift+Tab in the middle is the browser's own move"],
    [[a, b, c], "box", true, false, a, "Tab on the container itself goes to the first item"],
    [[a, b, c], "box", true, true, c, "Shift+Tab on the container itself goes to the last item"],
    [[a, b, c], "page", false, false, a, "focus that left the overlay comes back to the first item"],
    [[a, b, c], "page", false, true, c, "…or the last one on Shift+Tab"],
    [[], "box", true, false, "none", "an overlay with nothing to tab to keeps focus on itself"],
  ];
  for (const [items, active, inside, shift, want, label] of cases) {
    const got = df.trapTarget(items, active, inside, shift);
    if (got !== want) fail(`check 42: trapTarget — ${label}: got ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
  }

  const panel = decomment(read("components/DocumentPanel.tsx"));
  const call = /\buseDialogFocus\(\s*([^,]+?)\s*,\s*(\w+)\s*\)/.exec(panel);
  if (!call) fail("components/DocumentPanel.tsx: the review drawer does not call useDialogFocus");
  else {
    if (!/\breviewOpen\b/.test(call[1]) || !/!\s*isWide\b/.test(call[1]))
      fail(
        `components/DocumentPanel.tsx: useDialogFocus(${call[1]}, …) — the drawer is modal only while it is open AND ` +
          "below `lg` (`!isWide`); from `lg` it sits beside the paper and must take nothing",
      );
    const aside = /<aside\b[\s\S]*?>/.exec(panel.slice(panel.indexOf("createPortal(")))?.[0] ?? "";
    if (!new RegExp(`\\bref=\\{\\s*${call[2]}\\s*\\}`).test(aside) || !/tabIndex=\{\s*-1\s*\}/.test(aside))
      fail(`components/DocumentPanel.tsx: the drawer's <aside> must carry ref={${call[2]}} and tabIndex={-1}, or focus has nowhere to land`);
  }
  // BlockEditSheet: modal whenever it shows a block; its first field autofocuses,
  // which is why the hook reads the opener in render rather than in its effect.
  const sheet = decomment(read("components/BlockEditSheet.tsx"));
  const scall = /\buseDialogFocus\(\s*open\s*&&\s*!!draft\s*,\s*(\w+)\s*\)/.exec(sheet);
  if (!scall) fail("components/BlockEditSheet.tsx does not call useDialogFocus(open && !!draft, <ref>)");
  else {
    const sdialog = /<motion\.div\b(?=[^>]*role="dialog")[\s\S]*?>/.exec(sheet)?.[0] ?? "";
    if (!new RegExp(`\\bref=\\{\\s*${scall[1]}\\s*\\}`).test(sdialog) || !/tabIndex=\{\s*-1\s*\}/.test(sdialog))
      fail(`components/BlockEditSheet.tsx: the role="dialog" element must carry ref={${scall[1]}} and tabIndex={-1}`);
  }
  const hook = decomment(read("hooks/useDialogFocus.ts"));
  const effectAt = hook.indexOf("useEffect(");
  const readAt = hook.indexOf("document.activeElement instanceof HTMLElement ? document.activeElement");
  if (effectAt === -1 || readAt === -1 || readAt > effectAt)
    fail(
      "hooks/useDialogFocus.ts must read the opener BEFORE its effect, in the render that opens the overlay: an " +
        "autoFocus field inside takes focus during the commit, so an effect records that field as the opener",
    );
  const modal = decomment(read("components/ui/Modal.tsx"));
  const mcall = /\buseDialogFocus\(\s*open\s*,\s*(\w+)\s*\)/.exec(modal);
  if (!mcall) fail("components/ui/Modal.tsx does not call useDialogFocus(open, <ref>)");
  else {
    const dialog = /<motion\.div\b(?=[^>]*role="dialog")[\s\S]*?>/.exec(modal)?.[0] ?? "";
    if (!new RegExp(`\\bref=\\{\\s*${mcall[1]}\\s*\\}`).test(dialog) || !/tabIndex=\{\s*-1\s*\}/.test(dialog))
      fail(`components/ui/Modal.tsx: the role="dialog" element must carry ref={${mcall[1]}} and tabIndex={-1}`);
  }
} catch (e) {
  fail(`overlay focus check (check 42) could not run: ${e.message}`);
}

// ---- 43. the fit check's included tailor ends on the device's clock (EXECUTED) //
// Found beside P30-RELOAD-PASS, fixed 2026-09-22: the same defect that fix
// closed for the cover letter. `FitCheckResult.tailor_included_until` is the
// server's absolute instant, and `usesFor` compares it with Date.now(), so on a
// phone whose clock runs ahead the included tailor read as over early, and at 0
// uses left `out` disabled a Tailor the server still covered. The server now
// sends `tailor_expires_in_s` beside it, and `checkFit` replaces the instant with
// a deadline taken on arrival (`inclusionFrom`). The REAL `checkFit` is bundled
// out of api/client.ts and run against scripted answers on a device clock 2
// hours ahead of the server.
try {
  const realUses = runProbeBundle("fit-uses", `export * from "./lib/usesStore";\n`);
  let answer = null;
  const api = {
    post: async () => ({ data: answer, headers: {} }),
    get: async () => ({ data: null, headers: {} }),
    interceptors: { request: { use() {} }, response: { use() {} } },
  };
  const stubs = {
    axios: { create: () => api, isAxiosError: () => false },
    "../lib/usesStore": realUses,
    "../lib/draft": { noteDraftOwner() {} },
    "../lib/dataCache": { cachedFetch: (_k, fn) => fn(), clearDataCache() {}, invalidateData() {} },
    "../hooks/useMasterResume": { resetMasterCache() {} },
  };
  const client = runProbeBundle("check-fit", `export { checkFit } from "./api/client";\n`, stubs, { "import.meta.env": "{}" });
  if (typeof client.checkFit !== "function") throw new Error("api/client.ts exports no checkFit");
  const realNow = Date.now;
  const server = Date.UTC(2026, 8, 30, 23, 0, 0);
  const device = server + 2 * 3600_000; // a phone two hours fast
  Date.now = () => device;
  try {
    const base = { jd: {}, keyword_coverage: 0, fit_score: 0, rationale: "", gaps: [], covered: 0, partial: 0, missing: 0, total: 0 };
    const serverEnd = new Date(server + 86_400_000).toISOString();
    const run = async (extra) => {
      answer = { ...base, ...extra };
      return client.checkFit({}, "a posting");
    };
    const fresh = await run({ tailor_included_until: serverEnd, tailor_expires_in_s: 86_390 });
    const until = Date.parse(fresh.tailor_included_until);
    if (until !== device + 86_390_000)
      fail(
        `check 43: checkFit hands back tailor_included_until ${JSON.stringify(fresh.tailor_included_until)}, not the ` +
          "device's own now plus tailor_expires_in_s: on a phone 2 hours fast the included tailor ends 2 hours early.",
      );
    else if (realUses.usesFor("tailor", fresh.tailor_included_until, null).covered !== true)
      fail("check 43: usesFor does not read the converted deadline as covering the tailor");
    const exempt = await run({ tailor_included_until: "", tailor_expires_in_s: 0 });
    if (exempt.tailor_included_until !== "")
      fail(`check 43: an exempt answer (0 seconds) becomes ${JSON.stringify(exempt.tailor_included_until)}, not ""`);
    const old = await run({ tailor_included_until: serverEnd });
    if (old.tailor_included_until !== serverEnd)
      fail("check 43: an answer from a backend with no tailor_expires_in_s must keep its instant, not lose the ride");
  } finally {
    Date.now = realNow;
  }
} catch (e) {
  fail(`fit-check deadline check (check 43) could not run: ${e.message}`);
}

// ---- 44. the phone tool row shows the review's count, at a 32 px floor ------ //
// Found in the 2026-09-21 390 px pass, fixed 2026-09-22. The /app tool row shows
// ~366 px of ~940 and scrolls itself; in the shared order the review is 5th,
// behind three view pills and Template, so the only number on the row was off-
// screen on first paint, and every labelled pill measured 30 px. The phone row
// now leads with the review (the desktop rail keeps the shared order) and a
// labelled pill carries `min-h-8`. Re-measured at 390 px in en and he: the review
// pill first and visible with its count, every pill 32 px.
try {
  const panel = decomment(read("components/DocumentPanel.tsx"));
  const row = /<div\b[^>]*role="group"[^>]*lg:hidden[^>]*>\s*\{\s*(\w+)\.map\(/.exec(panel);
  if (!row) throw new Error("could not find the phone tool row (role=\"group\", lg:hidden) and the list it maps");
  const list = row[1];
  if (list === "tools")
    fail("components/DocumentPanel.tsx: the phone tool row maps `tools` in the shared order, so the review pill (the only one with a count) is off-screen on first paint at 390 px");
  else {
    const def = new RegExp(`const\\s+${list}\\s*=\\s*\\[([^\\n]*)\\]`).exec(panel);
    if (!def || !/^\s*\.\.\.tools\.filter\(\s*\(?(\w+)\)?\s*=>\s*\1\.key\s*===\s*"review"\s*\)/.test(def[1]))
      fail(`components/DocumentPanel.tsx: ${list} must START with the review tool (…tools.filter((x) => x.key === "review"), then the rest)`);
  }
  const pill = /labelled\s*\?\s*"([^"]*)"\s*:\s*"h-10 w-10"/.exec(panel);
  if (!pill) throw new Error("could not find ToolButton's labelled class string");
  if (!/\bmin-h-(?:8|9|10|11|12)\b/.test(pill[1]))
    fail(`components/DocumentPanel.tsx: a labelled tool pill ("${pill[1]}") has no min-h-8 — it measured 30 px at 390, under the 32 px floor`);
} catch (e) {
  fail(`phone tool row check (check 44) could not run: ${e.message}`);
}

// ---- 45. another account in another tab: heard, and the draft left alone (EXECUTED) //
// Known open since P30-EXT-LIMIT, fixed 2026-09-22. Every tab shares the session
// cookie, so after account B signed in from another tab this tab's requests ran
// as B while its stores still showed A; nothing noticed. And two mid-session
// readers of /auth/me (the search stream's error frame, Settings' mount) went
// through getAuthMe, which re-stamps the resume draft's owner from whatever the
// answer says, so such an answer claimed this tab's unsaved edits for B.
//
// (a) EXECUTES lib/accountWatch.ts as TWO tabs (the module bundled twice, one
//     instance each) over a fake BroadcastChannel: tab 1 hears tab 2 announce
//     another account and a sign-out, never its own account, and never its own
//     messages. (b) EXECUTES readAuthMe: the uses store only for the same
//     account, the draft owner never. (c) pins the wiring by source: the guard
//     announces a.user.id, an effect watches meId and reloads the document,
//     sign-out announces null before its own document load, and Settings reads
//     /auth/me through readAuthMe.
try {
  const realBC = globalThis.BroadcastChannel;
  const rooms = new Map();
  class FakeBC {
    constructor(name) {
      this.name = name;
      this.listeners = new Set();
      if (!rooms.has(name)) rooms.set(name, new Set());
      rooms.get(name).add(this);
    }
    postMessage(data) {
      for (const other of rooms.get(this.name)) if (other !== this) for (const l of other.listeners) l({ data });
    }
    addEventListener(type, l) {
      if (type === "message") this.listeners.add(l);
    }
    removeEventListener(type, l) {
      if (type === "message") this.listeners.delete(l);
    }
    close() {
      rooms.get(this.name).delete(this);
    }
  }
  globalThis.BroadcastChannel = FakeBC;
  try {
    const tab1 = runProbeBundle("account-watch-1", `export * from "./lib/accountWatch";\n`);
    const tab2 = runProbeBundle("account-watch-2", `export * from "./lib/accountWatch";\n`);
    for (const name of ["announceAccount", "watchAccount", "isOtherAccount", "tabAccount"])
      if (typeof tab1[name] !== "function") throw new Error(`lib/accountWatch.ts does not export ${name}`);
    const heard = [];
    tab1.announceAccount(7);
    const stop = tab1.watchAccount(7, () => heard.push("reload"));
    const steps = [];
    const hear = (label, act) => {
      const before = heard.length;
      act();
      steps.push([label, heard.length - before]);
    };
    hear("tab 2 announces the same account", () => tab2.announceAccount(7));
    hear("tab 2 announces another account", () => tab2.announceAccount(9));
    hear("tab 2 signs out", () => tab2.announceAccount(null));
    hear("tab 1 announces itself", () => tab1.announceAccount(7));
    hear("tab 1 signs out itself", () => tab1.announceAccount(null));
    stop();
    hear("after unsubscribing, tab 2 announces another account", () => tab2.announceAccount(9));
    const want = [
      ["tab 2 announces the same account", 0],
      ["tab 2 announces another account", 1],
      ["tab 2 signs out", 1],
      ["tab 1 announces itself", 0],
      ["tab 1 signs out itself", 0],
      ["after unsubscribing, tab 2 announces another account", 0],
    ];
    if (JSON.stringify(steps) !== JSON.stringify(want))
      fail(`check 45: lib/accountWatch.ts reloads ${JSON.stringify(steps)}, not ${JSON.stringify(want)}`);
    if (tab1.tabAccount() !== 7 || tab2.tabAccount() !== 9)
      fail(`check 45: tabAccount reads ${tab1.tabAccount()} / ${tab2.tabAccount()}, not each tab's own last announced account (7 / 9)`);
    for (const [msg, want2] of [[{ account: 9 }, true], [{ account: null }, true], [{ account: 7 }, false], [null, false], ["9", false], [{}, false], [{ account: "9" }, false]])
      if (tab1.isOtherAccount(7, msg) !== want2)
        fail(`check 45: isOtherAccount(7, ${JSON.stringify(msg)}) is ${!want2}, not ${want2}`);
  } finally {
    globalThis.BroadcastChannel = realBC;
  }

  // (b) readAuthMe, bundled out of api/client.ts against refreshUses' harness.
  const us = runProbeBundle("read-auth-me-uses", `export * from "./lib/usesStore";\n`);
  const h = refreshUsesHarness(us);
  const client = runProbeBundle("read-auth-me", `export { readAuthMe } from "./api/client";\n`, h.stubs, { "import.meta.env": "{}" });
  if (typeof client.readAuthMe !== "function") throw new Error("api/client.ts exports no readAuthMe");
  const mine = { plan: "free", limit: 10, used: 2, remaining: 8, resets_on: "2026-10-01", by_feature: {}, passes: {} };
  const signedIn = (id) => ({ authenticated: true, verified: true, method: "session", user: { id }, usage: mine });
  for (const [label, answer, expected, want] of [
    ["the same account", signedIn(7), 7, [mine]],
    ["another account", signedIn(9), 7, []],
    ["a signed-out answer", { authenticated: false, verified: false, method: null, user: null, usage: null }, 7, []],
    ["no account known to this tab", signedIn(7), null, []],
  ]) {
    h.reset(answer);
    const got = await client.readAuthMe(expected);
    if (got !== answer) fail(`check 45: readAuthMe(${expected}) answered by ${label} does not hand the answer back`);
    if (JSON.stringify(h.writes) !== JSON.stringify(want))
      fail(`check 45: readAuthMe(${expected}), answered by ${label}, wrote ${JSON.stringify(h.writes)} into the uses store, not ${JSON.stringify(want)}`);
    if (h.sideEffects.length) fail(`check 45: readAuthMe, answered by ${label}, also ${h.sideEffects.join(", ")}`);
  }

  // (c) the wiring.
  const layout = decomment(read("layouts/AppLayout.tsx"));
  if (!/\bsetMeId\(a\.user\.id\);\s*(?:\/\/[^\n]*\n\s*)*announceAccount\(a\.user\.id\);/.test(layout))
    fail("layouts/AppLayout.tsx: the guard does not announceAccount(a.user.id) beside setMeId, so no other tab learns who holds the cookie");
  const watch = /useEffect\(\(\)\s*=>\s*\{\s*if\s*\(\s*meId\s*===\s*null\s*\)\s*return;\s*return\s+watchAccount\(\s*meId\s*,\s*\(\)\s*=>\s*window\.location\.reload\(\)\s*\);\s*\},\s*\[\s*meId\s*\]\s*\)/;
  if (!watch.test(layout))
    fail("layouts/AppLayout.tsx has no `useEffect(() => { if (meId === null) return; return watchAccount(meId, () => window.location.reload()); }, [meId])`, so a tab keeps showing account A after B signs in elsewhere");
  const out = fnSource(decomment(read("lib/session.ts")), "export async function signOut");
  const said = out.indexOf("announceAccount(null)");
  const left = out.indexOf("window.location.assign(destination)");
  if (said === -1 || left === -1 || said > left)
    fail("lib/session.ts: signOut must announceAccount(null) BEFORE its document load, or the other tabs keep showing a signed-out account");
  const settings = decomment(read("pages/SettingsPage.tsx"));
  if (/\bgetAuthMe\(/.test(settings) || !/\breadAuthMe\(\s*tabAccount\(\)\s*\)/.test(settings))
    fail("pages/SettingsPage.tsx must read /auth/me through readAuthMe(tabAccount()), never getAuthMe, which re-stamps the resume draft's owner on every visit");
} catch (e) {
  fail(`account switch check (check 45) could not run: ${e.message}`);
}

// ---- 46. a job card never grows past the screen ---------------------------- //
// PLAN 31.1/1, found in the 2026-09-23 review at 390 px. Every job result card is
// a BorderGlow, whose card is `display: grid` with one implicit `auto` column, and
// a grid item's automatic minimum is its min-content width. A title under
// `truncate` is `white-space: nowrap`, so its min-content is the WHOLE title: 2 of
// 10 cards measured 423 px and 636 px wide at a 390 px viewport, with the title,
// company, date and links clipped at the screen's edge. The grid item has to be
// allowed to shrink (`min-width: 0` on `.border-glow-inner`), or the card's column
// has to be bounded (`grid-template-columns: minmax(0, 1fr)`). The detector is
// probed both ways on every run.
try {
  const css = decomment(read("components/ui/BorderGlow.css"));
  const rule = (src, sel) => {
    const m = new RegExp(`(?:^|[}\\s])${sel.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`, "m").exec(src);
    return m ? m[1] : null;
  };
  const unbounded = (src) => {
    const card = rule(src, ".border-glow-card");
    const inner = rule(src, ".border-glow-inner");
    if (card === null || inner === null)
      throw new Error("could not find the .border-glow-card and .border-glow-inner rules in components/ui/BorderGlow.css");
    const isGrid = /\bdisplay\s*:\s*grid\b/.test(card);
    const innerShrinks = /\bmin-width\s*:\s*0(?:px)?\s*(?:;|$)/.test(inner);
    const columnBounded = /\bgrid-template-columns\s*:\s*minmax\(\s*0(?:px)?\s*,/.test(card);
    return isGrid && !innerShrinks && !columnBounded;
  };
  const planted = css.replace(/(\.border-glow-inner\s*\{[^}]*?)\bmin-width\s*:\s*0(?:px)?\s*;?/, "$1");
  if (planted === css && !unbounded(css))
    throw new Error("the probe could not plant the defect: `.border-glow-inner` carries no `min-width: 0` to remove, so the check would pass by never firing");
  if (!unbounded(planted))
    throw new Error("the detector passes a card with no min-width: 0 and no bounded column, so it cannot see the defect it exists for");
  if (unbounded(css))
    fail("components/ui/BorderGlow.css: .border-glow-card is a grid and neither `.border-glow-inner { min-width: 0 }` nor `grid-template-columns: minmax(0, 1fr)` bounds it, so a long job title widens its card past a 390 px screen (PLAN 31.1/1: 636 px measured)");
} catch (e) {
  fail(`job card width check (check 46) could not run: ${e.message}`);
}

// ---- 47. the paper's headings are printed in the PAPER's language ---------- //
// PLAN 31.1/3, found in the 2026-09-23 review. `sectionLabel` read the interface's
// `t`, while both renderers print `labels_for(resume_language(resume))`, so under
// the Hebrew UI an English CV showed "תקציר מקצועי" on screen and the downloaded
// PDF said "PROFESSIONAL SUMMARY" — the everyday case in the primary market (a
// Hebrew interface, an English CV for a tech job). The headings come from a
// fixed-language `t` keyed on the paper's own direction, and the other language's
// catalog is loaded when the paper needs it (only the interface's is loaded at
// start, and a missing bundle falls back to English). The detector is probed
// both ways on every run.
try {
  const view = decomment(read("components/ResumeView.tsx"));
  const labelDef = (src) => {
    const at = src.indexOf("const sectionLabel =");
    if (at === -1) return null;
    const end = src.indexOf(";", at);
    return end === -1 ? null : src.slice(at, end);
  };
  const problems47 = (src) => {
    const out = [];
    const def = labelDef(src);
    if (def === null) throw new Error("could not find `const sectionLabel =` in components/ResumeView.tsx");
    const fixed = /const\s+(\w+)\s*=\s*i18n\.getFixedT\(\s*(\w+)\s*,\s*"tailor"\s*\)/.exec(src);
    if (!fixed) out.push("no `const <tPaper> = i18n.getFixedT(<paperLang>, \"tailor\")`");
    else {
      const [, tName, langName] = fixed;
      if (!new RegExp(`\\b${tName}\\(\\s*\`sections\\.`).test(def))
        out.push(`sectionLabel does not read its headings through ${tName}`);
      if (/(^|[^\w.])t\(\s*`sections\./.test(def))
        out.push("sectionLabel reads a heading through the interface's `t`");
      if (!new RegExp(`const\\s+${langName}\\s*(?::\\s*\\w+\\s*)?=\\s*paperDir\\s*===\\s*"rtl"\\s*\\?\\s*"he"\\s*:\\s*"en"`).test(src))
        out.push(`${langName} is not derived from paperDir (rtl → "he", else "en")`);
      if (!new RegExp(`loadLanguage\\(\\s*${langName}\\s*\\)`).test(src))
        out.push(`nothing loads ${langName}'s catalog, so under the other interface language the headings fall back to English`);
    }
    return out;
  };
  const planted = view.replace(/(const sectionLabel =[^;]*?)\btPaper\(/g, "$1t(");
  if (planted === view) throw new Error("the probe could not plant the defect (no tPaper( inside sectionLabel to swap for t()");
  if (!problems47(planted).length) throw new Error("the detector passes a sectionLabel that reads the interface's t, so it cannot see the defect it exists for");
  for (const p of problems47(view))
    fail(`components/ResumeView.tsx: ${p} — the on-screen headings must follow the paper's language, as both renderers do (PLAN 31.1/3)`);
} catch (e) {
  fail(`paper heading language check (check 47) could not run: ${e.message}`);
}

// ---- 48. nothing states a claims verdict before a tailor ran ----------------- //
// PLAN 31.1/4, found in the 2026-09-23 review: after a fit check with no tailor,
// the score card's guard tile read "Facts invented 0 · No new facts detected ·
// Checked · Facts ledger" about a rewrite that did not exist. That breaks the
// house rules "the UI may not claim more than the code proves" and "unknown is
// never zero, and never clean". Since PLAN 31.3/1 the score card is GONE: a fit
// reading on the master is one line with no guard in it, and the claims live in
// a draft's summary line and in the drawer's Changes pane. So this pins what
// keeps a verdict off the page before a tailor: the summary is mounted only
// under `result`, the pane is built only from `result`, and TailorPage says no
// claims sentence of its own anywhere else. Probed with each gate loosened and a
// verdict planted on the page.
try {
  const page48 = decomment(read("pages/TailorPage.tsx"));
  const read48 = (pg) => {
    const out = [];
    if (!/\{reviewPane && result && effectiveResume && \(\s*<DraftSummary\b/.test(pg))
      out.push("DraftSummary, which states the claims, is not mounted only under a tailor result");
    if (!/const reviewPane =\s*result && jd && effectiveResume && !loading\s*\?/.test(pg))
      out.push("the drawer's Changes pane, which lists the claims, is not built only from a tailor result");
    if (/t\("(?:review\.summary\.(?:claims|noClaims|noClaimsTyped|claimsResolved)|changelog\.clean\w*|review\.resolvedBody)"/.test(pg))
      out.push("TailorPage states a claims verdict of its own, outside the draft's summary line and drawer");
    return out;
  };
  const real48 = read48(page48);
  for (const [label, pg] of [
    ["a summary with no result gate", page48.replace("{reviewPane && result && effectiveResume && (", "{reviewPane && effectiveResume && (")],
    ["a pane built without a result", page48.replace(/const reviewPane =\s*result && jd/, "const reviewPane =\n    jd")],
    ["a verdict on the page", page48.replace("<DocumentPanel", '{t("review.summary.noClaims")}\n<DocumentPanel')],
  ]) {
    if (pg === page48) {
      if (real48.length) continue;
      throw new Error(`the probe could not plant "${label}"`);
    }
    if (!read48(pg).length) throw new Error(`the reader passes "${label}", so it cannot be trusted`);
  }
  for (const p of real48) fail(`check 48: pages/TailorPage.tsx: ${p} (PLAN 31.1/4, 31.3/1)`);
} catch (e) {
  fail(`claims-before-a-tailor check (check 48) could not run: ${e.message}`);
}

// ---- 49. no developer wording reaches a user ------------------------------- //
// PLAN 31.1/7, found in the 2026-09-23 review. Users could read "Could not load
// applications. Is the backend running?", the same on a failed tracker update,
// and "(ALERT_SMTP_* in backend/.env)" on the alerts card, in both languages.
// Every string in every namespace of both locales is swept. "Backend Engineer"
// in a job-title placeholder is a job title, not a server, and stays allowed.
// The detector is probed both ways on every run.
try {
  const DEV = [
    [/\bbackend\b(?!\s+(?:engineer|developer|team))/i, "the word backend"],
    [/\.env\b/, "a .env file"],
    [/\b[A-Z][A-Z0-9]*_[A-Z0-9_]*\*?/, "an ENV_VAR name"],
    [/\bis the (?:backend|server|api) (?:running|up)\b/i, "\"is the server running\""],
    [/השרת רץ/, "\"השרת רץ\""],
    [/\blocalhost\b|127\.0\.0\.1/i, "a local address"],
    [/\buvicorn\b|\bstack trace\b|\btraceback\b/i, "a server tool"],
  ];
  const devHits = (value) => DEV.filter(([re]) => re.test(value)).map(([, why]) => why);
  for (const [value, want] of [
    ["Could not load applications. Is the backend running?", true],
    ["(ALERT_SMTP_* in backend/.env)", true],
    ["לא הצלחנו לעדכן את המעקב. האם השרת רץ?", true],
    ["e.g. Backend Engineer", false],
    ["Couldn't load your applications. Check your connection and try again.", false],
    ["למשל: Backend Engineer", false],
  ])
    if (devHits(value).length > 0 !== want)
      throw new Error(`the detector reads ${JSON.stringify(value)} as ${want ? "clean" : "developer wording"}, so it cannot be trusted`);
  const walk = (node, keyPath, out) => {
    if (typeof node === "string") out.push([keyPath, node]);
    else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) walk(v, keyPath ? `${keyPath}.${k}` : k, out);
    return out;
  };
  // Strings only the ADMIN ever sees, who is the one person who sets these
  // variables. Each is rendered under an `isAdmin` branch, which is checked here
  // too, so the allowance cannot outlive the branch that justifies it.
  const ADMIN_ONLY = { "settings.json": { "extension.adminNote": "pages/SettingsPage.tsx" } };
  for (const [file, keys] of Object.entries(ADMIN_ONLY))
    for (const [keyPath, page] of Object.entries(keys)) {
      const src = decomment(read(page));
      const ns = file.replace(/\.json$/, "");
      const leaf = keyPath.replace(/\./g, "\\.");
      if (!new RegExp(`isAdmin\\s*\\?\\s*\\(?\\s*<[^>]*>\\s*\\{\\s*t\\(\\s*"${leaf}"`).test(src))
        fail(`check 49: ${ns}:${keyPath} is allowed developer wording only because ${page} renders it for the admin alone, and that isAdmin branch is gone`);
    }
  let swept = 0;
  for (const loc of ["en", "he"]) {
    const dir = path.join(SRC, "locales", loc);
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      for (const [keyPath, value] of walk(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")), "", [])) {
        swept += 1;
        if (ADMIN_ONLY[file]?.[keyPath]) continue;
        const hits = devHits(value);
        if (hits.length) fail(`locales/${loc}/${file}: ${keyPath} shows a user ${hits.join(", ")}: ${JSON.stringify(value.slice(0, 90))} (PLAN 31.1/7)`);
      }
    }
  }
  if (swept < 500) throw new Error(`swept only ${swept} strings across both locales — the walk is not reading the catalogs`);
} catch (e) {
  fail(`developer wording check (check 49) could not run: ${e.message}`);
}

// ---- 50. every control has a name, in the reader's language ---------------- //
// PLAN 31.1/9, found in the 2026-09-23 review. Below `sm` the floating feedback
// button's only label is `hidden sm:inline`, so a screen reader announced a
// nameless "button" on every page of a phone-first app; every dialog's close
// button was aria-label="Close" in both languages, and the route spinner
// "Loading". (a) No `aria-label` or `title` in any .tsx under src/ is an English
// literal: it goes through t(). (b) The feedback button carries an aria-label.
// The sweep is probed both ways on every run.
try {
  const LITERAL = /\b(?:aria-label|title)="([^"{]*[A-Za-z][^"{]*)"/g;
  const literalLabels = (src) => [...src.matchAll(LITERAL)].map((m) => m[1]);
  if (!literalLabels('<X aria-label="Close" />').length || literalLabels('<X aria-label={t("actions.close")} title={x} />').length)
    throw new Error("the literal-label detector misreads its own probes, so it cannot be trusted");
  const tsxFiles = [];
  const walkDir = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walkDir(full);
      else if (ent.name.endsWith(".tsx")) tsxFiles.push(full);
    }
  };
  walkDir(SRC);
  if (tsxFiles.length < 50) throw new Error(`found only ${tsxFiles.length} .tsx files under src/ — the walk is not reading the app`);
  for (const file of tsxFiles) {
    const rel = path.relative(SRC, file).replace(/\\/g, "/");
    for (const label of literalLabels(decomment(fs.readFileSync(file, "utf8"))))
      fail(`${rel}: a hard-coded English label "${label}" — a Hebrew screen reader hears English; use t() (PLAN 31.1/9)`);
  }
  const feedback = decomment(read("components/FeedbackButton.tsx"));
  // The opening tag's attributes run to its first child tag. A `>` is no end
  // marker: `onClick={() => …}` carries one.
  const btn = /<button\b([^<]*)</.exec(feedback);
  if (!btn) throw new Error("could not find FeedbackButton's <button>");
  if (!/\bonClick=/.test(btn[1])) throw new Error("FeedbackButton's <button> attributes parsed without its onClick — the reader is cutting the tag short");
  if (!/\baria-label=\{\s*t\(/.test(btn[1]))
    fail("components/FeedbackButton.tsx: the floating button has no aria-label, and its visible label is hidden below sm, so on a phone it is a nameless button (PLAN 31.1/9)");
} catch (e) {
  fail(`control name check (check 50) could not run: ${e.message}`);
}

// ---- 51. a delete waits out an undo window (EXECUTED) ---------------------- //
// PLAN 31.1/6, found in the 2026-09-23 review. A tracker card, a kit and a
// History row were deleted on one tap, with no confirm and no way back. Each now
// leaves the list at once while the server delete waits in `scheduleUndoable`,
// behind a toast whose Undo cancels it. (a) EXECUTES lib/undoableDelete.ts: no
// commit inside the window, exactly one after it, none after an Undo, and a
// failed commit reported through onFailed. (b) Pins the three sites by shape:
// none awaits its delete call in the tap's own path, each schedules it, and each
// toast carries an action for the whole window. The site detector is probed
// both ways on every run.
try {
  const ud = runProbeBundle("undoable-delete", `export * from "./lib/undoableDelete";\n`);
  if (typeof ud.scheduleUndoable !== "function" || typeof ud.UNDO_MS !== "number")
    throw new Error("lib/undoableDelete.ts does not export scheduleUndoable and UNDO_MS");
  if (ud.UNDO_MS < 3000) fail(`check 51: UNDO_MS is ${ud.UNDO_MS} ms — too short to read a toast and press Undo`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const run = async (label, commitFn, cancelAt) => {
    const log = [];
    const cancel = ud.scheduleUndoable(() => { log.push("commit"); return commitFn(); }, () => log.push("failed"), 30);
    if (log.length) fail(`check 51 (${label}): the delete ran inside the undo window`);
    if (cancelAt === "before") cancel();
    await wait(90);
    if (cancelAt === "after") cancel();
    await wait(10);
    return log;
  };
  const ok = await run("plain", () => Promise.resolve(), null);
  const undone = await run("undo", () => Promise.resolve(), "before");
  const failed = await run("failure", () => Promise.reject(new Error("boom")), null);
  const late = await run("undo after the commit", () => Promise.resolve(), "after");
  for (const [label, got, want] of [
    ["an untouched window commits once", ok, ["commit"]],
    ["an Undo inside the window commits nothing", undone, []],
    ["a failed delete is reported", failed, ["commit", "failed"]],
    ["an Undo after the commit changes nothing", late, ["commit"]],
  ])
    if (JSON.stringify(got) !== JSON.stringify(want)) fail(`check 51: ${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

  const body = (src, head) => {
    const at = src.indexOf(head);
    if (at === -1) return null;
    let depth = 0;
    for (let i = src.indexOf("{", at); i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
    }
    return null;
  };
  const siteProblems = (src, head, apiCall, scheduler) => {
    const b = body(src, head);
    if (b === null) throw new Error(`could not find \`${head}\``);
    const out = [];
    if (new RegExp(`await\\s+${apiCall}\\(`).test(b)) out.push(`awaits ${apiCall}( in the tap's own path`);
    if (!b.includes(`${scheduler}(`)) out.push(`does not go through ${scheduler}`);
    if (!/action:\s*\{/.test(b) || !/durationMs:\s*UNDO_MS/.test(b)) out.push("its toast carries no Undo action for the whole window");
    return out;
  };
  const tracker = decomment(read("pages/TrackerPage.tsx"));
  const jobs = decomment(read("pages/JobsPage.tsx"));
  const kitPage = decomment(read("pages/KitReviewPage.tsx"));
  const planted = tracker.replace(/function remove\(id: number\) \{/, "async function remove(id: number) {\n    await deleteApplication(id);");
  if (planted === tracker) throw new Error("the probe could not plant a direct delete into TrackerPage's remove");
  if (!siteProblems(planted, "function remove(id: number)", "deleteApplication", "scheduleUndoable").length)
    throw new Error("the site detector passes a remove() that awaits deleteApplication, so it cannot be trusted");
  // The kit's delete moved from the Jobs page's Kits tab to the kit's own page
  // with PLAN 31.4/5; the same three rules hold there.
  for (const [file, src, head, api, scheduler] of [
    ["pages/TrackerPage.tsx", tracker, "function remove(id: number)", "deleteApplication", "scheduleUndoable"],
    ["pages/JobsPage.tsx", jobs, "function deleteHit(id: number)", "deleteJobHistoryItem", "scheduleUndoable"],
    ["pages/KitReviewPage.tsx", kitPage, "function onDelete()", "deleteKit", "removeKitUndoable"],
  ])
    for (const p of siteProblems(src, head, api, scheduler)) fail(`check 51: ${file} \`${head}\` ${p} (PLAN 31.1/6)`);
  const store = decomment(read("state/kitsStore.ts"));
  const undoable = body(store, "export function removeKitUndoable(");
  if (!undoable || !/scheduleUndoable\(\s*\(\)\s*=>\s*deleteKit\(id\)/.test(undoable))
    fail("check 51: state/kitsStore.ts removeKitUndoable must hand deleteKit(id) to scheduleUndoable");
  if (/export\s+async\s+function\s+removeKit\(/.test(store))
    fail("check 51: state/kitsStore.ts still exports removeKit, a delete with no undo window");
  const toastSrc = decomment(read("components/ui/Toast.tsx"));
  if (!/\{t\.action\s*&&/.test(toastSrc) || !/t\.action\?\.onClick\(\)/.test(toastSrc))
    fail("check 51: components/ui/Toast.tsx does not render a toast's action button, so Undo is never offered");
} catch (e) {
  fail(`undo window check (check 51) could not run: ${e.message}`);
}

// ---- 52. the first run is the upload, then one sheet (PLAN 31.5/2) --------- //
// It replaced 31.1/11's "asked once per ACCOUNT": the first-run questions,
// their device record and POST /profile/onboarded are deleted, since the role
// they asked for is on the resume. A new account lands on /app's upload card,
// and once the resume is read ONE sheet says what the app found and asks what
// to do first. Pinned by shape on TailorPage and the sheet:
//   (a) the sheet opens only from the upload card: `firstRun` starts false, its
//       one `setFirstRun(true)` is inside `onFirstParsed`, the upload card's
//       ResumeUpload is handed `onFirstParsed`, and Replace is NOT, so an
//       account that already had a resume never sees it and no record is kept;
//   (b) "Find jobs" searches only from its tap: every `startJobSearch(` in the
//       page is inside `onFirstStep`, and `onFirstStep` is only the sheet's
//       `onChoose` (32(h)'s rule: no search nobody tapped);
//   (c) one page count for two displays: the page's single PageBadge is handed
//       `measured={pageReading}` and the sheet reads `pageReading`, so a change
//       renders the file once, PageBadge's one-mount rule;
//   (d) every literal t("firstRun.*") the sheet reads, through its "tailor"
//       binding, resolves in BOTH tailor.json files (check 8 is parity-only, so
//       a key missing from both is green and renders raw), and it reads no
//       template-literal key, which nothing here could resolve.
// The (a) and (b) detectors are probed both ways on synthetic twins every run.
try {
  const firstRunProblems = (src) => {
    const out = [];
    if (!/\[\s*firstRun\s*,\s*setFirstRun\s*\]\s*=\s*useState\(\s*false\s*\)/.test(src))
      out.push("`firstRun` does not start false");
    const opens = [...src.matchAll(/setFirstRun\(\s*true\s*\)/g)].length;
    let inside = 0;
    try {
      inside = [...fnSource(src, "async function onFirstParsed(").matchAll(/setFirstRun\(\s*true\s*\)/g)].length;
    } catch {
      inside = 0;
    }
    if (opens !== 1 || inside !== 1) out.push("the sheet opens from somewhere other than onFirstParsed alone");
    if (!/<ResumeUpload\s+onParsed=\{\s*onFirstParsed\s*\}/.test(src))
      out.push("the upload card does not hand ResumeUpload onFirstParsed");
    if (/onReplace=\{[^}]*\bonFirstParsed\b/.test(src)) out.push("Replace opens the first-run sheet");
    return out;
  };
  const searchProblems = (src) => {
    const out = [];
    const calls = [...src.matchAll(/\bstartJobSearch\(/g)].length;
    let inStep = 0;
    try {
      inStep = [...fnSource(src, "function onFirstStep(").matchAll(/\bstartJobSearch\(/g)].length;
    } catch {
      inStep = 0;
    }
    if (calls !== inStep) out.push("a search starts outside onFirstStep, on no tap");
    if (!/onChoose=\{\s*onFirstStep\s*\}/.test(src)) out.push("onFirstStep is not the sheet's onChoose");
    if ([...src.matchAll(/\bonFirstStep\b/g)].length !== 2) out.push("onFirstStep is used somewhere other than the sheet");
    return out;
  };

  const page = decomment(read("pages/TailorPage.tsx"));
  for (const p of [...firstRunProblems(page), ...searchProblems(page)]) fail(`check 52: pages/TailorPage.tsx: ${p}`);

  // (c) one measurement, two displays.
  const badges = [...page.matchAll(/<PageBadge\b[^>]*>/g)].map((m) => m[0]);
  if (badges.length !== 1 || !/\bmeasured=\{\s*pageReading\s*\}/.test(badges[0] ?? ""))
    fail(
      `check 52: pages/TailorPage.tsx mounts ${badges.length} PageBadge(s), and its one badge must be handed ` +
        "measured={pageReading}, or the page count is rendered twice for one number.",
    );
  if (!/\bconst\s+pageReading\s*=\s*usePageCount\(/.test(page) || !/\bpages=\{\s*pageReading\.data\?\.pages\b/.test(page))
    fail("check 52: the first-run sheet's page count is not the page's own `pageReading`.");

  // (d) the sheet's copy, in both locales, through its tailor binding.
  const sheet = decomment(read("components/FirstRunSheet.tsx"));
  if (!/const\s*\{\s*t\s*\}\s*=\s*useTranslation\(\s*"tailor"\s*\)/.test(sheet))
    throw new Error('components/FirstRunSheet.tsx no longer binds t to "tailor"; this check reads that binding');
  if (/\bt\(\s*`/.test(sheet))
    fail("check 52: components/FirstRunSheet.tsx reads a template-literal key, which no check resolves; write each one out.");
  const keys = [...new Set([...sheet.matchAll(/\bt\(\s*"((?:firstRun|pages)\.[\w.]+)"/g)].map((m) => m[1]))];
  if (keys.filter((k) => k.startsWith("firstRun.")).length < 9)
    throw new Error(`read only ${keys.length} firstRun.* keys out of components/FirstRunSheet.tsx (expected at least 9)`);
  for (const loc of ["en", "he"]) {
    const bundle = JSON.parse(read(`locales/${loc}/tailor.json`));
    for (const key of keys)
      if (!resolvesIn(bundle, key))
        fail(`check 52: locales/${loc}/tailor.json is missing "${key}" (read by the first-run sheet); it would render raw.`);
  }

  // Both directions on (a) and (b), on the shape that ships.
  const GOOD = [
    "const [firstRun, setFirstRun] = useState(false);",
    "  async function onFirstParsed(r, l) {",
    "    await onParsed(r, l);",
    "    setFirstRun(true);",
    "  }",
    "",
    "  function onFirstStep(step) {",
    "    setFirstRun(false);",
    '    if (step === "jobs") startJobSearch(shown, null);',
    "  }",
    "<ResumeUpload onParsed={onFirstParsed} />",
    "<DocumentPanel onReplace={isMaster ? onParsed : undefined} />",
    "<FirstRunSheet open={firstRun} onChoose={onFirstStep} />",
  ].join("\n");
  if (firstRunProblems(GOOD).length || searchProblems(GOOD).length)
    fail(`check 52's detectors refuse the shape that ships: ${[...firstRunProblems(GOOD), ...searchProblems(GOOD)]}`);
  for (const [label, src, which] of [
    ["a sheet open at mount", GOOD.replace("useState(false)", "useState(true)"), firstRunProblems],
    ["a sheet opened by an effect too", `${GOOD}\nuseEffect(() => setFirstRun(true), []);`, firstRunProblems],
    ["Replace opening it", GOOD.replace("isMaster ? onParsed", "isMaster ? onFirstParsed"), firstRunProblems],
    ["an upload card that never opens it", GOOD.replace("onParsed={onFirstParsed}", "onParsed={onParsed}"), firstRunProblems],
    ["a search on mount", `${GOOD}\nuseEffect(() => startJobSearch(shown, null), []);`, searchProblems],
    ["the step handed to a second control", `${GOOD}\n<Button onClick={() => onFirstStep("jobs")} />`, searchProblems],
  ])
    if (!which(src).length) fail(`check 52's detectors pass ${label}`);
} catch (e) {
  fail(`first-run check (check 52) could not run: ${e.message}`);
}

// ---- 53. the phone header drops nothing it used to hold -------------------- //
// PLAN 31.2/8 and /12, 2026-09-23. Below lg the header is the logo, the uses
// left and the avatar, and the feedback pill is desktop-only. Everything that
// left the phone's header or corner must still be reachable on a phone, or a
// breakpoint quietly deletes a feature: the Menu → the More SHEET the tab bar
// opens, which lists every other destination and is a real dialog (focus in,
// Tab kept, Escape out); language and theme → rows in the account menu; and
// feedback → an account-menu row that opens the same dialog the pill does.
// Each requirement is in force only while its control IS hidden below lg, and
// each "is it hidden" reading must parse one way or the other or the check
// throws, since a detector that stopped matching would pass by never firing.
// The reader is probed on the real file for every requirement in force.
try {
  const layout = decomment(read("layouts/AppLayout.tsx"));
  const pillSrc = decomment(read("components/FeedbackButton.tsx"));
  // Hidden at the base, shown from lg.
  const lgOnly = (cls) => {
    const c = cls.split(/\s+/);
    return c.includes("hidden") && c.some((x) => /^lg:(?:flex|inline-flex|block|grid)$/.test(x));
  };
  if (!lgOnly("relative hidden shrink-0 lg:block") || lgOnly("relative shrink-0") || lgOnly("hidden") ||
      !lgOnly("fixed bottom-4 end-4 z-40 hidden items-center lg:flex"))
    throw new Error("the hidden-below-lg reader misreads its own samples");
  const read53 = (src, pill) => {
    const acct = fnSource(src, "function AccountMenu(");
    const panel = fnSource(src, "function MenuPanel(");
    const shell = fnSource(src, "export default function AppLayout(");
    const out = [];
    const menuCls = /<div\s+ref=\{menuRef\}\s+className="([^"]*)"/.exec(shell);
    if (!menuCls) throw new Error("could not find the header Menu's wrapper (<div ref={menuRef} className=…>)");
    const menuHidden = lgOnly(menuCls[1]);
    if (menuHidden) {
      if (!/onMore=\{toggleMore\}/.test(shell)) out.push("the tab bar's More does not open the More sheet");
      if (!/<MenuPanel\s+sheet\b/.test(shell)) out.push("nothing renders the More sheet (<MenuPanel sheet …>)");
      for (const list of ["moreNav", "toolsSubNav"])
        if (!panel.includes(`${list}.map(`)) out.push(`the menu no longer lists ${list}`);
      const guarded = /\{!sheet && \(([\s\S]*?)\n\s*\)\}/.exec(panel);
      if (guarded && /(?:moreNav|toolsSubNav)\.map\(/.test(guarded[1]))
        out.push("the More sheet hides the other destinations along with the tabs");
      if (!/useDialogFocus\(\s*sheet\s*,/.test(panel)) out.push("the More sheet does not take and hand back focus");
      if (!/e\.key === "Escape"\) setMoreOpen\(false\)/.test(shell)) out.push("Escape does not close the More sheet");
    }
    const toggles = /<div className="([^"]*)">\s*<LanguageSwitch \/>\s*<ThemeToggle \/>\s*<\/div>/.exec(shell);
    const bare = /(?:<UsesLeft \/>|gap-2">)\s*<LanguageSwitch \/>/.test(shell);
    if (!toggles && !bare) throw new Error("could not find the header's LanguageSwitch and ThemeToggle");
    const togglesHidden = !!toggles && lgOnly(toggles[1]);
    if (togglesHidden) {
      if (!/setLanguage\(/.test(acct)) out.push("the account menu has no language row, and the header's switch is hidden below lg");
      if (!/onClick=\{toggleTheme\}/.test(acct)) out.push("the account menu has no theme row, and the header's toggle is hidden below lg");
    }
    const pillCls = /className="([^"]*\bfixed\b[^"]*)"/.exec(pill);
    if (!pillCls) throw new Error("components/FeedbackButton.tsx has no fixed element with a literal className");
    const pillHidden = lgOnly(pillCls[1]);
    if (pillHidden) {
      if (!/onClick=\{onFeedback\}/.test(acct)) out.push("the account menu has no feedback row, and the pill is hidden below lg");
      if (!/onFeedback=\{openFeedback\}/.test(shell) || !/setFeedbackOpen\(true\)/.test(shell))
        out.push("the account menu's feedback row does not open the feedback dialog");
      if (!/<FeedbackButton open=\{feedbackOpen\}/.test(shell))
        out.push("the feedback dialog is not driven by the shell's feedbackOpen");
    }
    return { out, menuHidden, togglesHidden, pillHidden };
  };
  const real = read53(layout, pillSrc);
  for (const [label, inForce, plant] of [
    ["no language row", real.togglesHidden, (s) => s.replace(/onClick=\{\(\) => void setLanguage\([^}]*\}/, "")],
    ["no theme row", real.togglesHidden, (s) => s.replace("onClick={toggleTheme}", "")],
    ["no feedback row", real.pillHidden, (s) => s.replace("onClick={onFeedback}", "")],
    ["More opens nothing", real.menuHidden, (s) => s.replace("onMore={toggleMore}", "onMore={() => {}}")],
    ["no Escape", real.menuHidden, (s) => s.replace('e.key === "Escape") setMoreOpen(false)', 'e.key === "Esc") setMoreOpen(false)')],
    ["the sheet hides the tools", real.menuHidden, (s) => s.replace("{!sheet && (", "{!sheet && (<>{toolsSubNav.map(() => null)}</>) && (")],
  ]) {
    if (!inForce) continue; // that control still shows below lg, so nothing is required of it
    const src = plant(layout);
    if (src === layout) {
      if (real.out.length) continue; // the real file already lacks it; reported below
      throw new Error(`the probe could not plant "${label}" into AppLayout`);
    }
    if (!read53(src, pillSrc).out.length) throw new Error(`the reader passes "${label}", so it cannot be trusted`);
  }
  for (const p of real.out) fail(`check 53: layouts/AppLayout.tsx: ${p} (PLAN 31.2/8, /12)`);
} catch (e) {
  fail(`phone header check (check 53) could not run: ${e.message}`);
}

// ---- 54. an installed JobFinder opens the app, as the same app ------------- //
// PLAN 31.2/11, found in the 2026-09-23 review: the manifest's `start_url` was
// "/", so JobFinder added to a home screen opened on the marketing landing, one
// tap away from the app it was installed for. It opens "/app", the canonical
// document route (CLAUDE.md: never renamed, the extension depends on it). And
// `id` stays "/": without one, the browser derives an installed app's identity
// from `start_url`, so moving it would turn every copy already on a home screen
// into a different app. The route itself must still be declared in App.tsx.
try {
  const manifestPath = path.join(HERE, "..", "public", "manifest.webmanifest");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.start_url !== "/app")
    fail(`check 54: public/manifest.webmanifest start_url is ${JSON.stringify(manifest.start_url)}, not "/app": an installed JobFinder opens somewhere other than the app`);
  if (manifest.id !== "/")
    fail(`check 54: public/manifest.webmanifest id is ${JSON.stringify(manifest.id)}, not "/": every copy already installed (whose identity was "/") becomes a different app`);
  if (!/<Route\s+path="\/app"/.test(read("App.tsx")))
    fail('check 54: App.tsx declares no <Route path="/app">, which the manifest opens');
} catch (e) {
  fail(`installed app check (check 54) could not run: ${e.message}`);
}

// ---- 55. the document toolbar is one row on a phone (PLAN 31.2/1) --------- //
// Measured 2026-09-23 at 390 px: the sticky bar over the paper was 139 px on the
// master and 241 on a tailored draft, four rows and a three-line note. It is one
// row now (51 and 46). Three things keep it there, and one keeps a feature:
// (a) the title YIELDS (`flex-1 basis-0 min-w-0 truncate`), so a long name
// truncates instead of pushing a button onto a second line; (b) the "tap to edit"
// hint lives outside the toolbar, once per device, so no rest state adds a row;
// (c) the save cluster renders nothing at rest; (d) when "Tailor for a different
// job" is hidden below lg on a draft, the tool row's "⋯" still offers it, or a
// phone could no longer re-aim a draft at all. Probed on the real files.
try {
  const readers = (bar, page, editBar) => {
    const out = [];
    const h1 = /<h1\b[^>]*className="([^"]*)"/.exec(bar);
    if (!h1) throw new Error("components/DocumentToolbar.tsx renders no <h1 className=…>");
    for (const c of ["flex-1", "basis-0", "min-w-0", "truncate"])
      if (!h1[1].split(/\s+/).includes(c)) out.push(`DocumentToolbar's title lacks \`${c}\`, so it can push the row's buttons onto a second line`);
    const toolbar = /<DocumentToolbar\b[\s\S]*?\n {6}\/>/.exec(page);
    if (!toolbar) throw new Error("could not find TailorPage's <DocumentToolbar … />");
    if (/t\("edit\.hint"\)/.test(toolbar[0])) out.push("the \"tap to edit\" hint is back inside the toolbar, a row on every visit");
    if (!/!hintSeen\s*&&[\s\S]{0,400}?t\("edit\.hint"\)/.test(page)) out.push("the \"tap to edit\" hint is no longer shown once per device (`!hintSeen`)");
    if (!/if \(save === "idle" && !canUndo\) return null;/.test(editBar)) out.push("ResumeEditBar renders something at rest, which costs the toolbar a row");
    if (/className=\{cn\("shrink-0", result && "hidden lg:inline-flex"\)\}/.test(toolbar[0])) {
      // On the SAME condition that hides the button (`result`), so a ⋯ entry
      // gated on anything else, or switched off, is no way back to it.
      const more = /moreItems=\{\s*result\b[^?]*\?[\s\S]*?t\("overlay\.openDifferent"\)[\s\S]*?setTailorState\(\{ overlayOpen: true \}\)/.test(page);
      if (!more) out.push("\"Tailor for a different job\" is hidden below lg on a draft and nothing under \"⋯\" offers it");
    }
    return out;
  };
  const bar = decomment(read("components/DocumentToolbar.tsx"));
  const page = decomment(read("pages/TailorPage.tsx"));
  const editBar = decomment(read("components/ResumeEditBar.tsx"));
  const real = readers(bar, page, editBar);
  for (const [label, b, pg, e] of [
    ["a title that does not yield", bar.replace("min-w-0 flex-1 basis-0 truncate", "min-w-0 truncate"), page, editBar],
    ["no ⋯ for a different job", bar, page.replace('label: t("overlay.openDifferent"),', 'label: t("overlay.open"),'), editBar],
    ["a save cluster that shows at rest", bar, page, editBar.replace('if (save === "idle" && !canUndo) return null;', 'if (save === "idle" && !canUndo) return <p />;')],
    ["a ⋯ entry switched off", bar, page.replace(/moreItems=\{\s*result && canRun/, "moreItems={\n              false && canRun"), editBar],
  ]) {
    if (b === bar && pg === page && e === editBar) {
      if (real.length) continue; // the real file already has it; reported below
      throw new Error(`the probe could not plant "${label}"`);
    }
    if (!readers(b, pg, e).length) throw new Error(`the reader passes "${label}", so it cannot be trusted`);
  }
  for (const p of real) fail(`check 55: ${p} (PLAN 31.2/1)`);
} catch (e) {
  fail(`one-row toolbar check (check 55) could not run: ${e.message}`);
}

// ---- 56. the draft's action bar: its height is cleared, twice (PLAN 31.2/2) //
// Measured 2026-09-23 at 390 px: Download and the job's status sat about 6,580
// px down a 7,168 px tailored page. They ride a bar on the tab bar now, and its
// height is written in three places that must agree: `BAR_HEIGHT` (which the
// page sets on <html> as `--bottom-bar` while the bar is up), the spacer that
// lets the page's last lines scroll clear of it, and the toast stack's bottom,
// which adds `var(--bottom-bar,0px)` so a toast never covers the buttons that
// raised it. A height changed in one place leaves content, or a toast, under
// the bar. Probed on the real files.
try {
  const read56 = (page, toast) => {
    const out = [];
    const h = /const BAR_HEIGHT = "([\d.]+)rem";/.exec(page);
    if (!h) throw new Error('pages/TailorPage.tsx has no const BAR_HEIGHT = "<n>rem"');
    if (!/<div\b[^>]*role="region"[^>]*className="fixed[^"]*bottom-\[calc\(3\.5rem\+env\(safe-area-inset-bottom\)\)\]/.test(page))
      throw new Error("could not find the action bar (a fixed role=\"region\" on the 3.5rem tab bar)");
    if (!/setProperty\("--bottom-bar", BAR_HEIGHT\)/.test(page)) out.push("the page no longer sets --bottom-bar from BAR_HEIGHT while the bar is up");
    const spacer = /\{barUp && <div aria-hidden className="h-\[([\d.]+)rem\] lg:hidden" \/>\}/.exec(page);
    if (!spacer) out.push("the page has no spacer under the bar, so its last lines stay behind it");
    else if (spacer[1] !== h[1]) out.push(`the spacer is ${spacer[1]}rem and the bar ${h[1]}rem`);
    if (!/bottom-\[calc\(4\.5rem\+var\(--bottom-bar,0px\)\+env\(safe-area-inset-bottom\)\)\]/.test(toast))
      out.push("the toast stack does not add var(--bottom-bar,0px), so a toast covers the bar's buttons");
    return out;
  };
  const page = decomment(read("pages/TailorPage.tsx"));
  const toast = decomment(read("components/ui/Toast.tsx"));
  const real = read56(page, toast);
  for (const [label, pg, ts] of [
    ["a taller bar, the same spacer", page.replace('const BAR_HEIGHT = "3.75rem";', 'const BAR_HEIGHT = "4.25rem";'), toast],
    ["no spacer", page.replace('{barUp && <div aria-hidden className="h-[3.75rem] lg:hidden" />}', ""), toast],
    ["toasts ignore the bar", page, toast.replace("var(--bottom-bar,0px)+", "")],
  ]) {
    if (pg === page && ts === toast) {
      if (real.length) continue;
      throw new Error(`the probe could not plant "${label}"`);
    }
    if (!read56(pg, ts).length) throw new Error(`the reader passes "${label}", so it cannot be trusted`);
  }
  for (const p of real) fail(`check 56: ${p} (PLAN 31.2/2)`);
} catch (e) {
  fail(`action bar clearance check (check 56) could not run: ${e.message}`);
}

// ---- 57. a compact job row keeps every door, and its "⋯" is on top ------------ //
// PLAN 31.2/5 and /6, 2026-09-23. A search result was about 700 px at 390 (a ring,
// three numbers, five chips, five stacked buttons): one job per screen. It is a
// compact row now, three per screen, and what left it went under "⋯" until the
// job page (31.4) exists: the kit, the outreach, the brief, the posting and the
// share, and on a History row Remove. Two things are pinned: (a) every one of
// those entries is still in each row's list, and (b) the list is PORTALLED to
// <body>, because inside the row it opened BEHIND the next card (each card's
// entry animation is a stacking context; measured, not reasoned). And (c) on the
// Jobs page, "Tailor my top matches" sits BELOW the results and only when a job
// can clear its lowest bar: above them it stood between the user and the jobs,
// with a disabled "Tailor 0 matches" on a weak search. Probed on the real files.
try {
  const keysOf = (src, head) => {
    const body = fnSource(src, head);
    const list = /const more: MoreItem\[\] = \[([\s\S]*?)\n  \];/.exec(body);
    if (!list) throw new Error(`could not find \`const more: MoreItem[]\` in ${head}`);
    return new Set([...list[1].matchAll(/\bkey:\s*"(\w+)"/g)].map((m) => m[1]));
  };
  const read57 = (cards, menu, jobs) => {
    const out = [];
    for (const [head, want] of [
      ["export function MatchCard(", ["kit", "outreach", "brief", "open", "share"]],
      ["export function HistoryRow(", ["outreach", "brief", "open", "share", "remove"]],
    ]) {
      const have = keysOf(cards, head);
      for (const k of want) if (!have.has(k)) out.push(`${head.replace("export function ", "").replace("(", "")}'s "⋯" lost its "${k}" entry, a door the row had before it was compacted`);
    }
    // The TARGET, after the list's closing tag: the list's own `dir` also
    // reads document.body, and a looser reader passed a portal aimed elsewhere.
    if (!/createPortal\([\s\S]*?<\/div>,\s*document\.body,?\s*\)/.test(menu))
      out.push("MoreMenu's list is not portalled to document.body, so it opens behind the next card");
    const list = jobs.indexOf("visible(sortedMatches).map(");
    const batch = jobs.indexOf("<BatchTailorCard");
    if (list === -1 || batch === -1) throw new Error("could not find the results list or <BatchTailorCard> in JobsPage");
    if (batch < list) out.push("\"Tailor my top matches\" is above the results again");
    if (!/KIT_THRESHOLDS\[0\][\s\S]{0,200}?<BatchTailorCard/.test(jobs))
      out.push("\"Tailor my top matches\" shows when no job can clear its lowest bar (\"Tailor 0 matches\")");
    return out;
  };
  const cards = decomment(read("pages/jobs/cards.tsx"));
  const menu = decomment(read("components/ui/MoreMenu.tsx"));
  const jobs = decomment(read("pages/JobsPage.tsx"));
  const real = read57(cards, menu, jobs);
  for (const [label, c, m, j] of [
    ["the kit entry dropped", cards.replace('? [{ key: "kit", label:', '? [{ key: "kitx", label:'), menu, jobs],
    ["History's remove dropped", cards.replace('{ key: "remove", label:', '{ key: "removed", label:'), menu, jobs],
    ["the list back inside the row", cards, menu.replace("document.body,", "ref.current as HTMLElement,"), jobs],
    ["no bar on the batch card", cards, menu, jobs.replace("Math.round(m.overall) >= KIT_THRESHOLDS[0]", "Math.round(m.overall) >= 0")],
  ]) {
    if (c === cards && m === menu && j === jobs) {
      if (real.length) continue;
      throw new Error(`the probe could not plant "${label}"`);
    }
    if (!read57(c, m, j).length) throw new Error(`the reader passes "${label}", so it cannot be trusted`);
  }
  for (const p of real) fail(`check 57: ${p} (PLAN 31.2/5, /6)`);
} catch (e) {
  fail(`compact job row check (check 57) could not run: ${e.message}`);
}

// ---- 58. the tracker is a list on a phone, sorted honestly (EXECUTED) ------- //
// PLAN 31.2/7, 2026-09-23. At 390 px five counters and two rings filled the first
// screen and the board's first column started at y = 609 of 664; the columns
// were swiped sideways, one per screen, each card carrying its status twice (a
// chip and a full-width select). Below md it is status tabs over one list now
// (the list at y = 290), and the rings are on Analytics. (a) EXECUTES
// lib/trackerSort.ts: "Date applied" puts every dated row before every row with
// no applied date (unknown is not early, the house rule), newest first on both
// sides; "Match" orders by score; "Newest" by the day it was added. (b) Pins by
// shape: ONE of board and list is mounted (`boardFits ? … : …`), because both
// render each card and the board's layoutId glide and the split-flap's pending
// flip each assume one copy; the status is one chip with a labelled native
// select over it; no full-width select is left; and the rings are on Analytics,
// not on the board. The shape reader is probed on the real file.
try {
  const ts = runProbeBundle("tracker-sort", `export * from "./lib/trackerSort";\n`);
  if (typeof ts.sortApps !== "function") throw new Error("lib/trackerSort.ts exports no sortApps");
  const app = (id, created, applied, score) => ({ id, created_at: created, applied_at: applied, overall_score: score });
  const rows = [
    app(1, "2026-09-01", null, 50),
    app(2, "2026-09-05", "2026-09-06", 90),
    app(3, "2026-09-10", null, 70),
    app(4, "2026-08-20", "2026-09-08", 0),
    app(5, "2026-09-02", undefined, 60),
  ];
  const ids = (by) => ts.sortApps(rows, by).map((r) => r.id).join(",");
  for (const [by, want, why] of [
    ["applied", "4,2,3,5,1", "every dated row before every undated one, newest applied first, then the undated newest-added first"],
    ["match", "2,3,5,1,4", "by score, highest first"],
    ["newest", "3,2,5,1,4", "by the day it was added, newest first"],
  ])
    if (ids(by) !== want) fail(`check 58: sortApps(…, "${by}") gives ${ids(by)}, not ${want} (${why})`);
  if (rows.map((r) => r.id).join(",") !== "1,2,3,4,5") fail("check 58: sortApps sorted its input in place");

  const read58 = (page, analytics) => {
    const out = [];
    if (!/\bboardFits \? \(/.test(page)) out.push("the board and the phone list are no longer one-or-the-other (`boardFits ? … : …`)");
    if (!/<select\s+value=\{a\.status\}\s+aria-label=\{t\("statusLabel"\)\}/.test(page))
      out.push("the status chip has no labelled select over it");
    if (/<select[^>]*className="w-full[^"]*"/.test(page)) out.push("a full-width status select is back under the card");
    if (/<ProgressRing\b/.test(page)) out.push("a ring is back on the board");
    if ((analytics.match(/<ProgressRing\b/g) || []).length < 2) out.push("the response and interview rings are not on Analytics");
    return out;
  };
  const page = decomment(read("pages/TrackerPage.tsx"));
  const analytics = decomment(read("components/TrackerAnalytics.tsx"));
  const real = read58(page, analytics);
  for (const [label, pg, an] of [
    ["both mounted", page.replace("boardFits ? (", "true ? ("), analytics],
    ["an unlabelled chip", page.replace('aria-label={t("statusLabel")}\n', "\n"), analytics],
    ["the rings gone from Analytics", page, analytics.replace(/<ProgressRing\b/g, "<Ring")],
  ]) {
    if (pg === page && an === analytics) {
      if (real.length) continue;
      throw new Error(`the probe could not plant "${label}"`);
    }
    if (!read58(pg, an).length) throw new Error(`the reader passes "${label}", so it cannot be trusted`);
  }
  for (const p of real) fail(`check 58: ${p} (PLAN 31.2/7)`);
} catch (e) {
  fail(`tracker list check (check 58) could not run: ${e.message}`);
}

// ---- 59. the saved-job sheet, and a posting that folds only when true -------- //
// PLAN 31.2/9, 2026-09-23. "Use a job you saved" opened an inline list below the
// fold on Interview; below lg it is a bottom sheet now. It also lives INSIDE the
// tailor dialog, whose Modal closes on any Escape it hears on window, so the
// sheet must take Escape in the CAPTURE phase and stop it there, or closing the
// sheet also throws away a half-pasted posting (driven: the dialog stays open).
// And the pasted posting folds to one line once a result for it is on screen
// (the fit reading sat under a 240 px box), but ONLY while the box still holds
// the text that was analysed: a fold over edited text would hide what the user
// is about to send. Both callers are held to that gate. Probed on the real files.
try {
  const read59 = (paste, overlay, interview) => {
    const out = [];
    if (!/addEventListener\("keydown", onKey, true\)/.test(paste) || !/e\.stopPropagation\(\);\s*setPicking\(false\)/.test(paste))
      out.push("JDPaste's sheet no longer takes Escape in the capture phase and stops it, so it closes the dialog around it too");
    if (!/createPortal\([\s\S]*?role="dialog"[\s\S]*?document\.body/.test(paste)) out.push("JDPaste's saved-job sheet is not portalled");
    // Since PLAN 31.3/1 the reading is the page's (`cached`) or one held in the
    // dialog beside a draft (`heldHere`), and each is for this very text.
    if (!/folded=\{reading \?/.test(overlay)) out.push("TailorOverlay folds the posting without a reading for this very text (`reading`)");
    if (!/const reading = cached \? fit : heldHere \? held\.fit : null;/.test(overlay)) out.push("TailorOverlay's `reading` is not the page's reading or the held one, and nothing else");
    if (!/const heldHere = hasResult && held !== null && held\.text === draft\.trim\(\);/.test(overlay)) out.push("TailorOverlay shows a held reading for a text other than the one in the box");
    if (!/analyzedFor === jdText\s*\?/.test(interview)) out.push("InterviewPage folds the posting without checking it is still the analysed text");
    return out;
  };
  const paste = decomment(read("components/JDPaste.tsx"));
  const overlay = decomment(read("components/TailorOverlay.tsx"));
  const interview = decomment(read("pages/InterviewPage.tsx"));
  const real = read59(paste, overlay, interview);
  for (const [label, pa, ov, iv] of [
    ["a bubbling Escape", paste.replace('addEventListener("keydown", onKey, true)', 'addEventListener("keydown", onKey)'), overlay, interview],
    ["a fold on any fit", paste, overlay.replace("folded={reading ?", "folded={fit ?"), interview],
    ["a held reading for any text", paste, overlay.replace("held.text === draft.trim()", "true"), interview],
    ["a fold on any questions", paste, overlay, interview.replace("analyzedFor === jdText\n", "true\n")],
  ]) {
    if (pa === paste && ov === overlay && iv === interview) {
      if (real.length) continue;
      throw new Error(`the probe could not plant "${label}"`);
    }
    if (!read59(pa, ov, iv).length) throw new Error(`the reader passes "${label}", so it cannot be trusted`);
  }
  for (const p of real) fail(`check 59: ${p} (PLAN 31.2/9)`);
} catch (e) {
  fail(`saved-job sheet check (check 59) could not run: ${e.message}`);
}

// ---- 60. the real PDF on a phone is pictures of the real file (PLAN 31.2/4) --- //
// Phone browsers do not draw a `blob:` PDF inside a page, so below sm "The real
// PDF" said so and offered Open and Download: the one view whose job is "this is
// really your file" showed nothing of it. It shows PDFium's pictures of the same
// bytes now (`POST /render/pages`, deterministic and free, smoke-pinned). This
// holds the wiring: the client posts to the route `routes.py` mounts, and the
// panel fetches the pictures exactly when it does NOT frame the PDF, and the
// frame exactly when it does, so a phone is never back to a sentence.
try {
  const client = decomment(read("api/client.ts"));
  if (!/\bapi\.post<PageImagesResult>\(\s*"\/render\/pages"/.test(fnSource(client, "export async function renderPages(")))
    fail('check 60: api/client.ts renderPages does not POST "/render/pages"');
  const routes = pySource("app/api/routes.py", "check 60");
  if (routes !== null && !/^@router\.post\(\s*"\/render\/pages"/m.test(routes))
    fail('check 60: backend/app/api/routes.py mounts no POST "/render/pages", which renderPages calls');
  const read60 = (panel) => {
    const out = [];
    if (!/usePdfPreview\(resume, template, view === "file" && framesPdf\)/.test(panel)) out.push("the PDF frame is not fetched on the frame's own condition (`framesPdf`)");
    if (!/usePageImages\(resume, template, view === "file" && !framesPdf\)/.test(panel)) out.push("the page pictures are not fetched when the PDF cannot be framed (`!framesPdf`)");
    if (!/<img\b[^>]*src=\{`data:image\/png;base64,\$\{png\}`\}/.test(panel)) out.push("the phone's file view draws no page pictures");
    if (/doc\.file\.mobile/.test(panel)) out.push("the phone's file view still says it cannot show the PDF");
    return out;
  };
  const panel = decomment(read("components/DocumentPanel.tsx"));
  const real = read60(panel);
  for (const [label, pl] of [
    ["no pictures on a phone", panel.replace('usePageImages(resume, template, view === "file" && !framesPdf)', 'usePageImages(resume, template, false)')],
    ["both fetched", panel.replace('usePdfPreview(resume, template, view === "file" && framesPdf)', 'usePdfPreview(resume, template, view === "file")')],
  ]) {
    if (pl === panel) {
      if (real.length) continue;
      throw new Error(`the probe could not plant "${label}"`);
    }
    if (!read60(pl).length) throw new Error(`the reader passes "${label}", so it cannot be trusted`);
  }
  for (const p of real) fail(`check 60: components/DocumentPanel.tsx: ${p} (PLAN 31.2/4)`);
} catch (e) {
  fail(`phone PDF pictures check (check 60) could not run: ${e.message}`);
}

// ---- 61. a job's draft is saved on that job's row, and only there (EXECUTED) //
// PLAN 31.3/4, owner decision 2: a finished tailor creates or updates the job's
// tracker row in Saved WITH the draft, and every later change updates it. The
// defect pinned here is the one the saver is built around: a change made for
// one job landing on ANOTHER job's row, which files a CV tailored for job B
// under the application for job A, the record the user sends from. So (a)
// EXECUTES the real store with the API stubbed and every POST and PUT recorded:
// three tailors, a change waiting out the pause when a new target arrives, and
// a new master. Each reset that clears `savedAppId` must move the saver to a new
// row and first send a waiting change to the row it was typed for; a re-tailor
// of the SAME posting keeps its row; an unchanged draft sends nothing. (b) pins
// the page by shape: the draft is saved whenever it changes, a hand-edited
// draft carries an UNKNOWN fabrication count (23.7's rule, which moved here
// from `sentSignals`), and "Saved" is said only once the row has answered.
// Probed with the store's own source mutated, and the page's.
try {
  const storeSrc = read("state/tailorStore.ts");
  const R61 = { contact: { name: "Probe" }, summary: "Probe summary.", experience: [], education: [], skills: [] };
  const draftRun = async (src) => {
    const calls = [];
    let nextId = 1;
    const st = runProbeBundle("draft-rows", src, {
      "../api/client": {
        analyzeJD: async () => ({ language: "en", job_title: "Probe", company: "Probe Co" }),
        getMasterResume: async () => null,
        saveMasterResume: async () => ({ resume: R61, label: "" }),
        tailor: async () => ({ tailored_resume: R61, fabrication_flags: [], score_after: { overall: 50 } }),
        // The store tailors over the stream since PLAN 31.3/2.
        tailorStream: async () => ({ tailored_resume: R61, fabrication_flags: [], score_after: { overall: 50 } }),
        saveApplication: async (p) => {
          const id = nextId++;
          calls.push(`POST:${id}:${p.jd_text}`);
          return { id };
        },
        saveApplicationDraft: async (id, d) => {
          calls.push(`PUT:${id}:${d.template}`);
          return { id };
        },
      },
      "../hooks/useMasterResume": { resetMasterCache: () => {} },
      "../lib/apiError": { apiErrorMessage: (_e, f) => f },
      "../lib/draft": { clearDraft: () => {}, writeDraft: () => {}, sameResume: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
      "../lib/lang": { resumeLanguage: () => "en" },
      // PLAN 31.6/2: the master's autosave.
      "../lib/dataCache": { invalidateData: () => {} },
      "../lib/masterLabel": { masterResumeLabel: () => "Probe's resume" },
      // PLAN 31.4/4: `openSavedReview` keeps a restored template only when this build knows it.
      "../lib/templateSpecs": { TEMPLATE_IDS: ["standard", "classic", "executive", "modern"] },
    });
    for (const name of ["syncDraft", "settleDraft", "flushDraftSave", "startTailor", "setTargetJob", "adoptMaster", "setTailorState", "getTailorState"])
      if (typeof st[name] !== "function") throw new Error(`state/tailorStore.ts does not export ${name}`);
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const snap = (posting, template) => ({
      draft: { tailored_resume: R61, template, voice_score: null, fabrication_flag_count: null, overall_score: 50 },
      job: { job_title: "T", company: "C", jd_text: posting },
    });
    const tailorFor = async (posting) => {
      st.setTailorState({ jdText: posting });
      st.startTailor();
      for (let i = 0; i < 10 && st.getTailorState().loading; i++) await tick();
      if (!st.getTailorState().result) throw new Error(`the stubbed tailor for "${posting}" never finished`);
    };
    st.setTailorState({ resume: R61 });
    await tailorFor("Posting A");
    await st.syncDraft(snap("Posting A", "standard")); // the row is made
    await st.syncDraft(snap("Posting A", "executive"), true); // a change
    await st.syncDraft(snap("Posting A", "executive"), true); // unchanged: nothing is sent
    await tailorFor("Posting A"); // the same posting again keeps the row
    await st.syncDraft(snap("Posting A", "classic"), true);
    await tailorFor("Posting B"); // another posting: a row of its own
    await st.syncDraft(snap("Posting B", "standard"));
    void st.syncDraft(snap("Posting B", "modern")); // waiting out the pause...
    st.setTargetJob("check-61-nav", { jdText: "Posting C" }); // ...when a new target arrives
    await st.syncDraft(snap("Posting C", "standard"));
    st.adoptMaster({ resume: R61, ledger: null, label: "", language: "en", updated_at: "" });
    await st.syncDraft(snap("Posting C", "standard"));
    st.flushDraftSave();
    await st.settleDraft();
    return calls.join(" ");
  };
  const WANT61 =
    "POST:1:Posting A PUT:1:executive PUT:1:classic POST:2:Posting B PUT:2:modern POST:3:Posting C POST:4:Posting C";
  const real = await draftRun(storeSrc);
  for (const [label, mutated] of [
    ["a new target that does not move the row", storeSrc.replace(/(consumedNavKey = navKey;\s*)(?:\/\/[^\n]*\n\s*)*newDraftRow\(\);/, "$1")],
    ["a re-tailor that keeps the row for any posting", storeSrc.replace("state.savedAppId !== null && state.savedFor === jdText.trim()", "state.savedAppId !== null")],
  ]) {
    if (mutated === storeSrc) {
      if (real !== WANT61) continue; // the real store already fails; reported below
      throw new Error(`the probe could not plant "${label}"`);
    }
    if ((await draftRun(mutated)) === WANT61) throw new Error(`the run passes "${label}", so it cannot be trusted`);
  }
  if (real !== WANT61)
    fail(
      `check 61: state/tailorStore.ts wrote [${real}] where [${WANT61}] is right. A draft saved with its job must ` +
        "reach that job's row and no other: a new posting, a new target and a new master each get a row of their " +
        "own, a change still waiting goes to the row it was typed for, the same posting keeps its row, and an " +
        "unchanged draft sends nothing (PLAN 31.3/4)",
    );

  const read61 = (pg) => {
    const out = [];
    if (!/useEffect\(\(\) => \{\s*if \(draftSnap\) void syncDraft\(draftSnap\)[^;]*;\s*\}, \[draftSnap\b/.test(pg))
      out.push("no effect saves the draft whenever it changes (`syncDraft(draftSnap)`, keyed on `draftSnap`)");
    if (!/fabrication_flag_count: overrideCount > 0 \? null : result\.fabrication_flags\.length/.test(pg))
      out.push("the draft saved after a hand-edit carries the AI version's fabrication count instead of unknown (null)");
    for (const [key, gate] of [
      ["jobDraft.saved", /draftSave === "saved" \? \(\s*<>\s*<span[^>]*>✓ \{t\("jobDraft\.saved"\)\}/],
      ["bar.saved", /draftSave === "saved" \? \(\s*<span[^>]*>✓ \{t\("bar\.saved"\)\}/],
      ["save.saved", /draftSave === "saved" \? t\("save\.saved"\)/],
    ]) {
      const uses = pg.split(`t("${key}")`).length - 1;
      if (uses !== 1 || !gate.test(pg))
        out.push(`t("${key}") is said ${uses === 1 ? "without" : `${uses} times, not once, behind`} the \`draftSave === "saved"\` gate, so the page can call a draft saved before the row has it`);
    }
    return out;
  };
  const page61 = decomment(read("pages/TailorPage.tsx"));
  const realPage = read61(page61);
  for (const [label, pg] of [
    ["a draft never saved", page61.replace("if (draftSnap) void syncDraft(draftSnap)", "if (false) void syncDraft(draftSnap)")],
    ["a known count over typed text", page61.replace("overrideCount > 0 ? null : result.fabrication_flags.length", "result.fabrication_flags.length")],
    ["an ungated Saved", page61.replace(/draftSave === "saved" \? \(\s*<>/, "true ? (\n<>")],
  ]) {
    if (pg === page61) {
      if (realPage.length) continue;
      throw new Error(`the probe could not plant "${label}"`);
    }
    if (!read61(pg).length) throw new Error(`the reader passes "${label}", so it cannot be trusted`);
  }
  for (const p of realPage) fail(`check 61: pages/TailorPage.tsx: ${p} (PLAN 31.3/4)`);
} catch (e) {
  fail(`draft-with-its-job check (check 61) could not run: ${e.message}`);
}

// ---- 62. a tailored draft is the document and one line; its claims are one answer (EXECUTED) //
// PLAN 31.3/3. The draft page was the document and then four cards for about
// 7,000 px, saying the keywords three times and the claims twice. It is the
// document and one summary line now, and the rest is the drawer's "Changes"
// pane. Three things keep it that way. (a) "N claims to check" over the paper
// and the flag rows inside the drawer are ONE reading, `flagStates` in
// lib/resumeDiff: EXECUTED here over the cases its contract names (on the
// document, typed away, declined, carried by no change, an unreadable
// document), and both callers must use it, never a copy. (b) The change list,
// the keyword report and the voice check render only inside the pane's content,
// so a card re-added under the paper goes red; and since PLAN 31.4/4 the letter
// is on no part of this page at all (the job's own page is its one writer), the
// pane pointing there instead. (c) The line
// never says "No new claims found" about lines the user typed, which the guard
// never read. Probed with resumeDiff mutated, a card planted, and the claims
// chain reordered.
try {
  const diffSrc = read("lib/resumeDiff.ts");
  const R62 = (summary) => ({
    contact: { name: "", email: "", phone: "", location: "", linkedin: "", website: "" },
    headline: "",
    summary,
    experience: [],
    education: [],
    skills: [],
    certifications: [],
    projects: [],
    languages: [],
    military_service: [],
  });
  const flag = (value) => ({ category: "number", value, detail: "" });
  const edit = { id: "summary", kind: "edited", section: "summary", context: "", before: "Led a team.", after: "Led a team of 12 engineers." };
  const run62 = (src) => {
    const mod = runProbeBundle("flag-states", src.replace(/from "\.\/(keywords|resumeBlocks)"/g, 'from "./lib/$1"'));
    if (typeof mod.flagStates !== "function") throw new Error("lib/resumeDiff.ts does not export flagStates");
    const one = (flags, anchored, effective) => mod.flagStates(flags, [edit], anchored, effective).map((s) => s.resolved);
    const out = [];
    const want = (label, got, expected) => {
      if (JSON.stringify(got) !== JSON.stringify(expected)) out.push(`${label}: resolved ${JSON.stringify(got)}, not ${JSON.stringify(expected)}`);
    };
    want("a flagged number still on the line it was put on", one([flag("12")], { summary: "@summary" }, R62("Led a team of 12 engineers.")), [false]);
    want("the number typed away by the user", one([flag("12")], { summary: "@summary" }, R62("Led a team of engineers.")), [true]);
    want("the change declined (its block is off the page)", one([flag("12")], {}, R62("Led a team.")), [true]);
    want("a flag no change carries (silence is not a clearance)", one([flag("99")], { summary: "@summary" }, R62("Led a team of 12 engineers.")), [false]);
    want("a document that cannot be read", one([flag("12")], { summary: "@summary" }, null), [false]);
    return out;
  };
  const real = run62(diffSrc);
  for (const [label, src] of [
    ["a reading that ignores the document", diffSrc.replace(/!editValueOnDocument\([^)]*\)/, "true")],
    ["a flag no change carries counted as resolved", diffSrc.replace("carriers.length > 0 && carriers.every", "carriers.every")],
  ]) {
    if (src === diffSrc) {
      if (real.length) continue;
      throw new Error(`the probe could not plant "${label}"`);
    }
    if (!run62(src).length) throw new Error(`the run passes "${label}", so it cannot be trusted`);
  }
  for (const p of real) fail(`check 62: lib/resumeDiff.ts flagStates, ${p} (PLAN 31.3/3)`);

  // Both callers read that function, never their own copy of it.
  const log = decomment(read("components/ChangeLog.tsx"));
  const page = decomment(read("pages/TailorPage.tsx"));
  if (!/\bflagStates\(/.test(log) || /\bblockSubtreeContainsValue\(/.test(log))
    fail("check 62: components/ChangeLog.tsx does not read the flag rows through flagStates, so the drawer and the summary can disagree about the claims");
  if (!/\bconst flagView = useMemo\(\s*\(\) => \(result \? flagStates\(/.test(page))
    fail("check 62: pages/TailorPage.tsx does not count the summary's claims through flagStates, so the line over the paper can disagree with the drawer");

  // (b) the cards live in the pane, and only there
  const read62b = (src) => {
    const at = src.indexOf("const reviewPane =");
    const end = at === -1 ? -1 : src.indexOf(": undefined;", at);
    if (at === -1 || end === -1) throw new Error("could not find TailorPage's `const reviewPane = … : undefined;`");
    const pane = src.slice(at, end);
    const out = [];
    for (const tag of ["<ChangeLog", "<MatchReport", "<VoicePanel", "<LeftOut"]) {
      const all = src.split(tag).length - 1;
      const inPane = pane.split(tag).length - 1;
      if (inPane !== 1) out.push(`${tag}> is ${inPane ? `in the drawer pane ${inPane} times` : "not in the drawer pane"}`);
      if (all !== inPane) out.push(`${tag}> is rendered outside the drawer pane too, under the paper`);
    }
    // PLAN 31.4/4: the letter left this page for the job's own page, its one
    // writer, and the pane points there instead (a letter written from this
    // page's memory could overwrite a newer one written on the job's page).
    if (src.includes("<CoverLetter")) out.push("<CoverLetter> is on the tailor page again; the job's page is the letter's one writer");
    if (!/to=\{`\/applications\/\$\{savedAppId\}`\}/.test(pane)) out.push("the drawer pane does not point to the job's page for the letter");
    return out;
  };
  const realB = read62b(page);
  // Planted where a card would go back: beside the document. `decomment`
  // strips JSX comments, so the anchor is code.
  const plantedB = page.replace("<DocumentPanel", '<MatchReport bare gaps={[]} jdText="" />\n<DocumentPanel');
  if (plantedB === page) {
    if (!realB.length) throw new Error("the card probe could not plant a report under the paper");
  } else if (!read62b(plantedB).length) throw new Error("the reader passes a keyword report planted on the page, so it cannot be trusted");
  for (const p of realB) fail(`check 62: pages/TailorPage.tsx: ${p} (PLAN 31.3/3: the page is the document and one line)`);

  // (c) no "No new claims found" over lines the user typed
  const summary = decomment(read("components/DraftSummary.tsx"));
  const read62c = (src, pg) => {
    const out = [];
    const chain = /claimsOpen > 0\s*\?[\s\S]*?:\s*claimsRaised > 0\s*\?[\s\S]*?:\s*typed > 0\s*\?\s*t\("review\.summary\.noClaimsTyped"\)\s*:\s*t\("review\.summary\.noClaims"\)/;
    if (!chain.test(src)) out.push("components/DraftSummary.tsx can say review.summary.noClaims while the user has typed lines the guard never read");
    if (!/<DraftSummary\b[\s\S]*?\btyped=\{overrideCount\}/.test(pg)) out.push("pages/TailorPage.tsx does not pass typed={overrideCount} to DraftSummary");
    return out;
  };
  const realC = read62c(summary, page);
  const plantedC = summary.replace(/typed > 0\s*\?\s*t\("review\.summary\.noClaimsTyped"\)\s*:\s*t\("review\.summary\.noClaims"\)/, 't("review.summary.noClaims")');
  if (plantedC === summary) {
    if (!realC.length) throw new Error("the claims probe could not plant the unguarded sentence");
  } else if (!read62c(plantedC, page).length) throw new Error("the reader passes an unguarded 'No new claims found', so it cannot be trusted");
  for (const p of realC) fail(`check 62: ${p} (PLAN 31.3/3)`);
} catch (e) {
  fail(`tailored-draft summary check (check 62) could not run: ${e.message}`);
}

// ---- 63. one way in: check the fit, then tailor, for one use (PLAN 31.3/1) ---- //
// The tailor dialog offered "Check fit" OR "Tailor my resume" side by side, a
// choice the user could not make yet: both spent a use, and the only difference
// was whether they saw the match first. It is one path now: the fit check is
// step one, and with its reading up "Tailor my resume — included" is step two,
// still one use in all because the check includes the tailor of the posting it
// read (Phase 30 / B4.4). Two things keep that true. (a) The dialog never
// offers both at once: Check fit renders only while there is no reading for the
// text in the box, and the Tailor button only in the branch where there is.
// (b) A reading taken beside a draft is held in the dialog, and the page makes
// it the posting's reading BEFORE `startTailor` runs, the same four fields
// `onChecked` writes; without that the tailor analyses the posting again, misses
// the ride, and spends a second use while the button says "included".
try {
  const overlay63 = decomment(read("components/TailorOverlay.tsx"));
  const page63 = decomment(read("pages/TailorPage.tsx"));
  const read63 = (ov, pg) => {
    const out = [];
    const step = /\{!reading \? \(\s*<Button\b[\s\S]{0,200}?onClick=\{run\}[\s\S]*?\) : /.exec(ov);
    if (!step) out.push("TailorOverlay offers Check fit other than as the one step before a reading (`!reading ? (<Button … onClick={run}>) : …`)");
    else {
      const before = ov.slice(0, step.index);
      const inStep = step[0];
      if (/onTailor\(/.test(before) || /onTailor\(/.test(inStep))
        out.push("TailorOverlay can tailor before there is a reading for the text in the box");
      if ((ov.match(/onClick=\{run\}/g) || []).length !== 1)
        out.push("TailorOverlay starts a fit check from more than the one step");
    }
    const handler = /onTailor=\{\(text, held\) => \{([\s\S]*?)\n\s*\}\}/.exec(pg);
    if (!handler) out.push("pages/TailorPage.tsx's onTailor does not take the held reading (`(text, held) => {…}`)");
    else {
      const body = handler[1];
      const adopt = body.search(/\.\.\.\(held \? \{ jd: held\.fit\.jd, fit: held\.fit, checkedFor: text, fitScoredAt: held\.at \} : \{\}\)/);
      const start = body.indexOf("startTailor()");
      if (adopt === -1) out.push("pages/TailorPage.tsx's onTailor does not make a held reading the posting's reading (jd, fit, checkedFor, fitScoredAt)");
      else if (start === -1 || start < adopt) out.push("pages/TailorPage.tsx's onTailor starts the tailor before adopting the held reading");
    }
    return out;
  };
  const real63 = read63(overlay63, page63);
  for (const [label, ov, pg] of [
    ["both buttons at once", overlay63.replace("{!reading ? (", "{true ? ("), page63],
    ["a tailor that ignores the held reading", overlay63, page63.replace(/\.\.\.\(held \? \{ jd: held\.fit\.jd, fit: held\.fit, checkedFor: text, fitScoredAt: held\.at \} : \{\}\),?/, "")],
  ]) {
    if (ov === overlay63 && pg === page63) {
      if (real63.length) continue;
      throw new Error(`the probe could not plant "${label}"`);
    }
    if (!read63(ov, pg).length) throw new Error(`the reader passes "${label}", so it cannot be trusted`);
  }
  for (const p of real63) fail(`check 63: ${p} (PLAN 31.3/1)`);
} catch (e) {
  fail(`one-way-in check (check 63) could not run: ${e.message}`);
}

// ---- 64. the tailor's progress is the pipeline's own report (EXECUTED) ------- //
// PLAN 31.3/2. A tailor takes about 20 s, and the page showed two grey skeletons
// for all of it, below the document. It shows the five stages the pipeline
// reports over `POST /tailor/stream` now, and the house rule is the one
// `ScanPanel` keeps for the boards: never animate progress that is not being
// measured. (a) ONE list of stages: `lib/tailorStages.ts` must equal
// `TAILOR_STAGES` in backend/app/core/tailor.py, the order the pipeline calls
// `progress` in (smoke drives the stream and checks the frames arrive in it).
// (b) EXECUTES `stageStates`: a stage is active only once reported, done only
// once a later one is, pending otherwise, and a stage name the page does not
// know is ignored. (c) Every stage has a label in both locales. (d) The panel is
// fed the store's reported list and reads no clock. Probed with the mirror
// reordered, a state that guesses, and a timer in the panel.
try {
  const ts64 = read("lib/tailorStages.ts");
  const tsList = (src) => {
    const m = /export const TAILOR_STAGES = \[([^\]]*)\] as const;/.exec(src);
    if (!m) throw new Error("could not find `export const TAILOR_STAGES = [...] as const;` in lib/tailorStages.ts");
    return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  };
  const py64 = pySource("app/core/tailor.py", "check 64");
  if (py64 !== null) {
    const pm = /^TAILOR_STAGES = \(([^)]*)\)/m.exec(py64);
    if (!pm) throw new Error("could not find `TAILOR_STAGES = (...)` in backend/app/core/tailor.py");
    const pyList = [...pm[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    const same = (a) => JSON.stringify(a) === JSON.stringify(pyList);
    if (pyList.length < 5) throw new Error(`parsed only ${pyList.length} stages out of tailor.py`);
    if (!same(tsList(ts64)))
      fail(`check 64: lib/tailorStages.ts lists [${tsList(ts64)}] where the pipeline reports [${pyList}] (PLAN 31.3/2)`);
    const reordered = ts64.replace(/\[([^\]]*)\] as const/, (_m, body) => `[${body.split(",").reverse().join(",")}] as const`);
    if (reordered === ts64) throw new Error("the mirror probe could not plant a reordered list");
    if (same(tsList(reordered))) throw new Error("the mirror reader passes a reordered list, so it cannot be trusted");
  }

  const run64 = (src) => {
    const mod = runProbeBundle("tailor-stages", src);
    if (typeof mod.stageStates !== "function") throw new Error("lib/tailorStages.ts does not export stageStates");
    const out = [];
    const want = (label, heard, expected) => {
      const got = mod.stageStates(heard);
      const shown = mod.TAILOR_STAGES.map((s) => got[s]).join(",");
      if (shown !== expected) out.push(`${label}: [${shown}], not [${expected}]`);
    };
    want("nothing reported yet", [], "pending,pending,pending,pending,pending");
    want("the plan started", ["plan"], "active,pending,pending,pending,pending");
    want("the rewrite started", ["plan", "rewrite"], "done,active,pending,pending,pending");
    want("every stage reported", ["plan", "rewrite", "facts", "voice", "rescore"], "done,done,done,done,active");
    want("a stage this page does not know", ["plan", "polish"], "active,pending,pending,pending,pending");
    return out;
  };
  const real64 = run64(ts64);
  const guessing = ts64.replace('!known.includes(s) ? "pending"', '!known.includes(s) && !last ? "pending"');
  if (guessing === ts64) {
    if (!real64.length) throw new Error("the probe could not plant a state that guesses");
  } else if (!run64(guessing).length) throw new Error("the run passes a stage marked done that never reported, so it cannot be trusted");
  for (const p of real64) fail(`check 64: stageStates, ${p} (PLAN 31.3/2)`);

  for (const loc of ["en", "he"]) {
    const ns = JSON.parse(read(`locales/${loc}/tailor.json`));
    if (!resolvesIn(ns, "progress.title")) fail(`check 64: locales/${loc}/tailor.json has no progress.title`);
    for (const s of tsList(ts64))
      if (!resolvesIn(ns, `progress.stages.${s}`))
        fail(`check 64: locales/${loc}/tailor.json has no progress.stages.${s}, so the tailor's progress shows a raw key`);
  }

  const panel64 = decomment(read("components/TailorProgress.tsx"));
  const page64 = decomment(read("pages/TailorPage.tsx"));
  const read64d = (panel, pg) => {
    const out = [];
    if (!/\bstageStates\(stages\)/.test(panel)) out.push("TailorProgress does not derive its states from the reported stages (`stageStates(stages)`)");
    if (/\b(?:setInterval|setTimeout|Date\.now|performance\.now|requestAnimationFrame)\b/.test(panel))
      out.push("TailorProgress reads a clock, so it can move a stage the pipeline never reported");
    if (!/<TailorProgress stages=\{tailorStages\} \/>/.test(pg)) out.push("TailorPage does not feed TailorProgress the store's reported stages");
    return out;
  };
  const real64d = read64d(panel64, page64);
  const timed = panel64.replace("const states = stageStates(stages);", "const states = stageStates(stages);\n  setInterval(() => {}, 1000);");
  if (timed === panel64) {
    if (!real64d.length) throw new Error("the probe could not plant a timer");
  } else if (!read64d(timed, page64).length) throw new Error("the reader passes a timer in the panel, so it cannot be trusted");
  for (const p of real64d) fail(`check 64: ${p} (PLAN 31.3/2)`);
} catch (e) {
  fail(`tailor progress check (check 64) could not run: ${e.message}`);
}

// ---- 65. one job, one page (PLAN 31.4/2) -------------------------------------- //
// A tracked job has a page of its own, and the tracker's detail modal and the
// row of three buttons under every card are gone. (a) The page is a route:
// `/applications/:id` renders JobPage. (b) A card IS the way there: its title
// links to `/applications/<id>` and stretches over the whole card
// (`after:absolute after:inset-0`), which only stays inside the card while both
// card wrappers are `relative` (without it the link covers the page from the
// nearest positioned ancestor); nothing on the tracker opens a modal or fetches
// one application any more. (c) Viewing the page never runs a model: no effect
// in JobPage calls a model route, so a model call can only follow a tap (the
// letter's "Write", which says what it costs). (d) Delete on the job page runs
// on the tracker, through `remove` and its undo window: the page hands the id
// over in navigation state, and the tracker clears that state before removing,
// so Back or a reload never deletes a second time. (e) Every `also` prefix in
// AppLayout's nav (a page that lights a tab from its own address) is the start
// of a route App.tsx declares, or it lights nothing. Probed red with each rule
// broken on the real files.
try {
  const app65 = decomment(read("App.tsx"));
  const tracker65 = decomment(read("pages/TrackerPage.tsx"));
  const job65 = decomment(read("pages/JobPage.tsx"));
  const layout65 = decomment(read("layouts/AppLayout.tsx"));

  // (c)'s reader: the body of every `useEffect(`, matched by brace depth.
  const effectBodies = (src) => {
    const bodies = [];
    for (const m of src.matchAll(/\buseEffect\(\s*(?:async\s*)?\(\)\s*=>\s*\{/g)) {
      let depth = 1;
      let i = m.index + m[0].length;
      for (; i < src.length && depth > 0; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") depth--;
      }
      bodies.push(src.slice(m.index + m[0].length, i - 1));
    }
    return bodies;
  };
  const MODEL_CALLS = /\b(?:analyzeJD|checkFit|coverLetter|tailorStream|tailorResume|startTailor|interviewQuestions|companyBrief|outreach|followUp)\(/;

  const read65 = ({ app, tracker, job, layout }) => {
    const out = [];
    // (a)
    if (!/<Route path="\/applications\/:id" element=\{<JobPage \/>\} \/>/.test(app))
      out.push("(a) App.tsx does not route `/applications/:id` to <JobPage />");
    // (b)
    const card = /<Link\s+to=\{`\/applications\/\$\{a\.id\}`\}[\s\S]{0,300}?after:absolute after:inset-0/.test(tracker);
    if (!card) out.push("(b) the tracker card's title is not a link to `/applications/${a.id}` stretched over the card");
    // Three wrappers hold a stretched link since PLAN 31.4/5: the board's card,
    // the phone list's, and a draft's in To review (its title links to the draft).
    const wrappers = (tracker.match(/className="(?:group )?relative rounded-xl border border-line/g) || []).length;
    if (wrappers < 3) out.push(`(b) ${wrappers} of the 3 card wrappers are \`relative\`, so the stretched link escapes a card`);
    for (const gone of ["<Modal", "getApplication(", "onView", "onDelete"])
      if (tracker.includes(gone)) out.push(`(b) TrackerPage still carries \`${gone}\` (the detail modal or the per-card action row)`);
    // (c)
    const bodies = effectBodies(job);
    if (bodies.length < 2) throw new Error(`found ${bodies.length} effects in JobPage.tsx, expected its loaders`);
    for (const body of bodies)
      if (MODEL_CALLS.test(body)) out.push(`(c) an effect in JobPage calls a model route (${body.match(MODEL_CALLS)[0]}), so viewing the page spends`);
    // (d)
    if (!/nav\("\/tracker", \{ state: \{ remove: detail\.id \} \}\)/.test(job))
      out.push("(d) JobPage's delete does not hand the id to the tracker (`nav(\"/tracker\", { state: { remove: detail.id } })`)");
    const handover = /typeof toRemove !== "number"[\s\S]{0,200}?nav\("\.", \{ replace: true, state: null \}\);\s*remove\(toRemove\);/.test(tracker);
    if (!handover) out.push("(d) the tracker does not clear the handed-over state BEFORE `remove(toRemove)`, so Back could delete again");
    // (e) `also` is a list of prefixes since PLAN 31.4/5 (a job's page and a
    // draft's page both light the Tracker); a single string is read too.
    const routes = [...app.matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1]);
    const alsos = [];
    for (const m of layout.matchAll(/\balso:\s*(\[[^\]]*\]|"[^"]+")/g))
      for (const s of m[1].matchAll(/"([^"]+)"/g)) alsos.push(s[1]);
    if (!alsos.length) out.push("(e) AppLayout's nav names no `also` prefix, so a job's page lights no tab");
    for (const p of alsos)
      if (!routes.some((r) => r.startsWith(p))) out.push(`(e) the nav's \`also\` prefix "${p}" starts no route App.tsx declares, so it lights nothing`);
    return out;
  };

  const real = { app: app65, tracker: tracker65, job: job65, layout: layout65 };
  const problems65 = read65(real);
  // Each probe breaks one rule on the real files and must go red.
  const plant = (key, from, to, label) => {
    const next = real[key].replace(from, to);
    if (next === real[key]) throw new Error(`the probe could not plant ${label}`);
    if (!read65({ ...real, [key]: next }).length) throw new Error(`the reader passes ${label}, so it cannot be trusted`);
  };
  plant("app", 'path="/applications/:id"', 'path="/application/:id"', "a renamed job route");
  plant("tracker", "after:absolute after:inset-0", "after:inset-0", "a card link that does not stretch");
  plant("tracker", 'className="relative rounded-xl border border-line', 'className="rounded-xl border border-line', "a card wrapper that is not relative");
  plant("job", "void load();", "void load(); void analyzeJD(\"x\");", "a model call in an effect");
  plant("job", "state: { remove: detail.id }", "state: { removed: detail.id }", "a delete that is never handed over");
  plant("tracker", 'nav(".", { replace: true, state: null });', "", "a handover that keeps its state");
  plant("layout", 'also: ["/applications/"', 'also: ["/application-page/"', "a dead also prefix");
  plant("layout", '"/kits/"]', '"/kit-page/"]', "a dead second also prefix");
  for (const p of problems65) fail(`check 65: ${p} (PLAN 31.4/2)`);
} catch (e) {
  fail(`job page check (check 65) could not run: ${e.message}`);
}

// ---- 66. every colour opacity is one Tailwind generates ----------------------- //
// A colour's `/<n>` modifier is generated only for a step on the opacity scale
// (0, 5, 10, … 100, plus any `opacity` the config extends), and an off-scale one
// is NOT an error: the class is simply never written, so the element paints no
// colour at all, in the browser, with a green build (the house rule against a
// class assembled at runtime, in a different costume). Seven shipped that way,
// found on 2026-09-23 while building the job page: `/12` on the missing-keyword
// chip in Badge, MatchReport and the CV scan, on the inbox bar's and the
// tracker's icon tiles, and `bg-bg/97` on the landing's phone menu, whose links
// sat over the hero with no panel under them. Measured in the browser: each
// computed to `rgba(0, 0, 0, 0)` while its `/10` or `/95` twin painted. Bracketed
// values (`/[0.12]`) are arbitrary values and always generated, so they pass.
try {
  const cfg66 = fs.readFileSync(path.join(SRC, "..", "tailwind.config.js"), "utf8");
  const extended = new Set();
  const ext = /\bopacity:\s*\{([^}]*)\}/.exec(cfg66.replace(/@keyframes[\s\S]*?\}\s*\}/g, ""));
  if (ext) for (const m of ext[1].matchAll(/["']?(\d+)["']?\s*:/g)) extended.add(Number(m[1]));
  const onScale = (n) => (n % 5 === 0 && n <= 100) || extended.has(n);
  const MOD = /(?<![\w-])((?:[a-z0-9-]+:)*(?:bg|text|border|ring|from|to|via|fill|stroke|outline|shadow|divide|placeholder|decoration|caret)-[a-z][a-z0-9-]*)\/(\d+)(?![\w./[])/g;
  const offScale = (text) => [...text.matchAll(MOD)].filter((m) => !onScale(Number(m[2]))).map((m) => `${m[1]}/${m[2]}`);
  const files66 = [];
  const walk66 = (dir) => {
    for (const e of fs.readdirSync(path.join(SRC, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) walk66(rel);
      else if (/\.(tsx?|css)$/.test(e.name)) files66.push(rel);
    }
  };
  walk66("");
  let seen66 = 0;
  for (const rel of files66) {
    const text = read(rel);
    seen66 += [...text.matchAll(MOD)].length;
    for (const cls of offScale(text))
      fail(`check 66: ${rel} uses \`${cls}\`, an opacity step Tailwind never generates, so it paints nothing — use a step of 5, or \`/[0.xx]\``);
  }
  if (seen66 < 100) throw new Error(`read only ${seen66} colour opacity modifiers across ${files66.length} files; the reader is broken`);
  // The reader in both directions: the shipped defects must be caught, and a
  // fraction, a bracketed value and an on-scale step must not be.
  const planted = offScale('className="bg-accent/12 hover:bg-bg/97 text-danger/8"');
  if (planted.join(" ") !== "bg-accent/12 hover:bg-bg/97 text-danger/8")
    throw new Error(`the reader missed a planted off-scale step (${JSON.stringify(planted)}), so it cannot be trusted`);
  const quiet = offScale('className="w-1/2 translate-x-1/2 bg-accent/[0.12] bg-accent/15 border-line/60 aspect-[1/1.414]"');
  if (quiet.length) throw new Error(`the reader flags valid classes (${quiet.join(", ")}), so it cannot be trusted`);
} catch (e) {
  fail(`Tailwind opacity check (check 66) could not run: ${e.message}`);
}

// ---- 67. Prepare opens each tool with the job, and Back returns to it (PLAN 31.4/3) //
// Every tool's Back said "All tools", and the posting it was opened with lived in
// navigation state, gone after a reload. Now a job's page links each Prepare tool
// with `?app=<id>`, and the tool reads the job through `useJobContext`, fills
// ONLY the fields still empty (what the user typed, or a caller's state, wins:
// `set…((cur) => cur || job.…)`), and returns to `/applications/<id>`. (a) Every
// Prepare link on the job page carries the job's `app=` parameter. (b) Each of
// the four tools calls `useJobContext()`, hands its Back to the job (ToolShell's
// `back={ctx?.backTo}`, or Interview's own link to `ctx.backTo`), and writes a
// field from the job only through `cur ||`. (c) ToolShell's Back falls back to
// the tools list when no job was named. Probed red on the real files with a tool
// that forgets its Back, a prefill that overwrites typed text, and a Prepare link
// without the job.
try {
  const job67 = decomment(read("pages/JobPage.tsx"));
  const shell67 = decomment(read("components/ToolShell.tsx"));
  const TOOLS67 = [
    ["pages/InterviewPage.tsx", "interview"],
    ["pages/tools/CompanyBriefToolPage.tsx", "brief"],
    ["pages/tools/OutreachToolPage.tsx", "outreach"],
    ["pages/tools/FollowUpToolPage.tsx", "follow-up"],
  ];
  const tools67 = Object.fromEntries(TOOLS67.map(([rel]) => [rel, decomment(read(rel))]));

  const read67 = (job, shell, tools) => {
    const out = [];
    // (a) the Prepare list is built from one `app=` string and every entry uses it.
    const sect = /function PrepareSection[\s\S]*?\n\}/.exec(job);
    if (!sect) throw new Error("could not find `function PrepareSection` in JobPage.tsx");
    if (!/const app = `app=\$\{detail\.id\}`;/.test(sect[0])) out.push("(a) the Prepare list does not build the job's `app=` parameter");
    const targets = [...sect[0].matchAll(/to: `(\/[^`?]+)\?\$\{app\}/g)].map((m) => m[1]);
    if (targets.length < 5) out.push(`(a) ${targets.length} of the 5 Prepare links carry \`?\${app}\``);
    // (b) each tool reads the job, returns to it, and fills only what is empty.
    for (const [rel, name] of TOOLS67) {
      const src = tools[rel];
      if (!/\bconst ctx = useJobContext\(\);/.test(src)) out.push(`(b) ${name}: does not read the job (\`useJobContext()\`)`);
      const back = /back=\{ctx\?\.backTo\}/.test(src) || /<Link\s+to=\{ctx\.backTo\}/.test(src);
      if (!back) out.push(`(b) ${name}: its Back does not return to the job's page`);
      const fills = [...src.matchAll(/set\w+\(\(cur\) => cur \|\| job\.\w+\)/g)].length;
      if (fills < 1) out.push(`(b) ${name}: fills nothing from the job through \`(cur) => cur || job.…\``);
      if (/set\w+\(job\.\w+\)/.test(src)) out.push(`(b) ${name}: writes a field straight from the job, over what the user typed`);
    }
    // (c)
    if (!/to=\{back \?\? "\/tools"\}/.test(shell)) out.push("(c) ToolShell's Back does not fall back to the tools list");
    return out;
  };

  const problems67 = read67(job67, shell67, tools67);
  const probe67 = (label, job, shell, tools) => {
    if (!read67(job, shell, tools).length) throw new Error(`the reader passes ${label}, so it cannot be trusted`);
  };
  const outreach = "pages/tools/OutreachToolPage.tsx";
  const forgot = tools67[outreach].replace("back={ctx?.backTo}", "");
  if (forgot === tools67[outreach]) throw new Error("the probe could not plant a tool that forgets its Back");
  probe67("a tool that forgets its Back", job67, shell67, { ...tools67, [outreach]: forgot });
  const brief = "pages/tools/CompanyBriefToolPage.tsx";
  const clobber = tools67[brief].replace("setCompany((cur) => cur || job.company);", "setCompany(job.company);");
  if (clobber === tools67[brief]) throw new Error("the probe could not plant a prefill that overwrites typed text");
  probe67("a prefill that overwrites typed text", job67, shell67, { ...tools67, [brief]: clobber });
  const bare = job67.replace("to: `/tools/outreach?${app}`", "to: `/tools/outreach`");
  if (bare === job67) throw new Error("the probe could not plant a Prepare link without the job");
  probe67("a Prepare link without the job", bare, shell67, tools67);
  for (const p of problems67) fail(`check 67: ${p} (PLAN 31.4/3)`);
} catch (e) {
  fail(`Prepare check (check 67) could not run: ${e.message}`);
}

// ---- 68. a job's draft opens again, and is written onto its own row (EXECUTED) - //
// PLAN 31.4/4. The review behind a saved draft (the tailor's result, the resume
// it came from, the declines, the typed lines) rides the saves, so the job's page
// can open it on the document after a reload, and a tailor started from a job's
// page writes onto THAT job's row. EXECUTES the real store with the API stubbed,
// recording each save as `<method>:<row>:<template>:<review>`, where the review
// is `R` (the result sent whole), `d` (the decisions only) or `-` (none):
//   * `setTargetJob(…, id)` binds the row, so the tailor's first save is a PUT
//     onto it, never a POST that makes a second row;
//   * the result is sent ONCE per row: the next save carries the decisions only;
//   * a new tailor is a new result, sent whole again;
//   * `openSavedReview` binds its row with the result already on the server, so
//     the next save is a lean PUT, and puts the review back on the page;
//   * a target with no row still creates one, with the review whole.
// Probed with a saver that always sends the whole result, a `setTargetJob` that
// ignores the id, and an `openSavedReview` that forgets what the server holds.
try {
  const storeSrc = read("state/tailorStore.ts");
  const R68 = { contact: { name: "Probe" }, summary: "Probe summary.", experience: [], education: [], skills: [] };
  const run68 = async (src) => {
    const calls = [];
    let nextId = 1;
    const reviewTag = (d) => (d.review ? (d.review.result ? "R" : "d") : "-");
    const st = runProbeBundle("draft-review", src, {
      "../api/client": {
        analyzeJD: async () => ({ language: "en", job_title: "Probe", company: "Probe Co" }),
        getMasterResume: async () => null,
        saveMasterResume: async () => ({ resume: R68, label: "" }),
        tailorStream: async () => ({ tailored_resume: R68, fabrication_flags: [], score_after: { overall: 50 } }),
        saveApplication: async (p) => {
          const id = nextId++;
          calls.push(`POST:${id}:${p.template}:${p.review ? (p.review.result ? "R" : "d") : "-"}`);
          return { id };
        },
        saveApplicationDraft: async (id, d) => {
          calls.push(`PUT:${id}:${d.template}:${reviewTag(d)}`);
          return { id };
        },
      },
      "../hooks/useMasterResume": { resetMasterCache: () => {} },
      "../lib/apiError": { apiErrorMessage: (_e, f) => f },
      "../lib/draft": { clearDraft: () => {}, writeDraft: () => {}, sameResume: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
      "../lib/lang": { resumeLanguage: () => "en" },
      // PLAN 31.6/2: the master's autosave.
      "../lib/dataCache": { invalidateData: () => {} },
      "../lib/masterLabel": { masterResumeLabel: () => "Probe's resume" },
      "../lib/templateSpecs": { TEMPLATE_IDS: ["standard", "classic", "executive", "modern"] },
    });
    for (const name of ["syncDraft", "settleDraft", "startTailor", "setTargetJob", "openSavedReview", "setTailorState", "getTailorState"])
      if (typeof st[name] !== "function") throw new Error(`state/tailorStore.ts does not export ${name}`);
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const tailor = async () => {
      st.startTailor();
      for (let i = 0; i < 10 && st.getTailorState().loading; i++) await tick();
      if (!st.getTailorState().result) throw new Error("the stubbed tailor never finished");
    };
    // The snapshot the page builds: the review's result IS the store's result.
    const snap = (posting, template) => {
      const s = st.getTailorState();
      return {
        draft: {
          tailored_resume: R68, template, voice_score: null, fabrication_flag_count: null, overall_score: 50,
          review: { result: s.result, base: s.tailoredFrom, rejected: s.rejectedEdits, overrides: s.tailorOverrides, scored_at: null },
        },
        job: { job_title: "T", company: "C", jd_text: posting },
      };
    };
    st.setTailorState({ resume: R68 });
    st.setTargetJob("check-68-a", { jdText: "Posting X" }, 7);
    await tailor();
    await st.syncDraft(snap("Posting X", "standard"), true);
    await st.syncDraft(snap("Posting X", "executive"), true);
    await tailor(); // the same posting again: the row kept, a new result
    await st.syncDraft(snap("Posting X", "classic"), true);
    const restored = { tailored_resume: R68, fabrication_flags: [], score_after: { overall: 61 } };
    st.openSavedReview(
      { id: 9, jd_text: "Posting Y ", job_url: "", job_title: "Y", company: "YCo", template: "modern", status: "applied", jd: null },
      { result: restored, base: R68, rejected: ["exp.0.b.1"], overrides: { summary: { summary: "Mine" } }, scored_at: 5 },
    );
    const s = st.getTailorState();
    const back =
      s.result === restored && s.savedAppId === 9 && s.savedFor === "Posting Y" && s.template === "modern" &&
      s.rejectedEdits.join() === "exp.0.b.1" && s.tailorOverrides.summary?.summary === "Mine" &&
      s.applied === true && s.scoredAt === 5 && s.draftSave === "saved";
    await st.syncDraft(snap("Posting Y", "modern"), true);
    st.setTargetJob("check-68-b", { jdText: "Posting Z" });
    await tailor();
    await st.syncDraft(snap("Posting Z", "standard"));
    await st.settleDraft();
    return { calls: calls.join(" "), back };
  };
  const WANT68 = "PUT:7:standard:R PUT:7:executive:d PUT:7:classic:R PUT:9:modern:d POST:1:standard:R";
  const real68 = await run68(storeSrc);
  for (const [label, mutated] of [
    ["a saver that always sends the whole result", storeSrc.replace("if (!review?.result || sentReview?.row !== row", "if (true || !review?.result || sentReview?.row !== row")],
    ["a setTargetJob that ignores the row id", storeSrc.replace("if (bound !== null) draftRows.set(draftEpoch, bound);", "")],
    ["an openSavedReview that forgets what the server holds", storeSrc.replace("  sentReview = { row: app.id, result: review.result };\n", "")],
  ]) {
    if (mutated === storeSrc) throw new Error(`the probe could not plant "${label}"`);
    const out = await run68(mutated);
    if (out.calls === WANT68 && out.back) throw new Error(`the run passes "${label}", so it cannot be trusted`);
  }
  if (real68.calls !== WANT68)
    fail(
      `check 68: state/tailorStore.ts wrote [${real68.calls}] where [${WANT68}] is right. A draft from a job's own page ` +
        "must reach that row (a PUT, never a second row), its review's result must be sent once per row and the " +
        "decisions after it, and a restored review must save onto its row without resending (PLAN 31.4/4)",
    );
  if (!real68.back)
    fail("check 68: openSavedReview does not put the saved review back on the page (its result, row, template, declines, typed lines, reading's minute and sent state) (PLAN 31.4/4)");
} catch (e) {
  fail(`saved review check (check 68) could not run: ${e.message}`);
}

// ---- 69. a batch's drafts wait on their jobs, in the tracker (EXECUTED) ------ //
// PLAN 31.4/5. The batch tailor's "kits" were a tab of their own on the Jobs
// page, apart from the jobs they were made for, and the count of them rode the
// Jobs entry. A kit is what it is to a user now, a draft waiting on its job:
// (a) EXECUTES lib/kitsReview.ts. To review lists exactly the drafts still
//     waiting (ready, tailoring, queued, failed), in that order and newest first
//     within one, never an approved, rejected or submitted one, which is
//     decided; it never sorts the store's own array; a list never loaded lists
//     nothing; and the nav's count is the ready ones alone.
// (b) Pins the wiring by shape: no Kits tab on the Jobs page and no kit row left
//     beside the jobs; the tracker lists them through `kitsToReview`, as the
//     phone list's tab and as a strip over the board; the count rides the
//     Tracker entry (`drafts: true`) and never Jobs; a draft's page leads back to
//     To review and tells the store what was decided (`putKit`); the batch
//     card's link opens To review; and the job page offers Comeet's send only
//     from the server's `send_kit`, sending that kit.
// Probed every run: an approved draft listed, the list in the store's order, a
// count of every draft, the count off the Tracker and back on Jobs, a Kits tab
// back, the tracker's own list, and a send offered without `send_kit`.
try {
  const reviewSrc = read("lib/kitsReview.ts");
  const ALL69 = [[1, "failed"], [2, "done"], [3, "approved"], [4, "queued"], [5, "running"], [6, "rejected"], [7, "submitted"], [8, "done"], [9, "queued"]];
  const run69 = (src) => {
    const m = runProbeBundle("kits-review", src);
    const input = ALL69.map(([id, status]) => ({ id, status }));
    const before = input.map((k) => k.id).join(",");
    return {
      listed: m.kitsToReview(input).map((k) => `${k.id}:${k.status}`).join(" "),
      inPlace: input.map((k) => k.id).join(",") !== before,
      none: m.kitsToReview(null).length,
      count: m.awaitingReview(input),
      countNone: m.awaitingReview(null),
    };
  };
  const WANT69 = "8:done 2:done 5:running 9:queued 4:queued 1:failed";
  const ok69 = (r) => r.listed === WANT69 && !r.inPlace && r.none === 0 && r.count === 2 && r.countNone === 0;
  for (const [label, mutated] of [
    ["an approved draft listed", reviewSrc.replace('["done", "running", "queued", "failed"]', '["done", "running", "queued", "failed", "approved"]')],
    ["the list in the store's order", reviewSrc.replace("|| b.id - a.id", "|| a.id - b.id")],
    ["a count of every draft", reviewSrc.replace('kits.filter((k) => k.status === "done").length', "kits.length")],
  ]) {
    if (mutated === reviewSrc) throw new Error(`the probe could not plant "${label}"`);
    if (ok69(run69(mutated))) throw new Error(`the run passes "${label}", so it cannot be trusted`);
  }
  const real69 = run69(reviewSrc);
  if (!ok69(real69))
    fail(
      `check 69: lib/kitsReview.ts lists [${real69.listed}] (in place: ${real69.inPlace}; a list never loaded: ` +
        `${real69.none}) and counts ${real69.count} (never loaded: ${real69.countNone}), where [${WANT69}], 0, 2 and 0 ` +
        "are right: To review lists the drafts still waiting, ready first, and the nav counts the ready ones (PLAN 31.4/5)",
    );

  const real = {
    jobs: decomment(read("pages/JobsPage.tsx")),
    kitsFile: decomment(read("pages/jobs/kits.tsx")),
    tracker: decomment(read("pages/TrackerPage.tsx")),
    layout: decomment(read("layouts/AppLayout.tsx")),
    kitPage: decomment(read("pages/KitReviewPage.tsx")),
    job: decomment(read("pages/JobPage.tsx")),
  };
  const read69 = ({ jobs, kitsFile, tracker, layout, kitPage, job }) => {
    const out = [];
    if (/key:\s*"kits"/.test(jobs) || /mode === "kits"/.test(jobs)) out.push("the Jobs page has a Kits tab again");
    if (/\bKitRow\b/.test(jobs + kitsFile)) out.push("a kit row is back beside the jobs");
    if (!/\bkitsToReview\(kits\)/.test(tracker)) out.push("the tracker does not list its drafts through kitsToReview");
    if ((tracker.match(/<ReviewList\b/g) || []).length < 2) out.push("To review is not on both the phone list and the board");
    if (!/setListStatus\("review"\)/.test(tracker)) out.push("the phone list has no To review tab");
    const entry = (to) => (layout.match(new RegExp(`\\{ to: "${to}",[^}]*\\}`)) || [""])[0];
    if (!/\bdrafts: true\b/.test(entry("/tracker"))) out.push("the Tracker entry does not carry the drafts count (`drafts: true`)");
    if (/\bdrafts: true\b/.test(entry("/jobs"))) out.push("the Jobs entry carries the drafts count");
    if (!/item\.drafts \? kitsBadge/.test(layout) || !/item\.drafts && awaiting > 0/.test(layout))
      out.push("the menu and the tab bar do not draw the count on the entry that carries it");
    if (/spinner \?\? kitsBadge/.test(layout) || /item\.live &&[^\n]*awaiting > 0/.test(layout))
      out.push("the count still rides the search's indicator on Jobs");
    if (!/\bawaitingReview\(kits\)/.test(layout)) out.push("the nav's count is not awaitingReview(kits)");
    if (!/to="\/tracker"\s+state=\{\{ show: "review" \}\}/.test(kitPage)) out.push("a draft's page does not lead back to To review");
    if (!/\bputKit\(/.test(kitPage)) out.push("a draft's page does not tell the store what was decided (putKit)");
    if (!/nav\("\/tracker", \{ state: \{ show: "review" \} \}\)/.test(kitsFile)) out.push("the batch card's link does not open To review");
    const send = fnSource(job, "function SendSection(");
    if (!/const kit = detail\.send_kit \?\? null;\s*if \(!kit\) return null;/.test(send))
      out.push("the job page offers Comeet's send without the server's send_kit");
    if (!/sendKitApplication\(kit\.id\)/.test(send)) out.push("the job page's send does not send the kit the server named");
    return out;
  };
  const problems69 = read69(real);
  const plant69 = (key, from, to, label) => {
    const next = real[key].replace(from, to);
    if (next === real[key]) throw new Error(`the probe could not plant ${label}`);
    if (!read69({ ...real, [key]: next }).length) throw new Error(`the reader passes ${label}, so it cannot be trusted`);
  };
  plant69("layout", ', drafts: true }', " }", "the count off the Tracker");
  plant69("layout", "live: true }", "live: true, drafts: true }", "the count back on Jobs");
  plant69("jobs", 'key: "manual"', 'key: "kits"', "a Kits tab back");
  plant69("tracker", "kitsToReview(kits)", "(kits ?? [])", "the tracker's own list");
  plant69("job", "if (!kit) return null;", "", "a send offered without send_kit");
  for (const p of problems69) fail(`check 69: ${p} (PLAN 31.4/5)`);
} catch (e) {
  fail(`drafts-to-review check (check 69) could not run: ${e.message}`);
}

// ---- 70. every way into a job's page (EXECUTED) ------------------------------ //
// PLAN 31.4/6. A job's own page existed, but the ways to it still led elsewhere:
// a saved search result's icon and the extension's two links opened the whole
// tracker, and the alert and nudge emails opened the board's posting.
// (a) EXECUTES lib/openJob.ts, the answer for an alert email's `/jobs?open=`,
//     with the Jobs page's real URL key: a tracked job opens its page through the
//     row History names, or through the tracker's row when History no longer
//     holds it; an untracked job History holds opens its row, found by its URL
//     or the same posting on another board; neither says so; and the notice's
//     posting link is made of an http(s) URL only.
// (b) Pins by shape: the Jobs page reads `open` and hands it to `openTarget`,
//     opens `/applications/${target.id}` for a job and rings the opened row; the
//     search card's and the History row's saved icons open the job's page; the
//     tracker's nudge opens the follow-up tool with `?app=`; and the extension's
//     two links (after a save, and the duplicate warning) open the row's page.
// (c) The Python half (degraded without backend/): the alert email links a job
//     through `/jobs?open=` with its URL quoted whole, and the nudge email links
//     an application to `/applications/{id}`.
// Probed every run with a resolver that ignores the row History names, one that
// forgets the other boards, a permissive posting link, and a saved icon, a job
// link and an extension link sent back to the tracker.
try {
  const openSrc = read("lib/openJob.ts");
  const run70 = (src) => {
    const m = runProbeBundle(
      "open-job",
      `${src}\nexport { normalizeJobUrl } from "./pages/jobs/shared";\n`,
    );
    const hits = [
      { id: 11, url: "https://www.linkedin.com/jobs/view/4460000001", also_on: [], app_id: 34 },
      { id: 12, url: "https://boards.example/jobs/77/", also_on: [{ source: "comeet", url: "https://www.comeet.com/jobs/acme/A1.001/dev/B1.011" }], app_id: null },
      { id: 13, url: "https://boards.example/jobs/untracked", also_on: [], app_id: null },
    ];
    const rows = [{ id: 51, job_url: "https://trimmed.example/jobs/9" }, { id: 52, job_url: "https://boards.example/jobs/untracked-other" }];
    const at = (open) => JSON.stringify(m.openTarget(open, hits, rows, m.normalizeJobUrl));
    return [
      at("https://www.linkedin.com/jobs/view/4460000001"),
      at("  https://boards.example/jobs/77  "),
      at("https://www.comeet.com/jobs/acme/A1.001/dev/B1.011"),
      at("https://boards.example/jobs/untracked/"),
      at("https://trimmed.example/jobs/9/"),
      at("https://nowhere.example/jobs/1"),
      JSON.stringify(m.openTarget("https://trimmed.example/jobs/9", null, rows, m.normalizeJobUrl)),
      [m.postingLink("https://jobs.example/1"), m.postingLink(" HTTP://Jobs.example/2 "), m.postingLink("javascript:alert(1)"),
        m.postingLink("data:text/html,x"), m.postingLink("/jobs"), m.postingLink("")].map(String).join(","),
    ].join(" | ");
  };
  const WANT70 = [
    '{"kind":"job","id":34}', '{"kind":"hit","id":12}', '{"kind":"hit","id":12}', '{"kind":"hit","id":13}',
    '{"kind":"job","id":51}', '{"kind":"missing"}', '{"kind":"job","id":51}',
    "https://jobs.example/1,HTTP://Jobs.example/2,null,null,null,null",
  ].join(" | ");
  for (const [label, mutated] of [
    ["a resolver that ignores the row History names", openSrc.replace("hit?.app_id ?? rows", "rows")],
    ["a resolver that forgets the other boards", openSrc.replace(" || (h.also_on ?? []).some((a) => same(a.url))", "")],
    ["a permissive posting link", openSrc.replace("return /^https?:\\/\\//i.test(open.trim()) ? open.trim() : null;", "return open.trim() || null;")],
  ]) {
    if (mutated === openSrc) throw new Error(`the probe could not plant "${label}"`);
    if (run70(mutated) === WANT70) throw new Error(`the run passes "${label}", so it cannot be trusted`);
  }
  const real70 = run70(openSrc);
  if (real70 !== WANT70)
    fail(
      `check 70: lib/openJob.ts answers [${real70}] where [${WANT70}] is right: an alert email's job opens its page when ` +
        "it is tracked (the row History names, else the tracker's), its History row when it is not, says so when " +
        "neither, and links a posting only when it is http(s) (PLAN 31.4/6)",
    );

  const real = {
    jobs: decomment(read("pages/JobsPage.tsx")),
    cards: decomment(read("pages/jobs/cards.tsx")),
    tracker: decomment(read("pages/TrackerPage.tsx")),
    popup: fs.existsSync(EXT_DIR) ? fs.readFileSync(path.join(EXT_DIR, "popup.js"), "utf8") : null,
  };
  const read70 = ({ jobs, cards, tracker, popup }) => {
    const out = [];
    if (!/searchParams\.get\("open"\)/.test(jobs) || !/openTarget\(openParam,/.test(jobs))
      out.push("the Jobs page does not resolve `?open=` through openTarget");
    if (!/nav\(`\/applications\/\$\{target\.id\}`, \{ replace: true \}\)/.test(jobs))
      out.push("an alert email's tracked job does not open its page");
    if (!/opened=\{hit\.id === openedHit\}/.test(jobs)) out.push("the History row an email opened is not ringed");
    if (!/postingLink\(openMissing\)/.test(jobs) || /href=\{openMissing\}/.test(jobs))
      out.push("the notice links the parameter without postingLink");
    if (!/nav\(rowId \? `\/applications\/\$\{rowId\}` : "\/tracker"\)/.test(cards))
      out.push("the search card's saved icon does not open the job's page");
    if (!/nav\(`\/applications\/\$\{hit\.app_id\}`\)/.test(cards)) out.push("a History row's saved icon does not open the job's page");
    if (!/nav\(`\/tools\/follow-up\?app=\$\{n\.id\}`/.test(tracker)) out.push("the tracker's nudge does not open the follow-up tool with its job");
    if (popup !== null) {
      if (!/\$\("dupLink"\)\.href = settings\.appUrl \+ "\/applications\/" \+ dup\.id/.test(popup))
        out.push("the extension's duplicate warning does not open the job's page");
      if (!/settings\.appUrl \+ "\/applications\/" \+ saved\.id/.test(popup)) out.push("the extension's saved link does not open the job's page");
    }
    return out;
  };
  const problems70 = read70(real);
  const plant70 = (key, from, to, label) => {
    if (real[key] === null) return;
    const next = real[key].replace(from, to);
    if (next === real[key]) throw new Error(`the probe could not plant ${label}`);
    if (!read70({ ...real, [key]: next }).length) throw new Error(`the reader passes ${label}, so it cannot be trusted`);
  };
  plant70("jobs", "nav(`/applications/${target.id}`, { replace: true })", 'nav("/tracker", { replace: true })', "a job link sent to the tracker");
  plant70("cards", 'nav(rowId ? `/applications/${rowId}` : "/tracker")', 'nav("/tracker")', "a saved icon sent to the tracker");
  plant70("popup", '"/applications/" + dup.id', '"/tracker"', "an extension link sent to the tracker");
  for (const p of problems70) fail(`check 70: ${p} (PLAN 31.4/6)`);

  // (c) The emails, in Python: each job's link and each application's link.
  const alertsPy = pySource("app/core/alerts.py", "check 70");
  const nudgesPy = pySource("app/core/nudges.py", "check 70");
  if (alertsPy !== null && nudgesPy !== null) {
    const jobLink = /def _job_link\(m: JobMatch, app_url: str = ""\) -> str:[\s\S]*?\n(?=def )/.exec(alertsPy)?.[0] ?? "";
    if (!jobLink) throw new Error("backend/app/core/alerts.py has no `_job_link` to read");
    if (!/\/jobs\?open=\{urllib\.parse\.quote\(m\.url, safe=''\)\}/.test(jobLink))
      fail("check 70: alerts._job_link does not link a job into the app as `/jobs?open=<posting, quoted whole>` (PLAN 31.4/6)");
    if ((alertsPy.match(/_job_link\(m, app_url\)/g) || []).length < 2)
      fail("check 70: the alert email's two bodies do not both link through `_job_link(m, app_url)` (PLAN 31.4/6)");
    if (!/f"\{base\}\/applications\/\{it\.id\}"/.test(nudgesPy))
      fail("check 70: nudges._application_link does not open `/applications/{id}` (PLAN 31.4/6)");
  }
} catch (e) {
  fail(`job entry points check (check 70) could not run: ${e.message}`);
}

// ---- 71. the first search is free, and only where the server serves it free (EXECUTED) //
// PLAN 31.5, owner decision 7. The pool's first search is served without a use
// by the two search routes (`first_free=True`), and by nothing else: an alert's
// Run now is a search too and is always charged. /auth/me lists the pool's open
// firsts (`UsageOut.first_free`), and a search that takes or gives one back says
// so in `X-Uses-First-Free: search;0|1`. Wrong in one direction, the note says
// "Uses 1" over a free search, the smaller lie; in the other, it says "Free"
// over a charged one, or enables a Run now at 0 left that the server refuses.
// (a) EXECUTES lib/usesStore.ts: free only for a caller that opts in, not out at
//     0 left while free, both header values, a monthly_limit refusal ending it,
//     an older backend that sends no field, and the admin (no limit) never free.
// (b) The header name the store reads is the one main.py writes, the store's
//     field is the one UsageOut serves, and the backend's FIRST_FREE is "search".
// (c) The Jobs page opts its search in (useUses and both notes), the first-run
//     sheet opts in its search choice alone, and the alerts card's Run now never
//     does: no `firstFree` on its note and no third argument to its useUses.
try {
  const us = runProbeBundle("uses-first-free", `export * from "./lib/usesStore";\n`);
  for (const name of ["setUsage", "noteUsesHeaders", "noteMonthlyLimit", "usesFor", "resetUses"])
    if (typeof us[name] !== "function") throw new Error(`lib/usesStore.ts does not export ${name}`);
  if (us.USES_FIRST_FREE_HEADER !== "X-Uses-First-Free")
    fail(`check 71: lib/usesStore.ts reads the first-free header as ${JSON.stringify(us.USES_FIRST_FREE_HEADER)}`);
  const usage = (over = {}) => ({
    plan: "free", limit: 10, used: 10, remaining: 0, resets_on: "2099-01-01",
    by_feature: {}, passes: {}, first_free: ["search"], ...over,
  });
  const view = (optIn) => us.usesFor("search", undefined, undefined, optIn);
  try {
    us.setUsage(usage());
    const opted = view(true);
    const plain = view(false);
    if (!(opted.free === true && opted.out === false))
      fail(`check 71: an open first search at 0 left reads free=${opted.free} out=${opted.out} for the Jobs page; it must be free and not out`);
    if (!(plain.free === false && plain.out === true))
      fail(`check 71: a control that never offers the free search (Run now) reads free=${plain.free} out=${plain.out} at 0 left; it must be charged and out`);
    if (us.usesFor("tailor", undefined, undefined, true).free !== false)
      fail("check 71: a feature the pool lists no first for reads as free");
    us.noteUsesHeaders({ "x-uses-first-free": "search;0" });
    if (view(true).free !== false || view(true).out !== true)
      fail("check 71: after `X-Uses-First-Free: search;0` the search still reads free");
    us.noteUsesHeaders({ "x-uses-first-free": "search;1" });
    if (view(true).free !== true)
      fail("check 71: after `X-Uses-First-Free: search;1` (a refund) the search does not read free again");
    us.noteUsesHeaders({ "x-uses-first-free": "search;x" });
    if (view(true).free !== true) fail("check 71: a malformed first-free header changed the store");
    us.noteMonthlyLimit({ code: "monthly_limit", feature: "search", plan: "free", limit: 10, used: 10, remaining: 0, resets_on: "2099-01-01" });
    if (view(true).free !== false)
      fail("check 71: a monthly_limit refusal of a search leaves the page calling the search free");
    us.setUsage(usage({ first_free: undefined }));
    if (view(true).free !== false) fail("check 71: an answer with no first_free (an older backend) reads as free");
    us.setUsage(usage({ limit: null, remaining: null, first_free: ["search"] }));
    if (view(true).free !== false) fail("check 71: an account with no monthly limit reads as having a free search");
  } finally {
    us.resetUses();
  }

  // (b) the cross-lane names.
  const mainPy = pySource("app/main.py", "check 71");
  if (mainPy !== null && !/response\.headers\["X-Uses-First-Free"\]\s*=/.test(mainPy))
    fail('check 71: backend/app/main.py writes no response.headers["X-Uses-First-Free"], which the store reads');
  const quotaPy = pySource("app/core/quota.py", "check 71");
  if (quotaPy !== null && !/^FIRST_FREE = \("search",\)/m.test(quotaPy))
    fail('check 71: backend/app/core/quota.py\'s FIRST_FREE is not ("search",), the one feature the UI calls free');
  if (!/\n\s*first_free:\s*string\[\];/.test(decomment(read("types.ts"))))
    fail("check 71: types.ts UsageOut carries no `first_free: string[]`");

  // (c) who opts in.
  const optInProblems = (jobs, sheet, alerts) => {
    const out = [];
    if (!/useUses\(\s*"search"\s*,\s*undefined\s*,\s*true\s*\)/.test(jobs)) out.push("the Jobs page's search does not opt in");
    const jobNotes = [...jobs.matchAll(/<UsesNote\b[^>]*\bfeature="search"[^>]*>/g)].map((m) => m[0]);
    if (!jobNotes.length || jobNotes.some((n) => !/\bfirstFree\b/.test(n))) out.push("a Jobs page search note does not pass firstFree");
    if (!/useUses\(\s*feature\s*,\s*undefined\s*,\s*feature\s*===\s*"search"\s*\)/.test(sheet)) out.push("the first-run sheet does not opt in its search choice alone");
    const alertNotes = [...alerts.matchAll(/<UsesNote\b[^>]*\bfeature="search"[^>]*>/g)].map((m) => m[0]);
    if (!alertNotes.length) out.push("the alerts card has no search note to read");
    if (alertNotes.some((n) => /\bfirstFree\b/.test(n))) out.push("Run now's note claims the free first search");
    if (/useUses\(\s*"search"\s*,[^)]*,/.test(alerts)) out.push("the alerts card's useUses opts in");
    return out;
  };
  const jobsSrc = decomment(read("pages/JobsPage.tsx"));
  const sheetSrc = decomment(read("components/FirstRunSheet.tsx"));
  const alertsSrc = decomment(read("pages/jobs/AlertsCard.tsx"));
  for (const p of optInProblems(jobsSrc, sheetSrc, alertsSrc)) fail(`check 71: ${p}`);
  // Both directions on the reader.
  if (optInProblems(jobsSrc, sheetSrc, alertsSrc.replace('<UsesNote feature="search"', '<UsesNote feature="search" firstFree')).length !== 1 ||
      optInProblems(jobsSrc.replace('useUses("search", undefined, true)', 'useUses("search")'), sheetSrc, alertsSrc).length !== 1)
    fail("check 71's opt-in reader cannot tell a charged Run now or an unopted Jobs search from the shipped shape");
} catch (e) {
  fail(`free first search check (check 71) could not run: ${e.message}`);
}

// ---- 72. Jobs opens on your matches, and the alert form lives in Settings --- //
// PLAN 31.5/3. A return visit to /jobs opened on an empty search form, the saved
// matches were a tab away (History), and the whole alert form sat under the
// search. Now: (a) the page's views are "matches" (the default) and "manual",
// with no History tab, and the matches view renders the saved feed; (b) the
// search card is folded while the feed is unknown or has rows, so a return
// visit opens on jobs rather than folding the form under the thumb when the
// feed lands; (c) the Jobs page mounts AlertSwitch and never AlertsCard, and
// Settings mounts AlertsCard inside `id="alerts"`, which its hash effect
// honours; (d) AlertSwitch's PUT sends the SAVED address, search and reminder
// choice and never `min_score`: that field is full-replace for everything
// else, and its absence is what the server reads as "leave the bar"
// (`AlertSettingsIn.min_score`), so a switch that sent the picker's value would
// reset a chosen bar. Each rule is probed with a planted twin every run.
try {
  const read72 = ({ jobs, settings, alerts }) => {
    const out = [];
    if (!/useState<"matches" \| "manual">\("matches"\)/.test(jobs)) out.push("the Jobs page does not open on its matches");
    if (/key:\s*"history"/.test(jobs) || /mode === "history"/.test(jobs)) out.push("History is a tab again");
    if (!/mode === "matches" && \([\s\S]*?\{renderFeed\(\)\}/.test(jobs)) out.push("the matches view does not render the saved feed");
    if (!/const hasFeed = history === null \|\| history\.length > 0;/.test(jobs) ||
        !/const searchFolded = \(!!searchResult \|\| hasFeed\) && !searching && !editSearch;/.test(jobs))
      out.push("the search card is not folded over a feed that is unknown or has rows");
    if (/<AlertsCard\b/.test(jobs)) out.push("the whole alert form is back on the Jobs page");
    if (!/<AlertSwitch\s*\/>/.test(jobs)) out.push("the Jobs page has no alert switch");
    if (!/<div id="alerts">\s*<AlertsCard\b/.test(settings)) out.push("Settings does not hold the alert form under id=\"alerts\"");
    if (!/hash !== "#danger" && hash !== "#alerts"/.test(settings)) out.push("Settings does not scroll to #alerts");
    let sw = "";
    try {
      sw = fnSource(alerts, "export function AlertSwitch(");
    } catch {
      out.push("AlertsCard.tsx exports no AlertSwitch");
    }
    const put = (sw.match(/updateJobAlert\(\{[\s\S]*?\}\)/) || [""])[0];
    if (sw && !put) out.push("AlertSwitch does not save through updateJobAlert({ … })");
    if (put && /\bmin_score\b/.test(put)) out.push("AlertSwitch sends min_score, which would reset a chosen fit bar");
    if (put && !(/email: settings\.email/.test(put) && /context: settings\.context/.test(put) && /nudge_emails: !!settings\.nudge_emails/.test(put)))
      out.push("AlertSwitch does not send the saved address, search and reminder choice back as they are");
    return out;
  };
  const real = {
    jobs: decomment(read("pages/JobsPage.tsx")),
    settings: decomment(read("pages/SettingsPage.tsx")),
    alerts: decomment(read("pages/jobs/AlertsCard.tsx")),
  };
  for (const p of read72(real)) fail(`check 72: ${p} (PLAN 31.5/3)`);
  const plant = (key, from, to, label) => {
    if (!real[key].includes(from)) throw new Error(`the probe could not plant "${label}"`);
    if (!read72({ ...real, [key]: real[key].replace(from, to) }).length) throw new Error(`the reader passes "${label}"`);
  };
  plant("jobs", 'useState<"matches" | "manual">("matches")', 'useState<"matches" | "manual">("manual")', "a page that opens on Paste / URL");
  plant("jobs", '{ key: "manual", label: t("tabs.manual") },', '{ key: "manual", label: t("tabs.manual") },\n            { key: "history", label: "History" },', "a History tab back");
  plant("jobs", "{renderFeed()}", "{null}", "a matches view without the feed");
  plant("jobs", "const searchFolded = (!!searchResult || hasFeed) && !searching && !editSearch;", "const searchFolded = !!searchResult && !searching && !editSearch;", "the form unfolded over the feed");
  plant("jobs", "<AlertSwitch />", "<AlertsCard resume={master.resume} seedContext={() => null} />", "the whole form back on Jobs");
  plant("settings", '<div id="alerts">', "<div>", "the form without its #alerts target");
  plant("alerts", "nudge_emails: !!settings.nudge_emails,", "nudge_emails: !!settings.nudge_emails,\n          min_score: 75,", "a switch that resets the fit bar");
  plant("alerts", "email: settings.email,", 'email: "",', "a switch that drops the saved address");
} catch (e) {
  fail(`jobs-opens-on-matches check (check 72) could not run: ${e.message}`);
}

// ---- 73. "Not for me": the server matches, the page says so (EXECUTED) ------ //
// PLAN 31.5/4. A hidden posting, company or title word is matched by the SERVER
// alone (app/core/hidden_jobs.py, smoke 31.5/4): the searches and History leave
// them out and count them, and after "Also hide jobs from Acme" the page asks
// POST /jobs/hidden/which about the results it holds instead of matching a company
// itself, one matcher, one answer. (a) EXECUTES `titleWords`, the only thing the
// page decides: which words of a title to OFFER (letters only, three characters or
// more, no filler or bare numbers, first spelling kept, at most four, Hebrew too).
// (b) Every literal hide.* and card.notForMe call resolves in both jobs.json files
// with its full plural set, since a missing `_two` renders English on the Hebrew
// page. (c) By shape: `gone` is set only from the row the user tapped and from
// whichHidden's flags; Undo removes by the keys the server stored; both lists say
// their count; and putHiddenJobs drops the cached History, which it filters.
try {
  const nf = runProbeBundle("not-for-me", `export { titleWords } from "./pages/jobs/NotForMe";\n`, {
    "react-i18next": "export const useTranslation = () => ({ t: (k) => k });",
    "../../components/ui": "export const Button = () => null; export const Modal = () => null;",
    "lucide-react": "export const EyeOff = () => null; export const X = () => null;",
  });
  if (typeof nf.titleWords !== "function") throw new Error("pages/jobs/NotForMe.tsx exports no titleWords");
  for (const [title, want] of [
    ["Senior Java Developer", ["Senior", "Java", "Developer"]],
    // "C#" is two characters and goes: the rule is three or more, whatever the script.
    ["C# / .NET Engineer for the Platform team", ["NET", "Engineer", "Platform", "team"]],
    ["Sales Manager – Sales EMEA", ["Sales", "Manager", "EMEA"]],
    ["נציג/ת מכירות של החברה", ["נציג", "מכירות", "החברה"]],
    ["QA 2 Team Lead 2026", ["Team", "Lead"]],
    ["", []],
  ]) {
    const got = nf.titleWords(title);
    if (JSON.stringify(got) !== JSON.stringify(want))
      fail(`check 73: titleWords(${JSON.stringify(title)}) is ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
  }

  const files = ["pages/jobs/NotForMe.tsx", "pages/JobsPage.tsx", "pages/jobs/cards.tsx"];
  const keys = new Set();
  for (const f of files)
    for (const m of decomment(read(f)).matchAll(/\bt\(\s*"((?:hide\.[\w.]+)|card\.notForMe)"/g)) keys.add(m[1]);
  if (keys.size < 14) throw new Error(`read only ${keys.size} hide.* / card.notForMe keys (expected at least 14)`);
  for (const loc of ["en", "he"]) {
    const bundle = JSON.parse(read(`locales/${loc}/jobs.json`));
    for (const key of keys)
      for (const problem of keyProblems(bundle, key, loc, "the Jobs page's Not for me"))
        fail(`check 73: locales/${loc}/jobs.json ${problem}`);
  }

  const read73 = ({ jobs, client }) => {
    const out = [];
    const sets = [...jobs.matchAll(/\bsetGone\(([^;]*)\);/g)].map((m) => m[1].replace(/\s+/g, " "));
    const fromTap = sets.filter((s) => /new Set\(g\)\.add\(key\)/.test(s)).length;
    const fromServer = sets.filter((s) => /flags\[i\]/.test(s)).length;
    if (!/\bwhichHidden\(/.test(jobs)) out.push("the page does not ask the server which rows the hides cover");
    if (sets.length !== 2 || fromTap !== 1 || fromServer !== 1)
      out.push("`gone` is set from something other than the tapped row and the server's flags");
    const undo = (jobs.match(/async function undoNotice\(\)[\s\S]*?\n  \}\n/) || [""])[0];
    if (!/u !== notice\.url_key/.test(undo) || !/c !== notice\.company_key/.test(undo) || !/notice\.word_keys\.includes\(w\)/.test(undo))
      out.push("Undo does not remove exactly the keys the server stored");
    if ((jobs.match(/<HiddenCount\b/g) || []).length < 2) out.push("a list that hides jobs does not say how many");
    const put = (client.match(/export async function putHiddenJobs[\s\S]*?\n\}/) || [""])[0];
    if (!/invalidateData\(\s*"history"\s*\)/.test(put)) out.push("putHiddenJobs leaves a stale History cached");
    return out;
  };
  const real = { jobs: decomment(read("pages/JobsPage.tsx")), client: decomment(read("api/client.ts")) };
  for (const p of read73(real)) fail(`check 73: ${p} (PLAN 31.5/4)`);
  const plant = (key, from, to, label) => {
    if (!real[key].includes(from)) throw new Error(`the probe could not plant "${label}"`);
    if (!read73({ ...real, [key]: real[key].replace(from, to) }).length) throw new Error(`the reader passes "${label}"`);
  };
  plant("jobs", "setGone(new Set(rows.filter((_, i) => flags[i]).map((m) => normalizeJobUrl(m.url))));",
    "setGone(new Set(rows.filter((m) => hidden?.companies.includes(m.company)).map((m) => normalizeJobUrl(m.url))));",
    "a page that matches companies itself");
  plant("jobs", "urls: base.urls.filter((u) => u !== notice.url_key),", "urls: base.urls.slice(0, -1),", "an Undo that guesses what to remove");
  plant("jobs", "<HiddenCount\n", "<HiddenCountGone\n", "a list that hides without saying so");
  plant("client", 'await api.put<HiddenJobs>("/jobs/hidden", hidden);\n  invalidateData("history");', 'await api.put<HiddenJobs>("/jobs/hidden", hidden);', "a stale History after a hide");
} catch (e) {
  fail(`not-for-me check (check 73) could not run: ${e.message}`);
}

// ---- 74. "Needs you": each chip is a count the page read, one tap from it --- //
// PLAN 31.5/5. At most three chips at the top of Jobs: drafts to review, gone
// quiet, the resume's top fix. Each count must come from the reader its own
// surface uses, or the strip and that surface disagree about one number: the
// Tracker entry's `awaitingReview(kits)`, the tracker's `getStaleApplications()`,
// and the review drawer's `badCount(review.data)`. Nothing renders when nothing
// waits (`if (!chips.length) return null`), each chip opens what it counts (the
// tracker's To review, the tracker, the document's review drawer, which /app
// opens from `{ pane: "review" }`), and every literal needs.* key resolves in both
// jobs.json files with its full plural set. Probed with planted twins every run.
try {
  const read74 = ({ strip, jobs, tailor }) => {
    const out = [];
    if (!/const drafts = awaitingReview\(kits\);/.test(strip)) out.push("the drafts chip does not count with awaitingReview(kits), the Tracker entry's reader");
    if (!/getStaleApplications\(\)/.test(strip)) out.push("the quiet chip does not read the tracker's getStaleApplications()");
    if (!/const fix = badCount\(review\.data\);/.test(strip)) out.push("the fix chip does not count with badCount(review.data), the drawer's own number");
    if (!/if \(!chips\.length\) return null;/.test(strip)) out.push("the strip renders when nothing waits");
    if (!/nav\("\/tracker", \{ state: \{ show: "review" \} \}\)/.test(strip)) out.push("the drafts chip does not open To review");
    if (!/nav\("\/app", \{ state: \{ pane: "review" \} \}\)/.test(strip)) out.push("the fix chip does not open the review");
    if (!/useState<DrawerPane \| null>\(\(\) => \(loc\.state\?\.pane === "review" \? "review" : null\)\)/.test(tailor))
      out.push("/app does not open its review drawer from { pane: \"review\" }");
    if (!/<NeedsYou resume=\{master\.resume\} \/>/.test(jobs)) out.push("the Jobs page does not mount the strip");
    return out;
  };
  const real = {
    strip: decomment(read("pages/jobs/NeedsYou.tsx")),
    jobs: decomment(read("pages/JobsPage.tsx")),
    tailor: decomment(read("pages/TailorPage.tsx")),
  };
  for (const p of read74(real)) fail(`check 74: ${p} (PLAN 31.5/5)`);
  const plant = (key, from, to, label) => {
    if (!real[key].includes(from)) throw new Error(`the probe could not plant "${label}"`);
    if (!read74({ ...real, [key]: real[key].replace(from, to) }).length) throw new Error(`the reader passes "${label}"`);
  };
  plant("strip", "const drafts = awaitingReview(kits);", "const drafts = (kits ?? []).length;", "a drafts count of every kit");
  plant("strip", "const fix = badCount(review.data);", "const fix = review.data?.findings.length ?? 0;", "a fix count of every finding");
  plant("strip", "if (!chips.length) return null;", "", "a strip shown with nothing in it");
  plant("tailor", '(loc.state?.pane === "review" ? "review" : null)', "null", "a fix chip that lands on a closed drawer");

  const keys = [...new Set([...real.strip.matchAll(/\bt\(\s*"(needs\.[\w.]+)"/g)].map((m) => m[1]))];
  if (keys.length < 4) throw new Error(`read only ${keys.length} needs.* keys out of pages/jobs/NeedsYou.tsx (expected 4)`);
  for (const loc of ["en", "he"]) {
    const bundle = JSON.parse(read(`locales/${loc}/jobs.json`));
    for (const key of keys)
      for (const problem of keyProblems(bundle, key, loc, "the Jobs page's needs-you strip"))
        fail(`check 74: locales/${loc}/jobs.json ${problem}`);
  }
} catch (e) {
  fail(`needs-you check (check 74) could not run: ${e.message}`);
}

// ---- 75. every finished step offers the next one ---------------------------- //
// PLAN 31.5/6. A status change used to end in silence (the tracker's chip, the
// job page's chip) or in a View (the document's Mark applied). `useNextStep` is
// the ONE answer: Applied offers the reminder emails in Settings (`#alerts`),
// Interview offers practice for that job (`/interview?app=<id>`, useJobContext),
// each a link to something that exists. Pinned: the hook's two branches and
// their destinations, all three places a status changes calling it (and the two
// chips only on a real change), and its four literal keys in both common.json.
try {
  const read75 = ({ hook, tracker, job, tailor }) => {
    const out = [];
    if (!/status === "applied"[\s\S]*?nav\("\/settings#alerts"\)/.test(hook)) out.push("Applied does not offer the reminder in Settings");
    if (!/status === "interview" && appId !== null[\s\S]*?nav\(`\/interview\?app=\$\{appId\}`\)/.test(hook))
      out.push("Interview does not offer practice for that job");
    if (!/if \(\(updated\.status \|\| status\) !== from\) nextStep\(updated\.status \|\| status, id\);/.test(tracker))
      out.push("the tracker's status chip offers no next step, or offers one on no change");
    if (!/else if \(status !== from\) nextStep\(status, detail\.id\);/.test(job))
      out.push("the job page's status chip offers no next step, or offers one on no change");
    if (!/nextStep\("applied", getTailorState\(\)\.savedAppId\)/.test(tailor)) out.push("the document's Mark applied offers no next step");
    return out;
  };
  const real = {
    hook: decomment(read("hooks/useNextStep.ts")),
    tracker: decomment(read("pages/TrackerPage.tsx")),
    job: decomment(read("pages/JobPage.tsx")),
    tailor: decomment(read("pages/TailorPage.tsx")),
  };
  for (const p of read75(real)) fail(`check 75: ${p} (PLAN 31.5/6)`);
  const plant = (key, from, to, label) => {
    if (!real[key].includes(from)) throw new Error(`the probe could not plant "${label}"`);
    if (!read75({ ...real, [key]: real[key].replace(from, to) }).length) throw new Error(`the reader passes "${label}"`);
  };
  plant("hook", 'nav("/settings#alerts")', 'nav("/settings")', "a reminder link that lands at the top of Settings");
  plant("hook", "nav(`/interview?app=${appId}`)", 'nav("/interview")', "practice without the job");
  plant("tracker", "if ((updated.status || status) !== from) nextStep(updated.status || status, id);", "", "a silent tracker chip");
  plant("job", "else if (status !== from) nextStep(status, detail.id);", "", "a silent job page chip");

  const keys = [...new Set([...real.hook.matchAll(/\bt\(\s*"(next\.[\w.]+)"/g)].map((m) => m[1]))];
  if (keys.length !== 4) throw new Error(`read ${keys.length} next.* keys out of hooks/useNextStep.ts (expected 4)`);
  for (const loc of ["en", "he"]) {
    const bundle = JSON.parse(read(`locales/${loc}/common.json`));
    for (const key of keys)
      if (!resolvesIn(bundle, key)) fail(`check 75: locales/${loc}/common.json is missing "${key}"; the toast would print the raw key`);
  }
} catch (e) {
  fail(`next-step check (check 75) could not run: ${e.message}`);
}

// ---- 76. a resume's language is a share of its words, in both detectors (EXECUTED) //
// PLAN 31.6/1. `resumeLanguage` said "he" for ANY Hebrew letter in the prose, so
// one Hebrew word typed into an English resume turned the whole document RTL on
// the paper, and on the server routed its save over the person's HEBREW resume.
// Both detectors now say "he" when at least one prose word in five is Hebrew,
// with skills voting only while there is no prose (they are English terms in
// most Hebrew resumes). The backend's own cases, `tests/fixtures/lang_cases.json`,
// are run through THIS file here and through `app/core/lang.py` in the smoke
// test, so the paper and the file cannot disagree about a document's direction.
// Four planted twins are probed every run: the old rule, skills voting, a
// plain majority and a threshold of one in six each misread a case.
try {
  // `.vercelignore` keeps `backend/tests` out of the Vercel upload (it holds no
  // runtime code), so there `backend/` is present and the fixture is not: that
  // is this build's shape, like `backend/` absent, and it degrades the same way.
  // The first deploy of this check went red on it (dpl_8Sry4…), and so did the
  // second (dpl_FiDnk…): Vercel removes an ignored path's FILES and leaves its
  // folders, so `backend/tests` exists there, empty. The suite's own file is the
  // signal: no `smoke_test.py`, no tests in this build. A `backend/tests` that
  // holds the suite without this file is a moved file, and `pySource` fails it.
  const testsAbsent =
    fs.existsSync(BACKEND_DIR) && !fs.existsSync(path.join(BACKEND_DIR, "tests", "smoke_test.py"));
  if (testsAbsent && !pySkips.has("check 76")) {
    console.warn(
      "\n  ! check 76 DEGRADED: backend/tests is not in this build (.vercelignore), so\n" +
        "    backend/tests/fixtures/lang_cases.json was NOT read and lib/lang.ts was not run over it.\n" +
        "    CI (.github/workflows/ci.yml) checks the whole repo out, so it runs there.\n",
    );
    pySkips.add("check 76");
  }
  const casesText = testsAbsent ? null : pySource("tests/fixtures/lang_cases.json", "check 76");
  if (casesText !== null) {
    const cases = JSON.parse(casesText).cases;
    if (!Array.isArray(cases) || cases.length < 17)
      throw new Error(`read ${cases?.length} cases out of backend/tests/fixtures/lang_cases.json (expected at least 17)`);
    const langSrc = read("lib/lang.ts");
    const misread76 = (src) => {
      const { resumeLanguage } = runProbeBundle("lang76", src);
      return cases.filter((c) => resumeLanguage(c.resume) !== c.expect).map((c) => c.name);
    };
    for (const name of misread76(langSrc))
      fail(`check 76: lib/lang.ts reads the case "${name}" as the other language; the paper would disagree with the file about its direction (PLAN 31.6/1)`);
    const plant = (from, to, label) => {
      if (!langSrc.includes(from)) throw new Error(`the probe could not plant "${label}"`);
      if (!misread76(langSrc.replace(from, to)).length) throw new Error(`the cases pass "${label}"`);
    };
    const verdict = 'return words && hebrew * HEBREW_SHARE_DEN >= words ? "he" : "en";';
    plant(verdict, 'return hebrew ? "he" : "en";', "any Hebrew letter, the rule this replaced");
    plant(verdict, 'return words && hebrew * 2 > words ? "he" : "en";', "a plain majority");
    plant("const HEBREW_SHARE_DEN = 5;", "const HEBREW_SHARE_DEN = 6;", "a threshold of one word in six");
    plant(
      'const parts: string[] = [resume.summary ?? ""];',
      'const parts: string[] = [resume.summary ?? "", (resume.skills ?? []).join(" ")];',
      "skills voting beside the prose",
    );
  }
} catch (e) {
  fail(`resume-language check (check 76) could not run: ${e.message}`);
}

// ---- 77. the master saves itself, and says so only when it did (EXECUTED) --- //
// PLAN 31.6/2. The Save button, its unsaved count and the explicit commit went:
// every edit and undo saves a pause later, carrying the slot the document came
// from and the version it was made from, so the server can refuse a save that
// would land on the other language's resume or over another tab's (31.6/1). The
// defects pinned are the ones an autosave makes quietly: a save that names no
// version (two tabs are last-write-wins again), an answer about a REPLACED
// resume landing after the replacement, a refused save retried after every
// keystroke, a server copy adopted over a line typed while the save was on the
// wire, and a Keep mine or a Save as my other resume that is coalesced like an
// autosave. (a) EXECUTES the real store with the save recorded; (b) pins the
// page: the loader and an upload record the version the server handed out
// (never the clock's), a hidden page sends the waiting edit, and the bar says
// Saved only about a save that answered. Probed with the store's source and the
// page's mutated.
try {
  const storeSrc = read("state/tailorStore.ts");
  const R77 = (summary) => ({ contact: { name: "Probe" }, summary, experience: [], education: [], skills: [] });
  const masterRun = async (src) => {
    const calls = [];
    let version = 0;
    let refuse = null; // the next save's 409 detail, once
    let gate = null; // a save held on the wire until released
    const st = runProbeBundle("master-autosave", src, {
      "../api/client": {
        analyzeJD: async () => ({ language: "en" }),
        getMasterResume: async () => null,
        saveApplication: async () => ({ id: 1 }),
        saveApplicationDraft: async () => ({ id: 1 }),
        tailorStream: async () => null,
        saveMasterResume: async (p) => {
          calls.push(`PUT:${p.resume.summary}:${p.slot ?? "-"}:${p.base_updated_at ?? "-"}:${p.autosave ? "auto" : "asked"}`);
          if (gate) await gate;
          if (refuse) {
            const detail = refuse;
            refuse = null;
            throw { response: { status: 409, data: { detail } } };
          }
          version++;
          return { resume: p.resume, ledger: null, label: "L", language: p.slot ?? "en", updated_at: `v${version}` };
        },
      },
      "../hooks/useMasterResume": { resetMasterCache: () => {} },
      "../lib/apiError": { apiErrorMessage: (_e, f) => f },
      "../lib/draft": { clearDraft: () => {}, writeDraft: () => {}, sameResume: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
      "../lib/lang": { resumeLanguage: () => "en" },
      "../lib/dataCache": { invalidateData: () => {} },
      "../lib/masterLabel": { masterResumeLabel: () => "Probe's resume" },
      "../lib/templateSpecs": { TEMPLATE_IDS: ["standard"] },
    });
    for (const name of ["applyBlockEdit", "undoBlockEdit", "settleMaster", "flushMasterSave", "resolveMasterConflict", "adoptMaster", "setTailorState", "getTailorState"])
      if (typeof st[name] !== "function") throw new Error(`state/tailorStore.ts does not export ${name}`);
    const seen = [];
    const note = (label) => {
      const s = st.getTailorState();
      seen.push(`${label}=${s.masterSave}${s.masterConflict ? `/${s.masterConflict.kind}` : ""}`);
    };
    st.setTailorState({ resume: R77("r0"), savedResume: R77("r0"), masterStamp: "v0", masterSlot: "en" });
    st.applyBlockEdit(R77("r1"));
    note("waiting"); // saving: the pause has not run out
    st.applyBlockEdit(R77("r2")); // a burst: one save
    await st.settleMaster();
    note("burst");
    st.undoBlockEdit(); // undo is an edit, saved like one
    await st.settleMaster();
    st.applyBlockEdit(R77("r1")); // the same document again: nothing to send
    await st.settleMaster();
    refuse = { kind: "resume_stale", updated_at: "vX" };
    st.applyBlockEdit(R77("r3"));
    await st.settleMaster();
    note("stale");
    st.applyBlockEdit(R77("r4")); // refused as stale: waits for the answer
    await st.settleMaster();
    await st.resolveMasterConflict("keep");
    note("kept");
    refuse = { kind: "resume_slot", slot: "en", language: "he" };
    st.applyBlockEdit(R77("r5"));
    await st.settleMaster();
    note("slot");
    await st.resolveMasterConflict("switch");
    st.applyBlockEdit(R77("r6")); // waiting when the master is replaced
    st.adoptMaster({ resume: R77("w0"), ledger: null, label: "L", language: "en", updated_at: "w0" });
    await st.settleMaster();
    note("replaced");
    let release = () => {};
    gate = new Promise((r) => (release = r));
    st.applyBlockEdit(R77("r8"));
    st.flushMasterSave(); // on the wire...
    await new Promise((r) => setTimeout(r, 0)); // ...and read: the request has left
    st.applyBlockEdit(R77("r9")); // ...while a line is typed
    gate = null;
    release();
    await st.settleMaster();
    await st.settleMaster();
    return `${calls.join(" ")} | ${seen.join(" ")} | screen=${st.getTailorState().resume.summary}`;
  };
  const WANT77 =
    "PUT:r2:en:v0:auto PUT:r1:en:v1:auto PUT:r3:en:v2:auto PUT:r4:en:vX:asked PUT:r5:en:v3:auto PUT:r5:he:-:asked " +
    "PUT:r8:en:w0:auto PUT:r9:en:v5:auto" +
    " | waiting=saving burst=saved stale=conflict/stale kept=saved slot=conflict/slot replaced=idle | screen=r9";
  const real = await masterRun(storeSrc);
  for (const [label, mutated] of [
    ["a save that names no version", storeSrc.replace("...(state.masterStamp !== null ? { base_updated_at: state.masterStamp } : {}),", "")],
    ["a replaced master's waiting edit still sent", storeSrc.replace(/(export function adoptMaster\(m: MasterResume\): void \{[\s\S]*?)newMasterEpoch\(\);/, "$1")],
    ["a stale refusal retried on the next edit", storeSrc.replace('if (state.masterConflict?.kind === "stale") return;', "")],
    ["the server copy adopted over a line typed meanwhile", storeSrc.replace("...(current ? { resume: saved.resume } : {}),", "resume: saved.resume,")],
    ["Keep mine coalesced like an autosave", storeSrc.replace("autosave: !asked,", "autosave: true,")],
  ]) {
    if (mutated === storeSrc) {
      if (real !== WANT77) continue; // the real store already fails; reported below
      throw new Error(`the probe could not plant "${label}"`);
    }
    if ((await masterRun(mutated)) === WANT77) throw new Error(`the run passes "${label}", so it cannot be trusted`);
  }
  if (real !== WANT77)
    fail(
      `check 77: the master's autosave ran [${real}] where [${WANT77}] is right. Each edit and undo is saved a pause ` +
        "later naming its slot and version, a burst is one save, an unchanged document sends nothing, a stale refusal " +
        "waits for the person's answer, an asked-for save is never coalesced, a replaced master's waiting edit is " +
        "dropped, and a line typed during a save survives its answer (PLAN 31.6/2)",
    );

  const read77 = (pg, bar) => {
    const out = [];
    // The loader's own lines, beside its baseline: the upload's save writes the
    // same two after it, and a reader matching either would pass without one.
    if (!/savedResume: m\.resume,[\s\S]{0,300}?masterStamp: m\.updated_at,\s*masterSlot: m\.language === "he" \? "he" : "en",/.test(pg))
      out.push("the master's loader does not record the version and slot it loaded, so an autosave names none");
    if (/adoptMaster\(\{[^}]*updated_at: new Date\(\)/.test(pg))
      out.push("an upload hands adoptMaster a clock time as its version, which the first autosave is refused over");
    if (!/setTailorState\(\{\s*masterLabel: m\.label,\s*masterStamp: m\.updated_at,/.test(pg))
      out.push("an upload's save does not record the version the server handed out");
    if (!/document\.visibilityState !== "hidden"\) return;\s*flushDraftSave\(\);\s*flushMasterSave\(\);/.test(pg))
      out.push("a hidden page does not send the master's waiting edit (iOS discards a background tab)");
    const saved = bar.split('t("edit.autoSaved")').length - 1;
    if (saved !== 1 || !/save === "saved"\s*\?\s*\{[\s\S]{0,160}?t\("edit\.autoSaved"\)/.test(bar))
      out.push("the edit bar says Saved other than once, behind `save === \"saved\"`, so it can call a refused save saved");
    return out;
  };
  const page77 = decomment(read("pages/TailorPage.tsx"));
  const bar77 = decomment(read("components/ResumeEditBar.tsx"));
  const realPage = read77(page77, bar77);
  for (const [label, pg, bar] of [
    ["a loader that forgets the version", page77.replace("masterStamp: m.updated_at,\n            masterSlot", "masterSlot"), bar77],
    ["a hidden page that keeps the edit", page77.replace("flushDraftSave();\n      flushMasterSave();", "flushDraftSave();"), bar77],
    ["Saved said while saving", page77, bar77.replace('save === "saved"\n        ? { icon', 'save !== "failed"\n        ? { icon')],
  ]) {
    if (pg === page77 && bar === bar77) {
      if (realPage.length) continue;
      throw new Error(`the probe could not plant "${label}"`);
    }
    if (!read77(pg, bar).length) throw new Error(`the reader passes "${label}", so it cannot be trusted`);
  }
  for (const p of realPage) fail(`check 77: ${p} (PLAN 31.6/2)`);
} catch (e) {
  fail(`master autosave check (check 77) could not run: ${e.message}`);
}

// ---- 78. the history is on the document, and the add controls are quiet ----- //
// PLAN 31.6/3 and /4. The master's version history opened only from a link on
// the Jobs page, and restored a restore point nobody could see first. It is a
// tool of the document now (the rail, and "⋯" on a phone), on the master only,
// it SHOWS a version whole before Restore is offered, and a restore takes the
// one way in every replacement takes: `adoptMaster` and `resetMasterCache`,
// after the waiting autosave is sent (`settleMaster`), so the state replaced is
// the one on screen. And on a phone every job carried a dashed "+ Add a line"
// and every skill group a "+ Add skill"; below lg only the entry, or the Skills
// section, being edited shows its control now, and an empty contact field is a
// dashed "+ Phone" chip after the filled ones, not a label with a dot after it.
// Four planted twins per half are probed every run.
try {
  const read78 = ({ panel, page, hist, jobs, view, css }) => {
    const out = [];
    if ((panel.match(/\.\.\.\(onHistory \? \[\{ key: "history"/g) ?? []).length !== 2)
      out.push("the history is not one tool on the rail AND under the phone's ⋯, gated on onHistory");
    if (!/onHistory=\{isMaster \? \(\) => setHistoryOpen\(true\) : undefined\}/.test(page))
      out.push("the history is offered on a tailored draft, where a restore would replace a master that is not on screen");
    const modal = /<VersionHistoryModal\b[\s\S]*?\/>/.exec(page);
    if (!modal) out.push("TailorPage mounts no VersionHistoryModal");
    else {
      if (!/beforeRestore=\{settleMaster\}/.test(modal[0])) out.push("a restore does not send the waiting autosave first");
      if (!/resetMasterCache\(\);\s*adoptMaster\(m\);/.test(modal[0]))
        out.push("a restore does not reach both master caches and the document (resetMasterCache, adoptMaster)");
    }
    if (!/disabled=\{!shown\}/.test(hist)) out.push("Restore is offered before the version it restores is shown");
    const preview = /<ResumeView\b[^>]*\/>/.exec(hist);
    if (!preview) out.push("the history renders no ResumeView of the version");
    else if (/on(?:EditBlock|InlineCommit|AddSkill|AddBullet|Add)\b/.test(preview[0])) out.push("the version preview can be edited");
    if (/VersionHistoryModal/.test(jobs)) out.push("the Jobs page still carries its own version history");
    for (const kind of ["exp", "proj", "mil"])
      if (!view.includes(`!editingIn(\`@${kind}.\${i}\`) && "hidden lg:list-item"`))
        out.push(`"+ Add a line" on @${kind} shows below lg whether or not its entry is being edited`);
    if ((view.match(/!editingIn\("@skills"\) && "hidden lg:inline"/g) ?? []).length !== 2)
      out.push('"+ Add skill" shows below lg while no skill is being edited');
    if (!/onPointerDown=\{noteEditing\}/.test(view)) out.push("the paper does not remember the block the person reached for");
    if (!/data-add=""/.test(view)) out.push("an empty contact field is not drawn as a \"+ Field\" chip");
    if (!/\.sheet \[data-add\]\[data-ph\]:empty::before \{\s*content: "\+ " attr\(data-ph\);/.test(css))
      out.push("styles.css draws no \"+\" before an empty contact field's label");
    return out;
  };
  const real = {
    panel: decomment(read("components/DocumentPanel.tsx")),
    page: decomment(read("pages/TailorPage.tsx")),
    hist: decomment(read("components/VersionHistory.tsx")),
    jobs: decomment(read("pages/JobsPage.tsx")),
    view: decomment(read("components/ResumeView.tsx")),
    css: read("styles.css"),
  };
  for (const p of read78(real)) fail(`check 78: ${p} (PLAN 31.6/3-4)`);
  const plant = (key, from, to, label) => {
    if (!real[key].includes(from)) throw new Error(`the probe could not plant "${label}"`);
    if (!read78({ ...real, [key]: real[key].replace(from, to) }).length) throw new Error(`the reader passes "${label}"`);
  };
  plant("page", "onHistory={isMaster ? () => setHistoryOpen(true) : undefined}", "onHistory={() => setHistoryOpen(true)}", "the history on a draft");
  plant("page", "resetMasterCache();\n          adoptMaster(m);", "adoptMaster(m);", "a restore that misses the other cache");
  plant("hist", "disabled={!shown}", "", "Restore before the version is shown");
  plant("view", '!editingIn(`@exp.${i}`) && "hidden lg:list-item"', "false", "every role's add control on a phone");
  plant("view", 'data-add=""', "", "an empty contact field drawn as a label");

  // The history's own words, in the namespace each binding names.
  const histKeys = [...new Set([...real.hist.matchAll(/\bt\("(versions\.[\w.]+)"/g)].map((m) => m[1]))];
  if (histKeys.length < 10) throw new Error(`read ${histKeys.length} versions.* keys out of components/VersionHistory.tsx (expected at least 10)`);
  for (const loc of ["en", "he"]) {
    const jobsNs = JSON.parse(read(`locales/${loc}/jobs.json`));
    for (const key of histKeys)
      if (!resolvesIn(jobsNs, key)) fail(`check 78: locales/${loc}/jobs.json is missing "${key}"; the history would print the raw key`);
    if (!resolvesIn(JSON.parse(read(`locales/${loc}/tailor.json`)), "doc.history.tool"))
      fail(`check 78: locales/${loc}/tailor.json is missing "doc.history.tool"; the tool would print the raw key`);
  }
} catch (e) {
  fail(`history and add-controls check (check 78) could not run: ${e.message}`);
}

// ---- 79. one name per thing, and fewer words (PLAN 31.7) --------------------- //
// The app called one number Fit, Search fit and Match, coverage Keyword match
// and Keyword coverage, a kit a kit and a draft, and the resume a CV 45 times in
// English; a cost note was a sentence and several notes were paragraphs. Pinned
// here, each with a planted twin: (a) no "CV" in the app's English copy (the
// landing is out of Phase 31's scope); (b) none of the retired names, and the
// kept ones where they are; (c) "Uses 1 · N left"; (d) the template note and the
// worldwide option as a line plus "Why?", with their keys; (e) the scan reads the
// saved resume when no file is chosen; (f) a job row's Tailor is secondary, so
// the Jobs page has one primary.
try {
  const APP_NS = ["common", "tailor", "tools", "scan", "auth", "jobs", "tracker", "settings", "interview"];
  const strings = (loc, ns) => {
    const p = path.join(SRC, "locales", loc, `${ns}.json`);
    if (!fs.existsSync(p)) return [];
    const out = [];
    const walk = (o, pre) => {
      for (const [k, v] of Object.entries(o)) {
        const key = pre ? `${pre}.${k}` : k;
        if (typeof v === "string") out.push([key, v]);
        else if (v && typeof v === "object") walk(v, key);
      }
    };
    walk(JSON.parse(fs.readFileSync(p, "utf8")), "");
    return out;
  };
  const en = Object.fromEntries(APP_NS.map((ns) => [ns, strings("en", ns)]));
  if (en.tailor.length < 200 || en.jobs.length < 200) throw new Error("read too few English strings");
  // The privacy page's extension paragraphs describe the INSTALLED extension,
  // whose buttons say "kit" (data-and-privacy.md holds that section to popup.js).
  const EXEMPT = /^privacy\.extension\./;
  const RETIRED = /\b(?:CVs?|Search fit|fit threshold|Keyword coverage|Keyword match|ATS coverage|Save for later|Save to tracker|Kits tab)\b/;
  const read79 = (bundles) => {
    const found = [];
    for (const [ns, list] of Object.entries(bundles))
      for (const [key, v] of list) if (!EXEMPT.test(key) && RETIRED.test(v)) found.push(`${ns}:${key} says "${RETIRED.exec(v)[0]}"`);
    const at = (ns, key) => bundles[ns].find(([k]) => k === key)?.[1];
    if (at("jobs", "card.save") !== "Save" || at("tailor", "save.cta") !== "Save") found.push("Save is not called Save");
    if (at("tailor", "fit.coverage") !== "Keywords" || at("scan", "results.coverage") !== "Keywords") found.push("coverage is not called Keywords");
    if (!/^Uses 1 · \{\{count\}\} left$/.test(at("common", "uses.note_other") ?? "")) found.push('the cost note is not "Uses 1 · N left"');
    for (const [key, v] of bundles.common) if (/^uses\./.test(key) && /you have left this month/.test(v)) found.push(`common:${key} is the long cost sentence`);
    return found;
  };
  for (const f of read79(en)) fail(`check 79: ${f} (PLAN 31.7)`);
  const plantCopy = (ns, key, value, label) => {
    const bundles = { ...en, [ns]: en[ns].map(([k, v]) => (k === key ? [k, value] : [k, v])) };
    if (!en[ns].some(([k]) => k === key)) throw new Error(`the probe could not plant "${label}"`);
    if (!read79(bundles).length) throw new Error(`the reader passes "${label}"`);
  };
  plantCopy("tailor", "doc.review.tool", "Check my CV", "a CV in English");
  plantCopy("jobs", "sort.fit", "Search fit", "a retired name");
  plantCopy("common", "uses.note_other", "This uses 1 of the {{count}} you have left this month.", "the long cost note");

  // (d)-(f), in the files.
  const panel = decomment(read("components/DocumentPanel.tsx"));
  const alerts = decomment(read("pages/jobs/AlertsCard.tsx"));
  const scan = decomment(read("pages/ScanPage.tsx"));
  const cards = decomment(read("pages/jobs/cards.tsx"));
  const readFiles = ({ panel: pn, alerts: al, scan: sc, cards: cd }) => {
    const out = [];
    const why = /<WhyNote\b[\s\S]*?line=\{t\("doc\.screen\.line"\)\}[\s\S]*?why=\{[\s\S]*?t\("doc\.screen\.note"\)[\s\S]*?doc\.screen\.icons[\s\S]*?doc\.screen\.footer[\s\S]*?doc\.screen\.twoColumn[\s\S]*?\/>/;
    if (!why.test(pn)) out.push("the template note is not one line with its gated paragraph under Why?");
    // `[\s{}]*`: a JSX comment between them decomments to an empty `{}`. The gate
    // is "any worldwide board ticked" since 2026-09-28 (LinkedIn or Himalayas;
    // check 100 holds `worldwideBoard` to WORLDWIDE_SOURCES).
    if (!/<\/label>\s*\)\}[\s{}]*allowsRemote\(ctx\?\.work_mode\) && worldwideBoard && \(\s*<WhyNote\b/.test(al))
      out.push("the worldwide option's Why? is not a sibling after its label");
    if (!/const saved = !file && !!master;/.test(sc) || !/\(!!file \|\| saved\)/.test(sc)) out.push("the scan does not default to the saved resume");
    if ((cd.match(/variant="secondary"\s*icon=\{<ArrowRight size=\{14\}/g) ?? []).length !== 2)
      out.push("a job row's Tailor is not secondary, so the Jobs page shows a column of primaries");
    return out;
  };
  const files = { panel, alerts, scan, cards };
  for (const f of readFiles(files)) fail(`check 79: ${f} (PLAN 31.7)`);
  const plantFile = (key, from, to, label) => {
    if (!files[key].includes(from)) throw new Error(`the probe could not plant "${label}"`);
    if (!readFiles({ ...files, [key]: files[key].replace(from, to) }).length) throw new Error(`the reader passes "${label}"`);
  };
  plantFile("scan", "const saved = !file && !!master;", "const saved = false;", "a scan that asks for the file again");
  plantFile("cards", 'variant="secondary"', 'variant="primary"', "a primary Tailor on every row");
  for (const loc of ["en", "he"]) {
    const common = JSON.parse(read(`locales/${loc}/common.json`));
    const tailor = JSON.parse(read(`locales/${loc}/tailor.json`));
    const jobs = JSON.parse(read(`locales/${loc}/jobs.json`));
    for (const [bundle, ns, key] of [
      [common, "common", "why.show"],
      [common, "common", "why.hide"],
      [tailor, "tailor", "doc.screen.line"],
      [jobs, "jobs", "search.worldwideLine"],
      [jobs, "jobs", "search.worldwideWhy"],
    ])
      if (!resolvesIn(bundle, key)) fail(`check 79: locales/${loc}/${ns}.json is missing "${key}"`);
  }
} catch (e) {
  fail(`names and words check (check 79) could not run: ${e.message}`);
}

// ---- 80. the first steps: a download counts, a preview does not (PLAN 31.8) - //
// The server records the first time each person reaches a step (`db/funnel.py`),
// and the admin reads it in Settings. The client half pinned here: only the
// download button's call carries `download=1` (the previews call the same
// /render, and a preview counted as a download would make the number say
// people downloaded who only looked); the list is mounted for the admin alone;
// the privacy page says what is recorded; and every step label resolves in both
// settings.json, one literal key per step. Planted twins are probed every run.
try {
  const read80 = ({ client, settings, card, privacy }) => {
    const out = [];
    const dl = /export async function downloadResume\([\s\S]*?\n\}/.exec(client);
    const blob = /export async function renderResumeBlob\([\s\S]*?\n\}/.exec(client);
    if (!dl || !blob) throw new Error("api/client.ts: downloadResume or renderResumeBlob not found");
    if (!/api\.post\("\/render\?download=1"/.test(dl[0])) out.push("the download button's /render call does not mark a download");
    if (/download=1/.test(blob[0])) out.push("the preview's /render call marks a download");
    if (!/\{user\?\.is_admin && <FunnelCard \/>\}/.test(settings)) out.push("the first-steps list is not the admin's alone");
    if (!/<li>\{t\("privacy\.store\.steps"\)\}<\/li>/.test(privacy)) out.push("the privacy page does not say the first steps are recorded");
    if (!/getFunnel\(\)/.test(card)) out.push("the first-steps card does not read /admin/funnel");
    return out;
  };
  const real = {
    client: decomment(read("api/client.ts")),
    settings: decomment(read("pages/SettingsPage.tsx")),
    card: decomment(read("components/FunnelCard.tsx")),
    privacy: decomment(read("pages/PrivacyPage.tsx")),
  };
  for (const p of read80(real)) fail(`check 80: ${p} (PLAN 31.8)`);
  const plant = (key, from, to, label) => {
    if (!real[key].includes(from)) throw new Error(`the probe could not plant "${label}"`);
    if (!read80({ ...real, [key]: real[key].replace(from, to) }).length) throw new Error(`the reader passes "${label}"`);
  };
  plant("client", 'api.post("/render?download=1"', 'api.post("/render"', "a download that is not marked");
  plant("settings", "{user?.is_admin && <FunnelCard />}", "<FunnelCard />", "the list shown to everyone");
  plant("privacy", '<li>{t("privacy.store.steps")}</li>', "", "a privacy page that does not say so");

  const keys = [...new Set([...real.card.matchAll(/\bt\("(funnel\.[\w.]+)"/g)].map((m) => m[1]))];
  if (keys.length < 10) throw new Error(`read ${keys.length} funnel.* keys out of components/FunnelCard.tsx (expected at least 10)`);
  for (const loc of ["en", "he"]) {
    const settingsNs = JSON.parse(read(`locales/${loc}/settings.json`));
    for (const key of keys) if (!resolvesIn(settingsNs, key)) fail(`check 80: locales/${loc}/settings.json is missing "${key}"`);
    if (!resolvesIn(JSON.parse(read(`locales/${loc}/auth.json`)), "privacy.store.steps"))
      fail(`check 80: locales/${loc}/auth.json is missing "privacy.store.steps"`);
  }
} catch (e) {
  fail(`first-steps check (check 80) could not run: ${e.message}`);
}

// ---- 85. applied jobs never come back: the server leaves them out, the page says so (EXECUTED) //
// Phase 32. A job the tracker holds at applied, interview, offer or rejected is
// left out of every search, the saved matches and the alert mornings by the SERVER
// (app/core/applied_jobs.py, smoke P32), which counts the jobs it left out; the
// page never matches, one matcher, one answer. (a) Every literal applied.* key
// resolves in both jobs.json files with its full plural set. (b) By shape: the
// search's count and the saved matches' count are each said, the latter fed by
// `h.applied`, and no list on the page filters by a tracker status itself (the old
// "Hide applied" toggle was that second matcher, and is deleted). (c) `applied` is
// mirrored on both result types, and read off the backend's models (degraded,
// loudly, without backend/). (d) EXECUTED: the data cache drops the saved matches
// whenever a wrapper drops "applications", since the server filters them by the
// tracker, and does not when it drops something else. Planted twins every run.
try {
  const read85 = ({ jobs, types, models }) => {
    const out = [];
    if (!/<AppliedCount count=\{searchResult\.applied \?\? 0\} \/>/.test(jobs))
      out.push("a search does not say how many jobs it left out as applied to");
    if (!/<AppliedCount count=\{historyApplied\} \/>/.test(jobs) || !/setHistoryApplied\(h\.applied \?\? 0\)/.test(jobs))
      out.push("the saved matches do not say how many they left out as applied to");
    const visible = jobs.match(/const visible = \(list: JobMatch\[\]\) =>[^;]*;/);
    if (!visible) throw new Error("pages/JobsPage.tsx: the `visible` list filter was not found");
    if (/statusFor|application_status|appStatus|isDone/.test(visible[0]) || /\bhideApplied\b/.test(jobs))
      out.push("the page filters jobs by their tracker status itself, a second matcher beside the server's");
    for (const name of ["JobSearchResult", "JobSearchHistory"]) {
      if (!/\bapplied\?: number;/.test(blockAfter(types, `export interface ${name} {`, `types.ts ${name}`)))
        out.push(`types.ts ${name} does not mirror \`applied\``);
      if (models !== null) {
        const m = models.match(new RegExp(`\\nclass ${name}\\(BaseModel\\):\\n([\\s\\S]*?)(?=\\n(?:class |def |[A-Z_]+ = ))`));
        if (!m) throw new Error(`backend/app/models/__init__.py: class ${name} was not found`);
        if (!/^\s+applied: int = 0$/m.test(m[1])) out.push(`the backend's ${name} carries no \`applied: int = 0\``);
      }
    }
    return out;
  };
  // Line endings folded first: a Windows checkout writes CRLF, and a plant or a
  // pattern that names "\n" must read the same text there as on CI.
  const lf = (s) => (s === null ? null : s.replace(/\r\n/g, "\n"));
  const pyModels = pySource("app/models/__init__.py", "check 85");
  const real = {
    jobs: lf(decomment(read("pages/JobsPage.tsx"))),
    types: lf(read("types.ts")),
    models: lf(pyModels),
  };
  for (const p of read85(real)) fail(`check 85: ${p} (Phase 32)`);
  const plant = (key, from, to, label) => {
    if (real[key] === null) return;
    if (!real[key].includes(from)) throw new Error(`the probe could not plant "${label}"`);
    if (!read85({ ...real, [key]: real[key].replace(from, to) }).length) throw new Error(`the reader passes "${label}"`);
  };
  plant("jobs", "<AppliedCount count={historyApplied} />", "", "saved matches that leave jobs out in silence");
  plant("jobs", "<AppliedCount count={searchResult.applied ?? 0} />", "<AppliedCount count={0} />", "a search that leaves jobs out in silence");
  plant(
    "jobs",
    "const visible = (list: JobMatch[]) => list.filter((m) => !m.url || !gone.has(normalizeJobUrl(m.url)));",
    'const visible = (list: JobMatch[]) => list.filter((m) => !m.url || !gone.has(normalizeJobUrl(m.url))).filter((m) => statusFor(m) !== "applied");',
    "a page that hides applied jobs by its own matcher",
  );
  plant(
    "types",
    "  /** Saved rows left out because the user has applied to them since (Phase 32). */\n  applied?: number;\n",
    "",
    "History's count not mirrored",
  );
  plant("models", "    applied: int = 0\n\n\nclass JobSearchHitOut", "\n\nclass JobSearchHitOut", "the search's count gone from the backend");

  const keys = [...new Set([...real.jobs.matchAll(/\bt\(\s*"(applied\.[\w.]+)"/g)].map((m) => m[1]))];
  if (keys.length < 1) throw new Error("read no applied.* key out of pages/JobsPage.tsx");
  for (const loc of ["en", "he"]) {
    const bundle = JSON.parse(read(`locales/${loc}/jobs.json`));
    for (const key of keys)
      for (const problem of keyProblems(bundle, key, loc, "the Jobs page's applied-jobs line"))
        fail(`check 85: locales/${loc}/jobs.json ${problem}`);
    // The reader of the plural set, probed: the Hebrew count without its _two form must be refused.
    if (loc === "he") {
      const lame = JSON.parse(JSON.stringify(bundle));
      delete lame.applied.count_two;
      if (!keyProblems(lame, "applied.count", loc).length) throw new Error("keyProblems passes a Hebrew count without its _two form");
    }
  }

  // (d) EXECUTED: the cached saved matches go when the tracker changes.
  const cacheSrc = read("lib/dataCache.ts");
  const drops85 = async (src) => {
    const dc = runProbeBundle("data-cache-85", src);
    let reads = 0;
    const history = () => dc.cachedFetch("history", async () => ++reads);
    await history();
    await history(); // fresh: served from the cache
    dc.invalidateData("nudges"); // not a source of the saved matches
    await history();
    const afterOther = reads;
    dc.invalidateData("applications", "nudges"); // what every tracker write sends
    await history();
    return { cached: afterOther === 1, dropped: reads === 2 };
  };
  const got85 = await drops85(cacheSrc);
  if (!got85.cached) fail("check 85: lib/dataCache.ts drops the saved matches when an unrelated key is dropped");
  if (!got85.dropped)
    fail("check 85: lib/dataCache.ts keeps the saved matches cached after a tracker write, so a job just marked applied still shows (Phase 32)");
  const derivation = "DERIVED.get(key) ?? []";
  if (!cacheSrc.includes(derivation)) throw new Error("the probe could not plant a cache without its derived keys");
  if ((await drops85(cacheSrc.replace(derivation, "[]"))).dropped)
    throw new Error("the executed probe passes a cache that forgets the saved matches depend on the tracker");
} catch (e) {
  fail(`applied-jobs check (check 85) could not run: ${e.message}`);
}

// ---- 89. every interview answer box can be spoken, and the mic talks to no server //
// Phase 32, "Answer out loud" (2026-09-27; docs/handbook/interview.md). A mic on
// every box where the user types an interview answer, through the browser's OWN
// speech recognition: no model call, no route, no audio through our server. What
// is pinned, each rule with a planted twin probed every run:
//   (a) every <textarea> on the interview page and under pages/interview/ is bound
//       to a `useDictation` on the same value and setter, is read-only while the
//       mic writes into it, sits first in a `relative` wrapper with its Listening
//       badge right after it (so the badge moves nothing), and draws the button
//       and the note; and every send of an answer (`interviewFeedback`,
//       `sendMockAnswer`) cancels the mic first, so what is sent is what the box
//       showed and no word lands after it.
//   (b) lib/dictation.ts, hooks/useDictation.ts and components/Dictation.tsx
//       reach no network and capture no raw audio, and import only from a short
//       list: the privacy page promises the voice never reaches JobFinder.
//   (c) every `dictate.*` key the component reads, and a sentence for every
//       `DictationNote` kind, resolve in both interview.json files.
//   (d) `MAX_ANSWER_KB` is the backend's `max_answer_kb` default, the cap that
//       measures a practice answer and each candidate turn (degrades without
//       backend/).
//   (e) the privacy page says, in both languages, that dictation uses the
//       browser's own speech service and never sends the voice to JobFinder.
try {
  const ANSWER_FILES = [
    "pages/InterviewPage.tsx",
    ...fs
      .readdirSync(path.join(SRC, "pages", "interview"))
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => `pages/interview/${f}`),
  ];
  // From `<textarea` to the end of its opening tag, reading braces, so an arrow's
  // `=>` inside a prop is not the tag's end.
  const openingTag = (src, at) => {
    let depth = 0;
    for (let i = at; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (depth === 0 && c === ">") return { text: src.slice(at, i + 1), end: i + 1, selfClosing: src[i - 1] === "/" };
    }
    throw new Error("an unterminated <textarea");
  };
  const readBoxes = (files) => {
    const out = [];
    let boxes = 0;
    let sends = 0;
    for (const [file, src] of Object.entries(files)) {
      const hooks = [];
      for (const m of src.matchAll(/const (\w+) = useDictation\(\{([\s\S]*?)\}\);/g)) {
        const value = /\bvalue:\s*([\w.]+)/.exec(m[2]);
        const setter = /\bonChange:\s*([\w.]+)/.exec(m[2]);
        if (!value || !setter) throw new Error(`${file}: a useDictation call whose value or onChange cannot be read`);
        hooks.push({ name: m[1], value: value[1], setter: setter[1] });
      }
      for (const m of src.matchAll(/<textarea\b/g)) {
        boxes += 1;
        const tag = openingTag(src, m.index);
        if (!tag.selfClosing) throw new Error(`${file}: a <textarea> with children, which this reader cannot read`);
        const value = /\bvalue=\{\s*([\w.]+)\s*\}/.exec(tag.text);
        const setter = /\bonChange=\{\s*\(\s*(\w+)\s*\)\s*=>\s*([\w.]+)\(\s*\1\.target\.value\s*\)\s*\}/.exec(tag.text);
        if (!value || !setter) throw new Error(`${file}: an answer box whose value or onChange this reader cannot read`);
        const box = `the box on \`${value[1]}\``;
        const hook = hooks.find((h) => h.value === value[1] && h.setter === setter[2]);
        if (!hook) {
          out.push(`${file}: ${box} has no mic (no useDictation({ value: ${value[1]}, onChange: ${setter[2]} }))`);
          continue;
        }
        const d = hook.name;
        if (!tag.text.includes(`readOnly={${d}.listening}`))
          out.push(`${file}: ${box} takes typing while the mic writes into it (readOnly={${d}.listening})`);
        if (!/<div className="relative\b[^"]*">\s*$/.test(src.slice(0, m.index)))
          out.push(`${file}: ${box} is not the first child of a relative wrapper, so its Listening badge has nothing to sit on`);
        if (!new RegExp(`^\\s*<ListeningBadge dictation=\\{${d}\\} />\\s*</div>`).test(src.slice(tag.end)))
          out.push(`${file}: ${box} has no Listening badge on its own edge, right after it in its wrapper`);
        if (!src.includes(`<DictateButton dictation={${d}} />`)) out.push(`${file}: the mic button of ${box} is not drawn`);
        if (!src.includes(`<DictationNote dictation={${d}}`)) out.push(`${file}: the mic's note for ${box} is not drawn`);
      }
      for (const m of src.matchAll(/\b(interviewFeedback|sendMockAnswer)\(/g)) {
        sends += 1;
        const head = src.slice(0, m.index);
        const fns = [...head.matchAll(/\bfunction\s+(\w+)\s*\(/g)];
        if (!fns.length) throw new Error(`${file}: ${m[1]}( is called outside any function this reader can find`);
        const last = fns[fns.length - 1];
        const body = head.slice(last.index);
        if (!hooks.some((h) => body.includes(`${h.name}.cancel();`)))
          out.push(`${file}: ${last[1]}() sends the answer (${m[1]}) without cancelling the mic first, so a word can land after it`);
      }
    }
    if (boxes < 2) throw new Error(`read ${boxes} answer boxes on the interview page (expected at least 2: the practice box and the mock chat)`);
    if (sends < 2) throw new Error(`read ${sends} sends of an answer (expected interviewFeedback and sendMockAnswer)`);
    return out;
  };
  const pages = Object.fromEntries(ANSWER_FILES.map((f) => [f, decomment(read(f))]));
  for (const p of readBoxes(pages)) fail(`check 89: ${p} (Answer out loud)`);
  const plantBox = (file, from, to, label) => {
    if (!pages[file].includes(from)) throw new Error(`the probe could not plant "${label}"`);
    if (!readBoxes({ ...pages, [file]: pages[file].replace(from, to) }).length) throw new Error(`the reader passes "${label}"`);
  };
  plantBox("pages/interview/MockInterview.tsx", "readOnly={dictation.listening}", "", "a box that takes typing while the mic writes");
  plantBox("pages/InterviewPage.tsx", "<DictateButton dictation={dictation} />", "", "a practice box with no mic button");
  plantBox("pages/InterviewPage.tsx", "dictation.cancel();", "", "Get feedback sent with the mic still on");
  plantBox(
    "pages/InterviewPage.tsx",
    "export default function InterviewPage",
    'const Extra = () => <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />;\nexport default function InterviewPage',
    "a new answer box with no mic",
  );
  plantBox(
    "pages/interview/MockInterview.tsx",
    "<ListeningBadge dictation={dictation} />",
    "",
    "a badge that is not on its box",
  );

  // (b) no network, no raw audio, a short import list.
  const MIC_FILES = ["lib/dictation.ts", "hooks/useDictation.ts", "components/Dictation.tsx"];
  const NET = [
    [/\bfetch\s*\(/, "fetch"],
    [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
    [/\bWebSocket\b/, "a WebSocket"],
    [/\bEventSource\b/, "an EventSource"],
    [/\bsendBeacon\b/, "sendBeacon"],
    [/\baxios\b/, "axios"],
    [/\bimport\s*\(/, "a dynamic import"],
    [/\bgetUserMedia\b|\bMediaRecorder\b|\bAudioContext\b/, "raw audio capture"],
  ];
  const IMPORTS_OK = new Set([
    "react",
    "react-i18next",
    "lucide-react",
    "./lang",
    "../lib/cn",
    "../lib/dictation",
    "../lib/inAppBrowser",
    "../hooks/useDictation",
  ]);
  const readNet = (files) => {
    const out = [];
    for (const [file, src] of Object.entries(files)) {
      for (const [re, what] of NET) if (re.test(src)) out.push(`${file} uses ${what}; the mic may reach no server and keep no audio`);
      const from = [...src.matchAll(/^\s*import\b[^;]*?\bfrom\s+"([^"]+)"/gm), ...src.matchAll(/^\s*import\s+"([^"]+)"/gm)].map((m) => m[1]);
      if (!from.length) throw new Error(`read no imports out of ${file}`);
      for (const spec of from) if (!IMPORTS_OK.has(spec)) out.push(`${file} imports "${spec}", which is not on the mic's short list (no API client, no network)`);
    }
    return out;
  };
  const mic = Object.fromEntries(MIC_FILES.map((f) => [f, decomment(read(f))]));
  for (const p of readNet(mic)) fail(`check 89: ${p} (Answer out loud)`);
  const plantNet = (file, from, to, label) => {
    if (!mic[file].includes(from)) throw new Error(`the probe could not plant "${label}"`);
    if (!readNet({ ...mic, [file]: mic[file].replace(from, to) }).length) throw new Error(`the reader passes "${label}"`);
  };
  plantNet("hooks/useDictation.ts", "  return {\n    supported:", '  void fetch("/api/speech");\n  return {\n    supported:', "a fetch from the hook");
  plantNet("components/Dictation.tsx", 'import { cn } from "../lib/cn";', 'import { cn } from "../lib/cn";\nimport { api } from "../api/client";', "the API client imported");
  plantNet("lib/dictation.ts", "  const emit = ", "  const rec2 = new MediaRecorder(stream);\n  const emit = ", "raw audio recorded");

  // (c) every word the mic says, in both languages.
  const comp = mic["components/Dictation.tsx"];
  const bindings = [...comp.matchAll(/useTranslation\(([^)]*)\)/g)].map((m) => m[1].trim());
  if (bindings.length < 3 || bindings.some((b) => b !== '"interview"'))
    fail(`check 89: components/Dictation.tsx reads a namespace other than "interview" (${bindings.join(", ")}); its keys would not resolve`);
  const keys = [...new Set([...comp.matchAll(/\bt\("(dictate\.[\w.]+)"\)/g)].map((m) => m[1]))];
  if (keys.length < 10) throw new Error(`read ${keys.length} dictate.* keys out of components/Dictation.tsx (expected at least 10)`);
  const union = /export type DictationNote =([^;]+);/.exec(mic["lib/dictation.ts"]);
  if (!union) throw new Error("lib/dictation.ts: the DictationNote union was not found");
  const kinds = [...union[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
  if (kinds.length < 6) throw new Error(`read ${kinds.length} DictationNote kinds (expected at least 6)`);
  for (const kind of kinds)
    if (!comp.includes(`dictation.note === "${kind}" && t("dictate.note.${kind}")`))
      fail(`check 89: the note "${kind}" has no sentence in components/Dictation.tsx; the mic would stop and say nothing`);
  for (const loc of ["en", "he"]) {
    const ns = JSON.parse(read(`locales/${loc}/interview.json`));
    for (const key of new Set([...keys, ...kinds.map((k) => `dictate.note.${k}`)]))
      if (!resolvesIn(ns, key)) fail(`check 89: locales/${loc}/interview.json is missing "${key}"; the mic would print the raw key`);
  }

  // (d) the cap is the backend's.
  const capTs = /export const MAX_ANSWER_KB = (\d+);/.exec(mic["lib/dictation.ts"]);
  if (!capTs) throw new Error("lib/dictation.ts: MAX_ANSWER_KB was not found");
  const config = pySource("app/config.py", "check 89");
  if (config !== null) {
    const capPy = /^\s*max_answer_kb:\s*int\s*=\s*(\d+)\s*$/m.exec(config);
    if (!capPy) throw new Error("backend/app/config.py: max_answer_kb was not found");
    if (capPy[1] !== capTs[1])
      fail(`check 89: lib/dictation.ts caps a spoken answer at ${capTs[1]} KB, the backend at ${capPy[1]} KB; the mic would stop early, or fill a box the server refuses`);
    const prompts = pySource("app/llm/prompts.py", "check 89");
    if (!prompts.includes('"answer": _Rule("answer", "max_answer_kb")') || !prompts.includes('_Rule("transcript", "max_transcript_kb", turn_cap="max_answer_kb")'))
      fail("check 89: backend/app/llm/prompts.py no longer caps a practice answer and a mock-interview turn with max_answer_kb; point MAX_ANSWER_KB at the cap that measures them");
  }

  // (e) the privacy page says where the voice goes.
  const VOICE = {
    en: [/\bbrowser's own speech recognition\b/i, /\bGoogle in Chrome\b/, /\bnever to JobFinder\b/, /\bonly when you send\b/i],
    he: [/הדפדפן עצמו/, /Google בכרום/, /לא ל-JobFinder/, /רק כשאתם שולחים/],
  };
  const voiceProblem = (text, rules) =>
    typeof text !== "string" ? "is missing" : rules.some((re) => !re.test(text)) ? "does not say the voice goes to the browser's own speech service and never to JobFinder" : "";
  for (const loc of ["en", "he"]) {
    const why = voiceProblem(JSON.parse(read(`locales/${loc}/auth.json`)).privacy?.ai?.voice, VOICE[loc]);
    if (why) fail(`check 89: locales/${loc}/auth.json "privacy.ai.voice" ${why}`);
  }
  if (!voiceProblem("Your voice goes to the speech service in your browser, and then to JobFinder.", VOICE.en))
    fail("check 89's privacy rule passes a sentence that sends the voice to JobFinder");
  if (!/<p>\{t\("privacy\.ai\.voice"\)\}<\/p>/.test(decomment(read("pages/PrivacyPage.tsx"))))
    fail("check 89: the privacy page does not say where a spoken answer goes (privacy.ai.voice)");
  // No route of ours takes speech.
  if (/["'`]\/[^"'`\n]*(?:speech|dictat|voice|audio)[^"'`\n]*["'`]/i.test(decomment(read("api/client.ts"))))
    fail("check 89: api/client.ts calls a speech route; dictation must stay in the browser");
} catch (e) {
  fail(`answer-out-loud check (check 89) could not run: ${e.message}`);
}

// ---- 90. the mic writes after what was typed, and stops where it should (EXECUTED) //
// Phase 32, "Answer out loud". It runs lib/dictation.ts's controller against a
// scripted recognizer and requires: the heard words go AFTER the typed text, one
// space between, never over it; the settled and the guessed words show as they
// come; tapping off lets the last words land and opens nothing more; a box the
// page changed (an answer sent) is never written again; a cancel lets every later
// word go; the cap stops the mic in UTF-8 bytes (a Hebrew answer meets it at half
// the letters), and a box already at the cap does not open it; every error has
// its note; a session the browser ends by itself after hearing words opens the
// next one, and one that heard nothing stops and says so; Chrome on Android's
// repeated zero-confidence finals are skipped; and the language is the
// question's by its share of words, else the interface's. Eight planted twins of
// the file are probed every run.
try {
  const src90 = read("lib/dictation.ts").replace('from "./lang"', 'from "./lib/lang"');
  if (!src90.includes('from "./lib/lang"')) throw new Error('lib/dictation.ts no longer imports "./lang"; point this probe at its imports');
  const run90 = (src) => {
    const lib = runProbeBundle("dictation90", src);
    const out = [];
    const eq = (got, want, what) => {
      if (JSON.stringify(got) !== JSON.stringify(want)) out.push(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    };
    class FakeRec {
      constructor() {
        FakeRec.made.push(this);
        this.calls = [];
        this.onresult = this.onerror = this.onend = null;
      }
      start() {
        this.calls.push("start");
        if (FakeRec.refuse) throw new Error("refused");
      }
      stop() {
        this.calls.push("stop");
      }
      abort() {
        this.calls.push("abort");
      }
    }
    // [transcript, isFinal, confidence]
    const say = (rec, ...rs) =>
      rec.onresult?.({ resultIndex: 0, results: rs.map(([text, isFinal, confidence = 0.9]) => Object.assign([{ transcript: text, confidence }], { isFinal })) });
    const harness = (typed, opts = {}) => {
      FakeRec.made = [];
      FakeRec.refuse = false;
      const h = { box: typed, writes: [], states: [], lang: opts.lang ?? "en-US" };
      h.ctl = lib.createDictation({
        ctor: FakeRec,
        read: () => h.box,
        write: (text) => {
          h.box = text;
          h.writes.push(text);
        },
        lang: () => h.lang,
        onState: (s) => h.states.push({ ...s }),
        capKb: opts.capKb,
        android: opts.android,
      });
      h.last = () => h.states[h.states.length - 1] ?? { listening: false, note: null };
      h.rec = () => FakeRec.made[FakeRec.made.length - 1];
      return h;
    };

    // After the typed text, one space between, the guessed words shown as they come.
    let h = harness("I led");
    h.ctl.start();
    eq(h.last(), { listening: true, note: null }, "a tap opens the mic");
    let r = h.rec();
    eq([r?.lang, r?.continuous, r?.interimResults, r?.calls.join()], ["en-US", true, true, "start"], "the recognizer is continuous, shows its guesses and listens for the language asked");
    say(r, ["a team", false]);
    eq(h.box, "I led a team", "the first words heard go after the typed text");
    say(r, [" a team of five", true], [" and we", false]);
    eq(h.box, "I led a team of five and we", "settled and guessed words both show, in order");
    if (!h.writes.every((w) => w.startsWith("I led "))) out.push("a write did not keep the typed text in front of it");
    h = harness("");
    h.ctl.start();
    say(h.rec(), ["hello", false]);
    eq(h.box, "hello", "an empty box gets the words with no space before them");
    h = harness("Line one\n");
    h.ctl.start();
    say(h.rec(), ["two", false]);
    eq(h.box, "Line one\ntwo", "a box ending in a line break gets no extra space");

    // Tapping off: the last words land, nothing more opens.
    h = harness("A");
    h.ctl.start();
    r = h.rec();
    say(r, ["b", false]);
    h.ctl.stop();
    eq(h.last().listening, false, "tapping off shows the mic off at once");
    if (!r.calls.includes("stop")) out.push("tapping off does not stop the recognizer");
    say(r, ["b c", true]);
    eq(h.box, "A b c", "the words on their way when the mic was tapped off still land");
    r.onend?.();
    eq(FakeRec.made.length, 1, "a session the person stopped opens no other");

    // The page changed the box (an answer sent): nothing is written over it.
    h = harness("A");
    h.ctl.start();
    r = h.rec();
    say(r, ["b", false]);
    h.box = "";
    say(r, ["b c", true]);
    eq(h.box, "", "a word heard after the box was sent is not written into the empty box");
    eq(h.last().listening, false, "a box the page changed ends the listening");
    if (!r.calls.includes("abort")) out.push("a box the page changed does not stop the recognizer");

    // Cancel: stop now, every later word goes.
    h = harness("A");
    h.ctl.start();
    r = h.rec();
    say(r, ["b", false]);
    h.ctl.cancel();
    say(r, ["b c", true]);
    r.onend?.();
    eq([h.box, h.last().listening, FakeRec.made.length], ["A b", false, 1], "a cancel keeps what the box showed and lets every later word go");
    if (!r.calls.includes("abort")) out.push("a cancel does not abort the recognizer");

    // The cap, in UTF-8 bytes.
    h = harness("", { capKb: 1 });
    h.ctl.start();
    r = h.rec();
    say(r, ["א".repeat(600), false]);
    eq([h.box, h.last()], ["", { listening: false, note: "cap" }], "600 Hebrew letters (1,200 bytes) pass a 1 KB cap: the mic stops and says so");
    if (!r.calls.includes("abort")) out.push("the cap does not stop the recognizer");
    h = harness("", { capKb: 1 });
    h.ctl.start();
    say(h.rec(), ["a".repeat(600), false]);
    eq(h.box.length, 600, "600 English letters (600 bytes) fit a 1 KB cap");
    h = harness("x".repeat(1024), { capKb: 1 });
    h.ctl.start();
    eq([FakeRec.made.length, h.last()], [0, { listening: false, note: "cap" }], "a box already at the cap does not open the mic, and says why");
    h = harness("x".repeat(1022), { capKb: 1 });
    h.ctl.start();
    eq(FakeRec.made.length, 1, "a box with room for one more word opens the mic");
    eq(
      [lib.fitsAnswerCap("x".repeat(16 * 1024)), lib.fitsAnswerCap("x".repeat(16 * 1024 + 1)), lib.fitsAnswerCap("א".repeat(8 * 1024)), lib.fitsAnswerCap("א".repeat(8 * 1024 + 1))],
      [true, false, true, false],
      "the default cap is the server's 16 KB, in bytes",
    );

    // Every error has its note, and none restarts the mic.
    for (const [error, note] of [
      ["not-allowed", "denied"],
      ["service-not-allowed", "service"],
      ["no-speech", "noSpeech"],
      ["network", "network"],
      ["audio-capture", "noMic"],
      ["language-not-supported", "failed"],
      ["aborted", null],
    ]) {
      h = harness("A");
      h.ctl.start();
      r = h.rec();
      r.onerror?.({ error });
      r.onend?.();
      eq([h.last(), FakeRec.made.length], [{ listening: false, note }, 1], `the error "${error}"`);
    }
    h = harness("A");
    FakeRec.refuse = true;
    h.ctl.start();
    eq(h.last(), { listening: false, note: "failed" }, "a recognizer that refuses to start says so");

    // A session the browser ends by itself.
    h = harness("A");
    h.ctl.start();
    const r1 = h.rec();
    say(r1, ["b", true]);
    h.lang = "he-IL";
    r1.onend?.();
    eq(FakeRec.made.length, 2, "a session that heard words and ended by itself opens the next");
    const r2 = h.rec();
    eq(r2?.lang, "he-IL", "the next session reads the language again");
    say(r2, ["c", false]);
    eq(h.box, "A b c", "the next session writes after the words the last one heard");
    r2.onend?.();
    const r3 = h.rec();
    eq(FakeRec.made.length, 3, "and the one after that, while words keep coming");
    r3.onend?.();
    eq([FakeRec.made.length, h.last()], [3, { listening: false, note: "stopped" }], "a session that heard nothing stops, and says the mic stopped");

    // Chrome on Android repeats a final with a confidence of 0.
    h = harness("", { android: true });
    h.ctl.start();
    say(h.rec(), ["one", true, 0.9], ["one", true, 0], ["two", false]);
    eq(h.box, "one two", "on Android a repeated zero-confidence final is skipped");
    h = harness("");
    h.ctl.start();
    say(h.rec(), ["one", true, 0.9], ["one", true, 0], ["two", false]);
    eq(h.box, "one one two", "off Android every result counts");

    // Feature detection, and the language.
    const F1 = function () {};
    const F2 = function () {};
    eq(
      [lib.recognitionCtor({}), lib.recognitionCtor(null), lib.recognitionCtor({ webkitSpeechRecognition: "x" })],
      [null, null, null],
      "no recognizer where the browser has none",
    );
    if (lib.recognitionCtor({ webkitSpeechRecognition: F2 }) !== F2 || lib.recognitionCtor({ SpeechRecognition: F1, webkitSpeechRecognition: F2 }) !== F1)
      out.push("the recognizer is not the browser's own (SpeechRecognition, else webkitSpeechRecognition)");
    eq(
      [
        lib.dictationLang("en", null),
        lib.dictationLang("he", null),
        lib.dictationLang(undefined, ""),
        lib.dictationLang("en", "ספרו על פרויקט שהובלתם"),
        lib.dictationLang("he", "Tell me about a project you led"),
        lib.dictationLang("en", "Tell me about your time at רפאל and what you built there"),
        lib.dictationLang("he", "ספרו לי על הניסיון שלכם עם Kubernetes ו-AWS"),
        lib.dictationLang("he", "1, 2, 3?"),
      ],
      ["en-US", "he-IL", "en-US", "he-IL", "en-US", "en-US", "he-IL", "he-IL"],
      "the language is the question's by its share of words, else the interface's",
    );
    return out;
  };
  for (const p of run90(src90)) fail(`check 90: ${p} (Answer out loud)`);
  const plant = (from, to, label) => {
    if (!src90.includes(from)) throw new Error(`the probe could not plant "${label}"`);
    if (!run90(src90.replace(from, to)).length) throw new Error(`the run passes "${label}"`);
  };
  plant("const next = joinDictation(base, words);", "const next = words;", "words written over the typed text");
  plant("new TextEncoder().encode(text).length", "text.length", "a cap counted in letters");
  plant("if (o.read() !== written) {", "if (false) {", "a word written into a box the page just sent");
  plant("if (wanted && heard && open()) return;", "", "a long answer cut off when the browser ends its session");
  plant("if (wanted && heard && open()) return;", "if (heard && open()) return;", "a mic that opens again after it was tapped off");
  plant("const asked = question ? proseLanguage(question) : null;", "const asked = null;", "the question's language ignored");
  plant("question ? proseLanguage(question)", 'question ? (/[\\u0590-\\u05FF]/.test(question) ? "he" : "en")', "any Hebrew letter making a question Hebrew");
  plant("r.continuous = true;", "r.continuous = false;", "a mic that stops after one sentence");
} catch (e) {
  fail(`answer-out-loud run (check 90) could not run: ${e.message}`);
}

// ---- 95. search in plain words fills the form and never searches (EXECUTED) -- //
// Phase 32. One line ("משרות QA בתל אביב, היברידי") is read by the SERVER into
// the search form's own fields (app/core/search_query.py), and the page applies
// the answer with `applySearchReading`: each field the line said replaces the
// form's, every field it did not say stays exactly as it was. Nothing is
// searched from the box: a search is a monthly use, and a misread line must be
// seen before it costs one. (a) EXECUTES applySearchReading / readingUnderstood.
// (b) By shape: the page's handler fills and opens the form and runs no search,
// the box calls onRead only for a line that said something, and the box sits in
// both states of the search card. Planted twins are probed every run.
try {
  const pw = runProbeBundle(
    "plain-words",
    'export { applySearchReading, readingUnderstood } from "./pages/jobs/shared";\n',
  );
  for (const name of ["applySearchReading", "readingUnderstood"])
    if (typeof pw[name] !== "function") throw new Error(`pages/jobs/shared.ts exports no ${name}`);
  const reading = (over = {}) => ({
    job_titles: [], location: "", work_mode: "", include_worldwide: false, notes: [], used_model: false, ...over,
  });
  const prev = {
    job_title: "Old", job_titles: ["Old", "Older"], location: "Haifa, Israel", work_mode: "onsite", limit: 25,
    sources: ["drushim"], max_age_days: 7, include_worldwide: false,
  };
  const frozen = JSON.stringify(prev);
  const cases = [
    ["a full line over no form", null,
      reading({ job_titles: ["Junior QA"], location: "Tel Aviv, Israel", work_mode: "hybrid" }),
      { job_title: "Junior QA", location: "Tel Aviv, Israel", work_mode: "hybrid", limit: 10, job_titles: ["Junior QA"] }],
    ["a place alone leaves every other field", prev, reading({ location: "Jerusalem, Israel" }),
      { ...prev, location: "Jerusalem, Israel" }],
    ["modes in any order are stored in the one order", prev, reading({ work_mode: "hybrid,remote" }),
      { ...prev, work_mode: "remote,hybrid" }],
    ["all three modes are any", prev, reading({ work_mode: "any" }), { ...prev, work_mode: "any" }],
    ["abroad puts LinkedIn back among chosen boards", prev, reading({ include_worldwide: true, work_mode: "remote" }),
      { ...prev, work_mode: "remote", include_worldwide: true, sources: ["drushim", "linkedin"] }],
    ["abroad over all boards names none", { ...prev, sources: undefined }, reading({ include_worldwide: true }),
      { ...prev, sources: undefined, include_worldwide: true }],
    ["a line that said nothing changes nothing", prev, reading({ notes: ["experience"] }), prev],
    ["at most five titles, blanks dropped", prev, reading({ job_titles: [" A ", "", "B", "C", "D", "E", "F"] }),
      { ...prev, job_title: "A", job_titles: ["A", "B", "C", "D", "E"] }],
  ];
  const canon = (o) => JSON.stringify(o, Object.keys(o ?? {}).sort());
  for (const [label, before, r, want] of cases) {
    const got = pw.applySearchReading(before, r);
    if (canon(got) !== canon(want))
      fail(`check 95: applySearchReading, ${label}: ${JSON.stringify(got)} (expected ${JSON.stringify(want)})`);
  }
  if (JSON.stringify(prev) !== frozen) fail("check 95: applySearchReading changed the form it was handed in place");
  for (const [label, r, want] of [
    ["a title", reading({ job_titles: ["QA"] }), true],
    ["a place", reading({ location: "Haifa, Israel" }), true],
    ["a mode", reading({ work_mode: "remote" }), true],
    ["abroad", reading({ include_worldwide: true }), true],
    ["notes only", reading({ notes: ["region"] }), false],
    ["nothing", reading(), false],
    ["no answer", null, false],
  ])
    if (pw.readingUnderstood(r) !== want) fail(`check 95: readingUnderstood(${label}) is not ${want}`);

  const read95 = ({ jobs, box }) => {
    const out = [];
    const handler = /function onPlainRead\([^)]*\) \{[\s\S]*?\n  \}\n/.exec(jobs);
    if (!handler) throw new Error("pages/JobsPage.tsx: function onPlainRead not found");
    const h = handler[0];
    if (!/setCtx\(\(prev\) => applySearchReading\(prev, reading\)\)/.test(h))
      out.push("the page does not fill its form through applySearchReading");
    if (!/setCustomOpen\(true\)/.test(h) || !/setEditSearch\(true\)/.test(h))
      out.push("the filled fields are not opened for the user to check");
    if (/runSearch\(|startJobSearch\(|searchJobs|updateSearchPrefs\(/.test(h))
      out.push("filling the form runs a search (a monthly use) before the user saw what was read");
    if (/startJobSearch|searchJobs|runSearch|updateSearchPrefs/.test(box))
      out.push("the plain-words box reaches a search");
    if (!/if \(readingUnderstood\(r\)\) onRead\(r\);/.test(box))
      out.push("the box hands the page a reading that said nothing, which would open an unchanged form");
    const mounts = [...jobs.matchAll(/<PlainSearch\b[^>]*\bstate=\{plain\}[^>]*onRead=\{onPlainRead\}/g)].length;
    if (mounts < 2) out.push(`the box is in ${mounts} state(s) of the search card, not both (folded and open)`);
    return out;
  };
  const real = { jobs: decomment(read("pages/JobsPage.tsx")), box: decomment(read("pages/jobs/PlainSearch.tsx")) };
  for (const p of read95(real)) fail(`check 95: ${p} (Phase 32)`);
  const plant = (key, from, to, label) => {
    if (!real[key].includes(from)) throw new Error(`the probe could not plant "${label}"`);
    if (!read95({ ...real, [key]: real[key].replace(from, to) }).length) throw new Error(`the reader passes "${label}"`);
  };
  plant("jobs", "setEditSearch(true);\n  }", "setEditSearch(true);\n    runSearch();\n  }", "a fill that searches");
  plant("jobs", "setCustomOpen(true);", "", "a fill the user never sees");
  plant("box", "if (readingUnderstood(r)) onRead(r);", "onRead(r);", "a box that opens the form on nothing");
  plant("jobs", "<PlainSearch", "<PlainSearchGone", "a box in one state of the card only");
} catch (e) {
  fail(`plain-words fill check (check 95) could not run: ${e.message}`);
}

// ---- 96. the plain-words box: its words, and a phone's keyboard ------------- //
// Every literal `plain.*` key the box reads resolves in both jobs.json files.
// The input is 16 px on a phone (`text-base`, `sm:text-sm` above it): iOS zooms
// the whole page into a smaller focused input, which moves the layout under the
// thumb. The input and its button are 44 px tall (`h-11`), the touch target, and
// the input stops at PLAIN_MAX_CHARS, which at Hebrew's two bytes a character
// must fit the server's `max_search_query_kb`, or the box would let a person
// type a line the server then refuses (its Python half degrades without backend/).
try {
  const box = decomment(read("pages/jobs/PlainSearch.tsx"));
  const keys = [...new Set([...box.matchAll(/\bt\("(plain\.[\w.]+)"/g)].map((m) => m[1]))];
  if (keys.length < 9) throw new Error(`read ${keys.length} plain.* keys out of PlainSearch.tsx (expected at least 9)`);
  for (const loc of ["en", "he"]) {
    const bundle = JSON.parse(read(`locales/${loc}/jobs.json`));
    for (const key of keys)
      for (const problem of keyProblems(bundle, key, loc, "the plain-words search box"))
        fail(`check 96: locales/${loc}/jobs.json ${problem}`);
  }
  const read96 = (src) => {
    const out = [];
    const input = /<input\b[\s\S]*?\/>/.exec(src);
    if (!input) throw new Error("PlainSearch.tsx: no <input>");
    const cls = (/className="([^"]*)"/.exec(input[0]) || [])[1];
    if (cls === undefined) throw new Error("PlainSearch.tsx: the input has no literal className");
    const words = cls.split(/\s+/);
    if (!words.includes("text-base") || words.includes("text-sm"))
      out.push("the input is under 16 px on a phone, which iOS zooms the page into");
    if (!words.includes("h-11")) out.push("the input is under the 44 px touch target");
    if (!/dir="auto"/.test(input[0])) out.push("the input does not take its direction from what is typed");
    if (!/maxLength=\{PLAIN_MAX_CHARS\}/.test(input[0])) out.push("the input has no length limit");
    const button = /<Button\b[\s\S]*?>/.exec(src.slice(input.index));
    if (!button || !/\bh-11\b/.test(button[0])) out.push("the box's button is under the 44 px touch target");
    return out;
  };
  for (const p of read96(box)) fail(`check 96: ${p} (Phase 32)`);
  for (const [from, to, label] of [
    ["text-base", "text-sm", "a 14 px input"],
    ["h-11 w-full", "h-9 w-full", "a short input"],
    ["maxLength={PLAIN_MAX_CHARS}", "", "an input with no limit"],
    ['dir="auto"\n', "\n", "an input with a fixed direction"],
  ]) {
    if (!box.includes(from)) throw new Error(`the probe could not plant "${label}"`);
    if (!read96(box.replace(from, to)).length) throw new Error(`the reader passes "${label}"`);
  }
  const max = Number((/export const PLAIN_MAX_CHARS = (\d+);/.exec(box) || [])[1]);
  if (!(max > 0)) throw new Error("PlainSearch.tsx: PLAIN_MAX_CHARS not found");
  const config = pySource("app/config.py", "check 96");
  if (config !== null) {
    const kb = Number((/max_search_query_kb: int = (\d+)/.exec(config) || [])[1]);
    if (!(kb > 0)) throw new Error("backend/app/config.py: max_search_query_kb not found");
    if (max * 2 > kb * 1024)
      fail(`check 96: the box takes ${max} characters, up to ${max * 2} bytes in Hebrew, over the server's ${kb} KB`);
  }
} catch (e) {
  fail(`plain-words box check (check 96) could not run: ${e.message}`);
}

// ---- 97. the route the box calls, its answer, and every daily cap's sentence //
// (a) `readSearchQuery` posts `{ query }` to the path routes.py mounts, and the
// TypeScript `SearchQueryReading` names exactly the fields of the backend's
// `SearchQueryOut`: a field renamed on one side compiles green and reads
// undefined. (b) Every LITERAL action the backend hands `check_and_count` has
// its own row in apiError's LIMIT_KEYS, whose sentence resolves in both
// common.json files: a new daily cap with no row reads the generic line, the
// defect LIMIT_KEYS was written to stop (32(c) pins five actions by name; this
// reads them all, the plain-words cap included). Degrades without backend/.
try {
  const client = decomment(read("api/client.ts"));
  const fn = /export async function readSearchQuery\([\s\S]*?\n\}/.exec(client);
  if (!fn) throw new Error("api/client.ts: readSearchQuery not found");
  if (!/api\.post<SearchQueryReading>\("\/jobs\/search-query", \{ query \}\)/.test(fn[0]))
    fail("check 97: readSearchQuery does not post { query } to /jobs/search-query");
  const types = read("types.ts");
  const tsBody = /export interface SearchQueryReading \{([\s\S]*?)\n\}/.exec(types);
  if (!tsBody) throw new Error("types.ts: SearchQueryReading not found");
  const tsFields = [...decomment(tsBody[1]).matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]).sort();
  const apiError = decomment(read("lib/apiError.ts"));
  const table = /const LIMIT_KEYS: Record<LimitAction, string> = \{([\s\S]*?)\n\};/.exec(apiError);
  if (!table) throw new Error("lib/apiError.ts: LIMIT_KEYS not found");
  const limitKeys = Object.fromEntries([...table[1].matchAll(/^\s*(\w+): "([\w.]+)"/gm)].map((m) => [m[1], m[2]]));
  if (Object.keys(limitKeys).length < 10) throw new Error(`read ${Object.keys(limitKeys).length} LIMIT_KEYS rows`);
  for (const loc of ["en", "he"]) {
    const common = JSON.parse(read(`locales/${loc}/common.json`));
    for (const [action, key] of Object.entries(limitKeys))
      if (!resolvesIn(common, key)) fail(`check 97: locales/${loc}/common.json is missing "${key}" (daily cap "${action}")`);
  }
  const routes = pySource("app/api/routes.py", "check 97");
  const models = pySource("app/models/__init__.py", "check 97");
  if (routes !== null && models !== null) {
    if (!/@router\.post\("\/jobs\/search-query", response_model=SearchQueryOut\)/.test(routes))
      fail("check 97: routes.py does not mount POST /jobs/search-query answering SearchQueryOut");
    const pyBody = /class SearchQueryOut\(BaseModel\):([\s\S]*?)\n(?=\S)/.exec(models);
    if (!pyBody) throw new Error("app/models: class SearchQueryOut not found");
    const pyFields = [...pyBody[1].matchAll(/^    (\w+): /gm)].map((m) => m[1]).sort();
    if (pyFields.length < 6) throw new Error(`read ${pyFields.length} SearchQueryOut fields`);
    if (JSON.stringify(pyFields) !== JSON.stringify(tsFields))
      fail(`check 97: SearchQueryOut ${JSON.stringify(pyFields)} and types.ts SearchQueryReading ${JSON.stringify(tsFields)} differ`);
    const actions = new Set();
    const pyFiles = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== "__pycache__") walk(p);
        else if (entry.name.endsWith(".py")) pyFiles.push(p);
      }
    };
    walk(path.join(BACKEND_DIR, "app"));
    for (const file of pyFiles)
      for (const m of fs.readFileSync(file, "utf8").matchAll(/\bcheck_and_count\(\s*[\w.]+,\s*\w+,\s*"(\w+)"/g)) actions.add(m[1]);
    if (actions.size < 10 || !actions.has("search_query"))
      throw new Error(`read ${actions.size} literal daily-cap actions out of backend/app (expected at least 10, search_query among them)`);
    for (const action of actions)
      if (!(action in limitKeys))
        fail(`check 97: the backend's daily cap "${action}" has no row in lib/apiError.ts LIMIT_KEYS, so its 429 reads the generic line`);
  }
} catch (e) {
  fail(`plain-words route check (check 97) could not run: ${e.message}`);
}

// ---- 81. every refusal of the Comeet send has a sentence in both locales (EXECUTED) //
// Found in PLAN 31.4/5, fixed 2026-09-27. A refused send (a job's page, PLAN
// 8.4) toasted the server's English sentence, on the Hebrew page too. The server
// now answers `{detail, code, params}`, `code` one of `auto_submit.REFUSAL_CODES`
// (smoke pins that every refusal path raises one), and `lib/sendRefusal.ts` maps
// the code to a `tracker` sentence. Held here, each way round:
// (a) REFUSAL_CODES is read out of the backend (one quoted entry per line), and
//     every code has a row in SEND_REFUSAL_KEYS and no row names a code the server
//     never sends;
// (b) every row, and the fallback, resolves in BOTH tracker.json files, and the
//     en and he sentences of a code name the same {{placeholders}}, each one a
//     value the backend's `SubmitRefused(<code>, …, name=…)` sends, or the toast
//     prints "{{company}}";
// (c) EXECUTED: `sendRefusal` reads the code and the string/number params of a
//     refusal and nothing else (the daily cap's object detail, a network error,
//     a 5xx body), and `sendRefusalKey` answers an unknown code and `constructor`
//     with the fallback, never a function every object inherits;
// (d) the job page's send reads its refusal through the two.
// It degrades only when backend/ is absent, and then runs (b)-(d) over the
// table's own codes. Planted twins are probed every run.
try {
  const table81 = read("lib/sendRefusal.ts");
  const run81 = (src) => runProbeBundle("send-refusal", src);
  const m81 = run81(table81);
  const rows = Object.keys(m81.SEND_REFUSAL_KEYS || {});
  if (rows.length < 10) throw new Error(`lib/sendRefusal.ts: read only ${rows.length} rows of SEND_REFUSAL_KEYS (expected at least 10)`);

  // (a) the backend's codes, and what each one's sentence may name.
  const asPy = pySource("app/core/auto_submit.py", "check 81");
  const routesPy = pySource("app/api/routes.py", "check 81");
  let codes = rows;
  const paramsOf = new Map(); // code -> Set(kwarg names), from every SubmitRefused(...) call
  if (asPy !== null && routesPy !== null) {
    codes = pyTuple(asPy, "REFUSAL_CODES", "backend/app/core/auto_submit.py");
    if (codes.length < 10) throw new Error(`backend/app/core/auto_submit.py: REFUSAL_CODES has only ${codes.length} codes`);
    // A string-aware call reader: the sentences hold parentheses of their own.
    const calls = (src) => {
      const out = [];
      for (let at = src.indexOf("SubmitRefused("); at !== -1; at = src.indexOf("SubmitRefused(", at + 1)) {
        if (/class\s+$/.test(src.slice(Math.max(0, at - 6), at))) continue; // the class statement itself
        let i = at + "SubmitRefused(".length;
        let depth = 1;
        let text = "";
        while (i < src.length && depth > 0) {
          const c = src[i];
          if (c === '"' || c === "'") {
            const q = c;
            text += '""';
            i++;
            while (i < src.length && src[i] !== q) i += src[i] === "\\" ? 2 : 1;
            i++;
            continue;
          }
          if (c === "(") depth++;
          else if (c === ")") depth--;
          if (depth > 0) text += c;
          i++;
        }
        if (depth !== 0) throw new Error("an unclosed SubmitRefused( call in the backend");
        const code = /^\s*"(\w*)"/.exec(src.slice(at + "SubmitRefused(".length));
        if (!code) throw new Error(`a SubmitRefused( call whose code is not a literal: ${src.slice(at, at + 60)}`);
        const kw = new Set([...text.matchAll(/(?<![=!<>])\b([a-z_]\w*)\s*=(?!=)/g)].map((k) => k[1]));
        out.push([code[1], kw]);
      }
      return out;
    };
    const found = [...calls(asPy), ...calls(routesPy)];
    // A floor, so a reader that finds nothing fails loudly (every code being
    // RAISED somewhere is the smoke test's pin, not this one's).
    if (found.length < 10) throw new Error(`read only ${found.length} SubmitRefused( calls out of the backend (expected at least 10)`);
    for (const [code, kw] of found) {
      if (!paramsOf.has(code)) paramsOf.set(code, new Set());
      for (const k of kw) paramsOf.get(code).add(k);
    }
  }
  const missingRow = codes.filter((c) => !rows.includes(c));
  const deadRow = rows.filter((r) => !codes.includes(r));
  for (const c of missingRow)
    fail(`check 81: the send refuses with code "${c}" and lib/sendRefusal.ts has no sentence for it, so the page says only that it failed (PLAN 31.4/5)`);
  for (const r of deadRow) fail(`check 81: lib/sendRefusal.ts has a sentence for "${r}", a code auto_submit.REFUSAL_CODES does not list`);

  // (b) both locales, and the same placeholders, each one the backend sends.
  const holes = (s) => new Set([...String(s).matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((h) => h[1]));
  const at81 = (bundle, key) => key.split(".").reduce((o, k) => (o == null ? o : o[k]), bundle);
  const read81b = (en, he) => {
    const out = [];
    for (const key of [...rows.map((r) => m81.SEND_REFUSAL_KEYS[r]), m81.SEND_REFUSAL_FALLBACK]) {
      for (const [loc, b] of [["en", en], ["he", he]]) if (!resolvesIn(b, key)) out.push(`locales/${loc}/tracker.json is missing "${key}"`);
    }
    for (const code of rows) {
      const key = m81.SEND_REFUSAL_KEYS[code];
      const [e, h] = [holes(at81(en, key)), holes(at81(he, key))];
      if ([...e].some((x) => !h.has(x)) || [...h].some((x) => !e.has(x)))
        out.push(`"${key}" names {{${[...e].join(", ")}}} in English and {{${[...h].join(", ")}}} in Hebrew`);
      if (paramsOf.size)
        for (const x of new Set([...e, ...h]))
          if (!paramsOf.get(code)?.has(x)) out.push(`"${key}" names {{${x}}}, which the backend's SubmitRefused("${code}", …) never sends`);
    }
    return out;
  };
  const en81 = JSON.parse(read("locales/en/tracker.json"));
  const he81 = JSON.parse(read("locales/he/tracker.json"));
  for (const p of read81b(en81, he81)) fail(`check 81: ${p} (PLAN 31.4/5)`);
  {
    const broken = JSON.parse(JSON.stringify(he81));
    broken.job.send.refused.recaptcha = "בדיקת בוטים.";
    if (!read81b(en81, broken).length) throw new Error('the reader passes a Hebrew "recaptcha" sentence that drops {{company}}');
    const unsent = JSON.parse(JSON.stringify(en81));
    unsent.job.send.refused.already_sent = "Already sent to {{company}}.";
    const unsentHe = JSON.parse(JSON.stringify(he81));
    unsentHe.job.send.refused.already_sent = "נשלחה אל {{company}}.";
    if (paramsOf.size && !read81b(unsent, unsentHe).length)
      throw new Error("the reader passes a sentence naming {{company}} for a code the backend sends no company with");
  }

  // (c) the reader and the key, executed.
  const run81c = (m) => {
    const got = [
      JSON.stringify(m.sendRefusal({ response: { data: { detail: "x", code: "recaptcha", params: { company: "Acme", status: 423, extra: { a: 1 } } } } })),
      JSON.stringify(m.sendRefusal({ response: { data: { detail: { code: "daily_limit", action: "submit", cap: 1 } } } })),
      JSON.stringify(m.sendRefusal(new Error("Network Error"))),
      JSON.stringify(m.sendRefusal({ response: { data: "Internal Server Error" } })),
      JSON.stringify(m.sendRefusal({ response: { data: { detail: "Kit not found.", code: "kit_not_found" } } })),
      m.sendRefusalKey("recaptcha"),
      String(m.sendRefusalKey("constructor")),
      m.sendRefusalKey("a_code_from_a_newer_server"),
    ];
    return got.join(" | ");
  };
  const WANT81 = [
    '{"code":"recaptcha","params":{"company":"Acme","status":423}}',
    "null",
    "null",
    "null",
    '{"code":"kit_not_found","params":{}}',
    "job.send.refused.recaptcha",
    "job.send.error",
    "job.send.error",
  ].join(" | ");
  const real81c = run81c(m81);
  if (real81c !== WANT81)
    fail(`check 81: lib/sendRefusal.ts answers [${real81c}] where [${WANT81}] is right (PLAN 31.4/5)`);
  for (const [label, from, to] of [
    ["a key lookup that answers `constructor`", "Object.prototype.hasOwnProperty.call(SEND_REFUSAL_KEYS, code) ? SEND_REFUSAL_KEYS[code] : SEND_REFUSAL_FALLBACK", "SEND_REFUSAL_KEYS[code] ?? SEND_REFUSAL_FALLBACK"],
    ["a reader that keeps any param", 'if (typeof v === "string" || typeof v === "number") params[k] = v;', "params[k] = v as string;"],
  ]) {
    if (!table81.includes(from)) throw new Error(`the probe could not plant "${label}"`);
    if (run81c(run81(table81.replace(from, to))) === WANT81) throw new Error(`the run passes "${label}", so it cannot be trusted`);
  }
  {
    const lessTable = table81.replace(/^\s*kit_flagged: "job\.send\.refused\.kit_flagged",\n/m, "");
    if (lessTable === table81) throw new Error('the probe could not plant "a table without kit_flagged"');
    const lessRows = Object.keys(run81(lessTable).SEND_REFUSAL_KEYS);
    if (codes.every((c) => lessRows.includes(c))) throw new Error('the comparison passes "a table without kit_flagged"');
  }

  // (d) the job page's send reads its refusal through the two.
  const read81d = (page) => {
    const send = fnSource(page, "function SendSection(");
    return /const refusal = sendRefusal\(e\);/.test(send) &&
      /refusal \? t\(sendRefusalKey\(refusal\.code\), refusal\.params\) : apiErrorMessage\(e, t\("job\.send\.error"\)\)/.test(send)
      ? []
      : ["the job page's send does not read a refusal through sendRefusal and sendRefusalKey, so a Hebrew page shows the server's English"];
  };
  const page81 = decomment(read("pages/JobPage.tsx"));
  for (const p of read81d(page81)) fail(`check 81: ${p} (PLAN 31.4/5)`);
  const planted81 = page81.replace("const refusal = sendRefusal(e);", "const refusal = null;");
  if (planted81 === page81 || !read81d(planted81).length) throw new Error('the reader passes "a send that ignores the code"');
} catch (e) {
  fail(`send refusal check (check 81) could not run: ${e.message}`);
}

// ---- 82. a tracker card's controls stay inside the card, at 44 px ---------- //
// Found in PLAN 31.4/5, fixed 2026-09-27. On the board's five columns (from xl)
// a card is 179 px wide, and its third row held the date beside a group of two
// controls, the status chip and "Interviewed", that could not wrap: side by
// side they need about 175 px of the card's 149, so "Interviewed" ran 9 px past
// the card's edge in the Interview column at 1440 (1 px in Applied), measured.
// The group now WRAPS (`flex-wrap`, with `min-w-0` so it may be narrower than
// its content), and each control is a box of at least 44 px (`min-h-11`)
// around its small face, the owner's touch-target floor: they were 24 and
// 23 px tall on a phone. Pinned by shape on AppCard, with planted twins.
try {
  const MIN44 = /\bmin-h-(?:1[1-9]|[2-9]\d|\[(?:4[4-9]|[5-9]\d|\d{3,})px\])(?=\s|"|$)/;
  const read82 = (src) => {
    const out = [];
    const card = fnSource(src, "function AppCard(");
    const at = card.indexOf("<FlipStatusChip");
    if (at === -1) throw new Error("pages/TrackerPage.tsx: AppCard renders no <FlipStatusChip>");
    const classes = [...card.slice(0, at).matchAll(/className="([^"]*)"/g)].map((m) => m[1]);
    if (classes.length < 2) throw new Error("pages/TrackerPage.tsx: cannot read the two wrappers around AppCard's status chip");
    const [group, box] = classes.slice(-2);
    if (!/\bflex-wrap\b/.test(group) || !/\bmin-w-0\b/.test(group))
      out.push("the status chip's group cannot wrap (`flex-wrap` and `min-w-0`), so on the board's 179 px card \"Interviewed\" runs past the edge");
    if (!MIN44.test(box)) out.push("the status chip's box is under 44 px tall (`min-h-11`)");
    const btn = /<button\b(?:(?!<\/button>)[\s\S])*?\{t\("interviewed"\)\}/.exec(card);
    if (!btn) throw new Error("pages/TrackerPage.tsx: AppCard has no <button> rendering t(\"interviewed\")");
    // The first className after `<button` (an arrow's `=>` in onClick is not the tag's end).
    const btnClass = /^<button\b[\s\S]*?className="([^"]*)"/.exec(btn[0]);
    if (!btnClass) throw new Error("pages/TrackerPage.tsx: cannot read the Interviewed button's className");
    if (!MIN44.test(btnClass[1])) out.push("the Interviewed toggle is under 44 px tall (`min-h-11`)");
    return out;
  };
  const tracker = decomment(read("pages/TrackerPage.tsx"));
  for (const p of read82(tracker)) fail(`check 82: ${p} (PLAN 31.4/5)`);
  const plant82 = (from, to, label) => {
    if (!tracker.includes(from)) throw new Error(`the probe could not plant "${label}"`);
    if (!read82(tracker.replace(from, to)).length) throw new Error(`the reader passes "${label}", so it cannot be trusted`);
  };
  plant82("relative z-10 flex min-w-0 flex-wrap items-center", "relative z-10 flex items-center", "a group that cannot wrap");
  plant82("relative inline-flex min-h-11 items-center gap-0.5", "relative inline-flex items-center gap-0.5", "a 24 px status chip");
  plant82("group/iv inline-flex min-h-11 items-center", "group/iv inline-flex items-center", "a 23 px Interviewed toggle");
  if (MIN44.test("min-h-10") || MIN44.test("min-h-[40px]") || !MIN44.test("min-h-[48px]"))
    throw new Error("the 44 px reader misreads min-h-10, min-h-[40px] or min-h-[48px]");
} catch (e) {
  fail(`tracker card controls check (check 82) could not run: ${e.message}`);
}

// ---- 83. a long job link survives sign-in, and the rules do not move (EXECUTED) //
// Found in PLAN 31.4/6, fixed 2026-09-27. An alert email links a job as
// `/jobs?open=<the posting's URL, quoted whole>`; a posting URL over about 450
// characters made that `next` longer than MAX_NEXT (512, the backend twin's),
// both validators refused it, and a signed-out click landed on /app with the job
// gone. The ceiling stays (it bounds what the anonymous Google door stores): the
// tab keeps a destination too long for `next` in sessionStorage and sends its
// path plus `?jf_next=<ref>`, which AppLayout's guard puts back after sign-in.
// (a) EXECUTES lib/safeNext.ts on a 620-character posting: the `next` that
//     `authRedirectUrl` builds fits and passes `safeNext` whole, and
//     `takeLongNext` on the page it lands on gives back the exact address, whose
//     `open` is the posting, once; a short destination is unchanged and stores
//     nothing; an auth page passes its own `next` along.
// (b) EXECUTES the refusals: `safeNext` still refuses the long link itself, and
//     an off-site, protocol-relative and `javascript:` value; `takeLongNext`
//     follows nothing for a ref this tab never stored, another ref, a stored value
//     over an hour old, a stored off-site or script value, or one for another
//     page, and drops the parameter from the address instead; storage refused
//     sends the path alone.
// (c) Pins AppLayout's guard: the destination is put back through takeLongNext
//     before the shell renders, on both of its branches.
// Planted twins every run.
try {
  const snSrc = read("lib/safeNext.ts");
  const posting =
    "https://www.comeet.com/jobs/lumen-payments/A1.001/" +
    "%D7%9E%D7%94%D7%A0%D7%93%D7%A1-%D7%AA%D7%95%D7%9B%D7%A0%D7%94-".repeat(9) +
    "backend/B1.011?utm_source=alert&utm_medium=email";
  if (posting.length < 600) throw new Error("check 83's posting fixture is under 600 characters");
  const saved83 = { window: globalThis.window, sessionStorage: globalThis.sessionStorage };
  const run83 = (src) => {
    const sn = runProbeBundle("safenext-long", src);
    const out = [];
    const at = (pathname, search, hash = "") => {
      globalThis.window = { location: { origin: "https://app.example", pathname, search, hash } };
    };
    const store = memoryStorage();
    globalThis.sessionStorage = store;
    try {
      // (a) the long link, round trip.
      const search = `?open=${encodeURIComponent(posting)}`;
      at("/jobs", search);
      const here = `/jobs${search}`;
      const login = sn.authRedirectUrl("/login");
      const next = new URLSearchParams(login.slice(login.indexOf("?"))).get("next") ?? "";
      out.push(next.length <= 512 && sn.safeNext(next) === next ? "fits" : `next ${next.length} chars, safeNext ${sn.safeNext(next)}`);
      const m = /^\/jobs\?jf_next=([0-9a-f]{16})$/.exec(next);
      out.push(m ? "marker" : `not a marker: ${next.slice(0, 40)}`);
      const back = m ? sn.takeLongNext("/jobs", `?jf_next=${m[1]}`) : null;
      out.push(back === here && new URLSearchParams(back.slice(5)).get("open") === posting ? "restored" : `restored ${String(back).slice(0, 40)}`);
      out.push(m && sn.takeLongNext("/jobs", `?jf_next=${m[1]}`) === "/jobs" ? "once" : "twice");
      // a short one, and an auth page.
      at("/app", "?tailor_app=42");
      const short = sn.authRedirectUrl("/login");
      out.push(short === `/login?next=${encodeURIComponent("/app?tailor_app=42")}` && store.getItem(sn.LONG_NEXT_KEY) === null ? "short" : `short ${short}`);
      at("/signup", `?next=${encodeURIComponent("/jobs?jf_next=0123456789abcdef")}`);
      out.push(sn.authRedirectUrl("/login") === `/login?next=${encodeURIComponent("/jobs?jf_next=0123456789abcdef")}` ? "passed" : "not passed");
      // (b) the refusals.
      out.push(sn.safeNext(here) === "/app" ? "ceiling" : "long kept");
      out.push(["//evil.example/jobs", "https://evil.example/jobs", "javascript:alert(1)"].every((v) => sn.safeNext(v) === "/app") ? "offsite" : "offsite kept");
      out.push(sn.takeLongNext("/jobs", "?x=1") === null ? "none" : "acted");
      at("/jobs", "");
      const put = (v) => store.setItem(sn.LONG_NEXT_KEY, JSON.stringify(v));
      const now = Date.now();
      const cases = [
        ["nothing stored", null],
        ["another ref", { ref: "ffffffffffffffff", next: here, at: now }],
        ["stale", { ref: "0123456789abcdef", next: here, at: now - 2 * 3600_000 }],
        ["off-site", { ref: "0123456789abcdef", next: "//evil.example/jobs", at: now }],
        ["script", { ref: "0123456789abcdef", next: "javascript:alert(1)", at: now }],
        ["another page", { ref: "0123456789abcdef", next: "/tracker?x=1", at: now }],
      ];
      for (const [label, v] of cases) {
        store.clear();
        if (v) put(v);
        const got = sn.takeLongNext("/jobs", "?x=1&jf_next=0123456789abcdef");
        out.push(got === "/jobs?x=1" ? label : `${label} -> ${String(got).slice(0, 30)}`);
      }
      // storage refused: the path alone.
      globalThis.sessionStorage = { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => {} };
      at("/jobs", search);
      out.push(sn.authRedirectUrl("/login") === `/login?next=${encodeURIComponent("/jobs")}` ? "path" : "no path");
    } finally {
      globalThis.window = saved83.window;
      globalThis.sessionStorage = saved83.sessionStorage;
    }
    return out.join(",");
  };
  const WANT83 = "fits,marker,restored,once,short,passed,ceiling,offsite,none,nothing stored,another ref,stale,off-site,script,another page,path";
  const real83 = run83(snSrc);
  if (real83 !== WANT83) fail(`check 83: lib/safeNext.ts answers [${real83}] where [${WANT83}] is right (PLAN 31.4/6)`);
  for (const [label, from, to] of [
    ["a next that is never shortened", "  if (here.length <= MAX_NEXT) return here;", "  return here;"],
    ["a take that ignores the ref", "if (v.ref !== ref || typeof v.next", "if (typeof v.next"],
    ["a take that follows another page", " || new URL(safe, window.location.origin).pathname !== pathname) return without;", ") return without;"],
    ["a take that trusts storage", "    const safe = checkNext(v.next, LONG_NEXT_MAX);\n    if (safe === FALLBACK ||", "    const safe = v.next;\n    if ("],
    ["a raised ceiling", "const MAX_NEXT = 512;", "const MAX_NEXT = 4096;"],
  ]) {
    if (!snSrc.includes(from)) throw new Error(`the probe could not plant "${label}"`);
    if (run83(snSrc.replace(from, to)) === WANT83) throw new Error(`the run passes "${label}", so it cannot be trusted`);
  }

  // (c) the guard puts the destination back before the shell renders.
  const read83 = (layout) => {
    const out = [];
    const shell = /const shellFor = \(\) => \{([\s\S]*?)\n\s*\};/.exec(layout);
    if (!shell) return ["AppLayout's guard has no shellFor that puts a long destination back"];
    if (!/const back = takeLongNext\(window\.location\.pathname, window\.location\.search, window\.location\.hash\);\s*if \(back !== null\) navigate\(back, \{ replace: true \}\);\s*setAuthed\(true\);/.test(shell[1]))
      out.push("shellFor does not put the destination back (takeLongNext, then navigate with replace) before setAuthed(true)");
    if ((layout.match(/setAuthed\(true\)/g) || []).length !== 1) out.push("a guard branch renders the shell without shellFor");
    if ((layout.match(/\bshellFor\(\);/g) || []).length < 2) out.push("shellFor is not called on both of the guard's branches");
    return out;
  };
  const layout83 = decomment(read("layouts/AppLayout.tsx"));
  for (const p of read83(layout83)) fail(`check 83: ${p} (PLAN 31.4/6)`);
  const plant83 = (from, to, label) => {
    if (!layout83.includes(from)) throw new Error(`the probe could not plant "${label}"`);
    if (!read83(layout83.replace(from, to)).length) throw new Error(`the reader passes "${label}"`);
  };
  plant83("if (back !== null) navigate(back, { replace: true });", "", "a guard that never puts it back");
  plant83("        if (!live) return;\n        shellFor();", "        if (!live) return;\n        setAuthed(true);", "a failed-open guard that skips it");
} catch (e) {
  fail(`long job link check (check 83) could not run: ${e.message}`);
}

// ---- 84. "Needs you" is one row on a phone ----------------------------------- //
// Found in PLAN 31.5/5, fixed 2026-09-27. With all three chips the strip WRAPPED
// (`flex flex-wrap`): two rows at 390 px, three at 360 in Hebrew, which moved the
// first saved job from y = 489 to 533 (597 at 360 in Hebrew), and the review's
// chip, which answers last, dropped the second row in under the thumb about
// 0.4 s after the first job was drawn. The strip is one row that scrolls
// sideways now: `flex` with `overflow-x-auto` and never `flex-wrap`, each item
// `shrink-0` and each label `whitespace-nowrap` (a label that wrapped inside its
// chip would make the row taller instead), no scrollbar drawn, the focus ring
// INSET (a scroller clips an outer ring), and each chip a 44 px target. Pinned
// by shape on the file, with planted twins.
try {
  const MIN44_84 = /\bmin-h-(?:1[1-9]|[2-9]\d|\[(?:4[4-9]|[5-9]\d|\d{3,})px\])(?=\s|"|$)/;
  const read84 = (src) => {
    const out = [];
    const ul = /<ul\b[\s\S]*?className="([^"]*)"[\s\S]*?>/.exec(src);
    if (!ul) throw new Error("pages/jobs/NeedsYou.tsx: cannot read the strip's <ul className>");
    const row = ul[1].split(/\s+/);
    if (row.some((c) => /(^|:)flex-wrap$/.test(c))) out.push("the strip wraps (`flex-wrap`), so three chips are two rows on a phone");
    if (!row.includes("flex") || !row.includes("overflow-x-auto"))
      out.push("the strip is not one sideways-scrolling row (`flex overflow-x-auto`)");
    if (!row.includes("[scrollbar-width:none]") || !row.includes("[&::-webkit-scrollbar]:hidden"))
      out.push("the strip draws a scrollbar under the chips");
    const li = /<li\b[^>]*className="([^"]*)"/.exec(src);
    if (!li || !li[1].split(/\s+/).includes("shrink-0")) out.push("a chip's <li> can shrink (`shrink-0`), so a label is squeezed");
    const btn = /<button\b[\s\S]*?className="([^"]*)"/.exec(src);
    if (!btn) throw new Error("pages/jobs/NeedsYou.tsx: cannot read the chip's <button className>");
    const b = btn[1].split(/\s+/);
    if (!b.includes("whitespace-nowrap")) out.push("a chip's label can wrap inside it (`whitespace-nowrap`), which makes the row taller");
    if (!MIN44_84.test(btn[1])) out.push("a chip is under 44 px tall (`min-h-11`)");
    if (b.includes("focus-visible:ring-2") && !b.includes("focus-visible:ring-inset"))
      out.push("a chip's focus ring is outside it, where the scroller clips it (`focus-visible:ring-inset`)");
    return out;
  };
  const strip = decomment(read("pages/jobs/NeedsYou.tsx"));
  for (const p of read84(strip)) fail(`check 84: ${p} (PLAN 31.5/5)`);
  const plant84 = (from, to, label) => {
    if (!strip.includes(from)) throw new Error(`the probe could not plant "${label}"`);
    if (!read84(strip.replace(from, to)).length) throw new Error(`the reader passes "${label}", so it cannot be trusted`);
  };
  plant84("-mx-4 flex gap-1.5 overflow-x-auto", "-mx-4 flex flex-wrap gap-1.5 overflow-x-auto", "a strip that wraps");
  plant84("-mx-4 flex gap-1.5 overflow-x-auto", "-mx-4 flex gap-1.5", "a strip that neither wraps nor scrolls");
  plant84('<li key={key} className="shrink-0">', "<li key={key}>", "chips that shrink");
  plant84("min-h-11 items-center gap-1.5 whitespace-nowrap", "min-h-[36px] items-center gap-1.5 whitespace-nowrap", "36 px chips");
  plant84("focus-visible:ring-inset ", "", "a focus ring the scroller clips");
} catch (e) {
  fail(`needs-you row check (check 84) could not run: ${e.message}`);
}

// ---- 87. the board's competition line says what the board said (EXECUTED) --- //
// Phase 32. LinkedIn's guest page states how many people applied, and the server
// reads it (`providers.linkedin.linkedin_applicants`) into `Applicants {kind, n,
// source, read_at}`. `applicantsText` in pages/jobs/shared.ts is the ONE wording
// every surface uses. EXECUTED with a recording `t`, for every kind the backend
// can send (`APPLICANTS_KINDS`, read out of app/models, degraded without backend/):
// each kind asks its OWN literal key, passes the number the board stated and the
// board's name; an unknown kind, no reading, a reading that names no board and a
// number that is not a whole count say NOTHING, since `t()` on a missing key
// renders the key and a number with no board is a claim we cannot attribute.
// Every key it asks resolves in both jobs.json files with its full plural set
// (`keyProblems`), and every form of it prints `{{board}}` and the number it was
// handed: a Hebrew sentence that dropped `{{board}}` would call LinkedIn's count
// everyone's. Six planted twins are judged every run and must each go red.
try {
  const RECORD = (key, opts) => `${key}|${JSON.stringify(opts ?? {})}`;
  const judge87 = (fn, bundles, kinds) => {
    const out = [];
    const asked = new Map(); // kind -> [key, opts]
    for (const [kind, n] of kinds.map((k, i) => [k, [25, 200, 131][i] ?? 7])) {
      const text = fn({ kind, n, source: "linkedin", read_at: "2026-09-27T10:00:00Z" }, RECORD);
      if (!text) {
        out.push(`says nothing for the backend's kind "${kind}"`);
        continue;
      }
      const [key, raw] = [text.slice(0, text.indexOf("|")), text.slice(text.indexOf("|") + 1)];
      const opts = JSON.parse(raw);
      if (!/^card\.applicants\w*$/.test(key)) out.push(`asks "${key}" for "${kind}", not a card.applicants* key`);
      if (opts.board !== "LinkedIn") out.push(`does not name the board for "${kind}" (board: ${JSON.stringify(opts.board)})`);
      if (opts.n !== n && opts.count !== n) out.push(`does not pass the board's number for "${kind}"`);
      asked.set(kind, [key, opts]);
    }
    const keys = [...asked.values()].map(([k]) => k);
    if (new Set(keys).size !== keys.length) out.push(`two kinds share one sentence (${keys.join(", ")})`);
    for (const [label, reading] of [
      ["an unknown kind", { kind: "about", n: 3, source: "linkedin", read_at: "" }],
      ["no reading", null],
      ["an absent reading", undefined],
      ["a reading that names no board", { kind: "count", n: 131, source: "", read_at: "" }],
      ["a fractional number", { kind: "count", n: 1.5, source: "linkedin", read_at: "" }],
      ["a negative number", { kind: "over", n: -1, source: "linkedin", read_at: "" }],
    ])
      if (fn(reading, RECORD)) out.push(`says something for ${label}`);
    for (const [loc, b] of Object.entries(bundles))
      for (const [kind, [key, opts]] of asked) {
        for (const problem of keyProblems(b, key, loc, "a job card's competition line")) out.push(`${loc}: ${problem}`);
        const parts = key.split(".");
        const leaf = parts.pop();
        const parent = parts.reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), b) || {};
        const forms = Object.entries(parent).filter(([k]) => k === leaf || k.startsWith(`${leaf}_`));
        const num = "count" in opts ? "{{count}}" : "{{n}}";
        for (const [k, v] of forms) {
          if (!String(v).includes("{{board}}")) out.push(`${loc} ${parts.join(".")}.${k} does not name the board`);
          // Hebrew "one" is written in words ("מועמד אחד"), as English "1" need not be.
          if (!String(v).includes(num) && !(k.endsWith("_one") && "count" in opts))
            out.push(`${loc} ${parts.join(".")}.${k} does not print the number (${num}) for "${kind}"`);
        }
      }
    return out;
  };

  const shared87 = runProbeBundle("competition-line", `export { applicantsText } from "./pages/jobs/shared";\n`);
  if (typeof shared87.applicantsText !== "function") throw new Error("pages/jobs/shared.ts exports no applicantsText");
  const models87 = pySource("app/models/__init__.py", "check 87");
  const kinds87 = models87 === null ? ["early", "over", "count"] : pyTuple(models87, "APPLICANTS_KINDS", "app/models/__init__.py");
  if (kinds87.length < 3) throw new Error(`read only ${kinds87.length} APPLICANTS_KINDS (expected at least 3)`);
  const bundles87 = { en: JSON.parse(read("locales/en/jobs.json")), he: JSON.parse(read("locales/he/jobs.json")) };
  for (const p of judge87(shared87.applicantsText, bundles87, kinds87)) fail(`check 87: applicantsText ${p} (Phase 32)`);

  // The judge's own directions: the real function passes (above); each twin fails.
  const realFn = shared87.applicantsText;
  const twins = [
    ["a raw key for a kind it does not know", (a, t) => (a && a.source ? (["early", "over", "count"].includes(a.kind) ? realFn(a, t) : t(`card.applicants.${a.kind}`, { n: a.n, board: "LinkedIn" })) : "")],
    ["no board named", (a, t) => realFn(a, (k, o) => t(k, { ...o, board: undefined }))],
    ["a number with no board behind it", (a, t) => realFn(a && { ...a, source: a.source || "linkedin" }, t)],
    ["two kinds on one sentence", (a, t) => realFn(a && a.kind === "over" ? { ...a, kind: "count" } : a, t)],
  ];
  for (const [label, fn] of twins)
    if (!judge87(fn, bundles87, kinds87).length) throw new Error(`the judge passes a twin with ${label}`);
  const heNoTwo = { ...bundles87, he: withoutForm(bundles87.he, "card.applicantsCount", "two") };
  if (!judge87(realFn, heNoTwo, kinds87).length) throw new Error("the judge passes a Hebrew count with no _two form");
  const heNoBoard = JSON.parse(JSON.stringify(bundles87.he));
  heNoBoard.card.applicantsOver = "מעל {{n}} מועמדים";
  if (!judge87(realFn, { ...bundles87, he: heNoBoard }, kinds87).length)
    throw new Error("the judge passes a Hebrew sentence that dropped {{board}}");
} catch (e) {
  fail(`competition-line wording check (check 87) could not run: ${e.message}`);
}

// ---- 88. the line rides every surface that holds a reading; the server judges its age //
// Phase 32. (a) The search row draws `<CompetitionLine applicants={m.applicants} />`
// and the History row `<CompetitionLine applicants={hit.applicants} />` INSIDE their
// badge rows (the `empty:hidden` row beside New / Older): a LinkedIn posting fresh
// enough to carry a reading usually carries New, so it rides a row the card
// already has, where a line of its own costs every card a row and a phone its
// third job (job-search.md records the measurements); `CompetitionLine` words it
// through `applicantsText`, and the job's page puts `applicantsText(detail.applicants, …)`
// in its meta line.
// (b) No file under src/ reads `read_at`: the server hands a reading back only
// while it is current (`job_search.current_applicants`, a day), and a device clock
// judging it would call a week-old "Under 25" current on a phone set a week slow.
// (c) The field is on both mirrors: `applicants` on types.ts's JobMatch,
// JobSearchHit and ApplicationDetail and on the backend's JobMatch, JobSearchHitOut
// and ApplicationDetail, with the same four fields on Applicants (a renamed field
// compiles green and reads undefined). Five planted twins are probed every run.
try {
  const read88 = ({ cards, jobPage, shared, types, models, srcFiles }) => {
    const out = [];
    const card = fnSource(cards, "export function MatchCard");
    const row = fnSource(cards, "export function HistoryRow");
    const line = fnSource(cards, "export function CompetitionLine");
    const badgeRow = (fn) => {
      const open = fn.indexOf('<div className="mt-1.5 flex flex-wrap items-center gap-1.5 empty:hidden">');
      return open === -1 ? "" : fn.slice(open, fn.indexOf("</div>", open));
    };
    if (!/<CompetitionLine\s+applicants=\{\s*m\.applicants\s*\}\s*\/>/.test(badgeRow(card)))
      out.push("the search row does not draw <CompetitionLine applicants={m.applicants} /> inside its badge row");
    if (!/<CompetitionLine\s+applicants=\{\s*hit\.applicants\s*\}\s*\/>/.test(badgeRow(row)))
      out.push("the History row does not draw <CompetitionLine applicants={hit.applicants} /> inside its badge row");
    if (!/applicantsText\(\s*applicants\s*,\s*t\s*\)/.test(line)) out.push("CompetitionLine words the line itself, not through applicantsText");
    if (!/applicantsText\(\s*detail\.applicants\s*,\s*tJobs\s*\)/.test(jobPage)) out.push("the job's page does not say its posting's competition line");
    if (!/export function applicantsText\(/.test(shared)) out.push("pages/jobs/shared.ts has no applicantsText");
    for (const [f, src] of srcFiles)
      if (f !== "types.ts" && /\bread_at\b/.test(src)) out.push(`${f} reads read_at: the server judges a reading's age, never the page`);
    for (const iface of ["JobMatch", "JobSearchHit", "ApplicationDetail"]) {
      const block = blockAfter(types, `export interface ${iface} `, `${iface} in types.ts`);
      if (!topLevelKeys(block).includes("applicants")) out.push(`types.ts: ${iface} has no applicants`);
    }
    const ap = blockAfter(types, "export interface Applicants ", "Applicants in types.ts");
    for (const k of ["kind", "n", "source", "read_at"]) if (!topLevelKeys(ap).includes(k)) out.push(`types.ts: Applicants has no ${k}`);
    if (models !== null) {
      const cls = (name) => {
        const m = new RegExp(`class ${name}\\(BaseModel\\):([\\s\\S]*?)\\n(?=class |\\S)`).exec(models);
        if (!m) throw new Error(`could not find class ${name} in backend/app/models/__init__.py`);
        return m[1];
      };
      for (const name of ["JobMatch", "JobSearchHitOut", "ApplicationDetail"])
        if (!/^\s+applicants:\s*Optional\[Applicants\]/m.test(cls(name))) out.push(`backend ${name} has no applicants: Optional[Applicants]`);
      const body = cls("Applicants");
      for (const k of ["kind", "n", "source", "read_at"])
        if (!new RegExp(`^\\s+${k}:\\s*(?:str|int)\\b`, "m").test(body)) out.push(`backend Applicants has no ${k}`);
    }
    return out;
  };
  const walk = (dir, rel = "") =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
      d.isDirectory()
        ? d.name === "locales" ? [] : walk(path.join(dir, d.name), `${rel}${d.name}/`)
        : /\.(ts|tsx)$/.test(d.name) ? [[`${rel}${d.name}`, decomment(fs.readFileSync(path.join(dir, d.name), "utf8"))]] : [],
    );
  const srcFiles = walk(SRC);
  if (srcFiles.length < 100) throw new Error(`walked only ${srcFiles.length} .ts/.tsx files under src/ (expected at least 100)`);
  const modelsRaw = pySource("app/models/__init__.py", "check 88");
  const real = {
    cards: decomment(read("pages/jobs/cards.tsx")),
    jobPage: decomment(read("pages/JobPage.tsx")),
    shared: decomment(read("pages/jobs/shared.ts")),
    types: read("types.ts"),
    models: modelsRaw === null ? null : modelsRaw.replace(/\r\n/g, "\n"),
    srcFiles,
  };
  for (const p of read88(real)) fail(`check 88: ${p} (Phase 32)`);
  const plant = (key, from, to, label) => {
    if (!(key === "srcFiles" || real[key].includes(from))) throw new Error(`the probe could not plant "${label}"`);
    const planted = key === "srcFiles" ? [...real.srcFiles, ["pages/jobs/cards.tsx", from]] : real[key].replace(from, to);
    if (!read88({ ...real, [key]: planted }).length) throw new Error(`the reader passes "${label}"`);
  };
  plant("cards", "<CompetitionLine applicants={hit.applicants} />", "", "a History row without the line");
  {
    // The first placement tried, moved into the "Searched …" line: it wrapped on
    // 8 of 12 fresh rows at 390 px in English, 16 px each.
    const from = "          <CompetitionLine applicants={hit.applicants} />\n";
    const searched = '<p className="mt-1 text-xs text-ink-faint">\n';
    if (!real.cards.includes(from) || !real.cards.includes(searched)) throw new Error('the probe could not plant "the Searched line"');
    const moved = real.cards.replace(from, "").replace(searched, `${searched}<CompetitionLine applicants={hit.applicants} />\n`);
    if (!read88({ ...real, cards: moved }).length) throw new Error('the reader passes "a History row with the line in its Searched line"');
  }
  {
    // Moved, not deleted: a line of its own under the meta line is the layout
    // that costs every card a row and a phone its third job.
    const from = "          <CompetitionLine applicants={m.applicants} />\n";
    const own = "<GeoNote geo={m.geo_restriction} />";
    if (!real.cards.includes(from) || !real.cards.includes(own)) throw new Error('the probe could not plant "a line of its own"');
    const moved = real.cards.replace(from, "").replace(own, `<p><CompetitionLine applicants={m.applicants} /></p>\n${own}`);
    if (!read88({ ...real, cards: moved }).length) throw new Error('the reader passes "a search row with the line on a row of its own"');
  }
  plant("jobPage", "applicantsText(detail.applicants, tJobs)", '""', "a job's page without the line");
  plant("srcFiles", "const fresh = Date.now() - Date.parse(a.read_at) < 86_400_000;", "", "a page that judges the age itself");
  plant("types", "  applicants?: Applicants | null;\n  searched_at: string;", "  searched_at: string;", "a mirror without the field");
} catch (e) {
  fail(`competition-line surfaces check (check 88) could not run: ${e.message}`);
}

// ---- 91. web push: a worker for push only, permission asked on a tap (PLAN 32) //
// The morning alert as a notification. What `tsc` cannot see, and each a way the
// feature ships broken or changes the whole site:
//   (a) public/sw.js is EXECUTED in a node vm with a fake `self`. It must show
//       the notification a push carries (title, body, direction, a same-origin
//       target), open ONLY this origin on a tap (a push naming another origin,
//       or no URL, opens /jobs), navigate and focus an open window before
//       opening a new one, and register NO `fetch` listener and touch no cache:
//       a worker that intercepts fetches changes every deploy on every device
//       (stale assets), which is not what a notification is worth.
//   (b) the permission prompt is asked only by lib/push.ts's `turnOn`, as its
//       FIRST awaited step (a prompt after an await is no longer the tap's and
//       Safari refuses it), and the worker is registered only there too: never
//       on page load. `Notification.requestPermission` and
//       `serviceWorker.register` appear nowhere else under src/.
//   (c) the alerts card reads the devices IN THE SAME Promise.all as the alert,
//       so the card appears whole and nothing under it moves when they land.
//   (d) the client's /push/* calls are routes notify_routes.py mounts, every
//       `alerts.push.*` key resolves in both jobs.json (the device count with its
//       full plural set), the push_test daily cap has its own sentence, and the
//       privacy page says who delivers notifications.
// Planted twins are probed every run.
try {
  const vm = createRequire(import.meta.url)("node:vm");
  const swPath = path.join(HERE, "..", "public", "sw.js");
  const swSrc = fs.readFileSync(swPath, "utf8");
  const ORIGIN = "https://app.jobfinder.test";
  const loadSw = (src) => {
    const listeners = {};
    const shown = [];
    const opened = [];
    const clients = [];
    const self = {
      location: { origin: ORIGIN, href: `${ORIGIN}/sw.js` },
      addEventListener: (type, fn) => (listeners[type] = listeners[type] || []).push(fn),
      skipWaiting: () => Promise.resolve(),
      registration: { showNotification: async (title, opts) => shown.push({ title, opts }) },
      clients: {
        claim: async () => undefined,
        matchAll: async () => clients,
        openWindow: async (url) => {
          opened.push(url);
          return null;
        },
      },
    };
    const caches = new Proxy({}, { get: () => () => { throw new Error("the worker touched CacheStorage"); } });
    vm.runInContext(src, vm.createContext({ self, URL, console, caches, setTimeout }), { filename: "sw.js" });
    return { listeners, shown, opened, clients };
  };
  const fire = async (sw, type, event) => {
    const waits = [];
    for (const fn of sw.listeners[type] || []) fn({ ...event, waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  };
  const read91a = async (src) => {
    const out = [];
    const sw = loadSw(src);
    if (sw.listeners.fetch?.length) out.push("sw.js listens for fetch, so it would sit between every page and the network");
    if (/\bcaches\b|CacheStorage|importScripts/.test(decomment(src))) out.push("sw.js touches a cache or imports scripts");
    if (!sw.listeners.push?.length || !sw.listeners.notificationclick?.length)
      throw new Error("public/sw.js registers no push or no notificationclick listener");
    await fire(sw, "push", { data: { json: () => ({ title: "3 new jobs for you", body: "Best: X", url: "/jobs?open=a%3Ab", lang: "he", dir: "rtl" }) } });
    await fire(sw, "push", { data: { json: () => ({ title: "t", body: "b", url: "https://evil.example/steal" }) } });
    await fire(sw, "push", { data: { json: () => { throw new Error("not json"); } } });
    const [ok, evil, junk] = sw.shown;
    if (!ok || ok.title !== "3 new jobs for you" || ok.opts.body !== "Best: X" || ok.opts.dir !== "rtl" || ok.opts.lang !== "he")
      out.push(`a push is not shown as sent: ${JSON.stringify(ok)}`);
    if (ok?.opts?.data?.url !== `${ORIGIN}/jobs?open=a%3Ab`) out.push(`a push's target is ${JSON.stringify(ok?.opts?.data?.url)}, not this origin's /jobs?open=`);
    if (evil?.opts?.data?.url !== `${ORIGIN}/jobs`) out.push(`a push naming another origin would open ${JSON.stringify(evil?.opts?.data?.url)} instead of /jobs`);
    if (!junk || junk.title !== "JobFinder" || junk.opts.data.url !== `${ORIGIN}/jobs`) out.push("a push that is not JSON shows nothing (userVisibleOnly) or opens elsewhere");
    // A tap with no window open opens the target; with one open, that window goes there and comes forward.
    await fire(sw, "notificationclick", { notification: { close() {}, data: { url: `${ORIGIN}/jobs?open=x` } } });
    if (sw.opened.join() !== `${ORIGIN}/jobs?open=x`) out.push(`a tap with no window open opened ${JSON.stringify(sw.opened)}`);
    const moves = [];
    sw.clients.push({ url: "https://other.example/", navigate: async () => moves.push("other") });
    sw.clients.push({ url: `${ORIGIN}/app`, navigate: async (u) => (moves.push(u), { focus: async () => moves.push("focus") }) });
    await fire(sw, "notificationclick", { notification: { close() {}, data: { url: "https://evil.example/x" } } });
    if (moves.join() !== `${ORIGIN}/jobs,focus` || sw.opened.length !== 1)
      out.push(`a tap with a JobFinder window open did ${JSON.stringify(moves)} / opened ${JSON.stringify(sw.opened)}`);
    return out;
  };
  for (const p of await read91a(swSrc)) fail(`check 91: ${p} (PLAN 32)`);
  const plantSw = async (from, to, label) => {
    if (!swSrc.includes(from)) throw new Error(`the probe could not plant "${label}"`);
    if (!(await read91a(swSrc.replace(from, to))).length) throw new Error(`the reader passes "${label}"`);
  };
  await plantSw('self.addEventListener("install"', 'self.addEventListener("fetch", () => {});\nself.addEventListener("install"', "a worker with a fetch handler");
  await plantSw("if (url.origin !== self.location.origin) return new URL(\"/jobs\", self.location.origin).href;", "", "a worker that opens any origin");
  await plantSw("const moved = \"navigate\" in client ? await client.navigate(target) : null;", "const moved = null;", "a tap that never brings the open window to the job");

  // (b) and (c): the prompt, the registration and the card's one load.
  const pushLib = decomment(read("lib/push.ts")).replace(/\r\n/g, "\n");
  const card = decomment(read("pages/jobs/AlertsCard.tsx")).replace(/\r\n/g, "\n");
  const read91b = (lib, cardSrc, others) => {
    const out = [];
    const turnOn = fnSource(lib, "export async function turnOn(");
    const firstAwait = /\bawait\s+([^;]+);/.exec(turnOn);
    if (!firstAwait || !/^Notification\.requestPermission\(\)$/.test(firstAwait[1].trim()))
      out.push(`turnOn's first await is ${JSON.stringify(firstAwait?.[1])}, not Notification.requestPermission(): the prompt would no longer belong to the tap`);
    if (!/navigator\.serviceWorker\.register\("\/sw\.js", \{ scope: "\/" \}\)/.test(turnOn)) out.push("turnOn does not register /sw.js at scope /");
    const outsideTurnOn = lib.replace(turnOn, "");
    if (/requestPermission|serviceWorker\.register/.test(outsideTurnOn)) out.push("lib/push.ts asks or registers outside turnOn");
    for (const [file, text] of others)
      if (/requestPermission|serviceWorker\.register/.test(text)) out.push(`${file} asks for permission or registers the worker, which only turnOn may`);
    if (!/Promise\.all\(\[\s*getJobAlert\(\),\s*getPushDevices\(\)[^\]]*currentSubscription\(\),[^\]]*\]\)/.test(cardSrc))
      out.push("the alerts card does not read the push devices and this browser's subscription together with the alert, so the card would move when they land");
    return out;
  };
  const srcFiles = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(ent.name) && !p.endsWith(path.join("lib", "push.ts")))
        srcFiles.push([path.relative(SRC, p), decomment(fs.readFileSync(p, "utf8"))]);
    }
  };
  walk(SRC);
  if (srcFiles.length < 100) throw new Error(`read only ${srcFiles.length} source files under src/`);
  for (const p of read91b(pushLib, card, srcFiles)) fail(`check 91: ${p} (PLAN 32)`);
  const plantB = (which, from, to, label) => {
    const lib = which === "lib" ? pushLib.replace(from, to) : pushLib;
    const cardSrc = which === "card" ? card.replace(from, to) : card;
    const others = which === "other" ? [["pages/SettingsPage.tsx", to]] : srcFiles;
    if (which !== "other" && (which === "lib" ? pushLib : card).indexOf(from) === -1) throw new Error(`the probe could not plant "${label}"`);
    if (!read91b(lib, cardSrc, others).length) throw new Error(`the reader passes "${label}"`);
  };
  plantB("lib", "const permission = await Notification.requestPermission();", "await Promise.resolve();\n  const permission = await Notification.requestPermission();", "a prompt after an await");
  plantB("other", "", "useEffect(() => { void navigator.serviceWorker.register(\"/sw.js\"); }, []);", "a worker registered on page load");
  plantB("card", "getPushDevices().catch(() => null),", "", "devices read after the card appeared");

  // (d) routes, words, the daily cap's sentence and the privacy line.
  const client = decomment(read("api/client.ts"));
  const routesPy = pySource("app/api/notify_routes.py", "check 91");
  const calls = [...client.matchAll(/api\.(get|post|delete)<[^>]*>\("(\/push\/[\w/-]+)"/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  if (calls.length < 4) throw new Error(`read ${calls.length} /push/* calls out of api/client.ts (expected 4)`);
  if (routesPy !== null) {
    const mounted = new Set([...routesPy.matchAll(/@router\.(get|post|delete)\("(\/push\/[\w/-]+)"/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`));
    for (const c of calls) if (!mounted.has(c)) fail(`check 91: api/client.ts calls ${c}, which notify_routes.py does not mount (PLAN 32)`);
  }
  const channels = decomment(read("pages/jobs/AlertChannels.tsx"));
  const keys = new Set([...channels.matchAll(/\bt\("(alerts\.push\.[\w.]+)"/g)].map((m) => m[1]));
  if (!/t\(`alerts\.push\.\$\{e\.reason\}`\)/.test(channels))
    throw new Error("pages/jobs/AlertChannels.tsx no longer says a PushError by its reason, so the reasons below are unread");
  if (keys.size < 12) throw new Error(`read ${keys.size} alerts.push.* keys out of pages/jobs/AlertChannels.tsx (expected at least 12)`);
  const reasons = /readonly reason: ("[a-z]+"(?:\s*\|\s*"[a-z]+")*)/.exec(pushLib);
  if (!reasons) throw new Error("lib/push.ts's PushError has no readable reason union");
  for (const r of reasons[1].match(/[a-z]+/g)) keys.add(`alerts.push.${r}`);
  const plural = { en: ["one", "other"], he: ["one", "two", "other"] };
  for (const loc of ["en", "he"]) {
    const jobs = JSON.parse(read(`locales/${loc}/jobs.json`));
    for (const key of keys) {
      if (key === "alerts.push.otherDevices") {
        for (const form of plural[loc])
          if (typeof jobs.alerts?.push?.[`otherDevices_${form}`] !== "string")
            fail(`check 91: locales/${loc}/jobs.json is missing "alerts.push.otherDevices_${form}" (PLAN 32)`);
      } else if (!resolvesIn(jobs, key)) fail(`check 91: locales/${loc}/jobs.json is missing "${key}" (PLAN 32)`);
    }
    if (!resolvesIn(JSON.parse(read(`locales/${loc}/common.json`)), "dailyLimit.pushTest"))
      fail(`check 91: locales/${loc}/common.json is missing "dailyLimit.pushTest" (PLAN 32)`);
    if (!/Google.*Apple.*Mozilla.*Microsoft/.test(JSON.parse(read(`locales/${loc}/auth.json`)).privacy?.store?.push ?? ""))
      fail(`check 91: locales/${loc}/auth.json's privacy.store.push does not name the push services that deliver notifications (PLAN 32)`);
  }
  if (!/<li>\{t\("privacy\.store\.push"\)\}<\/li>/.test(decomment(read("pages/PrivacyPage.tsx"))))
    fail("check 91: the privacy page does not say who delivers notifications (privacy.store.push) (PLAN 32)");
  if (!/push_test: "dailyLimit\.pushTest"/.test(decomment(read("lib/apiError.ts"))))
    fail("check 91: lib/apiError.ts's LIMIT_KEYS does not name push_test, so its daily cap reads the generic line (PLAN 32)");
} catch (e) {
  fail(`web push check (check 91) could not run: ${e.message}`);
}

// ---- 92. WhatsApp alerts: opt-in first, every refusal said (PLAN 32, part 2) -- //
// Every WhatsApp message is billed to the owner, and Meta requires an explicit
// opt-in that names the business. What `tsc` cannot see:
//   (a) the row is read in the alerts card's one Promise.all and drawn only when
//       the server says `available` (configured AND the admin's grant);
//   (b) "Send code" is disabled until the opt-in box is ticked, and the request
//       carries `opt_in`; the opt-in sentence names JobFinder and WhatsApp in both
//       locales;
//   (c) every send-failure reason the backend's whatsapp.py can return is one the
//       row knows (WA_REASONS) and has a sentence in both jobs.json; every
//       `alerts.whatsapp.*` key resolves, the wrong-code count with its plural
//       set; the `whatsapp` daily cap has its own sentence;
//   (d) the client's /whatsapp calls are routes notify_routes.py mounts, and the
//       privacy page says the number goes to WhatsApp (Meta).
// Planted twins are probed every run.
try {
  const card = decomment(read("pages/jobs/AlertsCard.tsx")).replace(/\r\n/g, "\n");
  const row = decomment(read("pages/jobs/AlertChannels.tsx")).replace(/\r\n/g, "\n");
  const waPy = pySource("app/core/whatsapp.py", "check 92");
  const backendReasons = waPy === null ? null : (() => {
    const table = /_REASONS = \{([\s\S]*?)\n\}/.exec(waPy);
    if (!table) throw new Error("backend/app/core/whatsapp.py has no readable _REASONS table");
    const found = new Set([...table[1].matchAll(/:\s*"([a-z_]+)"/g)].map((m) => m[1]));
    for (const m of waPy.matchAll(/SendResult\(False, "([a-z_]+)"/g)) found.add(m[1]);
    if (found.size < 6) throw new Error(`read ${found.size} send-failure reasons out of whatsapp.py (expected at least 6)`);
    return found;
  })();
  const read92 = (cardSrc, rowSrc) => {
    const out = [];
    if (!/Promise\.all\(\[[^\]]*getWhatsApp\(\)\.catch\(\(\) => null\)[^\]]*\]\)/.test(cardSrc))
      out.push("the alerts card does not read WhatsApp in its one Promise.all, so the card would move when it lands");
    if (!/setWa\(whats\?\.available \? whats : null\)/.test(cardSrc) || !/\{wa && <WhatsAppRow /.test(cardSrc))
      out.push("the WhatsApp row is drawn without the server's `available` (configured and granted)");
    const submit = /<Button[^>]*type="submit"[^>]*disabled=\{([^}]*)\}[^>]*>\s*\{t\("alerts\.whatsapp\.sendCode"\)\}/.exec(rowSrc);
    if (!submit || !/!optIn/.test(submit[1])) out.push("Send code is not disabled until the opt-in box is ticked");
    if (!/sendWhatsAppCode\(\{[^}]*opt_in:/.test(rowSrc)) out.push("the code request does not carry opt_in");
    const reasons = /const WA_REASONS = \[([^\]]*)\]/.exec(rowSrc);
    if (!reasons) throw new Error("pages/jobs/AlertChannels.tsx has no WA_REASONS list");
    const known = new Set([...reasons[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
    if (backendReasons) for (const r of backendReasons) if (!known.has(r)) out.push(`the backend can send reason "${r}", which the row does not know`);
    return { out, known };
  };
  const real = read92(card, row);
  for (const p of real.out) fail(`check 92: ${p} (PLAN 32)`);
  const plant = (which, from, to, label) => {
    const src = which === "card" ? card : row;
    if (!src.includes(from)) throw new Error(`the probe could not plant "${label}"`);
    const res = which === "card" ? read92(card.replace(from, to), row) : read92(card, row.replace(from, to));
    if (!res.out.length) throw new Error(`the reader passes "${label}"`);
  };
  plant("row", "disabled={!optIn || !phone.trim()}", "disabled={!phone.trim()}", "a code sent without the opt-in");
  plant("card", "setWa(whats?.available ? whats : null)", "setWa(whats)", "a row drawn for an account not granted");
  if (backendReasons) plant("row", '"opted_out", ', "", "a reason the row does not know");

  const keys = new Set([...row.matchAll(/\bt\("(alerts\.whatsapp\.[\w.]+)"/g)].map((m) => m[1]));
  if (keys.size < 18) throw new Error(`read ${keys.size} alerts.whatsapp.* keys out of pages/jobs/AlertChannels.tsx (expected at least 18)`);
  if (!/t\(`alerts\.whatsapp\.reason\.\$\{/.test(row)) throw new Error("the row no longer says a reason by its key, so the reasons below are unread");
  for (const r of real.known) keys.add(`alerts.whatsapp.reason.${r}`);
  const plural = { en: ["one", "other"], he: ["one", "two", "other"] };
  for (const loc of ["en", "he"]) {
    const jobs = JSON.parse(read(`locales/${loc}/jobs.json`));
    for (const key of keys) {
      if (key === "alerts.whatsapp.errWrong") {
        for (const form of plural[loc])
          if (typeof jobs.alerts?.whatsapp?.[`errWrong_${form}`] !== "string")
            fail(`check 92: locales/${loc}/jobs.json is missing "alerts.whatsapp.errWrong_${form}" (PLAN 32)`);
      } else if (!resolvesIn(jobs, key)) fail(`check 92: locales/${loc}/jobs.json is missing "${key}" (PLAN 32)`);
    }
    if (!/JobFinder/.test(jobs.alerts?.whatsapp?.optIn ?? "") || !/WhatsApp|וואטסאפ/.test(jobs.alerts?.whatsapp?.optIn ?? ""))
      fail(`check 92: locales/${loc}/jobs.json's opt-in sentence does not name JobFinder and WhatsApp (Meta's opt-in rule) (PLAN 32)`);
    if (!resolvesIn(JSON.parse(read(`locales/${loc}/common.json`)), "dailyLimit.whatsapp"))
      fail(`check 92: locales/${loc}/common.json is missing "dailyLimit.whatsapp" (PLAN 32)`);
    if (!/Meta/.test(JSON.parse(read(`locales/${loc}/auth.json`)).privacy?.store?.whatsapp ?? ""))
      fail(`check 92: locales/${loc}/auth.json's privacy.store.whatsapp does not say the number goes to WhatsApp (Meta) (PLAN 32)`);
  }
  if (!/<li>\{t\("privacy\.store\.whatsapp"\)\}<\/li>/.test(decomment(read("pages/PrivacyPage.tsx"))))
    fail("check 92: the privacy page does not mention the WhatsApp number (privacy.store.whatsapp) (PLAN 32)");
  if (!/whatsapp: "dailyLimit\.whatsapp"/.test(decomment(read("lib/apiError.ts"))))
    fail("check 92: lib/apiError.ts's LIMIT_KEYS does not name whatsapp, so its daily cap reads the generic line (PLAN 32)");

  const client = decomment(read("api/client.ts"));
  const calls = [...client.matchAll(/api\.(get|post|delete)<[^>]*>\("(\/whatsapp[\w/-]*)"/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  if (calls.length < 5) throw new Error(`read ${calls.length} /whatsapp calls out of api/client.ts (expected 5)`);
  const routesPy = pySource("app/api/notify_routes.py", "check 92");
  if (routesPy !== null) {
    const mounted = new Set([...routesPy.matchAll(/@router\.(get|post|delete)\("(\/whatsapp[\w/-]*)"/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`));
    for (const c of calls) if (!mounted.has(c)) fail(`check 92: api/client.ts calls ${c}, which notify_routes.py does not mount (PLAN 32)`);
  }
} catch (e) {
  fail(`WhatsApp check (check 92) could not run: ${e.message}`);
}

// ---- 98. the board list is the backend's registry, and every board has its names //
// 2026-09-28 (PLAN 32, More places to search). `SOURCE_IDS` in pages/jobs/shared.ts
// is the list a search is customised from: a registered board missing from it
// vanishes from a customised search the moment one box is unticked, and a board
// the backend lacks is a box that searches nothing. (a) EXECUTES shared.ts:
// SOURCE_IDS must equal the backend's `PROVIDERS` in its order (read out of
// providers/__init__.py and each provider class's `name`, a degraded skip without
// backend/), every board must have an English and a Hebrew name in SOURCE_NAMES,
// and `sourceLabel` must answer the page's language (Hebrew for "he", English
// otherwise, an unknown id capitalised, nothing for none). (b) Every call of
// `sourceLabel(` under src/ outside shared.ts hands it the page's language, and
// none maps over it bare: `.map(sourceLabel)` hands it the array INDEX as the
// language (it nearly shipped with this change). (c) The alert email names every
// registered board (alerts._EM_SOURCE_LABELS; "smartrecruiters".capitalize() is
// "Smartrecruiters"). Planted twins are judged every run.
try {
  const judge98 = ({ ids, names, label, backend, callers, email }) => {
    const out = [];
    if (backend !== null) {
      if (JSON.stringify(ids) !== JSON.stringify(backend))
        out.push(`SOURCE_IDS is ${JSON.stringify(ids)}, the backend registry is ${JSON.stringify(backend)} (same boards, same order)`);
    }
    for (const id of ids) {
      const n = names[id];
      if (!n || typeof n.en !== "string" || !n.en.trim() || typeof n.he !== "string" || !n.he.trim())
        out.push(`board "${id}" has no English and Hebrew name in SOURCE_NAMES`);
      else {
        if (label(id, "he") !== n.he) out.push(`sourceLabel("${id}", "he") is not its Hebrew name`);
        if (label(id, "en") !== n.en || label(id) !== n.en) out.push(`sourceLabel("${id}") is not its English name`);
      }
    }
    if (label("newboard", "he") !== "Newboard") out.push("an unknown board is not shown capitalised");
    if (label("", "he") !== "" || label(undefined, "en") !== "") out.push("no board is not an empty name");
    for (const [file, src] of callers) {
      if (/\.map\(\s*sourceLabel\s*\)/.test(src)) out.push(`${file} maps over sourceLabel bare, which hands it the index as the language`);
      for (const m of src.matchAll(/\bsourceLabel\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g))
        if (!/,/.test(m[1])) out.push(`${file}: sourceLabel(${m[1]}) is not handed the page's language`);
    }
    if (email !== null && backend !== null)
      for (const id of backend) if (!email.includes(`"${id}"`)) out.push(`the alert email has no name for board "${id}" (alerts._EM_SOURCE_LABELS)`);
    return out;
  };

  const shared98 = runProbeBundle(
    "sources",
    'export { SOURCE_IDS, SOURCE_NAMES, sourceLabel } from "./pages/jobs/shared";\n',
  );
  for (const k of ["SOURCE_IDS", "SOURCE_NAMES", "sourceLabel"])
    if (!(k in shared98)) throw new Error(`pages/jobs/shared.ts exports no ${k}`);

  // The backend's registry, in order: the classes `PROVIDERS` is built from, each
  // mapped to its `name` through the module it is imported from.
  let backend98 = null;
  const init98 = pySource("app/core/providers/__init__.py", "check 98");
  if (init98 !== null) {
    const src = init98.replace(/\r\n/g, "\n");
    const block = /PROVIDERS: dict\[str, JobProvider\] = \{[\s\S]*?for provider in \(([\s\S]*?)\n    \)\n\}/.exec(src);
    if (!block) throw new Error("providers/__init__.py: the PROVIDERS comprehension was not found");
    const classes = [...block[1].matchAll(/^\s*(\w+Provider)\(\),?\s*$/gm)].map((m) => m[1]);
    if (classes.length < 5) throw new Error(`read ${classes.length} provider classes out of PROVIDERS (expected at least 5)`);
    backend98 = classes.map((cls) => {
      const imp = new RegExp(`^from app\\.core\\.providers\\.(\\w+) import ${cls}$`, "m").exec(src);
      if (!imp) throw new Error(`providers/__init__.py does not import ${cls} from a provider module`);
      const mod = pySource(`app/core/providers/${imp[1]}.py`, "check 98").replace(/\r\n/g, "\n");
      const body = new RegExp(`^class ${cls}\\b[\\s\\S]*?^    name = "([\\w-]+)"`, "m").exec(mod);
      if (!body) throw new Error(`providers/${imp[1]}.py: class ${cls} has no \`name = "…"\``);
      return body[1];
    });
  }
  const alerts98 = pySource("app/core/alerts.py", "check 98");
  const email98 = alerts98 === null ? null : (/_EM_SOURCE_LABELS = \{([\s\S]*?)\n\}/.exec(alerts98) || [])[1];
  if (alerts98 !== null && email98 === undefined) throw new Error("app/core/alerts.py: _EM_SOURCE_LABELS not found");

  const walk98 = (dir, rel = "") =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
      d.isDirectory()
        ? d.name === "locales" ? [] : walk98(path.join(dir, d.name), `${rel}${d.name}/`)
        : /\.(ts|tsx)$/.test(d.name) && `${rel}${d.name}` !== "pages/jobs/shared.ts"
          ? [[`${rel}${d.name}`, decomment(fs.readFileSync(path.join(dir, d.name), "utf8"))]]
          : [],
    );
  const callers98 = walk98(SRC).filter(([, s]) => /\bsourceLabel\b/.test(s));
  const calls98 = callers98.reduce((n, [, s]) => n + (s.match(/\bsourceLabel\(/g) || []).length, 0);
  if (calls98 < 10) throw new Error(`found ${calls98} sourceLabel( calls under src/ (expected at least 10)`);

  const real = {
    ids: [...shared98.SOURCE_IDS],
    names: shared98.SOURCE_NAMES,
    label: shared98.sourceLabel,
    backend: backend98,
    callers: callers98,
    email: email98 ?? null,
  };
  for (const p of judge98(real)) fail(`check 98: ${p} (PLAN 32, More places to search)`);
  const twins = [
    ["a board missing from the list", { ...real, ids: real.ids.slice(0, -1) }],
    ["the boards in another order", { ...real, ids: [...real.ids].reverse() }],
    ["a board with no Hebrew name", { ...real, names: { ...real.names, [real.ids[1]]: { en: "X", he: "" } } }],
    ["a label that ignores the language", { ...real, label: (s, _l) => real.label(s, "en") }],
    ["a caller mapping over it bare", { ...real, callers: [...real.callers, ["x.tsx", "keys.map(sourceLabel).join()"]] }],
    ["a caller with no language", { ...real, callers: [...real.callers, ["x.tsx", "{sourceLabel(job.source)}"]] }],
  ];
  for (const [label, planted] of twins) {
    if (planted.backend === null && /missing|order/.test(label)) continue; // no backend to compare with
    if (!judge98(planted).length) throw new Error(`the judge passes ${label}`);
  }
  if (real.email !== null && real.backend !== null && !judge98({ ...real, email: real.email.replace(`"${real.backend[1]}"`, '"x"') }).length)
    throw new Error("the judge passes an alert email with a board unnamed");
} catch (e) {
  fail(`board list check (check 98) could not run: ${e.message}`);
}

// ---- 99. a Himalayas result names Himalayas beside a link back to it --------- //
// 2026-09-28. Himalayas' API is offered on one condition: "link back to the URL
// found on Himalayas AND mention Himalayas as the original source". Missing the
// line on one surface is the defect nothing else would see. (a) EXECUTES
// `attributedSource` and `ATTRIBUTED_SOURCES` (pages/jobs/shared.ts): the ids equal
// the backend's `providers.ATTRIBUTED` (a degraded skip without backend/); a
// result is credited by its source, else, where no source is stored (a tracked
// job's page), by its URL's host, never by a look-alike host or another board's
// source. (b) `card.viaBoard` resolves in both jobs.json and prints {{board}}.
// (c) By shape: the search row and the History row draw `<ViaBoard …/>` INSIDE
// their badge rows with their own source and URL; ViaBoard links to that URL in a
// new tab, words it through `card.viaBoard` with the board's name in the page's
// language, and is a 44 px box (`min-h-11`); a tracked job's page names the board
// on its link back (`attributedSource` + `card.openOn`). (d) The alert email
// credits it in BOTH bodies (`_via` in the plain text and the HTML). Planted twins
// are judged every run.
try {
  const shared99 = runProbeBundle(
    "attribution",
    'export { ATTRIBUTED_SOURCES, attributedSource } from "./pages/jobs/shared";\n',
  );
  if (typeof shared99.attributedSource !== "function") throw new Error("pages/jobs/shared.ts exports no attributedSource");
  const judgeFn99 = (fn) => {
    const out = [];
    const cases = [
      ["himalayas", "https://himalayas.app/companies/x/jobs/y", "himalayas"],
      [undefined, "https://himalayas.app/companies/x/jobs/y", "himalayas"],
      [undefined, "https://www.himalayas.app/x", "himalayas"],
      ["", "https://himalayas.app/x", "himalayas"],
      [undefined, "https://himalayas.app.evil.com/x", ""],
      [undefined, "https://evilhimalayas.app/x", ""],
      ["linkedin", "https://himalayas.app/x", ""],
      [undefined, "not a url", ""],
      [undefined, undefined, ""],
    ];
    for (const [source, url, want] of cases)
      if (fn(source, url) !== want) out.push(`attributedSource(${JSON.stringify(source)}, ${JSON.stringify(url)}) is not "${want}"`);
    return out;
  };
  for (const p of judgeFn99(shared99.attributedSource)) fail(`check 99: ${p} (PLAN 32)`);
  for (const [label, twin] of [
    ["a credit read from the source alone", (s, _u) => (s === "himalayas" ? "himalayas" : "")],
    ["a host matched as a substring", (s, u) => (s ? (s === "himalayas" ? s : "") : String(u ?? "").includes("himalayas.app") ? "himalayas" : "")],
  ])
    if (!judgeFn99(twin).length) throw new Error(`the judge passes ${label}`);

  const ids99 = Object.keys(shared99.ATTRIBUTED_SOURCES).sort();
  const init99 = pySource("app/core/providers/__init__.py", "check 99");
  if (init99 !== null) {
    const m = /^ATTRIBUTED: dict\[str, str\] = \{([^}]*)\}/m.exec(init99.replace(/\r\n/g, "\n"));
    if (!m) throw new Error("providers/__init__.py: ATTRIBUTED not found");
    const backend = [...m[1].matchAll(/(\w+)Provider\.name\s*:/g)].map((x) => x[1].toLowerCase()).sort();
    if (!backend.length) throw new Error("providers/__init__.py: read no board out of ATTRIBUTED");
    if (JSON.stringify(backend) !== JSON.stringify(ids99))
      fail(`check 99: ATTRIBUTED_SOURCES names ${JSON.stringify(ids99)}, the backend credits ${JSON.stringify(backend)} (PLAN 32)`);
  }

  for (const loc of ["en", "he"]) {
    const v = JSON.parse(read(`locales/${loc}/jobs.json`)).card?.viaBoard;
    if (typeof v !== "string" || !v.includes("{{board}}"))
      fail(`check 99: locales/${loc}/jobs.json card.viaBoard is missing or does not name {{board}} (PLAN 32)`);
  }

  const read99 = ({ cards, jobPage, alerts }) => {
    const out = [];
    const badgeRow = (fn) => {
      const open = fn.indexOf('<div className="mt-1.5 flex flex-wrap items-center gap-1.5 empty:hidden">');
      return open === -1 ? "" : fn.slice(open, fn.indexOf("</div>", open));
    };
    if (!/<ViaBoard\s+source=\{\s*m\.source\s*\}\s+url=\{\s*m\.url\s*\}\s*\/>/.test(badgeRow(fnSource(cards, "export function MatchCard"))))
      out.push("the search row does not draw <ViaBoard source={m.source} url={m.url} /> in its badge row");
    if (!/<ViaBoard\s+source=\{\s*hit\.source\s*\}\s+url=\{\s*hit\.url\s*\}\s*\/>/.test(badgeRow(fnSource(cards, "export function HistoryRow"))))
      out.push("the History row does not draw <ViaBoard source={hit.source} url={hit.url} /> in its badge row");
    const via = fnSource(cards, "export function ViaBoard");
    if (!/attributedSource\(\s*source\s*,\s*url\s*\)/.test(via)) out.push("ViaBoard does not ask attributedSource which board to credit");
    if (!/href=\{url\}/.test(via) || !/target="_blank"/.test(via)) out.push("ViaBoard does not link back to the posting's page in a new tab");
    if (!/t\("card\.viaBoard",\s*\{\s*board:\s*sourceLabel\(board,\s*i18n\.language\)\s*\}\)/.test(via))
      out.push("ViaBoard does not word the credit through card.viaBoard with the board's name in the page's language");
    if (!/\bmin-h-11\b/.test(via)) out.push("ViaBoard is not a 44 px box to tap (min-h-11)");
    if (!/attributedSource\(/.test(jobPage) || !/tJobs\("card\.openOn"/.test(jobPage))
      out.push("a tracked job's page does not name the credited board on its link back");
    if (alerts !== null) {
      if ((alerts.match(/if via := _via\(m\):/g) || []).length < 2) out.push("the alert email does not credit the board in both bodies (_via)");
      if (!/f"  via \{via\}: \{m\.url\}"/.test(alerts)) out.push("the plain-text email's credit does not carry the posting's page");
    }
    return out;
  };
  const alerts99 = pySource("app/core/alerts.py", "check 99");
  const real99 = {
    cards: decomment(read("pages/jobs/cards.tsx")),
    jobPage: decomment(read("pages/JobPage.tsx")),
    alerts: alerts99 === null ? null : alerts99.replace(/\r\n/g, "\n"),
  };
  for (const p of read99(real99)) fail(`check 99: ${p} (PLAN 32)`);
  const plant99 = (key, from, to, label) => {
    if (real99[key] === null) return;
    if (!real99[key].includes(from)) throw new Error(`the probe could not plant "${label}"`);
    if (!read99({ ...real99, [key]: real99[key].replace(from, to) }).length) throw new Error(`the reader passes "${label}"`);
  };
  plant99("cards", "<ViaBoard source={hit.source} url={hit.url} />", "", "a History row without the credit");
  plant99("cards", 'target="_blank"\n      rel="noopener noreferrer"\n      className="-my-3', '\n      className="-my-3', "a credit that leaves the page");
  plant99("cards", "-my-3 inline-flex min-h-11", "-my-3 inline-flex", "a credit too small to tap");
  plant99("jobPage", 'tJobs("card.openOn"', 't("job.openPosting"', "a job page that never names the board");
  plant99("alerts", "        if via := _via(m):\n            lines.append", "        if False:\n            lines.append", "a plain-text email without the credit");
} catch (e) {
  fail(`Himalayas credit check (check 99) could not run: ${e.message}`);
}

// ---- 100. the worldwide pass runs on two boards, and only it asks Himalayas -- //
// 2026-09-28. The pass was LinkedIn's alone (`WORLDWIDE_BOARD`); it runs on
// LinkedIn and Himalayas now, and Himalayas runs on nothing else. (a) The page's
// `WORLDWIDE_SOURCES` / `WORLDWIDE_ONLY_SOURCES` equal the backend's
// `WORLDWIDE_BOARDS` / `WORLDWIDE_ONLY_BOARDS` (job_search.py, a degraded skip
// without backend/). (b) EXECUTES `searchedSources`: without the pass (off, or on
// with an on-site-only search) a search never lists Himalayas, with it the chosen
// boards stand; and `applySearchReading`: "abroad" over a chosen set holding
// neither worldwide board puts LinkedIn back, over one holding Himalayas changes
// nothing. (c) By shape: the scan panel is fed `searchedSources(c)`; the opt-in
// is gated on ANY worldwide board ticked (never `includes("linkedin")`), and its
// sentences name Himalayas in both locales; the board list says a worldwide-only
// board is "remote abroad" (`search.worldwideOnlyBoard`, both locales) and each
// board is a 44 px row. Planted twins are judged every run.
try {
  const shared100 = runProbeBundle(
    "worldwide",
    'export { SOURCE_IDS, WORLDWIDE_SOURCES, WORLDWIDE_ONLY_SOURCES, searchedSources, applySearchReading } from "./pages/jobs/shared";\n',
  );
  for (const k of ["WORLDWIDE_SOURCES", "WORLDWIDE_ONLY_SOURCES", "searchedSources", "applySearchReading"])
    if (!(k in shared100)) throw new Error(`pages/jobs/shared.ts exports no ${k}`);
  const js100 = pySource("app/core/job_search.py", "check 100");
  if (js100 !== null) {
    const src = js100.replace(/\r\n/g, "\n");
    const board = (/^WORLDWIDE_BOARD = "(\w+)"/m.exec(src) || [])[1];
    const boards = /^WORLDWIDE_BOARDS: tuple\[str, \.\.\.\] = \(([^)]*)\)/m.exec(src);
    const only = /^WORLDWIDE_ONLY_BOARDS: frozenset\[str\] = frozenset\(\{([^}]*)\}\)/m.exec(src);
    if (!board || !boards || !only) throw new Error("job_search.py: WORLDWIDE_BOARD / WORLDWIDE_BOARDS / WORLDWIDE_ONLY_BOARDS not found");
    const names = (s) => s.split(",").map((x) => x.trim()).filter(Boolean).map((x) => (x === "WORLDWIDE_BOARD" ? board : x.replace(/^"|"$/g, "")));
    if (JSON.stringify(names(boards[1])) !== JSON.stringify([...shared100.WORLDWIDE_SOURCES]))
      fail(`check 100: WORLDWIDE_SOURCES is ${JSON.stringify(shared100.WORLDWIDE_SOURCES)}, the backend's WORLDWIDE_BOARDS ${JSON.stringify(names(boards[1]))} (PLAN 32)`);
    if (JSON.stringify(names(only[1]).sort()) !== JSON.stringify([...shared100.WORLDWIDE_ONLY_SOURCES].sort()))
      fail(`check 100: WORLDWIDE_ONLY_SOURCES is ${JSON.stringify(shared100.WORLDWIDE_ONLY_SOURCES)}, the backend's ${JSON.stringify(names(only[1]))} (PLAN 32)`);
  }
  const judge100 = (searched, apply) => {
    const out = [];
    const all = [...shared100.SOURCE_IDS];
    const noOnly = all.filter((s) => !shared100.WORLDWIDE_ONLY_SOURCES.includes(s));
    const ctx = (over) => ({ job_title: "QA", location: "", work_mode: "any", limit: 10, ...over });
    const cases = [
      ["no customisation", null, noOnly],
      ["the pass off", ctx({}), noOnly],
      ["the pass on", ctx({ include_worldwide: true, work_mode: "remote" }), all],
      ["the pass on over an on-site search", ctx({ include_worldwide: true, work_mode: "onsite" }), noOnly],
      ["two boards, pass off", ctx({ sources: ["drushim", "himalayas"] }), ["drushim"]],
      ["two boards, pass on", ctx({ sources: ["drushim", "himalayas"], include_worldwide: true }), ["drushim", "himalayas"]],
    ];
    for (const [label, c, want] of cases)
      if (JSON.stringify(searched(c)) !== JSON.stringify(want)) out.push(`searchedSources with ${label} is ${JSON.stringify(searched(c))}`);
    const r = { job_titles: [], location: "", work_mode: "", include_worldwide: true, notes: [], used_model: false };
    if (JSON.stringify(apply(ctx({ sources: ["drushim", "himalayas"] }), r).sources) !== JSON.stringify(["drushim", "himalayas"]))
      out.push("'abroad' over a set holding Himalayas changes its boards");
    if (JSON.stringify(apply(ctx({ sources: ["drushim"] }), r).sources) !== JSON.stringify(["drushim", "linkedin"]))
      out.push("'abroad' over a set with no worldwide board does not put LinkedIn back");
    return out;
  };
  for (const p of judge100(shared100.searchedSources, shared100.applySearchReading)) fail(`check 100: ${p} (PLAN 32)`);
  for (const [label, s, a] of [
    ["a search that always lists Himalayas", (c) => (c?.sources?.length ? [...c.sources] : [...shared100.SOURCE_IDS]), shared100.applySearchReading],
    ["'abroad' that adds LinkedIn whenever it is missing", shared100.searchedSources,
      (p, r) => ({ ...p, include_worldwide: true, sources: p.sources.includes("linkedin") ? p.sources : [...p.sources, "linkedin"] })],
  ])
    if (!judge100(s, a).length) throw new Error(`the judge passes ${label}`);

  const read100 = ({ jobs, alerts, en, he }) => {
    const out = [];
    const run = /function runSearch\(\) \{[\s\S]*?\n  \}\n/.exec(jobs);
    if (!run) throw new Error("pages/JobsPage.tsx: function runSearch not found");
    if (!/setRequestedSources\(searchedSources\(c\)\)/.test(run[0])) out.push("the scan panel is not fed the boards the search asks (searchedSources)");
    const fields = fnSource(alerts, "export function CustomizeFields");
    if (/selectedSources\.includes\("linkedin"\)/.test(fields)) out.push("the worldwide opt-in is still gated on LinkedIn alone");
    if (!/selectedSources\.some\(\(s\) => WORLDWIDE_SOURCES\.includes\(s\)\)/.test(fields)) out.push("the worldwide opt-in is not gated on the worldwide boards");
    if (!/WORLDWIDE_ONLY_SOURCES\.includes\(id\) && \(\s*<span[^>]*>\{t\("search\.worldwideOnlyBoard"\)\}/.test(fields))
      out.push("the board list does not say a worldwide-only board is remote abroad");
    if (!/<label key=\{id\} className="flex min-h-11 /.test(fields)) out.push("a board in the list is not a 44 px row");
    for (const [loc, b] of [["en", en], ["he", he]]) {
      for (const k of ["worldwideLine", "worldwideNeedsLinkedIn", "worldwideWhy"])
        if (!/Himalayas/.test(b.search?.[k] ?? "")) out.push(`locales/${loc}/jobs.json search.${k} does not name Himalayas`);
      if (typeof b.search?.worldwideOnlyBoard !== "string" || !b.search.worldwideOnlyBoard.trim())
        out.push(`locales/${loc}/jobs.json has no search.worldwideOnlyBoard`);
    }
    return out;
  };
  const real100 = {
    jobs: decomment(read("pages/JobsPage.tsx")),
    alerts: decomment(read("pages/jobs/AlertsCard.tsx")),
    en: JSON.parse(read("locales/en/jobs.json")),
    he: JSON.parse(read("locales/he/jobs.json")),
  };
  for (const p of read100(real100)) fail(`check 100: ${p} (PLAN 32)`);
  const plant100 = (key, from, to, label) => {
    if (!real100[key].includes(from)) throw new Error(`the probe could not plant "${label}"`);
    if (!read100({ ...real100, [key]: real100[key].replace(from, to) }).length) throw new Error(`the reader passes "${label}"`);
  };
  plant100("jobs", "setRequestedSources(searchedSources(c))", "setRequestedSources(c?.sources ?? [])", "a scan panel fed the chosen boards");
  plant100("alerts", "const worldwideBoard = selectedSources.some((s) => WORLDWIDE_SOURCES.includes(s));",
    'const worldwideBoard = selectedSources.includes("linkedin");', "an opt-in gated on LinkedIn alone");
  plant100("alerts", '<label key={id} className="flex min-h-11 ', '<label key={id} className="flex ', "a board row too small to tap");
  if (!read100({ ...real100, he: { ...real100.he, search: { ...real100.he.search, worldwideLine: "מלינקדאין." } } }).length)
    throw new Error("the reader passes a Hebrew line that names LinkedIn alone");
} catch (e) {
  fail(`worldwide boards check (check 100) could not run: ${e.message}`);
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
    (pySkips.size ? ` — and ${[...pySkips].join(", ")} read NO Python (backend/, or backend/tests, is not in this build)` : "") +
    (agentsSkip ? ` — and AGENTS.md was NOT compared with CLAUDE.md (${agentsSkip})` : "") +
    (extensionSkip ? ` — and the extension was NOT checked (${extensionSkip})` : ""),
);
