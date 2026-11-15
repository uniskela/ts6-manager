# Shared INT media-fetcher Compose identity (source from sibling scripts).
# Distinct from: production TS6 Manager, disposable INT TS (ts6-discord-int), D1 lab.
# POSIX sh compatible (repo hygiene runs sh -n on tracked *.sh).
# shellcheck shell=sh

DISCORD_INT_MEDIA_COMPOSE_PROJECT="${DISCORD_INT_MEDIA_COMPOSE_PROJECT:-ts6-discord-int-media}"
DISCORD_INT_MEDIA_COMPOSE_FILE="${DISCORD_INT_MEDIA_COMPOSE_FILE:-docker-compose.discord-int-media-fetcher.yml}"

# Forbidden project names — never reuse these for this stack (space-separated).
DISCORD_INT_MEDIA_FORBIDDEN_PROJECTS="ts6-discord-int ts6-manager ts6 d1 d1-ts6-lab integration-discord-bridge-commands-radio"

# Owned container_name values for this stack (space-separated).
DISCORD_INT_MEDIA_OWNED_CONTAINERS="ts6-discord-int-media-fetcher ts6-discord-int-media-egress-proxy ts6-discord-int-backend ts6-discord-int-sidecar"

discord_int_media_compose() {
  docker compose -p "$DISCORD_INT_MEDIA_COMPOSE_PROJECT" -f "$DISCORD_INT_MEDIA_COMPOSE_FILE" "$@"
}

# Abort if project name collides with reserved stacks or owned container names
# belong to a different Compose project.
discord_int_media_assert_project_safe() {
  p="$DISCORD_INT_MEDIA_COMPOSE_PROJECT"
  if [ "$p" != "ts6-discord-int-media" ] && [ -z "${DISCORD_INT_MEDIA_ALLOW_ALT_PROJECT:-}" ]; then
    echo "int-media-compose FAIL: project must be ts6-discord-int-media (got '$p')" >&2
    return 1
  fi
  for forbidden in $DISCORD_INT_MEDIA_FORBIDDEN_PROJECTS; do
    if [ "$p" = "$forbidden" ]; then
      echo "int-media-compose FAIL: project name '$p' collides with reserved stack '$forbidden'" >&2
      return 1
    fi
  done
  for c in $DISCORD_INT_MEDIA_OWNED_CONTAINERS; do
    if docker inspect "$c" >/dev/null 2>&1; then
      label="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$c" 2>/dev/null || true)"
      if [ -n "$label" ] && [ "$label" != "$p" ]; then
        echo "int-media-compose FAIL: container '$c' belongs to project '$label', not '$p'" >&2
        return 1
      fi
    fi
  done
  return 0
}

# After up: every existing owned container must carry our project label.
discord_int_media_assert_running_labels() {
  p="$DISCORD_INT_MEDIA_COMPOSE_PROJECT"
  for c in $DISCORD_INT_MEDIA_OWNED_CONTAINERS; do
    if docker inspect "$c" >/dev/null 2>&1; then
      label="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$c" 2>/dev/null || true)"
      if [ "$label" != "$p" ]; then
        echo "int-media-compose FAIL: '$c' label project='$label' expected '$p'" >&2
        return 1
      fi
    fi
  done
  return 0
}
