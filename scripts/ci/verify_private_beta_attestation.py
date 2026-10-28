#!/usr/bin/env python3
"""Verify a GitHub OIDC attestation for the private-beta tarball.

Attestation proves GitHub signed these tarball bytes for this workflow identity.
It does not prove the bytes were built from the dispatch SHA.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

PREDICATE_TYPE = "https://github.com/uniskela/ts6-manager/private-beta-publish/v1"
CERT_IDENTITY = (
    "https://github.com/uniskela/ts6-manager/.github/workflows/"
    "publish-discord-bridge-private-beta.yml@refs/heads/main"
)
SOURCE_REF = "refs/heads/main"
SUBJECT_NAME = "image.tar.gz"
MIN_GH = (2, 102, 0)


def parse_gh_version(text: str) -> tuple[int, int, int]:
    match = re.search(r"gh version (\d+)\.(\d+)\.(\d+)", text)
    if not match:
        raise SystemExit(f"unrecognized gh version output: {text.strip()!r}")
    return int(match.group(1)), int(match.group(2)), int(match.group(3))


def require_gh_version(runner=subprocess.run) -> str:
    proc = runner(["gh", "--version"], capture_output=True, text=True)
    text = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        raise SystemExit(text.strip() or "gh --version failed")
    ver = parse_gh_version(text)
    if ver < MIN_GH:
        raise SystemExit(
            f"gh {ver[0]}.{ver[1]}.{ver[2]} is older than 2.102.0; "
            "signer-workflow prefix matching is unsafe"
        )
    return f"gh {ver[0]}.{ver[1]}.{ver[2]}"


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
    cert_identity: str = CERT_IDENTITY,
    runner=subprocess.run,
) -> str:
    require_gh_version(runner=runner)
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
            "--cert-identity",
            cert_identity,
            "--predicate-type",
            PREDICATE_TYPE,
            "--source-ref",
            SOURCE_REF,
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
    return f"attested source_sha={commit} tarball_sha256={digest} identity={cert_identity}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--cert-identity", default=CERT_IDENTITY)
    args = parser.parse_args(argv)
    print(verify_attestation(args.file, args.commit, args.repo, args.cert_identity))
    return 0


if __name__ == "__main__":
    sys.exit(main())
