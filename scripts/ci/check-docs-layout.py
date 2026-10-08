#!/usr/bin/env python3
"""Fail when published docs leave the public/internal/agents layout.

Uniskela imports docs/manifest.json and rejects docs/internal and docs/agents.
Existing uniskela.com slugs stay stable; `public` is not part of the URL.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "docs" / "manifest.json"
LINK = re.compile(r"\]\(([^)\s]+)")

# Slugs already published at /docs/ts6-manager/latest/<slug>/.
# api-errors is the public API guide that the overview already linked.
PUBLISHED_SLUGS = {
    "readme",
    "index",
    "installation",
    "pwa",
    "configuration",
    "upgrading",
    "migrating-from-clusterzx",
    "server-management",
    "music-bots",
    "bot-flows",
    "video-streaming",
    "environment-variables",
    "reverse-proxy",
    "troubleshooting",
    "security",
    "teamspeak-compatibility",
    "architecture",
    "api-errors",
    "development",
    "roadmap",
}

LINK_ROOTS = [
    ROOT / "docs",
    ROOT / "README.md",
    ROOT / "AGENTS.md",
    ROOT / "CREDITS.md",
]


def fail(messages: list[str]) -> int:
    print("docs layout check failed:", file=sys.stderr)
    for message in messages:
        print(f"  {message}", file=sys.stderr)
    return 1


def markdown_files() -> list[Path]:
    files: list[Path] = []
    for root in LINK_ROOTS:
        if root.is_file():
            files.append(root)
        else:
            files.extend(sorted(root.rglob("*.md")))
    return files


def check_manifest(errors: list[str]) -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 1:
        errors.append("docs/manifest.json schemaVersion must stay 1")
    pages = manifest.get("pages")
    if not isinstance(pages, list) or not pages:
        errors.append("docs/manifest.json pages must be a non-empty list")
        return

    slugs: list[str] = []
    sources: list[str] = []
    for page in pages:
        source = page.get("source")
        slug = page.get("slug")
        kind = page.get("kind")
        if not isinstance(source, str) or not isinstance(slug, str):
            errors.append(f"page missing source/slug: {page!r}")
            continue
        slugs.append(slug)
        sources.append(source)
        if "/internal/" in source or "/agents/" in source or source.startswith(("docs/internal", "docs/agents")):
            errors.append(f"manifest publishes a non-public source: {source}")
        path = ROOT / source
        if not path.is_file():
            errors.append(f"manifest source missing: {source}")
        if source == "README.md":
            if slug != "readme" or kind != "readme":
                errors.append("README.md must stay slug readme kind readme")
        elif not source.startswith("docs/public/") or not source.endswith(".md") or kind != "doc":
            errors.append(f"published guide must be docs/public/*.md kind doc: {source}")
        elif "/public/" in slug:
            errors.append(f"slug must not include public: {slug}")

    if len(slugs) != len(set(slugs)):
        errors.append("duplicate documentation slugs")
    if len(sources) != len(set(sources)):
        errors.append("duplicate documentation sources")
    if set(slugs) != PUBLISHED_SLUGS:
        missing = sorted(PUBLISHED_SLUGS - set(slugs))
        extra = sorted(set(slugs) - PUBLISHED_SLUGS)
        errors.append(f"slug set changed; missing={missing} extra={extra}")


def check_links(errors: list[str]) -> None:
    for path in markdown_files():
        text = path.read_text(encoding="utf-8")
        for match in LINK.finditer(text):
            target = match.group(1)
            if target.startswith(("http://", "https://", "mailto:", "#")):
                if "/docs/ts6-manager/" in target and "/public/" in target:
                    errors.append(f"{path.relative_to(ROOT)} puts public into a uniskela.com URL: {target}")
                continue
            relative = target.split("#", 1)[0].split("?", 1)[0]
            if not relative:
                continue
            resolved = (path.parent / relative).resolve()
            try:
                resolved.relative_to(ROOT)
            except ValueError:
                errors.append(f"{path.relative_to(ROOT)} link escapes the repo: {target}")
                continue
            if not resolved.exists():
                errors.append(f"{path.relative_to(ROOT)} broken link: {target}")


def main() -> int:
    errors: list[str] = []
    if not (ROOT / "docs" / "internal").is_dir() or not (ROOT / "docs" / "agents").is_dir():
        errors.append("docs/internal and docs/agents must both exist")
    check_manifest(errors)
    check_links(errors)
    if errors:
        return fail(errors)
    print("OK: docs layout, slugs, and relative links")
    return 0


if __name__ == "__main__":
    sys.exit(main())
