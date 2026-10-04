import DatabaseManager from '@/core/infra/database/DatabaseManager';
import Logger from '@/core/infra/logger/Logger';
import { Config } from '@/core/infra/config/Config';

const REQUIRED_ENV_VARS = ['DB_HOST', 'DB_ROOT_PASSWORD', 'DB_USER', 'DB_PORT'] as const;

function missingEnvVars(): string[] {
    return REQUIRED_ENV_VARS.filter((name) => {
        const value = process.env[name];
        return value === undefined || value.trim().length === 0;
    });
}

/** Minimal Logger implementation so the CLI does not pull winston in. */
const consoleLogger: Logger = {
    info: (message: string) => console.log(`[MIGRATE] ${message}`),
    warn: (message: string) => console.warn(`[MIGRATE] ${message}`),
    debug: () => undefined,
    error: (param: Error | string) => console.error(`[MIGRATE] ${String(param)}`),
};

/**
 * Applies `src/core/infra/database/scripts/script.sql`.
 *
 * The script drops and recreates the `auth` and `game` databases, so this is a
 * bootstrap/reset entry point rather than an incremental migration runner. It
 * is compiled into `dist/tools/database/migrate.js` and shipped with the
 * release package so a fresh Armbian/Pine A64 install can be initialised
 * without a TypeScript toolchain.
 */
async function main(): Promise<void> {
    const missing = missingEnvVars();
    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    const databaseManager = new DatabaseManager({
        logger: consoleLogger,
        config: {
            DB_HOST: process.env.DB_HOST!,
            // Intentionally left undefined: the bootstrap script creates the
            // databases itself, so the pool must not target one of them.
            DB_DATABASE_NAME: process.env.DB_DATABASE_NAME,
            DB_ROOT_PASSWORD: process.env.DB_ROOT_PASSWORD!,
            DB_USER: process.env.DB_USER!,
            DB_PORT: process.env.DB_PORT!,
        } as Config,
    });

    consoleLogger.info(`Connecting to ${process.env.DB_HOST}:${process.env.DB_PORT} as "${process.env.DB_USER}"`);
    await databaseManager.init();

    consoleLogger.info('Running bootstrap script...');
    await databaseManager.executeScripts();

    await databaseManager.close();
    consoleLogger.info('Database scripts ran successfully');
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(`[MIGRATE] Error when try to execute database scripts: ${message}`);
    process.exitCode = 1;
});
