import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testDir: './e2e',
	globalTeardown: './e2e/global-teardown.ts',
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
	projects: [
		{ name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: 'dev-server.spec.ts' },
		// src/middleware.ts's check, against `astro dev` (see the spec).
		{ name: 'dev-server', testMatch: 'dev-server.spec.ts', use: { baseURL: 'http://localhost:5175' } }
	],
	webServer: [
		{
			// The bundle that ships, not `astro dev`: see e2e/static-server.ts.
			// Built into .astro/ (ignored) so it never replaces the dist/ that
			// `make backend` serves. Never reused: a server already on :5174
			// (`make frontend`) would be the dev server, so stop it first.
			command: 'bunx astro build --outDir .astro/e2e-dist && bun e2e/static-server.ts .astro/e2e-dist 5174',
			url: 'http://localhost:5174',
			reuseExistingServer: false,
			stdout: 'pipe',
			timeout: 60_000
		},
		{
			// For the dev-server project only. astro dev always daemonizes in
			// this Astro version (see the Makefile's `astro` target): start it
			// backgrounded, then block on `astro dev logs --follow`, which pipes
			// its log into the run's output and gives Playwright a foreground
			// process to stop. The EXIT trap and global-teardown.ts stop the
			// daemon.
			command:
				'bash -c "trap \'bunx astro dev stop\' EXIT; bunx astro dev --background --port 5175; bunx astro dev logs --follow"',
			url: 'http://localhost:5175',
			reuseExistingServer: false,
			stdout: 'pipe',
			timeout: 60_000
		}
	]
});
