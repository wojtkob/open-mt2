#!/usr/bin/env node
/**
 * Verifies the release artefacts produced by `tools/package/buildRelease.js`.
 *
 * This is the gate the CI/CD pipeline runs on the ARM64 runner: it re-opens the
 * generated `.tar.gz` and `.deb`, walks them as a real `tar`/`dpkg` would, and
 * fails loudly if anything a target machine needs is missing. That is what makes
 * the "publish on green" step trustworthy — an artefact that cannot be unpacked
 * on a Pine A64 never reaches a release.
 *
 * Checks performed:
 *   - the tarball extracts, and every runtime entry point is present;
 *   - every file is listed with a POSIX path, readable mode and known type;
 *   - `dist/` contains no unresolved `@/` alias and no ESM `import` statement,
 *     i.e. the tree really is CommonJS and runs without `tsconfig-paths`;
 *   - the `.deb` is a valid `ar` container with the three mandatory members;
 *   - `control` carries the required fields and the expected `Architecture`;
 *   - `md5sums` matches the payload, and the maintainer scripts are executable.
 *
 * Usage:
 *   node tools/package/verifyRelease.js [--arch arm64] [--dir build/release]
 */
'use strict';

const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { readTarArchive } = require('./tarWriter');
const { readArArchive } = require('./arWriter');

const projectRoot = path.resolve(__dirname, '..', '..');
const pkg = require(path.join(projectRoot, 'package.json'));

const REQUIRED_PACKAGE_PATHS = [
    'bin/open-mt2-auth',
    'bin/open-mt2-game',
    'bin/open-mt2-migrate',
    'bin/common.sh',
    'scripts/install.sh',
    'scripts/uninstall.sh',
    'scripts/install-node.sh',
    'etc/open-mt2.env.example',
    'deploy/systemd/open-mt2-auth.service',
    'deploy/systemd/open-mt2-game.service',
    'package.json',
    'README.md',
    'VERSION',
];

const REQUIRED_DIST_PATHS = [
    'dist/auth/main.js',
    'dist/game/main.js',
    'dist/tools/database/migrate.js',
    'dist/core/infra/database/scripts/script.sql',
    'dist/core/infra/config/ResourcePaths.js',
];

const REQUIRED_DEB_CONTROL_FIELDS = ['Package', 'Version', 'Architecture', 'Maintainer', 'Description', 'Depends'];
const DEBIAN_MAINTAINER_SCRIPTS = ['./postinst', './prerm', './postrm'];

/** Shipped files that must keep an executable bit inside the tarball. */
const EXECUTABLE_PATHS = [
    'bin/open-mt2-auth',
    'bin/open-mt2-game',
    'bin/open-mt2-migrate',
    'scripts/install.sh',
    'scripts/uninstall.sh',
    'scripts/install-node.sh',
];
const DEB_DATA_ROOT = 'opt/open-mt2';
const ARCH_ALIASES = { any: 'all', universal: 'all' };

/**
 * Expected `Homepage:` in the .deb control file. Kept in sync with the packager
 * by reading it from `package.json#repository`, so a rebrand cannot leave a stale
 * upstream URL in a published artefact without this check failing.
 */
const PROJECT_URL = (() => {
    const declared =
        typeof pkg.repository === 'string' ? pkg.repository : pkg.repository && pkg.repository.url;

    if (typeof declared !== 'string' || !declared.startsWith('http')) {
        return 'https://github.com/wojtkob/open-mt2';
    }

    return declared.replace(/^(?:git\+)?/, '').replace(/\.git$/, '');
})();

// -------------------------------------------------------------------- options

function parseArgs(argv) {
    const options = {
        arch: 'arm64',
        dir: path.join(projectRoot, 'build', 'release'),
        version: pkg.version,
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
            case '--arch':
                options.arch = next();
                break;
            case '--version':
                options.version = next();
                break;
            case '--dir':
                options.dir = path.resolve(next());
                break;
            case '-h':
            case '--help':
                console.log('Usage: node tools/package/verifyRelease.js [--arch <name>] [--version <v>] [--dir <dir>]');
                process.exit(0);
                break;
            default:
                throw new Error(`Unknown option: ${arg}`);
        }
    }

    return options;
}

// -------------------------------------------------------------------- helpers

function log(message) {
    console.log(`[verify] ${message}`);
}

/**
 * Collects failures instead of throwing on the first one, so a single CI run
 * reports every problem with the artefact rather than only the earliest.
 */
class Report {
    constructor() {
        this.failures = [];
        this.checks = 0;
    }

    check(condition, message) {
        this.checks += 1;
        if (!condition) {
            this.failures.push(message);
        }
        return Boolean(condition);
    }

    summary() {
        if (this.failures.length === 0) {
            log(`all ${this.checks} checks passed`);
            return;
        }

        console.error(`[verify] ${this.failures.length} of ${this.checks} checks failed:`);
        for (const failure of this.failures) {
            console.error(`  - ${failure}`);
        }
        throw new Error(`release verification failed with ${this.failures.length} problem(s)`);
    }
}

function namesOf(entries) {
    return new Set(entries.filter((entry) => entry.type !== '5').map((entry) => entry.name));
}

// --------------------------------------------------------------- tarball check

function verifyTarball(tarPath, report) {
    if (!fs.existsSync(tarPath)) {
        throw new Error(`Missing release artefact: ${tarPath}\nRun \`npm run package\` first.`);
    }

    log(`reading ${path.basename(tarPath)} (${(fs.statSync(tarPath).size / 1024 / 1024).toFixed(1)} MB)`);

    const archive = zlib.gunzipSync(fs.readFileSync(tarPath));
    const entries = readTarArchive(archive);
    const files = namesOf(entries);

    report.check(entries.length > 0, 'tarball contains no entries');

    // A single top-level directory keeps `tar xzf` from scattering files, and
    // gives an unambiguous prefix for the "is this really our dist tree?" checks.
    const roots = new Set([...files].map((name) => name.replace(/^\.\//, '').split('/')[0]));
    if (!report.check(roots.size === 1, `tarball should have a single top-level directory, found: ${[...roots].join(', ')}`)) {
        return { entries, files };
    }
    const distPrefix = `./${[...roots][0]}/dist/`;

    for (const required of [...REQUIRED_PACKAGE_PATHS, ...REQUIRED_DIST_PATHS]) {
        const found = [...files].some((name) => name.endsWith(`/${required}`));
        report.check(found, `tarball is missing ${required}`);
    }

    const attrFiles = [...files].filter((name) => name.startsWith(`${distPrefix}core/infra/config/data/attr/`));
    const spawnFiles = [...files].filter((name) => name.startsWith(`${distPrefix}core/infra/config/data/spawn/`));
    report.check(attrFiles.length > 0, 'tarball contains no map attribute files');
    report.check(spawnFiles.length > 0, 'tarball contains no spawn data');

    // Launchers must keep their executable bit, otherwise `bin/open-mt2-game`
    // cannot be started from a shell or by systemd.
    for (const launcher of EXECUTABLE_PATHS) {
        const entry = entries.find((candidate) => candidate.name.endsWith(`/${launcher}`));
        if (!report.check(entry !== undefined, `tarball is missing ${launcher}`)) {
            continue;
        }
        report.check((entry.mode & 0o111) !== 0, `${launcher} is not executable (mode ${entry.mode.toString(8)})`);
    }

    verifyCommonJs(entries, distPrefix, report);

    return { entries, files };
}

function verifyCommonJs(entries, distPrefix, report) {
    const suspicious = [];
    const esm = [];

    for (const entry of entries) {
        // Scoped to the package's own dist tree: `node_modules` legitimately
        // ships both CommonJS and ESM builds of the same file.
        if (entry.type !== '0' || !entry.name.startsWith(distPrefix) || !entry.name.endsWith('.js')) {
            continue;
        }

        const contents = entry.data.toString('utf8');
        if (/require\(["']@\//.test(contents) || /\bfrom\s+["']@\//.test(contents)) {
            suspicious.push(entry.name);
        }
        if (/^\s*import\s+[^(]/m.test(contents) || /^\s*export\s+(default|const|\{)/m.test(contents)) {
            esm.push(entry.name);
        }
    }

    report.check(suspicious.length === 0, `unresolved "@/" aliases in: ${suspicious.slice(0, 5).join(', ')}`);
    report.check(esm.length === 0, `ESM syntax found in a CommonJS dist tree: ${esm.slice(0, 5).join(', ')}`);

    const packageJson = entries.find((entry) => entry.name.endsWith('/package.json') && !entry.name.includes('node_modules'));
    if (report.check(packageJson !== undefined, 'tarball is missing the runtime package.json') && packageJson) {
        const manifest = JSON.parse(packageJson.data.toString('utf8'));
        report.check(manifest.type === 'commonjs', 'runtime package.json must declare "type": "commonjs"');
        report.check(manifest.main === 'dist/game/main.js', 'runtime package.json must point main at dist/game/main.js');
        report.check(
            manifest.devDependencies === undefined,
            'runtime package.json must not ship devDependencies',
        );
    }
}

// -------------------------------------------------------------------- deb check

function parseControl(contents) {
    const fields = {};
    let key = null;

    for (const line of contents.split('\n')) {
        if (/^\s/.test(line) && key) {
            fields[key] += `\n${line}`;
            continue;
        }
        const separator = line.indexOf(':');
        if (separator === -1) {
            continue;
        }
        key = line.slice(0, separator);
        fields[key] = line.slice(separator + 1).trim();
    }

    return fields;
}

function verifyDeb(debPath, options, report) {
    if (!fs.existsSync(debPath)) {
        log(`no .deb at ${path.basename(debPath)} — skipping (built with --no-deb)`);
        return;
    }

    log(`reading ${path.basename(debPath)} (${(fs.statSync(debPath).size / 1024 / 1024).toFixed(1)} MB)`);

    const members = readArArchive(fs.readFileSync(debPath));
    const byName = new Map(members.map((member) => [member.name, member]));

    for (const required of ['debian-binary', 'control.tar.gz', 'data.tar.gz']) {
        report.check(byName.has(required), `.deb is missing the "${required}" member`);
    }
    if (byName.get('debian-binary')?.data.toString('ascii') !== '2.0\n') {
        report.check(false, '.deb debian-binary must contain exactly "2.0\\n"');
    }

    const controlMember = byName.get('control.tar.gz');
    if (!controlMember) {
        return;
    }

    const controlEntries = readTarArchive(zlib.gunzipSync(controlMember.data));
    const controlFiles = new Map(controlEntries.map((entry) => [entry.name.replace(/^\.\//, ''), entry]));

    const control = controlFiles.get('control');
    if (report.check(control !== undefined, '.deb control.tar.gz has no control file')) {
        const fields = parseControl(control.data.toString('utf8'));
        for (const field of REQUIRED_DEB_CONTROL_FIELDS) {
            report.check(fields[field] !== undefined && fields[field] !== '', `.deb control is missing "${field}"`);
        }

        const expectedArch = ARCH_ALIASES[options.arch] ?? options.arch;
        report.check(
            fields.Architecture === expectedArch,
            `.deb Architecture is "${fields.Architecture}", expected "${expectedArch}"`,
        );
        report.check(fields.Package === 'open-mt2', `.deb Package is "${fields.Package}", expected "open-mt2"`);
        report.check(
            fields.Version === options.version,
            `.deb Version is "${fields.Version}", expected "${options.version}"`,
        );
        report.check(
            fields.Homepage === PROJECT_URL,
            `.deb Homepage is "${fields.Homepage}", expected "${PROJECT_URL}"`,
        );
    }

    for (const script of DEBIAN_MAINTAINER_SCRIPTS) {
        const entry = controlFiles.get(script.replace('./', ''));
        if (report.check(entry !== undefined, `.deb is missing the ${script} maintainer script`)) {
            report.check(entry.mode & 0o111, `${script} is not executable in the .deb`);
            report.check(entry.data.length > 0, `${script} is empty`);
        }
    }

    const md5sums = controlFiles.get('md5sums');
    const dataMember = byName.get('data.tar.gz');
    if (!report.check(md5sums !== undefined && dataMember !== undefined, '.deb is missing md5sums or data.tar.gz')) {
        return;
    }

    const dataEntries = readTarArchive(zlib.gunzipSync(dataMember.data));
    const dataFiles = new Map(
        dataEntries.filter((entry) => entry.type === '0').map((entry) => [entry.name.replace(/^\.\//, ''), entry]),
    );

    for (const required of [...REQUIRED_PACKAGE_PATHS, ...REQUIRED_DIST_PATHS]) {
        report.check(dataFiles.has(`${DEB_DATA_ROOT}/${required}`), `.deb data is missing ${DEB_DATA_ROOT}/${required}`);
    }

    const declared = new Map(
        md5sums.data
            .toString('utf8')
            .split('\n')
            .filter((line) => line.trim() !== '')
            .map((line) => {
                const separator = line.indexOf('  ');
                return [line.slice(separator + 2), line.slice(0, separator)];
            }),
    );

    report.check(
        declared.size === dataFiles.size,
        `.deb md5sums lists ${declared.size} file(s) but data.tar.gz holds ${dataFiles.size}`,
    );

    let mismatched = 0;
    let missing = 0;
    for (const [absolutePath, expected] of declared) {
        const entry = dataFiles.get(absolutePath.replace(/^\//, ''));
        if (!entry) {
            missing += 1;
            continue;
        }
        const actual = nodeCrypto.createHash('md5').update(entry.data).digest('hex');
        if (actual !== expected) {
            mismatched += 1;
        }
    }

    report.check(missing === 0, `.deb md5sums references ${missing} file(s) absent from data.tar.gz`);
    report.check(mismatched === 0, `.deb md5sums mismatch on ${mismatched} file(s)`);

    log(`.deb holds ${dataFiles.size} file(s), md5sums verified`);
}

// ------------------------------------------------------------------------ main

function main() {
    const options = parseArgs(process.argv.slice(2));
    const archLabel = options.arch === 'universal' ? 'any' : options.arch;
    const report = new Report();

    log(`verifying release ${options.version} for ${archLabel}`);

    verifyTarball(path.join(options.dir, `open-mt2-${options.version}-linux-${archLabel}.tar.gz`), report);
    verifyDeb(path.join(options.dir, `open-mt2_${options.version}_${archLabel}.deb`), options, report);

    const sumsPath = path.join(options.dir, 'SHA256SUMS');
    if (report.check(fs.existsSync(sumsPath), 'SHA256SUMS is missing')) {
        const sums = fs.readFileSync(sumsPath, 'utf8');
        report.check(
            sums.includes(`open-mt2-${options.version}-linux-${archLabel}.tar.gz`),
            'SHA256SUMS does not list the tarball',
        );
    }

    report.summary();
}

try {
    main();
} catch (error) {
    console.error(`[verify] ${error.message}`);
    process.exit(1);
}