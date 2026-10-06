#!/usr/bin/env python3
"""Rewrite relative markdown URLs to GitHub blob/raw URLs for a given ref.

Used before peter-evans/dockerhub-description because that action completes
URLs from GITHUB_REF_NAME, which GitHub does not allow workflows to override.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

IMAGE_EXT = {".bmp", ".gif", ".jpg", ".jpeg", ".png", ".svg", ".webp"}
LINK_RE = re.compile(r"(!?\[[^\]]*\])\(([^)]+)\)")


def is_absolute(url: str) -> bool:
    return bool(re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", url) or url.startswith("//"))


def rewrite(content: str, blob_prefix: str, raw_prefix: str, readme_rel: str) -> str:
    def repl(match: re.Match[str]) -> str:
        prefix, inner = match.group(1), match.group(2)
        parts = inner.strip().split(None, 1)
        url = parts[0]
        rest = f" {parts[1]}" if len(parts) > 1 else ""
        if is_absolute(url):
            return match.group(0)
        if url.startswith("#"):
            url = f"{blob_prefix}{readme_rel}{url}"
        else:
            path = url[2:] if url.startswith("./") else url
            ext = Path(path.split("#", 1)[0]).suffix.lower()
            base = raw_prefix if prefix.startswith("![") and ext in IMAGE_EXT else blob_prefix
            url = f"{base}{path.lstrip('/')}"
        return f"{prefix}({url}{rest})"

    return LINK_RE.sub(repl, content)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("readme")
    parser.add_argument("outfile")
    parser.add_argument("--ref", required=True)
    args = parser.parse_args()
    server = os.environ.get("GITHUB_SERVER_URL", "https://github.com").rstrip("/")
    repo = os.environ["GITHUB_REPOSITORY"]
    blob = f"{server}/{repo}/blob/{args.ref}/"
    raw = f"{server}/{repo}/raw/{args.ref}/"
    src = Path(args.readme)
    text = rewrite(src.read_text(encoding="utf-8"), blob, raw, src.name)
    Path(args.outfile).write_text(text, encoding="utf-8")
    return 0


def _self_check() -> None:
    out = rewrite(
        "![a](docs/x.png)\n[y](foo.md)\n[z](#z)\n[abs](https://example.com/a)",
        "BLOB/",
        "RAW/",
        "README.md",
    )
    assert "RAW/docs/x.png" in out, out
    assert "BLOB/foo.md" in out, out
    assert "BLOB/README.md#z" in out, out
    assert "[abs](https://example.com/a)" in out, out


if __name__ == "__main__":
    if len(sys.argv) == 1:
        _self_check()
        sys.exit(0)
    raise SystemExit(main())
