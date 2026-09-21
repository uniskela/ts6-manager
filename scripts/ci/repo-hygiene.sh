#!/usr/bin/env bash
# Repo hygiene gates for Docker/Windows CRLF and Compose validity.
# Run from the repository root: ./scripts/ci/repo-hygiene.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

fail=0

echo "==> CRLF check on tracked *.sh"
mapfile -t shell_scripts < <(git ls-files '*.sh')
if ((${#shell_scripts[@]} == 0)); then
  echo "No tracked *.sh files found." >&2
  exit 1
fi

crlf_hits=()
for script in "${shell_scripts[@]}"; do
  if grep -Iq $'\r' -- "$script"; then
    crlf_hits+=("$script")
  fi
done
if ((${#crlf_hits[@]} > 0)); then
  echo "CRLF line endings found in:" >&2
  printf '  %s\n' "${crlf_hits[@]}" >&2
  fail=1
else
  echo "OK: no CRLF in ${#shell_scripts[@]} tracked shell script(s)"
fi

echo "==> shell -n on tracked *.sh"
for script in "${shell_scripts[@]}"; do
  shebang="$(head -n1 "$script" || true)"
  case "$shebang" in
    *bash*)
      checker=(bash -n)
      ;;
    *)
      checker=(sh -n)
      ;;
  esac
  if ! "${checker[@]}" "$script"; then
    echo "${checker[*]} failed: $script" >&2
    fail=1
  fi
done
if [[ "$fail" -eq 0 ]]; then
  echo "OK: shell -n passed for ${#shell_scripts[@]} script(s)"
fi

echo "==> Obsolete top-level version: in docker-compose*.yml"
mapfile -t compose_files < <(git ls-files 'docker-compose*.yml' | sort)
if ((${#compose_files[@]} == 0)); then
  echo "No tracked docker-compose*.yml files found." >&2
  exit 1
fi

version_hits=()
for compose in "${compose_files[@]}"; do
  if grep -qE '^version:' -- "$compose"; then
    version_hits+=("$compose")
  fi
done
if ((${#version_hits[@]} > 0)); then
  echo "Obsolete top-level version: found in:" >&2
  printf '  %s\n' "${version_hits[@]}" >&2
  fail=1
else
  echo "OK: no top-level version: in ${#compose_files[@]} compose file(s)"
fi

echo "==> docker compose config --quiet"
if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required for compose config validation" >&2
  exit 1
fi

export JWT_SECRET=dummy
export ENCRYPTION_KEY=dummy
export SIDECAR_SECRET=dummy

for compose in "${compose_files[@]}"; do
  echo "  validating $compose"
  if ! docker compose -f "$compose" config --quiet; then
    echo "docker compose config failed: $compose" >&2
    fail=1
  fi
done
if [[ "$fail" -eq 0 ]]; then
  echo "OK: docker compose config for ${#compose_files[@]} file(s)"
fi

if [[ "$fail" -ne 0 ]]; then
  echo "repo-hygiene failed" >&2
  exit 1
fi

echo "repo-hygiene passed"
