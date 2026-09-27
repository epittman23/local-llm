import type { Page } from '@playwright/test';
import { expect, test } from './test';
import { mockWorkspaceBackend } from './workspace-helpers';

type Rec = Record<string, any>;
const json = (route: any, d: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(d) });
const nowNs = () => Date.now() * 1_000_000;

const note = (id: string, title: string, extra: Rec = {}) => ({
	id,
	title,
	user_id: 'u1',
	user: { name: 'Test User' },
	write_access: true,
	is_pinned: false,
	updated_at: nowNs(),
	access_grants: [],
	data: { content: { json: null, html: `<p>Body of ${title}</p>`, md: `Body of ${title}` } },
	...extra
});

async function mockNotes(page: Page, notes: Rec[] = []) {
	const seen = { searches: [] as string[], created: [] as Rec[], updates: [] as Rec[], access: [] as Rec[], pinned: [] as string[], deleted: [] as string[], completions: [] as Rec[] };
	const byId = new Map(notes.map((n) => [n.id, n]));
	await page.route('**/api/v1/notes/**', async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const path = url.pathname.replace('/api/v1/notes', '');
		if (path === '/search') {
			seen.searches.push(url.search);
			// One page of results, then an empty page (the end).
			return json(route, Number(url.searchParams.get('page') ?? 1) > 1 ? { items: [], total: notes.length } : { items: notes, total: notes.length });
		}
		if (path === '/create') {
			const body = req.postDataJSON();
			seen.created.push(body);
			const created = note(`n${seen.created.length + 10}`, body.title, { data: body.data });
			byId.set(created.id, created);
			return json(route, created);
		}
		if (path === '/pinned') return json(route, []);
		const [, id, action] = path.split('/');
		if (action === 'update') {
			seen.updates.push(req.postDataJSON());
			return json(route, { ...byId.get(id), ...req.postDataJSON() });
		}
		if (action === 'access') {
			seen.access.push(req.postDataJSON());
			return json(route, byId.get(id));
		}
		if (action === 'pin') {
			seen.pinned.push(id);
			return json(route, true);
		}
		if (action === 'delete') {
			seen.deleted.push(id);
			return json(route, true);
		}
		return byId.has(id) ? json(route, byId.get(id)) : json(route, { detail: 'Not found' }, 404);
	});
	await page.route('**/api/chat/completions', (route) => {
		seen.completions.push(route.request().postDataJSON());
		return json(route, { choices: [{ message: { content: 'Here: {"title": "Grocery Plan"}' } }] });
	});
	await page.route('**/api/v1/users/user/settings', (route) => json(route, { ui: { models: ['qwen'] } }));
	return seen;
}

const enabled = { features: { enable_notes: true } };

test('with notes turned off the page sends you home', async ({ page }) => {
	await mockWorkspaceBackend(page);
	await mockNotes(page);
	await page.goto('/notes');
	await expect(page).toHaveURL(/localhost:5174\/$/);
});

test('lists notes grouped by time; search and sort go to the server; grid shows a preview', async ({ page }) => {
	await mockWorkspaceBackend(page, enabled);
	const seen = await mockNotes(page, [note('a', 'Groceries'), note('b', 'Old idea', { updated_at: new Date('2025-02-01').getTime() * 1_000_000 })]);
	await page.goto('/notes');
	await expect(page.getByRole('region', { name: 'Today' }).getByRole('link', { name: /Groceries/ })).toBeVisible();
	await expect(page.getByRole('region', { name: '2025' })).toBeVisible();
	await page.getByLabel('Search Notes').fill('groc');
	await expect.poll(() => seen.searches.some((q) => new URLSearchParams(q).get('query') === 'groc')).toBe(true);
	await page.getByRole('button', { name: 'Title' }).click();
	await expect.poll(() => seen.searches.some((q) => new URLSearchParams(q).get('order_by') === 'name' && new URLSearchParams(q).get('direction') === 'asc')).toBe(true);
	await page.getByLabel('Display').selectOption('grid');
	await expect(page.getByText('Body of Groceries')).toBeVisible();
});

test('Create makes a dated note and opens it; ?title= makes one from a link', async ({ page }) => {
	await mockWorkspaceBackend(page, enabled);
	const seen = await mockNotes(page);
	await page.goto('/notes');
	await page.getByRole('button', { name: 'Create', exact: true }).click();
	await expect(page).toHaveURL(/\/notes\/n11$/);
	expect(seen.created[0]).toMatchObject({ title: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), data: { content: { json: null, html: '', md: '' } }, access_grants: [] });
	await page.goto('/notes/new?title=From%20link&content=%23%20Hello');
	await expect(page).toHaveURL(/\/notes\/n12$/);
	expect(seen.created[1]).toMatchObject({ title: 'From link', data: { content: { md: '# Hello', html: expect.stringContaining('<h1>Hello</h1>') } } });
});

test('importing: md/txt become notes, anything else is refused', async ({ page }) => {
	await mockWorkspaceBackend(page, enabled);
	const seen = await mockNotes(page);
	await page.goto('/notes');
	await page.getByLabel('Import note files').setInputFiles([{ name: 'Plan.md', mimeType: 'text/markdown', buffer: Buffer.from('- a\n- b') }]);
	await expect.poll(() => seen.created[0]?.title).toBe('Plan');
	expect(seen.created[0].data.content.md).toBe('- a\n- b');
	await page.getByLabel('Import note files').setInputFiles([{ name: 'x.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') }]);
	await expect(page.getByText('Only txt and md files are allowed')).toBeVisible();
});

test('editing autosaves the title and the body as html, markdown and json', async ({ page }) => {
	await mockWorkspaceBackend(page, enabled);
	const seen = await mockNotes(page, [note('a', 'Groceries')]);
	await page.goto('/notes/a');
	const editor = page.getByRole('textbox', { name: 'Note content' });
	await expect(editor).toContainText('Body of Groceries');
	await page.getByLabel('Title', { exact: true }).fill('Weekly groceries');
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.press('Enter');
	await page.keyboard.type('## Produce');
	await expect.poll(() => seen.updates.at(-1)?.data?.content?.md).toBe('Body of Groceries\n\n## Produce');
	const last = seen.updates.at(-1)!;
	expect(last.title).toBe('Weekly groceries');
	expect(last.data.content.html).toContain('<h2>Produce</h2>');
	expect(last.data.content.json).toMatchObject({ type: 'doc' });
	expect(last).not.toHaveProperty('access_grants');
	await expect(page.getByText(/^\d+ words · \d+ characters$/)).toBeVisible();
});

test('leaving right after typing still saves the last edit', async ({ page }) => {
	await mockWorkspaceBackend(page, enabled);
	const seen = await mockNotes(page, [note('a', 'Groceries')]);
	await page.goto('/notes/a');
	await page.getByLabel('Title', { exact: true }).fill('Quick rename');
	await page.getByRole('link', { name: 'Back to notes' }).click();
	await expect.poll(() => seen.updates.at(-1)?.title).toBe('Quick rename');
});

test('generate title uses the chosen model; the menu pins and deletes', async ({ page }) => {
	await mockWorkspaceBackend(page, enabled);
	const seen = await mockNotes(page, [note('a', 'Untitled')]);
	await page.goto('/notes/a');
	await page.getByRole('button', { name: 'Generate title' }).click();
	await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Grocery Plan');
	expect(seen.completions[0]).toMatchObject({ model: 'qwen', stream: false });
	expect(seen.completions[0].messages[0].content).toContain('Body of Untitled');
	await page.getByRole('button', { name: 'Note menu' }).click();
	await page.getByRole('menuitem', { name: 'Pin to Sidebar' }).click();
	await expect.poll(() => seen.pinned).toEqual(['a']);
	await page.getByRole('button', { name: 'Note menu' }).click();
	await page.getByRole('menuitem', { name: 'Delete' }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
	await expect(page).toHaveURL(/\/notes$/);
	expect(seen.deleted).toEqual(['a']);
});

test('a note without write access is read-only; an unknown note goes back to the list', async ({ page }) => {
	await mockWorkspaceBackend(page, enabled);
	await mockNotes(page, [note('r', 'Shared', { write_access: false })]);
	await page.goto('/notes/r');
	await expect(page.getByText('Read only')).toBeVisible();
	await expect(page.getByRole('textbox', { name: 'Note content' })).toHaveAttribute('contenteditable', 'false');
	await expect(page.getByRole('button', { name: 'Generate title' })).toHaveCount(0);
	await page.goto('/notes/missing');
	await expect(page).toHaveURL(/\/notes$/);
});
