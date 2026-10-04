#!/usr/bin/env node
/**
 * Copies the runtime (non-TypeScript) assets that `tsc` leaves behind into the
 * compiled `dist/` tree.
 *
 * `tsc` only emits `.js` (plus the `.json` files it statically imports), so a
 * build produced by `tsc -p tsconfig.build.json` alone is NOT runnable: the
 * server reads map attributes, per-map spawn files and the SQL bootstrap script
 * from disk at runtime. This script closes that gap so that `dist/` is a
 * self-contained, relocatable install — which is what the release tarball and
 * the Debian package ship.
 *
 * Layout is preserved 1:1, so `dist/core/infra/config/data/attr/<map>.attr.gz`
 * always sits at the same depth as `src/core/infra/config/data/attr/<map>.attr.gz`
 * and `ResourcePaths` resolves both identically.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const srcDir = path.join(projectRoot, 'src');
const distDir = path.join(projectRoot, 'dist');

/** Directories (relative to `src/`) scanned recursively for runtime assets. */
const ASSET_DIRECTORIES = [
    path.join('core', 'infra', 'config', 'data', 'attr'),
    path.join('core', 'infra', 'config', 'data', 'spawn'),
    path.join('core', 'infra', 'database', 'scripts'),
];

/** Single files (relative to `src/`) copied verbatim. */
const ASSET_FILES = [];

/** Extensions treated as runtime assets. */
const ASSET_EXTENSIONS = new Set(['.gz', '.sql', '.json', '.txt', '.csv']);

function walk(directory, onFile) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            walk(absolute, onFile);
        } else if (entry.isFile()) {
            onFile(absolute);
        }
    }
}

function copyFile(absoluteSource, relativeToSrc) {
    const target = path.join(distDir, relativeToSrc);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(absoluteSource, target);
    return target;
}

function main() {
    if (!fs.existsSync(srcDir)) {
        throw new Error(`Missing source directory: ${srcDir}`);
    }

    let copied = 0;

    for (const relativeDirectory of ASSET_DIRECTORIES) {
        const absoluteDirectory = path.join(srcDir, relativeDirectory);
        if (!fs.existsSync(absoluteDirectory)) {
            throw new Error(`Missing asset directory: ${relativeDirectory}`);
        }

        walk(absoluteDirectory, (absoluteFile) => {
            const extension = path.extname(absoluteFile).toLowerCase();
            if (ASSET_EXTENSIONS.has(extension)) {
                copyFile(absoluteFile, path.relative(srcDir, absoluteFile));
                copied += 1;
            }
        });
    }

    for (const relativeFile of ASSET_FILES) {
        const absoluteFile = path.join(srcDir, relativeFile);
        if (!fs.existsSync(absoluteFile)) {
            throw new Error(`Missing asset file: ${relativeFile}`);
        }
        copyFile(absoluteFile, relativeFile);
        copied += 1;
    }

    console.log(`[copy-runtime-assets] copied ${copied} asset(s) into ${path.relative(projectRoot, distDir)}`);
}

try {
    main();
} catch (error) {
    console.error(`[copy-runtime-assets] ${error.message}`);
    process.exit(1);
}