import type { Page } from '@playwright/test';
import { expect, test } from './test';
import { mockWorkspaceBackend } from './workspace-helpers';

type Rec = Record<string, any>;
type Call = { method: string; path: string; body: any };

const json = (route: any, d: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(d) });

/** Records writes to `/api/v1<prefix>/**` and answers reads from `reads[path]`. */
async function mockConfigApi(page: Page, prefix: string, reads: Record<string, unknown>, writes: Record<string, (body: any) => unknown> = {}) {
	const calls: Call[] = [];
	await page.route(`**/api/v1${prefix}**`, async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname.replace('/api/v1', '');
		let body: any = null;
		try {
			body = req.postDataJSON();
		} catch {
			/* none */
		}
		calls.push({ method: req.method(), path, body });
		if (req.method() !== 'GET' && writes[path]) return json(route, writes[path](body));
		if (path in reads) return json(route, reads[path]);
		return json(route, req.method() === 'GET' ? {} : true);
	});
	return { calls };
}

const modal = (page: Page) => page.getByRole('dialog', { name: 'Settings' });

test.describe('settings modal host', () => {
	test('?settings=admin:<tab> opens the modal on that tab and cleans the URL', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockConfigApi(page, '/configs', { '/configs/code_execution': { ENABLE_CODE_EXECUTION: false, ENABLE_CODE_INTERPRETER: false } });
		await page.goto('/?settings=admin:code-execution');
		await expect(modal(page)).toBeVisible();
		await expect(modal(page).getByRole('tab', { name: 'Code Execution', selected: true })).toBeVisible();
		await expect(modal(page).getByRole('heading', { name: 'Code Execution', level: 2 })).toBeVisible();
		await expect(page).toHaveURL(/localhost:5174\/$/);
	});

	test('/admin/settings/<tab> redirects into the modal; Back closes it', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockConfigApi(page, '/utils', {});
		await page.goto('/admin/settings/db');
		await expect(modal(page).getByRole('heading', { name: 'Database', level: 2 })).toBeVisible();
		await modal(page).getByRole('button', { name: 'Back' }).click();
		await expect(modal(page)).toHaveCount(0);
	});

	test('the Settings tab in the admin layout opens the modal', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await page.route('**/api/v1/users/**', (route) => json(route, { users: [], total: 0 }));
		await page.route('**/api/v1/groups/**', (route) => json(route, []));
		await page.goto('/admin/users/overview');
		await page.getByRole('link', { name: 'Settings', exact: true }).click();
		await expect(modal(page)).toBeVisible();
	});

	test('a non-admin asking for an admin tab gets no modal, and the param is dropped', async ({ page }) => {
		await mockWorkspaceBackend(page, { role: 'user' });
		await page.goto('/?settings=admin:db');
		await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible();
		await expect(modal(page)).toHaveCount(0);
		await expect(page).toHaveURL(/localhost:5174\/$/);
	});

	test('an unimplemented or unknown tab falls back to the first listed', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockConfigApi(page, '/configs', { '/configs/subagents': {} });
		await page.goto('/?settings=admin:nonsense');
		// Sub-agents is first in the list among the ported tabs.
		await expect(modal(page).getByRole('tab', { selected: true })).toHaveText('Sub-agents');
	});

	test('search filters by title and keyword, and moves the selection to the first match', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockConfigApi(page, '/configs', { '/configs/code_execution': {} });
		await page.goto('/?settings=admin:db');
		const search = modal(page).getByLabel('Search');
		await search.fill('sandbox');
		await expect(modal(page).getByRole('tab')).toHaveCount(1);
		await expect(modal(page).getByRole('tab', { selected: true })).toHaveText('Code Execution');
		await search.fill('zzzz');
		await expect(modal(page).getByText('No matches')).toBeVisible();
		await search.fill('');
		await expect(modal(page).getByRole('tab').first()).toBeVisible();
	});

	test('the user menu offers Settings to an admin', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockConfigApi(page, '/configs', { '/configs/subagents': {} });
		await page.goto('/');
		await page.getByRole('button', { name: 'Open sidebar' }).click();
		await page.getByRole('button', { name: /Test User/ }).click();
		await page.getByRole('menuitem', { name: 'Settings' }).click();
		await expect(modal(page)).toBeVisible();
	});
});

test.describe('settings: Sub-agents', () => {
	test('shows the defaults, hides options until enabled, and saves numbers as numbers', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockConfigApi(page, '/configs', { '/configs/subagents': {} });
		await page.goto('/?settings=admin:subagents');
		const m = modal(page);
		await expect(m.getByLabel('Max concurrent')).toHaveCount(0);
		await m.getByRole('switch', { name: 'Enable sub-agents' }).click();
		await expect(m.getByLabel('Max concurrent')).toHaveValue('20');
		await expect(m.getByLabel('Max iterations')).toHaveValue('30');
		await expect(m.getByLabel('Max background')).toHaveCount(0);
		await m.getByRole('switch', { name: 'Enable background sub-agents' }).click();
		await expect(m.getByLabel('Max background')).toHaveValue('20');
		await m.getByLabel('Max iterations').fill('12');
		await m.getByLabel('System prompt').fill('be brief');
		await m.getByRole('button', { name: 'Save' }).click();
		await expect
			.poll(() => calls.find((c) => c.method === 'POST' && c.path === '/configs/subagents')?.body)
			.toEqual({
				ENABLE_SUBAGENTS: true,
				SUBAGENTS_BACKGROUND_ENABLED: true,
				SUBAGENTS_MAX_CONCURRENT: 20,
				SUBAGENTS_MAX_ASYNC: 20,
				SUBAGENTS_MAX_ITERATIONS: 12,
				SUBAGENTS_MAX_OUTPUT: 30000,
				SUBAGENTS_SYSTEM_PROMPT: 'be brief'
			});
	});
});

test.describe('settings: Code Execution', () => {
	const cfg = {
		ENABLE_CODE_EXECUTION: true,
		CODE_EXECUTION_ENGINE: 'pyodide',
		ENABLE_CODE_INTERPRETER: true,
		CODE_INTERPRETER_ENGINE: 'pyodide',
		CODE_INTERPRETER_PROMPT_TEMPLATE: ''
	};

	test('Jupyter reveals its URL/auth fields, warns, masks the token, and saves the whole config', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockConfigApi(page, '/configs', { '/configs/code_execution': cfg });
		await page.goto('/?settings=admin:code-execution');
		const m = modal(page);
		await expect(m.getByText('Jupyter URL')).toHaveCount(0);
		await m.getByLabel('Code Execution Engine').selectOption('jupyter');
		await expect(m.getByText(/Jupyter execution enables arbitrary code execution/)).toBeVisible();
		await m.getByPlaceholder('Enter Jupyter URL').first().fill('http://jupyter:8888');
		await m.getByLabel('Jupyter Auth').first().selectOption('token');
		const token = m.getByPlaceholder('Enter Jupyter Token');
		await token.fill('s3cret');
		// A credential is masked until the eye is pressed (the Svelte tab shows it in the clear).
		await expect(token).toHaveAttribute('type', 'password');
		await m.getByRole('button', { name: 'Make password visible in the user interface' }).first().click();
		await expect(token).toHaveAttribute('type', 'text');
		await m.getByRole('button', { name: 'Save' }).click();
		await expect
			.poll(() => calls.find((c) => c.method === 'POST' && c.path === '/configs/code_execution')?.body)
			.toMatchObject({ CODE_EXECUTION_ENGINE: 'jupyter', CODE_EXECUTION_JUPYTER_URL: 'http://jupyter:8888', CODE_EXECUTION_JUPYTER_AUTH: 'token', CODE_EXECUTION_JUPYTER_AUTH_TOKEN: 's3cret', CODE_INTERPRETER_ENGINE: 'pyodide' });
	});

	test('the interpreter section has its own engine and prompt template', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockConfigApi(page, '/configs', { '/configs/code_execution': cfg });
		await page.goto('/?settings=admin:code-execution');
		const m = modal(page);
		await expect(m.getByLabel('Code Interpreter Engine')).toBeVisible();
		await expect(m.getByText('Code Interpreter Prompt Template')).toBeVisible();
		await m.getByRole('switch', { name: 'Enable Code Interpreter' }).click();
		await expect(m.getByLabel('Code Interpreter Engine')).toHaveCount(0);
	});
});

test.describe('settings: Database', () => {
	test('Export Config downloads JSON; the users CSV neutralizes formulas', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockConfigApi(page, '/configs', { '/configs/export': { a: 1 } });
		await page.route('**/api/v1/users/all', (route) =>
			json(route, { users: [{ id: 'u1', name: '=HYPERLINK("http://evil","x")', email: 'a@b.c', role: 'user' }] })
		);
		await page.goto('/?settings=admin:db');
		const m = modal(page);
		const cfgDownload = page.waitForEvent('download');
		await m.getByRole('button', { name: 'Export' }).first().click();
		expect((await cfgDownload).suggestedFilename()).toMatch(/^config-\d+\.json$/);

		const usersDownload = page.waitForEvent('download');
		await m.getByRole('button', { name: 'Export' }).last().click();
		const dl = await usersDownload;
		expect(dl.suggestedFilename()).toBe('users.csv');
		const stream = await dl.createReadStream();
		let text = '';
		for await (const chunk of stream) text += chunk;
		expect(text.split('\n')[0]).toBe('id,name,email,role');
		expect(text).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
	});

	test('Import Config posts the parsed file', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockConfigApi(page, '/configs', {});
		await page.goto('/?settings=admin:db');
		await page.locator('#config-json-input').setInputFiles({ name: 'c.json', mimeType: 'application/json', buffer: Buffer.from('{"x":1}') });
		await expect.poll(() => calls.find((c) => c.path === '/configs/import')?.body).toEqual({ config: { x: 1 } });
	});
});

test.describe('settings: Evaluations', () => {
	test('adding an arena model saves the whole config with it', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await page.route('**/api/v1/groups/**', (route) => json(route, []));
		await page.route('**/api/models*', (route) => json(route, { data: [{ id: 'm1', name: 'Model One' }] }));
		let saved: Rec | null = null;
		const cfg = { ENABLE_EVALUATION_ARENA_MODELS: true, EVALUATION_ARENA_MODELS: [] as Rec[] };
		await page.route('**/api/v1/evaluations/config', async (route) => {
			if (route.request().method() === 'POST') {
				saved = route.request().postDataJSON();
				return json(route, saved);
			}
			return json(route, cfg);
		});
		await page.goto('/?settings=admin:evaluations');
		const m = modal(page);
		await expect(m.getByText('Using the default arena model with all models.')).toBeVisible();
		await m.getByRole('button', { name: 'Add Arena Model' }).click();
		const dialog = page.getByRole('dialog', { name: 'Add Arena Model' });
		await dialog.getByLabel('Name', { exact: true }).fill('My Arena!');
		await expect(dialog.getByLabel('ID', { exact: true })).toHaveValue('my-arena');
		await dialog.getByLabel('Select a model').selectOption('m1');
		await dialog.getByRole('button', { name: 'Add model' }).click();
		await dialog.getByRole('button', { name: 'Save' }).click();
		await expect.poll(() => saved).toMatchObject({
			ENABLE_EVALUATION_ARENA_MODELS: true,
			EVALUATION_ARENA_MODELS: [{ id: 'my-arena', name: 'My Arena!', meta: { model_ids: ['m1'], filter_mode: 'include', description: null } }]
		});
		await expect(m.getByText('My Arena!')).toBeVisible();
	});

	test('a duplicate arena name is refused', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await page.route('**/api/v1/groups/**', (route) => json(route, []));
		await page.route('**/api/models*', (route) => json(route, { data: [{ id: 'm1', name: 'Taken' }] }));
		await page.route('**/api/v1/evaluations/config', (route) => json(route, { ENABLE_EVALUATION_ARENA_MODELS: true, EVALUATION_ARENA_MODELS: [] }));
		await page.goto('/?settings=admin:evaluations');
		await modal(page).getByRole('button', { name: 'Add Arena Model' }).click();
		const dialog = page.getByRole('dialog', { name: 'Add Arena Model' });
		await dialog.getByLabel('Name', { exact: true }).fill('Taken');
		await dialog.getByRole('button', { name: 'Save' }).click();
		await expect(page.getByText('Model name already exists')).toBeVisible();
		await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('');
	});
});

test.describe('settings: Pipelines', () => {
	test('with no server it says so and has no Save', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await page.route('**/api/v1/pipelines/list', (route) => json(route, { data: [] }));
		await page.goto('/?settings=admin:pipelines');
		await expect(modal(page).getByText('Pipelines Not Detected')).toBeVisible();
		await expect(modal(page).getByRole('button', { name: 'Save' })).toHaveCount(0);
	});

	test('picks a pipeline, edits a valve (None -> Custom), and saves arrays as arrays', async ({ page }) => {
		await mockWorkspaceBackend(page);
		let updated: Rec | null = null;
		await page.route('**/api/v1/pipelines/list', (route) => json(route, { data: [{ idx: 0, url: 'http://pipes:9099' }] }));
		await page.route('**/api/v1/pipelines/?*', (route) => json(route, { data: [{ id: 'p1', name: 'Pipe One', type: 'filter', valves: true }] }));
		await page.route('**/api/v1/pipelines/p1/valves/spec*', (route) =>
			json(route, { properties: { api_key: { title: 'API Key', type: 'string' }, tags: { title: 'Tags', type: 'array' } } })
		);
		await page.route('**/api/v1/pipelines/p1/valves/update*', (route) => {
			updated = route.request().postDataJSON();
			return json(route, true);
		});
		await page.route('**/api/v1/pipelines/p1/valves?*', (route) => json(route, { api_key: null, tags: ['a', 'b'] }));
		await page.goto('/?settings=admin:pipelines');
		const m = modal(page);
		await expect(m.getByLabel('Pipeline', { exact: true })).toContainText('Pipe One (filter)');
		await expect(m.getByText('API Key')).toBeVisible();
		await m.getByRole('button', { name: 'None' }).click();
		await m.getByLabel('API Key', { exact: true }).fill('k-1');
		await m.getByLabel('Tags', { exact: true }).fill('x, y');
		await m.getByRole('button', { name: 'Save' }).click();
		await expect.poll(() => updated).toEqual({ api_key: 'k-1', tags: ['x', 'y'] });
	});
});
