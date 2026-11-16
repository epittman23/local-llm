import type { Page } from '@playwright/test';
import { expect, test } from './test';
import { mockWorkspaceBackend } from './workspace-helpers';

type Rec = Record<string, any>;
type Call = { method: string; path: string; search: string; body: any };

const user = (n: number, o: Rec = {}): Rec => ({
	id: `user_${n}`,
	name: `User ${n}`,
	email: `user${n}@example.com`,
	role: 'user',
	profile_image_url: '',
	created_at: 1700000000 + n,
	last_active_at: 1700000000 + n,
	group_ids: [],
	...o
});
const group = (n: number, o: Rec = {}): Rec => ({
	id: `group_${n}`,
	name: `Group ${n}`,
	description: `Group number ${n}`,
	permissions: {},
	data: null,
	member_count: n,
	...o
});

/** users + groups + permissions endpoints, recording every write. */
async function mockAdminApi(
	page: Page,
	opts: { users?: Rec[]; groups?: Rec[]; defaults?: Rec; accounts?: number } = {}
) {
	const state = { users: opts.users ?? [], groups: opts.groups ?? [] };
	const calls: Call[] = [];
	const json = (route: any, d: unknown, status = 200) =>
		route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(d) });
	const record = (req: any): Call => {
		const url = new URL(req.url());
		let body: any = null;
		try {
			body = req.postDataJSON();
		} catch {
			/* none */
		}
		const call = { method: req.method(), path: url.pathname.replace('/api/v1', ''), search: url.search, body };
		calls.push(call);
		return call;
	};

	await page.route('**/api/v1/users/**', (route) => {
		const c = record(route.request());
		// The account count behind Admin's one-account rule (S5-D2): two unless a test says otherwise.
		if (c.path === '/users/search') return json(route, { users: state.users, total: opts.accounts ?? 2 });
		if (c.path === '/users/' && c.method === 'GET') {
			const params = new URLSearchParams(c.search);
			const q = (params.get('query') ?? '').toLowerCase();
			const users = state.users.filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.includes(q));
			return json(route, { users, total: users.length });
		}
		if (c.path === '/users/default/permissions')
			return json(route, c.method === 'POST' ? c.body : (opts.defaults ?? {}));
		if (c.path === '/users/default/permissions/defaults') return json(route, { workspace: { models: false } });
		let m = c.path.match(/^\/users\/([^/]+)\/(update|groups|preview)$/);
		if (m) {
			if (m[2] === 'update') return json(route, { ...state.users.find((u) => u.id === m![1]), ...c.body });
			if (m[2] === 'groups') return json(route, [{ id: 'group_1', name: 'Group 1' }]);
			return json(route, {
				groups: [{ name: 'Group 1' }],
				models: { items: [{ name: 'Model A' }], total: 3 },
				knowledge: { items: [], total: 0 },
				tools: { items: [], total: 0 }
			});
		}
		m = c.path.match(/^\/users\/([^/]+)$/);
		if (m && c.method === 'DELETE') {
			state.users = state.users.filter((u) => u.id !== m![1]);
			return json(route, true);
		}
		return json(route, {});
	});
	await page.route('**/api/v1/auths/add', (route) => {
		const c = record(route.request());
		return json(route, { id: 'new', ...c.body });
	});
	await page.route('**/api/v1/groups/**', (route) => {
		const c = record(route.request());
		if (c.path === '/groups/' && c.method === 'GET') return json(route, state.groups);
		if (c.path === '/groups/create') {
			state.groups = [...state.groups, group(state.groups.length + 1, c.body)];
			return json(route, c.body);
		}
		const m = c.path.match(/^\/groups\/id\/([^/]+)\/(update|delete|users\/add|users\/remove|preview)$/);
		if (m) {
			if (m[2] === 'update') return json(route, { ...state.groups.find((g) => g.id === m[1]), ...c.body });
			if (m[2] === 'delete') return json(route, true);
			if (m[2] === 'preview')
				return json(route, {
					models: { items: [], total: 0 },
					knowledge: { items: [], total: 0 },
					tools: { items: [], total: 0 }
				});
			return json(route, { ...state.groups.find((g) => g.id === m[1]), member_count: 5 });
		}
		return json(route, {});
	});
	return { calls, state };
}

test.describe('admin shell', () => {
	test('a non-admin is sent home', async ({ page }) => {
		await mockWorkspaceBackend(page, { role: 'user' });
		await page.goto('/admin/users');
		await expect(page).toHaveURL(/localhost:5174\/$/);
	});

	test('bare /admin lands on Users > Overview, with the tab bar', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockAdminApi(page, { users: [user(1)] });
		await page.goto('/admin');
		await expect(page).toHaveURL(/\/admin\/users\/overview$/);
		// The page's own tab bar, not the sidebar's Main navigation, which is open by default (#930).
		const nav = page.getByRole('main').getByRole('navigation').first();
		for (const name of ['Users', 'Evaluations', 'Functions', 'Settings']) {
			await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
		}
	});

	test('the Functions tab is hidden when plugins are off', async ({ page }) => {
		await mockWorkspaceBackend(page, { enablePlugins: false });
		await mockAdminApi(page, { users: [user(1)] });
		await page.goto('/admin/users/overview');
		await expect(page.getByText('User 1', { exact: true })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Functions', exact: true })).toHaveCount(0);
	});
});

const moreActions = async (page: Page, name: string, item: string) => {
	await page.getByRole('button', { name: `More actions for ${name}` }).click();
	await page.getByRole('menuitem', { name: item }).click();
};

test.describe('admin users', () => {
	test('lists users with counts, and offers no delete or preview on admin rows', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockAdminApi(page, { users: [user(1, { role: 'admin' }), user(2), user(3)], groups: [group(1)] });
		await page.goto('/admin/users/overview');
		await expect(page.getByText('User 2', { exact: true })).toBeVisible();
		await expect(page.getByRole('link', { name: /^Overview/ })).toContainText('3');
		await expect(page.getByRole('link', { name: /^Groups/ })).toContainText('1');
		// 2 non-admin rows have a "More actions" menu; the admin row has none (#1026).
		await expect(page.getByRole('button', { name: /^More actions for / })).toHaveCount(2);
		await expect(page.getByRole('button', { name: /^Edit User \d$/ })).toHaveCount(3);
		await expect(page.getByRole('button', { name: /^Role: User/ })).toHaveCount(2);
	});

	test('sorting and searching go to the server', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockAdminApi(page, { users: [user(1), user(2)] });
		await page.goto('/admin/users/overview');
		await expect(page.getByText('User 1', { exact: true })).toBeVisible();
		await page.getByRole('button', { name: /^Name/ }).click();
		await expect.poll(() => calls.some((c) => c.path === '/users/' && c.search.includes('order_by=name'))).toBe(true);
		await page.getByRole('button', { name: /^Name/ }).click();
		await expect
			.poll(() => calls.some((c) => c.search.includes('order_by=name') && c.search.includes('direction=desc')))
			.toBe(true);

		await page.getByLabel('Search users').fill('user2');
		await expect.poll(() => calls.some((c) => c.search.includes('query=user2'))).toBe(true);
		await expect(page.getByText('User 1', { exact: true })).toHaveCount(0);
	});

	test('editing a user sends the changed name and leaves the password out when it is empty', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockAdminApi(page, { users: [user(2)] });
		await page.goto('/admin/users/overview');
		await page.getByRole('button', { name: 'Edit User 2' }).click();
		const dialog = page.getByRole('dialog', { name: 'Edit user' });
		await expect(dialog.getByRole('link', { name: 'Group 1' })).toBeVisible();
		await dialog.getByRole('textbox', { name: 'Name' }).fill('Renamed');
		await dialog.getByRole('button', { name: 'Save user' }).click();
		await expect
			.poll(() => calls.find((c) => c.path === '/users/user_2/update')?.body)
			.toMatchObject({ role: 'user', name: 'Renamed' });
		expect(calls.find((c) => c.path === '/users/user_2/update')?.body).not.toHaveProperty('password');
	});

	test('the role menu changes a role at once (#1026)', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockAdminApi(page, { users: [user(2)] });
		await page.goto('/admin/users/overview');
		await page.getByRole('button', { name: /^Role: User/ }).click();
		await page.getByRole('menuitemradio', { name: 'Admin' }).click();
		await expect
			.poll(() => calls.find((c) => c.path === '/users/user_2/update')?.body)
			.toMatchObject({ role: 'admin', name: 'User 2' });
	});

	test('an admin cannot change their own role', async ({ page }) => {
		// The mocked session user is `u1`.
		await mockWorkspaceBackend(page);
		await mockAdminApi(page, { users: [user(1, { id: 'u1', role: 'admin' })] });
		await page.goto('/admin/users/overview');
		await expect(page.getByRole('button', { name: /^Role:/ })).toHaveCount(0);
		await page.getByRole('button', { name: 'Edit User 1' }).click();
		await expect(page.getByRole('dialog').getByRole('combobox', { name: 'Role' })).toBeDisabled();
	});

	test('delete asks first, then removes the user', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockAdminApi(page, { users: [user(2)] });
		await page.goto('/admin/users/overview');
		await moreActions(page, 'User 2', 'Delete user');
		const confirm = page.getByRole('alertdialog', { name: 'Delete “User 2”?' });
		await confirm.getByRole('button', { name: 'Delete user' }).click();
		await expect.poll(() => calls.some((c) => c.method === 'DELETE' && c.path === '/users/user_2')).toBe(true);
		await expect(page.getByText('User 2', { exact: true })).toHaveCount(0);
	});

	test('Add user posts the form', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockAdminApi(page, { users: [user(2)] });
		await page.goto('/admin/users/overview');
		await page.getByRole('button', { name: 'Add user', exact: true }).click();
		const dialog = page.getByRole('dialog', { name: 'Add user' });
		await dialog.getByRole('textbox', { name: 'Name' }).fill('New Person');
		await dialog.getByRole('textbox', { name: 'Email' }).fill('new@example.com');
		await dialog.getByLabel('Password', { exact: true }).fill('hunter2hunter2');
		await dialog.getByRole('button', { name: 'Add user' }).click();
		await expect
			.poll(() => calls.find((c) => c.path === '/auths/add')?.body)
			.toMatchObject({ name: 'New Person', email: 'new@example.com', password: 'hunter2hunter2', role: 'user' });
	});

	test('Add user shows what is missing under each field, and sends nothing (#1103)', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockAdminApi(page, { users: [user(2)] });
		await page.goto('/admin/users/overview');
		await page.getByRole('button', { name: 'Add user', exact: true }).click();
		const dialog = page.getByRole('dialog', { name: 'Add user' });
		await dialog.getByRole('button', { name: 'Add user' }).click();
		await expect(dialog.getByText('Enter their name.')).toBeVisible();
		await expect(dialog.getByText('Enter their email address.')).toBeVisible();
		await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveAttribute('aria-invalid', 'true');
		await expect(dialog.getByRole('textbox', { name: 'Name' })).toBeFocused();
		expect(calls.some((c) => c.path === '/auths/add')).toBe(false);
	});

	test('Preview access shows models with the "n of total" line', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockAdminApi(page, { users: [user(2)] });
		await page.goto('/admin/users/overview');
		await moreActions(page, 'User 2', 'Preview access');
		const dialog = page.getByRole('dialog');
		await expect(dialog.getByText('Model A')).toBeVisible();
		await expect(dialog.getByText('1 of 3 accessible')).toBeVisible();
		await expect(dialog.getByText('No knowledge bases accessible')).toBeVisible();
	});

	test('View chats needs enable_admin_chat_access', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockAdminApi(page, { users: [user(2)] });
		await page.goto('/admin/users/overview');
		await page.getByRole('button', { name: 'More actions for User 2' }).click();
		await expect(page.getByRole('menuitem', { name: 'Preview access' })).toBeVisible();
		await expect(page.getByRole('menuitem', { name: 'View chats' })).toHaveCount(0);
	});

	test("with the flag, the Chats dialog lists the user's chats", async ({ page }) => {
		await mockWorkspaceBackend(page, { features: { enable_admin_chat_access: true } });
		await mockAdminApi(page, { users: [user(2)] });
		await page.route('**/api/v1/chats/list/user/**', (route) =>
			route.fulfill({ json: [{ id: 'c1', title: 'Their first chat', updated_at: 1700000000 }] })
		);
		await page.goto('/admin/users/overview');
		await moreActions(page, 'User 2', 'View chats');
		const dialog = page.getByRole('dialog');
		await expect(dialog.getByText("User 2's Chats")).toBeVisible();
		await expect(dialog.getByRole('link', { name: 'Their first chat' })).toHaveAttribute('href', /\/s\/c1$/);
	});

	test('at 390 px a row is two lines and nothing runs off the page (#1026)', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await mockWorkspaceBackend(page);
		await mockAdminApi(page, { users: [user(1, { role: 'admin' }), user(2)] });
		await page.goto('/admin/users/overview');
		// The email sits under the name (the Email column is hidden at this width).
		await expect(page.getByText('user2@example.com').first()).toBeVisible();
		await expect(page.getByRole('button', { name: 'More actions for User 2' })).toBeInViewport();
		await expect(page.getByRole('button', { name: 'Add user' })).toBeInViewport();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	});

	test('with one account, Groups and Default permissions are hidden (S5-D2)', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockAdminApi(page, { users: [user(1, { id: 'u1', role: 'admin' })], groups: [group(1)], accounts: 1 });
		await page.goto('/admin/users/groups');
		await expect(page.getByText('User 1', { exact: true })).toBeVisible();
		await expect(page.getByRole('link', { name: /^Groups/ })).toHaveCount(0);
		await expect(page.getByRole('button', { name: /Default permissions/ })).toHaveCount(0);
	});
});

test.describe('admin groups', () => {
	test('lists groups sorted by members, filters, and shows custom vs default permissions', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockAdminApi(page, { groups: [group(1), group(3, { permissions: { chat: { edit: false } } }), group(2)] });
		await page.goto('/admin/users/groups');
		const names = page.getByRole('list', { name: 'Groups' }).getByRole('listitem');
		await expect(names).toHaveCount(3);
		await expect(names.nth(0)).toContainText('Group 3');
		await expect(names.nth(1)).toContainText('Group 2');
		await expect(names.nth(2)).toContainText('Group 1');
		await expect(page.getByText(/Custom permissions/)).toHaveCount(1);
		await expect(page.getByText(/Uses the defaults/)).toHaveCount(2);
		await expect(page.getByRole('button', { name: 'Sort: Members' })).toBeVisible();
		await expect(page.getByRole('link', { name: /^Groups/ })).toContainText('3');

		await page.getByLabel('Search groups').fill('Group 2');
		await expect(names).toHaveCount(1);
		await expect(names.nth(0)).toContainText('Group 2');
		// The tab count follows the filter.
		await expect(page.getByRole('link', { name: /^Groups/ })).toContainText('1');
	});

	test("?id= opens that group's editor, and Import/Export appear only once the parent switch is on", async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		await mockAdminApi(page, { groups: [group(1), group(2)] });
		await page.goto('/admin/users/groups?id=group_2');
		const dialog = page.getByRole('dialog');
		await expect(dialog.getByRole('heading', { name: 'Edit group' })).toBeVisible();
		await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue('Group 2');

		await dialog.getByRole('tab', { name: 'Permissions' }).click();
		await dialog.getByRole('button', { name: /^Workspace/ }).click();
		await expect(dialog.getByRole('switch', { name: 'Import models' })).toHaveCount(0);
		await dialog.getByRole('switch', { name: 'Models', exact: true }).click();
		await expect(dialog.getByRole('switch', { name: 'Import models' })).toBeVisible();
		// Sharing with everyone needs sharing first; the filter finds both.
		await dialog.getByLabel('Filter permissions').fill('notes');
		await expect(dialog.getByRole('switch', { name: 'Share notes with everyone' })).toHaveCount(0);
		await dialog.getByRole('switch', { name: 'Share notes', exact: true }).click();
		await expect(dialog.getByRole('switch', { name: 'Share notes with everyone' })).toBeVisible();
	});

	test('saving a group sends name, description and the full permission set', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockAdminApi(page, { groups: [group(1)] });
		await page.goto('/admin/users/groups');
		await page.getByRole('button', { name: /Group 1/ }).click();
		const dialog = page.getByRole('dialog');
		await dialog.getByRole('textbox', { name: 'Name' }).fill('Renamed');
		await dialog.getByRole('tab', { name: 'Permissions' }).click();
		await dialog.getByLabel('Filter permissions').fill('edit messages');
		await dialog.getByRole('switch', { name: 'Edit messages' }).click();
		await expect(dialog.getByRole('button', { name: /^Chat/ })).toContainText('1 changed');
		await dialog.getByRole('button', { name: 'Save group' }).click();
		await expect
			.poll(() => calls.find((c) => c.path === '/groups/id/group_1/update')?.body)
			.toMatchObject({
				name: 'Renamed',
				description: 'Group number 1',
				permissions: { chat: { edit: false, delete: true }, workspace: { models: false } }
			});
	});

	test('the default-permission hint appears when a group turns off something the defaults grant', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockAdminApi(page, { groups: [group(1)], defaults: { chat: { edit: true } } });
		await page.goto('/admin/users/groups');
		await page.getByRole('button', { name: /Group 1/ }).click();
		const dialog = page.getByRole('dialog');
		await dialog.getByRole('tab', { name: 'Permissions' }).click();
		await dialog.getByLabel('Filter permissions').fill('edit messages');
		const hint = dialog.getByText("On for every account by default, so this group's members keep it.");
		await expect(hint).toHaveCount(0);
		await dialog.getByRole('switch', { name: 'Edit messages' }).click();
		await expect(hint).toHaveCount(1);
	});

	test('New group starts from the default permissions and posts to create', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockAdminApi(page, { groups: [], defaults: { workspace: { models: true } } });
		await page.goto('/admin/users/groups');
		await expect(page.getByText('No groups yet')).toBeVisible();
		await page.getByRole('button', { name: 'New group' }).click();
		const dialog = page.getByRole('dialog');
		await dialog.getByRole('textbox', { name: 'Name' }).fill('Fresh');
		await dialog.getByRole('tab', { name: 'Permissions' }).click();
		await dialog.getByRole('button', { name: /^Workspace/ }).click();
		await expect(dialog.getByRole('switch', { name: 'Models', exact: true })).toBeChecked();
		await dialog.getByRole('button', { name: 'Create group' }).click();
		await expect
			.poll(() => calls.find((c) => c.path === '/groups/create')?.body)
			.toMatchObject({ name: 'Fresh', permissions: { workspace: { models: true } } });
		// Reopening does not keep the previous name.
		await page.getByRole('button', { name: 'New group' }).click();
		await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Name' })).toHaveValue('');
	});

	test('Default permissions saves through /users/default/permissions', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockAdminApi(page, { groups: [group(1)] });
		await page.goto('/admin/users/groups');
		await page.getByRole('button', { name: /Default permissions/ }).click();
		const dialog = page.getByRole('dialog');
		await expect(dialog.getByRole('heading', { name: 'Default permissions' })).toBeVisible();
		await expect(dialog.getByRole('tablist')).toHaveCount(0);
		await dialog.getByRole('button', { name: /^Workspace/ }).click();
		await dialog.getByRole('switch', { name: 'Knowledge', exact: true }).click();
		await dialog.getByRole('button', { name: 'Save permissions' }).click();
		await expect
			.poll(() => calls.find((c) => c.method === 'POST' && c.path === '/users/default/permissions')?.body)
			.toMatchObject({ workspace: { knowledge: true } });
	});

	test('the Members tab ticks a user into the group', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockAdminApi(page, { groups: [group(1)], users: [user(2)] });
		await page.goto('/admin/users/groups?id=group_1');
		const dialog = page.getByRole('dialog');
		await dialog.getByRole('tab', { name: 'Members' }).click();
		await expect(dialog.getByRole('button', { name: /^Member/ })).toBeVisible();
		await dialog.getByRole('checkbox', { name: 'User 2' }).click();
		await expect
			.poll(() => calls.some((c) => c.path === '/groups/id/group_1/users/add' && c.body?.user_ids?.[0] === 'user_2'))
			.toBe(true);
	});

	test('removing a member says so, and Undo adds them back (ACT-3)', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockAdminApi(page, { groups: [group(1)], users: [user(2, { group_ids: ['group_1'] })] });
		await page.goto('/admin/users/groups?id=group_1');
		const dialog = page.getByRole('dialog');
		await dialog.getByRole('tab', { name: 'Members' }).click();
		await dialog.getByRole('checkbox', { name: 'User 2' }).click();
		await expect.poll(() => calls.some((c) => c.path === '/groups/id/group_1/users/remove')).toBe(true);
		await expect(dialog.getByRole('status')).toHaveText(/Removed “User 2” from Group 1/);
		await dialog.getByRole('button', { name: 'Undo' }).click();
		await expect.poll(() => calls.some((c) => c.path === '/groups/id/group_1/users/add')).toBe(true);
	});

	test('deleting a group confirms first, saying the members keep their accounts', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockAdminApi(page, { groups: [group(1)] });
		await page.goto('/admin/users/groups?id=group_1');
		await page.getByRole('dialog').getByRole('button', { name: 'Delete group' }).click();
		const confirm = page.getByRole('alertdialog', { name: 'Delete “Group 1”?' });
		await expect(confirm).toContainText('Its members keep their accounts');
		await confirm.getByRole('button', { name: 'Delete group' }).click();
		await expect.poll(() => calls.some((c) => c.path === '/groups/id/group_1/delete')).toBe(true);
	});
});
