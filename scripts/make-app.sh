#!/bin/bash
# Builds "LaTeX Writer.app": a Dock app that starts the server in the background (no Terminal window)
# and stops it when you quit the app.
#
#   ./scripts/make-app.sh              -> ~/Applications/LaTeX Writer.app
#   ./scripts/make-app.sh /some/folder -> /some/folder/LaTeX Writer.app
#
# The app remembers where this source folder is. Run the script again if you move the folder.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd -P)"
DEST_DIR="${1:-$HOME/Applications}"
APP="$DEST_DIR/LaTeX Writer.app"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/app.applescript" <<'APPLESCRIPT'
property sourceFolder : "__SOURCE_FOLDER__"
global serverPid

on appHome()
	return (POSIX path of (path to home folder)) & "Library/Application Support/LaTeXWriter"
end appHome

on serverUrl()
	set thePort to "4173"
	try
		set thePort to do shell script "/usr/bin/plutil -extract lastPort raw -o - " & quoted form of (appHome() & "/config.json")
	end try
	return "http://localhost:" & thePort
end serverUrl

on isRunning()
	try
		do shell script "kill -0 " & serverPid
		return true
	on error
		return false
	end try
end isRunning

on run
	set serverPid to ""
	set logDir to appHome() & "/logs"
	try
		do shell script "mkdir -p " & quoted form of logDir
		-- launch.sh replaces itself with the server process, so this id stays valid until it stops.
		set serverPid to do shell script "cd " & quoted form of sourceFolder & " && (./scripts/launch.sh > " & quoted form of (logDir & "/launcher.log") & " 2>&1 & echo $!)"
	on error errorMessage
		display alert "LaTeX Writer could not start" message errorMessage & return & return & "Was the LaTeX Writer folder moved? Run scripts/make-app.sh again from its new place."
		quit
	end try
end run

-- Clicking the Dock icon while running opens the editor again.
on reopen
	do shell script "/usr/bin/open " & quoted form of serverUrl()
end reopen

on idle
	if serverPid is not "" and not isRunning() then
		set serverPid to ""
		-- If it never got as far as running, say why instead of vanishing from the Dock.
		set logTail to ""
		try
			set logTail to do shell script "tail -n 6 " & quoted form of (appHome() & "/logs/launcher.log")
		end try
		if logTail does not contain "is running on" and logTail does not contain "already running" then
			display alert "LaTeX Writer could not start" message logTail & return & return & "If macOS asked whether LaTeX Writer may access the folder and you declined, allow it in System Settings > Privacy & Security > Files and Folders, then open the app again."
		end if
		quit
	end if
	return 3
end idle

on quit
	if serverPid is not "" then
		try
			do shell script "kill -TERM " & serverPid
		end try
		-- Give the server a moment to write open files to disk.
		repeat 25 times
			if not isRunning() then exit repeat
			delay 0.2
		end repeat
	end if
	continue quit
end quit
APPLESCRIPT

# Put the real path into the script (escaped for an AppleScript string).
ESCAPED="$(printf '%s' "$SRC" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
/usr/bin/python3 - "$TMP/app.applescript" "$ESCAPED" <<'PY'
import sys
path, src = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read().replace("__SOURCE_FOLDER__", src)
open(path, "w", encoding="utf-8").write(text)
PY

mkdir -p "$DEST_DIR"
if [ -e "$APP" ]; then
  echo "Replacing the existing $APP"
  rm -rf "$APP"
fi
if ! /usr/bin/osacompile -s -o "$APP" "$TMP/app.applescript" 2> "$TMP/osacompile.log"; then
  cat "$TMP/osacompile.log"
  exit 1
fi

PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName LaTeX Writer" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleName string LaTeX Writer" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string local.latexwriter.launcher" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier local.latexwriter.launcher" "$PLIST"

# Icon: render the favicon at the sizes macOS wants. Skipped quietly if this Mac cannot render SVG.
ICON_SRC="$SRC/web/public/favicon.svg"
if /usr/bin/qlmanage -t -s 1024 -o "$TMP" "$ICON_SRC" >/dev/null 2>&1 && [ -f "$TMP/favicon.svg.png" ]; then
  SET="$TMP/icon.iconset"
  mkdir -p "$SET"
  for size in 16 32 128 256 512; do
    /usr/bin/sips -z "$size" "$size" "$TMP/favicon.svg.png" --out "$SET/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    /usr/bin/sips -z "$double" "$double" "$TMP/favicon.svg.png" --out "$SET/icon_${size}x${size}@2x.png" >/dev/null
  done
  if /usr/bin/iconutil -c icns "$SET" -o "$TMP/applet.icns" 2>/dev/null; then
    cp "$TMP/applet.icns" "$APP/Contents/Resources/applet.icns"
    rm -f "$APP/Contents/Resources/Assets.car"
  fi
fi

# The bundle was edited after osacompile signed it; sign it again (ad hoc, for this Mac only).
/usr/bin/codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
touch "$APP"

echo "Created: $APP"
echo "Open it from Finder or Spotlight, and drag it to the Dock if you like. Quit it from the Dock to stop LaTeX Writer."
