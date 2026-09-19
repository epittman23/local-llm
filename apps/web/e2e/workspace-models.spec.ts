import { expect, test } from './test';
import type { Page } from '@playwright/test';
import { mockWorkspaceBackend } from './workspace-helpers';

type Call = { method: string; path: string; search: string; body: any };
type M = Record<string, any>;

const model = (n: number, o: M = {}): M => ({
	id: `model-${n}`,
	name: `Model ${n}`,
	base_model_id: 'llama3',
	is_active: true,
	write_access: true,
	updated_at: 1700000000 + n,
	meta: { description: `Preset ${n}`, capabilities: { vision: true } },
	params: { system: `You are model ${n}` },
	access_grants: [],
	user: { name: 'Test User', email: 'u@example.com' },
	...o
});

const baseModels = [
	{ id: 'llama3', name: 'Llama 3' },
	{ id: 'gpt-4o', name: 'GPT-4o' },
	{ id: 'a-preset', name: 'A Preset', preset: true }
];

async function mockModelsApi(page: Page, initial: M[], extra: { tools?: M[]; functions?: M[]; settings?: M } = {}) {
	const state = { models: [...initial] };
	const calls: Call[] = [];
	const json = (d: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(d) });
	const record = (req: any, path: string) => {
		const url = new URL(req.url());
		let body: any = null;
		try {
			body = req.postDataJSON();
		} catch {
			/* none */
		}
		calls.push({ method: req.method(), path, search: url.search, body });
		return { url, body };
	};

	await page.route('**/api/v1/models/**', (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname.replace('/api/v1/models', '');
		const { url, body } = record(req, path);
		if (path === '/list') {
			const q = (url.searchParams.get('query') ?? '').toLowerCase();
			const items = state.models.filter((m) => m.name.toLowerCase().includes(q));
			return route.fulfill(json({ items, total: items.length }));
		}
		if (path === '/tags' || path === '/base/tags') return route.fulfill(json(['support', 'coding']));
		if (path === '/create') return route.fulfill(json(body));
		if (path === '/model') return route.fulfill(json(state.models.find((m) => m.id === url.searchParams.get('id')) ?? null, state.models.some((m) => m.id === url.searchParams.get('id')) ? 200 : 404));
		if (path === '/model/toggle') return route.fulfill(json(true));
		if (path === '/model/update') return route.fulfill(json(body));
		if (path === '/model/delete') return route.fulfill(json(true));
		return route.fulfill(json({}));
	});
	await page.route('**/api/models**', (route) => route.fulfill(json({ data: baseModels })));
	await page.route('**/api/v1/configs/models/defaults', (route) => route.fulfill(json({ DEFAULT_MODEL_METADATA: { capabilities: { web_search: true } } })));
	await page.route(/\/api\/v1\/tools\/(\?.*)?$/, (route) => route.fulfill(json(extra.tools ?? [])));
	await page.route('**/api/v1/skills/**', (route) => route.fulfill(json([])));
	await page.route('**/api/v1/functions/', (route) => route.fulfill(json(extra.functions ?? [])));
	await page.route('**/api/v1/users/user/settings', (route) => route.fulfill(json({ ui: extra.settings ?? {} })));
	await page.route('**/api/v1/users/user/settings/update', (route) => {
		record(route.request(), '/settings/update');
		return route.fulfill(json({}));
	});
	return { calls, state };
}

test.describe('workspace models list', () => {
	test('lists presets with id and description, badges read-only ones, searches server-side, and pages through the API', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockModelsApi(page, [model(1), model(2, { write_access: false }), model(3, { meta: { hidden: true } })]);
		await page.goto('/workspace/models');
		await expect(page.getByRole('link', { name: 'Model 1' })).toBeVisible();
		await expect(page.getByText('Preset 1')).toBeVisible();
		await expect(page.getByText('llama3').first()).toBeVisible(); // description falls back to the base model
		await expect(page.getByText('Read Only')).toHaveCount(1);
		await expect(page.locator('#model-item-model-3')).toHaveClass(/opacity-50/);

		await page.getByLabel('Search Models').fill('Model 2');
		await expect(page.getByRole('link', { name: 'Model 1' })).toHaveCount(0);
		expect(calls.some((c) => c.path === '/list' && c.search.includes('query=Model+2'))).toBe(true);
	});

	test('the switch toggles; delete asks first', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockModelsApi(page, [model(1)]);
		await page.goto('/workspace/models');
		await page.getByRole('switch', { name: 'Enabled' }).click();
		await expect.poll(() => calls.some((c) => c.path === '/model/toggle')).toBe(true);

		await page.getByRole('button', { name: 'Model Menu', exact: true }).click();
		await page.getByRole('menuitem', { name: 'Delete' }).click();
		await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
		await expect.poll(() => calls.some((c) => c.path === '/model/delete')).toBe(true);
	});

	test('"Keep in Sidebar" saves the user\'s pinned list, keeping their other settings', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockModelsApi(page, [model(1)], { settings: { theme: 'dark', pinnedModels: ['other'] } });
		await page.goto('/workspace/models');
		await page.getByRole('button', { name: 'Model Menu', exact: true }).click();
		await page.getByRole('menuitem', { name: 'Keep in Sidebar' }).click();
		await expect.poll(() => calls.find((c) => c.path === '/settings/update')?.body).toEqual({ ui: { theme: 'dark', pinnedModels: ['other', 'model-1'] } });
	});

	test('Hide Model saves meta.hidden; Hide All hides every visible model', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockModelsApi(page, [model(1), model(2)]);
		await page.goto('/workspace/models');
		await page.getByRole('button', { name: 'Model Menu', exact: true }).first().click();
		await page.getByRole('menuitem', { name: 'Hide Model' }).click();
		await expect.poll(() => calls.filter((c) => c.path === '/model/update').length).toBe(1);
		expect(calls.find((c) => c.path === '/model/update')?.body.meta.hidden).toBe(true);

		await page.getByRole('button', { name: 'Actions' }).click();
		await page.getByRole('menuitem', { name: 'Hide All' }).click();
		await expect.poll(() => calls.filter((c) => c.path === '/model/update').length).toBeGreaterThanOrEqual(3);
		await expect(page.getByText('All models are now hidden')).toBeVisible();
	});

	test('clone opens the create form pre-filled, with the base model kept', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockModelsApi(page, [model(1)]);
		await page.goto('/workspace/models');
		await page.getByRole('button', { name: 'Model Menu', exact: true }).click();
		await page.getByRole('menuitem', { name: 'Clone' }).click();
		await expect(page).toHaveURL(/\/workspace\/models\/create$/);
		await expect(page.getByLabel('Model Name')).toHaveValue('Model 1 (Clone)');
		await expect(page.getByLabel('Model ID')).toHaveValue('model-1-clone');
		await expect(page.getByRole('button', { name: 'Base model' })).toContainText('Llama 3');
	});

	test('import updates an existing model, creates a new one, and never takes grants from the file', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockModelsApi(page, [model(1)]);
		await page.goto('/workspace/models');
		await page.getByRole('button', { name: 'Open create menu' }).click();
		const chooser = page.waitForEvent('filechooser');
		await page.getByRole('menuitem', { name: 'Import JSON' }).click();
		await (await chooser).setFiles({
			name: 'models.json',
			mimeType: 'application/json',
			buffer: Buffer.from(
				JSON.stringify([
					{ id: 'model-1', name: 'Renamed', access_grants: [{ principal_type: 'user', principal_id: '*', permission: 'write' }] },
					{ info: { id: 'brand-new', name: 'Brand New' } },
					{ id: 'no-name' }
				])
			)
		});
		await expect.poll(() => calls.find((c) => c.path === '/model/update')?.body).toMatchObject({ id: 'model-1', name: 'Renamed', access_grants: [] });
		await expect.poll(() => calls.find((c) => c.path === '/create')?.body).toMatchObject({ id: 'brand-new', name: 'Brand New' });
		expect(calls.filter((c) => c.path === '/create')).toHaveLength(1);
	});
});

test.describe('workspace model editor', () => {
	test('create: the id follows the name, a base model is required, and the saved payload has the right shape', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockModelsApi(page, [], { tools: [{ id: 'calc', name: 'Calculator', meta: { description: 'Maths' } }] });
		await page.goto('/workspace/models/create');
		await page.getByLabel('Model Name').fill('My Helper 2');
		await expect(page.getByLabel('Model ID')).toHaveValue('my-helper-2');

		// No base model yet: refused, nothing sent.
		await page.getByRole('button', { name: 'Save & Create' }).click();
		await expect(page.getByText('Base Model is required.')).toBeVisible();
		expect(calls.some((c) => c.path === '/create')).toBe(false);

		await page.getByRole('button', { name: 'Base model' }).click();
		// Presets are never offered as a base.
		await expect(page.getByRole('button', { name: 'A Preset' })).toHaveCount(0);
		await page.getByRole('button', { name: 'GPT-4o' }).click();

		await page.getByLabel('System Prompt').fill('Be brief.');
		await page.getByLabel('Description', { exact: true }).fill('A helpful preset');
		// Capabilities: turn Vision off (it is on by default).
		await page.getByRole('checkbox', { name: 'Vision' }).click();
		// Pick a tool.
		await page.getByRole('button', { name: 'Select Tool' }).click();
		await page.getByRole('button', { name: 'Calculator' }).click();

		await page.getByRole('button', { name: 'Save & Create' }).click();
		await expect(page).toHaveURL(/\/workspace\/models$/);
		const body = calls.find((c) => c.path === '/create')?.body;
		expect(body).toMatchObject({
			id: 'my-helper-2',
			name: 'My Helper 2',
			base_model_id: 'gpt-4o',
			access_grants: [],
			meta: { description: 'A helpful preset', toolIds: ['calc'], capabilities: { vision: false, web_search: true } },
			params: { system: 'Be brief.' }
		});
		expect(body.meta).not.toHaveProperty('knowledge');
		expect(body.meta.suggestion_prompts).toBeNull();
	});

	test('create: a model id that already exists is refused', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockModelsApi(page, []);
		await page.route('**/api/models**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [...baseModels, { id: 'taken', name: 'Taken' }] }) }));
		await page.goto('/workspace/models/create');
		await page.getByLabel('Model Name').fill('Whatever');
		await page.getByLabel('Model ID').fill('taken');
		await page.getByRole('button', { name: 'Base model' }).click();
		await page.getByRole('button', { name: 'Llama 3' }).click();
		await page.getByRole('button', { name: 'Save & Create' }).click();
		await expect(page.getByText("A model with the ID 'taken' already exists")).toBeVisible();
		expect(calls.some((c) => c.path === '/create')).toBe(false);
	});

	test('advanced params: a Custom value is saved, and switching back to Default removes it', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockModelsApi(page, [model(1)]);
		await page.goto('/workspace/models/edit?id=model-1');
		await page.getByRole('button', { name: 'Show' }).first().click();
		await page.getByRole('button', { name: 'Temperature: Default' }).click();
		await page.getByLabel('Temperature', { exact: true }).fill('1.2');
		await page.getByRole('button', { name: 'Stop Sequence: Default' }).click();
		await page.getByRole('textbox', { name: 'Stop Sequence' }).fill('END, STOP');
		await page.getByRole('button', { name: 'Save & Update' }).click();
		await expect.poll(() => calls.find((c) => c.path === '/model/update')?.body?.params).toMatchObject({ temperature: 1.2, stop: ['END', ' STOP'], system: 'You are model 1' });
	});

	test('edit: loads by id with the id locked, and saves back to the same id', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockModelsApi(page, [model(1, { meta: { description: 'Old', tags: [{ name: 'support' }] } })]);
		await page.goto('/workspace/models/edit?id=model-1');
		await expect(page.getByLabel('Model Name')).toHaveValue('Model 1');
		await expect(page.getByLabel('Model ID')).toBeDisabled();
		await expect(page.getByText('support', { exact: true })).toBeVisible();
		await page.getByLabel('Model Name').fill('Model One');
		await expect(page.getByLabel('Model ID')).toHaveValue('model-1'); // an existing id does not follow the name
		await page.getByRole('button', { name: 'Save & Update' }).click();
		await expect(page).toHaveURL(/\/workspace\/models$/);
		expect(calls.find((c) => c.path === '/model/update')?.body).toMatchObject({ id: 'model-1', name: 'Model One', base_model_id: 'llama3' });
	});

	test('edit: a read-only or missing model returns to the list', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockModelsApi(page, [model(2, { write_access: false })]);
		await page.goto('/workspace/models/edit?id=model-2');
		await expect(page.getByText('You do not have permission to edit this model')).toBeVisible();
		await expect(page).toHaveURL(/\/workspace\/models$/);
		await page.goto('/workspace/models/edit?id=nope');
		await expect(page).toHaveURL(/\/workspace\/models$/);
	});

	test('the system prompt panel flags bad chat variables', async ({ page }) => {
		await mockWorkspaceBackend(page);
		await mockModelsApi(page, []);
		await page.goto('/workspace/models/create');
		await page.getByLabel('System Prompt').fill('Hi {{chat.variables.BadKey | text}} and {{user.variables.city}}');
		await expect(page.getByText('Detected Variables')).toBeVisible();
		await expect(page.getByText('BadKey must be lowercase snake case')).toBeVisible();
		await expect(page.getByText('city', { exact: true })).toBeVisible();
	});

	test('suggestion prompts and the JSON preview', async ({ page }) => {
		await mockWorkspaceBackend(page);
		const { calls } = await mockModelsApi(page, [model(1)]);
		await page.goto('/workspace/models/edit?id=model-1');
		await page.getByRole('button', { name: 'Default prompt suggestions' }).click();
		await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Tell me a fact');
		await page.getByLabel('Content').fill('Tell me a fun fact about Rome');
		await page.getByRole('button', { name: 'Show' }).last().click();
		await expect(page.locator('pre')).toContainText('Tell me a fun fact about Rome');
		await page.getByRole('button', { name: 'Save & Update' }).click();
		await expect.poll(() => calls.find((c) => c.path === '/model/update')?.body?.meta?.suggestion_prompts).toEqual([{ content: 'Tell me a fun fact about Rome', title: ['Tell me a fact', ''] }]);
	});
});
