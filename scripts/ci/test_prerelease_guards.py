"""Regression tests for prerelease SHA/tag collision and ancestry guards."""

import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
GUARD = ROOT / "scripts" / "ci" / "prerelease-guards.sh"
SHA_A = "a" * 40
SHA_B = "b" * 40


def run_guard(*args, env=None, cwd=None, timeout=20):
    return subprocess.run(
        ["bash", str(GUARD), *args],
        cwd=cwd,
        env=env or os.environ.copy(),
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def git(cwd, *args):
    subprocess.check_call(["git", *args], cwd=cwd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def write_exec(path: Path, body: str) -> None:
    path.write_text(body, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


class PrereleaseGuardTests(unittest.TestCase):
    def test_source_branch_allowlist(self):
        self.assertEqual(run_guard("validate-source-branch", "main").returncode, 0)
        self.assertEqual(run_guard("validate-source-branch", "release/1.12").returncode, 0)
        for branch in ("feature/x", "refs/pull/1/head", "release", ""):
            with self.subTest(branch=branch):
                self.assertNotEqual(run_guard("validate-source-branch", branch).returncode, 0)

    def test_ancestor_rejects_unreviewed_commit(self):
        with tempfile.TemporaryDirectory() as tmp:
            origin = Path(tmp) / "origin"
            clone = Path(tmp) / "clone"
            origin.mkdir()
            git(origin, "init", "-b", "main")
            git(origin, "config", "user.email", "ci@example.test")
            git(origin, "config", "user.name", "ci")
            (origin / "README").write_text("main\n", encoding="utf-8")
            git(origin, "add", "README")
            git(origin, "commit", "-m", "base")
            main_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=origin, text=True).strip()
            subprocess.check_call(["git", "clone", str(origin), str(clone)], stdout=subprocess.DEVNULL)
            git(clone, "config", "user.email", "ci@example.test")
            git(clone, "config", "user.name", "ci")
            git(clone, "checkout", "-b", "pr")
            (clone / "README").write_text("pr\n", encoding="utf-8")
            git(clone, "add", "README")
            git(clone, "commit", "-m", "unreviewed")
            pr_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=clone, text=True).strip()

            ok = run_guard("require-ancestor", main_sha, "main", cwd=clone)
            self.assertEqual(ok.returncode, 0, ok.stderr)
            bad = run_guard("require-ancestor", pr_sha, "main", cwd=clone)
            self.assertNotEqual(bad.returncode, 0)
            self.assertIn("not reachable", bad.stderr)

    def test_tag_collision_rejects_republish_from_other_sha(self):
        with tempfile.TemporaryDirectory() as tmp:
            origin = Path(tmp) / "origin"
            clone = Path(tmp) / "clone"
            origin.mkdir()
            git(origin, "init", "-b", "main")
            git(origin, "config", "user.email", "ci@example.test")
            git(origin, "config", "user.name", "ci")
            (origin / "README").write_text("one\n", encoding="utf-8")
            git(origin, "add", "README")
            git(origin, "commit", "-m", "one")
            first = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=origin, text=True).strip()
            git(origin, "tag", "v1.12.0-beta.1")
            (origin / "README").write_text("two\n", encoding="utf-8")
            git(origin, "add", "README")
            git(origin, "commit", "-m", "two")
            second = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=origin, text=True).strip()
            subprocess.check_call(["git", "clone", str(origin), str(clone)], stdout=subprocess.DEVNULL)

            same = run_guard("reject-tag-collision", "v1.12.0-beta.1", first, cwd=clone)
            self.assertEqual(same.returncode, 0, same.stderr)
            moved = run_guard("reject-tag-collision", "v1.12.0-beta.1", second, cwd=clone)
            self.assertNotEqual(moved.returncode, 0)
            self.assertIn(first, moved.stderr)
            missing = run_guard("reject-tag-collision", "v1.12.0-beta.2", second, cwd=clone)
            self.assertEqual(missing.returncode, 0, missing.stderr)

    def _inspect_env(self, rows):
        handle = tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False)
        handle.write("\n".join(rows) + "\n")
        handle.close()
        self.addCleanup(lambda: Path(handle.name).unlink(missing_ok=True))
        return {**os.environ, "PRERELEASE_IMAGE_INSPECT": handle.name}

    def _reject(self, env, sha=SHA_A, tag="v1.12.0-beta.1", version="1.12.0-beta.1", short=""):
        args = ["reject-image-collision", "ghcr.io/uniskela/ts6-manager", tag, version, sha]
        if short:
            args.append(short)
        return run_guard(*args, env=env)

    def test_image_collision_absent_allows_publish(self):
        env = self._inspect_env([])
        result = self._reject(env)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_image_collision_same_revision_allows_republish(self):
        env = self._inspect_env(
            [
                f"ghcr.io/uniskela/ts6-manager/backend:v1.12.0-beta.1\t{SHA_A}",
                f"ghcr.io/uniskela/ts6-manager/backend:1.12.0-beta.1\t{SHA_A}",
                f"ghcr.io/uniskela/ts6-manager/backend:sha-{SHA_A[:7]}\t{SHA_A}",
            ]
        )
        result = self._reject(env)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_image_collision_rejects_other_revision(self):
        env = self._inspect_env(
            [
                f"ghcr.io/uniskela/ts6-manager/backend:v1.12.0-beta.1\t{SHA_A}",
                f"ghcr.io/uniskela/ts6-manager/backend:1.12.0-beta.1\t{SHA_A}",
            ]
        )
        moved = self._reject(env, sha=SHA_B)
        self.assertNotEqual(moved.returncode, 0)
        self.assertIn(SHA_A, moved.stderr)

    def test_image_collision_fails_closed_without_revision(self):
        env = self._inspect_env(["ghcr.io/uniskela/ts6-manager/backend:v1.12.0-beta.1\t"])
        missing_label = self._reject(env)
        self.assertNotEqual(missing_label.returncode, 0)
        self.assertIn("no readable revision", missing_label.stderr)

    def test_image_collision_fails_closed_on_registry_error(self):
        env = self._inspect_env(["ghcr.io/uniskela/ts6-manager/backend:v1.12.0-beta.1\t\terror"])
        failed = self._reject(env)
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn("refusing to publish", failed.stderr)

    def test_image_collision_checks_short_sha_tag(self):
        env = self._inspect_env([f"ghcr.io/uniskela/ts6-manager/backend:sha-{SHA_A[:7]}\t{SHA_B}"])
        conflict = self._reject(env, sha=SHA_A, tag="", version="")
        self.assertNotEqual(conflict.returncode, 0)
        self.assertIn(SHA_B, conflict.stderr)
        self.assertIn(f"sha-{SHA_A[:7]}", conflict.stderr)

    def test_image_collision_scopes_to_one_component(self):
        env = self._inspect_env([f"ghcr.io/uniskela/ts6-manager/frontend:v1.12.0-beta.1\t{SHA_B}"])
        scoped = run_guard(
            "reject-image-collision",
            "ghcr.io/uniskela/ts6-manager",
            "v1.12.0-beta.1",
            "1.12.0-beta.1",
            SHA_A,
            SHA_A[:7],
            "backend",
            env=env,
        )
        self.assertEqual(scoped.returncode, 0, scoped.stderr)
        unscoped = self._reject(env)
        self.assertNotEqual(unscoped.returncode, 0)
        self.assertIn("frontend", unscoped.stderr)

    def test_github_release_refuses_other_commit(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp)
            write_exec(
                fake / "gh",
                f"""#!/bin/sh
if [ "$1" = release ] && [ "$2" = view ]; then
  [ "$3" = "v1.12.0-beta.1" ] && [ "${{RELEASE_EXISTS:-1}}" = 1 ] && exit 0
  exit 1
fi
if [ "$1" = api ]; then
  case "$2" in
    repos/uniskela/ts6-manager/git/ref/tags/v1.12.0-beta.1)
      [ "${{TAG_EXISTS:-1}}" = 1 ] && exit 0
      exit 1
      ;;
    repos/uniskela/ts6-manager/commits/v1.12.0-beta.1)
      printf '%s\\n' '{SHA_A}'
      exit 0
      ;;
  esac
fi
exit 1
""",
            )
            env = {**os.environ, "GH": str(fake / "gh"), "PATH": f"{fake}:{os.environ.get('PATH', '')}"}
            skip = run_guard(
                "verify-github-release-target",
                "v1.12.0-beta.1",
                SHA_A,
                "uniskela/ts6-manager",
                env=env,
            )
            self.assertEqual(skip.returncode, 0, skip.stderr)
            self.assertEqual(skip.stdout.strip(), "skip")
            moved = run_guard(
                "verify-github-release-target",
                "v1.12.0-beta.1",
                SHA_B,
                "uniskela/ts6-manager",
                env=env,
            )
            self.assertNotEqual(moved.returncode, 0)
            create = run_guard(
                "verify-github-release-target",
                "v1.12.0-beta.2",
                SHA_B,
                "uniskela/ts6-manager",
                env=env,
            )
            self.assertEqual(create.returncode, 0, create.stderr)
            self.assertEqual(create.stdout.strip(), "create")
            tag_moved = run_guard(
                "verify-github-release-target",
                "v1.12.0-beta.1",
                SHA_B,
                "uniskela/ts6-manager",
                env={**env, "RELEASE_EXISTS": "0", "TAG_EXISTS": "1"},
            )
            self.assertNotEqual(tag_moved.returncode, 0)
            self.assertIn("refusing to publish", tag_moved.stderr)

    def test_reviewers_required(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp)
            write_exec(
                fake / "gh",
                """#!/bin/sh
[ "$1" = api ] || exit 1
if [ "$2" = repos/uniskela/ts6-manager/environments/prerelease ]; then
  printf '%s\\n' "$GH_JQ_RESULT"
  exit 0
fi
exit 1
""",
            )
            env_ok = {
                **os.environ,
                "GH": str(fake / "gh"),
                "GH_JQ_RESULT": "1",
            }
            env_bad = {**env_ok, "GH_JQ_RESULT": "0"}
            # The script uses gh --jq; the fake ignores --jq and prints GH_JQ_RESULT.
            self.assertEqual(
                run_guard("require-prerelease-reviewers", "uniskela/ts6-manager", env=env_ok).returncode,
                0,
            )
            self.assertNotEqual(
                run_guard("require-prerelease-reviewers", "uniskela/ts6-manager", env=env_bad).returncode,
                0,
            )


DOCKER_MOCK = r"""#!/usr/bin/env python3
import json
import os
import sys


def fail(msg):
    print(msg, file=sys.stderr)
    raise SystemExit(1)


args = sys.argv[1:]
if args[:3] != ["buildx", "imagetools", "inspect"]:
    fail("unexpected docker invocation: " + " ".join(args))
fmt = None
image = None
rest = args[3:]
i = 0
while i < len(rest):
    if rest[i] == "--raw":
        fail("unexpected --raw inspect; use --format {{json .Image}}")
    if rest[i] == "--format":
        fmt = rest[i + 1]
        i += 2
        continue
    image = rest[i]
    i += 1
if not image:
    fail("missing image")
mode = os.environ.get("DOCKER_MOCK_MODE", "absent")
present = os.environ.get(
    "DOCKER_MOCK_IMAGE",
    "ghcr.io/uniskela/ts6-manager/backend:v1.12.0-beta.1",
)
revision = os.environ.get("DOCKER_MOCK_REVISION", "")
name = image.split("@", 1)[0]

if mode == "absent":
    fail("ERROR: manifest unknown")
if mode == "registry-error":
    fail(os.environ.get("DOCKER_MOCK_ERROR", "unauthorized: authentication required"))
if name != present:
    fail("ERROR: manifest unknown")
if not fmt:
    raise SystemExit(0)
if "{{json .Image}}" not in fmt:
    fail("unexpected format: " + fmt)

labels = {}
if mode != "missing-label":
    labels["org.opencontainers.image.revision"] = revision
single = {"architecture": "amd64", "config": {"Labels": labels}}
if mode == "multiarch":
    print(
        json.dumps(
            {
                "linux/amd64": single,
                "linux/arm64": {"architecture": "arm64", "config": {"Labels": dict(labels)}},
                "unknown/unknown": {
                    "config": {"Labels": {"org.opencontainers.image.revision": "0" * 40}}
                },
            }
        )
    )
elif mode == "multiarch-conflict":
    print(
        json.dumps(
            {
                "linux/amd64": single,
                "linux/arm64": {
                    "architecture": "arm64",
                    "config": {"Labels": {"org.opencontainers.image.revision": "b" * 40}},
                },
            }
        )
    )
else:
    print(json.dumps(single))
"""


class TestImageInspectDockerMock(unittest.TestCase):
    def _env(self, mode, revision="", image="ghcr.io/uniskela/ts6-manager/backend:v1.12.0-beta.1", error=""):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        write_exec(Path(tmp.name) / "docker", DOCKER_MOCK)
        env = {k: v for k, v in os.environ.items() if k != "PRERELEASE_IMAGE_INSPECT"}
        env["PATH"] = f"{tmp.name}:{env.get('PATH', '')}"
        env["DOCKER_MOCK_MODE"] = mode
        env["DOCKER_MOCK_IMAGE"] = image
        env["DOCKER_MOCK_REVISION"] = revision
        if error:
            env["DOCKER_MOCK_ERROR"] = error
        return env

    def _reject(self, env, sha=SHA_A, tag="v1.12.0-beta.1", version="1.12.0-beta.1"):
        return run_guard(
            "reject-image-collision",
            "ghcr.io/uniskela/ts6-manager",
            tag,
            version,
            sha,
            env=env,
        )

    def test_absent_image_allows_publish(self):
        result = self._reject(self._env("absent"))
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_same_revision_allows_republish(self):
        result = self._reject(self._env("present", SHA_A))
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_conflicting_revision_blocks_publish(self):
        result = self._reject(self._env("present", SHA_B), sha=SHA_A)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(SHA_B, result.stderr)

    def test_missing_label_blocks_publish(self):
        result = self._reject(self._env("missing-label"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no readable revision", result.stderr)

    def test_registry_failure_blocks_publish(self):
        for msg in (
            "unauthorized: authentication required",
            "toomanyrequests: rate limited",
            "context deadline exceeded",
            "net/http: TLS handshake timeout",
        ):
            with self.subTest(msg=msg):
                result = self._reject(self._env("registry-error", error=msg))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("refusing to publish", result.stderr)

    def test_multiarch_uses_config_not_annotations(self):
        result = self._reject(self._env("multiarch", SHA_A))
        self.assertEqual(result.returncode, 0, result.stderr)
        annotated_only = self._reject(self._env("multiarch", ""), sha=SHA_A)
        self.assertNotEqual(annotated_only.returncode, 0)
        self.assertIn("no readable revision", annotated_only.stderr)

    def test_multiarch_conflicting_revisions_block_publish(self):
        result = self._reject(self._env("multiarch-conflict", SHA_A))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("conflicting config revisions", result.stderr)

    def test_short_sha_tag_collision(self):
        result = self._reject(
            self._env("present", SHA_B, f"ghcr.io/uniskela/ts6-manager/backend:sha-{SHA_A[:7]}"),
            sha=SHA_A,
            tag="",
            version="",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f"sha-{SHA_A[:7]}", result.stderr)


LIVE_PREFIX = "ghcr.io/uniskela/ts6-manager"
LIVE_TAG = "v1.11.2"
LIVE_VERSION = "1.11.2"
LIVE_REV = "5cc02df35a0fa19b4fccaebd47506aefc8352aa4"
LIVE_IMAGE = f"{LIVE_PREFIX}/backend:{LIVE_TAG}"


def _live_image_json():
    return subprocess.run(
        ["docker", "buildx", "imagetools", "inspect", "--format", "{{json .Image}}", LIVE_IMAGE],
        capture_output=True,
        text=True,
        timeout=60,
    )


def live_registry_available():
    try:
        result = _live_image_json()
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0 and "org.opencontainers.image.revision" in result.stdout


class TestRevisionFromImageJson(unittest.TestCase):
    def _parse(self, payload):
        return subprocess.run(
            ["bash", str(GUARD), "revision-from-image-json"],
            input=payload,
            capture_output=True,
            text=True,
            timeout=10,
        )

    def test_single_platform_config(self):
        result = self._parse(
            json.dumps(
                {
                    "architecture": "amd64",
                    "config": {"Labels": {"org.opencontainers.image.revision": SHA_A}},
                }
            )
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, SHA_A)

    def test_multi_platform_map_ignores_unknown_and_conflicts(self):
        same = self._parse(
            json.dumps(
                {
                    "linux/amd64": {"config": {"Labels": {"org.opencontainers.image.revision": SHA_A}}},
                    "linux/arm64": {"config": {"Labels": {"org.opencontainers.image.revision": SHA_A}}},
                    "unknown/unknown": {"config": {"Labels": {"org.opencontainers.image.revision": SHA_B}}},
                }
            )
        )
        self.assertEqual(same.returncode, 0, same.stderr)
        self.assertEqual(same.stdout, SHA_A)
        conflict = self._parse(
            json.dumps(
                {
                    "linux/amd64": {"config": {"Labels": {"org.opencontainers.image.revision": SHA_A}}},
                    "linux/arm64": {"config": {"Labels": {"org.opencontainers.image.revision": SHA_B}}},
                }
            )
        )
        self.assertNotEqual(conflict.returncode, 0)
        self.assertIn("conflicting config revisions", conflict.stderr)


@unittest.skipUnless(live_registry_available(), "GHCR image inspect unavailable")
class TestLiveGhcrRevision(unittest.TestCase):
    def test_format_image_revision_matches_published_label(self):
        inspected = _live_image_json()
        self.assertEqual(inspected.returncode, 0, inspected.stderr)
        parsed = subprocess.run(
            ["bash", str(GUARD), "revision-from-image-json"],
            input=inspected.stdout,
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(parsed.returncode, 0, parsed.stderr)
        self.assertEqual(parsed.stdout, LIVE_REV)

    def test_matching_revision_allows_republish(self):
        result = run_guard(
            "reject-image-collision",
            LIVE_PREFIX,
            LIVE_TAG,
            LIVE_VERSION,
            LIVE_REV,
            LIVE_REV[:7],
            "backend",
            timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_conflicting_revision_blocks_publish(self):
        result = run_guard(
            "reject-image-collision",
            LIVE_PREFIX,
            LIVE_TAG,
            LIVE_VERSION,
            SHA_B,
            LIVE_REV[:7],
            "backend",
            timeout=60,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(LIVE_REV, result.stderr)


if __name__ == "__main__":
    unittest.main()
