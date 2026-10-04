## Requirements

- **TMP4 client** (40k client)
- **Node.js** (version 20 or higher)
- **Docker**

## Setup Client

Open serverinfo.py file and update the variables:

```python
SERVER_NAME			= "Open MT2 Server"
SERVER_IP			= "localhost"
CH1_NAME			= "CH1"
PORT_1				= 13001
PORT_AUTH			= 11002
PORT_MARK			= 13001
```

ps: If you changed the ports in the .env, put the relative values ​​here

## Run

- Install dependencies
```bash
npm install
```
- Setup .env file (you can use .env.example as example)
- Execute this command on terminal:
```bash
npm run docker:dep
```
- Execute migration command:
```bash
npm run migrate
```
- Run the auth server
```bash
npm run dev:auth
```
- Run the game server
```bash
npm run dev:game
```
ps: `npm run dev:auth:debug` / `npm run dev:game:debug` run the same servers with `LOG_LEVEL=debug` — useful when investigating, since many rejection paths only log at debug level.
- Open mt2 client and use these values for login and password:
```bash
login: admin
password: admin
```

## Production build and deployment

The development workflow above runs TypeScript directly through `ts-node`. For a real
server, compile first and run the plain JavaScript — the build output is
self-contained and relocatable, so it works from `/opt/open-mt2`, from a renamed
directory or from inside a container.

```bash
npm run build              # tsc + tsc-alias + copy of the map/spawn/quest data into dist/
npm run package            # release artefacts in build/release/
npm run package:verify     # re-open them and check every entry point
```

Then pick one of the deployment targets:

| Target | Command | Guide |
| --- | --- | --- |
| ARM64 / Pine A64 (systemd) | `sudo ./scripts/install.sh` | [arm64.md](arm64.md) |
| Docker (any architecture) | `docker compose -f docker-compose.yml up -d` | [arm64.md](arm64.md#2-docker-compose) |
| ARM64 Docker (pinned to `linux/arm64`) | `docker compose -f docker-compose.arm64.yml up -d` | [arm64.md](arm64.md#2-docker-compose) |
| Manually | `node dist/auth/main.js` and `node dist/game/main.js` | — |

`dist/tools/database/migrate.js` is the production migration CLI (same script as
`npm run migrate`, compiled); `bin/open-mt2-migrate` wraps it with the
`/etc/open-mt2/env` configuration file.

> The database image defaults to `mysql:8.0` because `mysql:5.7` publishes no
> `linux/arm64` manifest. Override with `DB_IMAGE=mariadb:11` (also arm64v8) if you
> prefer MariaDB, which is what Armbian ships natively.