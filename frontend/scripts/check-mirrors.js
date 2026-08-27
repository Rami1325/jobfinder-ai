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
      const parts = key.split(".");
      const leaf = parts.pop();
      const parent = parts.reduce((o, k) => (o == null ? o : o[k]), common);
      // A counted label exists ONLY under its plural suffixes, so a plain path
      // lookup would report a correctly-translated key as missing. Restricted
      // to the real i18next suffixes so `nav.more` cannot be satisfied by some
      // unrelated `nav.more_menu`.
      const present =
        parent != null &&
        (parent[leaf] !== undefined ||
          Object.keys(parent).some(
            (k) => k.startsWith(`${leaf}_`) && /_(zero|one|two|few|many|other)$/.test(k),
          ));
      if (!present)
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

// ---- report --------------------------------------------------------------- //
if (problems.length) {
  console.error("\nMirror checks FAILED:\n");
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  process.exit(1);
}
console.log(`mirrors ok — ${sectionKeys.length} edit sections, en/he parity across all namespaces`);
