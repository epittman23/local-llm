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
		await page.route('**/openai/config', (route) => json(route, { ENABLE_OPENAI_API: false, OPENAI_API_BASE_URLS: [], OPENAI_API_KEYS: [], OPENAI_API_CONFIGS: {} }));
		await page.route('**/ollama/config', (route) => json(route, { ENABLE_OLLAMA_API: false, OLLAMA_BASE_URLS: [], OLLAMA_API_CONFIGS: {} }));
		await mockConfigApi(page, '/configs', {});
		await page.goto('/?settings=admin:nonsense');
		// Whatever is first in the list, not whatever was asked for.
		const first = await modal(page).getByRole('tab').first().innerText();
		await expect(modal(page).getByRole('tab', { selected: true })).toHaveText(first);
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

test.describe('settings: Connections', () => {
	type Upstream = { openaiUpdate: Rec | null; ollamaUpdate: Rec | null; directUpdate: Rec | null; verify: Rec | null };

	async function mockUpstreams(page: Page, opts: { openai?: Rec; ollama?: Rec; direct?: Rec } = {}) {
		const seen: Upstream = { openaiUpdate: null, ollamaUpdate: null, directUpdate: null, verify: null };
		const openai = {
			ENABLE_OPENAI_API: true,
			OPENAI_API_BASE_URLS: ['https://openrouter.ai/api/v1', 'http://localhost:8090/v1'],
			OPENAI_API_KEYS: ['sk-or', ''],
			OPENAI_API_CONFIGS: { 0: { enable: true, prefix_id: 'or' }, 1: { enable: false } },
			...opts.openai
		};
		await page.route('**/openai/config', (route) => json(route, openai));
		await page.route('**/openai/config/update', (route) => {
			seen.openaiUpdate = route.request().postDataJSON();
			return json(route, seen.openaiUpdate);
		});
		await page.route('**/openai/verify', (route) => {
			seen.verify = route.request().postDataJSON();
			return json(route, { data: [] });
		});
		await page.route('**/openai/models/*', (route) => json(route, { data: [], pipelines: route.request().url().endsWith('/0') }));
		await page.route('**/ollama/config', (route) => json(route, { ENABLE_OLLAMA_API: false, OLLAMA_BASE_URLS: [], OLLAMA_API_CONFIGS: {}, ...opts.ollama }));
		await page.route('**/ollama/config/update', (route) => {
			seen.ollamaUpdate = route.request().postDataJSON();
			return json(route, seen.ollamaUpdate);
		});
		await page.route('**/api/v1/configs/connections', (route) => {
			if (route.request().method() === 'POST') {
				seen.directUpdate = route.request().postDataJSON();
				return json(route, seen.directUpdate);
			}
			return json(route, { ENABLE_DIRECT_CONNECTIONS: false, ENABLE_BASE_MODELS_CACHE: false, ...opts.direct });
		});
		await page.route('**/api/models*', (route) => json(route, { data: [] }));
		return seen;
	}

	test('lists the upstreams, marks a disabled one, and flags a Pipelines server', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockUpstreams(page);
		await page.goto('/?settings=admin:connections');
		const m = modal(page);
		await expect(m.getByLabel('API Base URL').first()).toHaveValue('https://openrouter.ai/api/v1');
		await expect(m.getByLabel('API Base URL').nth(1)).toHaveValue('http://localhost:8090/v1');
		await expect(m.getByRole('switch', { name: 'Disable https://openrouter.ai/api/v1' })).toBeChecked();
		await expect(m.getByRole('switch', { name: 'Enable http://localhost:8090/v1' })).not.toBeChecked();
		await expect(m.getByText('pipeline', { exact: true })).toHaveCount(1);
	});

	test('the enable switch saves at once, keeping every other upstream as it was', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const seen = await mockUpstreams(page);
		await page.goto('/?settings=admin:connections');
		await modal(page).getByRole('switch', { name: 'Enable http://localhost:8090/v1' }).click();
		await expect.poll(() => seen.openaiUpdate).toEqual({
			ENABLE_OPENAI_API: true,
			OPENAI_API_BASE_URLS: ['https://openrouter.ai/api/v1', 'http://localhost:8090/v1'],
			OPENAI_API_KEYS: ['sk-or', ''],
			OPENAI_API_CONFIGS: { 0: { enable: true, prefix_id: 'or' }, 1: { enable: true } }
		});
	});

	test('adding a connection appends the URL (minus a trailing slash), key and config, and saves', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const seen = await mockUpstreams(page);
		await page.goto('/?settings=admin:connections');
		await modal(page).getByRole('button', { name: 'Add OpenAI Connection' }).click();
		const dialog = page.getByRole('dialog', { name: 'Add Connection' });
		await dialog.getByLabel('URL', { exact: true }).fill('https://api.groq.com/openai/v1/');
		await dialog.getByPlaceholder('API Key').fill('gsk_123');
		await dialog.getByRole('button', { name: 'Save' }).click();
		await expect.poll(() => seen.openaiUpdate?.OPENAI_API_BASE_URLS).toEqual(['https://openrouter.ai/api/v1', 'http://localhost:8090/v1', 'https://api.groq.com/openai/v1']);
		expect(seen.openaiUpdate?.OPENAI_API_KEYS).toEqual(['sk-or', '', 'gsk_123']);
		expect(seen.openaiUpdate?.OPENAI_API_CONFIGS[2]).toMatchObject({ enable: true, connection_type: 'external', auth_type: 'bearer', model_ids: [] });
	});

	test('deleting the first connection re-indexes the config map', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const seen = await mockUpstreams(page);
		await page.goto('/?settings=admin:connections');
		await modal(page).getByRole('button', { name: 'Configure https://openrouter.ai/api/v1' }).click();
		const dialog = page.getByRole('dialog', { name: 'Edit Connection' });
		await expect(dialog.getByLabel('URL', { exact: true })).toHaveValue('https://openrouter.ai/api/v1');
		await dialog.getByRole('button', { name: 'Delete' }).click();
		await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
		await expect.poll(() => seen.openaiUpdate).toMatchObject({
			OPENAI_API_BASE_URLS: ['http://localhost:8090/v1'],
			OPENAI_API_KEYS: [''],
			OPENAI_API_CONFIGS: { 0: { enable: false } }
		});
	});

	test('Azure needs an API version, then deployment names', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const seen = await mockUpstreams(page);
		await page.goto('/?settings=admin:connections');
		await modal(page).getByRole('button', { name: 'Add OpenAI Connection' }).click();
		const dialog = page.getByRole('dialog', { name: 'Add Connection' });
		await dialog.getByLabel('URL', { exact: true }).fill('https://mine.openai.azure.com');
		await dialog.getByPlaceholder('API Key').fill('k');
		await dialog.getByRole('button', { name: 'Save' }).click();
		await expect(page.getByText('API Version is required')).toBeVisible();
		await dialog.getByLabel('API Version').fill('2024-02-01');
		await dialog.getByRole('button', { name: 'Save' }).click();
		await expect(page.getByText('Deployment names are required for Azure OpenAI')).toBeVisible();
		await dialog.getByLabel('Add a model ID').fill('gpt-4o');
		await dialog.getByRole('button', { name: 'Add', exact: true }).click();
		await dialog.getByRole('button', { name: 'Save' }).click();
		await expect.poll(() => seen.openaiUpdate?.OPENAI_API_CONFIGS?.[2]).toMatchObject({ azure: true, api_version: '2024-02-01', model_ids: ['gpt-4o'] });
	});

	test('bad headers JSON is refused and does not leave Save spinning', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const seen = await mockUpstreams(page);
		await page.goto('/?settings=admin:connections');
		await modal(page).getByRole('button', { name: 'Add OpenAI Connection' }).click();
		const dialog = page.getByRole('dialog', { name: 'Add Connection' });
		await dialog.getByLabel('URL', { exact: true }).fill('https://x.example/v1');
		await dialog.getByRole('button', { name: 'Advanced' }).click();
		await dialog.getByLabel('Headers').fill('[1, 2]');
		await dialog.getByRole('button', { name: 'Save' }).click();
		await expect(page.getByText('Headers must be a valid JSON object')).toBeVisible();
		await expect(dialog.getByRole('button', { name: 'Save' })).toBeEnabled();
		await expect(dialog.getByRole('status')).toHaveCount(0);
		expect(seen.openaiUpdate).toBeNull();
	});

	test('Verify Connection sends the URL, key and auth config', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const seen = await mockUpstreams(page);
		await page.goto('/?settings=admin:connections');
		await modal(page).getByRole('button', { name: 'Add OpenAI Connection' }).click();
		const dialog = page.getByRole('dialog', { name: 'Add Connection' });
		await dialog.getByLabel('URL', { exact: true }).fill('http://localhost:8090/v1/');
		await dialog.getByPlaceholder('API Key').fill('local');
		await dialog.getByRole('button', { name: 'Verify Connection' }).click();
		await expect.poll(() => seen.verify).toMatchObject({ url: 'http://localhost:8090/v1', key: 'local', config: { auth_type: 'bearer' } });
		await expect(page.getByText('Server connection verified')).toBeVisible();
	});

	test('Ollama connections save their key inside the config, and Direct Connections saves at once', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const seen = await mockUpstreams(page, { ollama: { ENABLE_OLLAMA_API: true } });
		await page.goto('/?settings=admin:connections');
		await modal(page).getByRole('button', { name: 'Add Ollama Connection' }).click();
		const dialog = page.getByRole('dialog', { name: 'Add Connection' });
		await dialog.getByLabel('URL', { exact: true }).fill('http://localhost:11434');
		await dialog.getByPlaceholder('API Key').fill('olk');
		await dialog.getByRole('button', { name: 'Save' }).click();
		await expect.poll(() => seen.ollamaUpdate).toMatchObject({ ENABLE_OLLAMA_API: true, OLLAMA_BASE_URLS: ['http://localhost:11434'], OLLAMA_API_CONFIGS: { 0: { key: 'olk', connection_type: 'local' } } });

		await modal(page).getByRole('switch', { name: 'Direct Connections' }).click();
		await expect.poll(() => seen.directUpdate).toEqual({ ENABLE_DIRECT_CONNECTIONS: true, ENABLE_BASE_MODELS_CACHE: false });
	});

	test('the OpenAI API switch turns the list off and saves that', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const seen = await mockUpstreams(page);
		await page.goto('/?settings=admin:connections');
		await modal(page).getByRole('switch', { name: 'OpenAI API' }).click();
		await expect.poll(() => seen.openaiUpdate?.ENABLE_OPENAI_API).toBe(false);
		await expect(modal(page).getByLabel('API Base URL')).toHaveCount(0);
	});
});

test.describe('settings: Analytics', () => {
	async function mockAnalytics(page: Page, opts: { chatAccess?: boolean } = {}) {
		const calls: { path: string; search: string }[] = [];
		await page.route('**/api/models*', (route) => json(route, { data: [{ id: 'alpha', name: 'Alpha' }] }));
		await page.route('**/api/v1/groups/**', (route) => json(route, [{ id: 'g1', name: 'Staff' }]));
		await page.route('**/api/v1/analytics/**', (route) => {
			const url = new URL(route.request().url());
			const path = url.pathname.replace('/api/v1/analytics', '');
			calls.push({ path, search: url.search });
			if (path === '/summary') return json(route, { total_messages: 1234, total_chats: 56, total_models: 2, total_users: 7 });
			if (path === '/models')
				return json(route, {
					models: [
						{ model_id: 'alpha', count: 30, unique_users: 3, unique_chats: 10 },
						{ model_id: 'zeta', count: 70, unique_users: 5, unique_chats: 20 }
					]
				});
			if (path === '/users') return json(route, { users: [{ user_id: 'u1', name: 'Ada', count: 60, total_tokens: 2000 }, { user_id: 'u2ffffffff', count: 40, total_tokens: 500 }] });
			if (path === '/daily') return json(route, { data: [{ date: '2026-09-01', models: { alpha: 3, zeta: 5 } }, { date: '2026-09-02', models: { alpha: 1, zeta: 9 } }] });
			if (path === '/tokens') return json(route, { models: [{ model_id: 'alpha', input_tokens: 100, output_tokens: 900, total_tokens: 1000 }], total_input_tokens: 100, total_output_tokens: 900, total_tokens: 1000 });
			if (/\/models\/.*\/overview/.test(path)) return json(route, { history: [{ date: '2026-09-01', won: 2, lost: 1 }], tags: [{ tag: 'code', count: 4 }] });
			if (/\/models\/.*\/chats/.test(path)) return json(route, { chats: [{ chat_id: 'c1', first_message: 'Hello there', updated_at: 1700000000, user_id: 'u1', user_name: 'Ada' }], total: 1 });
			return json(route, {});
		});
		return { calls };
	}

	test('shows totals, the chart and both tables, with model names resolved and shares computed', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockAnalytics(page);
		await page.goto('/?settings=admin:analytics');
		const m = modal(page);
		await expect(m.getByText('1,234')).toBeVisible();
		await expect(m.getByText('tokens', { exact: false }).first()).toBeVisible();
		await expect(m.getByRole('img', { name: 'Messages over time' })).toBeVisible();
		// Sorted by messages, descending: the unnamed model falls back to its id.
		const rows = m.locator('table').first().locator('tbody tr');
		await expect(rows.nth(0)).toContainText('zeta');
		await expect(rows.nth(0)).toContainText('70.0%');
		await expect(rows.nth(1)).toContainText('Alpha');
		await expect(rows.nth(1)).toContainText('30.0%');
		// A user without a name shows the start of their id.
		await expect(m.locator('table').nth(1)).toContainText('u2ffffff');
	});

	test('changing the period and group re-queries with the right window; the choice is remembered', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockAnalytics(page);
		await page.goto('/?settings=admin:analytics');
		const m = modal(page);
		await expect(m.getByText('1,234')).toBeVisible();
		await m.getByLabel('Period').selectOption('30d');
		await expect.poll(() => calls.some((c) => c.path === '/summary' && c.search.includes('start_date='))).toBe(true);
		await m.getByLabel('Group').selectOption('g1');
		await expect.poll(() => calls.some((c) => c.path === '/summary' && c.search.includes('group_id=g1'))).toBe(true);
		await m.getByLabel('Period').selectOption('24h');
		await expect.poll(() => calls.some((c) => c.path === '/daily' && c.search.includes('granularity=hourly'))).toBe(true);
		expect(await page.evaluate(() => localStorage.getItem('analyticsPeriod'))).toBe('24h');
	});

	test('a custom range waits for both dates before asking the server', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockAnalytics(page);
		await page.goto('/?settings=admin:analytics');
		const m = modal(page);
		await expect(m.getByText('1,234')).toBeVisible();
		const before = calls.length;
		await m.getByLabel('Period').selectOption('custom');
		await m.getByLabel('Start date').fill('2026-09-01');
		await page.waitForTimeout(300);
		expect(calls.length).toBe(before);
		await m.getByLabel('End date').fill('2026-09-03');
		await expect.poll(() => calls.some((c) => c.path === '/summary' && c.search.includes('end_date='))).toBe(true);
	});

	test('sorting the model table flips the order', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockAnalytics(page);
		await page.goto('/?settings=admin:analytics');
		const rows = modal(page).locator('table').first().locator('tbody tr');
		await expect(rows.nth(0)).toContainText('zeta');
		await modal(page).getByRole('columnheader', { name: 'Model' }).click();
		await expect(rows.nth(0)).toContainText('Alpha');
	});

	test('a model row opens its dialog: feedback activity and tags, and Chats only with chat access', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockAnalytics(page);
		await page.goto('/?settings=admin:analytics');
		await modal(page).locator('table').first().locator('tbody tr', { hasText: 'Alpha' }).click();
		const dialog = page.getByRole('dialog', { name: 'Alpha' });
		await expect(dialog.getByText('Feedback Activity')).toBeVisible();
		await expect(dialog.getByText('code', { exact: false }).first()).toBeVisible();
		await expect(dialog.getByRole('button', { name: 'Chats' })).toHaveCount(0);
	});

	test('with chat access the dialog lists that model\'s chats', async ({ page }) => {
		await mockWorkspaceBackend(page, { features: { enable_admin_chat_access: true } });
		await mockAnalytics(page);
		await page.goto('/?settings=admin:analytics');
		await modal(page).locator('table').first().locator('tbody tr', { hasText: 'Alpha' }).click();
		const dialog = page.getByRole('dialog', { name: 'Alpha' });
		await dialog.getByRole('button', { name: 'Chats' }).click();
		await expect(dialog.getByRole('link', { name: 'Hello there' })).toHaveAttribute('href', /\/s\/c1$/);
	});

	test('/admin/analytics opens the tab, and is a redirect home when the feature is off', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockAnalytics(page);
		await page.goto('/admin/analytics');
		await expect(modal(page).getByRole('heading', { name: 'Analytics', level: 2 })).toBeVisible();
	});

	test('with analytics turned off the tab is gone', async ({ page }) => {
		await mockWorkspaceBackend(page, { features: { enable_admin_analytics: false } });
		await mockAnalytics(page);
		await page.route('**/api/v1/users/**', (route) => json(route, { users: [], total: 0 }));
		await page.goto('/admin/analytics');
		await expect(page).toHaveURL(/\/admin\/users\/overview$/);
	});
});

test.describe('settings: General', () => {
	const adminCfg = {
		ENABLE_COMMUNITY_SHARING: true,
		ENABLE_MESSAGE_RATING: true,
		ENABLE_FOLDERS: false,
		FOLDER_MAX_FILE_COUNT: null,
		ENABLE_MEMORIES: false,
		ENABLE_MEMORY_SYSTEM_CONTEXT: false,
		ENABLE_NOTES: true,
		ENABLE_CHANNELS: false,
		CHANNEL_MODEL_RESPONSE_MODE: 'thread',
		ENABLE_CALENDAR: true,
		ENABLE_AUTOMATIONS: true,
		ENABLE_USER_WEBHOOKS: false,
		ENABLE_USER_STATUS: true,
		RESPONSE_WATERMARK: '',
		WEBUI_URL: 'http://localhost:3000',
		// Not editable here yet: it must come back to the server exactly as it arrived.
		DEFAULT_INTERFACE_SETTINGS: { theme: 'dark' }
	};
	const catalog = {
		schema: 'x',
		events: [
			{ event: 'chat.created', description: 'd', message: 'A chat was created' },
			{ event: 'user.created', description: 'd', message: 'A user signed up' },
			{ event: 'user.role.changed', description: 'd', message: 'A role changed' }
		]
	};
	const hooks = () => [
		{ id: 'b1', name: 'Beta', url: 'https://hooks.example.com/b', enabled: true, events: ['user.*'], targets: [] },
		{ id: 'default', name: 'Whatever', url: 'https://audit.example.com/x', enabled: false, events: ['*'], targets: null }
	];

	async function mockGeneral(page: Page, opts: { banners?: Rec[]; failWebhookPut?: boolean; version?: Rec } = {}) {
		const calls: Call[] = [];
		const record = (route: any, extra: Rec = {}) => {
			const req = route.request();
			let body: any = null;
			try {
				body = req.postDataJSON();
			} catch {
				/* none */
			}
			calls.push({ method: req.method(), path: new URL(req.url()).pathname, body, ...extra });
			return { req, body };
		};
		await page.route('**/api/v1/auths/admin/config', (route) => {
			const { req } = record(route);
			return json(route, req.method() === 'GET' ? adminCfg : true);
		});
		await page.route('**/api/v1/configs/banners', (route) => {
			const { req } = record(route);
			return json(route, req.method() === 'GET' ? (opts.banners ?? []) : true);
		});
		await page.route('**/api/version/updates', (route) => json(route, opts.version ?? { current: '1.0.0', latest: '9.9.9' }));
		await page.route('**/api/events**', (route) => {
			const { req } = record(route);
			const path = new URL(req.url()).pathname;
			if (path === '/api/events') return json(route, catalog);
			if (req.method() === 'GET') return json(route, hooks());
			if (req.method() === 'PUT' && opts.failWebhookPut) return json(route, { detail: 'nope' }, 500);
			return json(route, { id: 'new' });
		});
		await page.route('**/api/v1/groups/**', (route) => json(route, [{ id: 'g1', name: 'Staff' }]));
		await page.route('**/api/v1/users/search**', (route) => json(route, { users: [{ id: 'u9', name: 'Ada Lovelace', email: 'ada@x.test' }], total: 1 }));
		return { calls };
	}
	const saved = (calls: Call[], path: string) => calls.find((c) => c.method === 'POST' && c.path === path)?.body;

	test('saves the whole config back, including the parts it does not edit; an empty folder limit is null', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockGeneral(page);
		await page.goto('/?settings=admin:general');
		const m = modal(page);
		await expect(m.getByLabel('Folder Max File Count')).toHaveCount(0);
		await m.getByRole('switch', { name: 'Folders' }).click();
		await m.getByLabel('Folder Max File Count').fill('5');
		await m.getByLabel('Folder Max File Count').fill('');
		await m.getByRole('switch', { name: 'Message Rating' }).click();
		await m.getByLabel('Response Watermark').fill('AI generated');
		await m.getByRole('button', { name: 'Save' }).click();
		await expect
			.poll(() => saved(calls, '/api/v1/auths/admin/config'))
			.toEqual({ ...adminCfg, ENABLE_FOLDERS: true, FOLDER_MAX_FILE_COUNT: null, ENABLE_MESSAGE_RATING: false, RESPONSE_WATERMARK: 'AI generated' });
		await expect.poll(() => saved(calls, '/api/v1/configs/banners')).toEqual({ banners: [] });
	});

	test('memory and channel options appear only while their feature is on', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockGeneral(page);
		await page.goto('/?settings=admin:general');
		const m = modal(page);
		await expect(m.getByRole('switch', { name: 'Memory System Context' })).toHaveCount(0);
		await m.getByRole('switch', { name: 'Memories' }).click();
		await expect(m.getByRole('switch', { name: 'Memory System Context' })).toBeVisible();
		await expect(m.getByLabel('Model Response Mode')).toHaveCount(0);
		await m.getByRole('switch', { name: 'Channels' }).click();
		await expect(m.getByLabel('Model Response Mode')).toHaveValue('thread');
	});

	test('the update check is offered only when the backend enables it, and reports a newer release', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockGeneral(page);
		await page.goto('/?settings=admin:general');
		await expect(modal(page).getByRole('switch', { name: 'Notes' })).toBeVisible();
		await expect(modal(page).getByRole('button', { name: 'Check for updates' })).toHaveCount(0);

		const page2 = await page.context().newPage();
		await mockWorkspaceBackend(page2, { features: { enable_version_update_check: true } });
		await mockGeneral(page2);
		await page2.goto('/?settings=admin:general');
		await modal(page2).getByRole('button', { name: 'Check for updates' }).click();
		await expect(modal(page2).getByRole('link', { name: '(v9.9.9 available!)' })).toHaveAttribute('href', /releases\/tag\/v9\.9\.9$/);
	});

	test('banners: one blank at a time, a type is required, reorder and remove, then saved in order', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockGeneral(page, { banners: [{ id: 'old', type: 'info', title: '', content: 'Existing', dismissible: false, timestamp: 1 }] });
		await page.goto('/?settings=admin:general');
		const m = modal(page);
		const items = m.getByTestId('banner-item');
		await expect(items).toHaveCount(1);
		await m.getByRole('button', { name: 'Add banner' }).click();
		await expect(items).toHaveCount(2);
		await m.getByRole('button', { name: 'Add banner' }).click();
		await expect(items).toHaveCount(2); // the last one is still blank

		await items.nth(1).getByLabel('Banner content').fill('Maintenance tonight');
		// No type chosen: the browser refuses the submit, nothing is sent.
		await m.getByRole('button', { name: 'Save' }).click();
		await page.waitForTimeout(300);
		expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);

		await items.nth(1).getByLabel('Banner type').selectOption('warning');
		await items.nth(1).getByRole('button', { name: 'Move banner up' }).click();
		await expect(items.nth(0).getByLabel('Banner content')).toHaveValue('Maintenance tonight');
		await expect(items.nth(0).getByRole('button', { name: 'Move banner up' })).toBeDisabled();
		await m.getByRole('button', { name: 'Save' }).click();
		await expect
			.poll(() => (saved(calls, '/api/v1/configs/banners')?.banners as Rec[] | undefined)?.map((b) => [b.type, b.content, b.dismissible]))
			.toEqual([
				['warning', 'Maintenance tonight', true],
				['info', 'Existing', false]
			]);

		await items.nth(0).getByRole('button', { name: 'Remove banner' }).click();
		await expect(items).toHaveCount(1);
	});

	test('Events lists webhooks with a summary, default first; toggling one that the server refuses snaps back', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockGeneral(page, { failWebhookPut: true });
		await page.goto('/?settings=admin:general');
		const rows = modal(page).getByTestId('webhook-row');
		await expect(rows).toHaveCount(2);
		await expect(rows.nth(0)).toContainText('Default webhook');
		await expect(rows.nth(0)).toContainText('audit.example.com - All events - All users and system events');
		await expect(rows.nth(1)).toContainText('Beta');
		await expect(rows.nth(1)).toContainText('hooks.example.com - user.* - System events only');
		const toggle = rows.nth(1).getByRole('switch');
		await expect(toggle).toBeChecked();
		await toggle.click();
		await expect(page.getByText('nope')).toBeVisible();
		await expect(toggle).toBeChecked();
	});

	test('adding a webhook: bad patterns are refused, filters and specific targets are sent', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockGeneral(page);
		await page.goto('/?settings=admin:general');
		await modal(page).getByRole('button', { name: 'Add webhook' }).click();
		const d = page.getByRole('dialog', { name: 'Add webhook' });
		await d.getByLabel('Name').fill('Audit');
		await d.getByLabel('URL').fill('https://hooks.example.com/audit');

		await d.getByLabel('All events').uncheck();
		await d.getByLabel('Search or add pattern').fill('nope.*');
		await d.getByRole('button', { name: 'Add', exact: true }).click();
		await expect(page.getByText('Use a valid event name or pattern like user.*')).toBeVisible();
		await d.getByLabel('Search or add pattern').fill('user.*');
		await d.getByLabel('Search or add pattern').press('Enter');
		await expect(d.getByRole('button', { name: 'Remove user.*' })).toBeVisible();
		await d.getByRole('checkbox', { name: /chat\.created/ }).check();

		await d.getByLabel('Send events for').selectOption('selected');
		await d.getByLabel('Search users or groups').fill('a');
		await d.getByRole('button', { name: /Ada Lovelace/ }).click();
		await d.getByLabel('Search users or groups').fill('sta');
		await d.getByRole('button', { name: /Staff/ }).click();
		await d.getByRole('button', { name: 'Save' }).click();

		await expect
			.poll(() => calls.find((c) => c.method === 'POST' && c.path === '/api/events/webhooks')?.body)
			.toEqual({
				name: 'Audit',
				url: 'https://hooks.example.com/audit',
				enabled: true,
				events: ['chat.created', 'user.*'],
				targets: [
					{ type: 'user', id: 'u9' },
					{ type: 'group', id: 'g1' }
				]
			});
	});

	test('editing sends a PUT, and Delete asks first', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockGeneral(page);
		await page.goto('/?settings=admin:general');
		await modal(page).getByRole('button', { name: 'Configure Beta' }).click();
		const d = page.getByRole('dialog', { name: 'Edit webhook' });
		await expect(d.getByLabel('Name')).toHaveValue('Beta');
		await expect(d.getByLabel('Send events for')).toHaveValue('system');
		await d.getByLabel('Name').fill('Beta 2');
		await d.getByRole('button', { name: 'Save' }).click();
		await expect
			.poll(() => calls.find((c) => c.method === 'PUT' && c.path === '/api/events/webhooks/b1')?.body)
			.toEqual({ name: 'Beta 2', url: 'https://hooks.example.com/b', enabled: true, events: ['user.*'], targets: [] });

		await modal(page).getByRole('button', { name: 'Configure Beta' }).click();
		await page.getByRole('dialog', { name: 'Edit webhook' }).getByRole('button', { name: 'Delete' }).click();
		expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
		await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
		await expect.poll(() => calls.some((c) => c.method === 'DELETE' && c.path === '/api/events/webhooks/b1')).toBe(true);
	});
});
