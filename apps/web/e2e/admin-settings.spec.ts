import type { Page } from '@playwright/test';
import { expect, test } from './test';
import { mockWorkspaceBackend } from './workspace-helpers';

type Rec = Record<string, any>;
type Call = { method: string; path: string; body: any };

const json = (route: any, d: unknown, status = 200) =>
	route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(d) });

/** Records writes to `/api/v1<prefix>/**` and answers reads from `reads[path]`. */
async function mockConfigApi(
	page: Page,
	prefix: string,
	reads: Record<string, unknown>,
	writes: Record<string, (body: any) => unknown> = {}
) {
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
		await mockConfigApi(page, '/configs', {
			'/configs/code_execution': { ENABLE_CODE_EXECUTION: false, ENABLE_CODE_INTERPRETER: false }
		});
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
		await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
		await expect(modal(page)).toHaveCount(0);
		await expect(page).toHaveURL(/localhost:5174\/$/);
	});

	test('an unimplemented or unknown tab falls back to the first listed', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await page.route('**/openai/config', (route) =>
			json(route, { ENABLE_OPENAI_API: false, OPENAI_API_BASE_URLS: [], OPENAI_API_KEYS: [], OPENAI_API_CONFIGS: {} })
		);
		await page.route('**/ollama/config', (route) =>
			json(route, { ENABLE_OLLAMA_API: false, OLLAMA_BASE_URLS: [], OLLAMA_API_CONFIGS: {} })
		);
		await mockConfigApi(page, '/configs', {});
		await page.goto('/?settings=admin:nonsense');
		// Whatever is first in the list, not whatever was asked for. Wait for the
		// selected tab's body first: reading the list the instant the dialog
		// appears raced the lazy tab chunk on a busy dev server. (Not "any h2":
		// the dialog's screen-reader title is one too, so that matched two.)
		const first = await modal(page).getByRole('tab').first().innerText();
		await expect(modal(page).getByRole('heading', { level: 2, name: first, exact: true })).toBeVisible();
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
			.toMatchObject({
				CODE_EXECUTION_ENGINE: 'jupyter',
				CODE_EXECUTION_JUPYTER_URL: 'http://jupyter:8888',
				CODE_EXECUTION_JUPYTER_AUTH: 'token',
				CODE_EXECUTION_JUPYTER_AUTH_TOKEN: 's3cret',
				CODE_INTERPRETER_ENGINE: 'pyodide'
			});
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
		await page
			.locator('#config-json-input')
			.setInputFiles({ name: 'c.json', mimeType: 'application/json', buffer: Buffer.from('{"x":1}') });
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
		await expect
			.poll(() => saved)
			.toMatchObject({
				ENABLE_EVALUATION_ARENA_MODELS: true,
				EVALUATION_ARENA_MODELS: [
					{ id: 'my-arena', name: 'My Arena!', meta: { model_ids: ['m1'], filter_mode: 'include', description: null } }
				]
			});
		await expect(m.getByText('My Arena!')).toBeVisible();
	});

	test('a duplicate arena name is refused', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await page.route('**/api/v1/groups/**', (route) => json(route, []));
		await page.route('**/api/models*', (route) => json(route, { data: [{ id: 'm1', name: 'Taken' }] }));
		await page.route('**/api/v1/evaluations/config', (route) =>
			json(route, { ENABLE_EVALUATION_ARENA_MODELS: true, EVALUATION_ARENA_MODELS: [] })
		);
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
		await page.route('**/api/v1/pipelines/list', (route) =>
			json(route, { data: [{ idx: 0, url: 'http://pipes:9099' }] })
		);
		await page.route('**/api/v1/pipelines/?*', (route) =>
			json(route, { data: [{ id: 'p1', name: 'Pipe One', type: 'filter', valves: true }] })
		);
		await page.route('**/api/v1/pipelines/p1/valves/spec*', (route) =>
			json(route, {
				properties: { api_key: { title: 'API Key', type: 'string' }, tags: { title: 'Tags', type: 'array' } }
			})
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
		await page.route('**/openai/models/*', (route) =>
			json(route, { data: [], pipelines: route.request().url().endsWith('/0') })
		);
		await page.route('**/ollama/config', (route) =>
			json(route, { ENABLE_OLLAMA_API: false, OLLAMA_BASE_URLS: [], OLLAMA_API_CONFIGS: {}, ...opts.ollama })
		);
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
		await expect
			.poll(() => seen.openaiUpdate)
			.toEqual({
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
		await expect
			.poll(() => seen.openaiUpdate?.OPENAI_API_BASE_URLS)
			.toEqual(['https://openrouter.ai/api/v1', 'http://localhost:8090/v1', 'https://api.groq.com/openai/v1']);
		expect(seen.openaiUpdate?.OPENAI_API_KEYS).toEqual(['sk-or', '', 'gsk_123']);
		expect(seen.openaiUpdate?.OPENAI_API_CONFIGS[2]).toMatchObject({
			enable: true,
			connection_type: 'external',
			auth_type: 'bearer',
			model_ids: []
		});
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
		await expect
			.poll(() => seen.openaiUpdate)
			.toMatchObject({
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
		await expect
			.poll(() => seen.openaiUpdate?.OPENAI_API_CONFIGS?.[2])
			.toMatchObject({ azure: true, api_version: '2024-02-01', model_ids: ['gpt-4o'] });
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
		await expect
			.poll(() => seen.verify)
			.toMatchObject({ url: 'http://localhost:8090/v1', key: 'local', config: { auth_type: 'bearer' } });
		await expect(page.getByText('Server connection verified')).toBeVisible();
	});

	test('Ollama connections save their key inside the config, and Direct Connections saves at once', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const seen = await mockUpstreams(page, { ollama: { ENABLE_OLLAMA_API: true } });
		await page.goto('/?settings=admin:connections');
		await modal(page).getByRole('button', { name: 'Add Ollama Connection' }).click();
		const dialog = page.getByRole('dialog', { name: 'Add Connection' });
		await dialog.getByLabel('URL', { exact: true }).fill('http://localhost:11434');
		await dialog.getByPlaceholder('API Key').fill('olk');
		await dialog.getByRole('button', { name: 'Save' }).click();
		await expect
			.poll(() => seen.ollamaUpdate)
			.toMatchObject({
				ENABLE_OLLAMA_API: true,
				OLLAMA_BASE_URLS: ['http://localhost:11434'],
				OLLAMA_API_CONFIGS: { 0: { key: 'olk', connection_type: 'local' } }
			});

		await modal(page).getByRole('switch', { name: 'Direct Connections' }).click();
		await expect
			.poll(() => seen.directUpdate)
			.toEqual({ ENABLE_DIRECT_CONNECTIONS: true, ENABLE_BASE_MODELS_CACHE: false });
	});

	test('a failed Verify reports the failure only', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockUpstreams(page);
		// Later routes win: this one refuses.
		await page.route('**/openai/verify', (route) =>
			json(route, { error: { message: 'Server connection failed' } }, 500)
		);
		await page.goto('/?settings=admin:connections');
		await modal(page).getByRole('button', { name: 'Add OpenAI Connection' }).click();
		const dialog = page.getByRole('dialog', { name: 'Add Connection' });
		await dialog.getByLabel('URL', { exact: true }).fill('http://localhost:8090/v1');
		await dialog.getByRole('button', { name: 'Verify Connection' }).click();
		await expect(page.getByText('OpenAI: Server connection failed')).toBeVisible();
		// Counted once, after a moment for a false success toast to render: a retrying
		// toHaveCount(0) would pass as soon as that toast timed out.
		await page.waitForTimeout(300);
		expect(await page.getByText('Server connection verified').count()).toBe(0);
	});

	test('a refused save reports the failure only and puts the old values back', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockUpstreams(page);
		await page.route('**/openai/config/update', (route) => json(route, { detail: 'Not allowed' }, 500));
		await page.route('**/api/v1/configs/connections', (route) =>
			route.request().method() === 'POST'
				? json(route, { detail: 'Not allowed' }, 500)
				: json(route, { ENABLE_DIRECT_CONNECTIONS: false, ENABLE_BASE_MODELS_CACHE: false })
		);
		await page.goto('/?settings=admin:connections');
		const m = modal(page);
		await m.getByRole('switch', { name: 'OpenAI API' }).click();
		await expect(page.getByText('Not allowed').first()).toBeVisible();
		await page.waitForTimeout(300);
		expect(await page.getByText('OpenAI API settings updated').count()).toBe(0);
		await expect(m.getByRole('switch', { name: 'OpenAI API' })).toBeChecked();

		await m.getByRole('switch', { name: 'Direct Connections' }).click();
		await page.waitForTimeout(300);
		expect(await page.getByText('Connections settings updated').count()).toBe(0);
		await expect(m.getByRole('switch', { name: 'Direct Connections' })).not.toBeChecked();
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
			if (path === '/summary')
				return json(route, { total_messages: 1234, total_chats: 56, total_models: 2, total_users: 7 });
			if (path === '/models')
				return json(route, {
					models: [
						{ model_id: 'alpha', count: 30, unique_users: 3, unique_chats: 10 },
						{ model_id: 'zeta', count: 70, unique_users: 5, unique_chats: 20 }
					]
				});
			if (path === '/users')
				return json(route, {
					users: [
						{ user_id: 'u1', name: 'Ada', count: 60, total_tokens: 2000 },
						{ user_id: 'u2ffffffff', count: 40, total_tokens: 500 }
					]
				});
			if (path === '/daily')
				return json(route, {
					data: [
						{ date: '2026-09-01', models: { alpha: 3, zeta: 5 } },
						{ date: '2026-09-02', models: { alpha: 1, zeta: 9 } }
					]
				});
			if (path === '/tokens')
				return json(route, {
					models: [{ model_id: 'alpha', input_tokens: 100, output_tokens: 900, total_tokens: 1000 }],
					total_input_tokens: 100,
					total_output_tokens: 900,
					total_tokens: 1000
				});
			if (/\/models\/.*\/overview/.test(path))
				return json(route, { history: [{ date: '2026-09-01', won: 2, lost: 1 }], tags: [{ tag: 'code', count: 4 }] });
			if (/\/models\/.*\/chats/.test(path))
				return json(route, {
					chats: [
						{ chat_id: 'c1', first_message: 'Hello there', updated_at: 1700000000, user_id: 'u1', user_name: 'Ada' }
					],
					total: 1
				});
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
		await expect
			.poll(() => calls.some((c) => c.path === '/daily' && c.search.includes('granularity=hourly')))
			.toBe(true);
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

	test('a model row opens its dialog: feedback activity and tags, and Chats only with chat access', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		await mockAnalytics(page);
		await page.goto('/?settings=admin:analytics');
		await modal(page).locator('table').first().locator('tbody tr', { hasText: 'Alpha' }).click();
		const dialog = page.getByRole('dialog', { name: 'Alpha' });
		await expect(dialog.getByText('Feedback Activity')).toBeVisible();
		await expect(dialog.getByText('code', { exact: false }).first()).toBeVisible();
		await expect(dialog.getByRole('button', { name: 'Chats' })).toHaveCount(0);
	});

	test("with chat access the dialog lists that model's chats", async ({ page }) => {
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
		// Includes a key the defaults editor has no row for: it must survive edits.
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
		{
			id: 'default',
			name: 'Whatever',
			url: 'https://audit.example.com/x',
			enabled: false,
			events: ['*'],
			targets: null
		}
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
		await page.route('**/api/version/updates', (route) =>
			json(route, opts.version ?? { current: '1.0.0', latest: '9.9.9' })
		);
		await page.route('**/api/events**', (route) => {
			const { req } = record(route);
			const path = new URL(req.url()).pathname;
			if (path === '/api/events') return json(route, catalog);
			if (req.method() === 'GET') return json(route, hooks());
			if (req.method() === 'PUT' && opts.failWebhookPut) return json(route, { detail: 'nope' }, 500);
			return json(route, { id: 'new' });
		});
		await page.route('**/api/v1/groups/**', (route) => json(route, [{ id: 'g1', name: 'Staff' }]));
		await page.route('**/api/v1/users/search**', (route) =>
			json(route, { users: [{ id: 'u9', name: 'Ada Lovelace', email: 'ada@x.test' }], total: 1 })
		);
		return { calls };
	}
	const saved = (calls: Call[], path: string) => calls.find((c) => c.method === 'POST' && c.path === path)?.body;

	test('saves the whole config back, including the parts it does not edit; an empty folder limit is null', async ({
		page
	}) => {
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
			.toEqual({
				...adminCfg,
				ENABLE_FOLDERS: true,
				FOLDER_MAX_FILE_COUNT: null,
				ENABLE_MESSAGE_RATING: false,
				RESPONSE_WATERMARK: 'AI generated'
			});
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

	test('the update check is offered only when the backend enables it, and reports a newer release', async ({
		page
	}) => {
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
		await expect(modal(page2).getByRole('link', { name: '(v9.9.9 available!)' })).toHaveAttribute(
			'href',
			/releases\/tag\/v9\.9\.9$/
		);
	});

	test('banners: one blank at a time, a type is required, reorder and remove, then saved in order', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockGeneral(page, {
			banners: [{ id: 'old', type: 'info', title: '', content: 'Existing', dismissible: false, timestamp: 1 }]
		});
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
			.poll(() =>
				(saved(calls, '/api/v1/configs/banners')?.banners as Rec[] | undefined)?.map((b) => [
					b.type,
					b.content,
					b.dismissible
				])
			)
			.toEqual([
				['warning', 'Maintenance tonight', true],
				['info', 'Existing', false]
			]);

		await items.nth(0).getByRole('button', { name: 'Remove banner' }).click();
		await expect(items).toHaveCount(1);
	});

	test('Events lists webhooks with a summary, default first; toggling one that the server refuses snaps back', async ({
		page
	}) => {
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
		await expect
			.poll(() => calls.some((c) => c.method === 'DELETE' && c.path === '/api/events/webhooks/b1'))
			.toBe(true);
	});
	test('default interface settings: toggles, cycles and nested keys merge into the defaults; unknown keys survive', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockGeneral(page);
		await page.goto('/?settings=admin:general');
		const m = modal(page);
		await m.getByRole('button', { name: 'Configure Default Interface Settings' }).click();
		await expect(m.getByText('1 settings configured')).toBeVisible();
		await m.getByRole('switch', { name: 'Widescreen Mode' }).click();
		await m.getByRole('switch', { name: 'Title Auto-Generation' }).click();
		await m.getByRole('button', { name: 'Chat Direction' }).click();
		await m.getByRole('button', { name: 'Chat Direction' }).click();
		// Rows for features the app lacks are not offered (docs/code-review.md M7); the bubble hides the username switch.
		await expect(m.getByRole('switch', { name: 'Toast Notifications for New Updates' })).toHaveCount(0);
		await expect(m.getByRole('switch', { name: 'Display the Username Instead of You in the Chat' })).toHaveCount(0);
		await m.getByRole('switch', { name: 'Chat Bubble UI' }).click();
		await expect(m.getByRole('switch', { name: 'Display the Username Instead of You in the Chat' })).toBeVisible();
		await expect(m.getByText('5 settings configured')).toBeVisible();
		await m.getByRole('button', { name: 'Save', exact: true }).click();
		await expect
			.poll(() => saved(calls, '/api/v1/auths/admin/config')?.DEFAULT_INTERFACE_SETTINGS)
			.toEqual({
				theme: 'dark',
				widescreenMode: true,
				title: { auto: false },
				chatDirection: 'RTL',
				chatBubble: false
			});
	});

	test('default interface settings: UI scale and Clear', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockGeneral(page);
		await page.goto('/?settings=admin:general');
		const m = modal(page);
		await m.getByRole('button', { name: 'Configure Default Interface Settings' }).click();
		await m.getByRole('button', { name: 'UI Scale: Default' }).click();
		await m.getByRole('button', { name: 'Increase UI Scale' }).click();
		await expect(m.getByRole('button', { name: 'UI Scale: 1.1x' })).toBeVisible();
		// The floating quick-action toolbar is not ported, so neither is its Manage dialog.
		await expect(m.getByRole('button', { name: 'Manage Floating Quick Actions' })).toHaveCount(0);
		await m.getByRole('button', { name: 'Save', exact: true }).click();
		await expect
			.poll(() => saved(calls, '/api/v1/auths/admin/config')?.DEFAULT_INTERFACE_SETTINGS)
			.toMatchObject({ theme: 'dark', textScale: 1.1 });
		await m.getByRole('button', { name: 'Clear' }).click();
		await expect(m.getByText('0 settings configured')).toBeVisible();
	});
});

test.describe('settings: Interface', () => {
	const taskCfg = () => ({
		TASK_MODEL: '',
		TASK_MODEL_EXTERNAL: '',
		TASK_MODEL_PARAMS: { temperature: 0.2, top_p: null, seed: '' },
		ENABLE_TITLE_GENERATION: true,
		TITLE_GENERATION_PROMPT_TEMPLATE: '',
		ENABLE_FOLLOW_UP_GENERATION: false,
		FOLLOW_UP_GENERATION_PROMPT_TEMPLATE: '',
		IMAGE_PROMPT_GENERATION_PROMPT_TEMPLATE: '',
		ENABLE_AUTOCOMPLETE_GENERATION: false,
		AUTOCOMPLETE_GENERATION_INPUT_MAX_LENGTH: -1,
		AUTOCOMPLETE_GENERATION_PROMPT_TEMPLATE: '',
		TAGS_GENERATION_PROMPT_TEMPLATE: '',
		ENABLE_TAGS_GENERATION: true,
		ENABLE_SEARCH_QUERY_GENERATION: true,
		ENABLE_RETRIEVAL_QUERY_GENERATION: true,
		QUERY_GENERATION_PROMPT_TEMPLATE: '',
		TOOLS_FUNCTION_CALLING_PROMPT_TEMPLATE: '',
		ENABLE_VOICE_MODE_PROMPT: true,
		VOICE_MODE_PROMPT_TEMPLATE: ''
	});
	const chatCfg = () => ({
		CONTEXT_COMPACTION_MODEL: '',
		ENABLE_CONTEXT_COMPACTION: false,
		CONTEXT_COMPACTION_TOKEN_THRESHOLD: 80000,
		CONTEXT_COMPACTION_TOKEN_CAP: 80000,
		CONTEXT_COMPACTION_RETENTION_PERCENTAGE: 40,
		CONTEXT_COMPACTION_PROMPT_TEMPLATE: '',
		ENABLE_TOOL_PERMISSIONS: false
	});

	async function mockInterface(page: Page) {
		const calls: Call[] = [];
		await page.route('**/api/v1/tasks/config**', (route) => {
			const req = route.request();
			const path = new URL(req.url()).pathname;
			let body: any = null;
			try {
				body = req.postDataJSON();
			} catch {
				/* none */
			}
			calls.push({ method: req.method(), path, body });
			return json(route, req.method() === 'GET' ? taskCfg() : body);
		});
		await page.route('**/api/v1/chats/config', (route) => {
			const req = route.request();
			let body: any = null;
			try {
				body = req.postDataJSON();
			} catch {
				/* none */
			}
			calls.push({ method: req.method(), path: '/api/v1/chats/config', body });
			return json(route, req.method() === 'GET' ? chatCfg() : body);
		});
		await page.route('**/api/v1/models/base**', (route) =>
			json(route, [
				{
					id: 'priv',
					name: 'Private one',
					access_grants: [{ principal_type: 'user', principal_id: 'u1', permission: 'read' }]
				}
			])
		);
		await page.route('**/api/models**', (route) =>
			json(route, {
				data: [
					{ id: 'open', name: 'Open one', connection_type: 'local' },
					{ id: 'priv', name: 'Private base' }
				]
			})
		);
		return { calls };
	}
	const post = (calls: Call[], path: string) => calls.find((c) => c.method === 'POST' && c.path === path)?.body;

	test('shows options only while their feature is on', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockInterface(page);
		await page.goto('/?settings=admin:interface');
		const m = modal(page);
		await expect(m.getByLabel('Local Task Model')).toHaveValue('');
		await expect(m.getByLabel('Title Generation Prompt')).toBeVisible();
		await expect(m.getByLabel('Follow Up Generation Prompt')).toHaveCount(0);
		await expect(m.getByLabel('Token Threshold')).toHaveCount(0);
		await m.getByRole('switch', { name: 'Context Compaction' }).click();
		await expect(m.getByLabel('Token Threshold')).toHaveValue('80000');
		await expect(m.getByLabel('Retained Messages')).toHaveValue('40');
		await m.getByRole('switch', { name: 'Title Generation' }).click();
		await expect(m.getByLabel('Title Generation Prompt')).toHaveCount(0);
	});

	test('a model that is not public is warned about but kept', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockInterface(page);
		await page.goto('/?settings=admin:interface');
		const m = modal(page);
		await expect(m.getByLabel('Local Task Model').locator('option', { hasText: 'Open one (Local)' })).toHaveCount(1);
		await m.getByLabel('Local Task Model').selectOption('open');
		await expect(page.getByText('This model is not publicly available')).toHaveCount(0);
		await m.getByLabel('External Task Model').selectOption('priv');
		await expect(page.getByText('This model is not publicly available. Please select another model.')).toBeVisible();
		await expect(m.getByLabel('External Task Model')).toHaveValue('priv');
	});

	test('saves both configs; unset task parameters are not sent', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockInterface(page);
		await page.goto('/?settings=admin:interface');
		const m = modal(page);
		await m.getByLabel('Local Task Model').selectOption('open');
		await m.getByRole('switch', { name: 'Follow Up Generation' }).click();
		await m.getByLabel('Follow Up Generation Prompt').fill('Suggest three.');
		await m.getByRole('switch', { name: 'Context Compaction' }).click();
		await m.getByLabel('Retained Messages').fill('25');
		await m.getByRole('button', { name: 'Save' }).click();
		await expect
			.poll(() => post(calls, '/api/v1/tasks/config/update'))
			.toEqual({
				...taskCfg(),
				TASK_MODEL: 'open',
				TASK_MODEL_PARAMS: { temperature: 0.2 },
				ENABLE_FOLLOW_UP_GENERATION: true,
				FOLLOW_UP_GENERATION_PROMPT_TEMPLATE: 'Suggest three.'
			});
		await expect
			.poll(() => post(calls, '/api/v1/chats/config'))
			.toEqual({ ...chatCfg(), ENABLE_CONTEXT_COMPACTION: true, CONTEXT_COMPACTION_RETENTION_PERCENTAGE: 25 });
		await expect(page.getByText('Settings saved successfully!')).toBeVisible();
	});
});

test.describe('settings: Authentication', () => {
	const adminCfg = () => ({
		DEFAULT_USER_ROLE: 'pending',
		DEFAULT_GROUP_ID: '',
		ENABLE_SIGNUP: true,
		ENABLE_API_KEYS: false,
		ENABLE_API_KEYS_ENDPOINT_RESTRICTIONS: false,
		API_KEYS_ALLOWED_ENDPOINTS: '',
		JWT_EXPIRES_IN: '4w',
		SHOW_ADMIN_DETAILS: false,
		ADMIN_EMAIL: null,
		PENDING_USER_OVERLAY_TITLE: '',
		PENDING_USER_OVERLAY_CONTENT: '',
		// Not on this tab: must come back as it arrived.
		WEBUI_URL: 'http://localhost:3000'
	});
	const oauthCfg = (over: Rec = {}) => ({
		ENABLE_OAUTH_PERSISTENT_CONFIG: true,
		ENABLE_OAUTH: false,
		OAUTH_PROVIDER_NAME: 'SSO',
		OAUTH_CLIENT_ID: 'cid',
		OAUTH_CLIENT_SECRET: 's3cret',
		...over
	});
	// An older backend: no group-mapping keys at all.
	const ldapServer = () => ({
		label: 'Corp',
		host: 'ldap.corp',
		port: null,
		attribute_for_mail: 'mail',
		attribute_for_username: 'uid',
		search_base: 'ou=users'
	});

	async function mockAuth(page: Page, opts: { ldapEnabled?: boolean; oauth?: Rec | null } = {}) {
		const calls: Call[] = [];
		const answer = (path: string, reads: unknown) => async (route: any) => {
			const req = route.request();
			let body: any = null;
			try {
				body = req.postDataJSON();
			} catch {
				/* none */
			}
			calls.push({ method: req.method(), path, body });
			return json(route, req.method() === 'GET' ? reads : (body ?? true));
		};
		await page.route('**/api/v1/auths/admin/config', answer('/api/v1/auths/admin/config', adminCfg()));
		await page.route(
			'**/api/v1/auths/admin/config/ldap',
			answer('/api/v1/auths/admin/config/ldap', { ENABLE_LDAP: opts.ldapEnabled ?? false })
		);
		await page.route(
			'**/api/v1/auths/admin/config/ldap/server',
			answer('/api/v1/auths/admin/config/ldap/server', ldapServer())
		);
		await page.route('**/api/v1/auths/admin/config/oauth', (route) =>
			opts.oauth === null
				? json(route, { detail: 'nope' }, 404)
				: answer('/api/v1/auths/admin/config/oauth', opts.oauth ?? oauthCfg())(route)
		);
		await page.route('**/api/v1/groups/**', (route) => json(route, [{ id: 'g1', name: 'Staff' }]));
		return { calls };
	}
	const posted = (calls: Call[], path: string) => calls.find((c) => c.method === 'POST' && c.path === path)?.body;

	test('saves the admin config whole, LDAP off sends only the switch, OAuth goes back as it came', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockAuth(page);
		await page.goto('/?settings=admin:authentication');
		const m = modal(page);
		await expect(m.getByLabel('Default Group')).toContainText('Staff');
		await m.getByLabel('Default User Role').selectOption('user');
		await m.getByLabel('Default Group').selectOption('g1');
		await m.getByRole('switch', { name: 'New Sign Ups' }).click();
		await m.getByRole('button', { name: 'Save' }).click();
		await expect
			.poll(() => posted(calls, '/api/v1/auths/admin/config'))
			.toEqual({ ...adminCfg(), DEFAULT_USER_ROLE: 'user', DEFAULT_GROUP_ID: 'g1', ENABLE_SIGNUP: false });
		await expect.poll(() => posted(calls, '/api/v1/auths/admin/config/ldap')).toEqual({ enable_ldap: false });
		await expect.poll(() => posted(calls, '/api/v1/auths/admin/config/oauth')).toEqual(oauthCfg());
		expect(posted(calls, '/api/v1/auths/admin/config/ldap/server')).toBeUndefined();
		await expect(page.getByText('Settings saved successfully!')).toBeVisible();
	});

	test('API key and pending-account options appear only while their switch is on; -1 warns', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockAuth(page);
		await page.goto('/?settings=admin:authentication');
		const m = modal(page);
		await expect(m.getByRole('switch', { name: 'API Key Endpoint Restrictions' })).toHaveCount(0);
		await m.getByRole('switch', { name: 'API Keys', exact: true }).click();
		await m.getByRole('switch', { name: 'API Key Endpoint Restrictions' }).click();
		await expect(m.getByLabel('Allowed Endpoints')).toBeVisible();
		await expect(m.getByLabel('Admin Contact Email')).toHaveCount(0);
		await m.getByRole('switch', { name: 'Admin Details' }).click();
		await expect(m.getByLabel('Admin Contact Email')).toBeVisible();
		await expect(m.getByText('No expiration can pose security risks.')).toHaveCount(0);
		await m.getByLabel('JWT Expiration').fill('-1');
		await expect(m.getByText('No expiration can pose security risks.')).toBeVisible();
	});

	test('LDAP on: required fields block saving, a blank group attribute falls back to memberOf, an empty port is null', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockAuth(page, { ldapEnabled: true });
		await page.goto('/?settings=admin:authentication');
		const m = modal(page);
		await expect(m.getByLabel('Host')).toHaveValue('ldap.corp');
		await m.getByLabel('Search Base').fill('');
		await m.getByRole('button', { name: 'Save' }).click();
		// The browser's own validation stops the submit: nothing was sent.
		await page.waitForTimeout(200);
		expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
		await m.getByLabel('Search Base').fill('ou=people,dc=corp');
		await m.getByRole('switch', { name: 'Group Mapping' }).click();
		await m.getByLabel('Group Attribute').fill('');
		await m.getByRole('button', { name: 'Save' }).click();
		await expect
			.poll(() => posted(calls, '/api/v1/auths/admin/config/ldap/server'))
			.toMatchObject({
				label: 'Corp',
				host: 'ldap.corp',
				port: null,
				search_base: 'ou=people,dc=corp',
				enable_group_management: true,
				attribute_for_groups: 'memberOf',
				use_tls: false
			});
		expect(posted(calls, '/api/v1/auths/admin/config/ldap')).toEqual({ enable_ldap: true });
	});

	test('the app DN password is masked until revealed', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockAuth(page, { ldapEnabled: true });
		await page.goto('/?settings=admin:authentication');
		const m = modal(page);
		const pw = m.getByPlaceholder('Enter Application DN Password');
		await expect(pw).toHaveAttribute('type', 'password');
		await pw.locator('xpath=following-sibling::button').click();
		await expect(pw).toHaveAttribute('type', 'text');
	});

	test('OAuth settings that come from the environment are read-only and are not saved', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockAuth(page, {
			oauth: oauthCfg({ ENABLE_OAUTH_PERSISTENT_CONFIG: false, ENABLE_OAUTH: true })
		});
		await page.goto('/?settings=admin:authentication');
		const m = modal(page);
		await expect(m.getByText(/read from environment variables/)).toBeVisible();
		await expect(m.getByLabel('Provider Name')).toBeDisabled();
		await m.getByRole('button', { name: 'Save' }).click();
		await expect.poll(() => posted(calls, '/api/v1/auths/admin/config')).toBeTruthy();
		await expect(page.getByText('Settings saved successfully!')).toBeVisible();
		expect(posted(calls, '/api/v1/auths/admin/config/oauth')).toBeUndefined();
	});

	test('OAuth on reveals the provider fields; role and group mapping reveal theirs', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockAuth(page, { oauth: oauthCfg({ ENABLE_OAUTH: true }) });
		await page.goto('/?settings=admin:authentication');
		const m = modal(page);
		await expect(m.getByLabel('Client ID')).toHaveValue('cid');
		await expect(m.getByLabel('Roles Claim')).toHaveCount(0);
		await expect(m.getByLabel('Group Claim')).toHaveCount(0);
		await m.getByRole('switch', { name: 'Role Mapping' }).click();
		await m.getByRole('switch', { name: 'Group Mapping' }).click();
		await expect(m.getByLabel('Roles Claim')).toBeVisible();
		await expect(m.getByLabel('Group Claim')).toBeVisible();
	});

	test('a failed OAuth read leaves that section out but the rest still works', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockAuth(page, { oauth: null });
		await page.goto('/?settings=admin:authentication');
		const m = modal(page);
		await expect(m.getByRole('heading', { name: 'User Access' })).toBeVisible();
		await expect(m.getByRole('heading', { name: 'OAuth / OIDC' })).toHaveCount(0);
	});
});

test.describe('settings: Audio', () => {
	const audioCfg = () => ({
		tts: {
			OPENAI_API_BASE_URL: 'https://api.openai.com/v1',
			OPENAI_API_KEY: 'tk',
			OPENAI_PARAMS: {},
			API_KEY: '',
			ENGINE: '',
			MODEL: '',
			VOICE: '',
			SPLIT_ON: 'punctuation',
			AZURE_SPEECH_REGION: '',
			AZURE_SPEECH_BASE_URL: '',
			AZURE_SPEECH_OUTPUT_FORMAT: 'audio-24khz-160kbitrate-mono-mp3',
			MISTRAL_API_KEY: '',
			MISTRAL_API_BASE_URL: ''
		},
		stt: {
			OPENAI_API_BASE_URL: 'https://api.openai.com/v1',
			OPENAI_API_KEY: 'sk',
			OPENAI_API_REQUEST_FORMAT: '',
			ENGINE: '',
			MODEL: '',
			SUPPORTED_CONTENT_TYPES: [],
			ALLOWED_EXTENSIONS: ['wav', 'mp3'],
			WHISPER_MODEL: 'base',
			DEEPGRAM_API_KEY: '',
			AZURE_API_KEY: '',
			AZURE_REGION: '',
			AZURE_LOCALES: '',
			AZURE_BASE_URL: '',
			AZURE_MAX_SPEAKERS: '',
			MISTRAL_API_KEY: '',
			MISTRAL_API_BASE_URL: '',
			MISTRAL_USE_CHAT_COMPLETIONS: false
		}
	});

	async function mockAudio(page: Page) {
		const calls: Call[] = [];
		await page.route('**/api/v1/audio/**', (route) => {
			const req = route.request();
			const path = new URL(req.url()).pathname;
			let body: any = null;
			try {
				body = req.postDataJSON();
			} catch {
				/* none */
			}
			calls.push({ method: req.method(), path, body });
			if (path.endsWith('/config') && req.method() === 'GET') return json(route, audioCfg());
			if (path.endsWith('/config/update')) return json(route, body);
			if (path.endsWith('/voices'))
				return json(route, {
					voices: [
						{ id: 'nova', name: 'Nova' },
						{ id: 'alloy', name: 'Alloy' }
					]
				});
			if (path.endsWith('/models')) return json(route, { models: [{ id: 'tts-1' }, { id: 'tts-1-hd' }] });
			return json(route, {});
		});
		return { calls };
	}
	const updates = (calls: Call[]) => calls.filter((c) => c.path.endsWith('/config/update')).map((c) => c.body);
	const region = (page: Page, name: string) => modal(page).getByRole('region', { name });

	test('local Whisper by default; the update button and Save both post the config, and unedited extensions come back', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockAudio(page);
		await page.goto('/?settings=admin:audio');
		const stt = region(page, 'Speech-to-Text');
		await expect(stt.getByLabel('STT Model')).toHaveValue('base');
		await stt.getByLabel('STT Model').fill('small');
		await stt.getByLabel('Supported MIME Types').fill(' audio/wav, ,video/* ');
		await modal(page).getByRole('button', { name: 'Update model' }).click();
		await expect.poll(() => updates(calls).length).toBe(1);
		expect(updates(calls)[0].stt).toMatchObject({
			ENGINE: '',
			WHISPER_MODEL: 'small',
			SUPPORTED_CONTENT_TYPES: ['audio/wav', 'video/*'],
			ALLOWED_EXTENSIONS: ['wav', 'mp3'],
			OPENAI_API_REQUEST_FORMAT: 'multipart'
		});
		await modal(page).getByRole('button', { name: 'Save' }).click();
		await expect.poll(() => updates(calls).length).toBe(2);
		await expect(page.getByText('Settings saved successfully!').first()).toBeVisible();
	});

	test('each speech-to-text engine shows its own fields, and the API key is masked', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockAudio(page);
		await page.goto('/?settings=admin:audio');
		const stt = region(page, 'Speech-to-Text');
		await expect(stt.getByLabel('STT Model')).toBeVisible();
		await stt.getByLabel('Speech-to-Text Engine').selectOption('openai');
		await expect(stt.getByLabel('API Base URL')).toHaveValue('https://api.openai.com/v1');
		await expect(stt.getByPlaceholder('API Key')).toHaveAttribute('type', 'password');
		await expect(stt.getByLabel('Request Format')).toHaveValue('multipart');
		await stt.getByLabel('Speech-to-Text Engine').selectOption('azure');
		await expect(stt.getByLabel('Azure Region')).toBeVisible();
		await expect(stt.getByLabel('Max Speakers')).toBeVisible();
		await stt.getByLabel('Speech-to-Text Engine').selectOption('mistral');
		await expect(stt.getByRole('switch', { name: 'Use Chat Completions API' })).toBeVisible();
		await stt.getByLabel('Speech-to-Text Engine').selectOption('web');
		await expect(stt.getByLabel('Supported MIME Types')).toHaveCount(0);
	});

	test('choosing a TTS engine saves at once, then loads its voices and models, then resets voice and model', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockAudio(page);
		await page.goto('/?settings=admin:audio');
		const tts = region(page, 'Text-to-Speech');
		await tts.getByLabel('Text-to-Speech Engine').selectOption('openai');
		await expect(tts.getByLabel('TTS Voice')).toHaveValue('alloy');
		await expect(tts.getByLabel('TTS Model')).toHaveValue('tts-1');
		const calledPaths = calls.map((c) => c.path.replace('/api/v1/audio', ''));
		// The save has to land before the lists are asked for.
		expect(calledPaths.indexOf('/config/update')).toBeGreaterThan(-1);
		expect(calledPaths.indexOf('/voices')).toBeGreaterThan(calledPaths.indexOf('/config/update'));
		expect(calledPaths.indexOf('/models')).toBeGreaterThan(calledPaths.indexOf('/config/update'));
		expect(updates(calls)[0].tts).toMatchObject({ ENGINE: 'openai', VOICE: '', MODEL: '' });
		// Provider voices come sorted by name into the suggestion list.
		await expect(page.locator('#tts-voice-list option')).toHaveCount(2);
		expect(
			await page.locator('#tts-voice-list option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value))
		).toEqual(['alloy', 'nova']);
		expect(await page.locator('#tts-model-list option').count()).toBe(2);
	});

	test('the OpenAI parameters must be a JSON object; a valid one is sent as an object and tidied', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockAudio(page);
		await page.goto('/?settings=admin:audio');
		const tts = region(page, 'Text-to-Speech');
		await tts.getByLabel('Text-to-Speech Engine').selectOption('openai');
		await expect(tts.getByLabel('Additional Parameters')).toBeVisible();
		const before = updates(calls).length;
		await tts.getByLabel('Additional Parameters').fill('[1,2]');
		await modal(page).getByRole('button', { name: 'Save' }).click();
		await expect(page.getByText('Invalid JSON format for Parameters')).toBeVisible();
		expect(updates(calls)).toHaveLength(before);
		await tts.getByLabel('Additional Parameters').fill('{"speed":1.25}');
		await modal(page).getByRole('button', { name: 'Save' }).click();
		await expect.poll(() => updates(calls).length).toBe(before + 1);
		expect(updates(calls).at(-1).tts.OPENAI_PARAMS).toEqual({ speed: 1.25 });
		await expect(tts.getByLabel('Additional Parameters')).toHaveValue('{\n  "speed": 1.25\n}');
	});

	test('Azure TTS asks for its region, endpoint, voice and output format; splitting defaults to punctuation', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		await mockAudio(page);
		await page.goto('/?settings=admin:audio');
		const tts = region(page, 'Text-to-Speech');
		await expect(tts.getByLabel('Select how to split message text for TTS requests')).toHaveValue('punctuation');
		await tts.getByLabel('Text-to-Speech Engine').selectOption('azure');
		await expect(tts.getByLabel('Azure Region')).toBeVisible();
		await expect(tts.getByLabel('Output format')).toHaveValue('audio-24khz-160kbitrate-mono-mp3');
		await expect(tts.getByLabel('TTS Voice')).toBeVisible();
	});
});

test.describe('settings: Images', () => {
	const imagesCfg = (over: Rec = {}) => ({
		ENABLE_IMAGE_GENERATION: false,
		ENABLE_IMAGE_PROMPT_GENERATION: true,
		IMAGE_GENERATION_ENGINE: 'openai',
		IMAGE_GENERATION_MODEL: '',
		IMAGE_SIZE: '512x512',
		IMAGE_STEPS: 50,
		IMAGES_OPENAI_API_BASE_URL: 'https://api.openai.com/v1',
		IMAGES_OPENAI_API_KEY: '',
		IMAGES_OPENAI_API_VERSION: '',
		IMAGES_OPENAI_API_PARAMS: { quality: 'hd' },
		AUTOMATIC1111_BASE_URL: '',
		AUTOMATIC1111_API_AUTH: '',
		AUTOMATIC1111_PARAMS: {},
		COMFYUI_BASE_URL: '',
		COMFYUI_API_KEY: '',
		COMFYUI_WORKFLOW: '',
		COMFYUI_WORKFLOW_NODES: [],
		IMAGES_GEMINI_API_BASE_URL: '',
		IMAGES_GEMINI_API_KEY: '',
		IMAGES_GEMINI_ENDPOINT_METHOD: 'predict',
		ENABLE_IMAGE_EDIT: false,
		IMAGE_EDIT_ENGINE: 'openai',
		IMAGE_EDIT_MODEL: '',
		IMAGE_EDIT_SIZE: '',
		IMAGES_EDIT_OPENAI_API_BASE_URL: '',
		IMAGES_EDIT_OPENAI_API_KEY: '',
		IMAGES_EDIT_OPENAI_API_VERSION: '',
		IMAGES_EDIT_COMFYUI_BASE_URL: '',
		IMAGES_EDIT_COMFYUI_API_KEY: '',
		IMAGES_EDIT_COMFYUI_WORKFLOW: '',
		IMAGES_EDIT_COMFYUI_WORKFLOW_NODES: [],
		IMAGES_EDIT_GEMINI_API_BASE_URL: '',
		IMAGES_EDIT_GEMINI_API_KEY: '',
		...over
	});

	async function mockImages(page: Page, cfg: Rec = imagesCfg()) {
		const calls: Call[] = [];
		await page.route('**/api/v1/images/**', (route) => {
			const req = route.request();
			const path = new URL(req.url()).pathname.replace('/api/v1/images', '');
			let body: any = null;
			try {
				body = req.postDataJSON();
			} catch {
				/* none */
			}
			calls.push({ method: req.method(), path, body });
			if (path === '/config' && req.method() === 'GET') return json(route, cfg);
			if (path === '/config/update') return json(route, body);
			if (path === '/config/url/verify') return json(route, true);
			if (path === '/models')
				return json(route, [
					{ id: 'dall-e-3', name: 'DALL-E 3' },
					{ id: 'sdxl', name: 'SDXL' }
				]);
			return json(route, {});
		});
		return { calls };
	}
	const updates = (calls: Call[]) => calls.filter((c) => c.path === '/config/update').map((c) => c.body);
	const create = (page: Page) => modal(page).getByRole('region', { name: 'Create Image' });
	const edit = (page: Page) => modal(page).getByRole('region', { name: 'Edit Image' });
	const workflow = JSON.stringify({ '6': { class_type: 'CLIPTextEncode', inputs: { text: '' } } });

	test('with generation off, params go back as objects, and an unset engine key does not block the save', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockImages(page);
		await page.goto('/?settings=admin:images');
		const m = modal(page);
		await expect(create(page).getByLabel('Additional Parameters')).toHaveValue('{\n  "quality": "hd"\n}');
		await expect(create(page).getByLabel('Model')).toHaveCount(0);
		await m.getByRole('switch', { name: 'Image Edit' }).click();
		await m.getByRole('button', { name: 'Save' }).click();
		await expect.poll(() => updates(calls).length).toBe(1);
		expect(updates(calls)[0]).toMatchObject({
			ENABLE_IMAGE_GENERATION: false,
			ENABLE_IMAGE_EDIT: true,
			IMAGES_OPENAI_API_PARAMS: { quality: 'hd' },
			AUTOMATIC1111_PARAMS: {}
		});
		// No workflow is set, so the node list is the server's own, not the six default rows.
		expect(updates(calls)[0].COMFYUI_WORKFLOW_NODES).toEqual([]);
		await expect(page.getByText('Settings saved successfully!')).toBeVisible();
	});

	test('turning generation on shows model/size/steps and loads the model list; a missing key refuses the save and turns it back off', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockImages(page);
		await page.goto('/?settings=admin:images');
		const m = modal(page);
		await m.getByRole('switch', { name: 'Image Generation', exact: true }).click();
		await expect(create(page).getByLabel('Model')).toBeVisible();
		await expect(create(page).getByLabel('Image Size')).toHaveValue('512x512');
		await create(page).getByLabel('Model').fill('dall-e-3');
		await m.getByRole('button', { name: 'Save' }).click();
		await expect(page.getByText('OpenAI API Key is required.')).toBeVisible();
		await expect(m.getByRole('switch', { name: 'Image Generation', exact: true })).not.toBeChecked();
		expect(updates(calls)).toHaveLength(0);
	});

	test('with generation on at load, the model list is fetched and offered', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockImages(
			page,
			imagesCfg({ ENABLE_IMAGE_GENERATION: true, IMAGES_OPENAI_API_KEY: 'sk', IMAGE_GENERATION_MODEL: 'dall-e-3' })
		);
		await page.goto('/?settings=admin:images');
		await expect(create(page).getByLabel('Model')).toHaveValue('dall-e-3');
		await expect.poll(() => calls.some((c) => c.path === '/models')).toBe(true);
		await expect(page.locator('#img-model-list option')).toHaveCount(2);
	});

	test('AUTOMATIC1111: Verify saves first, then checks the connection', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockImages(
			page,
			imagesCfg({ IMAGE_GENERATION_ENGINE: 'automatic1111', AUTOMATIC1111_BASE_URL: 'http://sd:7860/' })
		);
		await page.goto('/?settings=admin:images');
		await create(page).getByLabel('Base URL').fill('http://sd:7861/');
		await create(page).getByRole('button', { name: 'Verify connection' }).click();
		await expect(page.getByText('Server connection verified')).toBeVisible();
		const order = calls.map((c) => c.path).filter((p) => p === '/config/update' || p === '/config/url/verify');
		expect(order).toEqual(['/config/update', '/config/url/verify']);
		expect(updates(calls)[0].AUTOMATIC1111_BASE_URL).toBe('http://sd:7861/');
		await expect(create(page).getByPlaceholder('Enter api auth string (e.g. username:password)')).toHaveAttribute(
			'type',
			'password'
		);
	});

	test('a save that cannot be sent (bad params) stops the verify too', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockImages(
			page,
			imagesCfg({ IMAGE_GENERATION_ENGINE: 'automatic1111', AUTOMATIC1111_BASE_URL: 'http://sd:7860/' })
		);
		await page.goto('/?settings=admin:images');
		await create(page).getByLabel('Additional Parameters').fill('{oops');
		await create(page).getByRole('button', { name: 'Verify connection' }).click();
		await expect(page.getByText('Invalid JSON format for AUTOMATIC1111 Additional Parameters.')).toBeVisible();
		expect(calls.some((c) => c.path === '/config/url/verify')).toBe(false);
		expect(updates(calls)).toHaveLength(0);
	});

	test('ComfyUI: an uploaded workflow reveals the node mapping; ids are saved as lists next to the workflow text', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockImages(
			page,
			imagesCfg({ IMAGE_GENERATION_ENGINE: 'comfyui', COMFYUI_BASE_URL: 'http://comfy:8188' })
		);
		await page.goto('/?settings=admin:images');
		const c = create(page);
		await expect(c.getByText('ComfyUI Workflow Nodes')).toHaveCount(0);
		await expect(c.getByRole('button', { name: 'Edit workflow.json content' })).toHaveCount(0);
		await c
			.locator('input[type=file]')
			.setInputFiles({ name: 'workflow.json', mimeType: 'application/json', buffer: Buffer.from(workflow) });
		await expect(c.getByText('ComfyUI Workflow Nodes')).toBeVisible();
		await expect(c.getByLabel('prompt key')).toHaveValue('text');
		await c.getByLabel('prompt node ids').fill('6, 7');
		await modal(page).getByRole('button', { name: 'Save' }).click();
		await expect.poll(() => updates(calls).length).toBe(1);
		const sent = updates(calls)[0];
		expect(JSON.parse(sent.COMFYUI_WORKFLOW)).toEqual(JSON.parse(workflow));
		expect(sent.COMFYUI_WORKFLOW_NODES).toContainEqual({ type: 'prompt', key: 'text', node_ids: ['6', '7'] });
		expect(sent.COMFYUI_WORKFLOW_NODES).toHaveLength(6);
	});

	test('a workflow that is not a JSON object is refused, naming the workflow', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockImages(
			page,
			imagesCfg({ IMAGE_GENERATION_ENGINE: 'comfyui', COMFYUI_BASE_URL: 'http://comfy:8188' })
		);
		await page.goto('/?settings=admin:images');
		await create(page)
			.locator('input[type=file]')
			.setInputFiles({ name: 'w.json', mimeType: 'application/json', buffer: Buffer.from('[1,2]') });
		await modal(page).getByRole('button', { name: 'Save' }).click();
		await expect(page.getByText('Invalid JSON format for ComfyUI Workflow.')).toBeVisible();
		expect(updates(calls)).toHaveLength(0);
	});

	test('the workflow opens in a code editor dialog', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockImages(
			page,
			imagesCfg({
				IMAGE_GENERATION_ENGINE: 'comfyui',
				COMFYUI_BASE_URL: 'http://comfy:8188',
				COMFYUI_WORKFLOW: workflow
			})
		);
		await page.goto('/?settings=admin:images');
		await create(page).getByRole('button', { name: 'Edit workflow.json content' }).click();
		const dialog = page.getByRole('dialog', { name: 'ComfyUI Workflow' });
		await expect(dialog.locator('.cm-content')).toContainText('CLIPTextEncode');
	});

	test('Edit Image: engines show their own fields, with the edit model only while generation and editing are both on', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		await mockImages(
			page,
			imagesCfg({ ENABLE_IMAGE_GENERATION: true, IMAGES_OPENAI_API_KEY: 'sk', IMAGE_GENERATION_MODEL: 'dall-e-3' })
		);
		await page.goto('/?settings=admin:images');
		const e = edit(page);
		await expect(e.getByLabel('Model')).toHaveCount(0);
		await modal(page).getByRole('switch', { name: 'Image Edit' }).click();
		await expect(e.getByLabel('Model')).toBeVisible();
		await e.getByLabel('Image Edit Engine').selectOption('gemini');
		await expect(e.getByPlaceholder('API Key')).toHaveAttribute('type', 'password');
		await e.getByLabel('Image Edit Engine').selectOption('comfyui');
		await expect(e.getByRole('button', { name: 'Verify connection' })).toBeVisible();
		await e
			.locator('input[type=file]')
			.setInputFiles({ name: 'edit.json', mimeType: 'application/json', buffer: Buffer.from(workflow) });
		await expect(e.getByLabel('image key')).toHaveValue('image');
		await expect(e.getByLabel('unet_name', { exact: false })).toHaveCount(0);
	});
});

test.describe('settings: Documents', () => {
	const ragCfg = (over: Rec = {}) => ({
		CONTENT_EXTRACTION_ENGINE: '',
		CONTENT_EXTRACTION_SUPPORTED_MEDIA_MIME_TYPES: null,
		PDF_EXTRACT_IMAGES: false,
		PDF_LOADER_MODE: 'page',
		BYPASS_EMBEDDING_AND_RETRIEVAL: false,
		TEXT_SPLITTER: '',
		ENABLE_MARKDOWN_HEADER_TEXT_SPLITTER: false,
		CHUNK_SIZE: 1000,
		CHUNK_OVERLAP: 100,
		CHUNK_MIN_SIZE_TARGET: 0,
		RAG_FULL_CONTEXT: false,
		ENABLE_RAG_HYBRID_SEARCH: false,
		RAG_RERANKING_ENGINE: '',
		RAG_RERANKING_MODEL: 'BAAI/bge-reranker-v2-m3',
		RAG_RERANKING_BATCH_SIZE: 32,
		TOP_K: 3,
		TOP_K_RERANKER: 3,
		RELEVANCE_THRESHOLD: 0,
		HYBRID_BM25_WEIGHT: null,
		RAG_TEMPLATE: '',
		ALLOWED_FILE_EXTENSIONS: ['pdf'],
		FILE_MAX_SIZE: 25,
		FILE_MAX_COUNT: null,
		FILE_IMAGE_COMPRESSION_WIDTH: null,
		FILE_IMAGE_COMPRESSION_HEIGHT: null,
		ENABLE_GOOGLE_DRIVE_INTEGRATION: false,
		ENABLE_ONEDRIVE_INTEGRATION: false,
		TIKA_SERVER_URL: '',
		TIKA_SERVER_VERSION: '3',
		DOCLING_SERVER_URL: '',
		DOCLING_PARAMS: {},
		EXTERNAL_DOCUMENT_LOADER_URL: '',
		EXTERNAL_DOCUMENT_LOADER_HEADERS: {},
		MINERU_API_MODE: 'local',
		MINERU_API_URL: 'http://localhost:8000',
		MINERU_API_KEY: '',
		MINERU_PARAMS: {},
		MINERU_FILE_EXTENSIONS: ['pdf'],
		// Belongs to the Web Search tab: must come back as it arrived.
		web: { ENABLE_WEB_SEARCH: true },
		...over
	});
	const embeddingCfg = (over: Rec = {}) => ({
		RAG_EMBEDDING_ENGINE: '',
		RAG_EMBEDDING_MODEL: 'sentence-transformers/all-MiniLM-L6-v2',
		RAG_EMBEDDING_BATCH_SIZE: 1,
		ENABLE_ASYNC_EMBEDDING: true,
		RAG_EMBEDDING_CONCURRENT_REQUESTS: 0,
		openai_config: { url: 'https://api.openai.com/v1', key: '' },
		ollama_config: { url: 'http://localhost:11434', key: '' },
		azure_openai_config: { url: '', key: '', version: '' },
		...over
	});

	async function mockDocuments(page: Page, opts: { rag?: Rec; embedding?: Rec; failEmbeddingUpdate?: boolean } = {}) {
		const calls: Call[] = [];
		const record = (route: any) => {
			const req = route.request();
			let body: any = null;
			try {
				body = req.postDataJSON();
			} catch {
				/* none */
			}
			const path = new URL(req.url()).pathname.replace('/api/v1', '');
			calls.push({ method: req.method(), path, body });
			return { req, body, path };
		};
		await page.route('**/api/v1/retrieval/**', (route) => {
			const { req, body, path } = record(route);
			if (path === '/retrieval/config' && req.method() === 'GET') return json(route, opts.rag ?? ragCfg());
			if (path === '/retrieval/embedding' && req.method() === 'GET')
				return json(route, opts.embedding ?? embeddingCfg());
			if (path === '/retrieval/embedding/update')
				return opts.failEmbeddingUpdate ? json(route, { detail: 'Model not found' }, 400) : json(route, body);
			if (path === '/retrieval/config/update') return json(route, body);
			return json(route, true);
		});
		await page.route('**/api/v1/files/all', (route) => (record(route), json(route, true)));
		await page.route('**/api/v1/knowledge/**reindex', (route) => (record(route), json(route, true)));
		await page.route('**/api/v1/memories/reindex', (route) => (record(route), json(route, true)));
		return { calls };
	}
	const sent = (calls: Call[], path: string) =>
		calls.filter((c) => c.method === 'POST' && c.path === path).map((c) => c.body);
	const region = (page: Page, name: string) => modal(page).getByRole('region', { name });

	test('Save applies the embedding model first, then sends the whole config with lists and objects rebuilt', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockDocuments(page);
		await page.goto('/?settings=admin:documents');
		const m = modal(page);
		await expect(m.getByLabel('Allowed File Extensions')).toHaveValue('pdf');
		await m.getByLabel('Allowed File Extensions').fill('pdf, docx ,');
		await m.getByLabel('Max Upload Size').fill('');
		await m.getByLabel('Max Upload Count').fill('10');
		await m.getByRole('button', { name: 'Save' }).click();
		await expect(page.getByText('Settings saved successfully!')).toBeVisible();
		const order = calls.filter((c) => c.method === 'POST').map((c) => c.path);
		expect(order).toEqual(['/retrieval/embedding/update', '/retrieval/config/update']);
		const cfg = sent(calls, '/retrieval/config/update')[0];
		expect(cfg).toMatchObject({
			ALLOWED_FILE_EXTENSIONS: ['pdf', 'docx'],
			FILE_MAX_SIZE: '',
			FILE_MAX_COUNT: 10,
			FILE_IMAGE_COMPRESSION_WIDTH: '',
			DOCLING_PARAMS: {},
			EXTERNAL_DOCUMENT_LOADER_HEADERS: {},
			MINERU_PARAMS: {},
			MINERU_FILE_EXTENSIONS: ['pdf'],
			CHUNK_SIZE: 1000,
			web: { ENABLE_WEB_SEARCH: true }
		});
		expect(cfg).not.toHaveProperty('CONTENT_EXTRACTION_SUPPORTED_MEDIA_MIME_TYPES');
		expect(sent(calls, '/retrieval/embedding/update')[0]).toEqual({
			RAG_EMBEDDING_ENGINE: '',
			RAG_EMBEDDING_MODEL: 'sentence-transformers/all-MiniLM-L6-v2',
			RAG_EMBEDDING_BATCH_SIZE: 1,
			ENABLE_ASYNC_EMBEDDING: true,
			RAG_EMBEDDING_CONCURRENT_REQUESTS: 0
		});
	});

	test('an extraction engine that needs a URL refuses the save before anything is sent', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockDocuments(page);
		await page.goto('/?settings=admin:documents');
		const m = modal(page);
		await m.getByLabel('Content Extraction Engine').selectOption('tika');
		await expect(m.getByLabel('Tika Server Version')).toHaveValue('3');
		await m.getByRole('button', { name: 'Save' }).click();
		await expect(page.getByText('Tika Server URL required.')).toBeVisible();
		expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
		await m.getByLabel('Tika Server URL').fill('http://tika:9998');
		await m.getByRole('button', { name: 'Save' }).click();
		await expect.poll(() => sent(calls, '/retrieval/config/update').length).toBe(1);
		expect(sent(calls, '/retrieval/config/update')[0]).toMatchObject({
			CONTENT_EXTRACTION_ENGINE: 'tika',
			TIKA_SERVER_URL: 'http://tika:9998'
		});
	});

	test('external loader: headers must be a JSON object, and a hint explains the variables', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockDocuments(page);
		await page.goto('/?settings=admin:documents');
		const m = modal(page);
		await m.getByLabel('Content Extraction Engine').selectOption('external');
		await m.getByLabel('Document Loader URL').fill('http://loader');
		await m.getByLabel('Headers').fill('["x"]');
		await m.getByRole('button', { name: 'Save' }).click();
		await expect(page.getByText('Headers must be a valid JSON object')).toBeVisible();
		await m.getByLabel('Headers').fill('{"X-Id":"{{FILE_ID}}"}');
		await expect(m.getByText('Available variables')).toHaveCount(0);
		await m.getByRole('button', { name: 'Header variables' }).click();
		await expect(m.getByText('Available variables')).toBeVisible();
		await m.getByRole('button', { name: 'Save' }).click();
		await expect.poll(() => sent(calls, '/retrieval/config/update').length).toBe(1);
		expect(sent(calls, '/retrieval/config/update')[0].EXTERNAL_DOCUMENT_LOADER_HEADERS).toEqual({
			'X-Id': '{{FILE_ID}}'
		});
	});

	test('MinerU: switching mode swaps the stock URL but keeps one that was typed; cloud needs a key', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		await mockDocuments(page);
		await page.goto('/?settings=admin:documents');
		const m = modal(page);
		await m.getByLabel('Content Extraction Engine').selectOption('mineru');
		await m.getByLabel('API Mode').selectOption('cloud');
		await expect(m.getByLabel('API URL')).toHaveValue('https://mineru.net/api/v4');
		await m.getByLabel('API URL').fill('https://mine.example');
		await m.getByLabel('API Mode').selectOption('local');
		await expect(m.getByLabel('API URL')).toHaveValue('https://mine.example');
		await m.getByLabel('API Mode').selectOption('cloud');
		await m.getByRole('button', { name: 'Save' }).click();
		await expect(page.getByText('MinerU API Key required for Cloud API mode.')).toBeVisible();
	});

	test('bypassing retrieval hides the splitter, embedding and retrieval settings and skips the embedding update', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockDocuments(page);
		await page.goto('/?settings=admin:documents');
		const m = modal(page);
		await expect(m.getByLabel('Chunk Size')).toBeVisible();
		await expect(region(page, 'Embedding')).toBeVisible();
		await m.getByRole('switch', { name: 'Bypass Embedding and Retrieval' }).click();
		await expect(m.getByLabel('Chunk Size')).toHaveCount(0);
		await expect(region(page, 'Embedding')).toHaveCount(0);
		await expect(m.getByRole('switch', { name: 'Hybrid Search' })).toHaveCount(0);
		await m.getByRole('button', { name: 'Save' }).click();
		await expect.poll(() => sent(calls, '/retrieval/config/update').length).toBe(1);
		expect(sent(calls, '/retrieval/embedding/update')).toHaveLength(0);
	});

	test('embedding engines: each picks a starting model, shows its connection, and sends only that', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockDocuments(page);
		await page.goto('/?settings=admin:documents');
		const e = region(page, 'Embedding');
		await e.getByLabel('Embedding Model Engine').selectOption('openai');
		await expect(e.getByLabel('Embedding Model', { exact: true })).toHaveValue('text-embedding-3-small');
		await expect(e.getByLabel('API Base URL')).toHaveValue('https://api.openai.com/v1');
		await expect(e.getByRole('switch', { name: 'Async Embedding Processing' })).toBeVisible();
		await e.getByLabel('API Key').fill('sk-live');
		await e.getByLabel('Embedding Model Engine').selectOption('ollama');
		await expect(e.getByLabel('Embedding Model', { exact: true })).toHaveValue('');
		await e.getByLabel('Embedding Model Engine').selectOption('openai');
		await modal(page).getByRole('button', { name: 'Save' }).click();
		await expect.poll(() => sent(calls, '/retrieval/embedding/update').length).toBe(1);
		const body = sent(calls, '/retrieval/embedding/update')[0];
		expect(body).toMatchObject({
			RAG_EMBEDDING_ENGINE: 'openai',
			RAG_EMBEDDING_MODEL: 'text-embedding-3-small',
			openai_config: { url: 'https://api.openai.com/v1', key: 'sk-live' }
		});
		expect(body).not.toHaveProperty('ollama_config');
	});

	test('a local model given as a filesystem path is refused and nothing is saved', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockDocuments(page);
		await page.goto('/?settings=admin:documents');
		await region(page, 'Embedding').getByLabel('Embedding Model', { exact: true }).fill('/models/hf/all-MiniLM');
		await modal(page).getByRole('button', { name: 'Save' }).click();
		await expect(page.getByText(/Model filesystem path detected/)).toBeVisible();
		expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
	});

	test('the update button applies just the embedding model and says so', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockDocuments(page);
		await page.goto('/?settings=admin:documents');
		const e = region(page, 'Embedding');
		await e.getByLabel('Embedding Model', { exact: true }).fill('BAAI/bge-small-en');
		await e.getByRole('button', { name: 'Update embedding model' }).click();
		await expect(page.getByText('Embedding model updated')).toBeVisible();
		expect(sent(calls, '/retrieval/embedding/update')[0]).toMatchObject({ RAG_EMBEDDING_MODEL: 'BAAI/bge-small-en' });
		expect(sent(calls, '/retrieval/config/update')).toHaveLength(0);
	});

	test('when the embedding update fails the rest is not saved, and the embedding fields snap back to the server', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockDocuments(page, { failEmbeddingUpdate: true });
		await page.goto('/?settings=admin:documents');
		const e = region(page, 'Embedding');
		await e.getByLabel('Embedding Model', { exact: true }).fill('BAAI/nope');
		await modal(page).getByLabel('Max Upload Count').fill('7');
		await modal(page).getByRole('button', { name: 'Save' }).click();
		await expect(page.getByText('Model not found')).toBeVisible();
		await expect(e.getByLabel('Embedding Model', { exact: true })).toHaveValue(
			'sentence-transformers/all-MiniLM-L6-v2'
		);
		expect(sent(calls, '/retrieval/config/update')).toHaveLength(0);
		// The other edit is still on screen to try again.
		await expect(modal(page).getByLabel('Max Upload Count')).toHaveValue('7');
	});

	test('hybrid search reveals reranking; an external engine clears the model; BM25 weight is Default until made Custom', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockDocuments(page);
		await page.goto('/?settings=admin:documents');
		const r = region(page, 'Retrieval');
		await expect(r.getByLabel('Top K Reranker')).toHaveCount(0);
		await r.getByRole('switch', { name: 'Hybrid Search' }).click();
		await expect(r.getByLabel('Reranking Model')).toHaveValue('BAAI/bge-reranker-v2-m3');
		await r.getByLabel('Reranking Engine').selectOption('external');
		await expect(r.getByLabel('Reranking Model')).toHaveValue('');
		await expect(r.getByLabel('API Base URL')).toBeVisible();
		await r.getByLabel('Reranking Engine').selectOption('');
		await expect(r.getByLabel('Reranking Model')).toHaveValue('BAAI/bge-reranker-v2-m3');
		await expect(r.getByLabel('BM25 Weight slider')).toHaveCount(0);
		await r.getByRole('button', { name: 'Default' }).click();
		await expect(r.getByLabel('BM25 Weight', { exact: true })).toHaveValue('0.5');
		await r.getByLabel('BM25 Weight', { exact: true }).fill('0.3');
		await modal(page).getByRole('button', { name: 'Save' }).click();
		await expect.poll(() => sent(calls, '/retrieval/config/update').length).toBe(1);
		expect(sent(calls, '/retrieval/config/update')[0]).toMatchObject({
			ENABLE_RAG_HYBRID_SEARCH: true,
			HYBRID_BM25_WEIGHT: 0.3
		});
	});

	test('full context mode hides the segmented-retrieval settings; a template with several placeholders is flagged', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		await mockDocuments(page);
		await page.goto('/?settings=admin:documents');
		const r = region(page, 'Retrieval');
		await expect(r.getByLabel('Top K', { exact: true })).toBeVisible();
		await r.getByRole('switch', { name: 'Full Context Mode' }).click();
		await expect(r.getByLabel('Top K', { exact: true })).toHaveCount(0);
		await expect(r.getByText(/multiple context placeholders/)).toHaveCount(0);
		await r.getByLabel('RAG Template').fill('Use [context] then {{CONTEXT}}');
		await expect(r.getByText(/multiple context placeholders/)).toBeVisible();
	});

	test('Danger Zone: cancelling does nothing; confirming resets the uploads and reports success', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockDocuments(page);
		await page.goto('/?settings=admin:documents');
		const z = region(page, 'Danger Zone');
		await z.getByRole('button', { name: 'Reset' }).first().click();
		await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
		expect(calls.some((c) => c.path === '/files/all')).toBe(false);
		await z.getByRole('button', { name: 'Reset' }).first().click();
		await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm' }).click();
		await expect(page.getByText('Success')).toBeVisible();
		expect(calls.filter((c) => c.path === '/files/all').map((c) => c.method)).toEqual(['DELETE']);
	});

	test('Danger Zone: the vector reset really waits for the server, and reports its failure', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockDocuments(page);
		await page.route(
			'**/api/v1/retrieval/reset/db',
			(route) => (
				calls.push({ method: 'POST', path: '/retrieval/reset/db', body: null }),
				json(route, { detail: 'Vector DB is busy' }, 500)
			)
		);
		await page.goto('/?settings=admin:documents');
		await region(page, 'Danger Zone').getByRole('button', { name: 'Reset' }).nth(1).click();
		await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm' }).click();
		await expect(page.getByText('Vector DB is busy')).toBeVisible();
		await expect(page.getByText('Success', { exact: true })).toHaveCount(0);
	});

	test('Danger Zone: reindex runs knowledge files, knowledge metadata, then memories, in that order', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockDocuments(page);
		await page.goto('/?settings=admin:documents');
		await region(page, 'Danger Zone').getByRole('button', { name: 'Reindex' }).click();
		await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm' }).click();
		await expect(page.getByText('Success')).toBeVisible();
		expect(calls.filter((c) => c.path.endsWith('reindex')).map((c) => c.path)).toEqual([
			'/knowledge/reindex',
			'/knowledge/metadata/reindex',
			'/memories/reindex'
		]);
	});
});

test.describe('settings: Web Search', () => {
	const webCfg = (over: Rec = {}) => ({
		ENABLE_WEB_SEARCH: true,
		ENABLE_WEB_SEARCH_CONFIRMATION: false,
		WEB_SEARCH_CONFIRMATION_CONTENT: '',
		WEB_SEARCH_ENGINE: 'searxng',
		SEARXNG_QUERY_URL: 'http://searx/search?q=<query>',
		SEARXNG_LANGUAGE: 'all',
		WEB_SEARCH_RESULT_COUNT: 3,
		WEB_SEARCH_CONCURRENT_REQUESTS: 0,
		WEB_FETCH_MAX_CONTENT_LENGTH: null,
		WEB_SEARCH_DOMAIN_FILTER_LIST: ['example.com', '!bad.com'],
		BYPASS_WEB_SEARCH_EMBEDDING_AND_RETRIEVAL: false,
		BYPASS_WEB_SEARCH_WEB_LOADER: false,
		WEB_SEARCH_TRUST_ENV: false,
		WEB_LOADER_ENGINE: '',
		WEB_LOADER_TIMEOUT: '',
		ENABLE_WEB_LOADER_SSL_VERIFICATION: true,
		PLAYWRIGHT_WS_URL: '',
		PLAYWRIGHT_TIMEOUT: '',
		FIRECRAWL_TIMEOUT: '30',
		WEB_LOADER_CONCURRENT_REQUESTS: 10,
		YOUTUBE_LOADER_LANGUAGE: ['en'],
		YOUTUBE_LOADER_PROXY_URL: '',
		LINKUP_SEARCH_PARAMS: {},
		...over
	});

	async function mockWeb(page: Page, web: Rec = webCfg()) {
		const calls: Call[] = [];
		await page.route('**/api/v1/retrieval/config**', (route) => {
			const req = route.request();
			let body: any = null;
			try {
				body = req.postDataJSON();
			} catch {
				/* none */
			}
			const path = new URL(req.url()).pathname.replace('/api/v1', '');
			calls.push({ method: req.method(), path, body });
			// The document settings share this endpoint; this tab must leave them alone.
			if (req.method() === 'GET') return json(route, { CONTENT_EXTRACTION_ENGINE: 'tika', web });
			return json(route, body);
		});
		return { calls };
	}
	const update = (calls: Call[]) =>
		calls.find((c) => c.method === 'POST' && c.path === '/retrieval/config/update')?.body;
	const search = (page: Page) => modal(page).getByRole('region', { name: 'Search' });
	const loader = (page: Page) => modal(page).getByRole('region', { name: 'Loader' });

	test('saves only the web block; lists go back as arrays and numeric timeouts as strings', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockWeb(page);
		await page.goto('/?settings=admin:web');
		const m = modal(page);
		await expect(m.getByLabel('Domain Filter List')).toHaveValue('example.com, !bad.com');
		await m.getByLabel('Domain Filter List').fill('a.com, ,b.org');
		await m.getByLabel('Youtube Language').fill('en, de');
		await m.getByRole('button', { name: 'Save' }).click();
		await expect(page.getByText('Settings saved successfully!')).toBeVisible();
		const body = update(calls);
		expect(Object.keys(body)).toEqual(['web']);
		expect(body.web).toMatchObject({
			WEB_SEARCH_ENGINE: 'searxng',
			WEB_SEARCH_DOMAIN_FILTER_LIST: ['a.com', 'b.org'],
			YOUTUBE_LOADER_LANGUAGE: ['en', 'de'],
			FIRECRAWL_TIMEOUT: '30',
			LINKUP_SEARCH_PARAMS: {},
			WEB_LOADER_CONCURRENT_REQUESTS: 10
		});
	});

	test('the engine choice decides which connection boxes show; required ones block the save', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockWeb(page);
		await page.goto('/?settings=admin:web');
		const s = search(page);
		await expect(s.getByLabel('Searxng Query URL')).toHaveValue('http://searx/search?q=<query>');
		await s.getByLabel('Web Search Engine').selectOption('brave');
		await expect(s.getByLabel('Searxng Query URL')).toHaveCount(0);
		await expect(s.getByPlaceholder('Enter Brave Search API Key')).toHaveAttribute('type', 'password');
		await s.getByLabel('Web Search Engine').selectOption('openserp');
		await modal(page).getByRole('button', { name: 'Save' }).click();
		// OpenSERP's URL is required, so the browser stops the submit.
		await page.waitForTimeout(200);
		expect(update(calls)).toBeUndefined();
		await s.getByLabel('OpenSERP URL').fill('http://openserp:7000');
		await modal(page).getByRole('button', { name: 'Save' }).click();
		await expect.poll(() => update(calls)?.web.OPENSERP_BASE_URL).toBe('http://openserp:7000');
	});

	test('engines with extra controls: Perplexity has a model and context usage, DDGS has a backend', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		await mockWeb(page);
		await page.goto('/?settings=admin:web');
		const s = search(page);
		await s.getByLabel('Web Search Engine').selectOption('perplexity');
		await expect(s.getByLabel('Perplexity Model')).toBeVisible();
		await expect(s.getByLabel('Perplexity Search Context Usage')).toBeVisible();
		await expect(page.locator('#perplexity-model-list option')).toHaveCount(5);
		await s.getByLabel('Web Search Engine').selectOption('duckduckgo');
		await expect(s.getByLabel('DDGS Backend')).toBeVisible();
		await expect(s.getByLabel('Perplexity Model')).toHaveCount(0);
		await expect(s.getByRole('option', { name: 'DDGS' })).toHaveCount(1);
	});

	test('Linkup parameters are sent as an object, and refused when they are not JSON', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockWeb(page);
		await page.goto('/?settings=admin:web');
		const s = search(page);
		await s.getByLabel('Web Search Engine').selectOption('linkup');
		await s.getByLabel('Parameters').fill('{depth');
		await modal(page).getByRole('button', { name: 'Save' }).click();
		await expect(page.getByText('Invalid JSON format in Linkup Parameters')).toBeVisible();
		expect(update(calls)).toBeUndefined();
		await s.getByLabel('Parameters').fill('{"depth":"deep"}');
		await modal(page).getByRole('button', { name: 'Save' }).click();
		await expect.poll(() => update(calls)?.web.LINKUP_SEARCH_PARAMS).toEqual({ depth: 'deep' });
	});

	test('search limits and the domain filter show only while web search is on; confirmation text only while confirming', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		await mockWeb(page);
		await page.goto('/?settings=admin:web');
		const s = search(page);
		await expect(s.getByLabel('Search Result Count')).toHaveValue('3');
		await expect(s.getByLabel('Web Search Confirmation Content')).toHaveCount(0);
		await s.getByRole('switch', { name: 'Web Search Confirmation' }).click();
		await expect(s.getByLabel('Web Search Confirmation Content')).toBeVisible();
		await s.getByRole('switch', { name: 'Web Search', exact: true }).click();
		await expect(s.getByLabel('Search Result Count')).toHaveCount(0);
		await expect(s.getByLabel('Domain Filter List')).toHaveCount(0);
	});

	test('loaders: the default has a timeout and SSL switch; Playwright, Tavily and Firecrawl ask for their own settings', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		await mockWeb(page);
		await page.goto('/?settings=admin:web');
		const l = loader(page);
		await expect(l.getByRole('switch', { name: 'Verify SSL Certificate' })).toBeChecked();
		await l.getByLabel('Web Loader Engine').selectOption('playwright');
		await expect(l.getByLabel('Playwright WebSocket URL')).toBeVisible();
		await expect(l.getByRole('switch', { name: 'Verify SSL Certificate' })).toHaveCount(0);
		await l.getByLabel('Web Loader Engine').selectOption('tavily');
		await expect(l.getByLabel('Tavily Extract Depth')).toBeVisible();
		await expect(l.getByPlaceholder('Enter Tavily API Key')).toBeVisible();
		await l.getByLabel('Web Loader Engine').selectOption('firecrawl');
		await expect(l.getByLabel('Firecrawl API Base URL')).toBeVisible();
	});

	test('a loader that is also the search engine is not asked for its key twice', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockWeb(page, webCfg({ WEB_SEARCH_ENGINE: 'tavily', WEB_LOADER_ENGINE: 'tavily' }));
		await page.goto('/?settings=admin:web');
		await expect(search(page).getByPlaceholder('Enter Tavily API Key')).toBeVisible();
		await expect(loader(page).getByLabel('Tavily Extract Depth')).toBeVisible();
		await expect(loader(page).getByPlaceholder('Enter Tavily API Key')).toHaveCount(0);
	});

	test('a Playwright timeout typed as a number is sent as a string', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockWeb(page, webCfg({ WEB_LOADER_ENGINE: 'playwright' }));
		await page.goto('/?settings=admin:web');
		await loader(page).getByLabel('Playwright Timeout (ms)').fill('15000');
		await modal(page).getByRole('button', { name: 'Save' }).click();
		await expect.poll(() => update(calls)?.web.PLAYWRIGHT_TIMEOUT).toBe('15000');
	});
});

test.describe('settings: Models', () => {
	const pub = { principal_type: 'user', principal_id: '*', permission: 'read' };
	const grp = { principal_type: 'group', principal_id: 'g1', permission: 'read' };
	const served = [
		{ id: 'gpt-4o', name: 'GPT-4o' },
		{ id: 'llama3', name: 'Llama 3' },
		{ id: 'helper', name: 'Helper', base_model_id: 'llama3', preset: true }
	];
	const provider = [...served, { id: 'mistral', name: 'Mistral' }];
	const records = () => [
		{
			id: 'llama3',
			name: 'Llama 3',
			base_model_id: null,
			is_active: true,
			meta: { description: 'A **fast** model' },
			access_grants: [pub]
		},
		{
			id: 'helper',
			name: 'Helper',
			base_model_id: 'llama3',
			is_active: false,
			meta: { hidden: true },
			access_grants: [grp]
		}
	];
	const modelsCfg = (over: Rec = {}) => ({
		DEFAULT_MODELS: '',
		DEFAULT_PINNED_MODELS: '',
		MODEL_ORDER_LIST: ['llama3', 'gpt-4o'],
		DEFAULT_MODEL_METADATA: {},
		DEFAULT_MODEL_PARAMS: {},
		...over
	});

	async function mockModels(page: Page, opts: { cfg?: Rec; failToggle?: boolean; failCfgPost?: boolean } = {}) {
		const calls: Call[] = [];
		const record = (route: any) => {
			const req = route.request();
			let body: any = null;
			try {
				body = req.postDataJSON();
			} catch {
				/* none */
			}
			const url = new URL(req.url());
			calls.push({ method: req.method(), path: url.pathname.replace('/api/v1', '') + url.search, body });
			return { req, body, url };
		};
		await page.route('**/api/models**', (route) => {
			const { url } = record(route);
			return json(route, { data: url.pathname.endsWith('/base') ? provider : served });
		});
		await page.route('**/api/v1/models/**', (route) => {
			const { req, body, url } = record(route);
			const path = url.pathname.replace('/api/v1', '');
			if (path === '/models/base/tags') return json(route, ['fast', 'local']);
			if (path === '/models/base') return json(route, records());
			if (path === '/models/model/toggle')
				return opts.failToggle
					? json(route, { detail: 'Toggle refused' }, 500)
					: json(route, { id: url.searchParams.get('id') });
			if (path === '/models/model/access/update')
				return json(route, { id: body.id, access_grants: body.access_grants });
			if (path === '/models/import') return json(route, true);
			if (path === '/models/delete/all') return json(route, true);
			if (path === '/models/model' && req.method() === 'GET')
				return json(route, { ...served.find((m) => m.id === url.searchParams.get('id')), full: true });
			return json(route, body ?? true);
		});
		await page.route('**/api/v1/configs/models', (route) => {
			const { req, body } = record(route);
			if (req.method() === 'GET') return json(route, opts.cfg ?? modelsCfg());
			return opts.failCfgPost ? json(route, { detail: 'Config refused' }, 500) : json(route, body);
		});
		await page.route('**/api/v1/configs/suggestions', (route) => (record(route), json(route, [])));
		return { calls };
	}
	const posts = (calls: Call[], path: string) =>
		calls.filter((c) => c.method === 'POST' && c.path.split('?')[0] === path).map((c) => c.body);
	const row = (page: Page, id: string) => modal(page).locator(`[data-model-row="${id}"]`);
	const rowIds = (page: Page) =>
		modal(page)
			.locator('[data-model-row]')
			.evaluateAll((els) => els.map((e) => e.getAttribute('data-model-row')));
	const moreMenu = async (page: Page, id: string, name: string) => {
		await row(page, id)
			.getByRole('button', { name: `More actions for ${name}` })
			.click();
	};
	const actions = async (page: Page, item: string) => {
		await modal(page).getByRole('button', { name: 'Actions', exact: true }).click();
		await page.getByRole('menuitem', { name: item }).click();
	};

	test('lists served models and connection models with no record, in the saved order, with their access', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		await mockModels(page);
		await page.goto('/?settings=admin:models');
		const m = modal(page);
		await expect(m.getByRole('heading', { name: /^Models/, level: 2 })).toContainText('4');
		// Saved order first, then anything new alphabetically.
		await expect.poll(() => rowIds(page)).toEqual(['llama3', 'gpt-4o', 'helper', 'mistral']);
		await expect(row(page, 'llama3')).toContainText('Public');
		await expect(row(page, 'helper')).toContainText('Shared');
		await expect(row(page, 'gpt-4o')).toContainText('Private');
		await expect(row(page, 'mistral').getByRole('switch')).toBeChecked();
		await expect(row(page, 'helper').getByRole('switch')).not.toBeChecked();
	});

	test('search and views narrow the list, and reordering is offered only when nothing is filtered', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		await mockModels(page);
		await page.goto('/?settings=admin:models');
		const m = modal(page);
		await m.getByLabel('Search Models').fill('LLAMA');
		await expect.poll(() => rowIds(page)).toEqual(['llama3']);
		await expect(
			row(page, 'llama3').getByRole('img', { name: 'Reordering is off while filters are set' })
		).toBeVisible();
		await m.getByLabel('Clear search').click();
		await m.getByRole('button', { name: 'View' }).click();
		await page.getByRole('menuitemradio', { name: 'Disabled' }).click();
		await expect.poll(() => rowIds(page)).toEqual(['helper']);
		await m.getByRole('button', { name: 'View' }).click();
		await page.getByRole('menuitemradio', { name: 'Public' }).click();
		await expect.poll(() => rowIds(page)).toEqual(['llama3']);
		await m.getByRole('button', { name: 'View' }).click();
		await page.getByRole('menuitemradio', { name: 'All' }).click();
		await expect.poll(async () => (await rowIds(page)).length).toBe(4);
	});

	test('the enable switch toggles a model that has a record, and creates the record for one that has none', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockModels(page);
		await page.goto('/?settings=admin:models');
		await row(page, 'llama3').getByRole('switch').click();
		await expect
			.poll(() => calls.filter((c) => c.path.startsWith('/models/model/toggle')).map((c) => c.path))
			.toEqual(['/models/model/toggle?id=llama3']);
		await row(page, 'mistral').getByRole('switch').click();
		await expect
			.poll(() => posts(calls, '/models/create')[0])
			.toMatchObject({ id: 'mistral', name: 'Mistral', base_model_id: null, is_active: false, access_grants: [] });
	});

	test('a toggle the server refuses snaps back and says why', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockModels(page, { failToggle: true });
		await page.goto('/?settings=admin:models');
		const sw = row(page, 'llama3').getByRole('switch');
		await sw.click();
		await expect(page.getByText('Toggle refused')).toBeVisible();
		await expect(sw).toBeChecked();
	});

	test('Set as Selected / Pinned saves the lists at once and marks the row; a refused save puts it back', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockModels(page);
		await page.goto('/?settings=admin:models');
		await moreMenu(page, 'gpt-4o', 'GPT-4o');
		await page.getByRole('menuitem', { name: 'Set as Selected Model' }).click();
		await expect(page.getByText('Model added to selected models')).toBeVisible();
		await expect(row(page, 'gpt-4o')).toContainText('Selected');
		await moreMenu(page, 'gpt-4o', 'GPT-4o');
		await page.getByRole('menuitem', { name: 'Set as Pinned Model' }).click();
		await expect(row(page, 'gpt-4o')).toContainText('Pinned');
		const last = posts(calls, '/configs/models').at(-1);
		expect(last).toMatchObject({
			DEFAULT_MODELS: 'gpt-4o',
			DEFAULT_PINNED_MODELS: 'gpt-4o',
			MODEL_ORDER_LIST: ['llama3', 'gpt-4o']
		});
	});

	test('a refused Selected save reverts the mark', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockModels(page, { failCfgPost: true });
		await page.goto('/?settings=admin:models');
		await moreMenu(page, 'gpt-4o', 'GPT-4o');
		await page.getByRole('menuitem', { name: 'Set as Selected Model' }).click();
		await expect(page.getByText('Config refused')).toBeVisible();
		await expect(row(page, 'gpt-4o')).not.toContainText('Selected');
	});

	test('Make Private drops every grant; Make Public adds the everyone grant to what is there', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockModels(page);
		await page.goto('/?settings=admin:models');
		await moreMenu(page, 'llama3', 'Llama 3');
		await page.getByRole('menuitem', { name: 'Make Private' }).click();
		await expect(row(page, 'llama3')).toContainText('Private');
		await moreMenu(page, 'helper', 'Helper');
		await page.getByRole('menuitem', { name: 'Make Public' }).click();
		await expect(row(page, 'helper')).toContainText('Public');
		const bodies = posts(calls, '/models/model/access/update');
		expect(bodies[0]).toEqual({ id: 'llama3', name: 'Llama 3', access_grants: [] });
		expect(bodies[1]).toEqual({ id: 'helper', name: 'Helper', access_grants: [grp, pub] });
	});

	test('Hide Model stores the flag through an update and says so', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockModels(page);
		await page.goto('/?settings=admin:models');
		await moreMenu(page, 'llama3', 'Llama 3');
		await page.getByRole('menuitem', { name: 'Hide Model' }).click();
		await expect(page.getByText('Model llama3 is now hidden')).toBeVisible();
		expect(posts(calls, '/models/model/update')[0]).toMatchObject({
			id: 'llama3',
			meta: { description: 'A **fast** model', hidden: true },
			base_model_id: null
		});
	});

	test('Move Down reorders and enables Save, which sends the new order and nothing else changed', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockModels(page);
		await page.goto('/?settings=admin:models');
		const save = modal(page).getByRole('button', { name: 'Save' });
		await expect(save).toBeDisabled();
		await moreMenu(page, 'llama3', 'Llama 3');
		await page.getByRole('menuitem', { name: 'Move Down' }).click();
		await expect.poll(() => rowIds(page)).toEqual(['gpt-4o', 'llama3', 'helper', 'mistral']);
		await expect(save).toBeEnabled();
		await save.click();
		await expect(page.getByText('Model order saved successfully')).toBeVisible();
		expect(posts(calls, '/configs/models').at(-1)).toMatchObject({
			MODEL_ORDER_LIST: ['gpt-4o', 'llama3', 'helper', 'mistral'],
			DEFAULT_MODELS: '',
			DEFAULT_MODEL_PARAMS: {}
		});
		await expect(save).toBeDisabled();
	});

	test('dragging a row by its grip moves it', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockModels(page);
		await page.goto('/?settings=admin:models');
		await row(page, 'mistral')
			.getByRole('img', { name: /Drag Mistral/ })
			.dragTo(row(page, 'llama3'));
		await expect.poll(() => rowIds(page)).toEqual(['mistral', 'llama3', 'gpt-4o', 'helper']);
		await expect(modal(page).getByRole('button', { name: 'Save' })).toBeEnabled();
	});

	test('Model Defaults: editing them enables Save; one request carries the current lists, and the starter prompts go to their own endpoint', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockModels(page);
		await page.goto('/?settings=admin:models');
		const m = modal(page);
		// A default model chosen first must not be lost when the defaults are saved after it.
		await moreMenu(page, 'gpt-4o', 'GPT-4o');
		await page.getByRole('menuitem', { name: 'Set as Selected Model' }).click();
		await expect(page.getByText('Model added to selected models')).toBeVisible();
		await m.getByRole('button', { name: 'Configure model defaults' }).click();
		await m.getByRole('button', { name: /Model Capabilities/ }).click();
		await m.getByRole('checkbox', { name: 'Vision' }).click();
		const save = m.getByRole('button', { name: 'Save' });
		await expect(save).toBeEnabled();
		await save.click();
		await expect(page.getByText('Models configuration saved successfully')).toBeVisible();
		const body = posts(calls, '/configs/models').at(-1);
		expect(body.DEFAULT_MODELS).toBe('gpt-4o');
		expect(body.DEFAULT_MODEL_METADATA.capabilities.vision).toBe(false);
		expect(posts(calls, '/configs/suggestions')).toEqual([{ suggestions: [] }]);
		await expect(save).toBeDisabled();
	});

	test('Actions: Enable All acts on the models in view only', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockModels(page);
		await page.goto('/?settings=admin:models');
		await actions(page, 'Enable All');
		await expect.poll(() => posts(calls, '/models/model/update').length).toBe(1);
		expect(posts(calls, '/models/model/update')[0]).toMatchObject({ id: 'helper', is_active: true });
	});

	test('Actions: Reset asks first, then deletes every model', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockModels(page);
		await page.goto('/?settings=admin:models');
		await actions(page, 'Reset');
		await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
		expect(calls.some((c) => c.path === '/models/delete/all')).toBe(false);
		await actions(page, 'Reset');
		await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm' }).click();
		await expect(page.getByText('All models deleted successfully')).toBeVisible();
		expect(calls.some((c) => c.path === '/models/delete/all')).toBe(true);
	});

	test('Actions: Import refuses a file that is not JSON, and sends models without any access grants', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockModels(page);
		await page.goto('/?settings=admin:models');
		const input = modal(page).getByLabel('Import models file');
		await input.setInputFiles({ name: 'm.json', mimeType: 'application/json', buffer: Buffer.from('not json') });
		await expect(page.getByText('Invalid JSON file')).toBeVisible();
		expect(posts(calls, '/models/import')).toHaveLength(0);
		await input.setInputFiles({
			name: 'm.json',
			mimeType: 'application/json',
			buffer: Buffer.from(JSON.stringify([{ id: 'x', name: 'X', access_grants: [pub] }]))
		});
		await expect(page.getByText('Models imported successfully')).toBeVisible();
		expect(posts(calls, '/models/import')[0]).toEqual({
			models: [expect.objectContaining({ id: 'x', name: 'X', access_grants: [] })]
		});
	});

	test('a preset opens in the workspace editor, a connection model in the editor here', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockModels(page);
		await page.goto('/?settings=admin:models');
		await row(page, 'gpt-4o').getByRole('button', { name: 'Edit GPT-4o' }).click();
		await expect(modal(page).getByLabel('Model Name')).toHaveValue('GPT-4o');
		await modal(page).getByRole('tabpanel').getByRole('button', { name: 'Back' }).click();
		await expect(row(page, 'gpt-4o')).toBeVisible();
		await row(page, 'helper').getByRole('button', { name: 'Edit Helper' }).click();
		await expect(page).toHaveURL(/\/workspace\/models\/edit\?id=helper/);
		await expect(modal(page)).toHaveCount(0);
	});

	test('Manage says so when no engine can be managed', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockModels(page);
		await page.route('**/ollama/config', (route) =>
			json(route, { ENABLE_OLLAMA_API: false, OLLAMA_BASE_URLS: [], OLLAMA_API_CONFIGS: {} })
		);
		await page.route('**/openai/config', (route) =>
			json(route, { ENABLE_OPENAI_API: false, OPENAI_API_BASE_URLS: [], OPENAI_API_KEYS: [], OPENAI_API_CONFIGS: {} })
		);
		await page.goto('/?settings=admin:models');
		await actions(page, 'Manage');
		await expect(
			page.getByRole('dialog', { name: 'Manage Models' }).getByText('No inference engine with management support found')
		).toBeVisible();
	});
});

test.describe('settings: Models > Manage', () => {
	const ndjson = (...lines: object[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

	async function mockManage(page: Page, opts: { openai?: Rec } = {}) {
		const calls: Call[] = [];
		await mockWorkspaceBackend(page);
		await page.route('**/api/models**', (route) => json(route, { data: [] }));
		await page.route('**/api/v1/models/**', (route) => json(route, []));
		await page.route('**/api/v1/configs/models', (route) =>
			json(route, {
				DEFAULT_MODELS: '',
				DEFAULT_PINNED_MODELS: '',
				MODEL_ORDER_LIST: [],
				DEFAULT_MODEL_METADATA: {},
				DEFAULT_MODEL_PARAMS: {}
			})
		);
		await page.route('**/ollama/config', (route) =>
			json(route, {
				ENABLE_OLLAMA_API: true,
				OLLAMA_BASE_URLS: ['http://ollama-a:11434', 'http://ollama-b:11434'],
				OLLAMA_API_CONFIGS: {}
			})
		);
		await page.route('**/openai/config', (route) =>
			json(
				route,
				opts.openai ?? {
					ENABLE_OPENAI_API: false,
					OPENAI_API_BASE_URLS: [],
					OPENAI_API_KEYS: [],
					OPENAI_API_CONFIGS: {}
				}
			)
		);
		await page.route('**/ollama/api/**', (route) => {
			const req = route.request();
			const url = new URL(req.url());
			let body: any = null;
			try {
				body = req.postDataJSON();
			} catch {
				/* none */
			}
			calls.push({ method: req.method(), path: url.pathname.replace('/ollama', ''), body });
			if (url.pathname.startsWith('/ollama/api/tags'))
				return json(route, {
					models: [
						{ model: 'llama3:8b', name: 'llama3:8b', size: 4.7 * 1024 ** 3 },
						{ model: 'phi3', name: 'phi3', size: 2.2 * 1024 ** 3 }
					]
				});
			if (url.pathname.startsWith('/ollama/api/pull'))
				return route.fulfill({
					status: 200,
					contentType: 'application/x-ndjson',
					body: ndjson(
						{ status: 'pulling manifest' },
						{ status: 'pulling abc', digest: 'sha256:abc', total: 200, completed: 50 },
						{ status: 'success' }
					)
				});
			if (url.pathname.startsWith('/ollama/api/delete')) return json(route, {});
			if (url.pathname.startsWith('/ollama/api/create'))
				return route.fulfill({
					status: 200,
					contentType: 'application/x-ndjson',
					body: ndjson({ status: 'creating model layer' }, { status: 'success' })
				});
			return json(route, {});
		});
		return { calls };
	}
	const dialog = (page: Page) => page.getByRole('dialog', { name: 'Manage Models' });
	const open = async (page: Page) => {
		await page.goto('/?settings=admin:models');
		await modal(page).getByRole('button', { name: 'Actions', exact: true }).click();
		await page.getByRole('menuitem', { name: 'Manage' }).click();
	};

	test('Ollama: pulls a pasted `ollama run` command as the plain tag, on the chosen instance, and reports success', async ({
		page
	}) => {
		const { calls } = await mockManage(page);
		await open(page);
		const d = dialog(page);
		await d.getByLabel('Ollama instance').selectOption('1');
		await d.getByLabel('Model tag to pull').fill('  ollama run mistral:7b ');
		await d.getByRole('button', { name: 'Pull Model' }).click();
		await expect(page.getByText("Model 'mistral:7b' has been successfully downloaded.")).toBeVisible();
		const pull = calls.find((c) => c.path.startsWith('/api/pull'));
		expect(pull).toMatchObject({ path: '/api/pull/1', body: { name: 'mistral:7b' } });
		await expect(d.getByLabel('Model tag to pull')).toHaveValue('');
	});

	test('Ollama: deleting a model asks first, then deletes that tag on that instance', async ({ page }) => {
		const { calls } = await mockManage(page);
		await open(page);
		const d = dialog(page);
		await expect(d.getByRole('option', { name: 'llama3:8b (4.7 GB)' })).toHaveCount(1);
		await expect(d.getByRole('button', { name: 'Delete Model' })).toBeDisabled();
		await d.getByLabel('Model to delete').selectOption('phi3');
		await d.getByRole('button', { name: 'Delete Model' }).click();
		expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
		await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm' }).click();
		await expect(page.getByText('Deleted phi3')).toBeVisible();
		expect(calls.find((c) => c.method === 'DELETE')).toMatchObject({ path: '/api/delete/0', body: { model: 'phi3' } });
	});

	test('Ollama: Create a model needs a tag and valid JSON, and posts them together', async ({ page }) => {
		const { calls } = await mockManage(page);
		await open(page);
		const d = dialog(page);
		await expect(d.getByRole('button', { name: 'Create Model' })).toBeDisabled();
		await d.getByLabel('New model tag').fill('my-model');
		await d.getByLabel('New model definition').fill('{oops');
		await d.getByRole('button', { name: 'Create Model' }).click();
		await expect(page.getByText(/JSON/).first()).toBeVisible();
		expect(calls.some((c) => c.path.startsWith('/api/create'))).toBe(false);
		await d.getByLabel('New model definition').fill('{"from":"llama3:8b"}');
		await d.getByRole('button', { name: 'Create Model' }).click();
		await expect
			.poll(() => calls.find((c) => c.path.startsWith('/api/create'))?.body)
			.toEqual({ model: 'my-model', from: 'llama3:8b' });
	});

	test('Ollama: Update All Models pulls each installed model in turn', async ({ page }) => {
		const { calls } = await mockManage(page);
		await open(page);
		await dialog(page).getByRole('button', { name: 'Update All Models' }).click();
		await expect(page.getByText('All models are up to date')).toBeVisible();
		expect(calls.filter((c) => c.path.startsWith('/api/pull')).map((c) => c.body.name)).toEqual(['llama3:8b', 'phi3']);
	});

	test('Ollama: the experimental GGUF upload stays hidden until asked for', async ({ page }) => {
		await mockManage(page);
		await open(page);
		const d = dialog(page);
		await expect(d.getByText('Upload a GGUF model')).toHaveCount(0);
		await d.getByRole('button', { name: 'Show' }).click();
		await expect(d.getByText('Upload a GGUF model')).toBeVisible();
		await d.getByRole('button', { name: 'File Mode' }).click();
		await expect(d.getByLabel('Hugging Face URL')).toBeVisible();
	});

	test('with Ollama and a llama.cpp connection, the engine can be chosen; the provider lists, loads and deletes models', async ({
		page
	}) => {
		const calls: Call[] = [];
		await mockManage(page, {
			openai: {
				ENABLE_OPENAI_API: true,
				OPENAI_API_BASE_URLS: ['http://llama:8080/v1'],
				OPENAI_API_KEYS: [''],
				OPENAI_API_CONFIGS: { 0: { provider: 'llama.cpp' } }
			}
		});
		await page.route('**/openai/models/0/**', (route) => {
			const req = route.request();
			const url = new URL(req.url());
			let body: any = null;
			try {
				body = req.postDataJSON();
			} catch {
				/* none */
			}
			calls.push({ method: req.method(), path: url.pathname.replace('/openai', '') + url.search, body });
			if (url.pathname.endsWith('/catalog'))
				return json(route, {
					models: [
						{ id: 'qwen', status: 'unloaded' },
						{ id: 'gemma', display_name: 'Gemma 2', status: { value: 'loaded' } }
					]
				});
			return json(route, { ok: true });
		});
		await page.route(
			'**/openai/models/0?**',
			(route) => (
				calls.push({
					method: route.request().method(),
					path: new URL(route.request().url()).pathname.replace('/openai', '') + new URL(route.request().url()).search,
					body: null
				}),
				json(route, { ok: true })
			)
		);
		await open(page);
		const d = dialog(page);
		await d.getByLabel('Engine').selectOption('provider');
		await expect(d.getByText('Gemma 2')).toBeVisible();
		await expect(d.getByText('loaded', { exact: true })).toBeVisible();
		await expect(d.getByRole('button', { name: 'Load Gemma 2', exact: true })).toBeDisabled();
		await d.getByRole('button', { name: 'Load qwen', exact: true }).click();
		await expect(page.getByText('Model loaded successfully')).toBeVisible();
		expect(calls.find((c) => c.path === '/models/0/load')?.body).toEqual({ model: 'qwen' });
		await d.getByRole('button', { name: 'Delete qwen', exact: true }).click();
		await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm' }).click();
		await expect(page.getByText('Model deleted successfully')).toBeVisible();
		expect(calls.find((c) => c.method === 'DELETE')?.path).toBe('/models/0?model=qwen');
	});
});

test.describe('settings: Integrations', () => {
	type Seen = {
		tools: Rec[];
		terminals: Rec[];
		policy: Rec[];
		lifecycle: Rec[];
		toolVerify: Rec | null;
		knowledge: { path: string; body: Rec }[];
	};

	async function mockIntegrations(
		page: Page,
		opts: {
			servers?: Rec[];
			terminals?: Rec[];
			verifyType?: string | null;
			knowledge?: { connections: Rec[]; items: Rec[] };
			testDocs?: string[];
		} = {}
	) {
		const seen: Seen = { tools: [], terminals: [], policy: [], lifecycle: [], toolVerify: null, knowledge: [] };
		const servers = opts.servers ?? [
			{
				type: 'openapi',
				url: 'https://tools.example',
				path: 'openapi.json',
				auth_type: 'bearer',
				key: 'sk-tool',
				config: { enable: true },
				info: { id: 'wx', name: 'Weather' }
			},
			{ type: 'mcp', url: 'https://mcp.example/', config: { enable: false }, info: {} }
		];
		await page.route('**/api/v1/configs/tool_servers', (route) => {
			if (route.request().method() === 'POST') {
				seen.tools.push(route.request().postDataJSON());
				return json(route, seen.tools.at(-1));
			}
			return json(route, { TOOL_SERVER_CONNECTIONS: servers });
		});
		await page.route('**/api/v1/configs/tool_servers/verify', (route) => {
			seen.toolVerify = route.request().postDataJSON();
			return json(route, { ok: true });
		});
		await page.route('**/api/v1/configs/terminal_servers', (route) => {
			if (route.request().method() === 'POST') {
				seen.terminals.push(route.request().postDataJSON());
				return json(route, seen.terminals.at(-1));
			}
			return json(route, { TERMINAL_SERVER_CONNECTIONS: opts.terminals ?? [] });
		});
		await page.route('**/api/v1/configs/terminal_servers/verify', (route) =>
			json(route, { type: opts.verifyType ?? 'terminal' })
		);
		await page.route('**/api/v1/configs/terminal_servers/policy', (route) => {
			const body = route.request().postDataJSON();
			if (!body.policy_data) return json(route, { data: { image: 'img:1', env: { A: 'b' } } });
			seen.policy.push(body);
			return json(route, { ok: true });
		});
		await page.route('**/api/v1/configs/terminal_servers/lifecycle', (route) => {
			const body = route.request().postDataJSON();
			if (!body.lifecycle_data) return json(route, { data: { reset: { schedule: '@weekly' } } });
			seen.lifecycle.push(body);
			return json(route, { ok: true });
		});
		const k = opts.knowledge ?? { connections: [], items: [] };
		await page.route('**/api/v1/knowledge/external/**', (route) => {
			const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
			if (route.request().method() === 'GET') return json(route, { items: k.connections });
			seen.knowledge.push({ path, body: route.request().postDataJSON() });
			if (path.endsWith('/source/test'))
				return json(route, { documents: opts.testDocs ?? ['a chunk'], metadatas: [{}], distances: [0.1] });
			return json(route, { id: 'new' });
		});
		await page.route('**/api/v1/knowledge/search*', (route) => json(route, { items: k.items, total: k.items.length }));
		return seen;
	}

	test('lists tool servers by name (or URL) with their state; a switch saves the whole list', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const seen = await mockIntegrations(page);
		await page.goto('/?settings=admin:integrations');
		const m = modal(page);
		await expect(m.getByRole('switch', { name: 'Disable Weather' })).toBeChecked();
		await expect(m.getByRole('switch', { name: 'Enable https://mcp.example/' })).not.toBeChecked();
		await expect(m.getByText('No terminal connections configured.')).toBeVisible();
		await expect(m.getByText('No external knowledge sources configured.')).toBeVisible();
		await m.getByRole('switch', { name: 'Enable https://mcp.example/' }).click();
		await expect.poll(() => seen.tools.at(-1)?.TOOL_SERVER_CONNECTIONS?.[1]?.config).toEqual({ enable: true });
		expect(seen.tools.at(-1)?.TOOL_SERVER_CONNECTIONS[0].key).toBe('sk-tool');
	});

	test('adding an OpenAPI server drops the trailing slash; an ID with ":" is refused', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const seen = await mockIntegrations(page, { servers: [] });
		await page.goto('/?settings=admin:integrations');
		await modal(page).getByRole('button', { name: 'Add Tool Server' }).click();
		const d = page.getByRole('dialog', { name: 'Add Connection' });
		await d.getByLabel('URL', { exact: true }).fill('https://new.example/');
		await d.getByLabel('ID').fill('bad:id');
		await d.getByRole('button', { name: 'Save' }).click();
		await expect(page.getByText('ID cannot contain ":" or "|" characters')).toBeVisible();
		expect(seen.tools).toHaveLength(0);
		await d.getByLabel('ID').fill('good');
		await d.getByPlaceholder('API Key').fill('k1');
		await d.getByRole('button', { name: 'Save' }).click();
		await expect
			.poll(() => seen.tools.at(-1)?.TOOL_SERVER_CONNECTIONS)
			.toEqual([
				expect.objectContaining({
					type: 'openapi',
					url: 'https://new.example',
					key: 'k1',
					path: 'openapi.json',
					config: { enable: true, function_name_filter_list: '', access_grants: [] },
					info: { id: 'good', name: '', description: '' }
				})
			]);
	});

	test('MCP keeps its trailing slash, warns, and OAuth 2.1 needs a registered client', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const seen = await mockIntegrations(page, { servers: [] });
		await page.goto('/?settings=admin:integrations');
		await modal(page).getByRole('button', { name: 'Add Tool Server' }).click();
		const d = page.getByRole('dialog', { name: 'Add Connection' });
		await d.getByRole('button', { name: 'Type' }).click();
		await expect(d.getByText(/MCP support is experimental/)).toBeVisible();
		await d.getByLabel('URL', { exact: true }).fill('https://mcp.example/mcp/');
		await d.getByLabel('ID').fill('m1');
		await d.getByLabel('Auth', { exact: true }).selectOption('oauth_2.1');
		await expect(d.getByText('Not Registered')).toBeVisible();
		await d.getByRole('button', { name: 'Save' }).click();
		await expect(page.getByText('Please register the OAuth client')).toBeVisible();
		await d.getByLabel('Auth', { exact: true }).selectOption('none');
		await d.getByRole('button', { name: 'Save' }).click();
		await expect
			.poll(() => seen.tools.at(-1)?.TOOL_SERVER_CONNECTIONS?.[0])
			.toMatchObject({ type: 'mcp', url: 'https://mcp.example/mcp/', auth_type: 'none' });
	});

	test('editing opens with the saved values; Delete asks first, then saves without it', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const seen = await mockIntegrations(page);
		await page.goto('/?settings=admin:integrations');
		await modal(page).getByRole('button', { name: 'Configure Weather' }).click();
		const d = page.getByRole('dialog', { name: 'Edit Connection' });
		await expect(d.getByLabel('URL', { exact: true })).toHaveValue('https://tools.example');
		await expect(d.getByLabel('ID')).toHaveValue('wx');
		await d.getByRole('button', { name: 'Delete' }).click();
		await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
		await expect
			.poll(() => seen.tools.at(-1)?.TOOL_SERVER_CONNECTIONS)
			.toEqual([expect.objectContaining({ url: 'https://mcp.example/' })]);
	});

	test('Verify sends the server to the backend; Export leaves the API key out', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const seen = await mockIntegrations(page);
		await page.goto('/?settings=admin:integrations');
		await modal(page).getByRole('button', { name: 'Configure Weather' }).click();
		const d = page.getByRole('dialog', { name: 'Edit Connection' });
		await d.getByRole('button', { name: 'Verify Connection' }).click();
		await expect
			.poll(() => seen.toolVerify)
			.toMatchObject({
				url: 'https://tools.example',
				path: 'openapi.json',
				type: 'openapi',
				key: 'sk-tool',
				info: { id: 'wx', name: 'Weather' }
			});
		const download = page.waitForEvent('download');
		await d.getByRole('button', { name: 'Export' }).click();
		const file = await download;
		expect(file.suggestedFilename()).toBe('tool-server-wx.json');
		const text = await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c).toString());
		expect(JSON.parse(text)[0]).toMatchObject({ url: 'https://tools.example', info: { id: 'wx' } });
		expect(text).not.toContain('sk-tool');
	});

	test('a terminal found to be an Orchestrator gets a policy ID, and Save writes the policy before the connection', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const seen = await mockIntegrations(page, { verifyType: 'orchestrator' });
		await page.goto('/?settings=admin:integrations');
		await modal(page).getByRole('button', { name: 'Add Terminal Connection' }).click();
		const d = page.getByRole('dialog', { name: 'Add Terminal Connection' });
		await d.getByLabel('Name').fill('Python DS');
		await d.getByLabel('URL', { exact: true }).fill('http://orch:9900/');
		await d.getByPlaceholder('API Key').fill('  okey ');
		await d.getByRole('button', { name: 'Verify Connection' }).click();
		await d.getByRole('button', { name: 'Orchestrator' }).click();
		await expect(d.getByLabel('Policy ID')).toHaveValue('python-ds');
		await d.getByLabel('Chat', { exact: true }).selectOption('chat_id');
		await d.getByRole('button', { name: '+ Add' }).click();
		await d.getByLabel('Variable 1 name').fill('TOKEN');
		await d.getByLabel('Variable 1 value').fill('x');
		await d.getByRole('button', { name: 'Save' }).click();
		await expect.poll(() => seen.terminals.length).toBe(1);
		expect(seen.policy[0]).toMatchObject({
			url: 'http://orch:9900',
			policy_id: 'python-ds',
			policy_data: { cpu_limit: '1', memory_limit: '1Gi', idle_timeout_minutes: 30, env: { TOKEN: 'x' } }
		});
		expect(seen.lifecycle[0]).toMatchObject({ policy_id: 'python-ds', lifecycle_data: {} });
		const saved = seen.terminals[0].TERMINAL_SERVER_CONNECTIONS[0];
		expect(saved).toMatchObject({
			url: 'http://orch:9900',
			key: 'okey',
			name: 'Python DS',
			enabled: false,
			server_type: 'orchestrator',
			policy_id: 'python-ds',
			config: { access_grants: [], contexts: { chat: { context_id: 'chat_id' } } }
		});
		expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
	});

	test('editing an Orchestrator terminal loads its policy back; bad lifecycle JSON is refused', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const seen = await mockIntegrations(page, {
			terminals: [{ id: 't1', url: 'http://orch', name: 'Orch', policy_id: 'p1', enabled: true, config: { extra: 1 } }]
		});
		await page.goto('/?settings=admin:integrations');
		await modal(page).getByRole('button', { name: 'Configure Orch' }).click();
		const d = page.getByRole('dialog', { name: 'Edit Terminal Connection' });
		await d.getByRole('button', { name: 'Orchestrator' }).click();
		await expect(d.getByLabel('Image')).toHaveValue('img:1');
		await expect(d.getByLabel('Policy ID')).toBeDisabled();
		await expect(d.getByLabel('Lifecycle JSON')).toHaveValue(/@weekly/);
		await d.getByLabel('Lifecycle JSON').fill('[1]');
		await d.getByRole('button', { name: 'Save' }).click();
		await expect(page.getByText('Lifecycle JSON must be a JSON object')).toBeVisible();
		expect(seen.policy).toHaveLength(0);
		await d.getByLabel('Lifecycle JSON').fill('{}');
		await d.getByRole('button', { name: 'Save' }).click();
		await expect
			.poll(() => seen.terminals.at(-1)?.TERMINAL_SERVER_CONNECTIONS?.[0])
			.toMatchObject({ id: 't1', policy_id: 'p1', config: { extra: 1 } });
		expect(seen.policy[0].policy_data).toMatchObject({ image: 'img:1', env: { A: 'b' } });
	});

	test('a knowledge source cannot be created until a test passes, and an edit asks for a new test', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const seen = await mockIntegrations(page);
		await page.goto('/?settings=admin:integrations');
		await modal(page).getByRole('button', { name: 'Add Knowledge Connection' }).click();
		const d = page.getByRole('dialog', { name: 'Add Knowledge Connection' });
		await d.getByLabel('Name').fill('Research');
		await d.getByLabel('Endpoint').fill('https://q.example');
		await d.getByLabel('Collection', { exact: true }).fill('docs');
		await d.getByRole('textbox', { name: 'Test Query' }).fill('what?');
		await expect(d.getByRole('button', { name: 'Create' })).toBeDisabled();
		await d.getByRole('button', { name: 'Run test query' }).click();
		await expect(d.getByRole('button', { name: 'Create' })).toBeEnabled();
		await d.getByLabel('Collection', { exact: true }).fill('docs2');
		await expect(d.getByRole('button', { name: 'Create' })).toBeDisabled();
		await d.getByRole('button', { name: 'Run test query' }).click();
		await d.getByRole('button', { name: 'Create' }).click();
		await expect
			.poll(() => seen.knowledge.find((c) => c.path.endsWith('/source/create'))?.body)
			.toMatchObject({
				name: 'Research',
				connection: { provider: 'qdrant', endpoint: 'https://q.example', auth_config: {}, config: { timeout: 30 } },
				source: {
					type: 'collection',
					name: 'docs2',
					config: { content_field: 'payload.text', metadata_field: 'payload.metadata', document_id_field: 'id' }
				},
				test_query: 'what?'
			});
	});

	test('a knowledge source with no enabled flag shows as on, and its switch turns it off', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const seen = await mockIntegrations(page, {
			knowledge: {
				connections: [{ id: 'c1', name: 'Q', provider: 'qdrant', endpoint: 'https://q', config: {} }],
				items: [
					{
						id: 'k1',
						name: 'Papers',
						meta: { external: { connection_id: 'c1', provider: 'qdrant', source: { name: 'papers' } } }
					}
				]
			}
		});
		await page.goto('/?settings=admin:integrations');
		await expect(modal(page).getByText('qdrant · papers')).toBeVisible();
		await modal(page).getByRole('switch', { name: 'Disable Papers' }).click();
		await expect
			.poll(() => seen.knowledge.at(-1))
			.toEqual({
				path: '/knowledge/external/connections/c1',
				body: expect.objectContaining({ enabled: false, auth_config: null })
			});
	});
});
