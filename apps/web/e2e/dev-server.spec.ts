// From @playwright/test, not ./test: these are plain HTTP requests, and
// ./test's auto fixture would open a browser page for nothing.
import { expect, test } from '@playwright/test';

// The `dev-server` project: `astro dev` on :5175 (playwright.config.ts). The
// rest of the suite runs against the build, so this is the one check of
// src/middleware.ts, which gives the dev server the deep-link fallback that
// main.py's SPAStaticFiles gives production: Astro emits only "/", and in
// `output: 'static'` its dev server 404s on any other path without it.

test('a deep link gets the app shell from the dev server', async ({ request }) => {
	const response = await request.get('/workspace/models');
	expect(response.status()).toBe(200);
	expect(await response.text()).toContain('<html');
});

test('a missing /_astro/ file stays a 404 on the dev server', async ({ request }) => {
	expect((await request.get('/_astro/missing.js')).status()).toBe(404);
});
