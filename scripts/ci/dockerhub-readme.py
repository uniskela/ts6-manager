#!/usr/bin/env python3
"""Cut README.md down to the sections a Docker Hub reader needs.

Docker Hub keeps only the first 25,000 bytes of a repository README, and the
full README is about twice that. This keeps the text before the first `##`
heading plus the SECTIONS below, in README order, and ends with a link to the
full README. It fails instead of publishing a page with a missing section or
one Hub would cut short.

Write the output as README.md (in another directory) and pass it through
complete-relative-readme-urls.py: relative links, including the footer and
`#anchor` links to sections left out here, then point at the full README.md of
the release tag on GitHub.
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

SECTIONS = (
    "Documentation",
    "Quick Start (Docker)",
    "Environment Variables",
    "Environment Variables: Sidecar / Video Streaming",
    "Requirements",
    "License",
)
# Leaves room for the URL rewrite, which adds about 55 bytes per relative link,
# under Docker Hub's 25,000.
MAX_BYTES = 20_000
FOOTER = (
    "---\n\n"
    "This is a shortened README for Docker Hub. Screenshots, features, "
    "architecture, development setup, TeamSpeak compatibility, music bot "
    "commands and contributors are in the [full README](README.md) for this "
    "release.\n"
)

HEADING_RE = re.compile(r"^## (?!#)(.+?)\s*#*\s*$")
FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})")


class ReadmeError(Exception):
    pass


def split_sections(text: str) -> tuple[str, list[tuple[str, str]]]:
    """Return the text before the first `##` heading and each (heading, text)."""
    preamble: list[str] = []
    sections: list[tuple[str, list[str]]] = []
    fence = ""
    for line in text.splitlines(keepends=True):
        match = FENCE_RE.match(line)
        if match:
            marker = match.group(1)
            if not fence:
                fence = marker
            elif marker[0] == fence[0] and len(marker) >= len(fence) and not line.strip()[len(marker):]:
                fence = ""
        heading = None if fence or match else HEADING_RE.match(line.rstrip("\n"))
        if heading:
            sections.append((heading.group(1), [line]))
        elif sections:
            sections[-1][1].append(line)
        else:
            preamble.append(line)
    return "".join(preamble), [(name, "".join(lines)) for name, lines in sections]


def build(text: str, sections=SECTIONS, max_bytes=MAX_BYTES) -> str:
    preamble, found = split_sections(text)
    names = [name for name, _ in found]
    missing = [name for name in sections if name not in names]
    if missing:
        raise ReadmeError(f"README.md has no '## ' section named: {', '.join(missing)}")
    duplicated = sorted({name for name in sections if names.count(name) > 1})
    if duplicated:
        raise ReadmeError(f"README.md has more than one '## ' section named: {', '.join(duplicated)}")
    kept = [body.rstrip("\n") + "\n" for name, body in found if name in sections]
    out = "\n".join([preamble.rstrip("\n") + "\n", *kept, FOOTER])
    size = len(out.encode("utf-8"))
    if size > max_bytes:
        raise ReadmeError(
            f"The Docker Hub README is {size} bytes, over the {max_bytes} allowed before URL rewriting; "
            "shorten its sections or keep fewer in scripts/ci/dockerhub-readme.py."
        )
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("readme", type=Path)
    parser.add_argument("outfile", type=Path)
    args = parser.parse_args()
    try:
        out = build(args.readme.read_text(encoding="utf-8"))
    except ReadmeError as error:
        print(f"::error::{error}")
        return 1
    args.outfile.parent.mkdir(parents=True, exist_ok=True)
    args.outfile.write_text(out, encoding="utf-8")
    print(f"Docker Hub README: kept {len(SECTIONS)} sections, {len(out.encode('utf-8'))} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
