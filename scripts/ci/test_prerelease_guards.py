"""Regression tests for prerelease SHA/tag collision and ancestry guards."""

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


def run_guard(*args, env=None, cwd=None):
    return subprocess.run(
        ["bash", str(GUARD), *args],
        cwd=cwd,
        env=env or os.environ.copy(),
        capture_output=True,
        text=True,
        timeout=20,
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

    def test_image_collision_rejects_other_revision(self):
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as inspect:
            inspect.write(
                "\n".join(
                    [
                        f"ghcr.io/uniskela/ts6-manager/backend:v1.12.0-beta.1\t{SHA_A}",
                        f"ghcr.io/uniskela/ts6-manager/backend:1.12.0-beta.1\t{SHA_A}",
                    ]
                )
                + "\n"
            )
            inspect_path = inspect.name
        env = {**os.environ, "PRERELEASE_IMAGE_INSPECT": inspect_path}
        same = run_guard(
            "reject-image-collision",
            "ghcr.io/uniskela/ts6-manager",
            "v1.12.0-beta.1",
            "1.12.0-beta.1",
            SHA_A,
            env=env,
        )
        self.assertEqual(same.returncode, 0, same.stderr)
        moved = run_guard(
            "reject-image-collision",
            "ghcr.io/uniskela/ts6-manager",
            "v1.12.0-beta.1",
            "1.12.0-beta.1",
            SHA_B,
            env=env,
        )
        self.assertNotEqual(moved.returncode, 0)
        self.assertIn(SHA_A, moved.stderr)
        Path(inspect_path).unlink(missing_ok=True)

    def test_github_release_refuses_other_commit(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp)
            write_exec(
                fake / "gh",
                f"""#!/bin/sh
if [ "$1" = release ] && [ "$2" = view ]; then
  [ "$3" = "v1.12.0-beta.1" ] && exit 0
  exit 1
fi
if [ "$1" = api ] && [ "$2" = repos/uniskela/ts6-manager/commits/v1.12.0-beta.1 ]; then
  printf '%s\\n' '{SHA_A}'
  exit 0
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


if __name__ == "__main__":
    unittest.main()
