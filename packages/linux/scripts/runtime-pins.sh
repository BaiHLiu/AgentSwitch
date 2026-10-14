# Pinned downloads of the Linux runtime, sourced by build-runtime.sh and lock-python.sh (not run on its own). The same
# Node and Python as the Mac app's (packages/mac-app/scripts/runtime-pins.sh), for this machine's architecture; the
# SHA-256 of each file is the release's own (nodejs.org SHASUMS256.txt, python-build-standalone SHA256SUMS).
# shellcheck shell=bash

NODE_VERSION="24.21.0"
PBS_RELEASE="20260901"
PYTHON_VERSION="3.12.14"
PY_MINOR="3.12"

case "$(uname -m)" in
  x86_64)
    ARCH="x86_64"
    NODE_SHA256="6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff"
    NODE_TARBALL="node-v${NODE_VERSION}-linux-x64.tar.gz"
    PYTHON_SHA256="936c246dfdbbfa7cb22dd01814a21f582a892689fae96b06071a5e433baffa22"
    PYTHON_TRIPLE="x86_64-unknown-linux-gnu"
    PY_PLATFORM="x86_64-manylinux_2_28"
    ;;
  aarch64|arm64)
    ARCH="aarch64"
    NODE_SHA256="724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5"
    NODE_TARBALL="node-v${NODE_VERSION}-linux-arm64.tar.gz"
    PYTHON_SHA256="b61b856c3e1a4fc65b8f6e6b0495ef975dd0924f90c59f3ea61b38a079173b84"
    PYTHON_TRIPLE="aarch64-unknown-linux-gnu"
    PY_PLATFORM="aarch64-manylinux_2_28"
    ;;
  *) printf 'error: no runtime for %s (x86_64 and aarch64 only)\n' "$(uname -m)" >&2; exit 1 ;;
esac
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"
PYTHON_TARBALL="cpython-${PYTHON_VERSION}+${PBS_RELEASE}-${PYTHON_TRIPLE}-install_only.tar.gz"
PYTHON_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/cpython-${PYTHON_VERSION}%2B${PBS_RELEASE}-${PYTHON_TRIPLE}-install_only.tar.gz"

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# fetch <url> <file> <sha256>: download once into $CACHE, verify on every call (a mismatch deletes it and stops).
fetch() {
  local url="$1" file="$CACHE/$2" sha="$3"
  mkdir -p "$CACHE"
  if [ ! -f "$file" ]; then
    log "downloading $2"
    curl -fsSL --retry 3 -o "$file.part" "$url"
    mv "$file.part" "$file"
  fi
  local got
  got="$(sha256sum "$file" | awk '{print $1}')"
  if [ "$got" != "$sha" ]; then
    rm -f "$file"
    die "SHA-256 mismatch for $2: expected $sha, got $got (cached copy removed)"
  fi
  echo "verified $2"
}

# extract <tarball in $CACHE> <dir>: a fresh tree from the verified tarball, replacing whatever was at <dir>.
extract() {
  local tarball="$CACHE/$1" dir="$2"
  rm -rf "$dir"
  mkdir -p "$dir"
  tar -xzf "$tarball" -C "$dir" --strip-components 1
}
