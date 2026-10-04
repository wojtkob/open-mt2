import fs from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import ResourcePaths from '@/core/infra/config/ResourcePaths';

const SEED_ADMIN_HASH_PLACEHOLDER = '{{SEED_ADMIN_PASSWORD_HASH}}';
const SAULT_ROUNDS = 5;
const BOOTSTRAP_SCRIPT = 'script.sql';

async function loadScript() {
    // Resolved through the shared data-root lookup so the compiled `dist/` tree
    // can be installed anywhere on disk (e.g. /opt/open-mt2 on a Pine A64)
    // without depending on the current working directory.
    const scriptPath = ResourcePaths.requireResourceFile('databaseScripts', BOOTSTRAP_SCRIPT);
    const bruteScript = (await fs.readFile(scriptPath)).toString();
    const seedAdminHash = await bcrypt.hash(process.env.SEED_ADMIN_PASSWORD || 'admin', SAULT_ROUNDS);
    const scriptWithSeedValues = bruteScript.replaceAll(SEED_ADMIN_HASH_PLACEHOLDER, seedAdminHash);
    const cleanedScript = scriptWithSeedValues.replace(/(\r\n|\n|\r)/gm, '');
    const scriptSplittedByCommand = cleanedScript.split(';');
    const validCommandScriptArray = scriptSplittedByCommand.filter(Boolean);
    return validCommandScriptArray;
}

export default loadScript;
