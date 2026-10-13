#!/usr/bin/env bash
#
# Overwrites one of the README screenshots with a fresh capture of the
# running app window. Get the app into the state you want shown (`npm run
# dev`, then load a local folder, a YouTube link, or scan an audio CD), then
# run:
#
#   scripts/update-screenshot.sh local
#   scripts/update-screenshot.sh youtube
#   scripts/update-screenshot.sh cd
#
# Linux (X11/XWayland) only.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
window_title="Scry Player"

target_file() {
  case "$1" in
    local) echo "example_local_screenshot.png" ;;
    youtube) echo "example_youtube_screenshot.png" ;;
    cd) echo "example_cd_screenshot.png" ;;
    *) return 1 ;;
  esac
}

usage_and_exit() {
  if [[ -n "${1:-}" ]]; then
    printf '%s\n\n' "$1" >&2
  fi
  printf 'Usage: scripts/update-screenshot.sh <local|youtube|cd> [--window-id=<id>]\n\n' >&2
  printf 'Run the app (`npm run dev`), get it into the state you want captured,\n' >&2
  printf 'then run this with the matching target to overwrite that README screenshot.\n' >&2
  exit 1
}

cleanup() {
  rm -f "${1:-}"
}

# Every xwininfo -tree line for a window titled "Scry Player" (case
# insensitive, matching how the real window manager renders it), newline
# separated, window id first on the line.
find_window_ids() {
  xwininfo -root -tree | grep -iE '^[[:space:]]*0x[0-9a-f]+\b.*"[^"]*'"$window_title"'[^"]*"' \
    | grep -oE '0x[0-9a-f]+' || true
}

main() {
  local target="" window_id_override=""
  for arg in "$@"; do
    case "$arg" in
      --window-id=*) window_id_override="${arg#--window-id=}" ;;
      --*) ;;
      *) [[ -z "$target" ]] && target="$arg" ;;
    esac
  done

  local out_name
  if [[ -z "$target" ]] || ! out_name="$(target_file "$target")"; then
    usage_and_exit "Target must be one of: local, youtube, cd"
  fi

  for bin in xwininfo import; do
    command -v "$bin" >/dev/null 2>&1 || usage_and_exit \
      "Missing \"$bin\". Install the X11/ImageMagick tools:
  sudo apt install x11-utils imagemagick"
  done

  local out_file="$repo_root/images/$out_name"
  # Written next to $out_file (not /tmp) so the final `mv` stays on one
  # filesystem — /tmp is often a separate mount (e.g. tmpfs), and a rename
  # across devices fails. Keeping ".png" as the actual extension matters:
  # ImageMagick picks its output format from the filename suffix, so a name
  # ending in anything else silently writes PostScript instead.
  local tmp_file="$repo_root/images/.tmp-$$-$out_name"
  trap 'cleanup "$tmp_file"' EXIT

  local window_id="$window_id_override"
  if [[ -z "$window_id" ]]; then
    local ids=()
    while IFS= read -r id; do
      [[ -n "$id" ]] && ids+=("$id")
    done < <(find_window_ids)

    if [[ "${#ids[@]}" -eq 0 ]]; then
      usage_and_exit "Couldn't find a window titled \"$window_title\". Is the app running (\`npm run dev\`)?
On a Wayland session, GTK apps sometimes render outside X and won't show up here — try \`GDK_BACKEND=x11 npm run dev\` instead, or pass --window-id=<id> from \`xwininfo -root -tree\`."
    fi
    if [[ "${#ids[@]}" -gt 1 ]]; then
      echo "Found ${#ids[@]} windows titled \"$window_title\", using the first (${ids[0]})." >&2
      echo "Pass --window-id=<id> to pick a different one." >&2
    fi
    window_id="${ids[0]}"
  fi

  local import_err
  if ! import_err="$(import -window "$window_id" "$tmp_file" 2>&1)"; then
    usage_and_exit "\`import -window $window_id\` failed: $import_err
The window may have closed, moved off a capturable surface, or the compositor is blocking the grab."
  fi

  local size
  size="$(stat -c%s "$tmp_file" 2>/dev/null || echo 0)"
  if [[ "$size" -lt 1024 ]]; then
    usage_and_exit "Capture looked empty (under 1KB) — the window probably was not visible. Aborting without touching the README image."
  fi

  mv "$tmp_file" "$out_file"
  trap - EXIT

  local kb
  kb="$(awk -v s="$size" 'BEGIN { printf "%.0f", s / 1024 }')"
  echo "Saved $target screenshot to images/$out_name (${kb} KB)."
}

main "$@"
