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

// Server tabs are pages under Admin (S5-D1); personal tabs are in the dialog.
const modal = (page: Page) =>
	page
		.getByRole('dialog', { name: 'Settings' })
		.or(page.getByRole('region', { name: /^(Server settings|Analytics)$/ }));

test.describe('server settings pages (S5-D1, #932)', () => {
	// The server's settings are pages under Admin; the dialog keeps personal settings.
	const server = (page: Page) => page.getByRole('region', { name: 'Server settings' });
	// The dialog itself, not the file's `modal` helper, which may also match the pages.
	const modal = (page: Page) => page.getByRole('dialog', { name: 'Settings' });

	test('?settings=admin:<tab> is replaced with its page under Admin (NAV-1)', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockConfigApi(page, '/configs', {
			'/configs/code_execution': { ENABLE_CODE_EXECUTION: false, ENABLE_CODE_INTERPRETER: false }
		});
		await page.goto('/?settings=admin:code-execution');
		await expect(page).toHaveURL(/\/admin\/settings\/code-execution$/);
		await expect(modal(page)).toHaveCount(0);
		await expect(server(page).getByRole('tab', { name: 'Code Execution', selected: true })).toBeVisible();
		await expect(server(page).getByRole('heading', { name: 'Code Execution', level: 2 })).toBeVisible();
		await expect(page).toHaveTitle('Code Execution · Settings · local-llm');
	});

	test('/admin/settings/<tab> is a page: it survives a reload, and Back leaves it', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockConfigApi(page, '/utils', {});
		await page.goto('/');
		await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
		await page.goto('/admin/settings/db');
		await expect(server(page).getByRole('heading', { name: 'Database', level: 2 })).toBeVisible();
		await expect(modal(page)).toHaveCount(0);
		await page.reload();
		await expect(server(page).getByRole('heading', { name: 'Database', level: 2 })).toBeVisible();
		await page.goBack();
		await expect(page).toHaveURL(/localhost:5174\/$/);
	});

	test('opened from the app it adds a history entry: Back closes it (NAV-1)', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockConfigApi(page, '/configs', { '/configs/subagents': {} });
		await page.goto('/');
		await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
		await page.keyboard.press('ControlOrMeta+.');
		await expect(modal(page)).toBeVisible();
		await expect(page).toHaveURL(/\?settings=general$/);
		await modal(page).getByRole('tab', { name: 'Interface', exact: true }).click();
		await expect(page).toHaveURL(/\?settings=interface$/);
		await page.goBack();
		await expect(modal(page)).toHaveCount(0);
		await expect(page).toHaveURL(/localhost:5174\/$/);
	});

	test('the Settings tab in the admin layout opens the first server settings page', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await page.route('**/api/v1/users/**', (route) => json(route, { users: [], total: 0 }));
		await page.route('**/api/v1/groups/**', (route) => json(route, []));
		await page.goto('/admin/users/overview');
		await page.getByRole('link', { name: 'Settings', exact: true }).click();
		await expect(page).toHaveURL(/\/admin\/settings\/general$/);
		await expect(server(page).getByRole('tab', { selected: true })).toHaveAccessibleName('General');
		await expect(page.getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('aria-current', 'page');
		await expect(modal(page)).toHaveCount(0);
	});

	test('a non-admin asking for an admin tab gets no modal, and the param is dropped', async ({ page }) => {
		await mockWorkspaceBackend(page, { role: 'user' });
		await page.goto('/?settings=admin:db');
		await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
		await expect(modal(page)).toHaveCount(0);
		await expect(page).toHaveURL(/localhost:5174\/$/);
	});

	test('an unknown tab goes back to the list, which opens its first tab', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockConfigApi(page, '/configs', {});
		await page.goto('/?settings=admin:nonsense');
		await expect(page).toHaveURL(/\/admin\/settings\/general$/);
		await expect(server(page).getByRole('tab', { selected: true })).toHaveAccessibleName('General');
	});

	test('search finds server tabs from the dialog and on the page, and says when nothing matches (#1001)', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		await mockConfigApi(page, '/configs', { '/configs/code_execution': {} });
		await mockConfigApi(page, '/utils', {});
		await page.goto('/?settings=interface');
		const search = modal(page).getByRole('combobox', { name: 'Search settings' });
		await search.fill('sandbox');
		await expect(modal(page).getByRole('option')).toHaveText(['Code Execution']);
		// The open tab stays while searching.
		await expect(modal(page).getByRole('heading', { name: 'Interface', level: 2 })).toBeVisible();
		await search.press('Enter');
		await expect(page).toHaveURL(/\/admin\/settings\/code-execution$/);
		await expect(modal(page)).toHaveCount(0);
		const pageSearch = server(page).getByRole('searchbox', { name: 'Search server settings' });
		await pageSearch.fill('database');
		await expect(server(page).getByRole('tab')).toHaveText(['Database']);
		await pageSearch.fill('zzzz');
		await expect(server(page).getByText('No server settings match ‘zzzz’.')).toBeVisible();
		await expect(server(page).getByRole('heading', { name: 'Code Execution', level: 2 })).toBeVisible();
		await server(page).getByRole('button', { name: 'Clear search' }).click();
		await expect(server(page).getByRole('tab').first()).toBeVisible();
	});

	test('the dialog’s “Server settings” row leaves for the pages, and Back returns to the dialog', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockConfigApi(page, '/configs', {});
		await page.goto('/?settings=general');
		await expect(modal(page).getByRole('tab', { name: /Server/ })).toHaveCount(0);
		await modal(page).getByRole('button', { name: 'Server settings' }).click();
		await expect(page).toHaveURL(/\/admin\/settings\/general$/);
		await expect(modal(page)).toHaveCount(0);
		await page.goBack();
		await expect(modal(page)).toBeVisible();
		await expect(page).toHaveURL(/\?settings=general$/);
	});

	test('the user menu offers Settings to an admin', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockConfigApi(page, '/configs', { '/configs/subagents': {} });
		await page.goto('/');
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

test.describe('settings: Sub-agents limits (#602)', () => {
	test('saves -1 for iterations and output, and still refuses a bounded value below the minimum', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockConfigApi(page, '/configs', {
			'/configs/subagents': {
				ENABLE_SUBAGENTS: true,
				SUBAGENTS_BACKGROUND_ENABLED: false,
				SUBAGENTS_MAX_CONCURRENT: 20,
				SUBAGENTS_MAX_ASYNC: 20,
				SUBAGENTS_MAX_ITERATIONS: -1,
				SUBAGENTS_MAX_OUTPUT: -1,
				SUBAGENTS_SYSTEM_PROMPT: ''
			}
		});
		await page.goto('/?settings=admin:subagents');
		const m = modal(page);
		await expect(m.getByLabel('Max iterations')).toHaveValue('-1');
		await expect(m.getByLabel('Max output')).toHaveValue('-1');
		const posted = () => calls.filter((c) => c.method === 'POST' && c.path === '/configs/subagents');

		// The browser's own validation used to block Save on the whole tab here.
		await m.getByLabel('System prompt').fill('be brief');
		await m.getByRole('button', { name: 'Save' }).click();
		await expect
			.poll(() => posted()[0]?.body)
			.toMatchObject({ SUBAGENTS_MAX_ITERATIONS: -1, SUBAGENTS_MAX_OUTPUT: -1 });

		await m.getByLabel('Max output').fill('500');
		await m.getByRole('button', { name: 'Save' }).click();
		await expect(m.getByLabel('Max output')).toHaveJSProperty(
			'validationMessage',
			'Enter -1 for no limit, or at least 1000.'
		);
		expect(posted()).toHaveLength(1);
	});
});

test.describe('settings: Code Execution', () => {
	// A server that last saved before the sandbox became the only engine.
	const cfg = {
		ENABLE_CODE_EXECUTION: true,
		CODE_EXECUTION_ENGINE: 'jupyter',
		ENABLE_CODE_INTERPRETER: true,
		CODE_INTERPRETER_ENGINE: 'pyodide',
		CODE_INTERPRETER_PROMPT_TEMPLATE: '',
		CODE_INTERPRETER_SANDBOX_DEFAULT_IMAGE: 'data',
		CODE_INTERPRETER_SANDBOX_TIMEOUT: 60,
		CODE_INTERPRETER_SANDBOX_MAX_RUNNING: 4,
		CODE_INTERPRETER_SANDBOX_IDLE_MINUTES: 30,
		CODE_INTERPRETER_SANDBOX_RETENTION_DAYS: 7
	};

	test('there is no engine to choose and no Jupyter field, whatever engine is stored', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockConfigApi(page, '/configs', { '/configs/code_execution': cfg });
		await page.goto('/?settings=admin:code-execution');
		const m = modal(page);
		await expect(m.getByLabel('Sandbox Maximum Running')).toBeVisible();
		await expect(m.getByLabel('Code Execution Engine')).toHaveCount(0);
		await expect(m.getByLabel('Code Interpreter Engine')).toHaveCount(0);
		await expect(m.getByText(/jupyter/i)).toHaveCount(0);
		await m.getByLabel('Sandbox Maximum Running').fill('5');
		await m.getByRole('button', { name: 'Save' }).click();
		await expect
			.poll(() => calls.find((c) => c.method === 'POST' && c.path === '/configs/code_execution')?.body)
			.toMatchObject({ CODE_EXECUTION_ENGINE: 'sandbox', CODE_INTERPRETER_ENGINE: 'sandbox' });
	});

	test('the interpreter section has the prompt template, and the sandbox settings move with its switch', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		await mockConfigApi(page, '/configs', { '/configs/code_execution': cfg });
		await page.goto('/?settings=admin:code-execution');
		const m = modal(page);
		await expect(m.getByText('Code Interpreter Prompt Template')).toBeVisible();
		await expect(
			m.getByRole('region', { name: 'Code Interpreter' }).getByLabel('Sandbox Maximum Running')
		).toBeVisible();
		await m.getByRole('switch', { name: 'Enable Code Interpreter' }).click();
		await expect(m.getByText('Code Interpreter Prompt Template')).toHaveCount(0);
		await expect(m.getByRole('region', { name: 'Code Execution' }).getByLabel('Sandbox Maximum Running')).toBeVisible();
		await m.getByRole('switch', { name: 'Enable Code Execution' }).click();
		await expect(m.getByLabel('Sandbox Maximum Running')).toHaveCount(0);
	});

	test('the sandbox shows its settings and status, and saves them', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockConfigApi(page, '/configs', { '/configs/code_execution': cfg });
		await page.route('**/api/v1/sandbox/status', (route) =>
			json(route, { ready: false, reason: 'the kata-clh runtime is not registered with Docker' })
		);
		await page.goto('/?settings=admin:code-execution');
		const m = modal(page);
		const notice = m.locator('[data-slot="status-notice"]');
		await expect(notice).toHaveAttribute('data-tone', 'warning');
		await expect(notice).toContainText("The sandbox isn't ready");
		await expect(notice).toContainText('The kata-clh runtime is not registered with Docker');
		await expect(m.getByText(/4 GiB of memory and 2 CPUs, so 16 at once is 64 GiB/)).toBeVisible();
		await m.getByLabel('Sandbox Default Image').selectOption('web');
		await m.getByLabel('Sandbox Maximum Running').fill('8');
		await m.getByRole('button', { name: 'Save' }).click();
		await expect
			.poll(() => calls.find((c) => c.method === 'POST' && c.path === '/configs/code_execution')?.body)
			.toMatchObject({
				CODE_EXECUTION_ENGINE: 'sandbox',
				CODE_INTERPRETER_ENGINE: 'sandbox',
				CODE_INTERPRETER_SANDBOX_DEFAULT_IMAGE: 'web',
				CODE_INTERPRETER_SANDBOX_TIMEOUT: 60,
				CODE_INTERPRETER_SANDBOX_MAX_RUNNING: 8
			});
	});
});

test.describe('settings: Database', () => {
	test('Export settings downloads JSON; the users CSV neutralizes formulas', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockConfigApi(page, '/configs', { '/configs/export': { a: 1 } });
		await page.route('**/api/v1/users/all', (route) =>
			json(route, { users: [{ id: 'u1', name: '=HYPERLINK("http://evil","x")', email: 'a@b.c', role: 'user' }] })
		);
		await page.goto('/?settings=admin:db');
		const m = modal(page);
		const cfgDownload = page.waitForEvent('download');
		await m.getByRole('button', { name: 'Export settings' }).click();
		expect((await cfgDownload).suggestedFilename()).toMatch(/^local-llm-config-\d{4}-\d{2}-\d{2}\.json$/);
		// The SQLite-only database download is gone; the backup is a pg_dump command (#961).
		await expect(m.getByRole('button', { name: 'Database' })).toHaveCount(0);
		await expect(m.getByText(/pg_dump -Fc/)).toBeVisible();

		const usersDownload = page.waitForEvent('download');
		await m.getByRole('button', { name: 'Export users' }).click();
		const dl = await usersDownload;
		expect(dl.suggestedFilename()).toMatch(/^local-llm-users-[\d-]+\.csv$/);
		const stream = await dl.createReadStream();
		let text = '';
		for await (const chunk of stream) text += chunk;
		expect(text.split('\n')[0]).toBe('id,name,email,role');
		expect(text).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
	});

	test('Import settings posts the parsed file', async ({ page }) => {
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
	test('an added arena model joins the draft and the tab Save sends the whole config (FRM-3)', async ({ page }) => {
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
		await expect(m.getByText('None yet, so the Arena model chooses among all your models.')).toBeVisible();
		await m.getByRole('button', { name: 'Add arena model' }).click();
		const dialog = page.getByRole('dialog', { name: 'Add arena model' });
		await dialog.getByLabel('Name', { exact: true }).fill('My Arena!');
		await expect(dialog.getByLabel('ID', { exact: true })).toHaveValue('my-arena');
		await dialog.getByLabel('Select a model').selectOption('m1');
		await dialog.getByRole('button', { name: 'Add model' }).click();
		await dialog.getByRole('button', { name: 'Add arena model' }).click();
		// Nothing is sent until the tab's Save.
		await expect(m.getByText('My Arena!')).toBeVisible();
		await expect(m.getByText('Unsaved changes')).toBeVisible();
		expect(saved).toBeNull();
		await m.getByRole('button', { name: 'Save', exact: true }).click();
		await expect
			.poll(() => saved)
			.toMatchObject({
				ENABLE_EVALUATION_ARENA_MODELS: true,
				EVALUATION_ARENA_MODELS: [
					{ id: 'my-arena', name: 'My Arena!', meta: { model_ids: ['m1'], filter_mode: 'include', description: null } }
				]
			});
		await expect(m.getByText('All changes saved')).toBeVisible();
	});

	test('a duplicate arena name is refused', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await page.route('**/api/v1/groups/**', (route) => json(route, []));
		await page.route('**/api/models*', (route) => json(route, { data: [{ id: 'm1', name: 'Taken' }] }));
		await page.route('**/api/v1/evaluations/config', (route) =>
			json(route, { ENABLE_EVALUATION_ARENA_MODELS: true, EVALUATION_ARENA_MODELS: [] })
		);
		await page.goto('/?settings=admin:evaluations');
		await modal(page).getByRole('button', { name: 'Add arena model' }).click();
		const dialog = page.getByRole('dialog', { name: 'Add arena model' });
		await dialog.getByLabel('Name', { exact: true }).fill('Taken');
		await dialog.getByRole('button', { name: 'Add arena model' }).click();
		await expect(page.getByText('Model name already exists')).toBeVisible();
		await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('');
	});
});

test.describe('settings: Pipelines', () => {
	test('with no server the tab is not offered, and its address goes to the first tab (S5-D4)', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await page.route('**/api/v1/pipelines/list', (route) => json(route, { data: [] }));
		await page.goto('/admin/settings/pipelines');
		await expect(page).toHaveURL(/\/admin\/settings\/general$/);
		await expect(
			page.getByRole('region', { name: 'Server settings' }).getByRole('tab', { name: 'Pipelines' })
		).toHaveCount(0);
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

	test('lists the upstreams, marks a disabled one Off, and flags a Pipelines server', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockUpstreams(page);
		await page.goto('/?settings=admin:connections');
		const m = modal(page);
		const list = m.getByRole('list', { name: 'OpenAI-compatible connections' });
		const rows = list.getByRole('listitem');
		await expect(rows.nth(0)).toContainText('https://openrouter.ai/api/v1');
		await expect(rows.nth(1)).toContainText('http://localhost:8090/v1');
		await expect(m.getByRole('switch', { name: 'Enable https://openrouter.ai/api/v1' })).toBeChecked();
		await expect(m.getByRole('switch', { name: 'Enable http://localhost:8090/v1' })).not.toBeChecked();
		await expect(rows.nth(1).locator('[data-slot=badge]', { hasText: 'Off' })).toBeVisible();
		await expect(list.getByText('Pipelines', { exact: true })).toHaveCount(1);
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
		await expect(page.getByText('“http://localhost:8090/v1” is on')).toBeVisible();
	});

	test('adding a connection appends the URL (minus a trailing slash), key and config, and saves', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const seen = await mockUpstreams(page);
		await page.goto('/?settings=admin:connections');
		await modal(page).getByRole('button', { name: 'Add connection' }).first().click();
		const dialog = page.getByRole('dialog', { name: 'Add connection' });
		await dialog.getByLabel('URL', { exact: true }).fill('https://api.groq.com/openai/v1/');
		await dialog.getByLabel(/API key/).fill('gsk_123');
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
		await expect(dialog).toBeHidden();
	});

	test('deleting the first connection asks, naming it, and re-indexes the config map', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const seen = await mockUpstreams(page);
		await page.goto('/?settings=admin:connections');
		await modal(page).getByRole('button', { name: 'Edit https://openrouter.ai/api/v1' }).click();
		const dialog = page.getByRole('dialog', { name: 'Edit connection' });
		await expect(dialog.getByLabel('URL', { exact: true })).toHaveValue('https://openrouter.ai/api/v1');
		await dialog.getByRole('button', { name: 'Delete connection' }).click();
		const ask = page.getByRole('alertdialog', { name: 'Delete “https://openrouter.ai/api/v1”?' });
		await ask.getByRole('button', { name: 'Delete connection' }).click();
		await expect
			.poll(() => seen.openaiUpdate)
			.toMatchObject({
				OPENAI_API_BASE_URLS: ['http://localhost:8090/v1'],
				OPENAI_API_KEYS: [''],
				OPENAI_API_CONFIGS: { 0: { enable: false } }
			});
	});

	test('Azure needs an API version, then deployment names, each said under its field', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const seen = await mockUpstreams(page);
		await page.goto('/?settings=admin:connections');
		await modal(page).getByRole('button', { name: 'Add connection' }).first().click();
		const dialog = page.getByRole('dialog', { name: 'Add connection' });
		await dialog.getByLabel('URL', { exact: true }).fill('https://mine.openai.azure.com');
		await dialog.getByLabel(/API key/).fill('k');
		await dialog.getByRole('button', { name: 'Save' }).click();
		const version = dialog.getByLabel('API version');
		await expect(version).toHaveAccessibleDescription('Enter the Azure API version.');
		await expect(version).toBeFocused();
		await version.fill('2024-02-01');
		await dialog.getByRole('button', { name: 'Save' }).click();
		const models = dialog.getByLabel(/Model IDs/);
		await expect(models).toHaveAccessibleDescription('Add a deployment name. Azure OpenAI needs at least one.');
		await models.fill('gpt-4o');
		await dialog.getByRole('button', { name: 'Add model ID' }).click();
		await dialog.getByRole('button', { name: 'Save' }).click();
		await expect
			.poll(() => seen.openaiUpdate?.OPENAI_API_CONFIGS?.[2])
			.toMatchObject({ azure: true, api_version: '2024-02-01', model_ids: ['gpt-4o'] });
	});

	test('bad headers JSON is refused under its field and does not leave Save spinning', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const seen = await mockUpstreams(page);
		await page.goto('/?settings=admin:connections');
		await modal(page).getByRole('button', { name: 'Add connection' }).first().click();
		const dialog = page.getByRole('dialog', { name: 'Add connection' });
		await dialog.getByLabel('URL', { exact: true }).fill('https://x.example/v1');
		await dialog.getByRole('button', { name: 'Advanced' }).click();
		await dialog.getByLabel(/Headers/).fill('[1, 2]');
		await dialog.getByRole('button', { name: 'Save' }).click();
		await expect(dialog.getByLabel(/Headers/)).toHaveAccessibleDescription(
			'Enter the headers as a JSON object, or leave them empty.'
		);
		await expect(dialog.getByRole('button', { name: 'Save' })).toBeEnabled();
		expect(seen.openaiUpdate).toBeNull();
	});

	test('Test connection sends the URL, key and auth config, and says what it found under the URL', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const seen = await mockUpstreams(page);
		await page.goto('/?settings=admin:connections');
		await modal(page).getByRole('button', { name: 'Add connection' }).first().click();
		const dialog = page.getByRole('dialog', { name: 'Add connection' });
		await dialog.getByLabel('URL', { exact: true }).fill('http://localhost:8090/v1/');
		await dialog.getByLabel(/API key/).fill('local');
		await dialog.getByRole('button', { name: 'Test connection' }).click();
		await expect
			.poll(() => seen.verify)
			.toMatchObject({ url: 'http://localhost:8090/v1', key: 'local', config: { auth_type: 'bearer' } });
		await expect(dialog.getByText('Reachable: 0 models')).toBeVisible();
	});

	test('Ollama connections save their key inside the config, and Direct connections saves at once', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const seen = await mockUpstreams(page, { ollama: { ENABLE_OLLAMA_API: true } });
		await page.goto('/?settings=admin:connections');
		await modal(page).getByRole('button', { name: 'Add connection' }).nth(1).click();
		const dialog = page.getByRole('dialog', { name: 'Add connection' });
		await dialog.getByLabel('URL', { exact: true }).fill('http://localhost:11434');
		await dialog.getByLabel(/API key/).fill('olk');
		await dialog.getByRole('button', { name: 'Save' }).click();
		await expect
			.poll(() => seen.ollamaUpdate)
			.toMatchObject({
				ENABLE_OLLAMA_API: true,
				OLLAMA_BASE_URLS: ['http://localhost:11434'],
				OLLAMA_API_CONFIGS: { 0: { key: 'olk', connection_type: 'local' } }
			});

		await modal(page).getByRole('switch', { name: 'Direct connections' }).click();
		await expect
			.poll(() => seen.directUpdate)
			.toEqual({ ENABLE_DIRECT_CONNECTIONS: true, ENABLE_BASE_MODELS_CACHE: false });
	});

	test('a dead URL says why under the URL, without the "OpenAI: " prefix (#1018)', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockUpstreams(page);
		// Later routes win: this one answers as the backend does for a refused connection (S5-D10).
		await page.route('**/openai/verify', (route) =>
			json(route, { detail: 'Connection refused at 127.0.0.1:9. Check that the server is running.' }, 500)
		);
		await page.goto('/?settings=admin:connections');
		await modal(page).getByRole('button', { name: 'Add connection' }).first().click();
		const dialog = page.getByRole('dialog', { name: 'Add connection' });
		const url = dialog.getByLabel('URL', { exact: true });
		await url.fill('http://127.0.0.1:9');
		await dialog.getByRole('button', { name: 'Test connection' }).click();
		await expect(url).toHaveAccessibleDescription(
			'Connection refused at 127.0.0.1:9. Check that the server is running.'
		);
		await expect(url).toHaveAttribute('aria-invalid', 'true');
		expect(await dialog.getByText(/OpenAI: |Reachable/).count()).toBe(0);
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
		await m.getByRole('switch', { name: 'OpenAI-compatible connections' }).click();
		await expect(page.getByText("Couldn't save the OpenAI-compatible connections.")).toBeVisible();
		await page.waitForTimeout(300);
		expect(await page.getByText('OpenAI-compatible connections are off').count()).toBe(0);
		await expect(m.getByRole('switch', { name: 'OpenAI-compatible connections' })).toBeChecked();

		await m.getByRole('switch', { name: 'Direct connections' }).click();
		await expect(page.getByText("Couldn't save the change.")).toBeVisible();
		await page.waitForTimeout(300);
		expect(await page.getByText('Settings saved successfully!').count()).toBe(0);
		await expect(m.getByRole('switch', { name: 'Direct connections' })).not.toBeChecked();
	});

	test('the tab saves as changes are made: no Save button (#951)', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockUpstreams(page);
		await page.goto('/?settings=admin:connections');
		const m = modal(page);
		await expect(m.getByText('Changes are saved as you make them.')).toBeVisible();
		await expect(m.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
	});

	test('a refused Ollama save says why once and keeps the Ollama list as it was', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockUpstreams(page, {
			ollama: { ENABLE_OLLAMA_API: true, OLLAMA_BASE_URLS: ['http://localhost:11434'], OLLAMA_API_CONFIGS: {} }
		});
		await page.route('**/ollama/config/update', (route) => json(route, { detail: 'ollama refused' }, 500));
		await page.goto('/?settings=admin:connections');
		const m = modal(page);
		await m.getByRole('switch', { name: 'Enable http://localhost:11434' }).click();
		await expect(page.getByText("Couldn't save the Ollama connections.")).toBeVisible();
		await page.waitForTimeout(300);
		expect(await page.getByText(/is off$/).count()).toBe(0);
		await expect(m.getByRole('switch', { name: 'Enable http://localhost:11434' })).toBeChecked();
	});

	test('a URL that is not http or https is refused before anything is sent', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const seen = await mockUpstreams(page);
		await page.goto('/?settings=admin:connections');
		await modal(page).getByRole('button', { name: 'Add connection' }).first().click();
		const dialog = page.getByRole('dialog', { name: 'Add connection' });
		const url = dialog.getByLabel('URL', { exact: true });
		await url.fill('not a url');
		await dialog.getByRole('button', { name: 'Test connection' }).click();
		await expect(url).toHaveAccessibleDescription('Enter a URL that starts with http:// or https://.');
		await dialog.getByRole('button', { name: 'Save' }).click();
		await expect(url).toBeFocused();
		expect(seen.verify).toBeNull();
		expect(seen.openaiUpdate).toBeNull();
	});

	test('the OpenAI-compatible switch turns the list off and saves that', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const seen = await mockUpstreams(page);
		await page.goto('/?settings=admin:connections');
		await modal(page).getByRole('switch', { name: 'OpenAI-compatible connections' }).click();
		await expect.poll(() => seen.openaiUpdate?.ENABLE_OPENAI_API).toBe(false);
		await expect(modal(page).getByRole('list', { name: 'OpenAI-compatible connections' })).toHaveCount(0);
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

	async function mockGeneral(page: Page, opts: { banners?: Rec[]; failWebhookPut?: boolean } = {}) {
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
		await page.route('**/api/events**', (route) => {
			const { req } = record(route);
			const path = new URL(req.url()).pathname;
			if (path === '/api/events') return json(route, catalog);
			if (req.method() === 'GET') return json(route, hooks());
			if (req.method() === 'PUT' && opts.failWebhookPut) return json(route, { detail: 'nope' }, 500);
			return json(route, { id: 'new' });
		});
		await page.route('**/api/v1/groups/**', (route) => json(route, [{ id: 'g1', name: 'Staff' }]));
		// Two accounts: the parts for other people (banners, channels, the watermark) show (S5-D2).
		await page.route('**/api/v1/users/search**', (route) =>
			json(route, { users: [{ id: 'u9', name: 'Ada Lovelace', email: 'ada@x.test' }], total: 2 })
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

	test('a change asks before another tab replaces it, and Discard changes puts it back (#951)', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockGeneral(page);
		await page.goto('/?settings=admin:general');
		const m = modal(page);
		await m.getByRole('switch', { name: 'Folders' }).click();
		await expect(m.getByText('Unsaved changes')).toBeVisible();
		await m.getByRole('tab', { name: 'Interface', exact: true }).click();
		const ask = page.getByRole('alertdialog', { name: 'Discard changes?' });
		await ask.getByRole('button', { name: 'Keep editing' }).click();
		await expect(m.getByRole('switch', { name: 'Folders' })).toBeChecked();
		await m.getByRole('button', { name: 'Discard changes' }).click();
		await expect(m.getByRole('switch', { name: 'Folders' })).not.toBeChecked();
		await expect(m.getByText('All changes saved')).toBeVisible();
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
		await page
			.getByRole('alertdialog', { name: 'Remove this banner?' })
			.getByRole('button', { name: 'Remove banner' })
			.click();
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
		await page.getByRole('dialog', { name: 'Edit webhook' }).getByRole('button', { name: 'Delete webhook' }).click();
		expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
		await page
			.getByRole('alertdialog', { name: 'Delete “Beta”?' })
			.getByRole('button', { name: 'Delete webhook' })
			.click();
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
		await m.getByRole('button', { name: /^Default interface settings/ }).click();
		await expect(m.getByText('1 setting configured')).toBeVisible();
		await m.getByRole('switch', { name: 'Widescreen Mode' }).click();
		await m.getByRole('switch', { name: 'Title Auto-Generation' }).click();
		await m.getByRole('button', { name: 'Chat Direction' }).click();
		await m.getByRole('button', { name: 'Chat Direction' }).click();
		// Rows for features the app lacks are not offered (docs/history/code-review.md M7); the bubble hides the username switch.
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
		await m.getByRole('button', { name: /^Default interface settings/ }).click();
		await m.getByRole('button', { name: 'UI Scale: Default' }).click();
		await m.getByRole('button', { name: 'Increase UI Scale' }).click();
		await expect(m.getByRole('button', { name: 'UI Scale: 1.1x' })).toBeVisible();
		// The floating quick-action toolbar is not ported, so neither is its Manage dialog.
		await expect(m.getByRole('button', { name: 'Manage Floating Quick Actions' })).toHaveCount(0);
		await m.getByRole('button', { name: 'Save', exact: true }).click();
		await expect
			.poll(() => saved(calls, '/api/v1/auths/admin/config')?.DEFAULT_INTERFACE_SETTINGS)
			.toMatchObject({ theme: 'dark', textScale: 1.1 });
		await m.getByRole('button', { name: 'Clear defaults' }).click();
		await page.getByRole('alertdialog').getByRole('button', { name: 'Clear defaults' }).click();
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
			if (path.endsWith('/defaults'))
				return json(route, { TITLE_GENERATION_PROMPT_TEMPLATE: 'Built-in title prompt.' });
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

	test('a prompt can start from the default and go back to it (#1101)', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockInterface(page);
		await page.goto('/?settings=admin:interface');
		const m = modal(page);
		const title = m.getByRole('textbox', { name: 'Title Generation Prompt' });
		await expect(title).toHaveValue('');
		await m.getByRole('button', { name: 'Show default' }).click();
		await expect(m.getByLabel('Default title generation prompt')).toHaveText('Built-in title prompt.');
		await m.getByRole('button', { name: 'Start from default' }).click();
		await expect(title).toHaveValue('Built-in title prompt.');
		await title.fill('Built-in title prompt. Five words at most.');
		await m.getByRole('button', { name: 'Save' }).click();
		await expect
			.poll(() => post(calls, '/api/v1/tasks/config/update')?.TITLE_GENERATION_PROMPT_TEMPLATE)
			.toBe('Built-in title prompt. Five words at most.');
		await m.getByRole('button', { name: 'Reset to default' }).click();
		await expect(title).toHaveValue('');
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
		OAUTH_EMAIL_CLAIM: 'email',
		...over
	});
	async function mockAuth(page: Page, opts: { oauth?: Rec | null } = {}) {
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
		await page.route('**/api/v1/auths/admin/config/oauth', (route) =>
			opts.oauth === null
				? json(route, { detail: 'nope' }, 404)
				: answer('/api/v1/auths/admin/config/oauth', opts.oauth ?? oauthCfg())(route)
		);
		await page.route('**/api/v1/groups/**', (route) => json(route, [{ id: 'g1', name: 'Staff' }]));
		return { calls };
	}
	const posted = (calls: Call[], path: string) => calls.find((c) => c.method === 'POST' && c.path === path)?.body;

	test('saves the admin config whole, and OAuth goes back as it came', async ({ page }) => {
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
		await expect.poll(() => posted(calls, '/api/v1/auths/admin/config/oauth')).toEqual(oauthCfg());
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

	test('OAuth settings that come from the environment are read-only and are not saved', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockAuth(page, {
			oauth: oauthCfg({ ENABLE_OAUTH_PERSISTENT_CONFIG: false, ENABLE_OAUTH: true })
		});
		await page.goto('/?settings=admin:authentication');
		const m = modal(page);
		// S5-D2: the block is folded to one line that says where it is set.
		const fold = m.getByRole('button', { name: /^Sign-in with an identity provider/ });
		await expect(fold).toContainText('On (set by environment variables)');
		await fold.click();
		await expect(m.getByText(/read from environment variables/)).toBeVisible();
		await expect(m.getByLabel('Email Claim')).toBeDisabled();
		await m.getByLabel('JWT Expiration').fill('2w');
		await m.getByRole('button', { name: 'Save' }).click();
		await expect.poll(() => posted(calls, '/api/v1/auths/admin/config')).toBeTruthy();
		await expect(page.getByText('Settings saved successfully!')).toBeVisible();
		expect(posted(calls, '/api/v1/auths/admin/config/oauth')).toBeUndefined();
	});

	test('OAuth on reveals the claim fields; role and group mapping reveal theirs', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockAuth(page, { oauth: oauthCfg({ ENABLE_OAUTH: true }) });
		await page.goto('/?settings=admin:authentication');
		const m = modal(page);
		await m.getByRole('button', { name: /^Sign-in with an identity provider/ }).click();
		await expect(m.getByLabel('Email Claim')).toHaveValue('email');
		await expect(m.getByTestId('oauth-env-note')).toContainText('environment variables');
		await expect(m.getByLabel('Client ID')).toHaveCount(0);
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
		await stt.getByLabel('STT Model').fill('medium');
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
		const verified: string[] = [];
		page.on('request', (req) => {
			const url = new URL(req.url());
			if (url.pathname.endsWith('/config/url/verify')) verified.push(url.search);
		});
		await page.goto('/?settings=admin:images');
		await create(page).getByLabel('Base URL').fill('http://sd:7861/');
		await create(page).getByRole('button', { name: 'Verify connection' }).click();
		await expect(page.getByText('Server connection verified')).toBeVisible();
		const order = calls.map((c) => c.path).filter((p) => p === '/config/update' || p === '/config/url/verify');
		expect(order).toEqual(['/config/update', '/config/url/verify']);
		// The generation engine's Verify names no target (#236).
		expect(verified).toEqual(['']);
		expect(updates(calls)[0].AUTOMATIC1111_BASE_URL).toBe('http://sd:7861/');
		await expect(create(page).getByPlaceholder('Enter api auth string (e.g. username:password)')).toHaveAttribute(
			'type',
			'password'
		);
	});

	test("the edit engine's Verify checks the edit server, not the generation one (#236)", async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockImages(
			page,
			imagesCfg({
				ENABLE_IMAGE_GENERATION: true,
				IMAGES_OPENAI_API_KEY: 'sk',
				IMAGE_GENERATION_MODEL: 'dall-e-3',
				ENABLE_IMAGE_EDIT: true,
				IMAGE_EDIT_ENGINE: 'comfyui',
				IMAGES_EDIT_COMFYUI_BASE_URL: 'http://comfy:8188'
			})
		);
		const verified: string[] = [];
		page.on('request', (req) => {
			const url = new URL(req.url());
			if (url.pathname.endsWith('/config/url/verify')) verified.push(url.search);
		});
		await page.goto('/?settings=admin:images');
		await edit(page).getByRole('button', { name: 'Verify connection' }).click();
		await expect(page.getByText('Server connection verified')).toBeVisible();
		expect(verified).toEqual(['?target=edit']);
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

// What update_rag_config warns when a save turned hybrid search off (#232).
const RERANKER_WARNING =
	"Hybrid search was turned off: the reranking model 'BAAI/bge-reranker-v2-m3' could not be loaded (the backend log says why).";

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

	async function mockDocuments(
		page: Page,
		opts: { rag?: Rec; embedding?: Rec; failEmbeddingUpdate?: boolean; saved?: (body: Rec) => Rec } = {}
	) {
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
			if (path === '/retrieval/config/update') return json(route, opts.saved ? opts.saved(body) : body);
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
		// A plain Save lets the server keep a loaded model that did not change (#532).
		expect(sent(calls, '/retrieval/embedding/update')[0]).toEqual({
			force_reload: false,
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
		expect(sent(calls, '/retrieval/embedding/update')[0]).toMatchObject({
			RAG_EMBEDDING_MODEL: 'BAAI/bge-small-en',
			force_reload: true
		});
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

	test('hybrid search reveals reranking; an external engine clears the model; the BM25 weight shows its default and saves a change (#233)', async ({
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
		await expect(r.getByLabel('BM25 Weight slider')).toHaveValue('0.5');
		await expect(r.getByLabel('BM25 Weight', { exact: true })).toHaveValue('0.5');
		await r.getByLabel('BM25 Weight', { exact: true }).fill('0.3');
		await modal(page).getByRole('button', { name: 'Save' }).click();
		await expect.poll(() => sent(calls, '/retrieval/config/update').length).toBe(1);
		expect(sent(calls, '/retrieval/config/update')[0]).toMatchObject({
			ENABLE_RAG_HYBRID_SEARCH: true,
			HYBRID_BM25_WEIGHT: 0.3
		});
		// Reset sends the number, which the server saves; "Default" sent null, which it kept as before.
		await r.getByRole('button', { name: 'Reset to 0.5' }).click();
		await modal(page).getByRole('button', { name: 'Save' }).click();
		await expect.poll(() => sent(calls, '/retrieval/config/update').length).toBe(2);
		expect(sent(calls, '/retrieval/config/update')[1]).toMatchObject({ HYBRID_BM25_WEIGHT: 0.5 });
	});

	test('chunk settings the splitters cannot use are refused before anything is sent (#235)', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockDocuments(page);
		await page.goto('/?settings=admin:documents');
		const m = modal(page);
		await expect(m.getByLabel('Chunk Size')).toHaveValue('1000');
		await m.getByLabel('Chunk Overlap').fill('2000');
		await m.getByRole('button', { name: 'Save' }).click();
		await expect(
			page.getByText('Chunk Overlap must be smaller than Chunk Size (2000 is not smaller than 1000).')
		).toBeVisible();
		expect(sent(calls, '/retrieval/embedding/update')).toHaveLength(0);
		expect(sent(calls, '/retrieval/config/update')).toHaveLength(0);
		await m.getByLabel('Chunk Overlap').fill('200');
		await m.getByRole('button', { name: 'Save' }).click();
		await expect.poll(() => sent(calls, '/retrieval/config/update').length).toBe(1);
		expect(sent(calls, '/retrieval/config/update')[0]).toMatchObject({ CHUNK_SIZE: 1000, CHUNK_OVERLAP: 200 });
	});

	test('a reranker that cannot load: the save says hybrid search went off, and the switch shows it (#232)', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockDocuments(page, {
			rag: ragCfg({ ENABLE_RAG_HYBRID_SEARCH: true }),
			saved: (body) => ({ ...body, ENABLE_RAG_HYBRID_SEARCH: false, warnings: [RERANKER_WARNING] })
		});
		await page.goto('/?settings=admin:documents');
		const r = region(page, 'Retrieval');
		await expect(r.getByRole('switch', { name: 'Hybrid Search', exact: true })).toBeChecked();
		await r.getByLabel('Top K', { exact: true }).fill('5');
		await modal(page).getByRole('button', { name: 'Save' }).click();
		await expect(page.getByText(RERANKER_WARNING)).toBeVisible();
		await expect(r.getByRole('switch', { name: 'Hybrid Search', exact: true })).not.toBeChecked();
		expect(sent(calls, '/retrieval/config/update')[0]).toMatchObject({ ENABLE_RAG_HYBRID_SEARCH: true });
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
		await z.getByRole('button', { name: 'Delete all uploads' }).click();
		await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
		expect(calls.some((c) => c.path === '/files/all')).toBe(false);
		await z.getByRole('button', { name: 'Delete all uploads' }).click();
		await page
			.getByRole('alertdialog', { name: 'Delete every uploaded file?' })
			.getByRole('button', { name: 'Delete all uploads' })
			.click();
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
		await region(page, 'Danger Zone').getByRole('button', { name: 'Reset vector storage' }).click();
		await page.getByRole('alertdialog').getByRole('button', { name: 'Reset vector storage' }).click();
		await expect(page.getByText('Vector DB is busy')).toBeVisible();
		await expect(page.getByText('Success', { exact: true })).toHaveCount(0);
	});

	test('Danger Zone: a reindex where files failed says so instead of Success (#308)', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockDocuments(page);
		await page.route('**/api/v1/knowledge/reindex', (route) =>
			json(route, {
				status: false,
				total: 3,
				reindexed: 2,
				failed: [{ file_id: 'f1', filename: 'report.pdf', error: 'embedding failed' }]
			})
		);
		await page.goto('/?settings=admin:documents');
		await region(page, 'Danger Zone').getByRole('button', { name: 'Reindex' }).click();
		await page.getByRole('alertdialog').getByRole('button', { name: 'Reindex' }).click();
		await expect(
			page.getByText(
				'1 of 3 files could not be embedded again and are missing from knowledge search until they are (report.pdf); the backend log has the errors.'
			)
		).toBeVisible();
		await expect(page.getByText('Success', { exact: true })).toHaveCount(0);
	});

	test('Danger Zone: reindex runs knowledge files, knowledge metadata, then memories, in that order', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockDocuments(page);
		await page.goto('/?settings=admin:documents');
		await region(page, 'Danger Zone').getByRole('button', { name: 'Reindex' }).click();
		await page.getByRole('alertdialog').getByRole('button', { name: 'Reindex' }).click();
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

	async function mockWeb(page: Page, web: Rec = webCfg(), saved: (body: Rec) => Rec = (body) => body) {
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
			return json(route, saved(body));
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

	test('a save that turned hybrid search off shows the warning, though this tab has no such switch (#232)', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		await mockWeb(page, webCfg(), (body) => ({
			...body,
			ENABLE_RAG_HYBRID_SEARCH: false,
			warnings: [RERANKER_WARNING]
		}));
		await page.goto('/?settings=admin:web');
		await expect(modal(page).getByLabel('Domain Filter List')).toHaveValue('example.com, !bad.com');
		await modal(page).getByLabel('Domain Filter List').fill('example.com');
		await modal(page).getByRole('button', { name: 'Save' }).click();
		await expect(page.getByText(RERANKER_WARNING)).toBeVisible();
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
			if (path === '/models/import')
				return json(route, { imported: (body?.models ?? []).map((m: { id: string }) => m.id), skipped: [] });
			if (path === '/models/delete/all') return json(route, true);
			// An admin may edit any model: without write_access the workspace editor
			// refuses the model and goes back to the list.
			if (path === '/models/model' && req.method() === 'GET')
				return json(route, {
					...served.find((m) => m.id === url.searchParams.get('id')),
					full: true,
					write_access: true
				});
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

	/** More than one account, so the access labels and Pin by default show (S4-D1, S5-D12). */
	const manyAccounts = (page: Page) =>
		page.route('**/api/v1/users/search**', (route) => json(route, { users: [], total: 3 }));
	const menuItem = (page: Page, name: string) => page.getByRole('menuitem', { name, exact: true });
	const menuSetting = (page: Page, name: string) =>
		page.getByRole('menuitemcheckbox', { name: new RegExp(`^${name}`) });

	test('lists served models and connection models with no record in two groups, in the saved order (S5-D9)', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		await manyAccounts(page);
		await mockModels(page);
		await page.goto('/?settings=admin:models');
		const m = modal(page);
		await expect(m.getByRole('heading', { name: /^From connections/, level: 3 })).toContainText('3');
		await expect(m.getByRole('heading', { name: /^Workspace models/, level: 3 })).toContainText('1');
		// Saved order first, then anything new alphabetically; the workspace model in its own group.
		await expect.poll(() => rowIds(page)).toEqual(['llama3', 'gpt-4o', 'mistral', 'helper']);
		await expect(row(page, 'llama3')).toContainText('Public');
		await expect(row(page, 'helper')).toContainText('Shared');
		await expect(row(page, 'gpt-4o')).toContainText('Private');
		await expect(row(page, 'helper')).toContainText('Hidden');
		await expect(row(page, 'helper')).toContainText('Off');
		await expect(row(page, 'mistral').getByRole('switch')).toBeChecked();
		await expect(row(page, 'helper').getByRole('switch')).not.toBeChecked();
	});

	test('search and views narrow the list, saying how many of the whole, and reordering is offered only when nothing is filtered', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		await manyAccounts(page);
		await mockModels(page);
		await page.goto('/?settings=admin:models');
		const m = modal(page);
		await m.getByLabel('Search models').fill('LLAMA');
		await expect.poll(() => rowIds(page)).toEqual(['llama3']);
		await expect(m.getByText('1 of 4 models')).toBeVisible();
		await expect(
			row(page, 'llama3').getByRole('img', { name: 'Reordering is off while a search or filter is set' })
		).toBeVisible();
		await m.getByLabel('Search models').fill('zzz');
		await expect(m.getByText('Nothing matches “zzz”')).toBeVisible();
		await m.getByTestId('model-list').getByRole('button', { name: 'Clear search' }).click();
		await m.getByRole('button', { name: 'Show: All' }).click();
		await page.getByRole('menuitemradio', { name: 'Disabled' }).click();
		await expect.poll(() => rowIds(page)).toEqual(['helper']);
		await m.getByRole('button', { name: 'Show: Disabled' }).click();
		await page.getByRole('menuitemradio', { name: 'Public' }).click();
		await expect.poll(() => rowIds(page)).toEqual(['llama3']);
		await m.getByRole('button', { name: 'Show: Public' }).click();
		await page.getByRole('menuitemradio', { name: 'All' }).click();
		await expect.poll(async () => (await rowIds(page)).length).toBe(4);
	});

	test('the enable switch toggles a model that has a record, and creates the record for one that has none', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockModels(page);
		await page.goto('/?settings=admin:models');
		await row(page, 'llama3').getByRole('switch', { name: 'Enable Llama 3' }).click();
		await expect
			.poll(() => calls.filter((c) => c.path.startsWith('/models/model/toggle')).map((c) => c.path))
			.toEqual(['/models/model/toggle?id=llama3']);
		await row(page, 'mistral').getByRole('switch', { name: 'Enable Mistral' }).click();
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
		await expect(page.getByText("Couldn't turn off “Llama 3”.")).toBeVisible();
		await expect(sw).toBeChecked();
	});

	test('Default for new chats and Pin by default save the lists at once and mark the row', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await manyAccounts(page);
		const { calls } = await mockModels(page);
		await page.goto('/?settings=admin:models');
		await moreMenu(page, 'gpt-4o', 'GPT-4o');
		await menuSetting(page, 'Default for new chats').click();
		await expect(page.getByText('“GPT-4o” is a default for new chats')).toBeVisible();
		await expect(row(page, 'gpt-4o')).toContainText('Default');
		await moreMenu(page, 'gpt-4o', 'GPT-4o');
		await expect(menuSetting(page, 'Default for new chats')).toHaveAttribute('aria-checked', 'true');
		await menuSetting(page, 'Pin by default').click();
		await expect(row(page, 'gpt-4o')).toContainText('Pinned');
		const last = posts(calls, '/configs/models').at(-1);
		expect(last).toMatchObject({
			DEFAULT_MODELS: 'gpt-4o',
			DEFAULT_PINNED_MODELS: 'gpt-4o',
			MODEL_ORDER_LIST: ['llama3', 'gpt-4o']
		});
	});

	test('a refused default save reverts the mark, and one account offers no Pin by default (S5-D12)', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		await mockModels(page, { failCfgPost: true });
		await page.goto('/?settings=admin:models');
		await moreMenu(page, 'gpt-4o', 'GPT-4o');
		await expect(menuSetting(page, 'Pin by default')).toHaveCount(0);
		await expect(menuItem(page, 'Make public')).toHaveCount(0);
		await menuSetting(page, 'Default for new chats').click();
		await expect(page.getByText("Couldn't save the change.")).toBeVisible();
		await expect(row(page, 'gpt-4o')).not.toContainText('Default');
	});

	test('Make private drops every grant; Make public adds the everyone grant to what is there', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await manyAccounts(page);
		const { calls } = await mockModels(page);
		await page.goto('/?settings=admin:models');
		await moreMenu(page, 'llama3', 'Llama 3');
		await menuItem(page, 'Make private').click();
		await expect(row(page, 'llama3')).toContainText('Private');
		await moreMenu(page, 'helper', 'Helper');
		await menuItem(page, 'Make public').click();
		await expect(row(page, 'helper')).toContainText('Public');
		const bodies = posts(calls, '/models/model/access/update');
		expect(bodies[0]).toEqual({ id: 'llama3', name: 'Llama 3', access_grants: [] });
		expect(bodies[1]).toEqual({ id: 'helper', name: 'Helper', access_grants: [grp, pub] });
	});

	test('Hide model stores the flag through an update, says so by name, and shows Hidden', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockModels(page);
		await page.goto('/?settings=admin:models');
		await moreMenu(page, 'llama3', 'Llama 3');
		await menuItem(page, 'Hide model').click();
		await expect(page.getByText('“Llama 3” is hidden')).toBeVisible();
		await expect(row(page, 'llama3')).toContainText('Hidden');
		expect(posts(calls, '/models/model/update')[0]).toMatchObject({
			id: 'llama3',
			meta: { description: 'A **fast** model', hidden: true },
			base_model_id: null
		});
	});

	test('hiding a model with no record creates it once, and showing it again updates it (#249)', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockModels(page);
		// Registered after mockModels, so it answers first: a record created here
		// is listed from then on, as the server would list it.
		const created: Rec[] = [];
		await page.route('**/api/v1/models/**', (route) => {
			const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
			if (path === '/models/create') created.push(route.request().postDataJSON());
			if (path === '/models/base') return json(route, [...records(), ...created]);
			return route.fallback();
		});
		await page.goto('/?settings=admin:models');
		await moreMenu(page, 'mistral', 'Mistral');
		await menuItem(page, 'Hide model').click();
		await expect(page.getByText('“Mistral” is hidden')).toBeVisible();
		await moreMenu(page, 'mistral', 'Mistral');
		await menuItem(page, 'Show model').click();
		await expect(page.getByText('“Mistral” is shown')).toBeVisible();
		expect(posts(calls, '/models/create').map((b) => b.id)).toEqual(['mistral']);
		expect(posts(calls, '/models/model/update')).toEqual([
			expect.objectContaining({ id: 'mistral', meta: expect.objectContaining({ hidden: false }) })
		]);
		// The enable switch now toggles the record instead of creating it again.
		await row(page, 'mistral').getByRole('switch').click();
		await expect
			.poll(() => calls.filter((c) => c.path.startsWith('/models/model/toggle')).map((c) => c.path))
			.toEqual(['/models/model/toggle?id=mistral']);
		expect(posts(calls, '/models/create')).toHaveLength(1);
	});

	test('Move down reorders within its group and enables Save, which sends the new order and nothing else changed', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockModels(page);
		await page.goto('/?settings=admin:models');
		const save = modal(page).getByRole('button', { name: 'Save', exact: true });
		await expect(save).toBeDisabled();
		await moreMenu(page, 'llama3', 'Llama 3');
		await menuItem(page, 'Move down').click();
		await expect.poll(() => rowIds(page)).toEqual(['gpt-4o', 'llama3', 'mistral', 'helper']);
		await expect(modal(page).getByText('Unsaved changes')).toBeVisible();
		await save.click();
		await expect(page.getByText('Model settings saved')).toBeVisible();
		// The one saved list keeps each id where it was; only the group's own rows trade places.
		expect(posts(calls, '/configs/models').at(-1)).toMatchObject({
			MODEL_ORDER_LIST: ['gpt-4o', 'llama3', 'helper', 'mistral'],
			DEFAULT_MODELS: '',
			DEFAULT_MODEL_PARAMS: {}
		});
		await expect(save).toBeDisabled();
	});

	test('dragging a row by its grip moves it within its group (S5-D13)', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockModels(page);
		await page.goto('/?settings=admin:models');
		await row(page, 'mistral')
			.getByRole('img', { name: /Drag Mistral/ })
			.dragTo(row(page, 'llama3'));
		await expect.poll(() => rowIds(page)).toEqual(['mistral', 'llama3', 'gpt-4o', 'helper']);
		await expect(modal(page).getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
	});

	test('Model defaults: editing them enables Save; one request carries the current lists, and the starter prompts go to their own endpoint', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockModels(page);
		await page.goto('/?settings=admin:models');
		const m = modal(page);
		// A default model chosen first must not be lost when the defaults are saved after it.
		await moreMenu(page, 'gpt-4o', 'GPT-4o');
		await menuSetting(page, 'Default for new chats').click();
		await expect(page.getByText('“GPT-4o” is a default for new chats')).toBeVisible();
		await m.getByRole('button', { name: 'Model defaults' }).click();
		await m.getByRole('button', { name: 'Capabilities' }).click();
		await m.getByRole('checkbox', { name: 'Vision' }).click();
		const save = m.getByRole('button', { name: 'Save', exact: true });
		await expect(save).toBeEnabled();
		await save.click();
		await expect(page.getByText('Model settings saved')).toBeVisible();
		const body = posts(calls, '/configs/models').at(-1);
		expect(body.DEFAULT_MODELS).toBe('gpt-4o');
		expect(body.DEFAULT_MODEL_METADATA.capabilities.vision).toBe(false);
		expect(posts(calls, '/configs/suggestions')).toEqual([{ suggestions: [] }]);
		await expect(save).toBeDisabled();
	});

	test('Actions: Turn all on acts on the models in view only', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockModels(page);
		await page.goto('/?settings=admin:models');
		await actions(page, 'Turn all on');
		await expect.poll(() => posts(calls, '/models/model/update').length).toBe(1);
		expect(posts(calls, '/models/model/update')[0]).toMatchObject({ id: 'helper', is_active: true });
		await expect(page.getByText('All models turned on')).toBeVisible();
	});

	test('Actions: Reset models asks first, destructive and counting the workspace models, then deletes every model', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockModels(page);
		await page.goto('/?settings=admin:models');
		await actions(page, 'Reset models');
		const ask = page.getByRole('alertdialog', { name: 'Reset all models?' });
		await expect(ask).toContainText('All 1 workspace model and every model setting are deleted');
		await ask.getByRole('button', { name: 'Cancel' }).click();
		expect(calls.some((c) => c.path === '/models/delete/all')).toBe(false);
		await actions(page, 'Reset models');
		await page.getByRole('alertdialog').getByRole('button', { name: 'Reset models' }).click();
		await expect(page.getByText('Models reset')).toBeVisible();
		expect(calls.some((c) => c.path === '/models/delete/all')).toBe(true);
	});

	test('Actions: Import refuses a file that is not JSON, and sends models without grants or a missing base model', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockModels(page);
		await page.goto('/?settings=admin:models');
		const input = modal(page).getByLabel('Import models file');
		await input.setInputFiles({ name: 'm.json', mimeType: 'application/json', buffer: Buffer.from('not json') });
		await expect(page.getByText("Couldn't import “m.json”. It isn't a JSON file.")).toBeVisible();
		expect(posts(calls, '/models/import')).toHaveLength(0);
		await input.setInputFiles({
			name: 'm.json',
			mimeType: 'application/json',
			buffer: Buffer.from(JSON.stringify([{ id: 'x', name: 'X', access_grants: [pub] }]))
		});
		await expect(page.getByText('Imported 1 model')).toBeVisible();
		// Left out, not empty: for a model that exists, the server keeps what is
		// left out, and an empty list would wipe its sharing (#524).
		expect(posts(calls, '/models/import')[0]).toEqual({
			models: [{ id: 'x', name: 'X', meta: {}, params: {} }]
		});
	});

	test('a workspace model opens in the workspace editor, a connection model in the editor here', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockModels(page);
		await page.goto('/?settings=admin:models');
		await row(page, 'gpt-4o').getByRole('button', { name: 'Edit GPT-4o' }).click();
		await expect(modal(page).getByLabel('Model name')).toHaveValue('GPT-4o');
		await modal(page).getByRole('tabpanel').getByRole('button', { name: 'Back' }).click();
		await expect(row(page, 'gpt-4o')).toBeVisible();
		await row(page, 'helper').getByRole('button', { name: 'Edit Helper' }).click();
		// The editor itself, not only its URL: a model it cannot edit sends it back
		// to the list, after a URL check alone could already have passed.
		await expect(page.getByLabel('Model name')).toHaveValue('Helper');
		await expect(page).toHaveURL(/\/workspace\/models\/edit\?id=helper/);
		await expect(modal(page)).toHaveCount(0);
	});

	test('Escape in the model editor asks once before its changes are lost (#951)', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockModels(page);
		await page.goto('/?settings=admin:models');
		await row(page, 'gpt-4o').getByRole('button', { name: 'Edit GPT-4o' }).click();
		const name = modal(page).getByLabel('Model name');
		await expect(name).toHaveValue('GPT-4o');
		await name.fill('GPT-4o, renamed');
		await expect(modal(page).getByText('Unsaved changes')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.getByRole('alertdialog')).toHaveCount(1);
		await page.getByRole('alertdialog').getByRole('button', { name: 'Keep editing' }).click();
		await expect(name).toHaveValue('GPT-4o, renamed');
		await page.keyboard.press('Escape');
		await expect(page.getByRole('alertdialog')).toHaveCount(1);
		await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes' }).click();
		await expect(modal(page)).toHaveCount(0);
		await expect(page.getByRole('alertdialog')).toHaveCount(0);
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
		await actions(page, 'Manage models');
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
		await page.getByRole('menuitem', { name: 'Manage models' }).click();
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
		await page
			.getByRole('alertdialog', { name: 'Delete “phi3”?' })
			.getByRole('button', { name: 'Delete model' })
			.click();
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

	test('Ollama: Update All Models says which pulls failed instead of all up to date (#246)', async ({ page }) => {
		await mockManage(page);
		// Registered after mockManage, so it answers the pulls instead.
		await page.route('**/ollama/api/pull**', (route) =>
			route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({ detail: 'Ollama: unreachable' })
			})
		);
		await open(page);
		await dialog(page).getByRole('button', { name: 'Update All Models' }).click();
		await expect(page.getByText('Could not update 2 models: llama3:8b, phi3 (Ollama: unreachable)')).toBeVisible();
		await expect(page.getByText('All models are up to date')).toHaveCount(0);
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
		await page.getByRole('alertdialog').getByRole('button', { name: 'Delete model' }).click();
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

	const chooseOption = async (page: Page, scope: ReturnType<Page['getByRole']>, field: string, option: string) => {
		await scope.getByRole('combobox', { name: field }).click();
		await page.getByRole('option', { name: option, exact: true }).click();
	};

	test('lists tool servers by name (or URL) with their state; a switch saves the whole list', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const seen = await mockIntegrations(page);
		await page.goto('/?settings=admin:integrations');
		const m = modal(page);
		await expect(m.getByRole('switch', { name: 'Enable Weather' })).toBeChecked();
		await expect(m.getByRole('switch', { name: 'Enable https://mcp.example/' })).not.toBeChecked();
		await expect(
			m.getByRole('list', { name: 'Tool servers' }).locator('[data-slot=badge]', { hasText: 'Off' })
		).toHaveCount(1);
		await expect(m.getByText('None yet.', { exact: true })).toBeVisible();
		await expect(m.getByText(/^None yet\. Add one to search a vector store/)).toBeVisible();
		await m.getByRole('switch', { name: 'Enable https://mcp.example/' }).click();
		await expect.poll(() => seen.tools.at(-1)?.TOOL_SERVER_CONNECTIONS?.[1]?.config).toEqual({ enable: true });
		expect(seen.tools.at(-1)?.TOOL_SERVER_CONNECTIONS[0].key).toBe('sk-tool');
	});

	test('adding an OpenAPI server drops the trailing slash; an ID with ":" is refused under the ID', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const seen = await mockIntegrations(page, { servers: [] });
		await page.goto('/?settings=admin:integrations');
		await modal(page).getByRole('button', { name: 'Add tool server' }).click();
		const d = page.getByRole('dialog', { name: 'Add tool server' });
		await d.getByLabel('URL', { exact: true }).fill('https://new.example/');
		await d.getByLabel(/^ID/).fill('bad:id');
		await d.getByRole('button', { name: 'Save' }).click();
		await expect(d.getByLabel(/^ID/)).toHaveAccessibleDescription('An ID can’t contain “:” or “|”.');
		expect(seen.tools).toHaveLength(0);
		await d.getByLabel(/^ID/).fill('good');
		await d.getByLabel(/API key/).fill('k1');
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
		await modal(page).getByRole('button', { name: 'Add tool server' }).click();
		const d = page.getByRole('dialog', { name: 'Add tool server' });
		await d.getByRole('radio', { name: 'MCP', exact: true }).click();
		await expect(d.getByText(/support is experimental/)).toBeVisible();
		await d.getByLabel('URL', { exact: true }).fill('https://mcp.example/mcp/');
		await d.getByLabel(/^ID/).fill('m1');
		await chooseOption(page, d, 'Authentication', 'OAuth 2.1');
		await expect(d.getByText('Not registered')).toBeVisible();
		await d.getByRole('button', { name: 'Save' }).click();
		await expect(d.getByRole('combobox', { name: 'Authentication' })).toHaveAccessibleDescription(
			'Register the OAuth client first.'
		);
		await chooseOption(page, d, 'Authentication', 'None');
		await d.getByRole('button', { name: 'Save' }).click();
		await expect
			.poll(() => seen.tools.at(-1)?.TOOL_SERVER_CONNECTIONS?.[0])
			.toMatchObject({ type: 'mcp', url: 'https://mcp.example/mcp/', auth_type: 'none' });
	});

	test('editing opens with the saved values; Delete asks first, naming it, then saves without it', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const seen = await mockIntegrations(page);
		await page.goto('/?settings=admin:integrations');
		await modal(page).getByRole('button', { name: 'Edit Weather' }).click();
		const d = page.getByRole('dialog', { name: 'Edit tool server' });
		await expect(d.getByLabel('URL', { exact: true })).toHaveValue('https://tools.example');
		await expect(d.getByLabel(/^ID/)).toHaveValue('wx');
		await d.getByRole('button', { name: 'Delete connection' }).click();
		await page
			.getByRole('alertdialog', { name: 'Delete “Weather”?' })
			.getByRole('button', { name: 'Delete connection' })
			.click();
		await expect
			.poll(() => seen.tools.at(-1)?.TOOL_SERVER_CONNECTIONS)
			.toEqual([expect.objectContaining({ url: 'https://mcp.example/' })]);
	});

	test('Test connection sends the server to the backend; Export leaves the API key out', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const seen = await mockIntegrations(page);
		await page.goto('/?settings=admin:integrations');
		await modal(page).getByRole('button', { name: 'Edit Weather' }).click();
		const d = page.getByRole('dialog', { name: 'Edit tool server' });
		await d.getByRole('button', { name: 'Test connection' }).click();
		await expect
			.poll(() => seen.toolVerify)
			.toMatchObject({
				url: 'https://tools.example',
				path: 'openapi.json',
				type: 'openapi',
				key: 'sk-tool',
				info: { id: 'wx', name: 'Weather' }
			});
		await expect(d.getByText('Reachable', { exact: true })).toBeVisible();
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
		await modal(page).getByRole('button', { name: 'Add terminal connection' }).click();
		const d = page.getByRole('dialog', { name: 'Add terminal connection' });
		await d.getByLabel(/^Name/).fill('Python DS');
		await d.getByLabel('URL', { exact: true }).fill('http://orch:9900/');
		await d.getByLabel(/API key/).fill('  okey ');
		await d.getByRole('button', { name: 'Test connection' }).click();
		await expect(d.getByText('Reachable: an Orchestrator')).toBeVisible();
		await d.getByRole('button', { name: 'Orchestrator' }).click();
		await expect(d.getByLabel('Policy ID')).toHaveValue('python-ds');
		await chooseOption(page, d, 'Chat terminals', 'Per chat');
		await d.getByRole('button', { name: 'Add variable' }).click();
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

	test('editing an Orchestrator terminal loads its policy back; bad lifecycle JSON is refused under it', async ({
		page
	}) => {
		await mockWorkspaceBackend(page);
		const seen = await mockIntegrations(page, {
			terminals: [{ id: 't1', url: 'http://orch', name: 'Orch', policy_id: 'p1', enabled: true, config: { extra: 1 } }]
		});
		await page.goto('/?settings=admin:integrations');
		await modal(page).getByRole('button', { name: 'Edit Orch' }).click();
		const d = page.getByRole('dialog', { name: 'Edit terminal connection' });
		await d.getByRole('button', { name: 'Orchestrator' }).click();
		await expect(d.getByLabel(/^Image/)).toHaveValue('img:1');
		await expect(d.getByLabel('Policy ID')).toBeDisabled();
		const lifecycle = d.getByLabel(/^Lifecycle/);
		await expect(lifecycle).toHaveValue(/@weekly/);
		await lifecycle.fill('[1]');
		await d.getByRole('button', { name: 'Save' }).click();
		await expect(lifecycle).toHaveAccessibleDescription('Enter the lifecycle as a JSON object, or leave it empty.');
		expect(seen.policy).toHaveLength(0);
		await lifecycle.fill('{}');
		await d.getByRole('button', { name: 'Save' }).click();
		await expect
			.poll(() => seen.terminals.at(-1)?.TERMINAL_SERVER_CONNECTIONS?.[0])
			.toMatchObject({ id: 't1', policy_id: 'p1', config: { extra: 1 } });
		expect(seen.policy[0].policy_data).toMatchObject({ image: 'img:1', env: { A: 'b' } });
	});

	test('a knowledge source cannot be added until a test passes, and an edit asks for a new test', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const seen = await mockIntegrations(page);
		await page.goto('/?settings=admin:integrations');
		await modal(page).getByRole('button', { name: 'Add source' }).click();
		const d = page.getByRole('dialog', { name: 'Add knowledge source' });
		await d.getByLabel('Name').fill('Research');
		await d.getByLabel('Endpoint').fill('https://q.example');
		await d.getByLabel('Collection', { exact: true }).fill('docs');
		const query = d.getByLabel('Test query');
		await query.fill('what?');
		await d.getByRole('button', { name: 'Add source' }).click();
		await expect(query).toHaveAccessibleDescription(
			'Run the test first: a source is added only once it finds documents.'
		);
		await d.getByRole('button', { name: 'Run test' }).click();
		await expect(d.getByText('Found 1 document.')).toBeVisible();
		await d.getByLabel('Collection', { exact: true }).fill('docs2');
		await expect(d.getByText('Found 1 document.')).toHaveCount(0);
		await d.getByRole('button', { name: 'Run test' }).click();
		await expect(d.getByText('Found 1 document.')).toBeVisible();
		await d.getByRole('button', { name: 'Add source' }).click();
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
		await modal(page).getByRole('switch', { name: 'Enable Papers' }).click();
		await expect
			.poll(() => seen.knowledge.at(-1))
			.toEqual({
				path: '/knowledge/external/connections/c1',
				body: expect.objectContaining({ enabled: false, auth_config: null })
			});
	});
});
