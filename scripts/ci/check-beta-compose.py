#!/usr/bin/env python3
"""Fail if beta compose can collide with the stable stack in the same checkout."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def compose_config(file: str) -> dict:
    env = {
        **{k: v for k, v in os.environ.items() if not k.startswith("COMPOSE_")},
        "JWT_SECRET": "dummy",
        "ENCRYPTION_KEY": "dummy",
        "SIDECAR_SECRET": "dummy",
        "TS6_BETA_TAG": "v0.0.0-beta.0",
        "FRONTEND_URL": "",
        # Empty beats a checkout .env; compose then uses each file's name: / directory default.
        "COMPOSE_PROJECT_NAME": "",
    }
    raw = subprocess.check_output(
        ["docker", "compose", "-f", file, "config", "--format", "json"],
        cwd=ROOT,
        env=env,
        text=True,
    )
    return json.loads(raw)


def published(service: dict) -> set[tuple[str, str]]:
    ports = set()
    for port in service.get("ports") or []:
        host = str(port.get("published") or "")
        ip = str(port.get("host_ip") or "")
        if host:
            ports.add((ip, host))
    return ports


def volume_names(cfg: dict) -> set[str]:
    names = set()
    for volume in (cfg.get("volumes") or {}).values():
        if isinstance(volume, dict) and volume.get("name"):
            names.add(volume["name"])
    return names


def network_names(cfg: dict) -> set[str]:
    names = set()
    for network in (cfg.get("networks") or {}).values():
        if isinstance(network, dict) and network.get("name"):
            names.add(network["name"])
    return names


def main() -> int:
    stable = compose_config("docker-compose.yml")
    beta = compose_config("docker-compose.beta.yml")
    errors: list[str] = []

    if beta.get("name") != "ts6-beta":
        errors.append(f"beta project name must be ts6-beta, got {beta.get('name')!r}")
    if stable.get("name") == beta.get("name"):
        errors.append("stable and beta compose share a project name")

    if volume_names(stable) & volume_names(beta):
        errors.append(f"shared volume names: {sorted(volume_names(stable) & volume_names(beta))}")
    if "ts6-beta-backend-data" not in volume_names(beta) or "ts6-beta-music-data" not in volume_names(beta):
        errors.append("beta volumes must be explicitly named ts6-beta-backend-data and ts6-beta-music-data")

    if network_names(stable) & network_names(beta):
        errors.append(f"shared network names: {sorted(network_names(stable) & network_names(beta))}")

    if published(beta.get("services", {}).get("backend", {})):
        errors.append("beta backend must not publish a host port")
    frontend_ports = published(beta.get("services", {}).get("frontend", {}))
    if frontend_ports != {("127.0.0.1", "13000")}:
        errors.append(f"beta UI must be 127.0.0.1:13000, got {frontend_ports}")
    if published(stable.get("services", {}).get("frontend", {})) & frontend_ports:
        errors.append("beta UI port overlaps the stable frontend")

    environment = beta.get("services", {}).get("backend", {}).get("environment") or {}
    if isinstance(environment, dict):
        frontend_url = str(environment.get("FRONTEND_URL") or "")
    else:
        frontend_url = ""
        for item in environment:
            if isinstance(item, str) and item.startswith("FRONTEND_URL="):
                frontend_url = item.split("=", 1)[1]
    if frontend_url != "http://127.0.0.1:13000":
        errors.append(f"FRONTEND_URL must be http://127.0.0.1:13000, got {frontend_url!r}")

    if errors:
        print("beta compose isolation check failed:", file=sys.stderr)
        for error in errors:
            print(f"  {error}", file=sys.stderr)
        return 1
    print("OK: beta compose is isolated from the stable stack")
    return 0


if __name__ == "__main__":
    sys.exit(main())
