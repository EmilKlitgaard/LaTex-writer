#!/bin/bash
# Builds the two Mac apps. Both run the same server from this folder, so they share projects,
# settings and chats, and whichever starts first is used by the other.
#
#   LaTeX Writer.app      a native window (WebKit) around the editor. Starts the server, or uses one
#                         that already runs, and stops the server it started when you quit.
#   LaTeX Writer Web.app  starts the server in the background and opens the editor in your browser,
#                         as before. Quit it from the Dock to stop the server.
#
# While either app is open it keeps a server running: when the one in use goes away (the other app
# was quit, or it crashed), it starts a new one that reopens the same project.
#
#   ./scripts/make-app.sh              -> ~/Applications
#   ./scripts/make-app.sh /some/folder -> /some/folder
#   NO_NATIVE=1 ./scripts/make-app.sh  -> only LaTeX Writer Web
#
# The apps remember where this source folder is. Run the script again if you move the folder, or
# when scripts/app/main.swift changes. Changes to the editor itself need no rebuild.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd -P)"
DEST_DIR="${1:-$HOME/Applications}"
WEB_NAME="LaTeX Writer Web"
WEB_ID="local.latexwriter.web"
NATIVE_NAME="LaTeX Writer"
NATIVE_ID="local.latexwriter.app"
APP="$DEST_DIR/$WEB_NAME.app"
NATIVE="$DEST_DIR/$NATIVE_NAME.app"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$DEST_DIR"

# Quits a running copy of an app before it is replaced (its server saves open files as it stops).
# Only when the bundle at that path has that id and runs from there, and never by launching it:
# "tell application id" on its own would start an app that is not running.
quit_app() {
  local id="$1" bundle="$2"
  [ -f "$bundle/Contents/Info.plist" ] || return 0
  [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$bundle/Contents/Info.plist" 2>/dev/null)" = "$id" ] || return 0
  pgrep -f "$bundle/Contents/MacOS/" >/dev/null 2>&1 || return 0
  echo "Quitting the running $(basename "$bundle" .app)..."
  /usr/bin/osascript -e "if application id \"$id\" is running then tell application id \"$id\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 1 80); do pgrep -f "$bundle/Contents/MacOS/" >/dev/null 2>&1 || break; sleep 0.1; done
}

# ---- icon (shared): the favicon rendered at the sizes macOS wants ---------------------------------

ICNS=""
ICON_SRC="$SRC/web/public/favicon.svg"
if /usr/bin/qlmanage -t -s 1024 -o "$TMP" "$ICON_SRC" >/dev/null 2>&1 && [ -f "$TMP/favicon.svg.png" ]; then
  SET="$TMP/icon.iconset"
  mkdir -p "$SET"
  for size in 16 32 128 256 512; do
    /usr/bin/sips -z "$size" "$size" "$TMP/favicon.svg.png" --out "$SET/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    /usr/bin/sips -z "$double" "$double" "$TMP/favicon.svg.png" --out "$SET/icon_${size}x${size}@2x.png" >/dev/null
  done
  /usr/bin/iconutil -c icns "$SET" -o "$TMP/AppIcon.icns" 2>/dev/null && ICNS="$TMP/AppIcon.icns"
fi

# ---- LaTeX Writer Web.app: an AppleScript launcher that opens the browser --------------------------

cat > "$TMP/app.applescript" <<'APPLESCRIPT'
property sourceFolder : "__SOURCE_FOLDER__"
global serverPid, everRan, recoveries

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
	if serverPid is "" then return false
	try
		do shell script "kill -0 " & serverPid
		return true
	on error
		return false
	end try
end isRunning

-- True when a LaTeX Writer server answers, whichever app started it.
on serverAnswers()
	try
		return (do shell script "/usr/bin/curl -s -m 2 " & quoted form of (serverUrl() & "/api/ping")) contains "latex-writer"
	on error
		return false
	end try
end serverAnswers

-- extra: "" on the first start; " --no-open --reopen" when starting again after the server went away.
on startServer(extra)
	set logDir to appHome() & "/logs"
	do shell script "mkdir -p " & quoted form of logDir
	-- launch.sh replaces itself with the server process, so this id stays valid until it stops.
	set serverPid to do shell script "cd " & quoted form of sourceFolder & " && (./scripts/launch.sh" & extra & " > " & quoted form of (logDir & "/launcher.log") & " 2>&1 & echo $!)"
end startServer

on run
	set serverPid to ""
	set everRan to false
	set recoveries to 0
	try
		startServer("")
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
	if isRunning() then
		if serverAnswers() then
			set everRan to true
			set recoveries to 0
		end if
		return 3
	end if
	-- Our own server is not running: it stopped, or another app's server was already there.
	set serverPid to ""
	if serverAnswers() then
		set everRan to true
		set recoveries to 0
		return 3
	end if
	set logTail to ""
	try
		set logTail to do shell script "tail -n 6 " & quoted form of (appHome() & "/logs/launcher.log")
	end try
	if not everRan then
		-- It never got as far as running: say why instead of vanishing from the Dock.
		if logTail does not contain "already running" then
			display alert "LaTeX Writer could not start" message logTail & return & return & "If macOS asked whether LaTeX Writer may access the folder and you declined, allow it in System Settings > Privacy & Security > Files and Folders, then open the app again."
			quit
			return 3
		end if
	end if
	-- The server went away (for example the other LaTeX Writer app was quit): start a new one that
	-- opens the same project; the browser tab reconnects by itself. A server that keeps dying is not
	-- started for ever.
	set recoveries to recoveries + 1
	if recoveries > 4 then
		display alert "LaTeX Writer keeps stopping" message logTail
		quit
		return 3
	end if
	try
		startServer(" --no-open --reopen")
	end try
	return 5
end idle

on quit
	if isRunning() then
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

quit_app "$WEB_ID" "$APP"
# Until now the launcher was called "LaTeX Writer"; that name now belongs to the native app.
quit_app "local.latexwriter.launcher" "$NATIVE"
rm -rf "$APP"
if ! /usr/bin/osacompile -s -o "$APP" "$TMP/app.applescript" 2> "$TMP/osacompile.log"; then
  cat "$TMP/osacompile.log"
  exit 1
fi

PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName $WEB_NAME" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleName string $WEB_NAME" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string $WEB_ID" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $WEB_ID" "$PLIST"
if [ -n "$ICNS" ]; then
  cp "$ICNS" "$APP/Contents/Resources/applet.icns"
  rm -f "$APP/Contents/Resources/Assets.car"
fi
# The bundle was edited after osacompile signed it; sign it again (ad hoc, for this Mac only).
/usr/bin/codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
touch "$APP"
echo "Created: $APP"

# ---- LaTeX Writer.app: the native window ----------------------------------------------------------

if [ "${NO_NATIVE:-0}" = 1 ]; then
  exit 0
fi
if ! command -v swiftc >/dev/null 2>&1; then
  echo "Skipped $NATIVE_NAME.app: swiftc was not found. Install the Xcode Command Line Tools (xcode-select --install) and run this again."
  exit 0
fi

STAGE="$TMP/stage/$NATIVE_NAME.app"
mkdir -p "$STAGE/Contents/MacOS" "$STAGE/Contents/Resources"
swiftc -O -o "$STAGE/Contents/MacOS/$NATIVE_NAME" "$SRC/scripts/app/main.swift" -framework AppKit -framework WebKit
if [ -n "$ICNS" ]; then cp "$ICNS" "$STAGE/Contents/Resources/AppIcon.icns"; fi
VERSION="$(date +%Y.%m.%d)"
BUILD="$(date +%Y%m%d%H%M)"
cat > "$STAGE/Contents/Info.plist" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>$NATIVE_NAME</string>
    <key>CFBundleDisplayName</key><string>$NATIVE_NAME</string>
    <key>CFBundleExecutable</key><string>$NATIVE_NAME</string>
    <key>CFBundleIdentifier</key><string>$NATIVE_ID</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleIconFile</key><string>AppIcon</string>
    <key>CFBundleShortVersionString</key><string>$VERSION</string>
    <key>CFBundleVersion</key><string>$BUILD</string>
    <key>LSMinimumSystemVersion</key><string>12.0</string>
    <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
    <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
    <key>LWSourceFolder</key><string></string>
</dict>
</plist>
PLISTEOF
# The path goes in with plutil, so spaces and special characters need no escaping.
/usr/bin/plutil -replace LWSourceFolder -string "$SRC" "$STAGE/Contents/Info.plist"
printf 'APPL????' > "$STAGE/Contents/PkgInfo"
/usr/bin/codesign --force --sign - "$STAGE" >/dev/null 2>&1 || true

quit_app "$NATIVE_ID" "$NATIVE"
rm -rf "$NATIVE"
/usr/bin/ditto "$STAGE" "$NATIVE"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$NATIVE" >/dev/null 2>&1 || true
touch "$NATIVE"
echo "Created: $NATIVE"
echo
echo "Open either from Finder or Spotlight, and drag it to the Dock if you like."
echo "  $NATIVE_NAME       its own window; quitting it stops the server it started."
echo "  $WEB_NAME   opens in your browser; quit it from the Dock to stop the server."
