import type { Page } from '@playwright/test';

export type MockUserOptions = {
	role?: 'admin' | 'user';
	workspacePermissions?: Record<string, boolean>;
	enablePlugins?: boolean;
};

// One place for the session + config + count-endpoint mocks every workspace
// spec needs. Later `page.route` registrations win in Playwright, so a spec
// can override any single endpoint after calling this. Unmocked /api/v1/**
// requests are answered with an empty list rather than left to hit the (absent)
// backend proxy, so a stray call fails visibly as "no data", not as a hang.
export async function mockWorkspaceBackend(page: Page, options: MockUserOptions = {}) {
	const { role = 'admin', workspacePermissions = {}, enablePlugins = true } = options;
	const user = {
		id: 'u1',
		email: 'u@example.com',
		name: 'Test User',
		role,
		profile_image_url: '',
		permissions: { workspace: workspacePermissions },
		expires_at: Math.floor(Date.now() / 1000) + 3600
	};
	const json = (body: unknown) => ({
		status: 200,
		contentType: 'application/json',
		body: JSON.stringify(body)
	});

	await page.context().addInitScript(() => {
		window.localStorage.setItem('token', 'test-token');
	});
	await page.route('**/api/v1/**', (route) => route.fulfill(json({ items: [], total: 0 })));
	await page.route('**/api/v1/auths/', (route) => route.fulfill(json(user)));
	await page.route('**/api/config', (route) =>
		route.fulfill(
			json({
				name: 'local-llm',
				version: 'test',
				features: { enable_plugins: enablePlugins, enable_benchmarks: true }
			})
		)
	);
	return { user, json };
}
