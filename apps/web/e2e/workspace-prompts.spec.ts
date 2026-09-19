import { expect, test } from './test';
import type { Page } from '@playwright/test';
import { mockWorkspaceBackend } from './workspace-helpers';

type Prompt = {
	id: string;
	name: string;
	command: string;
	content: string;
	is_active: boolean;
	write_access: boolean;
	created_at: number;
	updated_at: number;
	version_id: string;
	tags: string[];
	access_grants: unknown[];
	user: { id: string; name: string; email: string };
};

const owner = { id: 'u1', name: 'test user', email: 'u@example.com' };
const makePrompt = (n: number, overrides: Partial<Prompt> = {}): Prompt => ({
	id: `p${n}`,
	name: `Prompt ${n}`,
	command: `prompt-${n}`,
	content: `Content of prompt ${n}`,
	is_active: true,
	write_access: true,
	created_at: 1700000000,
	updated_at: 1700000000 + n,
	version_id: `v${n}-2`,
	tags: [],
	access_grants: [],
	user: owner,
	...overrides
});

type Recorded = { method: string; path: string; search: string; body: unknown };

/**
 * A small stateful stand-in for /api/v1/prompts/**. Everything the specs
 * assert on the *request* side (query params sent, bodies posted) goes through
 * `calls`, so a test can check what the page actually asked for rather than
 * only what it rendered.
 */
async function mockPromptsApi(page: Page, initial: Prompt[]) {
	const state = { prompts: [...initial] };
	const calls: Recorded[] = [];
	const history: Record<string, unknown[]> = {};

	await page.route('**/api/v1/prompts/**', async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const path = url.pathname.replace('/api/v1/prompts', '');
		const method = req.method();
		let body: unknown = null;
		try {
			body = req.postDataJSON();
		} catch {
			/* no body */
		}
		calls.push({ method, path, search: url.search, body });
		const json = (data: unknown, status = 200) =>
			route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });

		if (path === '/tags') return json(['writing', 'code']);
		if (path === '/list') {
			const q = (url.searchParams.get('query') ?? '').toLowerCase();
			const items = state.prompts.filter((p) => p.name.toLowerCase().includes(q));
			return json({ items, total: items.length });
		}
		if (path === '/create' && method === 'POST') {
			const draft = body as Partial<Prompt>;
			const created = makePrompt(state.prompts.length + 1, { ...draft, id: 'created-1' });
			state.prompts.unshift(created);
			return json(created);
		}
		const idMatch = path.match(/^\/id\/([^/]+)(\/.*)?$/);
		if (idMatch) {
			const [, id, rest = ''] = idMatch;
			const prompt = state.prompts.find((p) => p.id === id);
			if (!prompt) return json({ detail: 'Not found' }, 404);
			if (rest === '' && method === 'GET') return json(prompt);
			if (rest === '/toggle') {
				prompt.is_active = !prompt.is_active;
				return json(prompt);
			}
			if (rest === '/delete') {
				state.prompts = state.prompts.filter((p) => p.id !== id);
				return json(true);
			}
			if (rest === '/history') {
				return json(
					url.searchParams.get('page') === '0'
						? (history[id] ?? [
								{
									id: `v${id.slice(1)}-2`,
									commit_message: 'Second draft',
									created_at: 1700000100,
									snapshot: { content: 'Newest content' },
									user: { id: 'u1', name: 'Test User' }
								},
								{
									id: `v${id.slice(1)}-1`,
									commit_message: null,
									created_at: 1700000000,
									snapshot: { content: 'Original content' },
									user: { id: 'u1', name: 'Test User' }
								}
							])
						: []
				);
			}
			if (rest === '/update/meta') return json({ ...prompt, ...(body as object) });
			if (rest === '/update/version') return json(prompt);
			if (rest === '/access/update') return json(prompt);
			if (rest === '/update') {
				Object.assign(prompt, body, { version_id: 'v-new' });
				return json(prompt);
			}
		}
		return json({ items: [], total: 0 });
	});
	return { state, calls };
}

test.describe('workspace prompts', () => {
	test('lists prompts, searches (debounced, server-side) and sorts', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockPromptsApi(page, [makePrompt(1), makePrompt(2)]);
		await page.goto('/workspace/prompts');

		await expect(page.getByText('Prompt 1', { exact: true })).toBeVisible();
		await expect(page.getByText('/prompt-2')).toBeVisible();
		await expect(page.getByText('Content of prompt 1')).toBeVisible();

		const before = calls.filter((c) => c.path === '/list').length;
		await page.getByLabel('Search Prompts').fill('2');
		await expect(page.getByText('Prompt 1', { exact: true })).toHaveCount(0);
		await expect(page.getByText('Prompt 2', { exact: true })).toBeVisible();
		// One request for the settled query, not one per keystroke.
		const searches = calls.filter((c) => c.path === '/list').slice(before);
		expect(searches.every((c) => c.search.includes('query=2'))).toBe(true);

		await page.getByLabel('Clear search').click();
		await expect(page.getByText('Prompt 1', { exact: true })).toBeVisible();
		await page.getByRole('button', { name: 'Title' }).click();
		await expect
			.poll(() => calls.some((c) => c.search.includes('order_by=name') && c.search.includes('direction=asc')))
			.toBe(true);
	});

	test('the enable switch toggles optimistically and calls the API', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockPromptsApi(page, [makePrompt(1)]);
		await page.goto('/workspace/prompts');
		const toggle = page.getByRole('switch', { name: 'Enabled' });
		await expect(toggle).toBeChecked();
		await toggle.click();
		await expect(page.getByRole('switch', { name: 'Disabled' })).not.toBeChecked();
		await expect.poll(() => calls.some((c) => c.path === '/id/p1/toggle')).toBe(true);
	});

	test('delete asks first, then removes the row', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockPromptsApi(page, [makePrompt(1), makePrompt(2)]);
		await page.goto('/workspace/prompts');
		await page.getByRole('button', { name: 'Prompt Menu', exact: true }).first().click();
		await page.getByRole('menuitem', { name: 'Delete' }).click();
		const dialog = page.getByRole('alertdialog');
		await expect(dialog).toContainText('This will delete');
		await dialog.getByRole('button', { name: 'Delete' }).click();
		await expect.poll(() => calls.some((c) => c.method === 'DELETE' || c.path.endsWith('/delete'))).toBe(true);
		await expect(page.getByText('Prompt 1', { exact: true }).or(page.getByText('Prompt 2', { exact: true }))).toHaveCount(1);
	});

	test('create: the command follows the name until edited, then posts the draft', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockPromptsApi(page, [makePrompt(1)]);
		await page.goto('/workspace/prompts/create');

		const dialog = page.getByRole('dialog');
		await expect(dialog.getByText('Create Prompt')).toBeVisible();
		await dialog.getByLabel('Name').fill('Summarise This Thing');
		await expect(dialog.getByLabel('Command')).toHaveValue('summarise-this-thing');
		await dialog.getByLabel('Prompt Content').fill('Summarise {{topic}}');
		await dialog.getByRole('button', { name: /Save & Create/ }).click();

		await expect(page).toHaveURL(/\/workspace\/prompts$/);
		const create = calls.find((c) => c.path === '/create');
		expect(create?.body).toMatchObject({
			name: 'Summarise This Thing',
			command: 'summarise-this-thing',
			content: 'Summarise {{topic}}',
			tags: [],
			access_grants: []
		});
	});

	test('create: a command with illegal characters is rejected before any request', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockPromptsApi(page, []);
		await page.goto('/workspace/prompts/create');
		const dialog = page.getByRole('dialog');
		await dialog.getByLabel('Name').fill('Ok name');
		await dialog.getByLabel('Command').fill('has spaces!');
		await dialog.getByLabel('Prompt Content').fill('x');
		await dialog.getByRole('button', { name: /Save & Create/ }).click();
		await expect(page.getByText('Only alphanumeric characters and hyphens are allowed')).toBeVisible();
		expect(calls.some((c) => c.path === '/create')).toBe(false);
	});

	test('clone opens the create dialog pre-filled', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockPromptsApi(page, [makePrompt(1)]);
		await page.goto('/workspace/prompts');
		await page.getByRole('button', { name: 'Prompt Menu', exact: true }).click();
		await page.getByRole('menuitem', { name: 'Clone' }).click();
		const dialog = page.getByRole('dialog');
		await expect(dialog.getByLabel('Name')).toHaveValue('Prompt 1 (Clone)');
		await expect(dialog.getByLabel('Command')).toHaveValue('prompt-1-clone');
		await expect(dialog.getByLabel('Prompt Content')).toHaveValue('Content of prompt 1');
	});

	test('edit page: shows history, promotes a version, and autosaves metadata', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockPromptsApi(page, [makePrompt(1)]);
		await page.goto('/workspace/prompts/p1');

		// History renders, the production version (v1-2) is selected and marked Live.
		await expect(page.getByText('Second draft')).toBeVisible();
		await expect(page.getByText('Update', { exact: true })).toBeVisible(); // null commit message
		await expect(page.locator('pre')).toHaveText('Newest content');

		// Selecting the older version shows its content and offers to promote it.
		await page.getByText('Update', { exact: true }).click();
		await expect(page.locator('pre')).toHaveText('Original content');
		await page.getByRole('button', { name: 'Set as Production' }).click();
		await expect.poll(() => calls.some((c) => c.path === '/id/p1/update/version')).toBe(true);
		await expect(page.getByText('Production version updated')).toBeVisible();

		// Name edits save themselves after a pause, as ONE request for the settled value.
		await page.getByLabel('Prompt Name').fill('Renamed');
		await expect.poll(() => calls.filter((c) => c.path === '/id/p1/update/meta').length).toBe(1);
		expect(calls.find((c) => c.path === '/id/p1/update/meta')?.body).toMatchObject({
			name: 'Renamed',
			command: 'prompt-1'
		});
	});

	test('edit page: an invalid command reverts locally without calling the API', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockPromptsApi(page, [makePrompt(1)]);
		await page.goto('/workspace/prompts/p1');
		await page.getByLabel('Command').fill('bad command');
		await expect(page.getByText('Only alphanumeric characters and hyphens are allowed')).toBeVisible();
		await expect(page.getByLabel('Command')).toHaveValue('prompt-1');
		expect(calls.some((c) => c.path.endsWith('/update/meta'))).toBe(false);
	});

	test('edit page: a read-only prompt cannot be edited', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockPromptsApi(page, [makePrompt(1, { write_access: false })]);
		await page.goto('/workspace/prompts/p1');
		await expect(page.getByText('Read Only')).toBeVisible();
		await expect(page.getByLabel('Prompt Name')).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
	});

	test('edit page: saving a new version posts the content and reloads history', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockPromptsApi(page, [makePrompt(1)]);
		await page.goto('/workspace/prompts/p1');
		await page.getByRole('button', { name: 'Edit', exact: true }).click();
		const dialog = page.getByRole('dialog');
		await dialog.getByLabel('Prompt Content').fill('Brand new content');
		await dialog.getByLabel('Commit Message').fill('rewrite');
		await dialog.getByRole('button', { name: 'Save', exact: true }).click();
		await expect.poll(() => calls.find((c) => c.path === '/id/p1/update')?.body).toMatchObject({
			id: 'p1',
			content: 'Brand new content',
			commit_message: 'rewrite',
			is_production: true
		});
		await expect(page.getByText('Prompt updated successfully')).toBeVisible();
	});

	test('access control: changing visibility saves the new grants', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockPromptsApi(page, [makePrompt(1)]);
		await page.route('**/api/v1/groups/**', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
		);
		await page.goto('/workspace/prompts/p1');
		await page.getByRole('button', { name: 'Access' }).click();
		const dialog = page.getByRole('dialog');
		await expect(dialog.getByText('Only select users and groups with permission can access')).toBeVisible();
		await dialog.getByLabel('Visibility').selectOption('public');
		await expect(dialog.getByText('Accessible to all users')).toBeVisible();
		await expect
			.poll(() => calls.find((c) => c.path === '/id/p1/access/update')?.body)
			.toMatchObject({ access_grants: [{ principal_type: 'user', principal_id: '*', permission: 'read' }] });
		// A public item offers the write switch (roles include write here).
		await expect(dialog.getByRole('switch', { name: 'Allow public write access' })).toBeVisible();
	});
});
