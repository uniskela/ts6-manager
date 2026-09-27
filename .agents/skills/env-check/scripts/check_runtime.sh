#!/usr/bin/env bash
# Detect CLOUD_AGENT vs LOCAL_WORKSPACE for agent continuity decisions.
#
# Important:
# - Hub continuity fallback is triggered by **MCP unavailable**, not by runtime alone.
# - Do **not** treat `$USER=root` as cloud (false positives on local root / privileged shells).
# - Generic Docker / Podman alone is LOCAL (local docker/localhost is expected there).
# - Prefer Cursor Cloud / remote-sandbox markers when classifying CLOUD_AGENT.
# - CLOUD_AGENT must not assume machine-installed local skill CLIs (e.g. graphify).

set -eu

is_container=0
if [ -f /.dockerenv ] || [ -f /run/.containerenv ]; then
  is_container=1
fi
if [ -r /proc/1/cgroup ] && grep -Eqi 'docker|container|kubepods|/pod|libpod|podman' /proc/1/cgroup 2>/dev/null; then
  is_container=1
fi

cursor_cloud=0
case "${CURSOR_AGENT:-}" in
  1|true|TRUE|yes|YES) cursor_cloud=1 ;;
esac
if [ -n "${__CURSOR_SANDBOX_ENV_RESTORE:-}" ]; then
  cursor_cloud=1
fi
if [ -n "${CURSOR_AGENT_SOCKET:-}" ] || [ -n "${CURSOR_CONVERSATION_ID:-}" ]; then
  if [ "$is_container" -eq 1 ] || [ -d /tmp/cursor/cloud-agent-transcripts ] || [ -d /exec-daemon ]; then
    cursor_cloud=1
  fi
fi
if [ -d /tmp/cursor/cloud-agent-transcripts ] || [ -d /exec-daemon ]; then
  cursor_cloud=1
fi

signals=()
[ "$is_container" -eq 1 ] && signals+=("container")
[ "$cursor_cloud" -eq 1 ] && signals+=("cursor_cloud")
[ -n "${CURSOR_AGENT:-}" ] && signals+=("CURSOR_AGENT=${CURSOR_AGENT}")
[ -f /.dockerenv ] && signals+=("dockerenv")
[ -n "${__CURSOR_SANDBOX_ENV_RESTORE:-}" ] && signals+=("sandbox_env_restore")
[ -d /tmp/cursor/cloud-agent-transcripts ] && signals+=("cloud_agent_transcripts")
[ -d /exec-daemon ] && signals+=("exec_daemon")

if [ "$cursor_cloud" -eq 1 ]; then
  echo "RUNTIME_ENV: CLOUD_AGENT"
else
  echo "RUNTIME_ENV: LOCAL_WORKSPACE"
fi

if [ "${#signals[@]}" -gt 0 ]; then
  IFS=','; echo "RUNTIME_SIGNALS: ${signals[*]}"; unset IFS
else
  echo "RUNTIME_SIGNALS: none"
fi

echo "HUB_CONTINUITY_TRIGGER: MCP unavailable (runtime env is supporting context only)"
echo "NOTE: \$USER=root is ignored as a sole cloud signal (false positives)"
if [ "$cursor_cloud" -eq 1 ]; then
  echo "LOCAL_SKILL_CLIS: do not assume (e.g. graphify may be missing); one-line notice then use repo tools / committed graphify-out; never fabricate graph/Hub state"
else
  echo "LOCAL_SKILL_CLIS: may be available on this machine"
fi
