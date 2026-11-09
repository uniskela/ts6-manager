#!/usr/bin/env python3
"""Fail if accept-staging compose publishes unsafe or colliding host ports."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def compose_config() -> dict:
    env = {
        **{k: v for k, v in os.environ.items() if not k.startswith("COMPOSE_")},
        "JWT_SECRET": "dummy",
        "ENCRYPTION_KEY": "dummy",
        "SIDECAR_SECRET": "dummy",
        "TS_ACCEPT_QUERY_PASSWORD": "dummy-query-password",
        "TS_ACCEPT_QUERY_API_KEY": "dummy-query-api-key",
        "PUBLIC_URL": "https://example.test",
        "TS_VOICE_BIND_IP": "100.64.0.1",
        "TS_VOICE_HOST_PORT": "19987",
        "ACCEPT_HTTP_PORT": "13100",
        "WEBRTC_UDP_PORT": "10000",
        "GIT_SHA": "accept-check",
    }
    raw = subprocess.check_output(
        [
            "docker",
            "compose",
            "--env-file",
            os.devnull,
            "-f",
            "docker-compose.accept-staging.yml",
            "config",
            "--format",
            "json",
        ],
        cwd=ROOT,
        env=env,
        text=True,
    )
    return json.loads(raw)


def published(service: dict) -> set[tuple[str, str, str]]:
    """(host_ip, published_port, protocol)."""
    out: set[tuple[str, str, str]] = set()
    for port in service.get("ports") or []:
        host = str(port.get("published") or "")
        ip = str(port.get("host_ip") or "")
        proto = str(port.get("protocol") or "tcp")
        if host:
            out.add((ip, host, proto))
    return out


def main() -> int:
    cfg = compose_config()
    errors: list[str] = []

    if cfg.get("name") != "ts6-accept-632":
        errors.append(f"project name must be ts6-accept-632, got {cfg.get('name')!r}")

    services = cfg.get("services") or {}
    frontend = published(services.get("frontend") or {})
    if frontend != {("127.0.0.1", "13100", "tcp")}:
        errors.append(f"frontend must be 127.0.0.1:13100/tcp only, got {frontend}")

    if published(services.get("backend") or {}):
        errors.append("backend must not publish a host port")

    ts = published(services.get("teamspeak") or {})
    if ts != {("100.64.0.1", "19987", "udp")}:
        errors.append(f"teamspeak must publish only voice 100.64.0.1:19987/udp in CI fixture, got {ts}")
    for ip, host, proto in ts:
        if ip in ("", "0.0.0.0", "::"):
            errors.append(f"teamspeak voice must not bind all interfaces, got {ip!r}:{host}/{proto}")
        if host in ("9987", "10022", "30033", "9187", "3000", "13000"):
            errors.append(f"teamspeak host port {host} collides with common lab/production defaults")

    sidecar = published(services.get("sidecar") or {})
    if sidecar != {("127.0.0.1", "10000", "udp")}:
        errors.append(f"sidecar WebRTC must be 127.0.0.1:10000/udp only, got {sidecar}")

    volumes = {
        (v.get("name") if isinstance(v, dict) else None)
        for v in (cfg.get("volumes") or {}).values()
    }
    expected_vols = {
        "ts6-accept-632-backend-data",
        "ts6-accept-632-music-data",
        "ts6-accept-632-teamspeak-data",
    }
    if not expected_vols <= volumes:
        errors.append(f"missing explicit volume names, got {sorted(x for x in volumes if x)}")

    networks = {
        (n.get("name") if isinstance(n, dict) else None)
        for n in (cfg.get("networks") or {}).values()
    }
    if "ts6-accept-632" not in networks:
        errors.append(f"network must be named ts6-accept-632, got {sorted(x for x in networks if x)}")

    if errors:
        print("accept-staging compose check failed:", file=sys.stderr)
        for error in errors:
            print(f"  {error}", file=sys.stderr)
        return 1
    print("OK: accept-staging compose publishes only loopback UI/WebRTC + explicit private voice")
    return 0


if __name__ == "__main__":
    sys.exit(main())
