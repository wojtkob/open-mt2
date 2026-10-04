#!/bin/sh
#
# Downloads a private Node.js runtime into $OPEN_MT2_HOME/runtime.
#
# Why this exists: Armbian/Debian ship Node 18 or 20 in the main archive, while
# this project needs >= 22 (`Promise.withResolvers`, `module: nodenext`,
# `--env-file`). Rather than mutating the host package database we install a
# private, self-contained runtime under the application prefix, which the
# launchers pick up automatically.
#
# The tarball is verified against the SHASUMS256.txt published by nodejs.org
# before anything is extracted. Nothing outside $OPEN_MT2_HOME is touched.
#
# Usage:
#   OPEN_MT2_NODE_VERSION=22.23.3 scripts/install-node.sh
#   OPEN_MT2_NODE_TARBALL=/tmp/node-arm64.tar.xz scripts/install-node.sh   # offline
#
set -eu

OPEN_MT2_HOME=${OPEN_MT2_HOME:-/opt/open-mt2}
OPEN_MT2_NODE_VERSION=${OPEN_MT2_NODE_VERSION:-22.23.3}
OPEN_MT2_NODE_ARCH=${OPEN_MT2_NODE_ARCH:-}
OPEN_MT2_NODE_TARBALL=${OPEN_MT2_NODE_TARBALL:-}

RUNTIME_DIR="$OPEN_MT2_HOME/runtime"

log() { echo "install-node: $*"; }
die() { echo "install-node: $*" >&2; exit 1; }

detect_arch() {
    if [ -n "$OPEN_MT2_NODE_ARCH" ]; then
        printf '%s' "$OPEN_MT2_NODE_ARCH"
        return 0
    fi
    uname -m
}

require_tool() {
    command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not installed"
}

case "$(detect_arch)" in
    aarch64 | arm64) NODE_ARCH=arm64 ;;
    x86_64 | amd64)  NODE_ARCH=x64 ;;
    *) die "unsupported architecture '$(detect_arch)'; set OPEN_MT2_NODE_ARCH=arm64|x64|sarmv7l|armv7l" ;;
esac

DIST_DIR="node-v${OPEN_MT2_NODE_VERSION}-linux-${NODE_ARCH}"

if [ -x "$RUNTIME_DIR/bin/node" ]; then
    log "runtime already present: $("$RUNTIME_DIR/bin/node" --version)"
    exit 0
fi

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT INT TERM

TARBALL="$WORK_DIR/node.tar.xz"

if [ -n "$OPEN_MT2_NODE_TARBALL" ]; then
    [ -f "$OPEN_MT2_NODE_TARBALL" ] || die "OPEN_MT2_NODE_TARBALL=$OPEN_MT2_NODE_TARBALL does not exist"
    log "using pre-supplied tarball $OPEN_MT2_NODE_TARBALL"
    cp "$OPEN_MT2_NODE_TARBALL" "$TARBALL"
else
    require_tool curl
    URL="https://nodejs.org/dist/v${OPEN_MT2_NODE_VERSION}/${DIST_DIR}.tar.xz"
    log "downloading $URL"
    curl -fsSL --retry 3 --retry-delay 2 -o "$TARBALL" "$URL" \
        || die "download failed; download ${DIST_DIR}.tar.xz manually and re-run with OPEN_MT2_NODE_TARBALL=<file>"

    require_tool sha256sum
    SHASUMS="$WORK_DIR/SHASUMS256.txt"
    curl -fsSL --retry 3 --retry-delay 2 -o "$SHASUMS" \
        "https://nodejs.org/dist/v${OPEN_MT2_NODE_VERSION}/SHASUMS256.txt" \
        || die "could not download SHASUMS256.txt; re-run with OPEN_MT2_NODE_TARBALL=<file> to skip verification"

    EXPECTED=$(grep " ${DIST_DIR}.tar.xz\$" "$SHASUMS" | awk '{print $1}')
    [ -n "$EXPECTED" ] || die "no checksum published for ${DIST_DIR}.tar.xz"

    ACTUAL=$(sha256sum "$TARBALL" | awk '{print $1}')
    [ "$EXPECTED" = "$ACTUAL" ] || die "checksum mismatch for ${DIST_DIR}.tar.xz (expected $EXPECTED, got $ACTUAL)"
    log "checksum verified"
fi

if command -v tar >/dev/null 2>&1; then
    tar -xJf "$TARBALL" -C "$WORK_DIR" 2>/dev/null || tar -xf "$TARBALL" -C "$WORK_DIR"
else
    die "'tar' is required to unpack the Node.js runtime"
fi

[ -d "$WORK_DIR/$DIST_DIR" ] || die "unexpected archive layout: $DIST_DIR not found"

STAGING="$OPEN_MT2_HOME/.runtime.tmp"
rm -rf "$STAGING"
mkdir -p "$STAGING"
cp -a "$WORK_DIR/$DIST_DIR/." "$STAGING/"

# Swap atomically-ish: same filesystem, so `mv` is a rename.
mkdir -p "$(dirname "$RUNTIME_DIR")"
rm -rf "$RUNTIME_DIR"
mv "$STAGING" "$RUNTIME_DIR"

chmod +x "$RUNTIME_DIR/bin/node"

log "installed $("$RUNTIME_DIR/bin/node" --version) into $RUNTIME_DIR"