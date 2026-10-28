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
SUBJECT_NAME = "image.tar.gz"


def resolved_subject(path: str) -> Path:
    candidate = Path(path)
    if ".." in candidate.parts or candidate.name != SUBJECT_NAME:
        raise SystemExit(f"expected {SUBJECT_NAME}")
    resolved = candidate.resolve()
    if resolved.name != SUBJECT_NAME or not resolved.is_file():
        raise SystemExit(f"expected {SUBJECT_NAME}")
    return resolved


def file_sha256(path: str) -> str:
    digest = hashlib.sha256()
    with resolved_subject(path).open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _statement(entry: dict) -> dict:
    return ((entry.get("verificationResult") or {}).get("statement") or {})


def verify_attestation(
    path: str,
    commit: str,
    repo: str,
    signer_workflow: str = SIGNER_WORKFLOW,
    runner=subprocess.run,
) -> str:
    subject = resolved_subject(path)
    digest = file_sha256(str(subject))
    proc = runner(
        [
            "gh",
            "attestation",
            "verify",
            str(subject),
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
        statement = _statement(entry)
        pred = statement.get("predicate") or {}
        if pred.get("source_sha") != commit:
            raise SystemExit(f"attestation source_sha {pred.get('source_sha')!r} != {commit}")
        digests = [((item.get("digest") or {}).get("sha256")) for item in (statement.get("subject") or [])]
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
