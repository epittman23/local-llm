import type { Page } from '@playwright/test';
import { expect, test } from './test';
import { mockWorkspaceBackend } from './workspace-helpers';

type Rec = Record<string, any>;
const json = (route: any, d: unknown, status = 200) =>
	route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(d) });

const automation = (id: string, name: string, extra: Rec = {}) => ({
	id,
	user_id: 'u1',
	name,
	folder_id: null,
	is_active: true,
	last_run_at: null,
	next_run_at: null,
	next_runs: null,
	meta: null,
	created_at: 0,
	updated_at: 0,
	last_run: null,
	data: {
		prompt: `Prompt for ${name}`,
		model_id: 'qwen',
		rrule: 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
		target: { type: 'chat' }
	},
	...extra
});

async function mockAutomations(page: Page, items: Rec[] = [], runs: Rec[] = []) {
	const seen = {
		lists: [] as string[],
		created: [] as Rec[],
		updated: [] as Rec[],
		toggled: [] as string[],
		ran: [] as string[],
		deleted: [] as string[]
	};
	let list = [...items];
	await page.route('**/api/v1/automations/**', async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const path = url.pathname.replace('/api/v1/automations', '');
		if (path === '/list') {
			seen.lists.push(url.search);
			return json(route, { items: list, total: list.length });
		}
		if (path === '/create') {
			seen.created.push(req.postDataJSON());
			return json(route, { id: `new${seen.created.length}`, ...req.postDataJSON() });
		}
		const [, id, action] = path.split('/');
		if (action === 'toggle') {
			seen.toggled.push(id);
			list = list.map((a) => (a.id === id ? { ...a, is_active: !a.is_active } : a));
			return json(
				route,
				list.find((a) => a.id === id)
			);
		}
		if (action === 'run') {
			seen.ran.push(id);
			return json(route, { ok: true });
		}
		if (action === 'delete') {
			seen.deleted.push(id);
			list = list.filter((a) => a.id !== id);
			return json(route, true);
		}
		if (action === 'update') {
			seen.updated.push(req.postDataJSON());
			return json(route, { ...list.find((a) => a.id === id), ...req.postDataJSON() });
		}
		if (action === 'runs') return json(route, runs);
		const found = list.find((a) => a.id === id);
		return found ? json(route, found) : json(route, { detail: 'Not found' }, 404);
	});
	await page.route('**/api/models*', (route) =>
		json(route, {
			data: [
				{ id: 'qwen', name: 'Qwen' },
				{ id: 'secret', name: 'Hidden', info: { meta: { hidden: true } } }
			]
		})
	);
	await page.route('**/api/v1/folders/**', (route) => json(route, [{ id: 'f1', name: 'Reports' }]));
	await page.route('**/api/v1/channels/**', (route) =>
		json(route, [
			{ id: 'c1', name: 'ops' },
			{ id: 'dm1', name: 'dm', type: 'dm' }
		])
	);
	return seen;
}

// Channels on too: channel destinations are listed only when channels are.
const enabled = { features: { enable_automations: true, enable_channels: true } };

test('a user without the permission is sent home', async ({ page }) => {
	await mockWorkspaceBackend(page, { role: 'user', ...enabled });
	await mockAutomations(page);
	await page.goto('/automations');
	await expect(page).toHaveURL(/localhost:5174\/$/);
});

test('lists automations with schedule and destination; the switch pauses one', async ({ page }) => {
	await mockWorkspaceBackend(page, { role: 'user', ...enabled, featurePermissions: { automations: true } });
	const seen = await mockAutomations(page, [
		automation('a1', 'Morning digest'),
		automation('a2', 'Ops report', {
			data: {
				prompt: 'p',
				model_id: 'qwen',
				rrule: 'RRULE:FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=17;BYMINUTE=30',
				target: { type: 'channel', channel_id: 'c1' }
			}
		})
	]);
	await page.goto('/automations');
	await expect(page.getByRole('link', { name: /Morning digest.*Daily at 9:00 AM · New chat/ })).toBeVisible();
	await expect(page.getByText('MO,FR at 5:30 PM · #ops')).toBeVisible();
	await page.getByRole('switch', { name: 'Pause Morning digest' }).click();
	await expect.poll(() => seen.toggled).toEqual(['a1']);
	await expect(page.getByRole('switch', { name: 'Resume Morning digest' })).toBeVisible();
});

test('search and the status filter go to the server', async ({ page }) => {
	await mockWorkspaceBackend(page, enabled);
	const seen = await mockAutomations(page, [automation('a1', 'Morning digest')]);
	await page.goto('/automations');
	await page.getByLabel('Search Automations').fill('digest');
	await expect.poll(() => seen.lists.some((q) => new URLSearchParams(q).get('query') === 'digest')).toBe(true);
	await page.getByLabel('Status').selectOption('paused');
	await expect.poll(() => seen.lists.some((q) => new URLSearchParams(q).get('status') === 'paused')).toBe(true);
});

test('creating one: required fields, a weekly schedule, a channel destination, then it opens', async ({ page }) => {
	await mockWorkspaceBackend(page, enabled);
	const seen = await mockAutomations(page);
	await page.goto('/automations');
	await page.getByRole('button', { name: 'Create', exact: true }).click();
	const d = page.getByRole('dialog', { name: 'New automation' });
	await d.getByRole('button', { name: 'Create' }).click();
	await expect(page.getByText('Name, prompt, and model are required')).toBeVisible();
	await d.getByLabel('Automation title').fill('Standup notes');
	await d.getByLabel('Instructions').fill('Summarize yesterday');
	await d.getByRole('button', { name: 'Model' }).click();
	await expect(page.getByRole('button', { name: 'Hidden' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Qwen' }).click();
	await d.getByRole('button', { name: 'Schedule' }).click();
	await page.getByLabel('Frequency').selectOption('WEEKLY');
	await page.getByRole('button', { name: 'Mo', exact: true }).click();
	await page.getByRole('button', { name: 'Th', exact: true }).click();
	await page.getByLabel('Time').fill('08:15');
	await page.keyboard.press('Escape');
	await d.getByRole('button', { name: 'Destination' }).click();
	await page.getByRole('button', { name: 'In a channel…' }).click();
	await expect(page.getByRole('button', { name: '#dm' })).toHaveCount(0);
	await page.getByRole('button', { name: '#ops' }).click();
	await page.keyboard.press('Escape');
	await d.getByRole('button', { name: 'Create' }).click();
	await expect
		.poll(() => seen.created[0])
		.toEqual({
			name: 'Standup notes',
			folder_id: null,
			data: {
				prompt: 'Summarize yesterday',
				model_id: 'qwen',
				rrule: 'RRULE:FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=8;BYMINUTE=15',
				target: { type: 'channel', channel_id: 'c1' }
			},
			is_active: true
		});
	await expect(page).toHaveURL(/\/automations\/new1$/);
});

test('the detail page shows the automation and its runs; run now, edit and delete', async ({ page }) => {
	await mockWorkspaceBackend(page, enabled);
	const seen = await mockAutomations(
		page,
		[automation('a1', 'Morning digest', { folder_id: 'f1' })],
		[
			{
				id: 'r1',
				automation_id: 'a1',
				chat_id: 'chat9',
				status: 'success',
				error: null,
				created_at: Date.now() * 1_000_000
			},
			{
				id: 'r2',
				automation_id: 'a1',
				chat_id: null,
				status: 'error',
				error: 'Model unavailable',
				created_at: Date.now() * 1_000_000
			}
		]
	);
	await page.goto('/automations/a1');
	await expect(page.getByRole('heading', { name: 'Morning digest' })).toBeVisible();
	await expect(page.getByText('Folder: Reports')).toBeVisible();
	await expect(page.getByText('Prompt for Morning digest')).toBeVisible();
	await expect(page.getByRole('link', { name: 'View chat' })).toHaveAttribute('href', '/c/chat9');
	await expect(page.getByText('Model unavailable')).toBeVisible();
	await page.getByRole('button', { name: 'Run now' }).click();
	await expect.poll(() => seen.ran).toEqual(['a1']);
	await page.getByRole('button', { name: 'Edit' }).click();
	const d = page.getByRole('dialog', { name: 'Edit automation' });
	await expect(d.getByLabel('Automation title')).toHaveValue('Morning digest');
	await d.getByLabel('Automation title').fill('Evening digest');
	await d.getByRole('button', { name: 'Save' }).click();
	await expect.poll(() => seen.updated[0]).toMatchObject({ name: 'Evening digest', folder_id: 'f1' });
	await page.getByRole('button', { name: 'Delete' }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
	await expect(page).toHaveURL(/\/automations$/);
	expect(seen.deleted).toEqual(['a1']);
});

test('an unknown id goes back to the list; import skips incomplete entries', async ({ page }) => {
	await mockWorkspaceBackend(page, enabled);
	const seen = await mockAutomations(page);
	await page.goto('/automations/nope');
	await expect(page).toHaveURL(/\/automations$/);
	await page.getByLabel('Import automations file').setInputFiles({
		name: 'a.json',
		mimeType: 'application/json',
		buffer: Buffer.from(
			JSON.stringify([
				{ name: 'Ok', data: { prompt: 'p', model_id: 'm', rrule: 'R' }, meta: { webhook: 'https://x.example' } },
				{ name: 'Bad' }
			])
		)
	});
	await expect(page.getByText('Imported 1 automations; skipped 1 incomplete')).toBeVisible();
	expect(seen.created).toEqual([
		{
			name: 'Ok',
			folder_id: null,
			data: { prompt: 'p', model_id: 'm', rrule: 'R', target: { type: 'chat' } },
			meta: {},
			is_active: true
		}
	]);
});
