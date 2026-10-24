#!/bin/sh
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 naromil
#
# Add the Question Trainer to the current user's application menu.
# Re-run after moving the checkout; `./install.sh --uninstall` removes it.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
data=${XDG_DATA_HOME:-$HOME/.local/share}
entry=$data/applications/question-trainer.desktop

case ${1:-} in
  "")
    ;;
  --uninstall)
    rm -f -- "$entry"
    command -v update-desktop-database >/dev/null 2>&1 &&
      update-desktop-database "$data/applications" >/dev/null 2>&1 || true
    command -v kbuildsycoca6 >/dev/null 2>&1 &&
      kbuildsycoca6 --noincremental >/dev/null 2>&1 || true
    echo "Removed $entry"
    exit 0
    ;;
  -h|--help)
    echo "usage: $0 [--uninstall]"
    exit 0
    ;;
  *)
    echo "usage: $0 [--uninstall]" >&2
    exit 2
    ;;
esac

mkdir -p -- "$data/applications"

cat >"$entry" <<EOF
[Desktop Entry]
Type=Application
Name=Question Trainer
Comment=Practice question sets in your browser
Exec="$here/qt"
Path=$here
Icon=$here/icon.svg
Terminal=false
Categories=Education;
EOF

# Refresh the menu cache; the tool is absent on some systems.
command -v update-desktop-database >/dev/null 2>&1 &&
  update-desktop-database "$data/applications" >/dev/null 2>&1 || true
command -v kbuildsycoca6 >/dev/null 2>&1 &&
  kbuildsycoca6 --noincremental >/dev/null 2>&1 || true

echo "Installed $entry"
echo "Run it from the application menu, or with $here/qt."
