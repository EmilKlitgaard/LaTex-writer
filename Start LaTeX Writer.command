#!/bin/bash
# Double-click to start LaTeX Writer. Close this window (or press Ctrl+C) to stop it.
cd "$(dirname "$0")" || exit 1
./scripts/launch.sh
status=$?
if [ $status -ne 0 ]; then
  echo
  echo "LaTeX Writer stopped with an error (code $status). Press Return to close this window."
  read -r _
fi
