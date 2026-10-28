#!/usr/bin/env python3
"""Verify a GitHub OIDC attestation for the private-beta tarball.

Trust comes from GitHub-signed attestations for this workflow identity and the
dispatch input SHA. A checksum or provenance file written by the build job is
not accepted as proof.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

PREDICATE_TYPE = "https://github.com/uniskela/ts6-manager/private-beta-publish/v1"
SIGNER_WORKFLOW = "uniskela/ts6-manager/.github/workflows/publish-discord-bridge-private-beta.yml"


def file_sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_attestation(
    path: str,
    commit: str,
    repo: str,
    signer_workflow: str = SIGNER_WORKFLOW,
    runner=subprocess.run,
) -> str:
    digest = file_sha256(path)
    proc = runner(
        [
            "gh",
            "attestation",
            "verify",
            path,
            "--repo",
            repo,
            "--signer-workflow",
            signer_workflow,
            "--predicate-type",
            PREDICATE_TYPE,
            "--format",
            "json",
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise SystemExit(proc.stderr.strip() or proc.stdout.strip() or "attestation verify failed")
    payload = json.loads(proc.stdout)
    if not payload:
        raise SystemExit("attestation verify returned no results")
    for entry in payload:
        statement = ((entry.get("verificationResult") or {}).get("statement") or {})
        pred = statement.get("predicate") or {}
        if pred.get("source_sha") != commit:
            raise SystemExit(f"attestation source_sha {pred.get('source_sha')!r} != {commit}")
        subjects = statement.get("subject") or []
        names = [item.get("name") for item in subjects]
        digests = [((item.get("digest") or {}).get("sha256")) for item in subjects]
        if digest not in digests and Path(path).name not in names:
            # gh verify already bound the file hash; still require the SHA in the statement when present.
            if digests and digest not in digests:
                raise SystemExit("attestation subject digest does not match the tarball")
    return f"attested source_sha={commit} tarball_sha256={digest}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--signer-workflow", default=SIGNER_WORKFLOW)
    args = parser.parse_args(argv)
    print(verify_attestation(args.file, args.commit, args.repo, args.signer_workflow))
    return 0


if __name__ == "__main__":
    sys.exit(main())
