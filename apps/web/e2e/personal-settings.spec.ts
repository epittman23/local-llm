import type { Page } from '@playwright/test';
import { expect, test } from './test';
import { mockWorkspaceBackend } from './workspace-helpers';

const json = (route: any, d: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(d) });
const modal = (page: Page) => page.getByRole('dialog', { name: 'Settings' });

/** Saved UI settings: GET returns the latest POSTed `ui`, and every POST body is recorded. */
async function mockUserSettings(page: Page, initial: Record<string, unknown> = {}) {
	const posts: any[] = [];
	let ui = initial;
	await page.route('**/api/v1/users/user/settings**', (route) => {
		if (route.request().method() === 'GET') return json(route, { ui });
		const body = route.request().postDataJSON();
		posts.push(body);
		ui = body.ui;
		return json(route, body);
	});
	return posts;
}

test.describe('personal settings', () => {
	test('a non-admin opens Settings from the user menu and sees only personal tabs', async ({ page }) => {
		await mockWorkspaceBackend(page, { role: 'user' });
		await mockUserSettings(page);
		await page.goto('/?settings=general');
		await expect(modal(page).getByRole('tab', { name: 'General', selected: true })).toBeVisible();
		await expect(modal(page).getByRole('tab', { name: 'Account' })).toBeVisible();
		await expect(modal(page).getByRole('tab', { name: 'Code Execution' })).toHaveCount(0);
	});

	test('an admin sees the personal tabs first, then the admin ones', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockUserSettings(page);
		await page.goto('/?settings=about');
		const tabs = modal(page).getByRole('tab');
		await expect(tabs.first()).toHaveText('General');
		await expect(modal(page).getByRole('tab', { name: 'Database' })).toBeVisible();
		await expect(modal(page).getByRole('heading', { name: 'About', level: 2 })).toBeVisible();
		await expect(modal(page).getByText('Open WebUI Inc.')).toBeVisible();
	});

	test('search filters personal and admin tabs together', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockUserSettings(page);
		await page.goto('/?settings=general');
		await modal(page).getByPlaceholder('Search').fill('archived');
		await expect(modal(page).getByRole('tab')).toHaveText(['Archived Chats']);
	});

	test('Interface saves a switch into the user settings', async ({ page }) => {
		await mockWorkspaceBackend(page, { role: 'user' });
		const posts = await mockUserSettings(page, { pinnedModels: ['m1'] });
		await page.goto('/?settings=interface');
		await expect(modal(page).getByRole('heading', { name: 'Interface', level: 2 })).toBeVisible();
		const first = modal(page).getByRole('switch').first();
		const before = await first.getAttribute('aria-checked');
		await first.click();
		await expect(first).toHaveAttribute('aria-checked', before === 'true' ? 'false' : 'true');
		const save = modal(page).getByRole('button', { name: 'Save' });
		if (await save.count()) await save.click();
		await expect.poll(() => posts.length).toBeGreaterThan(0);
		// The whole `ui` object round-trips: keys this tab does not own survive.
		expect(posts.at(-1).ui.pinnedModels).toEqual(['m1']);
	});

	test('Account saves the profile and variables, and rejects bad variable keys', async ({ page }) => {
		await mockWorkspaceBackend(page, { role: 'user' });
		await mockUserSettings(page);
		const profiles: any[] = [];
		const variables: any[] = [];
		await page.route('**/api/v1/auths/update/profile', (route) => {
			profiles.push(route.request().postDataJSON());
			return json(route, { id: 'u1', ...route.request().postDataJSON() });
		});
		await page.route('**/api/v1/users/user/variables**', (route) => {
			if (route.request().method() === 'GET') return json(route, { variables: { team: 'blue' } });
			variables.push(route.request().postDataJSON());
			return json(route, route.request().postDataJSON());
		});
		await page.goto('/?settings=account');
		const m = modal(page);
		await expect(m.getByLabel('Name')).toHaveValue('Test User');
		await expect(m.getByLabel('Variable key')).toHaveValue('team');

		await m.getByRole('button', { name: 'Add Variable' }).click();
		await m.getByLabel('Variable key').nth(1).fill('Bad Key');
		await m.getByRole('button', { name: 'Save' }).click();
		await expect(page.getByText('Variable keys must use lowercase snake case.')).toBeVisible();
		expect(profiles).toHaveLength(0);

		await m.getByLabel('Variable key').nth(1).fill('region');
		await m.getByLabel('Variable value').nth(1).fill('eu');
		await m.getByLabel('Name').fill('New Name');
		await m.getByRole('button', { name: 'Save' }).click();
		await expect.poll(() => variables.length).toBe(1);
		expect(profiles[0].name).toBe('New Name');
		expect(JSON.stringify(variables[0])).toContain('"region":"eu"');
	});

	test('Archived Chats lists, and unarchives, an archived chat', async ({ page }) => {
		await mockWorkspaceBackend(page, { role: 'user' });
		await mockUserSettings(page);
		let archived = [{ id: 'c1', title: 'Old chat', updated_at: 1_700_000_000 }];
		const unarchived: string[] = [];
		await page.route('**/api/v1/chats/archived**', (route) => json(route, new URL(route.request().url()).searchParams.get('page') === '1' || !new URL(route.request().url()).searchParams.get('page') ? archived : []));
		await page.route('**/api/v1/chats/c1/archive', (route) => {
			unarchived.push('c1');
			archived = [];
			return json(route, { id: 'c1', archived: false });
		});
		await page.goto('/?settings=archived_chats');
		await expect(modal(page).getByText('Old chat').first()).toBeVisible();
		await modal(page).getByRole('button', { name: 'Unarchive Old chat' }).click();
		await expect.poll(() => unarchived).toEqual(['c1']);
	});
});
