#!/bin/sh
#
# Open MT2 installer — installs the release package on a Debian/Armbian system
# (Pine A64 and friends) as two systemd services.
#
#   sudo ./scripts/install.sh
#
# Everything lands under $PREFIX (default /opt/open-mt2) plus
# /etc/open-mt2/env, so removing it later is a single `uninstall.sh` away.
#
# Useful overrides:
#   PREFIX=/srv/open-mt2          install somewhere else
#   OPEN_MT2_USER=mt2             service account
#   OPEN_MT2_SKIP_NODE_DOWNLOAD=1 never download a private Node runtime
#   OPEN_MT2_AUTOSTART=1          also start the services now
#   OPEN_MT2_RUN_MIGRATE=1        run the (destructive) database bootstrap
#
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
SOURCE_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)

PREFIX=${PREFIX:-/opt/open-mt2}
ENV_DIR=${ENV_DIR:-/etc/open-mt2}
ENV_FILE=${ENV_FILE:-$ENV_DIR/env}
OPEN_MT2_USER=${OPEN_MT2_USER:-open-mt2}
OPEN_MT2_GROUP=${OPEN_MT2_GROUP:-$OPEN_MT2_USER}
AUTOSTART=${OPEN_MT2_AUTOSTART:-0}
RUN_MIGRATE=${OPEN_MT2_RUN_MIGRATE:-0}

# Everything the launchers, the migration CLI and `uninstall.sh` need in order to
# keep working from $PREFIX — `scripts/` in particular, since it contains the
# Node.js bootstrap used below.
PAYLOAD_ENTRIES='bin dist node_modules deploy scripts etc docs package.json package-lock.json VERSION README.md LICENSE'

log() { echo "==> $*"; }
die() { echo "install.sh: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must be run as root (try: sudo $0)"

[ -d "$SOURCE_DIR/dist" ] || die "no dist/ directory next to this script — is this a release package?"
[ -x "$SOURCE_DIR/bin/open-mt2-game" ] || die "missing bin/open-mt2-game — is this a release package?"

log "Installing Open MT2 into $PREFIX"

# ---------------------------------------------------------------- system user
if ! getent group "$OPEN_MT2_GROUP" >/dev/null 2>&1; then
    if command -v addgroup >/dev/null 2>&1; then
        addgroup --system "$OPEN_MT2_GROUP"
    else
        groupadd --system "$OPEN_MT2_GROUP"
    fi
    log "Created group $OPEN_MT2_GROUP"
fi

if ! getent passwd "$OPEN_MT2_USER" >/dev/null 2>&1; then
    if command -v adduser >/dev/null 2>&1; then
        adduser --system --ingroup "$OPEN_MT2_GROUP" --home "$PREFIX" \
            --no-create-home --disabled-password --shell /usr/sbin/nologin "$OPEN_MT2_USER"
    else
        useradd --system --gid "$OPEN_MT2_GROUP" --home-dir "$PREFIX" \
            --shell /usr/sbin/nologin "$OPEN_MT2_USER"
    fi
    log "Created user $OPEN_MT2_USER"
fi

# ------------------------------------------------------------------ app files
if [ "$SOURCE_DIR" != "$PREFIX" ]; then
    mkdir -p "$PREFIX"
    for entry in $PAYLOAD_ENTRIES; do
        if [ -e "$SOURCE_DIR/$entry" ]; then
            cp -a "$SOURCE_DIR/$entry" "$PREFIX/"
        fi
    done
    log "Copied application files to $PREFIX"
else
    log "Install prefix already contains the extracted package"
fi

chmod +x "$PREFIX"/bin/open-mt2-* "$PREFIX"/scripts/*.sh 2>/dev/null || true

# ------------------------------------------------------------------- runtime
# The quests use `Promise.withResolvers`, which is Node 22+. A system Node 20
# loads the containers without complaint and only fails once a quest opens a
# choice window, so anything below 22 is treated as absent and replaced.
MIN_NODE_MAJOR=22
node_major=0
if command -v node >/dev/null 2>&1; then
    node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
fi

if [ "$node_major" -ge "$MIN_NODE_MAJOR" ]; then
    log "Using system Node.js $(node --version)"
elif [ "${OPEN_MT2_SKIP_NODE_DOWNLOAD:-0}" = "1" ]; then
    die "Node.js >= $MIN_NODE_MAJOR not found and OPEN_MT2_SKIP_NODE_DOWNLOAD=1"
else
    log "No Node.js >= $MIN_NODE_MAJOR found, installing a private runtime into $PREFIX/runtime"
    OPEN_MT2_HOME="$PREFIX" "$PREFIX/scripts/install-node.sh"
fi

# ----------------------------------------------------------------------- env
mkdir -p "$ENV_DIR"
if [ -f "$ENV_FILE" ]; then
    log "Keeping existing configuration $ENV_FILE"
else
    cp "$PREFIX/etc/open-mt2.env.example" "$ENV_FILE"
    log "Created $ENV_FILE from the packaged example — review it before starting"
fi
# Opt-in: the bootstrap script drops and recreates the `auth`/`game` databases,
# so it must never run implicitly during an upgrade.
if [ "$RUN_MIGRATE" = "1" ]; then
    log "Running the database bootstrap script"
    if OPEN_MT2_ENV_FILE="$ENV_FILE" "$PREFIX/bin/open-mt2-migrate"; then
        log "Database bootstrap finished"
    else
        die "database bootstrap failed — fix the settings in $ENV_FILE and re-run $PREFIX/bin/open-mt2-migrate"
    fi
fi

# ------------------------------------------------------------------- systemd
if command -v systemctl >/dev/null 2>&1; then
    for unit in open-mt2-auth open-mt2-game; do
        if [ "$PREFIX" != "/opt/open-mt2" ] || [ "$ENV_FILE" != "/etc/open-mt2/env" ]; then
            # Keep the units self-describing when the install deviates from the
            # paths baked in at release time.
            sed -e "s#/opt/open-mt2#$PREFIX#g" -e "s#/etc/open-mt2/env#$ENV_FILE#g" \
                "$PREFIX/deploy/systemd/$unit.service" > "/etc/systemd/system/$unit.service"
        else
            cp -a "$PREFIX/deploy/systemd/$unit.service" /etc/systemd/system/
        fi
        chmod 644 "/etc/systemd/system/$unit.service"
    done

    chown -R "$OPEN_MT2_USER:$OPEN_MT2_GROUP" "$PREFIX"

    systemctl daemon-reload
    systemctl enable open-mt2-auth.service open-mt2-game.service >/dev/null

    if [ "$AUTOSTART" = "1" ]; then
        systemctl restart open-mt2-auth.service open-mt2-game.service
        log "Services started"
    fi

    log "Services enabled. Start them with: systemctl start open-mt2-auth open-mt2-game"
else
    log "systemctl not found — start the servers manually with $PREFIX/bin/open-mt2-auth and $PREFIX/bin/open-mt2-game"
fi

cat <<EOF

Open MT2 installed.

  prefix : $PREFIX
  config : $ENV_FILE
  logs   : journalctl -u open-mt2-auth -u open-mt2-game -f

Next steps:
  1. Review $ENV_FILE (database/Redis addresses and credentials).
  2. Make sure MySQL and Redis are running and reachable from this host.
  3. Initialise the databases:  OPEN_MT2_ENV_FILE=$ENV_FILE $PREFIX/bin/open-mt2-migrate
     (destructive: it recreates the 'auth' and 'game' databases)
  4. Start the servers:        systemctl start open-mt2-auth open-mt2-game

EOF