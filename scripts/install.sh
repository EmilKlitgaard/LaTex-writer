#!/bin/bash
# Installs or updates LaTeX Writer (both apps) from a GitHub release.
#   curl -fsSL https://github.com/EmilKlitgaard/LaTex-writer/releases/latest/download/install.sh | bash
#   curl -fsSL …/install.sh | bash -s -- 1.1.0      a given version instead of the latest
#   scripts/install.sh --dry-run [VERSION]           print what it would do, change nothing
# Checks the zip against the release's SHA256SUMS.txt before anything is changed, and never uses
# sudo: it installs into /Applications when this account may write there, else ~/Applications.
# A download through curl carries no quarantine flag, so macOS does not ask to "Open Anyway".
set -o errexit -o nounset -o pipefail

REPO=EmilKlitgaard/LaTex-writer
API="https://api.github.com/repos/$REPO/releases/latest"
APPS=("LaTeX Writer.app" "LaTeX Writer Web.app")

say() { printf '%s\n' "$*"; }
fail() { printf 'LaTeX Writer install: %s\n' "$*" >&2; exit 1; }

usage() {
  say "Usage: install.sh [--dry-run] [VERSION]"
  say "Installs LaTeX Writer VERSION (for example 1.1.0), or the latest release."
}

tag_from_json() {
  tr ',{}' '\n' | sed -n 's/^[[:space:]]*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

valid_version() {
  local re='^[0-9]+(\.[0-9]+)*(-[0-9A-Za-z.]+)?$'
  [[ $1 =~ $re ]]
}

target_dir() {
  if [ -w /Applications ]; then echo /Applications; else echo "$HOME/Applications"; fi
}

running() {
  pgrep -f "/LaTeX Writer( Web)?\.app/Contents/MacOS/" >/dev/null 2>&1
}

main() {
  local dry_run=0 version=""
  while [ $# -gt 0 ]; do
    case $1 in
      --dry-run) dry_run=1 ;;
      -h|--help) usage; exit 0 ;;
      -*) usage >&2; exit 2 ;;
      '') fail "the version argument is empty." ;;
      *) [ -z "$version" ] || { usage >&2; exit 2; }; version=$1 ;;
    esac
    shift
  done

  [ "$(uname -s)" = Darwin ] || fail "LaTeX Writer is for macOS only."
  local tool
  for tool in curl shasum ditto open; do command -v "$tool" >/dev/null || fail "$tool is missing."; done

  if [ -z "$version" ]; then
    say "Looking up the latest release"
    local json
    json=$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API") \
      || fail "couldn't reach the GitHub API (it allows 60 lookups an hour per address). Name a version instead: bash -s -- 1.1.0"
    version=$(printf '%s' "$json" | tag_from_json)
    [ -n "$version" ] || fail "the GitHub API answer had no release tag."
  fi
  version=${version#v}
  valid_version "$version" || fail "'$version' isn't a version number like 1.1.0."

  local base="https://github.com/$REPO/releases/download/v$version"
  local zip="LaTeX-Writer-$version.zip"
  local dest
  dest=$(target_dir)
  if [ "$dry_run" = 1 ]; then
    say "version $version"
    say "zip $base/$zip"
    say "sums $base/SHA256SUMS.txt"
    say "apps $dest/${APPS[0]}, $dest/${APPS[1]}"
    exit 0
  fi

  if running; then
    fail "LaTeX Writer is running. Quit it (both apps, if both are open), then run this again."
  fi

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/latexwriter-install-XXXXXX")
  trap 'rm -rf "$tmp"' EXIT

  say "Downloading LaTeX Writer $version"
  curl -fL --progress-bar -o "$tmp/$zip" "$base/$zip" || fail "couldn't download $base/$zip"
  curl -fsSL -o "$tmp/SHA256SUMS.txt" "$base/SHA256SUMS.txt" || fail "couldn't download $base/SHA256SUMS.txt"

  say "Checking the SHA-256 checksum"
  local expected actual hex='^[0-9a-fA-F]{64}$'
  expected=$(awk -v f="$zip" '$2 == f || $2 == "*" f { print $1; exit }' "$tmp/SHA256SUMS.txt")
  [[ $expected =~ $hex ]] || fail "SHA256SUMS.txt lists no checksum for $zip."
  actual=$(shasum -a 256 "$tmp/$zip" | awk '{ print $1 }')
  [ "$actual" = "$expected" ] || fail "the checksum of $zip doesn't match SHA256SUMS.txt. Nothing was installed."

  ditto -x -k "$tmp/$zip" "$tmp/unpacked" || fail "couldn't unpack $zip."
  local app
  for app in "${APPS[@]}"; do
    [ -d "$tmp/unpacked/$app/Contents/MacOS" ] || fail "$zip doesn't hold $app."
  done

  mkdir -p "$dest"
  say "Installing to $dest"
  for app in "${APPS[@]}"; do
    # Unpacked next to the old app first, so putting it in place is a rename on the same volume.
    rm -rf "$dest/.$app.new"
    ditto "$tmp/unpacked/$app" "$dest/.$app.new" || fail "couldn't copy $app to $dest."
    rm -rf "$dest/$app"
    mv "$dest/.$app.new" "$dest/$app" || fail "couldn't put $app in place."
  done

  command -v node >/dev/null 2>&1 || [ -x /opt/homebrew/bin/node ] || [ -x /usr/local/bin/node ] || [ -d "$HOME/.nvm/versions/node" ] \
    || say "Note: Node.js was not found. LaTeX Writer needs Node.js 24 or newer: https://nodejs.org"
  [ -x /Library/TeX/texbin/latexmk ] || command -v latexmk >/dev/null 2>&1 \
    || say "Note: MacTeX was not found. Install it to compile documents: https://tug.org/mactex"

  say "Opening LaTeX Writer (the first start installs what it needs, which takes a minute or two)"
  open "$dest/${APPS[0]}"
  say "Done: LaTeX Writer $version is in $dest."
}

main "$@"
