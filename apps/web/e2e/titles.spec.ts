import { routePaths } from '../src/routes/routePaths';
import { expect, test } from './test';

// LAY-5 and WRD-3: every page's tab reads `<Page> · local-llm`, public pages
// included, never the bare fallback. The titles come from each route's
// `handle` in AppRouter.tsx (RootLayout writes them), so this walks every
// path the app owns against a mocked backend with every feature on.
const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

test.beforeEach(async ({ page, context }) => {
	await context.addInitScript(() => window.localStorage.setItem('token', 'test-token'));
	await page.route('**/api/**', (route) => route.fulfill(json({ items: [], total: 0 })));
	// Serve lists the profiles, which the API answers as a bare array.
	await page.route('**/api/v1/benchmarks/profiles/?*', (route) => route.fulfill(json([])));
	await page.route('**/api/v1/auths/', (route) =>
		route.fulfill(
			json({
				id: 'u1',
				email: 'ada@example.com',
				name: 'Ada',
				role: 'admin',
				profile_image_url: '',
				expires_at: Math.floor(Date.now() / 1000) + 3600
			})
		)
	);
	await page.route('**/api/config', (route) =>
		route.fulfill(
			json({
				name: 'local-llm',
				version: 'test',
				features: {
					enable_plugins: true,
					enable_benchmarks: true,
					enable_notes: true,
					enable_calendar: true,
					enable_automations: true
				}
			})
		)
	);
});

const paths = Object.values(routePaths).filter((path) => !path.includes(':'));

for (const path of paths) {
	test(`${path} titles its tab "<Page> · local-llm"`, async ({ page }) => {
		await page.goto(path);
		await expect(page).toHaveTitle(/^.+ · local-llm$/);
		expect(await page.title()).not.toBe('local-llm');
	});
}

test('a section page names the tab, not the section', async ({ page }) => {
	await page.goto(routePaths.benchmarksServe);
	await expect(page).toHaveTitle('Serve · local-llm');
	await expect(page.getByRole('heading', { level: 1, name: 'Benchmarks' })).toBeVisible();
	await page.goto(routePaths.adminUsersOverview);
	await expect(page).toHaveTitle('Users · local-llm');
	await page.goto('/no-such-page');
	await expect(page).toHaveTitle('Page not found · local-llm');
});

test('a 404 sits inside the app shell, centred, with one h1 and a way on (#1069)', async ({ page }) => {
	await page.goto('/no-such-page');
	const heading = page.getByRole('heading', { level: 1, name: 'Page not found' });
	await expect(heading).toBeVisible();
	await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
	// Inside AppShell: its skip link and main are there, and the URL is kept.
	await expect(page.getByRole('main').getByRole('button', { name: 'Search chats' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Skip to content' })).toBeAttached();
	await expect(page).toHaveURL(/\/no-such-page$/);
	const box = await heading.boundingBox();
	const viewport = page.viewportSize();
	expect(box && viewport && box.y > viewport.height / 4).toBe(true);
});

test('the first Tab press shows the skip link, and Enter moves focus to the page (A11Y-3)', async ({ page }) => {
	await page.goto(routePaths.notes);
	await expect(page.getByRole('heading', { name: 'Notes', exact: true })).toBeVisible();
	await page.keyboard.press('Tab');
	const skip = page.getByRole('link', { name: 'Skip to content' });
	await expect(skip).toBeFocused();
	await expect(skip).toBeInViewport();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('main')).toBeFocused();
});

test('a shared chat titles its tab with the chat (`/s/:id`)', async ({ page }) => {
	await page.route('**/api/v1/chats/share/abc123', (route) =>
		route.fulfill(
			json({
				id: 'chat-1',
				chat: {
					title: 'Explaining monads',
					timestamp: 1700000000000,
					models: ['qwen38'],
					history: {
						currentId: 'm1',
						messages: { m1: { id: 'm1', parentId: null, childrenIds: [], role: 'user', content: 'What is a monad?' } }
					}
				}
			})
		)
	);
	await page.goto(routePaths.share.replace(':id', 'abc123'));
	await expect(page).toHaveTitle('Explaining monads · local-llm');
});
