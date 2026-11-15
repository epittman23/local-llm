import type { Page } from '@playwright/test';
import { expect, test } from './test';
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
		dirs: [
			{ id: 'dir1', name: 'Reports', created_at: 1700000000, updated_at: 1700000001, parent: null as string | null }
		],
		files: [
			{
				id: 'f1',
				dir: null as string | null,
				meta: { name: 'intro.txt', size: 2048 },
				updated_at: 1700000002,
				data: { content: 'Hello intro' },
				user: { name: 'Test User', email: 'u@example.com' }
			},
			{
				id: 'f2',
				dir: 'dir1',
				meta: { name: 'q1.txt', size: 10 },
				updated_at: 1700000003,
				data: { content: 'Q1 numbers' },
				user: null
			}
		]
	};
	const json = (data: unknown, status = 200) => ({
		status,
		contentType: 'application/json',
		body: JSON.stringify(data)
	});

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
			return route.fulfill(
				json(url.searchParams.get('page') === '1' ? { items, total: items.length } : { items: [], total: items.length })
			);
		}
		if (path === '/create') {
			// Kept, as the server keeps it: the page it opens loads it back by id.
			const created = kb(0, { id: 'new-kb', name: body.name, description: body.description, file_count: 0 });
			state.bases.push(created);
			return route.fulfill(json(created));
		}
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
			state.dirs.push({
				id: `d-${state.dirs.length}`,
				name: body.name,
				created_at: 1,
				updated_at: 1,
				parent: body.parent_id ?? null
			});
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
		if (req.method() === 'POST' && (path === '/' || path === ''))
			return route.fulfill(json({ id: 'uploaded-1', meta: { name: 'x' } }));
		if (path.endsWith('/process/status'))
			return route.fulfill({
				status: 200,
				contentType: 'text/event-stream',
				body: 'data: {"status":"completed"}\n\ndata: [DONE]\n\n'
			});
		const f = state.files.find((x) => path === `/${x.id}`);
		if (f) return route.fulfill(json({ ...f, data: undefined }));
		return route.fulfill(json(true));
	});
	await page.route('**/api/v1/retrieval/process/url**', (route) => {
		const url = new URL(route.request().url());
		calls.push({
			method: 'POST',
			path: '/retrieval/process/url',
			search: url.search,
			body: route.request().postDataJSON()
		});
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
		// The list shows its spinner as soon as the debounced query changes,
		// before that request reaches the mock, so Base 1 going is not yet
		// proof of the request (#157): wait for the filtered result, which
		// only the request's answer brings, and poll the log.
		await expect(page.getByText('Base 1', { exact: true })).toHaveCount(0);
		await expect(page.getByText('Base 2', { exact: true })).toBeVisible();
		await expect.poll(() => calls.some((c) => c.path === '/search' && c.search.includes('query=Base+2'))).toBe(true);
	});

	test('create dialog posts the form and opens the new base', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockKnowledgeApi(page, [kb(1)]);
		await page.route('**/api/v1/groups/**', (r) =>
			r.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
		);
		await page.goto('/workspace/knowledge/create');
		const dialog = page.getByRole('dialog');
		await dialog.getByLabel('Name').fill('Handbook');
		await dialog.getByLabel('Description').fill('Everything about us');
		await dialog.getByRole('button', { name: 'Create Knowledge' }).click();
		// The base itself, not only its URL: a base the page cannot load sends it
		// back to the list, after a URL check alone could already have passed.
		await expect(page.getByRole('heading', { name: 'Handbook' })).toBeVisible();
		await expect(page).toHaveURL(/\/workspace\/knowledge\/new-kb$/);
		expect(calls.find((c) => c.path === '/create')?.body).toMatchObject({
			name: 'Handbook',
			description: 'Everything about us',
			access_grants: []
		});
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
		await expect(page.getByRole('heading', { name: 'Base 1' })).toBeVisible();
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

		await page
			.locator('#files-input')
			.setInputFiles({ name: 'new.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
		await expect(page.getByText('Added "new.txt"')).toBeVisible();
		const post = calls.find((c) => c.method === 'POST' && c.path === '/');
		expect(String(post?.body)).toContain('"knowledge_id":"kb1"');
		expect(String(post?.body)).toContain('"directory_id":"dir1"');
	});

	test('an empty file is refused without any request', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockKnowledgeApi(page, [kb(1)]);
		await page.goto('/workspace/knowledge/kb1');
		await page
			.locator('#files-input')
			.setInputFiles({ name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.from('') });
		await expect(page.getByText('"empty.txt" is empty, so it wasn\'t uploaded.')).toBeVisible();
		expect(calls.some((c) => c.method === 'POST' && c.path === '/')).toBe(false);
	});

	test('add text content uploads a .txt file; add webpage keeps only valid, unique URLs', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockKnowledgeApi(page, [kb(1)]);
		await page.goto('/workspace/knowledge/kb1');

		await page.getByRole('button', { name: 'Add content' }).click();
		await page.getByRole('menuitem', { name: 'Add text' }).click();
		let dialog = page.getByRole('dialog', { name: 'Add text' });
		await dialog.getByLabel('Title').fill('Notes');
		await dialog.getByLabel('Text', { exact: true }).fill('Some notes');
		await dialog.getByRole('button', { name: 'Add text' }).click();
		await expect
			.poll(() => String(calls.find((c) => c.method === 'POST' && c.path === '/')?.body ?? ''))
			.toContain('Notes.txt');

		await page.getByRole('button', { name: 'Add content' }).click();
		await page.getByRole('menuitem', { name: 'Add a web page' }).click();
		dialog = page.getByRole('dialog', { name: 'Add a web page' });
		await dialog
			.getByLabel('Webpage URLs')
			.fill('not a url\nhttps://example.com/a\nhttps://example.com/a\njavascript:alert(1)');
		await dialog.getByRole('button', { name: 'Add web page' }).click();
		// Only the one valid, de-duplicated http(s) URL is fetched.
		await expect
			.poll(() => calls.filter((c) => c.path === '/retrieval/process/url').map((c) => c.body?.url))
			.toEqual(['https://example.com/a']);
	});

	test('new folder, remove file, and reset all call the API, the last two after a confirmation', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockKnowledgeApi(page, [kb(1)]);
		await page.goto('/workspace/knowledge/kb1');

		await page.getByRole('button', { name: 'Add content' }).click();
		await page.getByRole('menuitem', { name: 'New folder' }).click();
		await page.getByRole('dialog', { name: 'New folder' }).getByLabel('Name').fill('Archive');
		await page.getByRole('dialog').getByRole('button', { name: 'Create folder' }).click();
		await expect
			.poll(() => calls.find((c) => c.path === '/kb1/dirs/create' || c.path.endsWith('/dirs/create'))?.body)
			.toMatchObject({ name: 'Archive' });

		await page.getByRole('button', { name: 'intro.txt menu' }).click();
		await page.getByRole('menuitem', { name: 'Remove' }).click();
		await expect(page.getByRole('alertdialog')).toContainText('Remove "intro.txt"?');
		expect(calls.some((c) => c.path.endsWith('/file/remove'))).toBe(false);
		await page.getByRole('alertdialog').getByRole('button', { name: 'Remove file' }).click();
		await expect.poll(() => calls.find((c) => c.path.endsWith('/file/remove'))?.body).toMatchObject({ file_id: 'f1' });

		await page.getByRole('button', { name: 'Add content' }).click();
		await page.getByRole('menuitem', { name: 'Reset knowledge base' }).click();
		await expect(page.getByRole('alertdialog')).toContainText("can't be undone");
		await page.getByRole('alertdialog').getByRole('button', { name: 'Reset knowledge base' }).click();
		await expect.poll(() => calls.some((c) => c.path.endsWith('/reset'))).toBe(true);
	});

	test('the name saves from its dialog with Save changes; a blank name does not save', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockKnowledgeApi(page, [kb(1)]);
		await page.goto('/workspace/knowledge/kb1');
		await page.getByRole('button', { name: 'More actions' }).click();
		await page.getByRole('menuitem', { name: 'Edit name and description' }).click();
		const dialog = page.getByRole('dialog', { name: 'Edit name and description' });
		await dialog.getByLabel('Name').fill('');
		await dialog.getByRole('button', { name: 'Save changes' }).click();
		await expect(dialog.getByText('Give the knowledge base a name.')).toBeVisible();
		expect(calls.filter((c) => c.path.endsWith('/update')).length).toBe(0);

		await dialog.getByLabel('Name').fill('Renamed base');
		await dialog.getByRole('button', { name: 'Save changes' }).click();
		await expect.poll(() => calls.filter((c) => c.path.endsWith('/update')).length).toBe(1);
		expect(calls.find((c) => c.path.endsWith('/update'))?.body).toMatchObject({
			name: 'Renamed base',
			description: 'About base 1'
		});
		await expect(page.getByRole('heading', { name: 'Renamed base' })).toBeVisible();
	});

	test('opening a file shows its text in a sheet and saves edits', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockKnowledgeApi(page, [kb(1)]);
		await page.goto('/workspace/knowledge/kb1');
		await page.getByRole('button', { name: 'Open intro.txt' }).click();
		const sheet = page.getByRole('dialog');
		await expect(sheet.getByText('Hello intro')).toBeVisible();
		await sheet.getByRole('button', { name: 'Edit text' }).click();
		await expect(sheet.getByLabel('File text')).toHaveValue('Hello intro');
		await sheet.getByLabel('File text').fill('Edited intro');
		await sheet.getByRole('button', { name: 'Save text' }).click();
		await expect
			.poll(() => calls.find((c) => c.path === '/f1/data/content/update')?.body)
			.toMatchObject({ content: 'Edited intro' });
	});

	test('a read-only base has no add menu, no rename and no access button', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockKnowledgeApi(page, [kb(1, { write_access: false })]);
		await page.goto('/workspace/knowledge/kb1');
		await expect(page.getByText('intro.txt')).toBeVisible();
		await expect(page.getByText('Read only')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Add content' })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Access' })).toHaveCount(0);
		await page.getByRole('button', { name: 'More actions' }).click();
		await expect(page.getByRole('menuitem', { name: 'Edit name and description' })).toHaveCount(0);
	});

	test('a connected base shows its source and a working test query instead of files', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockKnowledgeApi(page, [
			kb(1, {
				write_access: false,
				meta: {
					source: 'external',
					external: { provider: 'Drive', connection_id: 'c1', source: { name: 'Team docs' } }
				}
			})
		]);
		await page.route('**/api/v1/knowledge/external/connections/c1/**', (route) => {
			calls.push({ method: 'POST', path: '/external-test', search: '', body: route.request().postDataJSON() });
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ documents: ['A matching passage'], metadatas: [{ source: 'doc.pdf' }] })
			});
		});
		await page.goto('/workspace/knowledge/kb1');
		await expect(page.getByText('Team docs')).toBeVisible();
		await expect(page.getByText('intro.txt')).toHaveCount(0);
		await page.getByLabel('Test Query').fill('what is x?');
		await page.getByRole('button', { name: 'Test', exact: true }).click();
		await expect(page.getByText('A matching passage')).toBeVisible();
		await expect(page.getByText('doc.pdf')).toBeVisible();
	});

	test('an unknown base says so in place, with the way back to the list', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockKnowledgeApi(page, [kb(1)]);
		// What the server answers for a base that is gone.
		await page.route('**/api/v1/knowledge/nope', (route) =>
			route.fulfill({
				status: 404,
				contentType: 'application/json',
				body: JSON.stringify({ detail: "We could not find what you're looking for :/" })
			})
		);
		await page.goto('/workspace/knowledge/nope');
		await expect(page.getByRole('heading', { name: 'Knowledge base not found' })).toBeVisible();
		await page.getByRole('button', { name: 'Back to Knowledge' }).click();
		await expect(page).toHaveURL(/\/workspace\/knowledge$/);
	});

	test('a failed upload stays in the list with its reason, and Dismiss removes it', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockKnowledgeApi(page, [kb(1)]);
		await page.route('**/api/v1/files/?**', (route) =>
			route.request().method() === 'POST'
				? route.fulfill({
						status: 400,
						contentType: 'application/json',
						body: JSON.stringify({ detail: 'Embedding model is not available offline' })
					})
				: route.fallback()
		);
		await page.goto('/workspace/knowledge/kb1');
		await page
			.locator('#files-input')
			.setInputFiles({ name: 'paper.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
		const row = page.locator('[data-upload-status="failed"]');
		await expect(row).toContainText('paper.txt');
		await expect(row).toContainText('The server refused the upload.');
		await page.waitForTimeout(1500);
		await expect(row).toBeVisible();
		await row.getByRole('button', { name: 'Dismiss paper.txt' }).click();
		await expect(row).toHaveCount(0);
	});

	test('four files make four rows and one toast, even while the server lists them as pending', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const pending: { id: string; filename: string; meta: { name: string } }[] = [];
		await mockKnowledgeApi(page, [kb(1)], { pending });
		let n = 0;
		await page.route('**/api/v1/files/?**', async (route) => {
			if (route.request().method() !== 'POST') return route.fallback();
			const id = `up-${n++}`;
			pending.push({ id, filename: `file${n}.txt`, meta: { name: `file${n}.txt` } });
			return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id, meta: {} }) });
		});
		// Processing takes a moment, so the list reloads (after each finished file)
		// while the next one is still in flight and listed as pending.
		await page.route('**/api/v1/files/*/process/status**', async (route) => {
			await new Promise((r) => setTimeout(r, 600));
			return route.fulfill({
				status: 200,
				contentType: 'text/event-stream',
				body: 'data: {"status":"completed"}\n\ndata: [DONE]\n\n'
			});
		});
		await page.goto('/workspace/knowledge/kb1');
		await page
			.locator('#files-input')
			.setInputFiles(
				[1, 2, 3, 4].map((i) => ({ name: `file${i}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`hello ${i}`) }))
			);
		const rows = page.locator('#collection-container [role=listitem]');
		for (let i = 0; i < 8; i++) {
			for (const name of ['file1.txt', 'file2.txt', 'file3.txt', 'file4.txt'])
				expect(await rows.filter({ hasText: name }).count()).toBeLessThanOrEqual(1);
			await page.waitForTimeout(300);
		}
		await expect(page.getByText('4 files added')).toBeVisible();
		await expect(page.locator('[data-sonner-toast]')).toHaveCount(1);
	});
});
