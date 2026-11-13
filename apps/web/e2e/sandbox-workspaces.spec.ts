import type { Page } from '@playwright/test';
import { json, mockChat, savedChat } from './chat-helpers';
import { expect, test } from './test';

// The workspace cap and deletion dialog (owner decision Q15), against mocked /api/v1/sandbox/pending routes.

const W1 = '00000000-0000-4000-8000-0000000000a1';
const W2 = '00000000-0000-4000-8000-0000000000a2';

const expired = {
	id: W1,
	chat_id: W1,
	chat_title: 'Sales analysis',
	reason: 'expired',
	since: 1_700_000_000,
	created_at: 1_690_000_000,
	last_used_at: 1_690_000_000,
	contents: {
		files: [
			{ path: 'data/sales.csv', size: 2048, mtime: 1_690_000_000 },
			{ path: 'outputs/plot.png', size: 512, mtime: 1_690_000_100 }
		],
		file_count: 2,
		total_bytes: 2560,
		complete: true
	},
	contents_error: null
};

const cap = {
	...expired,
	reason: 'cap',
	waiting_chat_id: 'c1',
	waiting_chat_title: 'Code',
	workspaces: [{ id: W2, chat_id: W2, chat_title: 'Old notebook', last_used_at: 1_695_000_000 }]
};

/** Serves the pending routes from `state`, recording every answer. */
async function mockPending(page: Page, state: { ids: string[]; pending: unknown[] }) {
	const answers: { id: string; body: unknown }[] = [];
	await page.route('**/api/v1/sandbox/pending/ids', (route) => json(route, { ids: state.ids }));
	await page.route('**/api/v1/sandbox/pending', (route) =>
		json(route, { pending: state.pending, max_workspaces: 20, retention_days: 7 })
	);
	await page.route('**/api/v1/sandbox/pending/*', (route) => {
		const req = route.request();
		if (req.method() !== 'POST') return route.fallback();
		const id = new URL(req.url()).pathname.split('/').at(-1) ?? '';
		answers.push({ id, body: req.postDataJSON() });
		state.ids = [];
		state.pending = [];
		return json(route, { ok: true });
	});
	return answers;
}

test('on load, a workspace unused too long is shown with its contents, and Remove deletes it', async ({ page }) => {
	await mockChat(page, { chats: [savedChat('c1', 'Code', [])] });
	const answers = await mockPending(page, { ids: [W1], pending: [expired] });
	await page.goto('/');

	const dialog = page.getByRole('dialog', { name: 'Code workspaces waiting for your answer' });
	await expect(dialog).toBeVisible();
	const item = dialog.getByRole('region', { name: 'Workspace of Sales analysis' });
	await expect(item).toContainText('Not used for more than 7 days');
	await expect(item.getByRole('cell', { name: 'data/sales.csv' })).toBeVisible();
	await expect(item.getByRole('cell', { name: 'outputs/plot.png' })).toBeVisible();
	await expect(item.getByTestId('workspace-totals')).toHaveText('2 files, 2.5 KB');

	await item.getByRole('button', { name: 'Remove workspace of Sales analysis' }).click();
	await expect(dialog).toHaveCount(0);
	expect(answers).toEqual([{ id: W1, body: { action: 'remove', since: 1_700_000_000 } }]);
});

test('a reply whose code hit the workspace limit opens the dialog, where another workspace can go', async ({
	page
}) => {
	const chat = await mockChat(page, { chats: [savedChat('c1', 'Code', [])] });
	const state = { ids: [] as string[], pending: [] as unknown[] };
	const answers = await mockPending(page, state);
	await page.goto('/c/c1');
	await chat.socket.connected;
	const dialog = page.getByRole('dialog', { name: 'Code workspaces waiting for your answer' });
	await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
	await expect(dialog).toHaveCount(0);

	await page.getByRole('textbox', { name: 'Message' }).fill('Plot the sales');
	await page.getByRole('textbox', { name: 'Message' }).press('Enter');
	await expect.poll(() => chat.seen.completions.length).toBe(1);
	// The model's code call was refused at the cap, so the server now has a request for this user.
	state.ids = [W1];
	state.pending = [cap];
	await chat.stream('Your workspace limit is reached; remove one and I will run it.');

	await expect(dialog).toBeVisible();
	const item = dialog.getByRole('region', { name: 'Workspace of Sales analysis' });
	await expect(item).toContainText('"\u2068Code\u2069" needs a code workspace, and you have the most allowed (20)');
	await item.getByLabel('Workspace to remove').selectOption(W2);
	await item.getByRole('button', { name: 'Remove workspace of Sales analysis' }).click();
	await expect(dialog).toHaveCount(0);
	expect(answers).toEqual([{ id: W1, body: { action: 'remove', since: 1_700_000_000, workspace: W2 } }]);
});

test('Decide later closes the dialog and Keep answers without deleting', async ({ page }) => {
	await mockChat(page, { chats: [savedChat('c1', 'Code', [])] });
	const answers = await mockPending(page, { ids: [W1], pending: [expired] });
	await page.goto('/');
	const dialog = page.getByRole('dialog', { name: 'Code workspaces waiting for your answer' });
	await dialog.getByRole('button', { name: 'Decide later' }).click();
	await expect(dialog).toHaveCount(0);
	expect(answers).toEqual([]);

	// Shown again on the next load, since nothing was answered.
	await page.reload();
	await dialog
		.getByRole('region', { name: 'Workspace of Sales analysis' })
		.getByRole('button', { name: 'Keep workspace of Sales analysis' })
		.click();
	await expect(dialog).toHaveCount(0);
	expect(answers).toEqual([{ id: W1, body: { action: 'keep', since: 1_700_000_000 } }]);
});

test('a Run that hit the workspace limit opens the dialog too', async ({ page }) => {
	await mockChat(page, {
		chats: [
			savedChat('c1', 'Code', [
				{ id: 'u1', role: 'user', content: 'Plot it' },
				{
					id: 'a1',
					role: 'assistant',
					content: '```python\nprint(1)\n```\n',
					model: 'qwen',
					modelName: 'Qwen',
					done: true
				}
			])
		],
		user: {
			features: { enable_code_execution: true },
			config: { code: { engine: 'sandbox' } },
			featurePermissions: { code_interpreter: true }
		}
	});
	const state = { ids: [] as string[], pending: [] as unknown[] };
	await mockPending(page, state);
	await page.route('**/api/v1/utils/code/execute', (route) => {
		state.ids = [W1];
		state.pending = [cap];
		return json(route, { stdout: '', stderr: 'the user already has 20 saved workspaces', result: '' });
	});
	await page.goto('/c/c1');
	await expect(page.getByTestId('code-block')).toBeVisible();
	const dialog = page.getByRole('dialog', { name: 'Code workspaces waiting for your answer' });
	await expect(dialog).toHaveCount(0);
	await page.getByTestId('code-block').getByRole('button', { name: 'Run' }).click();
	await expect(dialog.getByRole('region', { name: 'Workspace of Sales analysis' })).toBeVisible();
});

test('a very long chat title does not make the dialog scroll sideways, and its buttons stay in view', async ({
	page
}) => {
	// Untitled chats show their whole first message as the title; a native <select> grew to fit it (found on the
	// real stack, 2026-11-13).
	const long = 'Using the code interpreter, run one Python block that imports pandas and matplotlib, '.repeat(3);
	await page.setViewportSize({ width: 900, height: 900 });
	await mockChat(page, { chats: [savedChat('c1', 'Code', [])] });
	await mockPending(page, {
		ids: [W1],
		pending: [{ ...cap, chat_title: long, workspaces: [{ ...cap.workspaces[0], chat_title: long }] }]
	});
	await page.goto('/');

	const dialog = page.getByRole('dialog', { name: 'Code workspaces waiting for your answer' });
	await expect(dialog).toBeVisible();
	const sideways = await dialog.evaluate((el) => el.scrollWidth - el.clientWidth);
	expect(sideways).toBeLessThanOrEqual(0);
	const remove = dialog.getByRole('button', { name: /^Remove workspace of / });
	await expect(remove).toBeInViewport();
	const option = dialog.getByRole('combobox', { name: 'Workspace to remove' }).locator('option').first();
	expect(Array.from((await option.textContent()) ?? '').length).toBeLessThan(120);
});
