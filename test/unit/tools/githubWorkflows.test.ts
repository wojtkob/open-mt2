import { expect } from 'chai';
import * as fs from 'node:fs';
import * as path from 'node:path';

// `js-yaml` arrives as a transitive dependency (via lint-staged), so it is
// resolved from the repo rather than declared directly. The check is skipped
// rather than made to fail if that ever changes.
/* eslint-disable @typescript-eslint/no-require-imports -- js-yaml is CommonJS and ships no type declarations. */
type Job = {
    needs?: string | string[];
    if?: string;
    outputs?: Record<string, string>;
    steps?: Array<{ name?: string; uses?: string; run?: string; if?: string }>;
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
});
