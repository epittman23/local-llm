import { expect, test } from './test';
import { mockWorkspaceBackend } from './workspace-helpers';

test.describe('workspace shell', () => {
	test('bare /workspace redirects an admin to Models and shows every tab with its count', async ({
		page
	}) => {
		const { json } = await mockWorkspaceBackend(page);
		await page.route('**/api/v1/models/list*', (route) =>
			route.fulfill(json({ items: [], total: 1234 }))
		);
		await page.route('**/api/v1/prompts/list*', (route) =>
			route.fulfill(json({ items: [], total: 7 }))
		);
		await page.route('**/api/v1/tools/list', (route) => route.fulfill(json([{}, {}, {}])));

		await page.goto('/workspace');
		await expect(page).toHaveURL(/\/workspace\/models$/);

		const nav = page.getByRole('navigation');
		for (const name of ['Models', 'Knowledge', 'Prompts', 'Skills', 'Tools']) {
			await expect(nav.getByRole('link', { name: new RegExp(`^${name}`) })).toBeVisible();
		}
		// Counts use compact notation: 1234 -> "1.2k"; tools counts an array.
		await expect(nav.getByRole('link', { name: /^Models/ })).toContainText('1.2k');
		await expect(nav.getByRole('link', { name: /^Prompts/ })).toContainText('7');
		await expect(nav.getByRole('link', { name: /^Tools/ })).toContainText('3');
	});

	test('a non-admin sees only the tabs they hold a permission for, and lands on the first', async ({
		page
	}) => {
		await mockWorkspaceBackend(page, {
			role: 'user',
			workspacePermissions: { prompts: true, skills: true }
		});
		await page.goto('/workspace');
		await expect(page).toHaveURL(/\/workspace\/prompts$/);

		const nav = page.getByRole('navigation');
		await expect(nav.getByRole('link', { name: /^Prompts/ })).toBeVisible();
		await expect(nav.getByRole('link', { name: /^Skills/ })).toBeVisible();
		await expect(nav.getByRole('link', { name: /^Models/ })).toHaveCount(0);
		await expect(nav.getByRole('link', { name: /^Knowledge/ })).toHaveCount(0);
		await expect(nav.getByRole('link', { name: /^Tools/ })).toHaveCount(0);
	});

	test('a non-admin is bounced home from a section they lack permission for', async ({ page }) => {
		await mockWorkspaceBackend(page, { role: 'user', workspacePermissions: { prompts: true } });
		await page.goto('/workspace/models');
		// `/` is a real React route (a placeholder until Phase 10), so this
		// stays inside the SPA rather than leaving for SvelteKit.
		await expect(page).toHaveURL(/\/$/);
	});

	test('Tools disappears for everyone, admin included, when plugins are disabled', async ({
		page
	}) => {
		await mockWorkspaceBackend(page, { enablePlugins: false });
		await page.goto('/workspace/models');
		await expect(page.getByRole('navigation').getByRole('link', { name: /^Models/ })).toBeVisible();
		await expect(page.getByRole('navigation').getByRole('link', { name: /^Tools/ })).toHaveCount(0);
	});
});

test.describe('workspace Create button', () => {
	test('shows the current section\'s actions, and clears them when the section changes', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		await page.goto('/workspace/prompts');
		// Prompts registers Create + Import + Export, so it is the split button.
		await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Open create menu' })).toBeVisible();

		// An editor page registers nothing: the button goes away.
		await page.goto('/workspace/prompts/p1');
		await expect(page.getByRole('button', { name: 'Create', exact: true })).toHaveCount(0);
	});
});
