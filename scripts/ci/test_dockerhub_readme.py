"""Check the shortened Docker Hub README without contacting Docker Hub."""

import hashlib
import importlib.util
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/ci/dockerhub-readme.py"
REWRITER = ROOT / "scripts/ci/complete-relative-readme-urls.py"
HUB_LIMIT = 25_000

spec = importlib.util.spec_from_file_location("dockerhub_readme", SCRIPT)
hub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hub)

SAMPLE = """# Title

Intro with a [link](#license).

## Screenshots

![shot](docs/shot.png)

### Gallery

More pictures.

## Documentation

Read [the docs](docs/public/index.md).

```bash
## not a heading inside a fence
echo hi
```

## Quick Start (Docker)

~~~yaml
## Requirements
image: x
~~~

## Environment Variables

| Name | Default |
|------|---------|
| `PORT` | `3001` |

## Environment Variables: Sidecar / Video Streaming

Sidecar settings.

## Requirements

- TeamSpeak

## Contributors

Lots of people.

## License ##

MIT
"""


def headings(text):
    text = re.sub(r"^(```|~~~).*?^\1[ \t]*$", "", text, flags=re.MULTILINE | re.DOTALL)
    return re.findall(r"^## (.+)$", text, flags=re.MULTILINE)


def without_section(text, name):
    preamble, sections = hub.split_sections(text)
    return preamble + "".join(body for heading, body in sections if heading != name)


class DockerHubReadmeTests(unittest.TestCase):
    def run_cli(self, readme_text, *, tag="v1.2.3"):
        """Shorten and rewrite like the workflow; return (exit code, stdout, final text)."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            src = tmp / "src/README.md"
            src.parent.mkdir()
            src.write_text(readme_text, encoding="utf-8")
            short = tmp / "hub-readme/README.md"
            result = subprocess.run(
                [sys.executable, SCRIPT, src, short], capture_output=True, text=True, timeout=30
            )
            if result.returncode:
                self.assertFalse(short.exists())
                return result.returncode, result.stdout, None
            final = tmp / "dockerhub-readme.md"
            subprocess.run(
                [sys.executable, REWRITER, short, final, "--ref", tag],
                env={**os.environ, "GITHUB_REPOSITORY": "uniskela/ts6-manager", "GITHUB_SERVER_URL": "https://github.com"},
                check=True,
                timeout=30,
            )
            return 0, result.stdout, final.read_text(encoding="utf-8")

    def test_keeps_preamble_and_listed_sections_in_readme_order(self):
        out = hub.build(SAMPLE)
        self.assertTrue(out.startswith("# Title\n\nIntro with a [link](#license).\n\n## Documentation\n"))
        self.assertEqual(headings(out), ["Documentation", "Quick Start (Docker)", "Environment Variables",
                                         "Environment Variables: Sidecar / Video Streaming", "Requirements",
                                         "License ##"])
        self.assertNotIn("![shot]", out)
        self.assertNotIn("### Gallery", out)  # A dropped section takes its subsections along.
        self.assertNotIn("Lots of people", out)
        self.assertIn("| `PORT` | `3001` |\n", out)

    def test_headings_inside_code_fences_are_text(self):
        out = hub.build(SAMPLE)
        self.assertIn("```bash\n## not a heading inside a fence\necho hi\n```\n", out)
        self.assertIn("~~~yaml\n## Requirements\nimage: x\n~~~\n", out)
        # A section that only appears inside a fence is still missing.
        with self.assertRaisesRegex(hub.ReadmeError, r"named: Requirements$"):
            hub.build(without_section(SAMPLE, "Requirements"))

    def test_formatting(self):
        out = hub.build(SAMPLE)
        self.assertTrue(out.endswith("release.\n"))
        self.assertNotIn("\n\n\n", out)
        self.assertEqual(out.count("```") % 2, 0)
        for name in hub.SECTIONS:
            with self.subTest(section=name):
                # Each heading starts a paragraph, after exactly one blank line.
                self.assertRegex(out, rf"[^\n]\n\n## {re.escape(name)}")
        self.assertTrue(out.endswith(hub.FOOTER))
        self.assertIn("\n\n---\n\n", out)
        self.assertIn("[full README](README.md)", hub.FOOTER)

    def test_each_missing_section_fails(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        for name in hub.SECTIONS:
            with self.subTest(section=name):
                code, stdout, _ = self.run_cli(without_section(readme, name))
                self.assertEqual(code, 1)
                self.assertIn("::error::", stdout)
                self.assertIn(name, stdout)

    def test_renamed_section_fails(self):
        with self.assertRaisesRegex(hub.ReadmeError, "Quick Start"):
            hub.build(SAMPLE.replace("## Quick Start (Docker)", "## Quick start with Docker"))

    def test_duplicated_section_fails(self):
        with self.assertRaisesRegex(hub.ReadmeError, "more than one"):
            hub.build(SAMPLE + "\n## Requirements\n\nAgain.\n")

    def test_oversized_readme_fails(self):
        filler = "x" * 100 + "\n"
        big = SAMPLE.replace("- TeamSpeak\n", "- TeamSpeak\n" + filler * (hub.MAX_BYTES // len(filler)))
        with self.assertRaisesRegex(hub.ReadmeError, rf"over the {hub.MAX_BYTES}"):
            hub.build(big)
        code, stdout, _ = self.run_cli(big)
        self.assertEqual(code, 1)
        self.assertIn("::error::", stdout)
        # Text in dropped sections does not count.
        hub.build(SAMPLE.replace("Lots of people.\n", filler * (hub.MAX_BYTES // len(filler))))

    def test_limit_leaves_room_for_url_rewriting(self):
        self.assertLessEqual(hub.MAX_BYTES, HUB_LIMIT - 4_000)

    def test_real_readme_fits_on_docker_hub_and_links_the_full_readme(self):
        readme = ROOT / "README.md"
        before = hashlib.sha256(readme.read_bytes()).hexdigest()
        code, stdout, final = self.run_cli(readme.read_text(encoding="utf-8"), tag="v1.2.3")
        self.assertEqual(code, 0, stdout)
        self.assertEqual(hashlib.sha256(readme.read_bytes()).hexdigest(), before)
        size = len(final.encode("utf-8"))
        self.assertLessEqual(size, HUB_LIMIT)
        for name in hub.SECTIONS:
            with self.subTest(section=name):
                self.assertIn(name, headings(final))
        for dropped in ("Screenshots", "Contributors", "Development"):
            with self.subTest(dropped=dropped):
                self.assertNotIn(dropped, headings(final))
        full = "https://github.com/uniskela/ts6-manager/blob/v1.2.3/README.md"
        self.assertIn(f"[full README]({full})", final)
        self.assertIn(f"({full}#screenshots)", final)
        # Every link is absolute, so none breaks on Docker Hub.
        for url in re.findall(r"!?\[[^\]]*\]\(([^)\s]+)", final):
            with self.subTest(url=url):
                self.assertRegex(url, r"^https?://")


if __name__ == "__main__":
    unittest.main()
