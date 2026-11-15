// Records the checkout this app was built from, as the default repository
// folder (src/config.ts): an installed app has no other way to find it. Also
// records its commit, for Help > About (src/main.ts), when git can say.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '');
let commit;
try {
	commit = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
	// Not a git checkout (a source archive): About says the build is not recorded.
}
writeFileSync(
	new URL('../dist/build-info.json', import.meta.url),
	`${JSON.stringify({ repoRoot, commit }, null, 2)}\n`
);
