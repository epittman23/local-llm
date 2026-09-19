import { expect, test } from './test';
import type { Page } from '@playwright/test';

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
	features: { auth: true, enable_login_form: true, enable_signup: true }
};

const mockConfig = (page: Page, config: object) =>
	page.route('**/api/config', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config) })
	);

test('an anonymous visit to a protected route lands on /auth, and signing in returns to it', async ({
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

test('first-run onboarding is shown once config arrives, and leads into admin sign-up', async ({
	page
}) => {
	// Regression: AuthPage's one-shot mount logic used to run against a still-
	// null config and never re-run, so onboarding silently never appeared.
	await mockConfig(page, { ...baseConfig, onboarding: true });

	await page.goto('/auth');

	await expect(page.getByText('Welcome to local-llm')).toBeVisible();
	await page.getByRole('button', { name: 'Get Started' }).click();
	await expect(page.getByRole('button', { name: 'Create Admin Account' })).toBeVisible();
});

test('LDAP-enabled deployments start in LDAP mode and can switch to email', async ({ page }) => {
	await mockConfig(page, {
		...baseConfig,
		features: { ...baseConfig.features, enable_ldap: true }
	});

	await page.goto('/auth');

	await expect(page.getByText('Sign in to local-llm with LDAP')).toBeVisible();
	await expect(page.getByLabel('Username')).toBeVisible();
	await page.getByRole('button', { name: 'Continue with Email' }).click();
	await expect(page.getByLabel('Email')).toBeVisible();
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
	await context.addCookies([
		{ name: 'token', value: 'cookie-token', url: 'http://localhost:5174' }
	]);
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

test('a shared chat renders read-only for an anonymous viewer, sanitized, with no Clone button', async ({
	page
}) => {
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

test('an unknown share id bounces to the home route', async ({ page }) => {
	await mockConfig(page, baseConfig);
	await page.route('**/api/v1/chats/share/nope', (route) =>
		route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"Not found"}' })
	);

	await page.goto('/s/nope');

	// Home is gated, so an anonymous viewer continues on to /auth.
	await expect(page).toHaveURL(/\/auth\?redirect=%2F$/);
});
