import { execFileSync } from 'node:child_process';

/**
 * Belt-and-braces alongside playwright.config.ts's webServer command: that
 * command's own EXIT trap runs `astro dev stop` when Playwright kills the
 * process it spawned, but empirically that kill does not reliably reach the
 * detached astro.mjs daemon underneath (observed: a clean run's daemon was
 * still alive after the test run completed and teardown had already
 * finished). This is the explicit fallback so a Playwright run never leaves
 * the dev server behind regardless of why the signal-based path didn't land.
 */
export default function globalTeardown() {
	try {
		execFileSync('bunx', ['--bun', 'astro', 'dev', 'stop'], { stdio: 'ignore' });
	} catch {
		// Nothing was running -- fine.
	}
}
