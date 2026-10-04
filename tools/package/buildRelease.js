#!/usr/bin/env node
/**
 * Builds the installable Open MT2 release artefacts.
 *
 * Outputs (under `build/release/`):
 *   open-mt2-<version>-linux-<arch>.tar.gz   universal installable archive
 *   open-mt2_<version>_<arch>.deb            `dpkg -i` package for Armbian/Debian
 *   SHA256SUMS                               checksums for every artefact
 *   open-mt2-<version>/                      the staging tree, for inspection
 *
 * The server has **no native dependencies** — every runtime dependency is
 * pure JavaScript — so a single archive runs unmodified on aarch64 (Pine A64),
 * x86_64 and armv7l. The `--arch` flag therefore only affects the artefact
 * names and the `Architecture:` field of the .deb.
 *
 * Usage:
 *   npm run package                       # builds dist/ first, then packages
 *   node tools/package/buildRelease.js     # packages whatever is in dist/
 *   node tools/package/buildRelease.js --arch amd64 --no-deb
 */
'use strict';

const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const { createTarArchive } = require('./tarWriter');
const { createArArchive } = require('./arWriter');

const projectRoot = path.resolve(__dirname, '..', '..');
const pkg = require(path.join(projectRoot, 'package.json'));

const DEFAULT_PREFIX = '/opt/open-mt2';

/**
 * Project home, taken from `package.json#repository` when it declares one so the
 * metadata baked into the .deb never drifts from the repo it was built from.
 */
const PROJECT_URL = resolveProjectUrl(pkg);

/**
 * `package.json#repository` may be a plain URL string or the `{ type, url }`
 * object npm documents; both are accepted, and `git+https://` prefixes are
 * stripped so the value is usable as a `Homepage:` field.
 */
function resolveProjectUrl(packageJson) {
    const fallback = 'https://github.com/wojtkob/open-mt2';
    const declared =
        typeof packageJson.repository === 'string' ? packageJson.repository : packageJson.repository?.url;

    if (typeof declared !== 'string' || !declared.startsWith('http')) {
        return fallback;
    }

    return declared.replace(/^(?:git\+)?/, '').replace(/\.git$/, '');
}

// --------------------------------------------------------------------- options

function parseArgs(argv) {
    const options = {
        version: pkg.version,
        arch: 'arm64',
        outDir: path.join(projectRoot, 'build', 'release'),
        build: false,
        deb: true,
        productionInstall: true,
        sourceMaps: true,
        clean: true,
        debMaintainer: 'Open MT2 maintainers <open-mt2@example.invalid>',
        debDescription:
            'Metin2 server emulator (authentication + game server), Node.js/TypeScript.\n' +
            ' Runs on ARM64 boards such as the Pine A64 under Armbian.',
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = () => {
            const value = argv[i + 1];
            if (value === undefined) throw new Error(`Missing value for ${arg}`);
            i += 1;
            return value;
        };

        switch (arg) {
            case '--version':
                options.version = next();
                break;
            case '--arch':
                options.arch = next();
                break;
            case '--out':
                options.outDir = path.resolve(next());
                break;
            case '--maintainer':
                options.debMaintainer = next();
                break;
            case '--no-deb':
                options.deb = false;
                break;
            case '--no-source-maps':
                options.sourceMaps = false;
                break;
            case '--skip-install':
                options.productionInstall = false;
                break;
            case '--no-clean':
                options.clean = false;
                break;
            case '--build':
                options.build = true;
                break;
            case '-h':
            case '--help':
                printUsage();
                process.exit(0);
                break;
            default:
                throw new Error(`Unknown option: ${arg}`);
        }
    }

    return options;
}

function printUsage() {
    console.log(
        [
            'Usage: node tools/package/buildRelease.js [options]',
            '',
            '  --version <v>      release version (default: package.json version)',
            '  --arch <name>      arm64 | amd64 | armv7l | universal (default: arm64)',
            '  --out <dir>        output directory (default: build/release)',
            '  --maintainer <s>   Debian Maintainer field',
            '  --build            run `npm run build` before packaging',
            '  --no-deb           skip the .deb artefact',
            '  --no-source-maps   strip *.js.map from the package',
            '  --skip-install     reuse the staged node_modules instead of reinstalling',
            '  --no-clean         keep a previous staging tree',
        ].join('\n'),
    );
}

// -------------------------------------------------------------------- helpers

function log(message) {
    console.log(`[package] ${message}`);
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        stdio: options.quiet ? 'pipe' : 'inherit',
        cwd: options.cwd ?? projectRoot,
        shell: process.platform === 'win32',
        encoding: 'utf8',
    });

    if (result.error) throw new Error(`${command} failed to start: ${result.error.message}`);
    if (result.status !== 0) {
        const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
        throw new Error(`${command} exited with code ${result.status}\n${output}`);
    }

    return result.stdout ?? '';
}

function copyRecursive(source, target) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const from = path.join(source, entry.name);
        const to = path.join(target, entry.name);

        if (entry.isDirectory()) {
            copyRecursive(from, to);
        } else if (entry.isSymbolicLink()) {
            fs.symlinkSync(fs.readlinkSync(from), to);
        } else if (entry.isFile()) {
            fs.copyFileSync(from, to);
            const mode = fs.statSync(from).mode;
            fs.chmodSync(to, mode & 0o777);
        }
    }
}

function walkFiles(root, relativeTo = '') {
    const results = [];

    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const absolute = path.join(root, entry.name);
        const relative = `${relativeTo}${entry.name}`;

        if (entry.isDirectory()) {
            results.push(...walkFiles(absolute, `${relative}/`));
        } else if (entry.isFile()) {
            results.push(relative);
        }
    }

    return results.sort();
}

function walkDirectories(root, relativeTo = '') {
    const results = [];

    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const relative = `${relativeTo}${entry.name}`;
        results.push(relative);
        results.push(...walkDirectories(path.join(root, entry.name), `${relative}/`));
    }

    return results.sort();
}

function sha256(buffer) {
    return nodeCrypto.createHash('sha256').update(buffer).digest('hex');
}

function md5(buffer) {
    return nodeCrypto.createHash('md5').update(buffer).digest('hex');
}

function gzip(buffer) {
    return zlib.gzipSync(buffer, { level: 9 });
}

// -------------------------------------------------------------- dist validation

function validateDist(distDir) {
    const errors = [];

    const requireFile = (relative, description) => {
        if (!fs.existsSync(path.join(distDir, relative))) errors.push(`${description} (dist/${relative})`);
    };
    const requireCount = (relative, minimum, description) => {
        const absolute = path.join(distDir, relative);
        const count = fs.existsSync(absolute)
            ? fs.readdirSync(absolute).filter((f) => !f.endsWith('.map')).length
            : 0;
        if (count < minimum) errors.push(`${description} (at least ${minimum} under dist/${relative})`);
    };

    requireFile('auth/main.js', 'compiled auth entry point');
    requireFile('game/main.js', 'compiled game entry point');
    requireFile('tools/database/migrate.js', 'compiled migration entry point');
    requireFile('core/infra/database/scripts/script.sql', 'database bootstrap script');
    requireCount('core/domain/quests/quests', 1, 'compiled quest definitions');
    requireCount('core/infra/config/data/attr', 1, 'map attribute files');
    requireCount('core/infra/config/data/spawn', 1, 'spawn data directories');

    // `tsc-alias` must have rewritten every `@/...` specifier, otherwise the
    // package would depend on the removed tsconfig-paths runtime hook.
    const leaked = [];
    for (const relative of walkFiles(distDir)) {
        if (!relative.endsWith('.js')) continue;
        const contents = fs.readFileSync(path.join(distDir, relative), 'utf8');
        if (/require\("@\//.test(contents) || /from "@\//.test(contents)) {
            leaked.push(relative);
        }
    }
    if (leaked.length > 0) {
        errors.push(`unresolved "@/" path aliases in: ${leaked.slice(0, 5).join(', ')}`);
    }

    if (errors.length > 0) {
        throw new Error(
            `dist/ is not a runnable build:\n  - ${errors.join('\n  - ')}\nRun \`npm run build\` first.`,
        );
    }
}

// ------------------------------------------------------------------- packaging

/**
 * Paths that must carry the executable bit in the tarball and in the .deb.
 *
 * The mode cannot be derived from the staging tree: NTFS/ext4 metadata read
 * through `fs.statSync` does not round-trip Unix permission bits on Windows,
 * so a package built on a Windows dev box would ship launchers that neither a
 * shell nor systemd can start. Declaring the set explicitly keeps the artefact
 * byte-identical no matter which machine ran the release build.
 */
const EXECUTABLE_PATHS = new Set([
    'bin/common.sh',
    'bin/open-mt2-auth',
    'bin/open-mt2-game',
    'bin/open-mt2-migrate',
    'scripts/install-node.sh',
    'scripts/install.sh',
    'scripts/uninstall.sh',
]);

function buildEntries(stagingDir, rootName) {
    const entries = [];
    const root = `./${rootName}`;

    entries.push({ name: `${root}/`, type: 'directory', mode: 0o755 });

    for (const relative of walkDirectories(stagingDir)) {
        entries.push({ name: `${root}/${relative}`, type: 'directory', mode: 0o755 });
    }

    for (const relative of walkFiles(stagingDir)) {
        entries.push({
            name: `${root}/${relative}`,
            data: fs.readFileSync(path.join(stagingDir, relative)),
            mode: EXECUTABLE_PATHS.has(relative) ? 0o755 : 0o644,
        });
    }

    return entries;
}

function debControl(fields) {
    return `${Object.entries(fields)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n')}\n`;
}

function createDebianPackage({ stagingDir, version, arch, mtime, maintainer, description }) {
    const debName = `open-mt2_${version}_${arch}.deb`;
    const installedSize = walkFiles(stagingDir).reduce(
        (total, relative) => total + fs.statSync(path.join(stagingDir, relative)).size,
        0,
    );

    const control = debControl({
        Package: 'open-mt2',
        Version: version,
        Section: 'games',
        Priority: 'optional',
        Architecture: arch,
        Maintainer: maintainer,
        InstalledSize: Math.max(1, Math.round(installedSize / 1024)),
        Depends: 'libc6, adduser',
        Suggests: 'mariadb-server | mysql-server, redis-server',
        Homepage: PROJECT_URL,
        Description: description,
    });

    const controlEntries = [
        { name: './', type: 'directory', mode: 0o755 },
        { name: './control', data: Buffer.from(control, 'utf8'), mode: 0o644 },
    ];

    const md5sums = walkFiles(stagingDir)
        .map((relative) => `${md5(fs.readFileSync(path.join(stagingDir, relative)))}  ${DEFAULT_PREFIX}/${relative}`)
        .join('\n');
    controlEntries.push({ name: './md5sums', data: Buffer.from(`${md5sums}\n`, 'utf8'), mode: 0o644 });

    for (const script of ['postinst', 'prerm', 'postrm']) {
        const source = path.join(projectRoot, 'deploy', 'debian', script);
        controlEntries.push({
            name: `./${script}`,
            data: fs.readFileSync(source),
            mode: 0o755,
        });
    }

    // data.tar.gz holds absolute-looking paths *without* the leading slash,
    // prefixed by "./" — exactly what `buildEntries` produces for `opt/open-mt2`.
    const dataEntries = buildEntries(stagingDir, DEFAULT_PREFIX.replace(/^\//, ''));

    const deb = createArArchive([
        { name: 'debian-binary', data: Buffer.from('2.0\n', 'ascii'), mode: 0o100644, mtime: 0 },
        {
            name: 'control.tar.gz',
            data: gzip(createTarArchive(controlEntries, { mtime })),
            mode: 0o100644,
            mtime: 0,
        },
        {
            name: 'data.tar.gz',
            data: gzip(createTarArchive(dataEntries, { mtime })),
            mode: 0o100644,
            mtime: 0,
        },
    ]);

    return { debName, deb };
}

// ------------------------------------------------------------------------ main

function stage(stagingDir, options) {
    const distDir = path.join(projectRoot, 'dist');
    validateDist(distDir);

    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });

    log('staging compiled server');
    copyRecursive(distDir, path.join(stagingDir, 'dist'));

    log('staging launchers, systemd units, install scripts and docs');
    copyRecursive(path.join(projectRoot, 'deploy', 'launcher'), path.join(stagingDir, 'bin'));
    copyRecursive(path.join(projectRoot, 'deploy', 'systemd'), path.join(stagingDir, 'deploy', 'systemd'));
    copyRecursive(path.join(projectRoot, 'deploy', 'scripts'), path.join(stagingDir, 'scripts'));
    copyRecursive(path.join(projectRoot, 'docs'), path.join(stagingDir, 'docs'));

    for (const file of ['README.md', 'LICENSE']) {
        const source = path.join(projectRoot, file);
        if (fs.existsSync(source)) fs.copyFileSync(source, path.join(stagingDir, file));
    }

    fs.mkdirSync(path.join(stagingDir, 'etc'), { recursive: true });
    fs.copyFileSync(path.join(projectRoot, '.env.example'), path.join(stagingDir, 'etc', 'open-mt2.env.example'));

    fs.writeFileSync(
        path.join(stagingDir, 'VERSION'),
        `${pkg.version}\n`,
        'utf8',
    );

    // Production package.json: only what is needed to `require()` the tree.
    const runtimePackage = {
        name: 'open-mt2',
        version: pkg.version,
        description: pkg.description || 'Metin2 server emulator',
        license: pkg.license,
        private: true,
        type: 'commonjs',
        main: 'dist/game/main.js',
        dependencies: pkg.dependencies,
        engines: { node: '>=20' },
    };
    fs.writeFileSync(
        path.join(stagingDir, 'package.json'),
        `${JSON.stringify(runtimePackage, null, 4)}\n`,
        'utf8',
    );
    fs.copyFileSync(path.join(projectRoot, 'package-lock.json'), path.join(stagingDir, 'package-lock.json'));

    if (options.productionInstall) {
        log('installing production dependencies (npm ci --omit=dev)');
        run(
            'npm',
            ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'],
            { cwd: stagingDir, quiet: true },
        );
    } else {
        log('reusing the existing node_modules tree');
        copyRecursive(path.join(projectRoot, 'node_modules'), path.join(stagingDir, 'node_modules'));
    }

    if (!options.sourceMaps) {
        for (const relative of walkFiles(path.join(stagingDir, 'dist'))) {
            if (relative.endsWith('.map')) fs.rmSync(path.join(stagingDir, 'dist', relative));
        }
    }
}

function main() {
    const options = parseArgs(process.argv.slice(2));

    if (!/^[A-Za-z0-9.+~:-]+$/.test(options.version)) {
        throw new Error(`Invalid version string: ${options.version}`);
    }

    if (options.build) {
        log('running npm run build');
        run('npm', ['run', 'build']);
    }

    const archLabel = options.arch === 'universal' ? 'any' : options.arch;
    const rootName = `open-mt2-${options.version}`;
    const stagingDir = path.join(options.outDir, rootName);

    // Always rebuild the staging tree from scratch: a leftover file from a
    // previous run (an older `dist`, a stale `node_modules`) would otherwise be
    // silently published.
    if (options.clean && fs.existsSync(stagingDir)) {
        log('removing the previous staging tree');
        fs.rmSync(stagingDir, { recursive: true, force: true });
    }

    stage(stagingDir, options);

    fs.mkdirSync(options.outDir, { recursive: true });

    const mtime = Number(process.env.SOURCE_DATE_EPOCH ?? 1700000000);
    const entries = buildEntries(stagingDir, rootName);
    const archive = gzip(createTarArchive(entries, { mtime }));

    const tarName = `open-mt2-${options.version}-linux-${archLabel}.tar.gz`;
    const tarPath = path.join(options.outDir, tarName);
    fs.writeFileSync(tarPath, archive);
    log(`wrote ${tarName} (${(archive.length / 1024 / 1024).toFixed(1)} MB, ${entries.length} entries)`);

    const artefacts = [{ name: tarName, data: archive }];

    if (options.deb) {
        const { debName, deb } = createDebianPackage({
            stagingDir,
            version: options.version,
            arch: options.arch,
            mtime,
            maintainer: options.debMaintainer,
            description: options.debDescription,
        });
        fs.writeFileSync(path.join(options.outDir, debName), deb);
        log(`wrote ${debName} (${(deb.length / 1024 / 1024).toFixed(1)} MB)`);
        artefacts.push({ name: debName, data: deb });
    }

    const sums = artefacts.map(({ name, data }) => `${sha256(data)}  ${name}`).join('\n');
    fs.writeFileSync(path.join(options.outDir, 'SHA256SUMS'), `${sums}\n`, 'utf8');
    log(`wrote SHA256SUMS`);

    log(`release ready in ${path.relative(projectRoot, options.outDir) || options.outDir}`);
    console.log(sums);
}

try {
    main();
} catch (error) {
    console.error(`[package] ${error.message}`);
    process.exit(1);
}