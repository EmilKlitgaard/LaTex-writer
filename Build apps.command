#!/bin/bash
# Double-click to build "LaTeX Writer.app" (its own window) and "LaTeX Writer Web.app" (opens in the
# browser) into ~/Applications. Run it again after moving this folder.
cd "$(dirname "$0")" || exit 1
./scripts/make-app.sh "$@"
status=$?
if [ $status -ne 0 ]; then
  echo
  echo "❌ Building the apps failed (code $status). Press Return to close."
  read -r _
fi
