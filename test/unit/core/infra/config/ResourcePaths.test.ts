import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect } from 'chai';
import sinon from 'sinon';

import {
    DATA_DIR_ENV_VAR,
    findOptionalResourceDir,
    getProjectRoot,
    requireResourceDir,
    requireResourceFile,
    ResourcePaths,
} from '@/core/infra/config/ResourcePaths';

const ATTR_RELATIVE = path.join('core', 'infra', 'config', 'data', 'attr');
const SPAWN_RELATIVE = path.join('core', 'infra', 'config', 'data', 'spawn');
const SCRIPTS_RELATIVE = path.join('core', 'infra', 'database', 'scripts');
const QUESTS_RELATIVE = path.join('core', 'domain', 'quests', 'quests');

/** The root inferred from `__dirname`, i.e. `<repo>/src` when running from source. */
const moduleRoot = path.resolve(__dirname, '..', '..', '..', '..', '..', 'src');

let temporaryRoot: string;
let originalOverride: string | undefined;

function enoent(target: string): NodeJS.ErrnoException {
    const error: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, stat '${target}'`);
    error.code = 'ENOENT';
    return error;
}

/**
 * Replaces `fs.statSync` so that *only* the given absolute directories look
 * like they exist. This is what lets the specs pin down the resolution order
 * (env var -> module location -> cwd) without touching the real repository.
 */
function onlyDirectories(...allowed: string[]): void {
    sinon.stub(fs, 'statSync').callsFake(((target: fs.PathLike) => {
        const candidate = String(target);
        if (allowed.includes(path.resolve(candidate))) {
            return { isDirectory: () => true, isFile: () => false } as fs.Stats;
        }
        throw enoent(candidate);
    }) as unknown as typeof fs.statSync);
}

/** Replaces `fs.existsSync` so that *only* the given absolute paths exist. */
function onlyFiles(...allowed: string[]): void {
    sinon
        .stub(fs, 'existsSync')
        .callsFake(((target: fs.PathLike) => allowed.includes(path.resolve(String(target)))) as typeof fs.existsSync);
}

describe('ResourcePaths', () => {
    beforeEach(() => {
        originalOverride = process.env[DATA_DIR_ENV_VAR];
        delete process.env[DATA_DIR_ENV_VAR];
        temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'open-mt2-resource-paths-'));
    });

    afterEach(() => {
        sinon.restore();
        fs.rmSync(temporaryRoot, { recursive: true, force: true });

        if (originalOverride === undefined) {
            delete process.env[DATA_DIR_ENV_VAR];
        } else {
            process.env[DATA_DIR_ENV_VAR] = originalOverride;
        }
    });

    describe('OPEN_MT2_DATA_DIR', () => {
        it('should resolve a data tree from the environment override', () => {
            process.env[DATA_DIR_ENV_VAR] = temporaryRoot;
            onlyDirectories(path.join(temporaryRoot, ATTR_RELATIVE));

            expect(requireResourceDir('attr')).to.equal(path.join(temporaryRoot, ATTR_RELATIVE));
        });

        it('should ignore a blank override and fall back to the module location', () => {
            process.env[DATA_DIR_ENV_VAR] = '   ';

            expect(requireResourceDir('attr')).to.equal(path.join(moduleRoot, ATTR_RELATIVE));
        });

        it('should fall back to the module location when the override does not contain the tree', () => {
            process.env[DATA_DIR_ENV_VAR] = temporaryRoot;
            onlyDirectories(path.join(moduleRoot, ATTR_RELATIVE));

            expect(requireResourceDir('attr')).to.equal(path.join(moduleRoot, ATTR_RELATIVE));
        });

        it('should normalise a relative override against the process working directory', () => {
            process.env[DATA_DIR_ENV_VAR] = '.';
            const expected = path.join(process.cwd(), ATTR_RELATIVE);

            onlyDirectories(expected);

            expect(requireResourceDir('attr')).to.equal(expected);
        });
    });

    describe('resolution order', () => {
        it('should prefer the override over the module location and the working directory', () => {
            process.env[DATA_DIR_ENV_VAR] = temporaryRoot;
            onlyDirectories(
                path.join(temporaryRoot, SPAWN_RELATIVE),
                path.join(moduleRoot, SPAWN_RELATIVE),
                path.join(process.cwd(), SPAWN_RELATIVE),
            );

            expect(requireResourceDir('spawn')).to.equal(path.join(temporaryRoot, SPAWN_RELATIVE));
        });

        it('should fall back to the module location when the override is missing the tree', () => {
            process.env[DATA_DIR_ENV_VAR] = temporaryRoot;
            onlyDirectories(path.join(moduleRoot, SPAWN_RELATIVE), path.join(process.cwd(), SPAWN_RELATIVE));

            expect(requireResourceDir('spawn')).to.equal(path.join(moduleRoot, SPAWN_RELATIVE));
        });

        it('should fall back to the working directory when neither override nor module location match', () => {
            onlyDirectories(path.join(process.cwd(), SPAWN_RELATIVE));

            expect(requireResourceDir('spawn')).to.equal(path.join(process.cwd(), SPAWN_RELATIVE));
        });

        it('should resolve each data tree independently', () => {
            process.env[DATA_DIR_ENV_VAR] = temporaryRoot;
            onlyDirectories(
                path.join(temporaryRoot, ATTR_RELATIVE),
                path.join(moduleRoot, SPAWN_RELATIVE),
                path.join(process.cwd(), SCRIPTS_RELATIVE),
                path.join(moduleRoot, QUESTS_RELATIVE),
            );

            expect(requireResourceDir('attr')).to.equal(path.join(temporaryRoot, ATTR_RELATIVE));
            expect(requireResourceDir('spawn')).to.equal(path.join(moduleRoot, SPAWN_RELATIVE));
            expect(requireResourceDir('databaseScripts')).to.equal(path.join(process.cwd(), SCRIPTS_RELATIVE));
            expect(requireResourceDir('quests')).to.equal(path.join(moduleRoot, QUESTS_RELATIVE));
        });
    });

    describe('requireResourceDir', () => {
        it('should list every probed location and the override variable when nothing is found', () => {
            onlyDirectories();
            const resolve = () => requireResourceDir('attr');

            expect(resolve).to.throw('[RESOURCE_PATHS] Unable to locate the "attr" data directory.');
            expect(resolve).to.throw(path.join(moduleRoot, ATTR_RELATIVE));
            expect(resolve).to.throw(path.join(process.cwd(), ATTR_RELATIVE));
            expect(resolve).to.throw(DATA_DIR_ENV_VAR);
        });

        it('should mention the missing data tree by name so operators can spot a partial install', () => {
            onlyDirectories();

            expect(() => requireResourceDir('databaseScripts')).to.throw(SCRIPTS_RELATIVE);
        });
    });

    describe('findOptionalResourceDir', () => {
        it('should return the resolved directory when the tree exists', () => {
            process.env[DATA_DIR_ENV_VAR] = temporaryRoot;
            onlyDirectories(path.join(temporaryRoot, ATTR_RELATIVE));

            expect(findOptionalResourceDir('attr')).to.equal(path.join(temporaryRoot, ATTR_RELATIVE));
        });

        it('should return undefined instead of throwing when the tree is absent', () => {
            onlyDirectories();

            expect(findOptionalResourceDir('attr')).to.be.undefined;
        });
    });

    describe('requireResourceFile', () => {
        it('should resolve a file inside a data tree', () => {
            process.env[DATA_DIR_ENV_VAR] = temporaryRoot;
            onlyDirectories(path.join(temporaryRoot, SCRIPTS_RELATIVE));
            onlyFiles(path.join(temporaryRoot, SCRIPTS_RELATIVE, 'script.sql'));

            expect(requireResourceFile('databaseScripts', 'script.sql')).to.equal(
                path.join(temporaryRoot, SCRIPTS_RELATIVE, 'script.sql'),
            );
        });

        it('should throw an actionable error when the data tree exists but the file does not', () => {
            process.env[DATA_DIR_ENV_VAR] = temporaryRoot;
            onlyDirectories(path.join(temporaryRoot, SCRIPTS_RELATIVE));
            onlyFiles();
            const resolve = () => requireResourceFile('databaseScripts', 'script.sql');

            expect(resolve).to.throw('[RESOURCE_PATHS] Missing required file "script.sql"');
            expect(resolve).to.throw(path.join(temporaryRoot, SCRIPTS_RELATIVE));
        });
    });

    describe('getProjectRoot', () => {
        it('should return the closest ancestor carrying a package.json', () => {
            const packageRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
            onlyFiles(path.join(packageRoot, 'package.json'));

            expect(getProjectRoot()).to.equal(packageRoot);
        });

        it('should return the inferred root when no package.json marker is found', () => {
            onlyFiles();

            expect(getProjectRoot()).to.equal(moduleRoot);
        });
    });

    describe('default export', () => {
        it('should expose one accessor per data tree plus the shared helpers', () => {
            process.env[DATA_DIR_ENV_VAR] = temporaryRoot;
            onlyDirectories(
                path.join(temporaryRoot, ATTR_RELATIVE),
                path.join(temporaryRoot, SPAWN_RELATIVE),
                path.join(temporaryRoot, SCRIPTS_RELATIVE),
                path.join(temporaryRoot, QUESTS_RELATIVE),
            );

            expect(ResourcePaths.requireAttr()).to.equal(path.join(temporaryRoot, ATTR_RELATIVE));
            expect(ResourcePaths.requireSpawn()).to.equal(path.join(temporaryRoot, SPAWN_RELATIVE));
            expect(ResourcePaths.requireDatabaseScripts()).to.equal(path.join(temporaryRoot, SCRIPTS_RELATIVE));
            expect(ResourcePaths.requireQuests()).to.equal(path.join(temporaryRoot, QUESTS_RELATIVE));
            expect(ResourcePaths.attr()).to.equal(path.join(temporaryRoot, ATTR_RELATIVE));
            expect(ResourcePaths.spawn()).to.equal(path.join(temporaryRoot, SPAWN_RELATIVE));
            expect(ResourcePaths.databaseScripts()).to.equal(path.join(temporaryRoot, SCRIPTS_RELATIVE));
            expect(ResourcePaths.quests()).to.equal(path.join(temporaryRoot, QUESTS_RELATIVE));
            expect(ResourcePaths.DATA_DIR_ENV_VAR).to.equal(DATA_DIR_ENV_VAR);
            expect(ResourcePaths.requireResourceDir).to.equal(requireResourceDir);
            expect(ResourcePaths.findOptionalResourceDir).to.equal(findOptionalResourceDir);
            expect(ResourcePaths.requireResourceFile).to.equal(requireResourceFile);
            expect(ResourcePaths.projectRoot).to.equal(getProjectRoot);
        });
    });
});
