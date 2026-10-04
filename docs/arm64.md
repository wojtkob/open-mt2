# Running Open MT2 on ARM64 (Pine A64, Raspberry Pi, Ampere, Graviton)

Open MT2 is written in TypeScript and compiled to plain JavaScript. Every
runtime dependency (`awilix`, `bcryptjs`, `cross-env`, `mysql2`, `redis`,
`reflect-metadata`, `winston`) is pure JavaScript — there is **no native module,
no `node-gyp` step and no compiler requirement**. The same `dist/` tree
therefore runs unmodified on `linux/arm64`, `linux/amd64` and `linux/arm/v7`.

This guide covers the three ways to deploy on ARM64:

| Method | Best for | Notes |
| --- | --- | --- |
| [Release tarball / `.deb`](#1-install-from-a-release-package) | A board dedicated to the server | Recommended. Installs to `/opt/open-mt2` and registers two systemd services. |
| [Docker Compose](#2-docker-compose) | Boards that already run Docker, or you want the MySQL/Redis containers too | `docker-compose.arm64.yml` pins `linux/arm64`. |
| [From source](#3-run-from-source) | Developing on the board itself | Needs the full dev dependency tree. |

Hardware notes for a Pine A64 class board (quad-core Cortex-A53, 2 GB):

- Give the board at least **2 GB of RAM**. Add 2 GB of swap if the game server
  is killed by the OOM killer.
- The game server holds the whole world in memory. Start it with a heap cap
  below the container/system limit so V8 collects before the kernel kills the
  process: `--max-old-space-size=1024`.
- Use an SD card of class 10 or better, or an external SSD; MySQL's InnoDB on a
  slow card will dominate your latency.
- Run MySQL/MariaDB and Redis **on the same board** for a private server, or
  point `DB_HOST`/`CACHE_HOST` at another host.

## 0. What changed for ARM64

- `src/core/infra/config/ResourcePaths.ts` resolves every data directory from
  the module's own location (`__dirname`) instead of `process.cwd()`, with the
  `OPEN_MT2_DATA_DIR` environment variable as an override. The server can
  therefore live in `/opt/open-mt2`, in a renamed directory, or inside a
  container, and still find its map attributes, spawn data, quest scripts and
  SQL bootstrap.
- `npm run build` now also copies the runtime assets into `dist/`
  (`tools/build/copyRuntimeAssets.js`), so a build output is self-contained and
  relocatable.
- `npm run migrate` no longer runs from `tools/` (which is not compiled): it
  moved to `src/tools/database/migrate.ts`, compiled to
  `dist/tools/database/migrate.js`, and the production launcher is
  `bin/open-mt2-migrate` (`npm run migrate:prod`).
- The Dockerfile no longer needs `tsconfig-paths` at runtime — `tsc-alias`
  rewrites every `@/...` import during the build — and it ships the *complete*
  `dist/` tree plus the map/spawn data.
- The database image changed from `mysql:5.7` (which publishes **no** arm64
  manifest) to `mysql:8.0`, and the cache image to `redis:7-alpine`. Both
  publish `linux/arm64v8`. Override with `DB_IMAGE=mariadb:11` or
  `CACHE_IMAGE=redis:7-alpine` as needed.
- `docker-compose.yml`, `docker-compose.arm64.yml` and `docker-compose.dep.yml`
  no longer pin `version:` (obsolete in Compose v2) and take the image tags from
  `DB_IMAGE` / `CACHE_IMAGE` / `OPEN_MT2_IMAGE`.

## 1. Install from a release package

### 1.1 Get the package

From a GitHub release, or build it yourself on any machine:

```bash
npm ci --ignore-scripts
npm run package          # writes build/release/
```

`npm run package` produces:

```
build/release/
├── open-mt2-<version>-linux-arm64.tar.gz   # universal installer
├── open-mt2_<version>_arm64.deb            # dpkg -i package
├── SHA256SUMS                              # checksums
└── open-mt2-<version>/                     # the staging tree, for inspection
```

The tarball is architecture independent, so `open-mt2-<version>-linux-amd64.tar.gz`
and `open-mt2-<version>-linux-arm64.tar.gz` contain identical code. Verify it
before trusting it:

```bash
sha256sum -c SHA256SUMS
```

`node tools/package/verifyRelease.js --arch arm64` re-opens the archive and
checks that every entry point, launcher and data file is present and
executable — the same check the CI runs before publishing.

### 1.2 Prepare the system

```bash
sudo apt-get update
sudo apt-get install -y mariadb-server redis-server    # or use Docker, see below
```

On Armbian the equivalent packages are `mariadb-server` and `redis-server`.
Armbian ships Node.js 20+ as `nodejs`, but many images ship an older major
version; see [1.9 Node runtime](#19-node-runtime) if `node --version` is below 20.

### 1.3 Install from the tarball

```bash
tar -xzf open-mt2-<version>-linux-arm64.tar.gz
cd open-mt2-<version>
sudo ./scripts/install.sh
```

The installer:

1. creates the system user/group `open-mt2`;
2. copies `bin/`, `dist/`, `node_modules/`, `deploy/`, `scripts/`, `etc/` and
   the docs into `/opt/open-mt2`;
3. uses the system Node.js when it is new enough, otherwise downloads a private
   runtime into `/opt/open-mt2/runtime`;
4. seeds `/etc/open-mt2/env` from `etc/open-mt2.env.example`;
5. installs and enables `open-mt2-auth.service` and `open-mt2-game.service`.

Useful overrides:

```bash
# Install somewhere else, with a different service account and starting now.
sudo PREFIX=/srv/open-mt2 OPEN_MT2_USER=mt2 OPEN_MT2_AUTOSTART=1 ./scripts/install.sh

# Never download a private Node runtime (fail instead if Node < 20).
sudo OPEN_MT2_SKIP_NODE_DOWNLOAD=1 ./scripts/install.sh
```

### 1.4 Install from the `.deb`

```bash
sudo dpkg -i open-mt2_<version>_arm64.deb
```

The `postinst` maintainer script delegates to the very same
`/opt/open-mt2/scripts/install.sh`, so `dpkg` and a manual install converge on
one configuration. Check the result with `dpkg -l open-mt2` and
`systemctl status open-mt2-auth`.

> `dpkg -i` does not install `Suggests`. Install `mariadb-server` and
> `redis-server` yourself, or point the config at existing hosts.

### 1.5 Configure

```bash
sudo nano /etc/open-mt2/env
```

At a minimum set:

```ini
AUTH_SERVER_ADDRESS=0.0.0.0     # reachable by the client
GAME_SERVER_ADDRESS=0.0.0.0
REAL_SERVER_ADDRESS=192.168.1.50  # the address the CLIENT will dial
DB_HOST=127.0.0.1
DB_USER=root
DB_ROOT_PASSWORD=<your password>
SEED_ADMIN_PASSWORD=<something other than admin>
```

### 1.6 Create the databases

```bash
OPEN_MT2_ENV_FILE=/etc/open-mt2/env /opt/open-mt2/bin/open-mt2-migrate
```

> The bootstrap script **drops and recreates** the `auth` and `game` databases.
> Never run it automatically during an upgrade.

### 1.7 Run

```bash
sudo systemctl start open-mt2-auth open-mt2-game
sudo systemctl status open-mt2-auth open-mt2-game
sudo journalctl -u open-mt2-auth -u open-mt2-game -f
```

Without systemd, run the launchers directly:

```bash
/opt/open-mt2/bin/open-mt2-auth
/opt/open-mt2/bin/open-mt2-game
```

The launchers pick the Node runtime in this order: `$OPEN_MT2_NODE`,
`$OPEN_MT2_HOME/runtime/bin/node`, then `node` from `PATH`, and they refuse to
start on Node < 20.

### 1.8 Upgrade / uninstall

```bash
# Upgrade: replace the prefix, keep /etc/open-mt2/env, then reinstall the units.
sudo rm -rf /opt/open-mt2
sudo tar -xzpf open-mt2-<version>-linux-arm64.tar.gz -C /tmp
sudo /tmp/open-mt2-<version>/scripts/install.sh
sudo systemctl restart open-mt2-auth open-mt2-game

# Uninstall (keeps /etc/open-mt2/env unless you pass --purge).
sudo /opt/open-mt2/scripts/uninstall.sh
```

### 1.9 Node runtime

The installer accepts a system Node.js >= 20. If the board has an older one, it
downloads a private ARM64 runtime:

```bash
sudo /opt/open-mt2/scripts/install-node.sh          # honours OPEN_MT2_ARCH
sudo /opt/open-mt2/scripts/install-node.sh --force  # replace an existing runtime
```

Set `OPEN_MT2_ARCH=aarch64` to pin the architecture, and `OPEN_MT2_NODE` to
point the launchers at a specific binary.

## 2. Docker Compose

`docker-compose.arm64.yml` is self-contained: copy it to the board together
with `.env` and run it.

```bash
cp .env.example .env && $EDITOR .env
docker compose -f docker-compose.arm64.yml up -d
docker compose -f docker-compose.arm64.yml ps
docker compose -f docker-compose.arm64.yml logs -f game-server
```

It pins `platform: linux/arm64` on every service, so the same file works on a
Pine A64 and on an amd64 workstation running the ARM64 image through QEMU.
Relevant knobs:

```bash
DB_IMAGE=mariadb:11 docker compose -f docker-compose.arm64.yml up -d
CACHE_IMAGE=redis:7-alpine docker compose -f docker-compose.arm64.yml up -d
OPEN_MT2_IMAGE=ghcr.io/wojtkob/open-mt2:1.0.0 \
  OPEN_MT2_PULL_POLICY=always \
  docker compose -f docker-compose.arm64.yml up -d
```

Run the migration inside a container:

```bash
docker compose -f docker-compose.arm64.yml run --rm auth node dist/tools/database/migrate.js
```

## 3. Run from source

Building on the board itself needs the dev dependency tree (~500 MB) and takes a
few minutes on a Pine A64 — a cross-build elsewhere is much faster.

```bash
sudo apt-get install -y git build-essential python3
git clone https://github.com/wojtkob/open-mt2.git
cd open-mt2
npm ci --ignore-scripts
cp .env.example .env && $EDITOR .env
npm run build
npm run migrate
npm run auth            # dist/auth/main.js
npm run game            # dist/game/main.js
```

`npm run dev:auth` / `npm run dev:game` (ts-node-dev with reload) are also
available but noticeably slower on ARM.

## 4. Troubleshooting

**`[RESOURCE_PATHS] Unable to locate the "spawn" data directory`**
The compiled tree lost its data files. Either run `npm run build` (which copies
them into `dist/`), or point `OPEN_MT2_DATA_DIR` at a directory that contains
`core/infra/config/data/spawn`, `core/infra/config/data/attr`,
`core/domain/quests/quests` and `core/infra/database/scripts`. The error lists
every path that was probed.

**`Cannot find module '@/...'`**
A stale `dist/` produced without `tsc-alias`. Run `npm run build:clean` and
rebuild; never start the compiled server with `-r tsconfig-paths/register`
(that package is a devDependency and is not shipped).

**`open-mt2: Node.js 20+ is required, found v18...`**
Install Node 20+ system-wide, or run `sudo /opt/open-mt2/scripts/install-node.sh`.

**`mysql: no matching manifest for linux/arm64`**
A leftover `mysql:5.7` reference. Use `mysql:8.0`, `mysql:8.4`, `mariadb:11` or
the native `mariadb-server` package.

**`exec format error` while running a container**
The image was pulled for the wrong architecture. Remove it and pull again, or
add `platform: linux/arm64` (already set in `docker-compose.arm64.yml`).

**The game server is OOM-killed**
Lower `--max-old-space-size`, add swap, or reduce the container memory limit.
`docker inspect game-server --format '{{.State.OOMKilled}}'` confirms it.

**`systemctl start` fails with status 203/EXEC**
The launcher lost its executable bit (e.g. the package was extracted by a tool
that ignores modes). Run `chmod +x /opt/open-mt2/bin/open-mt2-* /opt/open-mt2/scripts/*.sh`.

## 5. Continuous integration

### The gate — `.github/workflows/flow.yml`

Runs on every pull request and every push to `master`:

- **quality** — `format:check` and `lint` (both read-only; they never rewrite
  files), a full build, and the unit test suite with coverage;
- **package** — builds and verifies the ARM64 artefacts, so a broken tarball or
  `.deb` fails the gate instead of the publish step.

### The release — `.github/workflows/release.yml`

Publishes automatically once a build is green. It is triggered by a successful
`workflow_run` of the CI Pipeline on `master`, and also by a `v*` tag, a nightly
`schedule` and `workflow_dispatch`.

A **gate** job runs first and refuses to publish a red or forked build, then
classifies the run as either the rolling `autobuild` prerelease or an immutable
semver release. Every job builds the exact commit the CI run tested.

- **build** — compiles and produces + verifies the amd64 package;
- **arm64** — the same build, the unit test suite and the package verification
  on a **native `ubuntu-24.04-arm` runner**, plus a relocability smoke test that
  extracts the tarball, renames the prefix and resolves the data trees from an
  unrelated working directory. **This job gates publication**: a release is
  never published from an artefact set the ARM64 job did not verify;
- **docker** — `buildx` + QEMU builds `linux/amd64` and `linux/arm64` and pushes
  the manifest to GHCR under the `latest`, `autobuild`, version and prerelease
  tags; the arm64 variant is booted under QEMU and its entry points are
  executed. The manifest omits `linux/arm/v7` because GitHub's runners cannot
  emulate armv7 (`tonistiigi/binfmt` rejects it), which fails the build with
  `exec format error`. On an armv7 board, build the image locally with
  `docker build .` — the tarball and `.deb` work on armv7 regardless;
- **release** — publishes the tarballs, the `.deb`s and `SHA256SUMS` as a
  GitHub release. A semver tag becomes the *Latest* release; `autobuild` is a
  prerelease, is pinned to the exact commit it was built from, and has its
  superseded assets pruned on every run so it never grows without bound.

### Installing the autobuild

The rolling release is what a Pine A64 user installs:

```sh
VERSION=autobuild
wget "https://github.com/wojtkob/open-mt2/releases/download/$VERSION/open-mt2-<version>-linux-arm64.tar.gz"
tar -xzf "open-mt2-<version>-linux-arm64.tar.gz"
cd "open-mt2-<version>"
sudo ./scripts/install.sh
```

`<version>` is the version on the release page. The filename keeps the
`package.json` version even under the `autobuild` tag, because the version is
baked into the artefacts at build time.

`SHA256SUMS` is published next to the artefacts for verification:

```sh
sha256sum --check --ignore-missing --strict SHA256SUMS
```

`--ignore-missing` is needed because that one file lists every artefact in the
release — the amd64 package too — while you only downloaded the ARM64 one.
Without it, `sha256sum` reports `FAILED open or read` for the files you did not
download and exits non-zero even though the tarball you have is intact.

Download the amd64 artefacts as well and drop the flag if you want a strict
check of the whole set.

For a fixed version, cut a `v<version>` tag. The tag must match the
`package.json` version or the run is rejected, which stops a tag from
advertising a release that was never built.