// Runs the frontend repros under docs/audit/repro/ with apps/web's own test
// setup (happy-dom, vitest.setup.ts, the @/ alias), so nothing is copied into
// apps/web. Usage, from apps/web:
//   bunx vitest run --config ../../docs/audit/repro/vitest.repro.config.mts <repro file>
import { fileURLToPath } from 'node:url';
import { getViteConfig } from '../../../apps/web/node_modules/astro/dist/config/entrypoint.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const web = `${repoRoot}apps/web`;
const repros = fileURLToPath(new URL('./', import.meta.url));

export default getViteConfig({
	root: web,
	server: { fs: { allow: [repoRoot] } },
	test: {
		root: web,
		dir: repros,
		environment: 'happy-dom',
		setupFiles: [`${web}/vitest.setup.ts`],
		include: [`${repros}**/*.test.{ts,tsx}`]
	}
});
