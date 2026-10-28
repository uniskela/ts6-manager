#!/usr/bin/env python3
"""GHCR privacy checks that do not trust a raw unauthenticated 401.

Require an already-private package before push. After push, complete the
Registry v2 bearer-token flow and fail closed on public access or errors.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.request


def gh_api(path: str, runner=subprocess.run) -> object | None:
    proc = runner(["gh", "api", path], capture_output=True, text=True)
    err = (proc.stderr or "") + (proc.stdout or "")
    if proc.returncode != 0:
        if "404" in err or "Not Found" in err or "Package not found" in err:
            return None
        raise SystemExit(err.strip() or f"gh api failed: {path}")
    return json.loads(proc.stdout)


def package_record(owner: str, name: str, runner=subprocess.run) -> tuple[dict, str]:
    encoded = name.replace("/", "%2F")
    for scope in ("users", "orgs"):
        info = gh_api(f"{scope}/{owner}/packages/container/{encoded}", runner=runner)
        if isinstance(info, dict):
            return info, scope
    raise SystemExit(
        "GHCR package is missing. Provision "
        f"ghcr.io/{owner}/{name} as a private package before publishing a private-beta tag."
    )


def assert_private_package(owner: str, name: str, runner=subprocess.run) -> tuple[dict, str]:
    info, scope = package_record(owner, name, runner=runner)
    vis = info.get("visibility")
    if vis != "private":
        raise SystemExit(f"package must stay private; refusing visibility={vis!r}")
    return info, scope


def require_private_package(owner: str, name: str, tag: str, runner=subprocess.run) -> str:
    info, scope = assert_private_package(owner, name, runner=runner)
    encoded = name.replace("/", "%2F")
    tags: list[str] = []
    page = 1
    while True:
        batch = gh_api(
            f"{scope}/{owner}/packages/container/{encoded}/versions?per_page=100&page={page}",
            runner=runner,
        )
        if not isinstance(batch, list) or not batch:
            break
        for version in batch:
            tags.extend(((version.get("metadata") or {}).get("container") or {}).get("tags") or [])
        if len(batch) < 100:
            break
        page += 1
    if tag in tags:
        raise SystemExit(f"refusing to overwrite existing tag {tag}")
    return f"visibility=private tag {tag} is free"


def _status(url: str, headers: dict[str, str], opener) -> int:
    req = urllib.request.Request(url, method="GET", headers=headers)
    try:
        with opener(req, timeout=30) as resp:
            return int(resp.status)
    except urllib.error.HTTPError as exc:
        return int(exc.code)
    except Exception as exc:  # noqa: BLE001 — fail closed on any transport error
        raise SystemExit(f"registry request failed closed: {exc}") from exc


def anonymous_pull_denied(owner: str, name: str, tag: str, opener=urllib.request.urlopen) -> str:
    token_url = f"https://ghcr.io/token?service=ghcr.io&scope=repository:{owner}/{name}:pull"
    req = urllib.request.Request(token_url, method="GET")
    try:
        with opener(req, timeout=30) as resp:
            if int(resp.status) != 200:
                raise SystemExit(f"anonymous token endpoint returned HTTP {resp.status}")
            body = json.load(resp)
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"anonymous token endpoint returned HTTP {exc.code}") from exc
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"anonymous token request failed closed: {exc}") from exc
    token = (body.get("token") or body.get("access_token") or "").strip()
    if not token:
        raise SystemExit("anonymous token endpoint returned no token")
    url = f"https://ghcr.io/v2/{owner}/{name}/manifests/{tag}"
    code = _status(
        url,
        {
            "Accept": "application/vnd.oci.image.manifest.v1+json",
            "Authorization": f"Bearer {token}",
        },
        opener,
    )
    if code == 200:
        raise SystemExit("anonymous pull succeeded; package is public")
    if code not in (401, 403, 404):
        raise SystemExit(f"anonymous pull must be denied, got HTTP {code}")
    return f"anonymous_manifest_status={code}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    req = sub.add_parser("require-private")
    vis = sub.add_parser("assert-private")
    anon = sub.add_parser("anonymous-denied")
    for item in (req, vis, anon):
        item.add_argument("--owner", required=True)
        item.add_argument("--name", required=True)
    req.add_argument("--tag", required=True)
    anon.add_argument("--tag", required=True)
    args = parser.parse_args(argv)
    if args.cmd == "require-private":
        print(require_private_package(args.owner, args.name, args.tag))
    elif args.cmd == "assert-private":
        assert_private_package(args.owner, args.name)
        print("visibility=private")
    else:
        print(anonymous_pull_denied(args.owner, args.name, args.tag))
    return 0


if __name__ == "__main__":
    sys.exit(main())
