// Regenerates frontend/src/fonts.css from the fontsource packages, keeping only
// the subsets this app can actually render. Run from frontend/:
//   node scripts/gen-fonts.js
const fs = require("fs");

const KEEP = { inter: ["latin", "latin-ext"], heebo: ["hebrew", "latin", "latin-ext"] };

const header = `/* Font faces, trimmed to the subsets this app can render — see main.tsx.

   GENERATED from @fontsource-variable/{inter,heebo}/index.css. If you bump
   either package, regenerate rather than hand-editing the unicode-ranges.

   Dropped: inter-{cyrillic,cyrillic-ext,greek,greek-ext,vietnamese} and
   heebo-{math,symbols}. The heebo pair is not merely unused weight: its ranges
   cover U+2190 and U+25A0-27BF, so the arrow and check glyphs in the Hebrew
   locale strings were pulling a 14 kB font request during first paint for two
   characters. Those glyphs now fall back to the system font — which is already
   exactly what happens on the English side, because Inter ships no symbols
   subset at all. */

`;

let out = header;
const kept = [];
for (const [pkg, subsets] of Object.entries(KEEP)) {
  const css = fs.readFileSync(`node_modules/@fontsource-variable/${pkg}/index.css`, "utf8");
  for (const block of css.split("/*").slice(1)) {
    const m = block.match(new RegExp(`^\\s*${pkg}-(.+?)-wght-normal\\s*\\*/`));
    if (!m || !subsets.includes(m[1])) continue;
    kept.push(`${pkg}-${m[1]}`);
    out +=
      block
        .slice(block.indexOf("@font-face"))
        .replace("url(./files/", `url('@fontsource-variable/${pkg}/files/`)
        .replace(".woff2)", ".woff2')")
        .trim() + "\n\n";
  }
}
fs.writeFileSync("src/fonts.css", out);
console.log(`kept ${kept.length}: ${kept.join(", ")}`);
