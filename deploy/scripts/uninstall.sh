#!/bin/sh
#
# Removes an Open MT2 installation created by install.sh (or the .deb).
#
#   sudo ./scripts/uninstall.sh            # keep the files, drop the services
#   sudo ./scripts/uninstall.sh --purge    # also delete /opt/open-mt2, the
#                                          # service account and /etc/open-mt2
#
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

# Always operate on the installed copy, never on the directory the release
# archive happens to be sitting in; override with PREFIX= if it was installed
# somewhere else.
PREFIX=${PREFIX:-/opt/open-mt2}
ENV_DIR=${ENV_DIR:-/etc/open-mt2}
OPEN_MT2_USER=${OPEN_MT2_USER:-open-mt2}
OPEN_MT2_GROUP=${OPEN_MT2_GROUP:-$OPEN_MT2_USER}

PURGE=0
for arg in "$@"; do
    case "$arg" in
        --purge) PURGE=1 ;;
        -h | --help)
            echo "usage: uninstall.sh [--purge]"
            exit 0
            ;;
        *) echo "uninstall.sh: unknown option '$arg'" >&2; exit 2 ;;
    esac
done

[ "$(id -u)" -eq 0 ] || { echo "uninstall.sh: must be run as root" >&2; exit 1; }

if command -v systemctl >/dev/null 2>&1; then
    for unit in open-mt2-auth open-mt2-game; do
        systemctl stop "$unit.service" 2>/dev/null || true
        systemctl disable "$unit.service" 2>/dev/null || true
        rm -f "/etc/systemd/system/$unit.service"
    done
    systemctl daemon-reload
    systemctl reset-failed 'open-mt2-*' 2>/dev/null || true
    echo "==> Services removed"
fi

if [ "$PURGE" = "1" ]; then
    # Refuse to delete anything that is not recognisably an Open MT2 install.
    if [ -d "$PREFIX" ] && [ ! -f "$PREFIX/bin/open-mt2-game" ] && [ ! -f "$PREFIX/dist/game/main.js" ]; then
        echo "uninstall.sh: $PREFIX does not look like an Open MT2 install; refusing to delete it" >&2
        exit 1
    fi

    rm -rf "$PREFIX"
    rm -rf "$ENV_DIR"
    echo "==> Removed $PREFIX and $ENV_DIR"

    if getent passwd "$OPEN_MT2_USER" >/dev/null 2>&1; then
        userdel "$OPEN_MT2_USER" 2>/dev/null || true
        echo "==> Removed user $OPEN_MT2_USER"
    fi
    if getent group "$OPEN_MT2_GROUP" >/dev/null 2>&1; then
        groupdel "$OPEN_MT2_GROUP" 2>/dev/null || true
        echo "==> Removed group $OPEN_MT2_GROUP"
    fi

    echo "==> The 'auth' and 'game' databases were left untouched; drop them manually if you want to wipe the world"
else
    echo "==> Files kept in $PREFIX (re-run with --purge to remove them)"
fi

echo "==> Done"