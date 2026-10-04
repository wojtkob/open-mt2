# open-mt2

A Node.js + TypeScript rewrite of the Metin2 MMORPG server, originally written in C++. Hobby/study project — it does not aim for strict fidelity to the original game behavior.

## Architecture: two servers

The original client (TMP4) was already built for multiple servers: before entering the world, it asks the **auth server** which IP/port of the **game server** it should connect to. Because of that, the project is split into two independent processes:

- `src/auth` — authentication (login, character select/create/delete, initial handshake). Has its own `main.ts` + `Container.ts`.
- `src/game` — the game world (movement, combat, skills, quests, commands, shops). Has its own `main.ts` + `Container.ts`.
- `src/core` — code shared by both: domain entities, packets, enums, network utilities (buffer reader/writer), managers.

Run both with `npm run dev:auth` and `npm run dev:game` (see [docs/guide.md](docs/guide.md) for full setup with Docker/migrations).

## Layers inside each server

Each of `src/{auth,game}` follows the same split:

- `domain/` — pure business rules (entities, managers, services, commands, quests). Should not depend on concrete infrastructure.
- `interface/` — entry/exit points: network packets (parse/serialize), handlers that translate a packet into a domain call.
- `infra/` — concrete implementations (repositories backed by MySQL, Redis cache, etc.).
- `app/` — high-level orchestration (e.g. `CommandManager` in the game server).

## Dependency injection (awilix)

Each server has a `Container.ts` that calls [awilix](https://github.com/jeffijoe/awilix)'s `createContainer()` and registers everything into a single object:

```ts
container.register({
  logger: asClass(WinstonLoggerAdapter).singleton(),
  entityManager: asClass(EntityManager).singleton(),
  packets: asFunction(makePackets).singleton(),
  commands: asFunction(Commands).singleton(),
  ...
});
```

- `asClass(SomeClass).singleton()` for classes whose constructor receives `{ dep1, dep2 }` — destructured from the cradle **by the registered property name**, not the class name.
- `asFunction(factory).singleton()` for values built by a factory function (e.g. packet/command maps).
- `asValue(value)` for fixed values (e.g. the container itself, injected into whatever needs to resolve dependencies dynamically).

**Any new service/class that needs to be injected into a handler must be registered in the `Container.ts` of the corresponding server** (`src/auth/Container.ts` or `src/game/Container.ts`) — an easy step to forget.

## Common contribution workflows

The most repetitive workflows in the project have dedicated skills under `.claude/skills/`, invokable with `/skill-name`:

- **[add-packet](.claude/skills/add-packet/SKILL.md)** — create a new network packet (IN or OUT), register it, and document it.
- **[add-command](.claude/skills/add-command/SKILL.md)** — create a new chat command (`/something`) in the game server.
- **[add-quest](.claude/skills/add-quest/SKILL.md)** — create a new quest using the `@Quest`/`@Task` decorators.
- **[testing-conventions](.claude/skills/testing-conventions/SKILL.md)** — unit and integration test conventions.

Use these skills when working on those flows — they describe the exact order of steps and where a registration step is easy to forget (e.g. a packet created but never registered in `Packets.ts`).

## Build, packaging and deployment

- `npm run build` — `tsc` + `tsc-alias` (rewrites every `@/` import to a relative path, which is why the compiled server never needs `tsconfig-paths/register`) + `tools/build/copyRuntimeAssets.js`, which copies the map attributes, spawn data and SQL bootstrap into `dist/`.
- `npm run package` — `tools/package/buildRelease.js` stages a runtime tree (`dist`, production `node_modules`, launchers, systemd units, installers, docs) and emits a `.tar.gz`, a `.deb` and `SHA256SUMS` into `build/release/`. The tar and `ar` writers are dependency-free pure Node (`tools/package/tarWriter.js`, `arWriter.js`) so the release build runs on any host with Node, including Windows.
- `npm run package:verify` — `tools/package/verifyRelease.js` re-opens the artefacts as `tar`/`dpkg` would and asserts every entry point, data file, executable bit and `md5sums` entry is present. CI runs this before publishing anything.
- `src/core/infra/config/ResourcePaths.ts` is the single source of truth for data locations (`__dirname`-relative, with `OPEN_MT2_DATA_DIR` as an override). Never reintroduce `process.cwd()` for reading `attr`, `spawn`, quest scripts or the SQL bootstrap — it breaks every install that is not run from the repository root.
- `deploy/` holds the shell/systemd/debian packaging assets. `deploy/scripts/install.sh` is the single installer; the `.deb` `postinst` delegates to it so both paths converge.
- `.github/workflows/flow.yml` is the read-only gate (`format:check`, `lint`, build, tests, plus a job that builds and verifies the ARM64 artefacts). Never switch it back to `format`/`lint:fix`: those rewrite files, so CI would report success on a commit other than the one being merged.
- `.github/workflows/release.yml` publishes automatically off a successful `workflow_run` of that gate on `master` (also on `v*` tags, a nightly `schedule` and `workflow_dispatch`). A `gate` job rejects red/forked CI runs and classifies the run as the rolling `autobuild` prerelease or an immutable semver release. It builds and tests on a native `ubuntu-24.04-arm` runner — which gates publication — and pushes an `amd64`/`arm64` image to GHCR. The manifest omits `arm/v7` because the runner's `tonistiigi/binfmt` cannot emulate armv7.

## Existing documentation

- [docs/guide.md](docs/guide.md) — local setup (client, Docker, migrations, running the servers) and the deployment targets.
- [docs/arm64.md](docs/arm64.md) — ARM64/Pine A64 install (release package, systemd, Docker Compose, from source) and troubleshooting.
- [docs/packets.md](docs/packets.md) — auto-generated by `npm run generate:doc` from `@packet` JSDoc blocks on OUT packets. **Do not edit this file by hand** — edit the JSDoc on the packet and rerun the generator.
- [docs/quests.md](docs/quests.md) — quest system conventions (decorators, contexts, helpers).
- `README.md` — list of chat commands (`## Commands`), maintained manually.

## Tests

- `npm run test:unit` — unit tests (mocha + chai + sinon), fast, no external infrastructure.
- `npm run test:integration` — spin up a real server in-process; require MySQL + Redis (`npm run docker:dep`) and the game port to be free.
- `npm run test:coverage` — coverage via `c8`.

See the `testing-conventions` skill for the pattern used by each test type.
