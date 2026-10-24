/// <reference types="vitest/config" />
import { getViteConfig } from 'astro/config';

export default getViteConfig({
	test: {
		environment: 'happy-dom',
		setupFiles: ['./vitest.setup.ts'],
		include: ['src/**/*.test.{ts,tsx}'],
		exclude: ['e2e/**'],
		// `bun run test:coverage` (CI's web job): lcov for diff-cover, which
		// checks the lines a pull request changes (docs/guides/testing.md).
		// src/components/ui is generated (shadcn/ui), as in biome.jsonc.
		coverage: {
			provider: 'v8',
			include: ['src/**/*.{ts,tsx}'],
			exclude: ['src/**/*.test.{ts,tsx}', 'src/components/ui/**', 'src/**/*.d.ts'],
			reporter: ['lcov', 'text-summary']
		}
	}
});
