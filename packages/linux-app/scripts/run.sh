#!/bin/sh
# Starts the window with the system's Electron (docs/linux-app-v0.md §5): ELECTRON names another.
here=$(cd "$(dirname "$0")/.." && pwd)
electron=${ELECTRON:-$(command -v electron)}
if [ -z "$electron" ]; then
  echo "没有找到 electron。Arch：sudo pacman -S electron；其他发行版见 docs/linux-app-v0.md §5。" >&2
  exit 1
fi
exec "$electron" "$here" "$@"
