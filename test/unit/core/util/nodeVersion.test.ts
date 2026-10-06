import { expect } from 'chai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    MIN_NODE_MAJOR,
    SUPPORTED_NODE_MAJORS,
    assertSupportedRuntime,
    isRuntimeSupported,
    unsupportedRuntimeReasons,
} from '@/core/util/nodeVersion';

/**
 * Reads `NAME=123` out of a shell script so the four declarations of the Node
 * floor can be compared. Commented-out assignments are deliberately skipped: a
 * `# MIN_NODE_MAJOR=20` left behind after a change is exactly the drift this
 * exists to catch, and it must not be allowed to read as the real value.
 */
function readShellNumber(file: string, name: string): number {
    const text = fs.readFileSync(file, 'utf8');
    const match = text.match(new RegExp(`^[ \\t]*${name}=(\\d+)[ \\t]*$`, 'm'));

    if (!match || match[1] === undefined) {
        throw new Error(`${name}= is not assigned as a bare number in ${path.relative(process.cwd(), file)}`);
    }

    return Number.parseInt(match[1], 10);
}

describe('nodeVersion', () => {
    describe('MIN_NODE_MAJOR', () => {
        // Promise.withResolvers is the constraint that sets this, and it is not
        // a preference: on an older runtime AbstractQuest throws while a quest
        // choice window is being opened.
        it('should require the Node version that introduced Promise.withResolvers', () => {
            expect(MIN_NODE_MAJOR).to.be.at.least(22);
            expect(MIN_NODE_MAJOR).to.be.a('number');
        });

        it('should be the same floor the release artefacts advertise', () => {
            // tools/package/buildRelease.js copies package.json#engines.node
            // into the runtime package.json shipped in the tarball and the
            // .deb, so a mismatch here means the published artefacts understate
            // the runtime requirement.
            const root = path.resolve(__dirname, '..', '..', '..', '..');
            const declared = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

            expect(declared.engines?.node, 'package.json must declare engines.node').to.be.a('string');
            expect(declared.engines.node).to.equal(`>=${MIN_NODE_MAJOR}`);
        });

        it('should be the same floor the installers and launchers enforce', () => {
            // Four separate declarations of one number, and they run at
            // different times: package.json before install, install.sh while
            // choosing a system runtime, common.sh every launch, nodeVersion.ts
            // inside Node. Nothing links them, so drift is silent until someone
            // hits it on a board. install.sh will replace a system Node 20 with
            // a private 22.x runtime; common.sh is what stops OPEN_MT2_NODE (or
            // a PATH that changed after the install) from putting Node 20 back.
            const root = path.resolve(__dirname, '..', '..', '..', '..');

            for (const [file, name] of [
                ['deploy/scripts/install.sh', 'MIN_NODE_MAJOR'],
                ['deploy/launcher/common.sh', 'OPEN_MT2_MIN_NODE_MAJOR'],
            ] as const) {
                const value = readShellNumber(path.join(root, file), name);

                expect(value, `${file} declares ${value}, nodeVersion.ts declares ${MIN_NODE_MAJOR}`).to.equal(
                    MIN_NODE_MAJOR,
                );
            }
        });
    });

    describe('unsupportedRuntimeReasons', () => {
        it('should report nothing for a supported version', () => {
            for (const major of SUPPORTED_NODE_MAJORS) {
                expect(unsupportedRuntimeReasons(`v${major}.0.0`), `v${major}`).to.deep.equal([]);
            }
        });

        it('should reject a runtime older than the floor', () => {
            for (const version of ['v18.20.0', 'v20.11.1', 'v21.7.3']) {
                const reasons = unsupportedRuntimeReasons(version);

                expect(reasons, version).to.not.be.empty;
                expect(reasons.join(' '), version).to.include(`>= ${MIN_NODE_MAJOR}`);
            }
        });

        it('should reject a version it cannot parse', () => {
            expect(unsupportedRuntimeReasons('not-a-version')).to.not.be.empty;
        });

        it('should flag an untested newer major as a warning, not a blocker', () => {
            const reasons = unsupportedRuntimeReasons('v99.0.0');

            expect(reasons.join(' ')).to.include('newer than the tested versions');
            // Refusing to start on a runtime that has the features would be its
            // own failure, so this must not read as fatal.
            expect(isRuntimeSupported('v99.0.0')).to.equal(true);
        });
    });

    describe('isRuntimeSupported', () => {
        it('should accept the floor itself', () => {
            expect(isRuntimeSupported(`v${MIN_NODE_MAJOR}.0.0`)).to.equal(true);
        });

        it('should reject anything below the floor', () => {
            expect(isRuntimeSupported('v20.11.1')).to.equal(false);
            expect(isRuntimeSupported('v18.20.0')).to.equal(false);
        });
    });

    describe('assertSupportedRuntime', () => {
        it('should not exit on the current runtime', () => {
            // The suite itself only runs on a supported runtime, so this must be
            // a silent no-op rather than process.exit(1).
            expect(() => assertSupportedRuntime()).to.not.throw();
        });

        it('should exit 1 with an actionable message on an old runtime', () => {
            const written: string[] = [];
            const originalExit = process.exit;
            const originalWrite = process.stderr.write;
            let exitCode: number | undefined;

            process.stderr.write = ((chunk: string) => {
                written.push(chunk);
                return true;
            }) as typeof process.stderr.write;
            process.exit = ((code?: number) => {
                exitCode = code;
                throw new Error('__exit__');
            }) as typeof process.exit;

            try {
                expect(() => assertSupportedRuntime('v20.11.1')).to.throw('__exit__');
            } finally {
                process.exit = originalExit;
                process.stderr.write = originalWrite;
            }

            expect(exitCode, 'must exit non-zero').to.equal(1);

            const message = written.join('');
            expect(message).to.include('cannot start on this Node.js runtime');
            // A user on an old runtime needs the fix, not just the diagnosis.
            expect(message).to.include('nodesource.com');
            expect(message).to.include('nvm install 22');
        });
    });
});
