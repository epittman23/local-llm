// Records the checkout this app was built from, as the default repository
// folder (src/config.ts): an installed app has no other way to find it.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '');
writeFileSync(new URL('../dist/build-info.json', import.meta.url), `${JSON.stringify({ repoRoot }, null, 2)}\n`);
