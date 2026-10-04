import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// `tools/` is excluded from `tsconfig.build.json` and ships no type
// declarations, so the helpers under test are loaded through `require` with an
// explicit contract instead of relying on JS type inference.
/* eslint-disable @typescript-eslint/no-require-imports -- the `tools/` scripts are plain CommonJS and ship no type declarations. */
const { pruneStaleArtefacts, resolveProjectUrl, ARTEFACT_PATTERN } =
    require('../../../../tools/package/buildRelease') as {
        pruneStaleArtefacts: (outDir: string) => string[];
        resolveProjectUrl: (packageJson: { repository?: unknown }) => string;
        ARTEFACT_PATTERN: RegExp;
    };

describe('buildRelease', () => {
    let outDir: string;

    beforeEach(() => {
        outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-mt2-prune-'));
    });

    afterEach(() => {
        fs.rmSync(outDir, { recursive: true, force: true });
    });

    describe('pruneStaleArtefacts', () => {
        it('should remove the artefacts of a previous run', () => {
            fs.writeFileSync(path.join(outDir, 'open-mt2-1.0.0-linux-arm64.tar.gz'), 'x');
            fs.writeFileSync(path.join(outDir, 'open-mt2-1.0.0-linux-amd64.tar.gz'), 'x');
            fs.writeFileSync(path.join(outDir, 'open-mt2_1.0.0_arm64.deb'), 'x');
            fs.writeFileSync(path.join(outDir, 'open-mt2_1.0.0_amd64.deb'), 'x');
            fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), 'x');

            const removed = pruneStaleArtefacts(outDir);

            expect(removed).to.have.members([
                'SHA256SUMS',
                'open-mt2-1.0.0-linux-amd64.tar.gz',
                'open-mt2-1.0.0-linux-arm64.tar.gz',
                'open-mt2_1.0.0_amd64.deb',
                'open-mt2_1.0.0_arm64.deb',
            ]);
            // This is the point of the function: the glob the release workflow
            // uploads must resolve to this run only, never to both arches.
            expect(fs.readdirSync(outDir)).to.be.empty;
        });

        it('should leave the staging directory in place', () => {
            const staging = path.join(outDir, 'open-mt2-1.0.0');
            fs.mkdirSync(staging);
            fs.writeFileSync(path.join(staging, 'package.json'), '{}');
            fs.writeFileSync(path.join(outDir, 'open-mt2_1.0.0_arm64.deb'), 'x');

            pruneStaleArtefacts(outDir);

            expect(fs.existsSync(staging)).to.equal(true);
            expect(fs.readdirSync(staging)).to.deep.equal(['package.json']);
            expect(fs.existsSync(path.join(outDir, 'open-mt2_1.0.0_arm64.deb'))).to.equal(false);
        });

        it('should keep files it does not own', () => {
            const stranger = path.join(outDir, 'release-notes.md');
            fs.writeFileSync(stranger, 'keep me');
            fs.writeFileSync(path.join(outDir, 'open-mt2-old.tar.gz.bak'), 'keep me too');

            const removed = pruneStaleArtefacts(outDir);

            expect(removed).to.be.empty;
            expect(fs.existsSync(stranger)).to.equal(true);
            expect(fs.existsSync(path.join(outDir, 'open-mt2-old.tar.gz.bak'))).to.equal(true);
        });

        it('should return an empty list when the output directory does not exist', () => {
            expect(pruneStaleArtefacts(path.join(outDir, 'missing'))).to.be.empty;
        });

        it('should never delete through a symlink', () => {
            const target = path.join(outDir, 'target.deb');
            fs.writeFileSync(target, 'precious');
            const link = path.join(outDir, 'open-mt2_1.0.0_arm64.deb');

            try {
                fs.symlinkSync(target, link);
            } catch {
                // Windows without developer mode cannot create symlinks; the
                // remaining assertions (the real file survives) still hold.
                return;
            }

            const removed = pruneStaleArtefacts(outDir);

            // `isFile()` is false for a symlink, so the link is skipped rather
            // than followed. What matters is that the file it points at is
            // untouched: pruning must not reach outside the output directory.
            expect(removed).to.be.empty;
            expect(fs.readFileSync(target, 'utf8')).to.equal('precious');
            expect(fs.lstatSync(link).isSymbolicLink()).to.equal(true);
        });
    });

    describe('ARTEFACT_PATTERN', () => {
        it('should match only the filenames the packager writes', () => {
            for (const name of [
                'open-mt2-1.0.0-linux-arm64.tar.gz',
                'open-mt2-1.0.0-linux-any.tar.gz',
                'open-mt2_1.0.0_arm64.deb',
            ]) {
                expect(ARTEFACT_PATTERN.test(name), name).to.equal(true);
            }
        });

        it('should reject anything else that happens to mention open-mt2', () => {
            for (const name of [
                'open-mt2-old.tar.gz.bak',
                'open-mt2-1.0.0-linux-arm64.tar.gz.sig',
                'open-mt2-1.0.0-linux-arm64.zip',
                'notes-open-mt2-1.0.0.deb',
                'SHA256SUMS',
            ]) {
                expect(ARTEFACT_PATTERN.test(name), name).to.equal(false);
            }
        });
    });

    describe('resolveProjectUrl', () => {
        it('should read the { type, url } object form npm documents', () => {
            expect(
                resolveProjectUrl({ repository: { type: 'git', url: 'git+https://github.com/wojtkob/open-mt2.git' } }),
            ).to.equal('https://github.com/wojtkob/open-mt2');
        });

        it('should read a plain string form', () => {
            expect(resolveProjectUrl({ repository: 'https://github.com/wojtkob/open-mt2' })).to.equal(
                'https://github.com/wojtkob/open-mt2',
            );
        });

        it('should fall back when the manifest declares no usable repository', () => {
            const fallback = 'https://github.com/wojtkob/open-mt2';

            expect(resolveProjectUrl({})).to.equal(fallback);
            expect(resolveProjectUrl({ repository: undefined })).to.equal(fallback);
            expect(resolveProjectUrl({ repository: {} })).to.equal(fallback);
            expect(resolveProjectUrl({ repository: 'ftp://example.invalid/open-mt2' })).to.equal(fallback);
        });

        it('should never return the upstream fork', () => {
            const url = resolveProjectUrl({ repository: 'git+https://github.com/willianmarquess/open-mt2.git' });

            // The fallback is deliberate: this repository is standalone, so an
            // unrecognised value resolves here rather than to the old fork.
            expect(url).to.equal('https://github.com/wojtkob/open-mt2');
        });
    });
});
