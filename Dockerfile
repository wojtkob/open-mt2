# syntax=docker/dockerfile:1
#
# Open MT2 server image.
#
# The image is architecture independent: every runtime dependency is pure
# JavaScript, so the exact same layers build and run on `linux/amd64`,
# `linux/arm64` (Pine A64, Raspberry Pi 4/5, Ampere, Graviton) and `linux/arm/v7`.
# Build the multi-arch manifest with:
#
#   docker buildx build --platform linux/amd64,linux/arm64,linux/arm/v7 \
#       -t ghcr.io/willianmarquess/open-mt2:latest --push .
#
# Both servers live in one image; the role is selected by the command, so a
# deployment only needs a single image (auth, game) plus its own database and
# cache containers. See `docker-compose.arm64.yml` for a Pine A64 deployment.

# --------------------------------------------------------------------- builder
FROM node:22-bookworm-slim AS builder

WORKDIR /usr/src/open-mt2

# `bcryptjs` and `mysql2` are the only non-trivial runtime dependencies and both
# ship prebuilt JS fallbacks, so no compiler or native toolchain is needed for
# any of the supported architectures.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY tools ./tools
COPY src ./src

# `npm run build` = tsc + tsc-alias + copyRuntimeAssets. The last step copies the
# map attributes, the spawn data and the SQL bootstrap into `dist/`, which is
# what makes `dist/` self-contained and relocatable (see ResourcePaths).
RUN npm run build \
    && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

# --------------------------------------------------------------------- runtime
FROM node:22-bookworm-slim AS runtime

# Same layout as the release tarball / .deb, so paths, launchers and docs are
# identical whether the server runs from Docker or from /opt/open-mt2 on Armbian.
ENV NODE_ENV=production \
    OPEN_MT2_HOME=/opt/open-mt2 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /opt/open-mt2

RUN groupadd --system --gid 10001 open-mt2 \
    && useradd --system --uid 10001 --gid 10001 --home-dir /opt/open-mt2 \
       --shell /usr/sbin/nologin open-mt2

COPY --from=builder --chown=root:root /usr/src/open-mt2/dist ./dist
COPY --from=builder --chown=root:root /usr/src/open-mt2/node_modules ./node_modules
COPY --from=builder --chown=root:root /usr/src/open-mt2/package.json /usr/src/open-mt2/package-lock.json ./

# The launchers, installers, systemd units, docs and the example env file travel
# with the image, so the layout inside a container is the same as inside a
# release tarball: `docker compose exec game node dist/game/main.js` and
# `docker compose exec auth /opt/open-mt2/bin/open-mt2-migrate` both work.
COPY --chown=root:root deploy/launcher ./bin
COPY --chown=root:root deploy/scripts ./scripts
COPY --chown=root:root deploy/systemd ./deploy/systemd
COPY --chown=root:root .env.example ./etc/open-mt2.env.example
COPY --chown=root:root docs ./docs
COPY --chown=root:root README.md LICENSE ./

RUN chmod +x /opt/open-mt2/bin/open-mt2-* /opt/open-mt2/scripts/*.sh \
    && chown -R open-mt2:open-mt2 /opt/open-mt2/etc \
    && mkdir -p /opt/open-mt2/logs \
    && chown open-mt2:open-mt2 /opt/open-mt2/logs

USER open-mt2

# The Metin2 protocol has no HTTP endpoint, so readiness is "the TCP port
# accepts a connection". AUTH_SERVER_PORT / GAME_SERVER_PORT decide which one,
# which keeps a single healthcheck valid for both roles.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD node -e "const net=require('node:net');const port=Number(process.env.AUTH_SERVER_PORT||process.env.GAME_SERVER_PORT||0);if(!port)process.exit(1);const socket=net.connect({host:'127.0.0.1',port},()=>{socket.end();process.exit(0)});socket.on('error',()=>process.exit(1));socket.setTimeout(4000,()=>{socket.destroy();process.exit(1)})"

# No `-r tsconfig-paths/register`: `tsc-alias` already rewrote every `@/`
# import inside `dist/`, and `tsconfig-paths` is a dev-only dependency.
CMD ["node", "dist/auth/main.js"]