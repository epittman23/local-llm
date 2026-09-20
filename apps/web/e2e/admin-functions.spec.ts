import type { Page } from '@playwright/test';
import { expect, test } from './test';
import { mockWorkspaceBackend } from './workspace-helpers';

type Rec = Record<string, any>;
type Call = { method: string; path: string; body: any };

const fn = (n: number, o: Rec = {}): Rec => ({
	id: `fn_${n}`,
	name: `Function ${n}`,
	type: 'pipe',
	user_id: 'u1',
	updated_at: 1700000000 + n,
	is_active: true,
	is_global: false,
	content: `class Pipe:\n    pass  # ${n}`,
	meta: { description: `Function number ${n}` },
	user: { name: 'Test User', email: 'u@example.com', username: 'tester' },
	...o
});

async function mockFunctionsApi(page: Page, initial: Rec[], opts: { failToggle?: boolean } = {}) {
	const state = { fns: [...initial] };
	const calls: Call[] = [];
	await page.route('**/api/v1/functions/**', async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname.replace('/api/v1/functions', '');
		let body: any = null;
		try {
			body = req.postDataJSON();
		} catch {
			/* none */
		}
		calls.push({ method: req.method(), path, body });
		const json = (d: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(d) });
		if (path === '/list' || path === '/') return json(state.fns);
		if (path === '/create') return json(body);
		if (path === '/export') return json(state.fns);
		const m = path.match(/^\/id\/([^/]+)(\/.*)?$/);
		if (m) {
			const found = state.fns.find((f) => f.id === m[1]);
			const rest = m[2] ?? '';
			if (rest === '/toggle' && opts.failToggle) return json({ detail: 'nope' }, 500);
			if (rest === '/valves/spec') return json(null);
			if (rest === '/valves') return json({});
			if (!found) return json({ detail: 'Not found' }, 404);
			if (rest === '') return json(found);
			if (rest === '/update') return json({ ...found, ...body });
			if (rest === '/toggle') return json({ ...found, is_active: !found.is_active });
			if (rest === '/toggle/global') return json({ ...found, is_global: !found.is_global });
			if (rest === '/delete') {
				state.fns = state.fns.filter((f) => f.id !== found.id);
				return json(true);
			}
		}
		return json({});
	});
	return { calls };
}

test.describe('admin functions', () => {
	test('a plugins-off deployment bounces /admin/functions back to Users', async ({ page }) => {
		await mockWorkspaceBackend(page, { enablePlugins: false });
		await page.goto('/admin/functions');
		await expect(page).toHaveURL(/\/admin\/users\/overview$/);
	});

	test('lists functions, filters by type and by author, and counts the filtered list', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockFunctionsApi(page, [
			fn(1),
			fn(2, { type: 'filter', user: { name: 'Zed', email: 'z@example.com', username: 'zedzed' }, user_id: 'other' }),
			fn(3, { type: 'action', meta: { description: 'd', manifest: { version: '2.0.1' } } })
		]);
		await page.goto('/admin/functions');
		await expect(page.getByText('Function 1', { exact: true })).toBeVisible();
		await expect(page.getByText('v2.0.1')).toBeVisible();
		await expect(page.getByText('filter', { exact: true })).toBeVisible();
		await expect(page.getByText('3', { exact: true }).first()).toBeVisible();

		await page.getByRole('button', { name: 'Tag', exact: true }).click();
		await page.getByRole('menuitemradio', { name: 'Filter' }).click();
		await expect(page.getByText('Function 2', { exact: true })).toBeVisible();
		await expect(page.getByText('Function 1', { exact: true })).toHaveCount(0);

		await page.getByRole('button', { name: 'Clear tag' }).click();
		await page.getByLabel('Search Functions').fill('zedzed');
		await expect(page.getByText('Function 2', { exact: true })).toBeVisible();
		await expect(page.getByText('Function 3', { exact: true })).toHaveCount(0);
	});

	test('the enable switch toggles, and reverts when the server refuses', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockFunctionsApi(page, [fn(1)]);
		await page.goto('/admin/functions');
		const sw = page.getByRole('switch', { name: 'Enable Function 1' });
		await expect(sw).toBeChecked();
		await sw.click();
		await expect(sw).not.toBeChecked();
		await expect.poll(() => calls.some((c) => c.path === '/id/fn_1/toggle')).toBe(true);
	});

	test('a refused toggle puts the switch back', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockFunctionsApi(page, [fn(1)], { failToggle: true });
		await page.goto('/admin/functions');
		const sw = page.getByRole('switch', { name: 'Enable Function 1' });
		await sw.click();
		await expect(sw).toBeChecked();
	});

	test('Global appears in the menu for filters and actions only, and toggles', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockFunctionsApi(page, [fn(1, { type: 'filter' }), fn(2, { type: 'pipe' })]);
		await page.goto('/admin/functions');
		// Newest first: fn_2 (pipe) then fn_1 (filter).
		const menus = page.getByRole('button', { name: 'Function Menu', exact: true });
		await menus.first().click();
		await expect(page.getByRole('switch', { name: 'Global' })).toHaveCount(0);
		await page.keyboard.press('Escape');
		await menus.last().click();
		const global = page.getByRole('switch', { name: 'Global' });
		await global.click();
		await expect.poll(() => calls.some((c) => c.path === '/id/fn_1/toggle/global')).toBe(true);
		// The menu stays open after using the switch.
		await expect(global).toBeChecked();
	});

	test('delete confirms first', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockFunctionsApi(page, [fn(1)]);
		await page.goto('/admin/functions');
		await page.getByRole('button', { name: 'Function Menu', exact: true }).click();
		await page.getByRole('menuitem', { name: 'Delete' }).click();
		await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
		await expect.poll(() => calls.some((c) => c.path === '/id/fn_1/delete')).toBe(true);
		await expect(page.getByText('No functions found')).toBeVisible();
	});

	test('create: the id follows the name, the warning gates the save, and only four fields are sent', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockFunctionsApi(page, []);
		await page.goto('/admin/functions/create');
		await expect(page.locator('.cm-content')).toContainText('class Filter');
		await page.getByLabel('Function Name').fill('My Cool Filter');
		await expect(page.getByLabel('Function ID')).toHaveValue('my_cool_filter');
		await page.getByLabel('Function Description').fill('does things');
		await page.getByRole('button', { name: 'Save & Create' }).click();
		// Nothing is sent until the warning is acknowledged.
		await expect(page.getByRole('alertdialog')).toContainText('Functions allow arbitrary code execution.');
		expect(calls.some((c) => c.path === '/create')).toBe(false);
		await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm' }).click();
		await expect.poll(() => calls.find((c) => c.path === '/create')?.body).toMatchObject({ id: 'my_cool_filter', name: 'My Cool Filter', meta: { description: 'does things' } });
		expect(Object.keys(calls.find((c) => c.path === '/create')!.body).sort()).toEqual(['content', 'id', 'meta', 'name']);
		await expect(page).toHaveURL(/\/admin\/functions$/);
	});

	test('the Event starter swaps the code', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockFunctionsApi(page, []);
		await page.goto('/admin/functions/create');
		await expect(page.locator('.cm-content')).toContainText('class Filter');
		await page.getByLabel('Function starter').selectOption('event');
		await expect(page.locator('.cm-content')).toContainText('class Event');
		await expect(page.locator('.cm-content')).not.toContainText('class Filter');
	});

	test('clone opens a pre-filled create page whose id no longer tracks the name', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockFunctionsApi(page, [fn(1)]);
		await page.goto('/admin/functions');
		await page.getByRole('button', { name: 'Function Menu', exact: true }).click();
		await page.getByRole('menuitem', { name: 'Clone' }).click();
		await expect(page).toHaveURL(/\/admin\/functions\/create$/);
		await expect(page.getByLabel('Function ID')).toHaveValue('fn_1_clone');
		await expect(page.getByLabel('Function Name')).toHaveValue('Function 1 (Clone)');
		await page.getByLabel('Function Name').fill('Renamed');
		await expect(page.getByLabel('Function ID')).toHaveValue('fn_1_clone');
	});

	test('edit: the id is fixed, and saving updates without asking', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockFunctionsApi(page, [fn(1)]);
		await page.goto('/admin/functions/edit?id=fn_1');
		await expect(page.getByLabel('Function Name')).toHaveValue('Function 1');
		await expect(page.getByLabel('Function ID')).toHaveCount(0);
		await page.getByLabel('Function Name').fill('Function One');
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect.poll(() => calls.find((c) => c.path === '/id/fn_1/update')?.body).toMatchObject({ id: 'fn_1', name: 'Function One' });
	});

	test('an unknown id on the edit page goes back to the list', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockFunctionsApi(page, [fn(1)]);
		await page.goto('/admin/functions/edit?id=missing');
		await expect(page).toHaveURL(/\/admin\/functions$/);
	});

	test('Import JSON unwraps the community format, warns first, and creates only the editable fields', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockFunctionsApi(page, [fn(1)]);
		await page.goto('/admin/functions');
		await page.getByRole('button', { name: 'Create' }).first().waitFor();
		const file = {
			name: 'fns.json',
			mimeType: 'application/json',
			buffer: Buffer.from(
				JSON.stringify([
					{ function: { id: 'imp', name: 'Imported', content: 'class Filter: pass', meta: { description: 'x' }, is_global: true, user_id: 'attacker' } },
					{ id: 'bad', name: 'No code' }
				])
			)
		};
		await page.locator('#documents-import-input').setInputFiles(file);
		await expect(page.getByRole('alertdialog')).toContainText('Functions allow arbitrary code execution.');
		await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm' }).click();
		await expect.poll(() => calls.filter((c) => c.path === '/create').length).toBe(1);
		const created = calls.find((c) => c.path === '/create')!.body;
		expect(created).toEqual({ id: 'imp', name: 'Imported', content: 'class Filter: pass', meta: { description: 'x' } });
	});

	test('a message from an unexpected origin does not replace the create form', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockFunctionsApi(page, []);
		await page.goto('/admin/functions/create');
		await page.getByLabel('Function Name').fill('Mine');
		// Same-origin (localhost:5174), which is not one of the community origins.
		await page.evaluate(() => window.postMessage(JSON.stringify({ id: 'evil', name: 'Evil', content: 'x = 1', meta: { description: 'e' } }), '*'));
		await page.waitForTimeout(300);
		await expect(page.getByLabel('Function Name')).toHaveValue('Mine');
	});
});
