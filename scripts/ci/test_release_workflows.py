"""Check image-publication boundaries without building or publishing images."""

import os
from pathlib import Path
import subprocess
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[2]
WRITERS = {
    "build-and-push",
    "build-all-in-one",
    "promote-latest",
    "promote-all-in-one-latest",
    "make-public",
}
BUILDERS = {"build-and-push", "build-all-in-one"}


def workflow(name):
    # BaseLoader keeps YAML 1.1's `on` and booleans as strings, like other
    # workflow scalars. No workflow expressions or actions are executed.
    return yaml.load(
        (ROOT / ".github/workflows" / name).read_text(), Loader=yaml.BaseLoader
    )


class ReleaseWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.publish = workflow("publish-images.yml")
        self.release = workflow("release-please.yml")
        self.validation = workflow("pr-validation.yml")

    def test_only_publish_jobs_can_write_packages(self):
        default = self.publish["permissions"]
        self.assertEqual(default, {"contents": "read"})
        writers = set()
        for name, job in self.publish["jobs"].items():
            # A job permissions map replaces the default; omitted scopes
            # become none, rather than inheriting individual default scopes.
            effective = job.get("permissions", default)
            with self.subTest(job=name):
                if name in WRITERS:
                    expected = {"packages": "write"}
                    if name in BUILDERS:
                        expected["contents"] = "read"
                    self.assertEqual(effective, expected)
                else:
                    self.assertEqual(effective, {"contents": "read"})
            if effective.get("packages") == "write":
                writers.add(name)
        self.assertEqual(writers, WRITERS)

    def test_repo_hygiene_actions_are_immutable_and_read_only(self):
        job = self.validation["jobs"]["repo-hygiene"]
        self.assertEqual(
            job.get("permissions", self.validation["permissions"]),
            {"contents": "read"},
        )
        actions = [step["uses"] for step in job["steps"] if "uses" in step]
        self.assertTrue(actions)
        for action in actions:
            with self.subTest(action=action):
                self.assertRegex(action, r"^[\w-]+/[\w-]+@[0-9a-f]{40}$")
        self.assertIn("pull_request", self.validation["on"])
        self.assertNotIn("pull_request_target", self.validation["on"])

    def test_reusable_caller_ceiling_allows_required_permissions(self):
        caller = self.release["jobs"]["publish-images"]
        self.assertEqual(caller["uses"], "./.github/workflows/publish-images.yml")
        self.assertEqual(caller["permissions"], {"contents": "read", "packages": "write"})
        rank = {"none": 0, "read": 1, "write": 2}
        for name, job in self.publish["jobs"].items():
            effective = job.get("permissions", self.publish["permissions"])
            for scope, access in effective.items():
                with self.subTest(job=name, scope=scope):
                    self.assertLessEqual(rank[access], rank[caller["permissions"].get(scope, "none")])

    def test_publication_requires_release_creation_or_manual_recovery(self):
        self.assertEqual(set(self.publish["on"]), {"workflow_call", "workflow_dispatch"})
        for event in ("workflow_call", "workflow_dispatch"):
            self.assertEqual(
                {key: self.publish["on"][event]["inputs"]["tag"][key] for key in ("required", "type")},
                {"required": "true", "type": "string"},
            )
        caller = self.release["jobs"]["publish-images"]
        self.assertEqual(caller["needs"], "release-please")
        self.assertEqual(caller["if"], "needs.release-please.outputs.release_created == 'true'")
        self.assertEqual(caller["with"]["tag"], "${{ needs.release-please.outputs.tag_name }}")

    def test_builds_validate_tag_before_checkout(self):
        for name in BUILDERS:
            steps = self.publish["jobs"][name]["steps"]
            guard = next(step for step in steps if step.get("name") == "Validate release tag")
            checkout = next(step for step in steps if step.get("name") == "Checkout release tag")
            self.assertLess(steps.index(guard), steps.index(checkout))
            self.assertEqual(guard["env"]["TAG"], "${{ inputs.tag }}")
            self.assertEqual(checkout["with"]["ref"], "refs/tags/${{ inputs.tag }}")
            for tag in ("v1.2.3", "v0.0.1", "main", "1.2.3", "v1.2.3-rc.1", ""):
                with self.subTest(job=name, tag=tag):
                    result = subprocess.run(
                        ["bash", "-c", guard["run"]],
                        env={**os.environ, "TAG": tag},
                        capture_output=True,
                        timeout=5,
                    )
                    self.assertEqual(result.returncode == 0, tag in {"v1.2.3", "v0.0.1"})

    def test_latest_promotion_depends_on_successful_build(self):
        for promotion, build in (
            ("promote-latest", "build-and-push"),
            ("promote-all-in-one-latest", "build-all-in-one"),
        ):
            job = self.publish["jobs"][promotion]
            self.assertEqual(job["needs"], build)
            self.assertNotIn("if", job)  # Keep GitHub's default success() guard.

    def test_description_recovery_uses_released_readme_and_current_rewriter(self):
        steps = self.publish["jobs"]["update-dockerhub-description"]["steps"]
        names = [step["name"] for step in steps]
        self.assertLess(names.index("Checkout workflow revision"), names.index("Keep Hub README rewrite script"))
        self.assertLess(names.index("Keep Hub README rewrite script"), names.index("Checkout release tag"))
        checkout = steps[names.index("Checkout release tag")]
        self.assertEqual(checkout["with"]["ref"], "refs/tags/${{ inputs.tag }}")
        self.assertEqual(checkout["with"]["persist-credentials"], "false")


if __name__ == "__main__":
    unittest.main()
