"""Contract checks for bundled nginx API vs WebSocket proxy headers."""

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
CONFIGS = (
    ROOT / "docker-commands" / "nginx-frontend.conf",
    ROOT / "docker-commands" / "nginx-all-in-one.conf",
)


def location_block(text: str, path: str) -> str:
    match = re.search(
        rf"location\s+{re.escape(path)}\s*\{{",
        text,
    )
    if not match:
        raise AssertionError(f"missing location {path}")
    start = match.end()
    depth = 1
    for index, char in enumerate(text[start:], start):
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start:index]
    raise AssertionError(f"unclosed location {path}")


class NginxProxyTests(unittest.TestCase):
    def test_websocket_location_keeps_upgrade_headers(self):
        for path in CONFIGS:
            block = location_block(path.read_text(), "/ws")
            with self.subTest(config=path.name):
                self.assertIn("proxy_http_version 1.1", block)
                self.assertIn("proxy_set_header Upgrade $http_upgrade", block)
                self.assertIn('proxy_set_header Connection "upgrade"', block)
                self.assertRegex(block, r"proxy_pass\s+\S+")

    def test_api_location_does_not_unconditionally_upgrade(self):
        for path in CONFIGS:
            block = location_block(path.read_text(), "/api")
            with self.subTest(config=path.name):
                self.assertRegex(block, r"proxy_pass\s+\S+")
                self.assertIn("proxy_http_version 1.1", block)
                self.assertNotIn('proxy_set_header Connection "upgrade"', block)
                self.assertNotIn("proxy_set_header Upgrade $http_upgrade", block)
                self.assertIn("proxy_set_header Host $host", block)
                self.assertIn("proxy_read_timeout 300s", block)


if __name__ == "__main__":
    unittest.main()
