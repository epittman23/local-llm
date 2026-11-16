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
			// Refused as the server refuses a one-time automation that has already run.
			if (req.postDataJSON()?.name === 'Refused')
				return route.fulfill({ status: 400, json: { detail: 'RRULE has no future occurrences' } });
			seen.created.push(req.postDataJSON());
			// Kept, as the server keeps it: the page it opens loads it back by id.
			const body = req.postDataJSON();
			const created = automation(`new${seen.created.length}`, body.name, body);
			list = [...list, created];
			return json(route, created);
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
		return found ? json(route, found) : json(route, { detail: "We could not find what you're looking for :/" }, 404);
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
	await expect(page.getByRole('heading', { level: 1, name: 'Automations' })).toBeVisible();
	await expect(page.getByRole('button', { name: /Morning digest.*Daily at 9:00 AM · New chat/ })).toBeVisible();
	await expect(page.getByText('Mon, Fri at 5:30 PM · #ops')).toBeVisible();
	const toggle = page.getByRole('switch', { name: 'Run Morning digest on its schedule' });
	await expect(toggle).toBeChecked();
	await toggle.click();
	await expect.poll(() => seen.toggled).toEqual(['a1']);
	await expect(toggle).not.toBeChecked();
	await expect(page.getByRole('button', { name: /^Morning digest/ })).toContainText('Paused');
});

test('search and the status filter go to the server', async ({ page }) => {
	await mockWorkspaceBackend(page, enabled);
	const seen = await mockAutomations(page, [automation('a1', 'Morning digest')]);
	await page.goto('/automations');
	await page.getByLabel('Search automations').fill('digest');
	await expect.poll(() => seen.lists.some((q) => new URLSearchParams(q).get('query') === 'digest')).toBe(true);
	await page.getByRole('button', { name: 'Status: All' }).click();
	await page.getByRole('menuitemradio', { name: 'Paused' }).click();
	await expect(page.getByRole('button', { name: 'Status: Paused' })).toBeVisible();
	await expect.poll(() => seen.lists.some((q) => new URLSearchParams(q).get('status') === 'paused')).toBe(true);
});

test('offers no channel to post to while the server has one account (S6-D1)', async ({ page }) => {
	await mockWorkspaceBackend(page, enabled);
	await page.route('**/api/v1/users/search**', (route) => json(route, { users: [], total: 1 }));
	await mockAutomations(page);
	await page.goto('/automations');
	await page.getByRole('button', { name: 'New automation' }).first().click();
	const d = page.getByRole('dialog', { name: 'New automation' });
	await d.getByRole('button', { name: 'Post to' }).click();
	await expect(page.getByRole('option', { name: /Chat, in no folder/ })).toBeVisible();
	await expect(page.getByRole('option', { name: 'ops' })).toHaveCount(0);
	await expect(page.getByRole('combobox', { name: 'Search folders' })).toBeVisible();
});

test('creating one: required fields, a weekly schedule, a channel destination, then it opens', async ({ page }) => {
	await mockWorkspaceBackend(page, enabled);
	// Channels are shown only with a second account (S6-D1).
	await page.route('**/api/v1/users/search**', (route) => json(route, { users: [], total: 2 }));
	const seen = await mockAutomations(page);
	await page.goto('/automations');
	await page.getByRole('button', { name: 'New automation' }).first().click();
	const d = page.getByRole('dialog', { name: 'New automation' });
	await d.getByRole('button', { name: 'Create automation' }).click();
	// FRM-2: each missing field says so under itself (#1033).
	await expect(d.getByText('Enter a name for the automation.')).toBeVisible();
	await expect(d.getByText('Enter the instructions the model follows on each run.')).toBeVisible();
	await expect(d.getByRole('textbox', { name: 'Name' })).toBeFocused();
	await d.getByRole('textbox', { name: 'Name' }).fill('Standup notes');
	await d.getByRole('textbox', { name: 'Instructions' }).fill('Summarize yesterday');
	await d.getByRole('button', { name: 'Model' }).click();
	await expect(page.getByRole('option', { name: 'Hidden' })).toHaveCount(0);
	await page.getByRole('option', { name: 'Qwen' }).click();
	await expect(page.getByRole('option', { name: 'Qwen' })).toHaveCount(0);
	await d.getByRole('combobox', { name: 'Schedule' }).click();
	await page.getByRole('option', { name: 'Weekly' }).click();
	// Weekly starts on today, shown pressed (#1104); here it is cleared and two days chosen.
	const days = d.getByRole('group', { name: 'Days' });
	await expect(days.locator('button[aria-pressed=true]')).toHaveCount(1);
	await days.locator('button[aria-pressed=true]').click();
	await d.getByRole('button', { name: 'Create automation' }).click();
	await expect(d.getByText('Choose at least one day.')).toBeVisible();
	await days.getByRole('button', { name: 'Mon' }).click();
	await days.getByRole('button', { name: 'Thu' }).click();
	await d.getByLabel('At', { exact: true }).fill('08:15');
	await expect(d.getByText(/^Next: (Mon|Thu), /)).toBeVisible();
	await d.getByRole('button', { name: 'Post to' }).click();
	await expect(page.getByRole('option', { name: 'dm' })).toHaveCount(0);
	await page.getByRole('option', { name: 'ops' }).click();
	await d.getByRole('button', { name: 'Create automation' }).click();
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
	// The automation itself, not only its URL: one the page cannot load says so
	// in place, after a URL check alone could already have passed.
	await expect(page.getByRole('heading', { level: 1, name: 'Standup notes' })).toBeVisible();
	await expect(page).toHaveURL(/\/automations\/new1$/);
});

test("a custom rule is spelled out, and the server's refusal is worded under it (#1032)", async ({ page }) => {
	await mockWorkspaceBackend(page, enabled);
	await mockAutomations(page);
	await page.route('**/api/v1/automations/create', (route) =>
		route.fulfill({ status: 400, json: { detail: 'Invalid RRULE: not enough values to unpack (expected 2, got 1)' } })
	);
	await page.goto('/automations');
	await page.getByRole('button', { name: 'New automation' }).first().click();
	const d = page.getByRole('dialog', { name: 'New automation' });
	await d.getByRole('textbox', { name: 'Name' }).fill('Month end');
	await d.getByRole('textbox', { name: 'Instructions' }).fill('Summarise the month');
	await d.getByRole('button', { name: 'Model' }).click();
	await page.getByRole('option', { name: 'Qwen' }).click();
	await d.getByRole('combobox', { name: 'Schedule' }).click();
	await page.getByRole('option', { name: 'Custom rule' }).click();
	await d.getByRole('textbox', { name: 'Rule' }).fill('RRULE:FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=17;BYMINUTE=0');
	await expect(d.getByText(/^Next: Fri, /)).toBeVisible();
	await d.getByRole('button', { name: 'Create automation' }).click();
	await expect(d.getByText(/^The scheduler can't read this rule/)).toBeVisible();
	await expect(page.getByText(/not enough values/)).toHaveCount(0);
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
	await expect(page.getByRole('heading', { level: 1, name: 'Morning digest' })).toBeVisible();
	await expect(page.getByText('Folder: Reports').first()).toBeVisible();
	await expect(page.getByText('Prompt for Morning digest')).toBeVisible();
	await expect(page.getByRole('link', { name: 'Open chat' })).toHaveAttribute('href', '/c/chat9');
	// #1034: the failure in full, with its badge and Run again.
	await expect(page.getByText('Model unavailable')).toBeVisible();
	await expect(page.getByText('Failed')).toBeVisible();
	await page.getByRole('button', { name: 'Run again' }).click();
	await expect.poll(() => seen.ran).toEqual(['a1']);
	await page.getByRole('button', { name: 'Run now' }).click();
	await expect.poll(() => seen.ran).toEqual(['a1', 'a1']);
	await page.getByRole('button', { name: 'Edit', exact: true }).click();
	const d = page.getByRole('dialog', { name: 'Edit automation' });
	await expect(d.getByRole('textbox', { name: 'Name' })).toHaveValue('Morning digest');
	await d.getByRole('textbox', { name: 'Name' }).fill('Evening digest');
	// S6-D13: every run into one chat.
	await d.getByRole('checkbox', { name: 'Same chat every time' }).click();
	await d.getByRole('button', { name: 'Save changes' }).click();
	await expect
		.poll(() => seen.updated[0])
		.toMatchObject({ name: 'Evening digest', folder_id: 'f1', data: { target: { type: 'chat', same_chat: true } } });
	await page.getByRole('button', { name: 'Delete', exact: true }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Delete automation' }).click();
	await expect(page).toHaveURL(/\/automations$/);
	expect(seen.deleted).toEqual(['a1']);
});

test('import goes on past an automation the server refuses, and names it (#323)', async ({ page }) => {
	await mockWorkspaceBackend(page, enabled);
	const seen = await mockAutomations(page);
	await page.goto('/automations');
	const item = (name: string) => ({ name, data: { prompt: 'p', model_id: 'm', rrule: 'RRULE:FREQ=DAILY' } });
	await page.getByLabel('Import automations file').setInputFiles({
		name: 'a.json',
		mimeType: 'application/json',
		buffer: Buffer.from(JSON.stringify([item('First'), item('Refused'), item('Last')]))
	});
	await expect(
		page.getByText('Imported 2 automations; 1 could not be created: Refused (RRULE has no future occurrences)')
	).toBeVisible();
	expect(seen.created.map((a) => a.name)).toEqual(['First', 'Last']);
});

test('an unknown id says so in place (NAV-3); import skips incomplete entries', async ({ page }) => {
	await mockWorkspaceBackend(page, enabled);
	const seen = await mockAutomations(page);
	await page.goto('/automations/nope');
	await expect(page.getByRole('heading', { name: 'This automation no longer exists' })).toBeVisible();
	await page.getByRole('link', { name: 'Back to automations' }).click();
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
	await expect(page.getByText('Imported 1 automation; skipped 1 incomplete')).toBeVisible();
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
