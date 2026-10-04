import fs from 'node:fs';
import path from 'node:path';

/**
 * Environment variable that, when set, is used as the first (and, when it
 * contains every required resource, only) candidate root for data files.
 *
 * It is meant for distributions where the TypeScript/JavaScript tree and the
 * data tree are installed in different places, e.g.:
 *
 *   /opt/open-mt2/dist          <- compiled JavaScript
 *   /opt/open-mt2/data          <- map attributes, spawn files, quest scripts
 *
 * pointing `OPEN_MT2_DATA_DIR=/opt/open-mt2/data` makes the server find them
 * without shipping a full source tree.
 */
export const DATA_DIR_ENV_VAR = 'OPEN_MT2_DATA_DIR';

/**
 * Data sub-trees, expressed relative to a data root. They are identical for
 * `src/` (ts-node / ts-node-dev) and `dist/` (compiled), because both keep the
 * same directory layout under the project root.
 */
const RESOURCE_LAYOUT = {
    /** Gzipped map attribute files (`<map>.attr.gz`) used for walk blocking. */
    attr: path.join('core', 'infra', 'config', 'data', 'attr'),
    /** Per-map spawn definitions (`regen.json`, `npc.json`, `boss.json`, `stone.json`). */
    spawn: path.join('core', 'infra', 'config', 'data', 'spawn'),
    /** SQL bootstrap script executed by `npm run migrate`. */
    databaseScripts: path.join('core', 'infra', 'database', 'scripts'),
    /** Quest definitions, discovered at runtime through `require`. */
    quests: path.join('core', 'domain', 'quests', 'quests'),
} as const;

export type ResourceName = keyof typeof RESOURCE_LAYOUT;

const layoutRelativeToModuleDir = path.join('..', '..', '..');
const SERVER_MODULE_DIR = __dirname;
const ROOT_MARKER_FILES = ['package.json'] as const;

function normalize(value: string): string {
    return path.resolve(value);
}

function isDirectory(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Directories that may contain a data root, in priority order:
 *
 *  1. `OPEN_MT2_DATA_DIR` (explicit operator override).
 *  2. The project root inferred from this module's own location. This works for
 *     both `src/core/infra/config/` and `dist/core/infra/config/`, which keeps
 *     the server relocatable: it can be installed anywhere on disk.
 *  3. `process.cwd()` (legacy layout, still used by the dev tooling).
 */
function candidateRoots(): string[] {
    const roots: string[] = [];

    const override = process.env[DATA_DIR_ENV_VAR];
    if (override && override.trim().length > 0) {
        roots.push(normalize(override));
    }

    // `__dirname` is `<root>/core/infra/config` in both `src/` and `dist/`.
    roots.push(normalize(path.join(SERVER_MODULE_DIR, layoutRelativeToModuleDir)));
    roots.push(normalize(process.cwd()));

    return dedupe(roots);
}

function dedupe(values: string[]): string[] {
    return [...new Set(values)];
}

/**
 * A candidate is only accepted when it looks like a real data root, i.e. it
 * exposes the requested sub-tree. Checking existence (instead of blindly
 * returning the first candidate) is what keeps `OPEN_MT2_DATA_DIR` optional
 * while still failing loudly when nothing can be found.
 */
function findResourceDir(name: ResourceName): string | undefined {
    const relative = RESOURCE_LAYOUT[name];

    for (const root of candidateRoots()) {
        const candidate = path.join(root, relative);
        if (isDirectory(candidate)) {
            return candidate;
        }
    }

    return undefined;
}

function searchedLocations(name: ResourceName): string[] {
    const relative = RESOURCE_LAYOUT[name];
    return candidateRoots().map((root) => path.join(root, relative));
}

/**
 * Resolve a data directory, or throw an error listing every location that was
 * probed. Callers run during boot, so failing loudly with an actionable message
 * is far better than a later `ENOENT` deep inside a map loader.
 */
export function requireResourceDir(name: ResourceName): string {
    const resolved = findResourceDir(name);
    if (resolved) {
        return resolved;
    }

    throw new Error(
        [
            `[RESOURCE_PATHS] Unable to locate the "${name}" data directory.`,
            `[RESOURCE_PATHS] Searched: ${searchedLocations(name).join(', ')}`,
            `[RESOURCE_PATHS] Reinstall the package or set ${DATA_DIR_ENV_VAR} to the directory that contains "${RESOURCE_LAYOUT[name]}".`,
        ].join('\n'),
    );
}

/**
 * Same as {@link requireResourceDir} but returns `undefined` instead of
 * throwing, for the cases where an absent tree is a supported (if degraded)
 * state — e.g. a map without an `.attr.gz` file simply has no blocked cells.
 */
export function findOptionalResourceDir(name: ResourceName): string | undefined {
    return findResourceDir(name);
}

/**
 * Resolve a single file inside a data tree, e.g. the `script.sql` bootstrap.
 */
export function requireResourceFile(name: ResourceName, fileName: string): string {
    const dir = requireResourceDir(name);
    const file = path.join(dir, fileName);

    if (!fs.existsSync(file)) {
        throw new Error(`[RESOURCE_PATHS] Missing required file "${fileName}" inside ${dir}`);
    }

    return file;
}

/**
 * The install/project root: the closest ancestor of this module that carries a
 * `package.json`. Falls back to the inferred root when the tree has been
 * stripped down to a bare `dist/` (as done by some container images).
 */
export function getProjectRoot(): string {
    const inferred = normalize(path.join(SERVER_MODULE_DIR, layoutRelativeToModuleDir));

    let current = inferred;
    for (let depth = 0; depth < 6; depth += 1) {
        if (ROOT_MARKER_FILES.some((marker) => fs.existsSync(path.join(current, marker)))) {
            return current;
        }

        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }

    return inferred;
}

export const ResourcePaths = {
    DATA_DIR_ENV_VAR,
    attr: () => findResourceDir('attr'),
    spawn: () => findResourceDir('spawn'),
    databaseScripts: () => findResourceDir('databaseScripts'),
    quests: () => findResourceDir('quests'),
    findOptionalResourceDir,
    requireResourceDir,
    requireResourceFile,
    requireAttr: () => requireResourceDir('attr'),
    requireSpawn: () => requireResourceDir('spawn'),
    requireDatabaseScripts: () => requireResourceDir('databaseScripts'),
    requireQuests: () => requireResourceDir('quests'),
    projectRoot: getProjectRoot,
};

export default ResourcePaths;
