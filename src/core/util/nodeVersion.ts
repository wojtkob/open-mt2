/**
 * Node.js runtime guard.
 *
 * The servers need ES2024 `Promise.withResolvers`, added in Node.js 22. On an
 * older runtime the code still loads, so nothing fails until a quest opens a
 * choice window deep inside gameplay:
 *
 *     TypeError: this.currentChoicePromise.resolve is not a function
 *
 * That failure is worth catching up front: it names neither Node nor the quest
 * that triggered it, and on a board like the Pine A64 it is a common
 * configuration, because Armbian's own `nodejs` package is regularly older than
 * the runtime the server needs.
 */
export const MIN_NODE_MAJOR = 22;

/** Node.js versions the servers are known to run on. */
export const SUPPORTED_NODE_MAJORS = [22, 24];

/** Features the runtime must provide, beyond the major version number. */
const REQUIRED_FEATURES: Array<{ name: string; available: () => boolean; since: string }> = [
    {
        name: 'Promise.withResolvers',
        available: () => typeof Promise.withResolvers === 'function',
        since: 'Node.js 22',
    },
];

function majorOf(version: string): number {
    return Number.parseInt(version.replace(/^v/, '').split('.')[0] ?? '', 10);
}

/**
 * Reasons the current runtime cannot run the servers, most specific first.
 * An empty array means the runtime is supported.
 */
export function unsupportedRuntimeReasons(version: string = process.version): string[] {
    const reasons: string[] = [];
    const major = majorOf(version);

    if (!Number.isFinite(major)) {
        reasons.push(`Could not read a major version out of "${version}"`);
    } else if (major < MIN_NODE_MAJOR) {
        reasons.push(`Node.js ${version} is too old, Node.js >= ${MIN_NODE_MAJOR} is required`);
    } else if (!SUPPORTED_NODE_MAJORS.includes(major)) {
        // Newer than anything tested. Not fatal, but worth saying out loud
        // before a real incompatibility is mistaken for a server bug.
        reasons.push(
            `Node.js ${version} is newer than the tested versions ` +
                `(${SUPPORTED_NODE_MAJORS.map((value) => `>= ${value}`).join(', ')})`,
        );
    }

    for (const feature of REQUIRED_FEATURES) {
        if (!feature.available()) {
            reasons.push(`${feature.name} is missing (${feature.since} or newer required)`);
        }
    }

    return reasons;
}

/**
 * True when the runtime can run the servers without a known impediment.
 *
 * Note this is stricter than {@link unsupportedRuntimeReasons} being empty: an
 * untested-but-newer major is reported, yet is not a reason to refuse to start.
 */
export function isRuntimeSupported(version: string = process.version): boolean {
    return majorOf(version) >= MIN_NODE_MAJOR && REQUIRED_FEATURES.every((feature) => feature.available());
}

/** Reasons that make the runtime genuinely unusable, ignoring untested warnings. */
function fatalReasons(version: string): string[] {
    const major = majorOf(version);

    if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
        return [`Node.js ${version} is too old, Node.js >= ${MIN_NODE_MAJOR} is required`];
    }

    return REQUIRED_FEATURES.filter((feature) => !feature.available()).map(
        (feature) => `${feature.name} is missing (${feature.since} or newer required)`,
    );
}

/**
 * Prints an actionable message and exits when the runtime cannot run the
 * servers. Call it as the first statement of every entry point.
 *
 * An untested-but-newer major only warns: refusing to start on a Node release
 * that plainly has the features would be its own kind of failure.
 */
export function assertSupportedRuntime(version: string = process.version): void {
    const reasons = fatalReasons(version);

    if (reasons.length === 0) {
        const warnings = unsupportedRuntimeReasons(version);

        for (const warning of warnings) {
            process.stderr.write(`open-mt2 warning: ${warning}\n`);
        }

        return;
    }

    process.stderr.write(
        [
            'open-mt2 cannot start on this Node.js runtime:',
            ...reasons.map((reason) => `  - ${reason}`),
            '',
            'Upgrade with one of:',
            '  - NodeSource: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs',
            '  - nvm:         nvm install 22 && nvm use 22',
            '',
            `Running: ${process.version} on ${process.platform}/${process.arch}`,
            '',
        ].join('\n'),
    );

    process.exit(1);
}
