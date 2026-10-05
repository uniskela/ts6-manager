#!/usr/bin/env python3
"""Fail when package.json pnpm.overrides are missing from pnpm-lock.yaml.

Dependabot often regenerates the lockfile without the top-level overrides
block, which breaks `pnpm install --frozen-lockfile` (ERR_PNPM_LOCKFILE_CONFIG_MISMATCH).
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PACKAGE_JSON = ROOT / "package.json"
LOCKFILE = ROOT / "pnpm-lock.yaml"


def main() -> int:
    pkg = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))
    expected = pkg.get("pnpm", {}).get("overrides") or {}
    if not expected:
        print("OK: no pnpm.overrides in package.json")
        return 0

    lock = LOCKFILE.read_text(encoding="utf-8")
    match = re.search(r"(?m)^overrides:\n((?:[ \t].*\n)*)", lock)
    if not match:
        print(
            "pnpm-lock.yaml is missing a top-level overrides: block, "
            "but package.json defines pnpm.overrides.\n"
            "Close Dependabot PRs that strip overrides; regenerate with "
            "`pnpm install` (pnpm 9) on a human branch.",
            file=sys.stderr,
        )
        return 1

    present: set[str] = set()
    for line in match.group(1).splitlines():
        key_match = re.match(r"^[ \t]+(.+?):\s*", line)
        if not key_match:
            continue
        key = key_match.group(1).strip()
        if len(key) >= 2 and key[0] == key[-1] and key[0] in "'\"":
            key = key[1:-1]
        present.add(key)

    missing = sorted(set(expected) - present)
    if missing:
        print(
            "pnpm-lock.yaml overrides are missing keys from package.json "
            f"pnpm.overrides: {', '.join(missing)}",
            file=sys.stderr,
        )
        return 1

    print(f"OK: lockfile overrides cover {len(expected)} pnpm.overrides key(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
