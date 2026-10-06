#!/bin/sh
#
# Shared launcher logic for the Open MT2 servers.
#
# Sourced by bin/open-mt2-auth, bin/open-mt2-game and bin/open-mt2-migrate.
# It is deliberately POSIX sh (Armbian ships dash as /bin/sh) so it works on a
# bare Pine A64 with no bash installed.
#
# Resolution order for the Node.js binary:
#   1. $OPEN_MT2_NODE                       (explicit override)
#   2. $OPEN_MT2_HOME/runtime/bin/node     (Node downloaded by install.sh)
#   3. node from PATH                      (system-wide Node >= 22)
#
set -eu

if [ -z "${OPEN_MT2_HOME:-}" ]; then
    OPEN_MT2_HOME=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
fi
export OPEN_MT2_HOME

# Must agree with package.json#engines.node, src/core/util/nodeVersion.ts and
# deploy/scripts/install.sh. test/unit/core/util/nodeVersion.test.ts reads all
# four and fails if they drift: install.sh will happily replace a system Node 20
# with a private 22.x runtime, but this check is what stops an override such as
# OPEN_MT2_NODE=/usr/bin/node from picking the old one back up, so a launch here
# on 20 would otherwise fail later inside Node instead of at the launcher.
OPEN_MT2_MIN_NODE_MAJOR=22

open_mt2_resolve_node() {
    if [ -n "${OPEN_MT2_NODE:-}" ]; then
        if [ ! -x "$OPEN_MT2_NODE" ]; then
            echo "open-mt2: OPEN_MT2_NODE is set to '$OPEN_MT2_NODE' which is not executable" >&2
            exit 1
        fi
        printf '%s' "$OPEN_MT2_NODE"
        return 0
    fi

    if [ -x "$OPEN_MT2_HOME/runtime/bin/node" ]; then
        printf '%s' "$OPEN_MT2_HOME/runtime/bin/node"
        return 0
    fi

    if command -v node >/dev/null 2>&1; then
        command -v node
        return 0
    fi

    cat >&2 <<'EOF'
open-mt2: no Node.js runtime found.

Install Node.js 22 or newer, for example:
  sudo apt-get install -y nodejs
or re-run install.sh, which downloads a private runtime into
/opt/open-mt2/runtime when the system one is missing or too old.
EOF
    exit 1
}

open_mt2_check_node_version() {
    node_bin=$1
    node_major=$("$node_bin" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    if [ "$node_major" -lt "$OPEN_MT2_MIN_NODE_MAJOR" ]; then
        echo "open-mt2: Node.js $OPEN_MT2_MIN_NODE_MAJOR+ is required, found $("$node_bin" --version) at $node_bin" >&2
        exit 1
    fi
}

# Echoes the arguments that should precede the entry script.
# `--env-file` only exists on Node >= 20.6 and errors out when the file is
# missing, so it is added conditionally; systemd injects the same variables via
# EnvironmentFile anyway.
open_mt2_node_args() {
    node_bin=$1
    env_file=${OPEN_MT2_ENV_FILE:-$OPEN_MT2_HOME/etc/open-mt2.env}

    if [ -n "${OPEN_MT2_EXTRA_NODE_ARGS:-}" ]; then
        # shellcheck disable=SC2086
        printf -- '--env-file=%s %s' "$env_file" "$OPEN_MT2_EXTRA_NODE_ARGS"
        return 0
    fi

    if [ -r "$env_file" ] && [ "$("$node_bin" -p 'process.versions.node.split(".").map(Number).join(".") >= 20.6' 2>/dev/null)" = "true" ]; then
        printf -- '--env-file=%s' "$env_file"
    fi
}

open_mt2_run() {
    entry=$1
    shift

    node_bin=$(open_mt2_resolve_node)
    open_mt2_check_node_version "$node_bin"

    if [ ! -f "$entry" ]; then
        echo "open-mt2: compiled entry point not found: $entry" >&2
        echo "open-mt2: the installation looks incomplete, re-run install.sh" >&2
        exit 1
    fi

    cd "$OPEN_MT2_HOME"

    # shellcheck disable=SC2046
    exec "$node_bin" $(open_mt2_node_args "$node_bin") "$entry" "$@"
}