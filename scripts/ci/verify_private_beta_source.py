#!/usr/bin/env python3
"""Prove a commit is on open, same-repository PR #504 via the GitHub API.

The privileged publish path must call this with GitHub-provided inputs, not
metadata from the image artifact. gh is invoked here so a shell heredoc cannot
swallow the PR JSON on stdin.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys


def gh_api(path: str, runner=subprocess.run) -> object:
    proc = runner(["gh", "api", path], capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(proc.stderr.strip() or proc.stdout.strip() or f"gh api failed: {path}")
    return json.loads(proc.stdout)


def pr_commits(repo: str, source_pr: str, runner=subprocess.run) -> list[str]:
    shas: list[str] = []
    page = 1
    while True:
        batch = gh_api(f"repos/{repo}/pulls/{source_pr}/commits?per_page=100&page={page}", runner=runner)
        if not isinstance(batch, list) or not batch:
            break
        shas.extend(item.get("sha") for item in batch)
        if len(batch) < 100:
            break
        page += 1
    return shas


def verify_source(commit: str, repo: str, source_pr: str, runner=subprocess.run) -> str:
    if source_pr != "504":
        raise SystemExit("source PR must be 504")
    meta = gh_api(f"repos/{repo}/pulls/{source_pr}", runner=runner)
    if not isinstance(meta, dict):
        raise SystemExit("PR metadata was not an object")
    if meta.get("state") != "open":
        raise SystemExit(f"PR #{source_pr} must be open")
    head = ((meta.get("head") or {}).get("repo") or {}).get("full_name")
    if head != repo:
        raise SystemExit(f"PR #{source_pr} must be from {repo}")
    shas = pr_commits(repo, source_pr, runner=runner)
    if commit not in shas:
        raise SystemExit(f"{commit} is not a commit on PR #{source_pr}")
    return f"commit {commit} is on open PR #{source_pr}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--commit", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--pr", required=True)
    args = parser.parse_args(argv)
    print(verify_source(args.commit, args.repo, args.pr))
    return 0


if __name__ == "__main__":
    sys.exit(main())
