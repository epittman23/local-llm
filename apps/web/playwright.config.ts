import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testDir: './e2e',
	globalTeardown: './e2e/global-teardown.ts',
	fullyParallel: true,
	// Two workers, here and in CI alike: at Playwright's default (half the
	// cores) a cold `astro dev` server can't answer that many browsers in
	// time on a many-core machine, and redirect assertions miss their 5 s
	// timeouts. Pinned in this file so `make test-e2e` and CI run the same.
	workers: 2,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	reporter: 'list',
	use: {
		baseURL: 'http://localhost:5174',
		trace: 'on-first-retry'
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: {
		// astro dev always daemonizes in this Astro version (see the
		// Makefile's `astro` target for the same issue): a plain `astro dev`
		// spawns the real server as a detached background process and the
		// wrapper exits almost immediately, which Playwright reads as
		// "config.webServer exited early." Same fix as the Makefile: start
		// it explicitly backgrounded, then block on `astro dev logs --follow`
		// so there is a real foreground process for Playwright to manage,
		// and `astro dev stop` on exit either way.
		command:
			'bash -c "trap \'bunx astro dev stop\' EXIT; bunx astro dev --background --port 5174; bunx astro dev logs --follow"',
		url: 'http://localhost:5174',
		reuseExistingServer: !process.env.CI,
		timeout: 60_000
	}
});
