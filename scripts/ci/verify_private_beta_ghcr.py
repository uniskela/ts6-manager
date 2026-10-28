#!/usr/bin/env python3
"""GHCR privacy checks that do not trust a raw unauthenticated 401.

Require an already-private package before push. After push, confirm visibility
via the authenticated Packages API, then complete the Registry v2 bearer-token
flow. Anonymous token-endpoint HTTP 401/403 counts as denied only when that
API says private for this owner/name. A bearer that can read the
manifest, or public visibility, retracts only the pushed tag version.
Fail closed on malformed responses, transport errors, rate limits, and
unexpected status codes.
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


def _container_tags(version: dict) -> list[str]:
    return list(((version.get("metadata") or {}).get("container") or {}).get("tags") or [])


def _versions(scope: str, owner: str, name: str, runner=subprocess.run) -> list[dict]:
    encoded = name.replace("/", "%2F")
    versions: list[dict] = []
    page = 1
    while True:
        batch = gh_api(
            f"{scope}/{owner}/packages/container/{encoded}/versions?per_page=100&page={page}",
            runner=runner,
        )
        if not isinstance(batch, list) or not batch:
            break
        versions.extend(item for item in batch if isinstance(item, dict))
        if len(batch) < 100:
            break
        page += 1
    return versions


def require_private_package(owner: str, name: str, tag: str, runner=subprocess.run) -> str:
    _, scope = assert_private_package(owner, name, runner=runner)
    tags = [tag for version in _versions(scope, owner, name, runner=runner) for tag in _container_tags(version)]
    if tag in tags:
        raise SystemExit(f"refusing to overwrite existing tag {tag}")
    return f"visibility=private tag {tag} is free"


def _gh_mutate(args: list[str], runner=subprocess.run) -> None:
    proc = runner(["gh", "api", *args], capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit((proc.stderr or proc.stdout or "gh api mutate failed").strip())


def retract_pushed_tag(owner: str, name: str, tag: str, scope: str, runner=subprocess.run) -> str:
    """Delete versions whose only tag is `tag`. Never delete other versions."""
    encoded = name.replace("/", "%2F")
    retracted = False
    refused: list[str] = []
    retract_error = None
    for version in _versions(scope, owner, name, runner=runner):
        tags = _container_tags(version)
        if tag not in tags or version.get("id") is None:
            continue
        extra = [item for item in tags if item != tag]
        if extra:
            refused.append(f"version {version['id']} also tagged {extra!r}")
            continue
        try:
            _gh_mutate(
                [
                    "--method",
                    "DELETE",
                    f"{scope}/{owner}/packages/container/{encoded}/versions/{version['id']}",
                ],
                runner=runner,
            )
            retracted = True
        except SystemExit as exc:
            retract_error = str(exc)
    parts = [
        f"retracted {tag}" if retracted else f"no version carrying only {tag} was found to retract"
    ]
    if refused:
        parts.append("refused to delete unrelated versions: " + "; ".join(refused))
    if retract_error:
        parts.append(f"DELETE failed: {retract_error}")
    return "; ".join(parts)


def seal_or_retract(owner: str, name: str, tag: str, runner=subprocess.run) -> str:
    """After push: private is success. Otherwise delete the tag version and fail.

    GitHub does not support making a public package private. Do not PATCH visibility.
    Deleting the version does not undo a public pull that already happened.
    """
    info, scope = package_record(owner, name, runner=runner)
    if info.get("visibility") == "private":
        return "visibility=private"
    cleanup = retract_pushed_tag(owner, name, tag, scope, runner=runner)
    raise SystemExit(
        f"package visibility={info.get('visibility')!r} after push; "
        f"public packages cannot be made private; {cleanup}"
    )


def _status(url: str, headers: dict[str, str], opener) -> int:
    req = urllib.request.Request(url, method="GET", headers=headers)
    try:
        with opener(req, timeout=30) as resp:
            return int(resp.status)
    except urllib.error.HTTPError as exc:
        return int(exc.code)
    except Exception as exc:  # noqa: BLE001 — fail closed on any transport error
        raise SystemExit(f"registry request failed closed: {exc}") from exc


def registry_token_url(owner: str, name: str) -> str:
    return f"https://ghcr.io/token?service=ghcr.io&scope=repository:{owner}/{name}:pull"


def anonymous_pull_denied(
    owner: str,
    name: str,
    tag: str,
    opener=urllib.request.urlopen,
    runner=subprocess.run,
    visibility: str | None = None,
) -> str:
    if visibility is None:
        info, _ = assert_private_package(owner, name, runner=runner)
        visibility = info.get("visibility")
    token_url = registry_token_url(owner, name)
    req = urllib.request.Request(token_url, method="GET")
    body: object | None = None
    try:
        with opener(req, timeout=30) as resp:
            token_status = int(resp.status)
            if token_status == 200:
                try:
                    body = json.load(resp)
                except Exception as exc:  # noqa: BLE001
                    raise SystemExit(f"anonymous token response malformed: {exc}") from exc
    except urllib.error.HTTPError as exc:
        token_status = int(exc.code)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"anonymous token request failed closed: {exc}") from exc
    if token_status in (401, 403):
        if visibility != "private":
            raise SystemExit(
                f"anonymous token endpoint returned HTTP {token_status} "
                "without private package confirmation"
            )
        return f"anonymous_token_status={token_status}"
    if token_status != 200:
        raise SystemExit(f"anonymous token endpoint returned HTTP {token_status}")
    if not isinstance(body, dict):
        raise SystemExit("anonymous token response malformed: expected object")
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


def verify_after_push(
    owner: str,
    name: str,
    tag: str,
    runner=subprocess.run,
    opener=urllib.request.urlopen,
) -> str:
    """Post-push privacy check. Retract on public visibility or anonymous HTTP 200."""
    info, scope = package_record(owner, name, runner=runner)
    vis = info.get("visibility")
    errors: list[str] = []
    exposed = vis != "private"
    if exposed:
        errors.append(
            f"package visibility={vis!r} after push; public packages cannot be made private"
        )
    try:
        anon = anonymous_pull_denied(
            owner, name, tag, opener=opener, runner=runner, visibility=vis
        )
    except SystemExit as exc:
        errors.append(str(exc))
        if "anonymous pull succeeded" in str(exc):
            exposed = True
    if exposed:
        try:
            errors.append(retract_pushed_tag(owner, name, tag, scope, runner=runner))
        except SystemExit as exc:
            errors.append(f"retract failed: {exc}")
    if errors:
        raise SystemExit("; ".join(errors))
    return f"visibility=private {anon}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    req = sub.add_parser("require-private")
    vis = sub.add_parser("assert-private")
    seal = sub.add_parser("seal-or-retract")
    anon = sub.add_parser("anonymous-denied")
    after = sub.add_parser("verify-after-push")
    for item in (req, vis, seal, anon, after):
        item.add_argument("--owner", required=True)
        item.add_argument("--name", required=True)
    req.add_argument("--tag", required=True)
    seal.add_argument("--tag", required=True)
    anon.add_argument("--tag", required=True)
    after.add_argument("--tag", required=True)
    args = parser.parse_args(argv)
    if args.cmd == "require-private":
        print(require_private_package(args.owner, args.name, args.tag))
    elif args.cmd == "assert-private":
        assert_private_package(args.owner, args.name)
        print("visibility=private")
    elif args.cmd == "seal-or-retract":
        print(seal_or_retract(args.owner, args.name, args.tag))
    elif args.cmd == "verify-after-push":
        print(verify_after_push(args.owner, args.name, args.tag))
    else:
        print(anonymous_pull_denied(args.owner, args.name, args.tag))
    return 0


if __name__ == "__main__":
    sys.exit(main())
