#!/bin/bash
# Builds LaTeX Writer for other Macs and publishes it as a GitHub release, so people can download
# the apps without the source code.
#
#   scripts/release.sh --dry-run   build and check everything, publish nothing (prints where it is)
#   scripts/release.sh             the same, then tag v<version> and publish the release
#
# The version comes from package.json. The release carries:
#   LaTeX-Writer-<version>.dmg   both apps and a link to Applications: drag them over
#   LaTeX-Writer-<version>.zip   both apps; what install.sh downloads
#   install.sh                   the one-line Terminal install (no "Open Anyway" step)
#   SHA256SUMS.txt               checksums of the three, which install.sh checks
#
# The apps are signed ad hoc, not notarized (that needs a paid Apple Developer account), so a
# downloaded DMG needs "Open Anyway" once; the notes say how. Publish from a clean, pushed main.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$SRC"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

VERSION="$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' package.json | head -n 1)"
[ -n "$VERSION" ] || { echo "No version in package.json"; exit 1; }
TAG="v$VERSION"
NAME="LaTeX-Writer-$VERSION"
REPO="EmilKlitgaard/LaTex-writer"
# Outside iCloud, so the build files do not sync.
OUT="${TMPDIR:-/tmp}/latexwriter-release-$VERSION"

if [ "$DRY" = 0 ]; then
  [ -z "$(git status --porcelain)" ] || { echo "Commit or stash your changes first: a release is built from what is committed."; exit 1; }
  [ "$(git rev-parse --abbrev-ref HEAD)" = main ] || { echo "Release from main."; exit 1; }
  git fetch -q origin main
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "Push main first: the release is tagged on it."; exit 1; }
  if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || git ls-remote --exit-code --tags origin "$TAG" >/dev/null 2>&1; then
    echo "$TAG exists already. Raise the version in package.json (and package-lock.json)."
    exit 1
  fi
  command -v gh >/dev/null || { echo "The GitHub CLI (gh) is needed to publish."; exit 1; }
fi

echo "Building LaTeX Writer $VERSION in $OUT"
rm -rf "$OUT"
mkdir -p "$OUT/apps"
APP_VERSION="$VERSION" ./scripts/make-app.sh --release "$OUT/apps" | grep -E "payload|Created|Skipped"
for app in "LaTeX Writer.app" "LaTeX Writer Web.app"; do
  [ -d "$OUT/apps/$app/Contents/Resources/app/server" ] || { echo "$app carries no copy of LaTeX Writer"; exit 1; }
  codesign --verify --deep "$OUT/apps/$app" || { echo "$app is not validly signed"; exit 1; }
done

# The disk image: both apps, a link to Applications and the install steps.
mkdir -p "$OUT/dmg"
ditto "$OUT/apps" "$OUT/dmg"
ln -s /Applications "$OUT/dmg/Applications"
cat > "$OUT/dmg/Read me first.txt" <<EOF
LaTeX Writer $VERSION

1. Drag both apps onto Applications.
   LaTeX Writer      the editor in its own window
   LaTeX Writer Web  the same editor in your browser
2. Open LaTeX Writer. macOS says it cannot check it for malicious software, because it is not
   notarized. Open System Settings > Privacy & Security, scroll down and click "Open Anyway"
   next to LaTeX Writer, then confirm. This is needed once per app.

You need Node.js 24 or newer (https://nodejs.org) and MacTeX (https://tug.org/mactex).
The first start installs what LaTeX Writer needs from the internet, which takes a minute or two.

Instead of all this you can install from Terminal, with no "Open Anyway" step:
  curl -fsSL https://github.com/$REPO/releases/latest/download/install.sh | bash

More: https://github.com/$REPO
EOF
hdiutil create -quiet -volname "LaTeX Writer $VERSION" -srcfolder "$OUT/dmg" -ov -format UDZO "$OUT/$NAME.dmg"

# The zip holds both apps at its top, as install.sh expects.
ditto -c -k "$OUT/apps" "$OUT/$NAME.zip"
cp scripts/install.sh "$OUT/install.sh"
(cd "$OUT" && shasum -a 256 "$NAME.dmg" "$NAME.zip" install.sh > SHA256SUMS.txt)

# Check what was made: the zip unpacks to both apps, the image mounts with both apps and the link.
CHECK="$OUT/check"
mkdir -p "$CHECK"
ditto -x -k "$OUT/$NAME.zip" "$CHECK/zip"
for app in "LaTeX Writer.app" "LaTeX Writer Web.app"; do
  [ -d "$CHECK/zip/$app" ] || { echo "The zip lacks $app"; exit 1; }
  codesign --verify --deep "$CHECK/zip/$app" || { echo "$app in the zip is not validly signed"; exit 1; }
done
MOUNT="$(hdiutil attach -nobrowse -readonly "$OUT/$NAME.dmg" | awk -F'\t' '/\/Volumes\// { print $NF }' | tail -n 1)"
ok=1
[ -d "$MOUNT/LaTeX Writer.app" ] && [ -d "$MOUNT/LaTeX Writer Web.app" ] && [ -L "$MOUNT/Applications" ] || ok=0
hdiutil detach -quiet "$MOUNT" || true
[ "$ok" = 1 ] || { echo "The disk image is missing an app or the Applications link"; exit 1; }
(cd "$OUT" && shasum -a 256 -c SHA256SUMS.txt >/dev/null) || { echo "Checksums do not match"; exit 1; }

NOTES="$OUT/notes.md"
cat > "$NOTES" <<EOF
A local, Overleaf-style LaTeX editor for macOS, with live PDF preview, collaboration on your network, and an optional AI assistant (Claude Code or Codex, using your own subscription).

**Two apps:** **LaTeX Writer** opens the editor in its own window; **LaTeX Writer Web** opens it in your browser. Both use the same projects and settings.

### Install

The quickest way, in Terminal (checks the download, installs both apps, no "Open Anyway" step):

\`\`\`bash
curl -fsSL https://github.com/$REPO/releases/latest/download/install.sh | bash
\`\`\`

Or download **$NAME.dmg**, drag both apps to Applications, and open LaTeX Writer. The apps are not notarized, so macOS blocks the first start: open System Settings › Privacy & Security, click **Open Anyway** next to LaTeX Writer, and confirm. This is needed once per app.

### Requirements

- macOS 12 or later
- [Node.js](https://nodejs.org) 24 or newer
- [MacTeX](https://tug.org/mactex) to compile documents
- Internet on the first start, which installs what LaTeX Writer needs (a minute or two)
- For the assistant (optional): [Claude Code](https://claude.com/claude-code) or Codex (in the ChatGPT app), signed in

SHA256SUMS.txt lists the checksums of the files here.
EOF

echo
echo "Built and checked:"
(cd "$OUT" && ls -lh "$NAME.dmg" "$NAME.zip" install.sh SHA256SUMS.txt | awk '{ print "  " $5 "  " $9 }')
if [ "$DRY" = 1 ]; then
  echo "Dry run: nothing was published. Files and notes are in $OUT"
  exit 0
fi

git tag -a "$TAG" -m "LaTeX Writer $VERSION"
git push -q origin "$TAG"
gh release create "$TAG" --repo "$REPO" --title "LaTeX Writer $VERSION" --notes-file "$NOTES" \
  "$OUT/$NAME.dmg" "$OUT/$NAME.zip" "$OUT/install.sh" "$OUT/SHA256SUMS.txt"
echo "Published: https://github.com/$REPO/releases/tag/$TAG"
