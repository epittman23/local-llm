import { expect, test } from './test';
import type { Page } from '@playwright/test';
import { mockWorkspaceBackend } from './workspace-helpers';

type Tool = Record<string, any>;
const tool = (n: number, o: Tool = {}): Tool => ({
	id: `tool_${n}`,
	name: `Tool ${n}`,
	user_id: n === 2 ? 'someone-else' : 'u1',
	write_access: true,
	updated_at: 1700000000 + n,
	content: `def f${n}(): pass`,
	access_grants: [],
	meta: { description: `Tool number ${n}` },
	user: { name: 'Test User', email: 'u@example.com' },
	...o
});

type Call = { method: string; path: string; body: any };

async function mockToolsApi(page: Page, initial: Tool[], extra: { valvesSpec?: unknown; valves?: unknown; loadUrl?: unknown } = {}) {
	const state = { tools: [...initial] };
	const calls: Call[] = [];
	await page.route('**/api/v1/tools/**', async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const path = url.pathname.replace('/api/v1/tools', '');
		let body: any = null;
		try {
			body = req.postDataJSON();
		} catch {
			/* none */
		}
		calls.push({ method: req.method(), path, body });
		const json = (d: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(d) });
		if (path === '/list' || path === '/') return json(state.tools);
		if (path === '/create') return json(body);
		if (path === '/load/url') return json(extra.loadUrl ?? {});
		const m = path.match(/^\/id\/([^/]+)(\/.*)?$/);
		if (m) {
			const found = state.tools.find((t) => t.id === m[1]);
			const rest = m[2] ?? '';
			if (rest === '/valves/spec') return json(extra.valvesSpec ?? null);
			if (rest === '/valves') return json(extra.valves ?? {});
			if (rest === '/valves/update') return json(body);
			if (!found) return json({ detail: 'Not found' }, 404);
			if (rest === '') return json(found);
			if (rest === '/update') return json({ ...found, ...body });
			if (rest === '/delete') {
				state.tools = state.tools.filter((t) => t.id !== found.id);
				return json(true);
			}
			if (rest === '/access/update') return json(found);
		}
		return json({});
	});
	return { calls };
}

test.describe('workspace tools', () => {
	test('lists tools, filters client-side, and shows version, read-only and support affordances', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockToolsApi(page, [
			tool(1, { meta: { description: 'Tool number 1', manifest: { version: '1.2.3', funding_url: 'https://example.com/fund' } } }),
			tool(2),
			tool(3, { write_access: false })
		]);
		await page.goto('/workspace/tools');
		await expect(page.getByText('Tool 1', { exact: true })).toBeVisible();
		await expect(page.getByText('v1.2.3')).toBeVisible();
		await expect(page.getByText('Read Only')).toHaveCount(1);
		await expect(page.getByRole('button', { name: 'Support', exact: true })).toHaveCount(1);

		// Search is local and matches the author's email too.
		await page.getByLabel('Search Tools').fill('Tool 2');
		await expect(page.getByText('Tool 1', { exact: true })).toHaveCount(0);
		await expect(page.getByText('Tool 2', { exact: true })).toBeVisible();
		// The tab count follows the filtered list.
		await expect(page.getByRole('navigation').getByRole('link', { name: /^Tools/ })).toContainText('1');
	});

	test("the Support dialog only links http(s) funding URLs", async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockToolsApi(page, [
			tool(1, { meta: { description: 'd', manifest: { funding_url: 'javascript:alert(1)' } } }),
			tool(2, { meta: { description: 'd', manifest: { funding_url: 'https://example.com/fund' } } })
		]);
		await page.goto('/workspace/tools');
		// Newest first: tool 2 (https) is listed above tool 1 (javascript:).
		const buttons = page.getByRole('button', { name: 'Support', exact: true });
		await buttons.first().click();
		let dialog = page.getByRole('dialog');
		await expect(dialog.getByRole('link')).toHaveAttribute('href', 'https://example.com/fund');
		await dialog.getByRole('button', { name: 'Done' }).click();
		await buttons.last().click();
		dialog = page.getByRole('dialog');
		await expect(dialog.getByText('javascript:alert(1)')).toBeVisible();
		await expect(dialog.getByRole('link')).toHaveCount(0);
	});

	test('delete confirms first', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockToolsApi(page, [tool(1)]);
		await page.goto('/workspace/tools');
		await page.getByRole('button', { name: 'Tool Menu', exact: true }).click();
		await page.getByRole('menuitem', { name: 'Delete' }).click();
		await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
		await expect.poll(() => calls.some((c) => c.path.endsWith('/delete'))).toBe(true);
	});

	test('valves: loads a spec, edits a custom value and a default toggle, and saves arrays as arrays', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockToolsApi(page, [tool(1)], {
			valvesSpec: {
				properties: {
					api_key: { title: 'API Key', type: 'string', input: { type: 'password' } },
					tags: { title: 'Tags', type: 'array', description: 'Comma **separated**' },
					verbose: { title: 'Verbose', type: 'boolean' }
				},
				required: ['api_key']
			},
			valves: { api_key: null, tags: ['a', 'b'], verbose: null }
		});
		await page.goto('/workspace/tools');
		await page.getByRole('button', { name: 'Valves', exact: true }).click();
		const dialog = page.getByRole('dialog');
		await expect(dialog.getByText('API Key')).toBeVisible();
		await expect(dialog.getByText('*required')).toBeVisible();
		// Descriptions are rendered markdown.
		await expect(dialog.locator('strong', { hasText: 'separated' })).toBeVisible();
		// Arrays are shown as comma-separated text.
		await expect(dialog.getByLabel('Tags', { exact: true })).toHaveValue('a,b');

		await dialog.getByRole('button', { name: 'API Key: None' }).click();
		await dialog.getByPlaceholder('').first().fill('secret');
		await dialog.getByLabel('Tags', { exact: true }).fill('x, y ,,z');
		await dialog.getByRole('button', { name: 'Save' }).click();
		await expect.poll(() => calls.find((c) => c.path === '/id/tool_1/valves/update')?.body).toMatchObject({
			api_key: 'secret',
			tags: ['x', 'y', 'z'],
			verbose: null
		});
	});

	test('import from a JSON file asks for acknowledgement, and drops grants', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockToolsApi(page, []);
		await page.goto('/workspace/tools');
		await page.getByRole('button', { name: 'Open create menu' }).click();
		const chooser = page.waitForEvent('filechooser');
		await page.getByRole('menuitem', { name: 'Import JSON' }).click();
		await (await chooser).setFiles({
			name: 'tools.json',
			mimeType: 'application/json',
			buffer: Buffer.from(
				JSON.stringify([{ id: 'imp', name: 'Imp', content: 'x=1', meta: { description: 'd' }, access_grants: [{ principal_type: 'user', principal_id: '*', permission: 'write' }] }])
			)
		});
		const dialog = page.getByRole('alertdialog');
		await expect(dialog).toContainText('arbitrary code execution');
		expect(calls.some((c) => c.path === '/create')).toBe(false); // nothing before the acknowledgement
		await dialog.getByRole('button', { name: 'Confirm' }).click();
		await expect.poll(() => calls.find((c) => c.path === '/create')?.body).toMatchObject({ id: 'imp', access_grants: [] });
	});

	test('create: boilerplate is seeded, the header fills name/description, and saving needs acknowledgement', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockToolsApi(page, []);
		await page.goto('/workspace/tools/create');
		const cm = page.locator('.cm-content');
		await expect(cm).toContainText('class Tools');

		await cm.click();
		await page.keyboard.press('ControlOrMeta+a');
		await page.keyboard.insertText('"""\ntitle: Fancy Tool\ndescription: Does fancy things\n"""\nclass Tools:\n    pass\n');
		await expect(page.getByLabel('Tool Name')).toHaveValue('Fancy Tool');
		await expect(page.getByLabel('Tool ID')).toHaveValue('fancy_tool');
		await expect(page.getByLabel('Tool Description')).toHaveValue('Does fancy things');

		await page.getByRole('button', { name: 'Save & Create' }).click();
		const dialog = page.getByRole('alertdialog');
		await expect(dialog).toContainText('arbitrary code execution');
		expect(calls.some((c) => c.path === '/create')).toBe(false);
		await dialog.getByRole('button', { name: 'Confirm' }).click();
		await expect(page).toHaveURL(/\/workspace\/tools$/);
		const body = calls.find((c) => c.path === '/create')?.body;
		expect(body).toMatchObject({ id: 'fancy_tool', name: 'Fancy Tool', meta: { description: 'Does fancy things' }, access_grants: [] });
		expect(body.content).toContain('class Tools');
	});

	test('create: a tool that requires a newer Open WebUI than this one is refused', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockToolsApi(page, []);
		await page.goto('/workspace/tools/create');
		const cm = page.locator('.cm-content');
		await cm.click();
		await page.keyboard.press('ControlOrMeta+a');
		await page.keyboard.insertText('"""\nrequired_open_webui_version: 999.0.0\n"""\nclass Tools:\n    pass\n');
		await page.getByLabel('Tool Name').fill('Needs new');
		await page.getByLabel('Tool Description').fill('d');
		await page.getByRole('button', { name: 'Save & Create' }).click();
		await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm' }).click();
		await expect(page.getByText(/is lower than required version \(v999\.0\.0\)/)).toBeVisible();
		expect(calls.some((c) => c.path === '/create')).toBe(false);
	});

	test('create: a community message pre-fills the form but cannot choose grants', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockToolsApi(page, []);
		await page.goto('/workspace/tools/create');
		// The editor is lazy-loaded, so once it is on screen the page's effects have run.
		await expect(page.locator('.cm-content')).toBeVisible();
		await page.evaluate(() =>
			window.dispatchEvent(
				new MessageEvent('message', {
					origin: 'https://openwebui.com',
					data: JSON.stringify({ id: 'from_web', name: 'From Web', content: 'class Tools:\n    pass', meta: { description: 'shared' }, access_grants: [{ principal_type: 'user', principal_id: '*', permission: 'write' }] })
				})
			)
		);
		await expect(page.getByLabel('Tool Name')).toHaveValue('From Web');
		await page.getByRole('button', { name: 'Save & Create' }).click();
		await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm' }).click();
		await expect.poll(() => calls.find((c) => c.path === '/create')?.body).toMatchObject({ id: 'from_web', access_grants: [] });
	});

	test('edit: loads by id, saves without an acknowledgement, and bounces read-only tools', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockToolsApi(page, [tool(1), tool(3, { write_access: false })]);
		await page.goto('/workspace/tools/edit?id=tool_1');
		await expect(page.getByLabel('Tool Name')).toHaveValue('Tool 1');
		await expect(page.locator('.cm-content')).toContainText('def f1');
		await page.getByLabel('Tool Description').fill('Changed');
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect.poll(() => calls.find((c) => c.path === '/id/tool_1/update')?.body).toMatchObject({ id: 'tool_1', meta: { description: 'Changed' } });

		await page.goto('/workspace/tools/edit?id=tool_3');
		await expect(page.getByText('You do not have permission to edit this tool')).toBeVisible();
		await expect(page).toHaveURL(/\/workspace\/tools$/);
	});

	test('the Tools page returns to /workspace when plugins are disabled', async ({ page }) => {
		await mockWorkspaceBackend(page, { enablePlugins: false });
		await mockToolsApi(page, []);
		await page.goto('/workspace/tools');
		// The admin tab is hidden, and the page itself redirects on to Models.
		await expect(page).toHaveURL(/\/workspace\/models$/);
	});
});
