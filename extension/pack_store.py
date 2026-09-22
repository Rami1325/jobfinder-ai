"""Build the Chrome Web Store upload for JobFinder Job Clipper.

    <any python 3.9+> extension/pack_store.py

Writes extension-dist/jobfinder-job-clipper-<version>.zip at the repo root
(git-ignored and Vercel-ignored), with manifest.json at the zip's root. Stdlib
only.

The repo's manifest.json stays the DEVELOPMENT manifest: it lists
localhost:8000 and 127.0.0.1:8000 so an unpacked copy can reach a local
backend. The Store copy asks for the production host alone, because every host
permission is shown to the user at install and weighed by the Store's review,
and a published build has no use for a developer's machine. Nothing else in the
manifest changes.

Dev-only files never reach the zip: this script, README.md and any other .md,
any .py, and dotfiles. Everything else under extension/ is packed, so a new
script or image cannot be left out by an allowlist nobody updated. Instead the
build then checks the zip against itself and fails loudly: every file the
manifest names (the popup, the options page, each icon, the default locale's
messages) and every local <script src> / <link href> in a packed page must be
IN the zip, and no host but production may be left in the manifest.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import sys
import zipfile
from pathlib import Path

EXT_DIR = Path(__file__).resolve().parent
ROOT = EXT_DIR.parent
OUT_DIR = ROOT / "extension-dist"

PROD_ORIGIN = "https://jobfinder-hazel-pi.vercel.app"
STORE_HOSTS = [PROD_ORIGIN + "/*"]

# A fixed timestamp makes the same source produce the same bytes, so two
# builds of one commit can be compared by hash.
FIXED_TIME = (1980, 1, 1, 0, 0, 0)


def excluded(rel: str) -> bool:
    parts = rel.split("/")
    name = parts[-1]
    if any(p.startswith(".") or p == "__pycache__" for p in parts):
        return True
    return name.endswith((".md", ".py", ".pyc")) or name in {"Thumbs.db", "desktop.ini"}


def store_manifest(dev: dict) -> dict:
    m = json.loads(json.dumps(dev))  # a deep copy
    m["host_permissions"] = list(STORE_HOSTS)
    return m


def fail(msg: str) -> None:
    print(f"pack_store: {msg}", file=sys.stderr)
    sys.exit(1)


def manifest_refs(m: dict) -> list[str]:
    """Every packaged file the manifest names."""
    refs = []
    action = m.get("action") or {}
    if action.get("default_popup"):
        refs.append(action["default_popup"])
    icon = action.get("default_icon")
    refs += list(icon.values()) if isinstance(icon, dict) else ([icon] if icon else [])
    refs += list((m.get("icons") or {}).values())
    opts = m.get("options_ui") or {}
    if opts.get("page"):
        refs.append(opts["page"])
    if m.get("options_page"):
        refs.append(m["options_page"])
    bg = m.get("background") or {}
    if bg.get("service_worker"):
        refs.append(bg["service_worker"])
    for cs in m.get("content_scripts") or []:
        refs += cs.get("js", []) + cs.get("css", [])
    if m.get("default_locale"):
        refs.append(f"_locales/{m['default_locale']}/messages.json")
    return refs


def page_refs(html: str) -> list[str]:
    """Local files a page loads by <script src> or <link href>."""
    out = []
    for m in re.finditer(r"<(?:script[^>]*\bsrc|link[^>]*\bhref)\s*=\s*[\"']([^\"']+)[\"']", html, re.I):
        target = m.group(1)
        if re.match(r"^[a-z][a-z0-9+.-]*:|^//", target, re.I):
            fail(f"a packed page loads {target!r} from outside the package; MV3 forbids remote code")
        out.append(target.split("?")[0].split("#")[0].lstrip("./"))
    return out


def main() -> None:
    dev = json.loads((EXT_DIR / "manifest.json").read_text(encoding="utf-8"))
    if dev.get("manifest_version") != 3:
        fail("manifest.json is not manifest_version 3")
    version = dev.get("version", "")
    if not re.fullmatch(r"\d+(\.\d+){0,3}", version):
        fail(f"manifest version {version!r} is not one the Store accepts")
    if PROD_ORIGIN + "/*" not in dev.get("host_permissions", []):
        fail(f"the development manifest no longer lists {PROD_ORIGIN}/*; the Store copy would not reach production")
    store = store_manifest(dev)

    files = sorted(
        p.relative_to(EXT_DIR).as_posix()
        for p in EXT_DIR.rglob("*")
        if p.is_file() and not excluded(p.relative_to(EXT_DIR).as_posix())
    )
    if "manifest.json" not in files:
        fail("extension/manifest.json is missing")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for rel in files:
            data = (
                (json.dumps(store, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
                if rel == "manifest.json"
                else (EXT_DIR / rel).read_bytes()
            )
            info = zipfile.ZipInfo(rel, date_time=FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, data)

    # Check the zip itself, not the folder it came from.
    with zipfile.ZipFile(io.BytesIO(buf.getvalue())) as zf:
        names = set(zf.namelist())
        packed = json.loads(zf.read("manifest.json"))
        if packed.get("host_permissions") != STORE_HOSTS:
            fail(f"the packed manifest asks for {packed.get('host_permissions')}, not {STORE_HOSTS}")
        blob = json.dumps(packed)
        for dev_host in ("localhost", "127.0.0.1"):
            if dev_host in blob:
                fail(f"the packed manifest still names {dev_host}")
        missing = [r for r in manifest_refs(packed) if r not in names]
        for page in [n for n in names if n.endswith(".html")]:
            missing += [f"{r} (loaded by {page})" for r in page_refs(zf.read(page).decode("utf-8")) if r not in names]
        if missing:
            fail("the zip lacks files the extension loads: " + ", ".join(dict.fromkeys(missing)))
        for size in ("16", "32", "48", "128"):
            if size not in (packed.get("icons") or {}):
                fail(f"the manifest has no {size}px icon; the Store requires a 128px one")
        stray = [n for n in names if excluded(n)]
        if stray:
            fail("dev-only files reached the zip: " + ", ".join(stray))

    OUT_DIR.mkdir(exist_ok=True)
    out = OUT_DIR / f"jobfinder-job-clipper-{version}.zip"
    out.write_bytes(buf.getvalue())
    print(f"wrote {out.relative_to(ROOT).as_posix()} ({out.stat().st_size} bytes, sha256 {hashlib.sha256(buf.getvalue()).hexdigest()})")
    print(f"host_permissions: {STORE_HOSTS}")
    with zipfile.ZipFile(out) as zf:
        for i in zf.infolist():
            print(f"  {i.file_size:>7}  {i.filename}")


if __name__ == "__main__":
    main()
