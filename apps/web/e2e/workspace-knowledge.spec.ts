import { expect, test } from './test';
import type { Page } from '@playwright/test';
import { mockWorkspaceBackend } from './workspace-helpers';

type Call = { method: string; path: string; search: string; body: any };

const kb = (n: number, o: Record<string, any> = {}) => ({
	id: `kb${n}`,
	name: `Base ${n}`,
	description: `About base ${n}`,
	updated_at: 1700000000 + n,
	file_count: n,
	write_access: true,
	access_grants: [],
	meta: null,
	user: { name: 'Test User', email: 'u@example.com' },
	...o
});

/** A tiny in-memory knowledge API: bases, a folder tree, files, and every write the page can make. */
async function mockKnowledgeApi(page: Page, bases: any[], opts: { pending?: any[] } = {}) {
	const calls: Call[] = [];
	const state = {
		bases,
		dirs: [{ id: 'dir1', name: 'Reports', created_at: 1700000000, updated_at: 1700000001, parent: null as string | null }],
		files: [
			{ id: 'f1', dir: null as string | null, meta: { name: 'intro.txt', size: 2048 }, updated_at: 1700000002, data: { content: 'Hello intro' }, user: { name: 'Test User', email: 'u@example.com' } },
			{ id: 'f2', dir: 'dir1', meta: { name: 'q1.txt', size: 10 }, updated_at: 1700000003, data: { content: 'Q1 numbers' }, user: null }
		]
	};
	const json = (data: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(data) });

	await page.route('**/api/v1/knowledge/**', async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const path = url.pathname.replace('/api/v1/knowledge', '');
		let body: any = null;
		try {
			body = req.postDataJSON();
		} catch {
			/* none */
		}
		calls.push({ method: req.method(), path, search: url.search, body });

		if (path === '/search') {
			const q = (url.searchParams.get('query') ?? '').toLowerCase();
			const items = state.bases.filter((b) => b.name.toLowerCase().includes(q));
			// One page only: an empty page 2 ends the infinite scroll.
			return route.fulfill(json(url.searchParams.get('page') === '1' ? { items, total: items.length } : { items: [], total: items.length }));
		}
		if (path === '/create') return route.fulfill(json({ id: 'new-kb', ...body }));
		const m = path.match(/^\/([^/]+)(\/.*)?$/);
		if (!m) return route.fulfill(json({}));
		const base = state.bases.find((b) => b.id === m[1]);
		const rest = m[2] ?? '';
		if (!base) return route.fulfill(json({ detail: 'Not found' }, 404));
		if (rest === '') return route.fulfill(json(base));
		if (rest === '/files') {
			const dirId = url.searchParams.get('directory_id');
			const current = dirId ? state.dirs.find((d) => d.id === dirId) : null;
			return route.fulfill(
				json({
					items: state.files.filter((f) => f.dir === (dirId || null)),
					total: state.files.filter((f) => f.dir === (dirId || null)).length,
					directories: state.dirs.filter((d) => d.parent === (dirId || null)),
					breadcrumbs: current ? [{ id: current.id, name: current.name }] : []
				})
			);
		}
		if (rest === '/files/pending') return route.fulfill(json(opts.pending ?? []));
		if (rest === '/file/remove') {
			state.files = state.files.filter((f) => f.id !== body?.file_id);
			return route.fulfill(json(base));
		}
		if (rest === '/file/move') {
			const f = state.files.find((x) => x.id === body?.file_id);
			if (f) f.dir = body?.directory_id ?? null;
			return route.fulfill(json(true));
		}
		if (rest === '/dirs/create') {
			state.dirs.push({ id: `d-${state.dirs.length}`, name: body.name, created_at: 1, updated_at: 1, parent: body.parent_id ?? null });
			return route.fulfill(json({ id: 'd-new' }));
		}
		if (rest === '/file/add') return route.fulfill(json(base));
		if (rest === '/reset') return route.fulfill(json(base));
		if (rest === '/update' || rest === '/access/update' || rest === '/delete') return route.fulfill(json(base));
		if (rest.startsWith('/dirs/')) return route.fulfill(json(true));
		return route.fulfill(json({}));
	});

	await page.route('**/api/v1/files/**', async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const path = url.pathname.replace('/api/v1/files', '');
		let body: any = null;
		try {
			body = req.postDataJSON();
		} catch {
			/* multipart */
		}
		calls.push({ method: req.method(), path, search: url.search, body: body ?? req.postData() });
		if (req.method() === 'POST' && (path === '/' || path === '')) return route.fulfill(json({ id: 'uploaded-1', meta: { name: 'x' } }));
		if (path.endsWith('/process/status')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"status":"completed"}\n\ndata: [DONE]\n\n' });
		const f = state.files.find((x) => path === `/${x.id}`);
		if (f) return route.fulfill(json({ ...f, data: undefined }));
		return route.fulfill(json(true));
	});
	await page.route('**/api/v1/retrieval/process/url**', (route) => {
		const url = new URL(route.request().url());
		calls.push({ method: 'POST', path: '/retrieval/process/url', search: url.search, body: route.request().postDataJSON() });
		return route.fulfill(json({ type: 'web', content: 'Page body', file: null }));
	});
	return { calls, state };
}

test.describe('workspace knowledge list', () => {
	test('lists bases with file counts, badges connected ones read-only, and searches server-side', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockKnowledgeApi(page, [
			kb(1),
			kb(2, { write_access: false }),
			kb(3, { meta: { source: 'external', external: { provider: 'Drive' } } })
		]);
		await page.goto('/workspace/knowledge');
		await expect(page.getByText('Base 1', { exact: true })).toBeVisible();
		await expect(page.getByText('1 file · About base 1')).toBeVisible();
		await expect(page.getByText('Drive', { exact: true })).toBeVisible();
		await expect(page.getByText('Read Only')).toHaveCount(2); // Base 2, and connected Base 3

		await page.getByLabel('Search Knowledge').fill('Base 2');
		await expect(page.getByText('Base 1', { exact: true })).toHaveCount(0);
		expect(calls.some((c) => c.path === '/search' && c.search.includes('query=Base+2'))).toBe(true);
	});

	test('create dialog posts the form and opens the new base', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockKnowledgeApi(page, [kb(1)]);
		await page.route('**/api/v1/groups/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
		await page.goto('/workspace/knowledge/create');
		const dialog = page.getByRole('dialog');
		await dialog.getByLabel('Name').fill('Handbook');
		await dialog.getByLabel('Description').fill('Everything about us');
		await dialog.getByRole('button', { name: 'Create Knowledge' }).click();
		await expect(page).toHaveURL(/\/workspace\/knowledge\/new-kb$/);
		expect(calls.find((c) => c.path === '/create')?.body).toMatchObject({ name: 'Handbook', description: 'Everything about us', access_grants: [] });
	});

	test('a document-type item cannot be opened', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockKnowledgeApi(page, [kb(1, { meta: { document: true } })]);
		await page.goto('/workspace/knowledge');
		await page.getByText('Base 1', { exact: true }).click();
		await expect(page.getByText('Only collections can be edited')).toBeVisible();
		await expect(page).toHaveURL(/\/workspace\/knowledge$/);
	});
});

test.describe('workspace knowledge base', () => {
	test('shows folders then files, navigates into a folder with breadcrumbs, and back', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockKnowledgeApi(page, [kb(1)]);
		await page.goto('/workspace/knowledge/kb1');
		await expect(page.getByLabel('Knowledge Name')).toHaveValue('Base 1');
		await expect(page.getByText('Reports', { exact: true })).toBeVisible();
		await expect(page.getByText('intro.txt')).toBeVisible();
		await expect(page.getByText('2.0 KB')).toBeVisible();
		await expect(page.getByText('q1.txt')).toHaveCount(0);

		await page.getByRole('button', { name: 'Open Reports' }).click();
		await expect(page.getByText('q1.txt')).toBeVisible();
		await expect(page.getByText('intro.txt')).toHaveCount(0);
		// Breadcrumb: root (the base's name) > Reports; root goes back up.
		const crumbs = page.locator('div.flex.min-w-0.flex-1.items-center.overflow-x-auto');
		await expect(crumbs.getByRole('button', { name: 'Reports' })).toBeVisible();
		await crumbs.getByRole('button', { name: 'Base 1' }).click();
		await expect(page.getByText('intro.txt')).toBeVisible();
	});

	test('uploading a file posts it with the knowledge id and the current folder', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockKnowledgeApi(page, [kb(1)]);
		await page.goto('/workspace/knowledge/kb1');
		await page.getByRole('button', { name: 'Open Reports' }).click();
		await expect(page.getByText('q1.txt')).toBeVisible();

		await page.locator('#files-input').setInputFiles({ name: 'new.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
		await expect(page.getByText('File added successfully.')).toBeVisible();
		const post = calls.find((c) => c.method === 'POST' && c.path === '/');
		expect(String(post?.body)).toContain('"knowledge_id":"kb1"');
		expect(String(post?.body)).toContain('"directory_id":"dir1"');
	});

	test('an empty file is refused without any request', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockKnowledgeApi(page, [kb(1)]);
		await page.goto('/workspace/knowledge/kb1');
		await page.locator('#files-input').setInputFiles({ name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.from('') });
		await expect(page.getByText('You cannot upload an empty file.')).toBeVisible();
		expect(calls.some((c) => c.method === 'POST' && c.path === '/')).toBe(false);
	});

	test('add text content uploads a .txt file; add webpage keeps only valid, unique URLs', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockKnowledgeApi(page, [kb(1)]);
		await page.goto('/workspace/knowledge/kb1');

		await page.getByRole('button', { name: 'Add Content' }).click();
		await page.getByRole('menuitem', { name: 'Add text content' }).click();
		let dialog = page.getByRole('dialog');
		await dialog.getByLabel('Title').fill('Notes');
		await dialog.getByLabel('Content').fill('Some notes');
		await dialog.getByRole('button', { name: 'Save' }).click();
		await expect.poll(() => String(calls.find((c) => c.method === 'POST' && c.path === '/')?.body ?? '')).toContain('Notes.txt');

		await page.getByRole('button', { name: 'Add Content' }).click();
		await page.getByRole('menuitem', { name: 'Add webpage' }).click();
		dialog = page.getByRole('dialog');
		await dialog.getByLabel('Webpage URLs').fill('not a url\nhttps://example.com/a\nhttps://example.com/a\njavascript:alert(1)');
		await dialog.getByRole('button', { name: 'Add' }).click();
		// Only the one valid, de-duplicated http(s) URL is fetched.
		await expect.poll(() => calls.filter((c) => c.path === '/retrieval/process/url').map((c) => c.body?.url)).toEqual(['https://example.com/a']);
	});

	test('new directory, delete file, and reset all call the API', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockKnowledgeApi(page, [kb(1)]);
		await page.goto('/workspace/knowledge/kb1');

		await page.getByRole('button', { name: 'Add Content' }).click();
		await page.getByRole('menuitem', { name: 'New directory' }).click();
		await page.getByRole('dialog').getByLabel('Name').fill('Archive');
		await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
		await expect.poll(() => calls.find((c) => c.path === '/kb1/dirs/create' || c.path.endsWith('/dirs/create'))?.body).toMatchObject({ name: 'Archive' });

		await page.getByRole('button', { name: 'intro.txt menu' }).click();
		await page.getByRole('menuitem', { name: 'Delete' }).click();
		await expect.poll(() => calls.find((c) => c.path.endsWith('/file/remove'))?.body).toMatchObject({ file_id: 'f1' });

		await page.getByRole('button', { name: 'Add Content' }).click();
		await page.getByRole('menuitem', { name: 'Reset' }).click();
		await expect(page.getByRole('alertdialog')).toContainText('cannot be undone');
		await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm' }).click();
		await expect.poll(() => calls.some((c) => c.path.endsWith('/reset'))).toBe(true);
	});

	test('the name saves itself after a pause; a blank name does not save', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockKnowledgeApi(page, [kb(1)]);
		await page.goto('/workspace/knowledge/kb1');
		await page.getByLabel('Knowledge Name').fill('Renamed base');
		await expect.poll(() => calls.filter((c) => c.path === '/kb1/update' || c.path.endsWith('/update')).length).toBe(1);
		expect(calls.find((c) => c.path.endsWith('/update'))?.body).toMatchObject({ name: 'Renamed base', description: 'About base 1' });

		await page.getByLabel('Knowledge Name').fill('');
		await expect(page.getByText('Please fill in all fields.')).toBeVisible();
		expect(calls.filter((c) => c.path.endsWith('/update')).length).toBe(1);
	});

	test('opening a file shows its text in a sheet and saves edits', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockKnowledgeApi(page, [kb(1)]);
		await page.goto('/workspace/knowledge/kb1');
		await page.getByRole('button', { name: 'Open intro.txt' }).click();
		const sheet = page.getByRole('dialog');
		await expect(sheet.getByLabel('File content')).toHaveValue('Hello intro');
		await sheet.getByLabel('File content').fill('Edited intro');
		await sheet.getByRole('button', { name: 'Save' }).click();
		await expect.poll(() => calls.find((c) => c.path === '/f1/data/content/update')?.body).toMatchObject({ content: 'Edited intro' });
	});

	test('a read-only base has no add menu, no rename and no access button', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockKnowledgeApi(page, [kb(1, { write_access: false })]);
		await page.goto('/workspace/knowledge/kb1');
		await expect(page.getByText('intro.txt')).toBeVisible();
		await expect(page.getByText('Read Only')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Add Content' })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Access' })).toHaveCount(0);
		await expect(page.getByLabel('Knowledge Name')).toBeDisabled();
	});

	test('a connected base shows its source and a working test query instead of files', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockKnowledgeApi(page, [
			kb(1, { write_access: false, meta: { source: 'external', external: { provider: 'Drive', connection_id: 'c1', source: { name: 'Team docs' } } } })
		]);
		await page.route('**/api/v1/knowledge/external/connections/c1/**', (route) => {
			calls.push({ method: 'POST', path: '/external-test', search: '', body: route.request().postDataJSON() });
			return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ documents: ['A matching passage'], metadatas: [{ source: 'doc.pdf' }] }) });
		});
		await page.goto('/workspace/knowledge/kb1');
		await expect(page.getByText('Team docs')).toBeVisible();
		await expect(page.getByText('intro.txt')).toHaveCount(0);
		await page.getByLabel('Test Query').fill('what is x?');
		await page.getByRole('button', { name: 'Test', exact: true }).click();
		await expect(page.getByText('A matching passage')).toBeVisible();
		await expect(page.getByText('doc.pdf')).toBeVisible();
	});

	test('an unknown base returns to the list', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockKnowledgeApi(page, [kb(1)]);
		await page.goto('/workspace/knowledge/nope');
		await expect(page).toHaveURL(/\/workspace\/knowledge$/);
	});
});
