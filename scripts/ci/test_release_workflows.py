"""Check image-publication boundaries without building or publishing images."""

import os
from pathlib import Path
import re
import subprocess
import tempfile
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
        self.description = workflow("dockerhub-description.yml")
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
        jobs = {name: self.publish["jobs"][name] for name in BUILDERS}
        jobs["dockerhub-description"] = self.description["jobs"]["update"]
        for name, job in jobs.items():
            steps = job["steps"]
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

    def test_description_recovery_uses_released_readme_and_current_scripts(self):
        steps = self.description["jobs"]["update"]["steps"]
        names = [step["name"] for step in steps]
        order = [
            "Checkout workflow revision",
            "Keep Hub README scripts",
            "Checkout release tag",
            "Shorten the README for Docker Hub",
            "Point relative README URLs at the release tag",
            "Check the README fits on Docker Hub",
            "Docker Hub Description",
        ]
        self.assertEqual([name for name in names if name in order], order)
        checkout = steps[names.index("Checkout release tag")]
        self.assertEqual(checkout["with"]["ref"], "refs/tags/${{ inputs.tag }}")
        self.assertEqual(checkout["with"]["persist-credentials"], "false")
        keep = steps[names.index("Keep Hub README scripts")]["run"]
        for script in ("dockerhub-readme.py", "complete-relative-readme-urls.py"):
            with self.subTest(script=script):
                self.assertIn(f'cp scripts/ci/{script} "$RUNNER_TEMP/{script}"', keep)
                # After the tag checkout, scripts/ci is the release's copy.
                for step in steps[names.index("Checkout release tag"):]:
                    self.assertNotRegex(step.get("run", ""), rf"(python3?\s+|\./)scripts/ci/{re.escape(script)}")

    def test_hub_gets_the_shortened_rewritten_readme(self):
        steps = {step["name"]: step for step in self.description["jobs"]["update"]["steps"]}
        hub = steps["Docker Hub Description"]["with"]
        self.assertEqual(hub["readme-filepath"], "${{ runner.temp }}/dockerhub-readme.md")
        self.assertEqual(hub["enable-url-completion"], "false")
        with tempfile.TemporaryDirectory() as tmp:
            temp, checkout = Path(tmp) / "runner-temp", Path(tmp) / "checkout"
            temp.mkdir()
            checkout.mkdir()
            readme = (ROOT / "README.md").read_bytes()
            (checkout / "README.md").write_bytes(readme)
            env = {**os.environ, "RUNNER_TEMP": str(temp), "TAG": "v1.2.3",
                   "GITHUB_REPOSITORY": "uniskela/ts6-manager", "GITHUB_SERVER_URL": "https://github.com"}

            def run(name, cwd):
                return subprocess.run(["bash", "-c", steps[name]["run"]], cwd=cwd, env=env,
                                      capture_output=True, text=True, timeout=30)

            for name, cwd in (
                ("Keep Hub README scripts", ROOT),
                ("Shorten the README for Docker Hub", checkout),
                ("Point relative README URLs at the release tag", checkout),
                ("Check the README fits on Docker Hub", checkout),
            ):
                with self.subTest(step=name):
                    result = run(name, cwd)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual((checkout / "README.md").read_bytes(), readme)
            final = (temp / "dockerhub-readme.md").read_text(encoding="utf-8")
            self.assertLessEqual(len(final.encode("utf-8")), 25_000)
            self.assertLess(len(final), len(readme) // 2)
            self.assertIn("(https://github.com/uniskela/ts6-manager/blob/v1.2.3/README.md#screenshots)", final)
            self.assertIn("[full README](https://github.com/uniskela/ts6-manager/blob/v1.2.3/README.md)", final)

            for size, fits in ((25_000, True), (25_001, False)):
                with self.subTest(size=size):
                    (temp / "dockerhub-readme.md").write_bytes(b"x" * size)
                    result = run("Check the README fits on Docker Hub", checkout)
                    self.assertEqual(result.returncode == 0, fits)
                    self.assertEqual("::error::" in result.stdout, not fits)

    def test_description_update_follows_a_build_and_holds_nothing_back(self):
        caller = self.publish["jobs"]["update-dockerhub-description"]
        self.assertEqual(caller["uses"], "./.github/workflows/dockerhub-description.yml")
        self.assertEqual(caller["needs"], ["build-and-push", "build-all-in-one"])
        self.assertEqual(
            caller["if"],
            "always() && (needs.build-and-push.result == 'success' || needs.build-all-in-one.result == 'success')",
        )
        self.assertEqual(caller["with"], {"tag": "${{ inputs.tag }}"})
        for name, other in self.publish["jobs"].items():
            needs = other.get("needs", [])
            with self.subTest(job=name):
                self.assertNotIn("update-dockerhub-description", [needs] if isinstance(needs, str) else needs)

    def test_refused_description_update_fails_the_job(self):
        job = self.description["jobs"]["update"]
        self.assertNotIn("continue-on-error", job)
        for step in job["steps"]:
            with self.subTest(step=step["name"]):
                self.assertNotIn("continue-on-error", step)
        explain = next(step for step in job["steps"] if step["name"] == "Explain a failed Hub update")
        self.assertEqual(explain["if"], "failure() && steps.hub-description.outcome == 'failure'")

    def test_description_token_stays_in_its_environment(self):
        on = self.description["on"]
        self.assertEqual(set(on), {"workflow_call", "workflow_dispatch"})
        for event in ("workflow_call", "workflow_dispatch"):
            self.assertEqual(
                {key: on[event]["inputs"]["tag"][key] for key in ("required", "type")},
                {"required": "true", "type": "string"},
            )
        # Declared or named secrets hide the environment's token from a
        # called job; it only arrives through `secrets: inherit`.
        self.assertNotIn("secrets", on["workflow_call"])
        self.assertEqual(self.description["permissions"], {"contents": "read"})
        self.assertEqual(set(self.description["jobs"]), {"update"})
        job = self.description["jobs"]["update"]
        self.assertEqual(job["environment"], "dockerhub-description")
        self.assertNotIn("permissions", job)
        hub = next(step for step in job["steps"] if step["name"] == "Docker Hub Description")
        self.assertEqual(hub["with"]["password"], "${{ secrets.DOCKERHUB_DESCRIPTION_TOKEN }}")
        self.assertNotIn("secrets.DOCKERHUB_TOKEN", (ROOT / ".github/workflows/dockerhub-description.yml").read_text())
        caller = self.publish["jobs"]["update-dockerhub-description"]
        self.assertEqual(caller["secrets"], "inherit")
        self.assertEqual(self.release["jobs"]["publish-images"]["secrets"], "inherit")
        for path in sorted((ROOT / ".github/workflows").glob("*.yml")):
            if path.name == "dockerhub-description.yml":
                continue
            with self.subTest(workflow=path.name):
                self.assertNotIn("DOCKERHUB_DESCRIPTION_TOKEN", path.read_text())
                for other in workflow(path.name)["jobs"].values():
                    environment = other.get("environment", "")
                    if isinstance(environment, dict):
                        environment = environment.get("name", "")
                    self.assertNotEqual(environment, "dockerhub-description")

    def test_container_security_inventory_keeps_accepted_risks(self):
        wf = workflow("container-security.yml")
        steps = {step["name"]: step for step in wf["jobs"]["scan"]["steps"]}
        inventory = steps["Record full vulnerability inventory"]
        table = steps["Show all high and critical findings"]
        gate = steps["Gate on fixable high and critical findings"]
        self.assertNotIn("trivyignores", inventory.get("with", {}))
        self.assertEqual(inventory.get("env", {}).get("TRIVY_IGNOREFILE"), "/dev/null")
        self.assertEqual(table["with"]["trivyignores"], ".trivyignore")
        self.assertEqual(gate["with"]["trivyignores"], ".trivyignore")
        for event in ("pull_request", "push"):
            self.assertIn(".trivyignore", wf["on"][event]["paths"])

    def test_missing_description_credentials_skip_with_a_warning(self):
        detect = next(step for step in self.description["jobs"]["update"]["steps"] if step.get("id") == "hub")
        self.assertEqual(
            detect["env"],
            {
                "DOCKERHUB_USERNAME": "${{ secrets.DOCKERHUB_USERNAME }}",
                "DOCKERHUB_DESCRIPTION_TOKEN": "${{ secrets.DOCKERHUB_DESCRIPTION_TOKEN }}",
            },
        )
        for user, token, update in (("u", "t", "1"), ("u", "", "0"), ("", "t", "0"), ("", "", "0")):
            with self.subTest(user=bool(user), token=bool(token)), tempfile.NamedTemporaryFile("r") as out:
                env = {key: value for key, value in os.environ.items() if not key.startswith("DOCKERHUB_")}
                result = subprocess.run(
                    ["bash", "-c", detect["run"]],
                    env={**env, "GITHUB_OUTPUT": out.name, "DOCKERHUB_USERNAME": user, "DOCKERHUB_DESCRIPTION_TOKEN": token},
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(out.read().strip(), f"update_hub={update}")
                warned = "::warning::" in result.stdout and "DOCKERHUB_DESCRIPTION_TOKEN" in result.stdout
                self.assertEqual(warned, update == "0")
        gated = [step for step in self.description["jobs"]["update"]["steps"] if "if" in step and step.get("id") != "hub"]
        for step in gated:
            if step["name"] == "Explain a failed Hub update":
                continue
            with self.subTest(step=step["name"]):
                self.assertEqual(step["if"], "steps.hub.outputs.update_hub == '1'")


class PrereleaseWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.prerelease = workflow("publish-prerelease.yml")
        self.release = workflow("release-please.yml")
        self.publish = workflow("publish-images.yml")
        self.validation = workflow("pr-validation.yml")
        self.security = workflow("container-security.yml")

    def test_dispatch_only_and_not_on_the_stable_path(self):
        self.assertEqual(set(self.prerelease["on"]), {"workflow_dispatch"})
        self.assertNotIn("pull_request", self.prerelease["on"])
        self.assertNotIn("pull_request_target", self.prerelease["on"])
        self.assertNotIn("push", self.prerelease["on"])
        self.assertEqual(self.release["jobs"]["publish-images"]["uses"], "./.github/workflows/publish-images.yml")
        self.assertNotIn("publish-prerelease", yaml.dump(self.release))
        self.assertNotIn("publish-prerelease", yaml.dump(self.publish))

    def test_requires_maintainer_environment_and_explicit_ref(self):
        job = self.prerelease["jobs"]["resolve-ref"]
        self.assertEqual(job["environment"], "prerelease")
        self.assertEqual(job["if"], "github.repository == 'uniskela/ts6-manager'")
        inputs = self.prerelease["on"]["workflow_dispatch"]["inputs"]
        self.assertEqual(inputs["ref"]["required"], "true")
        self.assertEqual(inputs["create_github_prerelease"]["default"], "false")
        self.assertEqual(inputs["source_branch"]["default"], "main")

    def test_default_permissions_are_empty(self):
        self.assertEqual(self.prerelease["permissions"], {})

    def test_validate_script_accepts_sha_and_prerelease_only(self):
        guard = next(
            step
            for step in self.prerelease["jobs"]["resolve-ref"]["steps"]
            if step.get("name") == "Validate prerelease ref"
        )
        accepted = {
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "v1.12.0-beta.1",
            "v1.12.0-rc.2",
            "v2.0.0-alpha.0",
        }
        rejected = {
            "v1.11.2",
            "v1.12.0",
            "main",
            "1.12.0-beta.1",
            "abc1234",
            "refs/pull/1/head",
            "",
        }
        for ref in accepted | rejected:
            with self.subTest(ref=ref):
                result = subprocess.run(
                    ["bash", "-c", guard["run"]],
                    env={**os.environ, "REF": ref, "PRE_TAG": "", "SOURCE_BRANCH": "main"},
                    capture_output=True,
                    timeout=5,
                )
                self.assertEqual(result.returncode == 0, ref in accepted, result.stderr)

        result = subprocess.run(
            ["bash", "-c", guard["run"]],
            env={
                **os.environ,
                "REF": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "PRE_TAG": "v1.12.0-beta.1",
                "SOURCE_BRANCH": "main",
            },
            capture_output=True,
            timeout=5,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        result = subprocess.run(
            ["bash", "-c", guard["run"]],
            env={
                **os.environ,
                "REF": "v1.12.0-beta.1",
                "PRE_TAG": "v1.12.0-beta.2",
                "SOURCE_BRANCH": "main",
            },
            capture_output=True,
            timeout=5,
        )
        self.assertNotEqual(result.returncode, 0)
        result = subprocess.run(
            ["bash", "-c", guard["run"]],
            env={
                **os.environ,
                "REF": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "PRE_TAG": "",
                "SOURCE_BRANCH": "feature/unreviewed",
            },
            capture_output=True,
            timeout=5,
        )
        self.assertNotEqual(result.returncode, 0)

    def test_stable_tag_guard_still_rejects_prereleases(self):
        guard = next(
            step
            for step in self.publish["jobs"]["build-and-push"]["steps"]
            if step.get("name") == "Validate release tag"
        )
        for tag, ok in (("v1.11.2", True), ("v1.12.0-beta.1", False), ("v1.12.0-rc.1", False)):
            with self.subTest(tag=tag):
                result = subprocess.run(
                    ["bash", "-c", guard["run"]],
                    env={**os.environ, "TAG": tag},
                    capture_output=True,
                    timeout=5,
                )
                self.assertEqual(result.returncode == 0, ok)

    def test_publish_waits_for_tests_and_security(self):
        for name in ("build-and-push", "build-all-in-one"):
            self.assertEqual(
                self.prerelease["jobs"][name]["needs"],
                ["resolve-ref", "validate", "security"],
            )
        self.assertEqual(self.prerelease["jobs"]["validate"]["uses"], "./.github/workflows/pr-validation.yml")
        self.assertEqual(self.prerelease["jobs"]["security"]["uses"], "./.github/workflows/container-security.yml")
        self.assertEqual(
            self.prerelease["jobs"]["validate"]["with"]["ref"],
            "${{ needs.resolve-ref.outputs.sha }}",
        )

    def test_reusable_gates_accept_a_ref(self):
        for flow in (self.validation, self.security):
            self.assertIn("workflow_call", flow["on"])
            self.assertEqual(flow["on"]["workflow_call"]["inputs"]["ref"]["required"], "false")

    def test_no_stable_alias_promotion(self):
        text = (ROOT / ".github/workflows" / "publish-prerelease.yml").read_text()
        self.assertNotIn("major_minor", text)
        self.assertNotIn("promote-latest", self.prerelease["jobs"])
        self.assertNotIn("promote-all-in-one-latest", self.prerelease["jobs"])
        self.assertNotIn("update-dockerhub-description", self.prerelease["jobs"])
        self.assertNotIn("DOCKERHUB_DESCRIPTION_TOKEN", text)
        self.assertNotRegex(text, r"IMAGE_PREFIX\}[^ \n]*:latest")
        for name, job in self.prerelease["jobs"].items():
            with self.subTest(job=name):
                self.assertNotIn("latest", name)

    def test_tag_lists_are_sha_and_prerelease_only(self):
        for job_name in ("build-and-push", "build-all-in-one"):
            step = next(
                s
                for s in self.prerelease["jobs"][job_name]["steps"]
                if s.get("name") == "Resolve image tags"
            )
            script = step["run"]
            self.assertIn(":sha-${SHORT_SHA}", script)
            self.assertIn("${TAG}", script)
            self.assertIn("${VERSION}", script)
            self.assertNotIn("MAJOR_MINOR", script)
            self.assertNotIn(":latest", script)

    def test_trusted_source_and_collision_guards_are_wired(self):
        names = [step.get("name") for step in self.prerelease["jobs"]["resolve-ref"]["steps"]]
        self.assertIn("Require trusted source", names)
        self.assertIn("Reject tag collisions", names)
        self.assertIn("Require prerelease environment reviewers", names)
        text = (ROOT / ".github/workflows" / "publish-prerelease.yml").read_text()
        self.assertIn("require-ancestor", text)
        self.assertIn("reject-tag-collision", text)
        self.assertIn("reject-image-collision", text)
        self.assertIn("verify-github-release-target", text)
        for job_name in ("build-and-push", "build-all-in-one"):
            step = next(
                s
                for s in self.prerelease["jobs"][job_name]["steps"]
                if s.get("name") == "Reject image tag collisions"
            )
            self.assertNotIn("if", step)
            self.assertIn("needs.resolve-ref.outputs.short_sha", step["run"])
            self.assertIn("reject-image-collision", step["run"])
        self.assertNotIn("leaving it unchanged", text)
        self.assertNotIn("ref: ${{ inputs.ref }}", text)
        self.assertEqual(
            self.prerelease["concurrency"]["group"],
            "prerelease-${{ inputs.prerelease_tag || inputs.ref }}",
        )
        self.assertEqual(
            self.validation["concurrency"]["group"],
            "pr-validation-${{ github.workflow }}-${{ inputs.ref || github.event.pull_request.number || github.ref }}",
        )
        self.assertEqual(
            self.security["concurrency"]["group"],
            "container-security-${{ github.workflow }}-${{ inputs.ref || github.event.pull_request.number || github.ref }}",
        )

    def test_github_prerelease_is_opt_in_and_marked_prerelease(self):
        job = self.prerelease["jobs"]["github-prerelease"]
        self.assertEqual(job["if"], "inputs.create_github_prerelease && needs.resolve-ref.outputs.tag != ''")
        script = next(step["run"] for step in job["steps"] if step.get("name") == "Publish GitHub prerelease")
        self.assertIn("gh release create", script)
        self.assertIn("--prerelease", script)
        self.assertIn("verify-github-release-target", script)
        self.assertIn("Discord voice bridge", script)

    def test_checkout_paths_stay_under_workspace(self):
        text = (ROOT / ".github/workflows" / "publish-prerelease.yml").read_text()
        self.assertNotIn("prerelease-workflow", text)
        self.assertNotIn("path: ${{ runner.temp }}", text)
        guard_jobs = ("resolve-ref", "build-and-push", "build-all-in-one", "github-prerelease")
        keep_run = None
        for name in guard_jobs:
            steps = self.prerelease["jobs"][name]["steps"]
            names = [step.get("name") for step in steps]
            self.assertIn("Checkout trusted workflow source", names)
            self.assertIn("Verify workflow source", names)
            self.assertIn("Keep publish-path guards", names)
            source = steps[names.index("Checkout trusted workflow source")]
            self.assertEqual(source["with"]["ref"], "${{ github.sha }}")
            self.assertNotIn("path", source.get("with", {}))
            verify = steps[names.index("Verify workflow source")]
            self.assertIn("git merge-base --is-ancestor", verify["run"])
            self.assertIn("$WORKFLOW_SHA", verify["run"])
            self.assertIn("$SOURCE_BRANCH", verify["run"])
            self.assertLess(names.index("Verify workflow source"), names.index("Keep publish-path guards"))
            keep = steps[names.index("Keep publish-path guards")]
            if keep_run is None:
                keep_run = keep["run"]
            self.assertEqual(keep["run"], keep_run)
            self.assertIn('cp scripts/ci/prerelease-guards.sh "$RUNNER_TEMP/prerelease-guards.sh"', keep["run"])
            if "Checkout trusted default branch" in names:
                self.assertLess(
                    names.index("Keep publish-path guards"),
                    names.index("Checkout trusted default branch"),
                )
            for step in steps:
                path = (step.get("with") or {}).get("path")
                if path:
                    self.assertFalse(str(path).startswith("${{ runner.temp"))
                    self.assertFalse(str(path).startswith("/"))
                if "prerelease-guards.sh" in step.get("run", ""):
                    self.assertIn("$RUNNER_TEMP/prerelease-guards.sh", step["run"])
                    self.assertNotIn("scripts/ci/prerelease-guards.sh", step["run"].replace(keep["run"], ""))

    def test_dispatch_resolves_guard_path_without_publishing(self):
        keep = next(
            step
            for step in self.prerelease["jobs"]["resolve-ref"]["steps"]
            if step.get("name") == "Keep publish-path guards"
        )
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp) / "runner-temp"
            workspace = Path(tmp) / "workspace"
            temp.mkdir()
            workspace.mkdir()
            copied = subprocess.run(
                ["bash", "-c", keep["run"]],
                cwd=ROOT,
                env={**os.environ, "RUNNER_TEMP": str(temp)},
                capture_output=True,
                text=True,
                timeout=5,
            )
            self.assertEqual(copied.returncode, 0, copied.stderr)
            guard = temp / "prerelease-guards.sh"
            self.assertTrue(guard.is_file())
            (workspace / "scripts").mkdir()
            result = subprocess.run(
                ["bash", str(guard), "validate-source-branch", "main"],
                cwd=workspace,
                capture_output=True,
                text=True,
                timeout=5,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run(
                ["bash", str(guard), "validate-source-branch", "feature/unreviewed"],
                cwd=workspace,
                capture_output=True,
                text=True,
                timeout=5,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("ghcr.io", result.stdout + result.stderr)
            self.assertNotIn("docker", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
