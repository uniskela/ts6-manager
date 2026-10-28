#!/usr/bin/env python3
"""Integration-style checks for private-beta source, GHCR, and attestation helpers."""
from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from types import SimpleNamespace

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

from verify_private_beta_attestation import (
    CERT_IDENTITY,
    PREDICATE_TYPE,
    file_sha256,
    parse_gh_version,
    require_gh_version,
    resolved_subject,
    verify_attestation,
)
from verify_private_beta_ghcr import (
    anonymous_pull_denied,
    require_private_package,
    seal_or_retract,
    verify_after_push,
)
from verify_private_beta_source import verify_source


ROOT = Path(__file__).resolve().parents[2]
COMMIT = "4e944acb667d3d0c19c5b1ae476652ae4eaa77e2"
REPO = "uniskela/ts6-manager"
WORKFLOW = ROOT / ".github/workflows/publish-discord-bridge-private-beta.yml"


def workflow():
    return yaml.load(WORKFLOW.read_text(), Loader=yaml.BaseLoader)


def expand_run(text: str, commit: str = COMMIT) -> str:
    return (
        text.replace("${{ steps.sha.outputs.sha }}", commit)
        .replace("${{ needs.verify-and-build.outputs.sha }}", commit)
        .replace("${{ github.repository }}", REPO)
        .replace("${{ env.SOURCE_PR }}", "504")
    )


class FakeProc(SimpleNamespace):
    pass


class FakeGh:
    def __init__(self, routes: dict):
        self.routes = routes

    def __call__(self, args, capture_output=True, text=True):
        path = args[-1]
        if path not in self.routes:
            return FakeProc(returncode=1, stdout="", stderr=f"gh: {path} not found")
        value = self.routes[path]
        if value is None:
            return FakeProc(returncode=1, stdout="", stderr="gh: Not Found (HTTP 404)")
        return FakeProc(returncode=0, stdout=json.dumps(value), stderr="")


def pr_routes(state="open", head=REPO, commits=None):
    if commits is None:
        commits = [COMMIT]
    return {
        f"repos/{REPO}/pulls/504": {"state": state, "head": {"repo": {"full_name": head}}},
        f"repos/{REPO}/pulls/504/commits?per_page=100&page=1": [{"sha": sha} for sha in commits],
    }


def write_fake_gh(directory: Path, routes: dict) -> None:
    payload = json.dumps(routes)
    path = directory / "gh"
    path.write_text(
        "#!/usr/bin/env python3\n"
        "import json, sys\n"
        f"routes = json.loads({payload!r})\n"
        "path = sys.argv[-1]\n"
        "if path not in routes or routes[path] is None:\n"
        "    sys.stderr.write('gh: Not Found (HTTP 404)\\n')\n"
        "    sys.exit(1)\n"
        "json.dump(routes[path], sys.stdout)\n"
    )
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


def run_workflow_step(run: str, routes: dict, commit: str = COMMIT) -> subprocess.CompletedProcess:
    with tempfile.TemporaryDirectory() as tmp:
        bindir = Path(tmp)
        write_fake_gh(bindir, routes)
        env = {**os.environ, "PATH": f"{bindir}:{os.environ['PATH']}", "GH_TOKEN": "x"}
        return subprocess.run(
            ["bash", "-c", expand_run(run, commit)],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=10,
            input='{"state":"closed","head":{"repo":{"full_name":"evil/fork"}}}',
        )


class SourceVerifyTests(unittest.TestCase):
    def test_accepts_open_same_repo_commit(self):
        msg = verify_source(COMMIT, REPO, "504", runner=FakeGh(pr_routes()))
        self.assertIn(COMMIT, msg)

    def test_rejects_closed_pr_wrong_repo_and_foreign_commit(self):
        cases = [
            ("505", FakeGh(pr_routes())),
            ("504", FakeGh(pr_routes(state="closed"))),
            ("504", FakeGh(pr_routes(head="evil/fork"))),
            ("504", FakeGh(pr_routes(commits=["deadbeef" * 5]))),
        ]
        for pr, runner in cases:
            with self.subTest(pr=pr), self.assertRaises(SystemExit):
                verify_source(COMMIT, REPO, pr, runner=runner)


class WorkflowSourceStepTests(unittest.TestCase):
    def setUp(self):
        jobs = workflow()["jobs"]
        self.steps = []
        for name in ("verify-and-build", "attest", "publish"):
            for step in jobs[name]["steps"]:
                if step.get("name") in (
                    "Verify commit belongs to PR 504",
                    "Re-verify commit belongs to PR 504",
                ):
                    self.steps.append((name, step["run"]))
        self.assertEqual(len(self.steps), 3)

    def test_all_jobs_accept_valid_pr_metadata_even_if_stdin_is_poisoned(self):
        routes = pr_routes()
        for job, run in self.steps:
            with self.subTest(job=job):
                result = run_workflow_step(run, routes)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(COMMIT, result.stdout)

    def test_all_jobs_reject_invalid_pr_wrong_repo_and_unauthorised_commit(self):
        cases = {
            "closed": pr_routes(state="closed"),
            "wrong_repo": pr_routes(head="evil/fork"),
            "foreign_commit": pr_routes(commits=["aa" * 20]),
        }
        for job, run in self.steps:
            for label, routes in cases.items():
                with self.subTest(job=job, case=label):
                    result = run_workflow_step(run, routes)
                    self.assertNotEqual(result.returncode, 0, result.stdout)


class FakeResp:
    def __init__(self, status, body=b""):
        self.status = status
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, n=-1):
        return self._body


class FakeOpener:
    def __init__(self, mapping):
        self.mapping = mapping

    def __call__(self, req, timeout=30):
        url = req if isinstance(req, str) else req.full_url
        for key, (status, body) in self.mapping.items():
            if key in url:
                if status >= 400:
                    raise urllib.error.HTTPError(url, status, "err", hdrs=None, fp=None)
                return FakeResp(status, body)
        raise RuntimeError(url)


class GhcrTests(unittest.TestCase):
    def test_require_private_rejects_missing_public_and_existing_tag(self):
        tag = f"private-beta-{COMMIT}"
        missing = FakeGh(
            {
                f"users/uniskela/packages/container/ts6-manager%2Fdiscord-bridge": None,
                f"orgs/uniskela/packages/container/ts6-manager%2Fdiscord-bridge": None,
            }
        )
        with self.assertRaises(SystemExit):
            require_private_package("uniskela", "ts6-manager/discord-bridge", tag, runner=missing)
        public = FakeGh(
            {
                f"users/uniskela/packages/container/ts6-manager%2Fdiscord-bridge": {"visibility": "public"},
            }
        )
        with self.assertRaises(SystemExit):
            require_private_package("uniskela", "ts6-manager/discord-bridge", tag, runner=public)
        taken = FakeGh(
            {
                f"users/uniskela/packages/container/ts6-manager%2Fdiscord-bridge": {"visibility": "private"},
                f"users/uniskela/packages/container/ts6-manager%2Fdiscord-bridge/versions?per_page=100&page=1": [
                    {"metadata": {"container": {"tags": [tag]}}}
                ],
            }
        )
        with self.assertRaises(SystemExit):
            require_private_package("uniskela", "ts6-manager/discord-bridge", tag, runner=taken)

    def test_seal_or_retract_keeps_private_and_retracts_public(self):
        tag = f"private-beta-{COMMIT}"
        pkg = "users/uniskela/packages/container/ts6-manager%2Fdiscord-bridge"
        private = FakeGh({pkg: {"visibility": "private"}})
        self.assertEqual(
            seal_or_retract("uniskela", "ts6-manager/discord-bridge", tag, runner=private),
            "visibility=private",
        )
        public = FakeGh(
            {
                pkg: {"visibility": "public"},
                f"{pkg}/versions?per_page=100&page=1": [
                    {"id": 99, "metadata": {"container": {"tags": [tag]}}}
                ],
                f"{pkg}/versions/99": {},
            }
        )
        calls = []

        def recording(args, capture_output=True, text=True):
            calls.append(args)
            return public(args, capture_output=capture_output, text=text)

        with self.assertRaises(SystemExit) as exc:
            seal_or_retract("uniskela", "ts6-manager/discord-bridge", tag, runner=recording)
        self.assertIn("retracted", str(exc.exception))
        self.assertIn("cannot be made private", str(exc.exception))
        self.assertTrue(any("DELETE" in arg for args in calls for arg in args))
        self.assertFalse(any("PATCH" in arg for args in calls for arg in args))

        missing_tag = FakeGh(
            {
                pkg: {"visibility": "public"},
                f"{pkg}/versions?per_page=100&page=1": [{"id": 1, "metadata": {"container": {"tags": []}}}],
            }
        )
        with self.assertRaises(SystemExit) as missing:
            seal_or_retract("uniskela", "ts6-manager/discord-bridge", tag, runner=missing_tag)
        self.assertIn("no version carrying", str(missing.exception))
        self.assertNotIn(f"retracted {tag}", str(missing.exception))

    def test_bearer_flow_fails_on_public_manifest_and_fail_closed(self):
        token = json.dumps({"token": "anon"}).encode()
        public = FakeOpener(
            {
                "ghcr.io/token": (200, token),
                "/manifests/": (200, b"{}"),
            }
        )
        with self.assertRaises(SystemExit) as pub:
            anonymous_pull_denied("uniskela", "ts6-manager/discord-bridge", "t", opener=public)
        self.assertIn("public", str(pub.exception))
        denied = FakeOpener(
            {
                "ghcr.io/token": (200, token),
                "/manifests/": (401, b""),
            }
        )
        self.assertIn("401", anonymous_pull_denied("uniskela", "ts6-manager/discord-bridge", "t", opener=denied))
        token_fail = FakeOpener({"ghcr.io/token": (401, b"")})
        with self.assertRaises(SystemExit):
            anonymous_pull_denied("uniskela", "ts6-manager/discord-bridge", "t", opener=token_fail)
        boom = FakeOpener({})
        with self.assertRaises(SystemExit):
            anonymous_pull_denied("uniskela", "ts6-manager/discord-bridge", "t", opener=boom)

    def test_verify_after_push_retracts_anonymous_200_not_other_versions(self):
        tag = f"private-beta-{COMMIT}"
        pkg = "users/uniskela/packages/container/ts6-manager%2Fdiscord-bridge"
        gh = FakeGh(
            {
                pkg: {"visibility": "private"},
                f"{pkg}/versions?per_page=100&page=1": [
                    {"id": 99, "metadata": {"container": {"tags": [tag]}}},
                    {"id": 1, "metadata": {"container": {"tags": ["keep-me"]}}},
                    {"id": 2, "metadata": {"container": {"tags": [tag, "other"]}}},
                ],
                f"{pkg}/versions/99": {},
            }
        )
        calls = []

        def recording(args, capture_output=True, text=True):
            calls.append(args)
            return gh(args, capture_output=capture_output, text=text)

        opener = FakeOpener(
            {
                "ghcr.io/token": (200, json.dumps({"token": "anon"}).encode()),
                "/manifests/": (200, b"{}"),
            }
        )
        with self.assertRaises(SystemExit) as exc:
            verify_after_push(
                "uniskela",
                "ts6-manager/discord-bridge",
                tag,
                runner=recording,
                opener=opener,
            )
        msg = str(exc.exception)
        self.assertIn("anonymous pull succeeded", msg)
        self.assertIn(f"retracted {tag}", msg)
        self.assertIn("refused to delete unrelated versions", msg)
        deleted = [args[-1] for args in calls if "--method" in args and "DELETE" in args]
        self.assertEqual(deleted, [f"{pkg}/versions/99"])

    def test_verify_after_push_private_denied_does_not_retract(self):
        tag = f"private-beta-{COMMIT}"
        pkg = "users/uniskela/packages/container/ts6-manager%2Fdiscord-bridge"
        gh = FakeGh(
            {
                pkg: {"visibility": "private"},
                f"{pkg}/versions?per_page=100&page=1": [
                    {"id": 99, "metadata": {"container": {"tags": [tag]}}},
                ],
                f"{pkg}/versions/99": {},
            }
        )
        calls = []

        def recording(args, capture_output=True, text=True):
            calls.append(args)
            return gh(args, capture_output=capture_output, text=text)

        opener = FakeOpener(
            {
                "ghcr.io/token": (200, json.dumps({"token": "anon"}).encode()),
                "/manifests/": (401, b""),
            }
        )
        msg = verify_after_push(
            "uniskela",
            "ts6-manager/discord-bridge",
            tag,
            runner=recording,
            opener=opener,
        )
        self.assertIn("visibility=private", msg)
        self.assertFalse(any("--method" in args and "DELETE" in args for args in calls))

    def test_verify_after_push_keeps_exposure_if_retract_listing_fails(self):
        tag = f"private-beta-{COMMIT}"
        pkg = "users/uniskela/packages/container/ts6-manager%2Fdiscord-bridge"
        gh = FakeGh({pkg: {"visibility": "private"}})
        opener = FakeOpener(
            {
                "ghcr.io/token": (200, json.dumps({"token": "anon"}).encode()),
                "/manifests/": (200, b"{}"),
            }
        )
        with self.assertRaises(SystemExit) as exc:
            verify_after_push(
                "uniskela",
                "ts6-manager/discord-bridge",
                tag,
                runner=gh,
                opener=opener,
            )
        msg = str(exc.exception)
        self.assertIn("anonymous pull succeeded", msg)
        self.assertIn("retract failed:", msg)

    def test_verify_after_push_reports_delete_failure(self):
        tag = f"private-beta-{COMMIT}"
        pkg = "users/uniskela/packages/container/ts6-manager%2Fdiscord-bridge"
        gh = FakeGh(
            {
                pkg: {"visibility": "private"},
                f"{pkg}/versions?per_page=100&page=1": [
                    {"id": 99, "metadata": {"container": {"tags": [tag]}}},
                ],
            }
        )
        opener = FakeOpener(
            {
                "ghcr.io/token": (200, json.dumps({"token": "anon"}).encode()),
                "/manifests/": (200, b"{}"),
            }
        )
        with self.assertRaises(SystemExit) as exc:
            verify_after_push(
                "uniskela",
                "ts6-manager/discord-bridge",
                tag,
                runner=gh,
                opener=opener,
            )
        self.assertIn("DELETE failed", str(exc.exception))

    def test_post_push_privacy_runs_when_digest_inspect_fails(self):
        publish = workflow()["jobs"]["publish"]
        steps = {step.get("name"): step for step in publish["steps"]}
        push = steps["Push commit-specific tag only"]
        digest = steps["Record published digest"]
        confirm = steps["Confirm private visibility and deny anonymous pull"]
        names = [step.get("name") for step in publish["steps"]]
        self.assertEqual(push.get("id"), "push")
        self.assertIn("docker push", push["run"])
        self.assertNotIn("imagetools inspect", push["run"])
        self.assertIn("imagetools inspect", digest["run"])
        self.assertIsNone(digest.get("if"))
        self.assertLess(names.index("Push commit-specific tag only"), names.index("Record published digest"))
        self.assertLess(names.index("Record published digest"), names.index("Confirm private visibility and deny anonymous pull"))
        condition = confirm.get("if", "")
        self.assertIn("always()", condition)
        self.assertIn("steps.push.outcome", condition)
        self.assertIn("skipped", condition)
        self.assertIn("verify-after-push", confirm["run"])
        self.assertNotIn("anonymous-denied", confirm["run"])


class VerifyGh:
    def __init__(self, payload=None, version="gh version 2.102.0 (2026-09-30)\n", identity=CERT_IDENTITY, predicate=PREDICATE_TYPE, returncode=0, stderr=""):
        self.payload = payload or []
        self.version = version
        self.identity = identity
        self.predicate = predicate
        self.returncode = returncode
        self.stderr = stderr
        self.last_verify = None

    def __call__(self, args, capture_output=True, text=True):
        if args[:2] == ["gh", "--version"]:
            return FakeProc(returncode=0, stdout=self.version, stderr="")
        self.last_verify = args
        if args[1:3] != ["attestation", "verify"]:
            return FakeProc(returncode=1, stdout="", stderr="unexpected gh invocation")
        ident = args[args.index("--cert-identity") + 1] if "--cert-identity" in args else ""
        pred = args[args.index("--predicate-type") + 1] if "--predicate-type" in args else ""
        if ident != self.identity:
            return FakeProc(returncode=1, stdout="", stderr="certificate identity mismatch")
        if pred != self.predicate:
            return FakeProc(returncode=1, stdout="", stderr="predicate type mismatch")
        if self.returncode != 0:
            return FakeProc(returncode=self.returncode, stdout="", stderr=self.stderr)
        return FakeProc(returncode=0, stdout=json.dumps(self.payload), stderr="")


class AttestationTests(unittest.TestCase):
    def _tarball(self):
        tmp = tempfile.TemporaryDirectory()
        path = str(Path(tmp.name) / "image.tar.gz")
        Path(path).write_bytes(b"image-bytes")
        self.addCleanup(tmp.cleanup)
        return path, file_sha256(path)

    def _payload(self, digest, source_sha=COMMIT):
        return [
            {
                "verificationResult": {
                    "statement": {
                        "predicate": {"source_sha": source_sha},
                        "subject": [{"name": "image.tar.gz", "digest": {"sha256": digest}}],
                    }
                }
            }
        ]

    def test_require_gh_102(self):
        self.assertEqual(parse_gh_version("gh version 2.102.0 (2026-09-30)\n"), (2, 102, 0))
        with self.assertRaises(SystemExit):
            require_gh_version(runner=lambda args, **kw: FakeProc(returncode=0, stdout="gh version 2.101.0\n", stderr=""))
        help_text = subprocess.check_output(["gh", "attestation", "verify", "--help"], text=True)
        self.assertGreaterEqual(parse_gh_version(subprocess.check_output(["gh", "--version"], text=True)), (2, 102, 0))
        self.assertIn("--cert-identity", help_text)
        self.assertIn("--source-ref", help_text)

    def test_passes_cert_identity_and_source_ref(self):
        path, digest = self._tarball()
        runner = VerifyGh(payload=self._payload(digest))
        msg = verify_attestation(path, COMMIT, REPO, runner=runner)
        self.assertIn(COMMIT, msg)
        args = runner.last_verify
        self.assertIn("--cert-identity", args)
        self.assertEqual(args[args.index("--cert-identity") + 1], CERT_IDENTITY)
        self.assertIn("--source-ref", args)
        self.assertEqual(args[args.index("--source-ref") + 1], "refs/heads/main")
        self.assertEqual(args[args.index("--predicate-type") + 1], PREDICATE_TYPE)
        self.assertNotIn("--signer-workflow", args)

    def test_rejects_wrong_signer_predicate_sha_digest_and_missing(self):
        path, digest = self._tarball()
        cases = {
            "wrong_signer": {
                "cert_identity": "https://github.com/evil/repo/.github/workflows/x.yml@refs/heads/main",
                "runner": VerifyGh(payload=self._payload(digest)),
            },
            "wrong_predicate": {
                "runner": VerifyGh(returncode=1, stderr="predicate type mismatch"),
            },
            "wrong_sha": {"runner": VerifyGh(payload=self._payload(digest, source_sha="00" * 20))},
            "mismatched_digest": {"runner": VerifyGh(payload=self._payload("ab" * 32))},
            "missing": {"runner": VerifyGh(returncode=1, stderr="no attestation")},
            "old_gh": {"runner": VerifyGh(version="gh version 2.101.0\n", payload=self._payload(digest))},
        }
        for label, kwargs in cases.items():
            with self.subTest(label), self.assertRaises(SystemExit):
                verify_attestation(path, COMMIT, REPO, **kwargs)

    def test_resolved_subject_rejects_traversal_wrong_name_and_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "image.tar.gz").write_bytes(b"x")
            with self.assertRaises(SystemExit):
                resolved_subject(str(root / ".." / "image.tar.gz"))
            with self.assertRaises(SystemExit):
                resolved_subject(str(root / "other.tar.gz"))
            secret = root / "secret.bin"
            secret.write_bytes(b"x")
            link = root / "image.tar.gz"
            link.unlink()
            link.symlink_to(secret)
            with self.assertRaises(SystemExit):
                resolved_subject(str(link))
            link.unlink()
            (root / "image.tar.gz").write_bytes(b"x")
            self.assertEqual(resolved_subject(str(root / "image.tar.gz")).name, "image.tar.gz")


if __name__ == "__main__":
    unittest.main()
