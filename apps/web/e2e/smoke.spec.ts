import { expect, test } from './test';

const fakeUser = {
	id: 'test-user',
	email: 'test@example.com',
	name: 'Test User',
	role: 'user',
	profile_image_url: '',
	expires_at: Math.floor(Date.now() / 1000) + 3600
};

// The route gate (lib/auth/useAuthGate.ts) redirects anything but an
// authenticated session to /auth -- which is still a SvelteKit page this
// dev server (no backend running behind it) can't actually serve, so every
// test here needs a session or it would just loop against a 404. Mocking
// the one request session.ts's initAuth() makes (GET .../auths/) stands in
// for a real backend the same way App.test.tsx's fetch mock does.
test.beforeEach(async ({ page, context }) => {
	await context.addInitScript(() => {
		window.localStorage.setItem('token', 'test-token');
	});
	await page.route('**/api/v1/auths/', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fakeUser) })
	);
});

test('the app shell renders the home route with a working sidebar link', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible();

	// The sidebar defaults closed (mirrors apps/openwebui/src/lib/components/
	// layout/Sidebar.svelte's own localStorage.sidebar default), so its nav
	// links don't exist in the DOM until it's opened.
	await page.getByRole('button', { name: /open sidebar/i }).click();
	await expect(page.getByRole('link', { name: /new chat/i })).toBeVisible();

	await page.getByRole('link', { name: /notes/i }).click();
	await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible();
	await expect(page).toHaveURL(/\/notes$/);
});

test('a direct load of a deep link falls back to the app shell, not a 404', async ({ page }) => {
	// src/middleware.ts's job: without it, Astro's static-output dev server
	// 404s on any path getStaticPaths didn't enumerate (confirmed directly
	// while building the routing shell). react-router then takes over once
	// React mounts and renders the real route.
	await page.goto('/notes');
	await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible();
});
