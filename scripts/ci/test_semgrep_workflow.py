"""Contract checks for the informational Semgrep Community Edition workflow."""

from pathlib import Path
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows" / "semgrep.yml"
SEMGREP_IMAGE = (
    "semgrep/semgrep:1.182.0@sha256:"
    "4a34048c04fef049f71665047f074cffb00cc3d89482f965a5cd151d589237af"
)


def load_workflow():
    return yaml.load(WORKFLOW.read_text(), Loader=yaml.BaseLoader)


class SemgrepWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.wf = load_workflow()
        self.job = self.wf["jobs"]["semgrep"]
        self.steps = {step["name"]: step for step in self.job["steps"]}
        self.text = WORKFLOW.read_text()

    def test_triggers_and_permissions(self):
        self.assertEqual(self.wf["permissions"], {"contents": "read"})
        self.assertIn("pull_request", self.wf["on"])
        self.assertIn("workflow_dispatch", self.wf["on"])
        self.assertEqual(self.wf["on"]["push"]["branches"], ["main"])
        self.assertEqual(self.wf["on"]["schedule"][0]["cron"], "41 5 * * 2")
        self.assertNotIn("pull_request_target", self.wf["on"])
        self.assertNotIn("security-events", self.text)

    def test_stays_community_edition_and_informational(self):
        self.assertEqual(self.job["container"]["image"], SEMGREP_IMAGE)
        scan = self.steps["Scan with Community Edition rules"]["run"]
        self.assertIn("--metrics=off", scan)
        self.assertIn("--oss-only", scan)
        self.assertIn("--config p/security-audit", scan)
        self.assertIn("--config p/owasp-top-ten", scan)
        self.assertIn("--config .semgrep", scan)
        self.assertIn("--sarif-output=semgrep.sarif", scan)
        self.assertNotIn(" --sarif\n", scan)
        self.assertNotIn("semgrep ci", scan)
        self.assertNotIn("semgrep login", self.text)
        self.assertNotIn("--error", scan)
        self.assertNotIn("SEMGREP_APP_TOKEN", self.text)
        self.assertNotIn("continue-on-error", self.text)
        self.assertNotIn("|| true", self.text)
        self.assertNotIn("upload-sarif", self.text)
        self.assertEqual(
            self.steps["Scan with Community Edition rules"]["env"]["SEMGREP_SEND_METRICS"],
            "off",
        )

    def test_pins_actions_and_keeps_sarif_as_an_artifact(self):
        checkout = self.steps["Checkout"]["uses"]
        upload = self.steps["Upload SARIF artifact"]["uses"]
        self.assertRegex(checkout, r"^actions/checkout@[0-9a-f]{40}$")
        self.assertRegex(upload, r"^actions/upload-artifact@[0-9a-f]{40}$")
        self.assertEqual(self.steps["Checkout"]["with"]["persist-credentials"], "false")
        self.assertEqual(self.steps["Upload SARIF artifact"]["with"]["retention-days"], "14")
        self.assertEqual(self.steps["Upload SARIF artifact"]["with"]["if-no-files-found"], "error")
        self.assertEqual(self.steps["Upload SARIF artifact"]["with"]["path"], "semgrep.sarif")

    def test_custom_rules_and_ignore_file_exist(self):
        path = ROOT / ".semgrep" / "unsafe-subprocess.yml"
        parsed = yaml.safe_load(path.read_text())
        ids = [rule["id"] for rule in parsed["rules"]]
        self.assertEqual(ids, ["ts6.child-process-shell-true", "ts6.go-shell-c"])
        for rule in parsed["rules"]:
            for item in rule["pattern-either"]:
                self.assertIsInstance(item["pattern"], str)
                self.assertNotIn("\n", item["pattern"])
        ignore = (ROOT / ".semgrepignore").read_text()
        self.assertIn("node_modules/", ignore)
        self.assertIn("packages/backend/generated/", ignore)
        self.assertIn("packages/frontend/playwright-report/", ignore)


if __name__ == "__main__":
    unittest.main()
