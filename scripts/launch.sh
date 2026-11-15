#!/bin/bash
# Starts LaTeX Writer: installs dependencies and builds the interface when needed, then runs the server.
# Dependencies and build output live outside iCloud, in ~/Library/Application Support/LaTeXWriter.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd -P)"
APP_HOME="${LATEXWRITER_HOME:-$HOME/Library/Application Support/LaTeXWriter}"
DEPS="$APP_HOME/deps"
BUILD="$APP_HOME/build/web"

# Finder and the Dock start us without the shell profile, so find Node ourselves.
find_node() {
  if command -v node >/dev/null 2>&1; then return 0; fi
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
    command -v node >/dev/null 2>&1 && return 0
  fi
  for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin"; do
    if [ -x "$dir/node" ]; then
      PATH="$dir:$PATH"
      return 0
    fi
  done
  return 1
}

if ! find_node; then
  echo "Node.js was not found. Install it from https://nodejs.org (version 24 or newer) and try again."
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "LaTeX Writer needs Node.js 24 or newer (found $(node -v))."
  exit 1
fi
export PATH="/Library/TeX/texbin:$PATH"
if ! command -v latexmk >/dev/null 2>&1; then
  echo "Warning: latexmk was not found. Install MacTeX (https://tug.org/mactex) to compile documents."
fi

mkdir -p "$DEPS"
cd "$SRC"

# Install dependencies on first run, and again whenever package-lock.json changes.
if [ ! -d "$DEPS/node_modules" ] || ! cmp -s package-lock.json "$DEPS/package-lock.json"; then
  echo "Installing dependencies (first run, or they changed)..."
  cp package.json package-lock.json "$DEPS/"
  (cd "$DEPS" && npm ci --no-audit --no-fund)
fi
# The source folder only holds a link, so iCloud never syncs node_modules.
if [ "$(readlink node_modules 2>/dev/null || true)" != "$DEPS/node_modules" ]; then
  rm -rf node_modules
  ln -s "$DEPS/node_modules" node_modules
fi

# Rebuild the interface when any of its sources is newer than the last build, or (for a copy that
# came inside a downloaded app, marked by .version) when that copy is another version.
STAMP="$BUILD/.built"
if [ ! -f "$STAMP" ] || { [ -f .version ] && ! cmp -s .version "$STAMP"; } || [ -n "$(find web vite.config.ts package-lock.json -newer "$STAMP" -type f -print -quit)" ]; then
  echo "Building the interface..."
  npx vite build
  if [ -f .version ]; then cp .version "$STAMP"; else : > "$STAMP"; fi
fi

exec node server/index.ts "$@"
