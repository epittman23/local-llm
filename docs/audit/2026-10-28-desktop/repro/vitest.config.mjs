// Runs the audit repros with apps/desktop's own Vitest (see README.md here).
// A plain object, without importing `vitest/config`: that package doesn't
// resolve from docs/. Globals let the repros use describe/it/expect/vi
// without importing vitest either. Vite's cache goes to the temp directory and
// Vitest's module cache is off, so nothing lands in a node_modules/ here.
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default {
	cacheDir: join(tmpdir(), 'local-llm-desktop-audit-vite'),
	test: { root: import.meta.dirname, include: ['P*/*.test.ts'], globals: true, fsModuleCache: false }
};
