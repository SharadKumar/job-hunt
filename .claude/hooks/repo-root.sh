#!/bin/bash
# repo-root.sh — deterministic repository-root resolver.
#
# Walks up from $1 (or $PWD) to the first directory that contains BOTH a
# CLAUDE.md and a package.json whose "name" matches this harness. Prints the
# absolute path on stdout and exits 0; prints a diagnostic on stderr and exits
# 1 when no such ancestor exists.
#
# Why: headless launchd runs and Codex invocations do NOT reliably inherit the
# repo as cwd. Every hook, script and skill resolves paths through this instead
# of trusting $PWD.
#
#   Executed:  ROOT="$(bash .claude/hooks/repo-root.sh)"
#   Sourced:   source .claude/hooks/repo-root.sh && ROOT="$(repo_root)"
#
# Override the expected package name with HARNESS_REPO_NAME (forks).
# Override resolution entirely with HARNESS_REPO_ROOT (tests, launchers that
# already know the root).

REPO_ROOT_EXPECTED_NAME="${HARNESS_REPO_NAME:-job-hunt-career-harness}"

repo_root() {
  local start="${1:-$PWD}"
  local dir

  if [ -n "${HARNESS_REPO_ROOT:-}" ]; then
    printf '%s\n' "$HARNESS_REPO_ROOT"
    return 0
  fi

  if [ ! -d "$start" ]; then
    echo "repo-root: start path is not a directory: $start" >&2
    return 1
  fi

  dir="$(cd "$start" 2>/dev/null && pwd -P)" || {
    echo "repo-root: cannot enter start path: $start" >&2
    return 1
  }

  while :; do
    if [ -f "$dir/CLAUDE.md" ] && [ -f "$dir/package.json" ] \
       && grep -qE "\"name\"[[:space:]]*:[[:space:]]*\"${REPO_ROOT_EXPECTED_NAME}\"" "$dir/package.json"; then
      printf '%s\n' "$dir"
      return 0
    fi
    [ "$dir" = "/" ] && break
    dir="$(dirname "$dir")"
  done

  echo "repo-root: no ancestor of '$start' contains CLAUDE.md + package.json with name \"${REPO_ROOT_EXPECTED_NAME}\"." >&2
  echo "repo-root: run this from inside the harness repository, or set HARNESS_REPO_NAME if this is a fork." >&2
  return 1
}

# Only auto-run when executed directly, so `source`-ing just defines the function.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  repo_root "${1:-$PWD}"
  exit $?
fi
