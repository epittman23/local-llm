import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testDir: './e2e',
	fullyParallel: true,
	// Four workers, here and in CI alike (ubuntu-latest has four vCPUs).
	// Against the built app (webServer below), on four cores, the suite ran
	// in 2.0 min at four workers against 4.9 min under `astro dev` at two
	// (2026-11-06). The dev server was the bottleneck there: four workers
	// against it barely helped, and Playwright's default (half the cores)
	// made its cold start miss 5 s timeouts. Pinned in this file so
	// `make test-e2e` and CI run the same.
	workers: 4,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	reporter: 'list',
	use: {
		baseURL: 'http://localhost:5174',
		trace: 'on-first-retry'
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: {
		// The bundle that ships, not `astro dev`: see e2e/static-server.ts.
		// Built into .astro/ (ignored) so it never replaces the dist/ that
		// `make backend` serves. Its own process, so Playwright's stop is the
		// whole teardown. Never reused: a server already on :5174 (`make
		// frontend`) would be the dev server, so stop it first.
		command: 'bunx astro build --outDir .astro/e2e-dist && bun e2e/static-server.ts .astro/e2e-dist 5174',
		url: 'http://localhost:5174',
		reuseExistingServer: false,
		stdout: 'pipe',
		timeout: 60_000
	}
});
