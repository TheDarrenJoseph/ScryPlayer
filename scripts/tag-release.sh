#!/usr/bin/env bash
#
# Bumps the version everywhere it's declared (package.json, tauri.conf.json,
# Cargo.toml — and Cargo.lock's record of it), commits that as one change,
# and tags it. Pushing is a separate, explicit confirmation: this script
# collapses the busywork, not the decision to actually ship.
#
# Every step checks the current state first and skips itself — with a line
# saying so — when there's nothing to do. That makes it safe to re-run: a
# first release tagging an already-correct 0.1.0, or a retry after an
# earlier run got as far as the commit but not the tag, both just do
# whatever's left.
#
#   scripts/tag-release.sh 0.2.0

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

usage_and_exit() {
  if [[ -n "${1:-}" ]]; then
    printf '%s\n\n' "$1" >&2
  fi
  printf 'Usage: scripts/tag-release.sh <version>\n\nExample: scripts/tag-release.sh 0.2.0\n' >&2
  exit 1
}

# Rewrites a `"version": "..."` field, printing what it did. Returns success
# (and prints "updated ...") only if the value actually changed, so a caller
# can do `if sync_json_version ...; then` to track which files to commit.
sync_json_version() {
  local rel_path="$1" version="$2" file="$repo_root/$1"

  if ! grep -qE '"version": *"[^"]*"' "$file"; then
    usage_and_exit "Could not find a \"version\" field in $rel_path."
  fi

  local current
  current="$(sed -nE '0,/"version": *"[^"]*"/{s/.*"version": *"([^"]*)".*/\1/p}' "$file")"

  if [[ "$current" == "$version" ]]; then
    echo "skipped $rel_path (already $version)"
    return 1
  fi

  sed -i -E '0,/"version": *"[^"]*"/{s/"version": *"[^"]*"/"version": "'"$version"'"/}' "$file"
  echo "updated $rel_path"
}

# As above, for Cargo.toml's bare `version = "..."` form. Anchored to the
# start of the line so this only ever touches the [package] version, never
# a dependency's — those are written as `name = { version = "...", ... }`
# on one line, not a standalone `version = "..."` line.
sync_cargo_version() {
  local rel_path="$1" version="$2" file="$repo_root/$1"

  if ! grep -qE '^version = "[^"]*"' "$file"; then
    usage_and_exit "Could not find a \"version\" field in $rel_path."
  fi

  local current
  current="$(sed -nE '/^version = "/{s/^version = "([^"]*)".*/\1/p;q}' "$file")"

  if [[ "$current" == "$version" ]]; then
    echo "skipped $rel_path (already $version)"
    return 1
  fi

  sed -i -E '0,/^version = "[^"]*"/{s/^version = "[^"]*"/version = "'"$version"'"/}' "$file"
  echo "updated $rel_path"
}

confirm() {
  local answer
  read -r -p "$1 [y/N] " answer || answer=""
  [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]]
}

main() {
  local raw="${1:-}"
  [[ -n "$raw" ]] || usage_and_exit ""

  local version="${raw#v}"
  if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
    usage_and_exit "\"$raw\" doesn't look like a version (expected e.g. 0.2.0)."
  fi
  local tag="v$version"

  [[ "$(git rev-parse --abbrev-ref HEAD)" == "main" ]] \
    || usage_and_exit "Releases are tagged from main. Switch branches and try again."

  [[ -z "$(git status --porcelain)" ]] \
    || usage_and_exit "Working tree is not clean. Commit or stash first."

  git fetch origin main
  [[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] \
    || usage_and_exit "main is not up to date with origin/main. Pull first."

  local changed=() cargo_changed=0
  if sync_json_version package.json "$version"; then changed+=("package.json"); fi
  if sync_json_version src-tauri/tauri.conf.json "$version"; then changed+=("src-tauri/tauri.conf.json"); fi
  if sync_cargo_version src-tauri/Cargo.toml "$version"; then
    changed+=("src-tauri/Cargo.toml")
    cargo_changed=1
  fi

  if [[ "$cargo_changed" == 1 ]]; then
    # Regenerates just this package's version line in Cargo.lock — nothing else in it.
    cargo check --manifest-path src-tauri/Cargo.toml --quiet
    changed+=("src-tauri/Cargo.lock")
    echo "updated src-tauri/Cargo.lock"
  fi

  if [[ "${#changed[@]}" -gt 0 ]]; then
    git add "${changed[@]}"
    git commit -m "Bump version to $version"
    echo "committed: Bump version to $version"
  else
    echo "skipped commit (nothing changed)"
  fi

  if [[ -n "$(git tag --list "$tag")" ]]; then
    echo "skipped git tag (already $tag)"
  else
    git tag "$tag"
    echo "created git tag $tag"
  fi

  echo
  if confirm "Push main and $tag to origin now? This starts the release build."; then
    git push origin main "$tag"
    echo "Pushed. Watch the build under Actions, then publish the draft release once it's done."
  else
    printf 'Not pushed. When ready:\n\n  git push origin main %s\n' "$tag"
  fi
}

main "$@"
