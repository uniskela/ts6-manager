#!/usr/bin/env bash
# Guards for the maintainer-only prerelease publish path.
# Sourced by unit tests; invoked as a command from the workflow.
set -euo pipefail

STABLE_TAG='^v[0-9]+\.[0-9]+\.[0-9]+$'
PRE_TAG='^v[0-9]+\.[0-9]+\.[0-9]+-(alpha|beta|rc)\.[0-9]+$'
COMMIT_SHA='^[0-9a-f]{40}$'
SOURCE_REF='^(main|release/[A-Za-z0-9._-]+)$'
GH_BIN="${GH:-gh}"

die() {
  echo "$*" >&2
  exit 1
}

validate_source_branch() {
  local branch="${1:-}"
  [[ "$branch" =~ $SOURCE_REF ]] || die "source_branch must be main or release/*, got: $branch"
}

require_ancestor() {
  local sha="${1:-}" branch="${2:-}"
  [[ "$sha" =~ $COMMIT_SHA ]] || die "require-ancestor expects a 40-character SHA"
  validate_source_branch "$branch"
  git fetch --no-tags origin "+refs/heads/${branch}:refs/remotes/origin/${branch}"
  git merge-base --is-ancestor "$sha" "origin/${branch}" \
    || die "commit $sha is not reachable from origin/${branch}; refusing unreviewed or foreign history"
}

require_protected_source() {
  local branch="${1:-}" repo="${2:-${GITHUB_REPOSITORY:-}}"
  validate_source_branch "$branch"
  # main is the default trusted line. Other release/* names must be branch-protected.
  if [ "$branch" = main ]; then
    return 0
  fi
  [ -n "$repo" ] || die "GITHUB_REPOSITORY is required to verify branch protection"
  "$GH_BIN" api "repos/${repo}/branches/${branch}/protection" >/dev/null \
    || die "origin/${branch} is not a protected release branch"
}

require_prerelease_reviewers() {
  local repo="${1:-${GITHUB_REPOSITORY:-}}"
  [ -n "$repo" ] || die "GITHUB_REPOSITORY is required to verify the prerelease environment"
  local count
  count="$("$GH_BIN" api "repos/${repo}/environments/prerelease" \
    --jq '[.protection_rules[]? | select(.type=="required_reviewers") | .reviewers[]?] | length')"
  [ "${count:-0}" -ge 1 ] || die "prerelease environment has no required reviewers"
}

existing_tag_commit() {
  local tag="$1"
  local peeled
  peeled="$(git ls-remote --tags origin "refs/tags/${tag}^{}" 2>/dev/null | awk '{print $1}')"
  if [ -n "$peeled" ]; then
    printf '%s\n' "$peeled"
    return 0
  fi
  git ls-remote --tags origin "refs/tags/${tag}" 2>/dev/null | awk '{print $1}'
}

reject_tag_collision() {
  local tag="${1:-}" sha="${2:-}"
  [[ "$tag" =~ $PRE_TAG ]] || die "reject-tag-collision expects a prerelease tag"
  [[ "$sha" =~ $COMMIT_SHA ]] || die "reject-tag-collision expects a 40-character SHA"
  local existing
  existing="$(existing_tag_commit "$tag")"
  [ -z "$existing" ] && return 0
  [ "$existing" = "$sha" ] || die "git tag $tag already points at $existing, not $sha"
}

inspect_not_found() {
  printf '%s' "$1" | grep -qiE \
    'manifest unknown|MANIFEST_UNKNOWN|name unknown|NAME_UNKNOWN|not found: manifest|(^|[[:space:]])404([[:space:]]|$)'
}

inspect_raw() {
  local image="$1" err
  err="$(mktemp)"
  if ! docker buildx imagetools inspect --raw "$image" 2>"$err"; then
    local msg
    msg="$(cat "$err")"
    rm -f "$err"
    if inspect_not_found "$msg"; then
      return 1
    fi
    die "registry inspect failed for $image; refusing to publish"
  fi
  rm -f "$err"
}

inspect_raw_required() {
  local image="$1" raw
  raw="$(inspect_raw "$image")" || die "could not read $image from the registry; refusing to publish"
  [ -n "$raw" ] || die "registry inspect returned empty for $image; refusing to publish"
  printf '%s' "$raw"
}

image_fixture_status() {
  local image="$1"
  awk -F'\t' -v img="$image" '$1==img {print ($3 == "" ? "ok" : $3); exit}' "$PRERELEASE_IMAGE_INSPECT"
}

image_present() {
  local image="$1"
  if [ -n "${PRERELEASE_IMAGE_INSPECT:-}" ]; then
    case "$(image_fixture_status "$image")" in
      error) die "registry inspect failed for $image; refusing to publish" ;;
      ok) return 0 ;;
      *) return 1 ;;
    esac
  fi
  local err rc=0
  err="$(mktemp)"
  docker buildx imagetools inspect "$image" >/dev/null 2>"$err" || rc=$?
  local msg
  msg="$(cat "$err")"
  rm -f "$err"
  [ "$rc" -eq 0 ] && return 0
  if inspect_not_found "$msg"; then
    return 1
  fi
  die "registry inspect failed for $image; refusing to publish"
}

revision_from_config() {
  local image="$1" manifest="$2" cfg cfg_raw
  cfg="$(printf '%s' "$manifest" | jq -r '.config.digest // empty')"
  [ -n "$cfg" ] || return 0
  cfg_raw="$(inspect_raw_required "${image}@${cfg}")"
  printf '%s' "$cfg_raw" | jq -r '.config.Labels["org.opencontainers.image.revision"] // empty'
}

revision_from_oci() {
  local image="$1" raw="$2"
  if printf '%s' "$raw" | jq -e '(.manifests | type) == "array"' >/dev/null 2>&1; then
    local digest rev seen=""
    while IFS= read -r digest; do
      [ -n "$digest" ] || continue
      rev="$(revision_from_config "$image" "$(inspect_raw_required "${image}@${digest}")")"
      [ -n "$rev" ] || continue
      if [ -z "$seen" ]; then
        seen="$rev"
      elif [ "$seen" != "$rev" ]; then
        die "image $image has conflicting config revisions"
      fi
    done < <(printf '%s' "$raw" | jq -r '
      .manifests[]?
      | select((.platform.os // "linux") != "unknown")
      | select((.annotations["vnd.docker.reference.type"] // "") != "attestation-manifest")
      | .digest // empty
    ')
    printf '%s' "$seen"
    return 0
  fi
  revision_from_config "$image" "$raw"
}

image_revision() {
  local image="$1"
  if [ -n "${PRERELEASE_IMAGE_INSPECT:-}" ]; then
    awk -F'\t' -v img="$image" '$1==img {print $2; exit}' "$PRERELEASE_IMAGE_INSPECT"
    return 0
  fi
  local raw
  raw="$(inspect_raw "$image")" || return 0
  [ -n "$raw" ] || return 0
  revision_from_oci "$image" "$raw"
}

reject_image_collision() {
  local prefix="${1:-}" tag="${2:-}" version="${3:-}" sha="${4:-}" short="${5:-}"
  [ -n "$prefix" ] || die "image prefix required"
  [[ "$sha" =~ $COMMIT_SHA ]] || die "reject-image-collision expects a 40-character SHA"
  if [ -z "$short" ]; then
    short="${sha:0:7}"
  fi
  [[ "$short" =~ ^[0-9a-f]{7}$ ]] || die "reject-image-collision expects a 7-character short SHA"
  local component suffix image existing
  for component in backend frontend sidecar all-in-one; do
    for suffix in "sha-${short}" $tag $version; do
      [ -n "$suffix" ] || continue
      image="${prefix}/${component}:${suffix}"
      if ! image_present "$image"; then
        continue
      fi
      existing="$(image_revision "$image")"
      [ -n "$existing" ] || die "image $image exists but has no readable revision label"
      [ "$existing" = "$sha" ] || die "image $image revision $existing does not match $sha"
    done
  done
}

verify_github_release_target() {
  local tag="${1:-}" sha="${2:-}" repo="${3:-${GITHUB_REPOSITORY:-}}"
  [[ "$tag" =~ $PRE_TAG ]] || die "verify-github-release-target expects a prerelease tag"
  [[ "$sha" =~ $COMMIT_SHA ]] || die "verify-github-release-target expects a 40-character SHA"
  [ -n "$repo" ] || die "GITHUB_REPOSITORY is required"
  local existing
  if ! "$GH_BIN" release view "$tag" --repo "$repo" >/dev/null 2>&1; then
    if "$GH_BIN" api "repos/${repo}/git/ref/tags/${tag}" >/dev/null 2>&1; then
      existing="$("$GH_BIN" api "repos/${repo}/commits/${tag}" --jq .sha)"
      [ -n "$existing" ] || die "could not resolve commit for existing tag $tag"
      [ "$existing" = "$sha" ] || die "git tag $tag points at $existing, not $sha; refusing to publish"
    fi
    echo create
    return 0
  fi
  existing="$("$GH_BIN" api "repos/${repo}/commits/${tag}" --jq .sha)"
  [ -n "$existing" ] || die "could not resolve commit for existing tag $tag"
  [ "$existing" = "$sha" ] || die "GitHub tag $tag points at $existing, not $sha; refusing to reuse it"
  echo skip
}

usage() {
  die "usage: $0 <validate-source-branch|require-ancestor|require-protected-source|require-prerelease-reviewers|reject-tag-collision|reject-image-collision|verify-github-release-target> [args]"
}

main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    validate-source-branch) validate_source_branch "$@" ;;
    require-ancestor) require_ancestor "$@" ;;
    require-protected-source) require_protected_source "$@" ;;
    require-prerelease-reviewers) require_prerelease_reviewers "$@" ;;
    reject-tag-collision) reject_tag_collision "$@" ;;
    reject-image-collision) reject_image_collision "$@" ;;
    verify-github-release-target) verify_github_release_target "$@" ;;
    *) usage ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
