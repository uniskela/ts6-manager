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

from verify_private_beta_attestation import file_sha256, verify_attestation
from verify_private_beta_ghcr import anonymous_pull_denied, require_private_package
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
        with self.assertRaises(SystemExit):
            verify_source(COMMIT, REPO, "505", runner=FakeGh(pr_routes()))
        with self.assertRaises(SystemExit):
            verify_source(COMMIT, REPO, "504", runner=FakeGh(pr_routes(state="closed")))
        with self.assertRaises(SystemExit):
            verify_source(COMMIT, REPO, "504", runner=FakeGh(pr_routes(head="evil/fork")))
        with self.assertRaises(SystemExit):
            verify_source(COMMIT, REPO, "504", runner=FakeGh(pr_routes(commits=["deadbeef" * 5])))


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


class AttestationTests(unittest.TestCase):
    def test_requires_github_signed_predicate_source_sha(self):
        with tempfile.NamedTemporaryFile() as fh:
            fh.write(b"image-bytes")
            fh.flush()
            digest = file_sha256(fh.name)
            good = {
                "verificationResult": {
                    "statement": {
                        "predicate": {"source_sha": COMMIT},
                        "subject": [{"name": "image.tar.gz", "digest": {"sha256": digest}}],
                    }
                }
            }
            def run(args, capture_output=True, text=True):
                self.assertEqual(args[0], "gh")
                self.assertEqual(args[1], "attestation")
                return FakeProc(returncode=0, stdout=json.dumps([good]), stderr="")

            self.assertIn(COMMIT, verify_attestation(fh.name, COMMIT, REPO, runner=run))
            bad = json.loads(json.dumps(good))
            bad["verificationResult"]["statement"]["predicate"]["source_sha"] = "00" * 20

            def run_bad(args, capture_output=True, text=True):
                return FakeProc(returncode=0, stdout=json.dumps([bad]), stderr="")

            with self.assertRaises(SystemExit):
                verify_attestation(fh.name, COMMIT, REPO, runner=run_bad)

            def run_fail(args, capture_output=True, text=True):
                return FakeProc(returncode=1, stdout="", stderr="no attestation")

            with self.assertRaises(SystemExit):
                verify_attestation(fh.name, COMMIT, REPO, runner=run_fail)


if __name__ == "__main__":
    unittest.main()
