# Bundled fonts

All three families ship under the SIL Open Font License 1.1 (full text in
`OFL.txt`), which permits bundling and embedding in the PDFs we generate.

| Family | Files | Used for | Copyright |
| --- | --- | --- | --- |
| Noto Sans Hebrew | `NotoSansHebrew-{Regular,Bold}.ttf` | every Hebrew résumé (covers Hebrew + Latin) | 2022 The Noto Project Authors |
| Lato | `Lato-{Regular,Bold,Italic}.ttf` | the `classic`, `modern`, `compact` and `minimal` templates | 2010–2014 Łukasz Dziedzic |
| Spectral | `Spectral-{Regular,Bold,Italic}.ttf` | the `executive` template | 2017 Production Type |

The PDF renderer embeds only the glyph subset each résumé actually uses, so
adding a family here costs repository size, not download size.

`pdf_renderer._fonts()` falls back to the base-14 faces (Helvetica / Times) if
a file is missing, so a bad deploy degrades to a plain PDF instead of a failed
download. Removing a file therefore fails quietly — check the rendered output,
not just the exit code.

The DOCX renderer never embeds anything: it names a family Word resolves
locally (`docx_font` in `templates.py`), chosen to be the closest widely
installed twin of the PDF face.
