import type { Page } from '@playwright/test';
import { expect, test } from './test';
import { mockWorkspaceBackend } from './workspace-helpers';

const json = (route: any, d: unknown, status = 200) =>
	route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(d) });
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
		await expect(modal(page).getByText(/Open WebUI Inc\. \[Created by Timothy Jaeryang Baek\]/)).toBeVisible();
	});

	test('search finds personal and admin tabs together, and settings by their words (#1001)', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockUserSettings(page);
		await page.goto('/?settings=general');
		await modal(page).getByPlaceholder('Search').fill('archived');
		await expect(modal(page).getByRole('option')).toHaveText(['Archived chats']);
		await modal(page).getByPlaceholder('Search').fill('widescreen');
		await modal(page).getByRole('option', { name: 'Interface › Widescreen Mode' }).click();
		await expect(modal(page).getByRole('tab', { selected: true })).toHaveText('Interface');
		await expect(modal(page).getByRole('switch', { name: 'Widescreen Mode' })).toBeInViewport();
	});

	test('a tab with unsaved changes asks before it is left (#951)', async ({ page }) => {
		await mockWorkspaceBackend(page, { role: 'user' });
		const posts = await mockUserSettings(page, { system: 'be brief' });
		await page.goto('/?settings=general');
		const m = modal(page);
		await m.getByRole('textbox', { name: 'System prompt' }).fill('be thorough');
		await expect(m.getByText('Unsaved changes')).toBeVisible();
		await m.getByRole('tab', { name: 'Interface', exact: true }).click();
		const ask = page.getByRole('alertdialog', { name: 'Discard changes?' });
		await expect(ask.getByRole('button', { name: 'Keep editing' })).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(ask).toHaveCount(0);
		await expect(m.getByRole('textbox', { name: 'System prompt' })).toHaveValue('be thorough');
		await m.getByRole('button', { name: 'Save', exact: true }).click();
		await expect.poll(() => posts.length).toBe(1);
		expect(posts[0].ui.system).toBe('be thorough');
		await expect(m.getByText('All changes saved')).toBeVisible();
		await m.getByRole('tab', { name: 'Interface', exact: true }).click();
		await expect(m.getByRole('heading', { name: 'Interface', level: 2 })).toBeVisible();
	});

	test('Escape in a confirmation inside Settings closes only the confirmation (#950)', async ({ page }) => {
		await mockWorkspaceBackend(page, { role: 'user' });
		await mockUserSettings(page);
		await page.goto('/?settings=data_controls');
		await modal(page).getByRole('button', { name: 'Archive all chats' }).click();
		// Focus inside it (on Cancel, ACT-3) means it is the top layer: Escape is now its to handle.
		await expect(
			page.getByRole('alertdialog', { name: 'Archive all chats?' }).getByRole('button', { name: 'Cancel' })
		).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(page.getByRole('alertdialog')).toHaveCount(0);
		await expect(modal(page)).toBeVisible();
		await expect(modal(page).getByRole('button', { name: 'Archive all chats' })).toBeFocused();
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

	test('Interface saves a font typed and submitted with Enter (#261)', async ({ page }) => {
		await mockWorkspaceBackend(page, { role: 'user' });
		const posts = await mockUserSettings(page);
		await page.goto('/?settings=interface');
		const m = modal(page);
		await m.getByRole('button', { name: 'Font Family: Default' }).click();
		const box = m.getByLabel('Font Family name');
		await box.fill('Aptos');
		await box.press('Enter');
		await expect.poll(() => posts.length).toBe(1);
		expect(posts[0].ui.fontFamily).toBe('Aptos');
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

	test('Enter in a password field changes the password, not the profile (#260)', async ({ page }) => {
		await mockWorkspaceBackend(page, {
			role: 'user',
			features: { enable_login_form: true, enable_password_change_form: true }
		});
		await mockUserSettings(page);
		const profiles: unknown[] = [];
		const passwords: unknown[] = [];
		await page.route('**/api/v1/auths/update/profile', (route) => {
			profiles.push(route.request().postDataJSON());
			return json(route, { id: 'u1', ...route.request().postDataJSON() });
		});
		await page.route('**/api/v1/auths/update/password', (route) => {
			passwords.push(route.request().postDataJSON());
			return json(route, { detail: 'Incorrect password' }, 400);
		});
		await page.goto('/?settings=account');
		const m = modal(page);
		await expect(m.getByLabel('Name')).toHaveValue('Test User');

		await m.getByLabel('Current Password').fill('old-pass');
		await m.getByLabel('New Password').fill('new-pass');
		await m.getByLabel('Confirm Password').fill('new-pass');
		await m.getByLabel('Confirm Password').press('Enter');
		await expect(page.getByText('Incorrect password')).toBeVisible();
		expect(passwords).toEqual([{ password: 'old-pass', new_password: 'new-pass' }]);
		expect(profiles).toHaveLength(0);

		// And Enter in a profile field still saves the tab (once it has a change), not the password.
		await m.getByLabel('Name').fill('Test User B');
		await m.getByLabel('Name').press('Enter');
		await expect.poll(() => profiles.length).toBe(1);
		expect(passwords).toHaveLength(1);
	});

	test('Archived Chats lists, and unarchives, an archived chat', async ({ page }) => {
		await mockWorkspaceBackend(page, { role: 'user' });
		await mockUserSettings(page);
		let archived = [{ id: 'c1', title: 'Old chat', updated_at: 1_700_000_000 }];
		const unarchived: string[] = [];
		await page.route('**/api/v1/chats/archived**', (route) =>
			json(
				route,
				new URL(route.request().url()).searchParams.get('page') === '1' ||
					!new URL(route.request().url()).searchParams.get('page')
					? archived
					: []
			)
		);
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
