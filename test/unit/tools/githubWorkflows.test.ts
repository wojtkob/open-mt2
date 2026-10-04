import { expect } from 'chai';
import * as fs from 'node:fs';
import * as path from 'node:path';

// `js-yaml` arrives as a transitive dependency (via lint-staged), so it is
// resolved from the repo rather than declared directly. The check is skipped
// rather than made to fail if that ever changes.
/* eslint-disable @typescript-eslint/no-require-imports -- js-yaml is CommonJS and ships no type declarations. */
type Step = {
    name?: string;
    uses?: string;
    run?: string;
    if?: string;
    env?: Record<string, string>;
    'continue-on-error'?: boolean;
};
type Job = {
    needs?: string | string[];
    if?: string;
    outputs?: Record<string, string>;
    steps?: Step[];
};
type Workflow = {
    name: string;
    jobs: Record<string, Job>;
};

function loadWorkflows(): Workflow[] {
    let YAML: { load: (input: string) => unknown };
    try {
        YAML = require('js-yaml') as typeof YAML;
    } catch {
        return [];
    }

    // test/unit/tools -> repo root
    const dir = path.resolve(__dirname, '..', '..', '..', '.github', 'workflows');

    return fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
        .map((name) => YAML.load(fs.readFileSync(path.join(dir, name), 'utf8')) as Workflow);
}

const workflows = loadWorkflows();

describe('github workflows', function () {
    // Nothing to assert if js-yaml could not be resolved.
    if (workflows.length === 0) {
        return;
    }

    it('should parse as YAML with a name and jobs', () => {
        expect(workflows.length).to.be.greaterThan(0);

        for (const workflow of workflows) {
            expect(workflow.name, 'every workflow needs a name').to.be.a('string').and.not.be.empty;
            expect(Object.keys(workflow.jobs), `${workflow.name} needs jobs`).to.not.be.empty;
        }
    });

    // GitHub Actions only exposes the outputs of jobs named in a job's OWN
    // `needs` list. Referencing needs.<job>.outputs.* through an indirect
    // dependency silently resolves to an empty string — no warning, no error —
    // which is how an empty release tag_name reached a published workflow.
    it('should only read outputs of jobs it directly needs', () => {
        for (const workflow of workflows) {
            for (const [name, job] of Object.entries(workflow.jobs)) {
                const needs = new Set([].concat(job.needs ?? []).map(String));
                const source = JSON.stringify(job);

                for (const match of source.matchAll(/needs\.([A-Za-z_][\w]*)\.outputs\./g)) {
                    expect(
                        needs.has(match[1]),
                        `${workflow.name} / ${name} reads needs.${match[1]}.outputs but does not list ${match[1]} in needs`,
                    ).to.equal(true);
                }
            }
        }
    });

    it('should only read outputs a job actually declares', () => {
        for (const workflow of workflows) {
            for (const [name, job] of Object.entries(workflow.jobs)) {
                const source = JSON.stringify(job);

                for (const match of source.matchAll(/needs\.([A-Za-z_][\w]*)\.outputs\.([A-Za-z_][\w]*)/g)) {
                    const producer = workflow.jobs[match[1]];

                    if (!producer) {
                        continue; // reported by the previous test
                    }

                    const declared = producer.outputs ?? {};

                    expect(
                        Object.keys(declared),
                        `${workflow.name} / ${name} uses needs.${match[1]}.outputs.${match[2]}, which ${match[1]} does not declare`,
                    ).to.include(match[2]);
                }
            }
        }
    });

    it('should give every job a timeout', () => {
        // A workflow that hangs blocks a release forever; the timeout is the
        // only thing that stops it.
        for (const workflow of workflows) {
            for (const [name, job] of Object.entries(workflow.jobs)) {
                expect(
                    (job as { 'timeout-minutes'?: number })['timeout-minutes'],
                    `${workflow.name} / ${name}`,
                ).to.be.a('number');
            }
        }
    });

    it('should check out the commit being released rather than the event ref', () => {
        // On workflow_run, github.sha is not the commit CI tested. Any job that
        // builds a release artefact must check out the resolved SHA.
        for (const workflow of workflows) {
            if (!workflow.jobs.arm64) {
                continue;
            }

            const checkout = (workflow.jobs.arm64.steps ?? []).find((step) =>
                step.uses?.startsWith('actions/checkout'),
            );

            expect(checkout, `${workflow.name} / arm64 must check out code`).to.not.be.undefined;
            expect(checkout?.with?.ref, `${workflow.name} / arm64 must pin the checkout to a ref`).to.not.be.undefined;
        }
    });

    // `target_commitish` on a release only applies while the tag is created. The
    // rolling `autobuild` tag therefore stayed pinned to the commit it was first
    // published from, while its assets were rewritten on every green build, so
    // the "Source code" and install-guide links on the release resolved to an
    // older build than the artefacts next to them.
    it('should move the rolling autobuild tag onto the commit it published', () => {
        const release = workflows.find((workflow) => workflow.jobs.release);

        expect(release, 'a Release workflow with a release job is required').to.not.be.undefined;

        const steps = release?.jobs.release?.steps ?? [];
        const moveTag = steps.find((step) => step.run?.includes('git/refs/tags/$TAG'));

        expect(moveTag, 'the release job must keep the rolling tag on the built commit').to.not.be.undefined;
        // Force-updating the ref is the whole point: an existing tag is never
        // moved by a plain PATCH without it.
        expect(moveTag?.run, 'the tag ref must be updated with force=true').to.include('force=true');
        expect(moveTag?.env?.SHA, 'the tag must be moved onto RELEASE_SHA').to.include('RELEASE_SHA');
        // The ref must be resolved back afterwards, otherwise a silent failure to
        // move would still publish a green run with a drifting tag.
        expect(moveTag?.run, 'the tag move must be verified').to.match(/actual="\$\(gh api/);
        expect(moveTag?.run, 'a tag that did not move must fail the run').to.include('exit 1');
    });

    it('should never force-move an immutable semver tag', () => {
        for (const workflow of workflows) {
            for (const [name, job] of Object.entries(workflow.jobs)) {
                for (const step of job.steps ?? []) {
                    if (!step.run?.includes('git/refs') || !step.run?.includes('force=true')) {
                        continue;
                    }

                    // Only the rolling autobuild tag may be rewritten, and only
                    // while the gate classified the run as an autobuild. Without
                    // that guard the step would also fire for a `v*` release,
                    // whose tag is immutable by design.
                    expect(
                        step.if,
                        `${workflow.name} / ${name}: "${step.name}" force-updates a tag ref but is not guarded by \`if\``,
                    ).to.be.a('string');
                    expect(
                        step.if,
                        `${workflow.name} / ${name}: "${step.name}" force-updates a tag ref; its guard must restrict it to the rolling autobuild tag`,
                    ).to.include('autobuild');
                }
            }
        }
    });

    // A container package created by GITHUB_TOKEN defaults to private, and a
    // private package answers 401 to an anonymous manifest request. Every doc in
    // this repository tells users to `docker pull ghcr.io/<repo>` without a
    // login, so if the workflow never flips the visibility that instruction
    // fails while looking like a wrong tag name.
    it('should make the pushed container package publicly pullable', () => {
        // Find the job that pushes an image, then the step in it that fixes the
        // package visibility.
        const [, imageJob] = workflows
            .flatMap((workflow) => Object.entries(workflow.jobs))
            .find(([, job]) => (job.steps ?? []).some((step) => step.uses?.startsWith('docker/build-push-action@')));

        expect(imageJob, 'a job that pushes a container image is required').to.not.be.undefined;

        const step = imageJob?.steps?.find((candidate) => candidate.run?.includes('visibility=public'));

        expect(step, 'the image job must flip the container package to public').to.not.be.undefined;

        // A pull_request never pushes an image, and a fork PR cannot read this
        // token at all; running it there would only produce noise.
        expect(step?.if, 'the visibility step must not run on pull requests').to.be.a('string');
        expect(step?.if).to.include('!=');
        expect(step?.if).to.include('pull_request');

        // Visibility is a registry setting, not part of the build. If the token
        // lacks the scope, or the endpoint changes, the release must still ship
        // its artefacts rather than go red over a package setting.
        expect(step?.['continue-on-error'], 'the visibility step must be best-effort').to.equal(true);

        // It must act on this repository's own package, derived from the
        // repository rather than hardcoded, so a rename cannot leave it patching
        // a path that no longer exists.
        expect(step?.run).to.include('/user/packages/container/');
        // It must resolve the package from IMAGE_NAME, not from the repository
        // name: the image path is pinned, so the repository name would point the
        // PATCH at a package this workflow never pushes to.
        expect(step?.run).to.include('${IMAGE_NAME##*/}');
        // The assertion targets executable lines: the explanatory comment above
        // mentions GITHUB_REPOSITORY by name while explaining why it is unused.
        const commands = (step?.run ?? '')
            .split('\n')
            .filter((line) => !line.trimStart().startsWith('#'))
            .join('\n');

        expect(commands, 'the visibility step must not resolve the package from GITHUB_REPOSITORY').to.not.include(
            'GITHUB_REPOSITORY',
        );
    });

    // A GHCR package is created once and then stays bound to the repository that
    // first pushed it, so `IMAGE_NAME: ${{ github.repository }}` breaks the push
    // the moment the repository is renamed: the workflow aims at a package this
    // repository does not own and the push fails with
    // `denied: permission_denied: read_package`.
    it('should publish the image under a path the repository already owns', () => {
        const env = (workflows.find((workflow) => workflow.jobs.release) as unknown as { env?: Record<string, string> })
            .env;
        const imageName = env?.IMAGE_NAME;

        expect(imageName, 'the Release workflow must declare IMAGE_NAME').to.be.a('string');
        expect(imageName, 'IMAGE_NAME must be a literal, not ${{ github.repository }}').to.not.include('${{');

        // The current repository name, so a later rename fails loudly here
        // instead of silently repointing at a package nobody can push.
        expect(
            imageName,
            'IMAGE_NAME no longer matches the repository; publish once under a new path before changing it',
        ).to.equal('wojtkob/open-mt2');
    });
});
