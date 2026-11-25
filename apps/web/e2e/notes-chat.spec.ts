import type { Page } from '@playwright/test';
import { json, mockChat, savedChat } from './chat-helpers';
import { expect, test } from './test';

type Rec = Record<string, unknown>;

const note = (id: string, title: string, md: string) => ({
	id,
	title,
	user_id: 'u1',
	user: { name: 'Test User' },
	write_access: true,
	is_pinned: false,
	updated_at: Date.now() * 1_000_000,
	access_grants: [],
	data: { content: { json: null, html: `<p>${md}</p>`, md } }
});

/** Just the notes endpoints these flows use; `created` and `updates` are what the page sent. */
async function mockNotes(page: Page, notes: Rec[]) {
	const seen = { created: [] as Rec[], updates: [] as Rec[] };
	const byId = new Map(notes.map((n) => [n.id, n]));
	await page.route('**/api/v1/notes/**', async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname.replace('/api/v1/notes', '');
		if (path === '/search') return json(route, { items: notes, total: notes.length });
		if (path === '/pinned') return json(route, []);
		if (path === '/create') {
			const body = req.postDataJSON();
			seen.created.push(body);
			const created = { ...note(`n${seen.created.length + 10}`, body.title, ''), data: body.data };
			byId.set(created.id, created);
			return json(route, created);
		}
		const [, id, action] = path.split('/');
		if (action === 'update') {
			seen.updates.push({ id, ...req.postDataJSON() });
			return json(route, { ...byId.get(id), ...req.postDataJSON() });
		}
		return byId.has(id) ? json(route, byId.get(id)) : json(route, { detail: 'Not found' }, 404);
	});
	return seen;
}

const REPLY = 'It is **4**\n\n```py\nprint(2 + 2)\n```\n\n$$2+2=4$$';
const convo = () => [
	savedChat('c1', 'Arithmetic', [
		{ id: 'u1', role: 'user', content: 'What is 2+2?' },
		{ id: 'a1', role: 'assistant', content: REPLY, model: 'qwen', modelName: 'Qwen', done: true }
	])
];
const withNotes = { features: { enable_notes: true } };

test('Ask in a new chat from a note opens a new chat with the note attached', async ({ page }) => {
	await mockChat(page, { user: withNotes });
	await mockNotes(page, [note('n1', 'Study plan', 'Week 1: limits')]);
	await page.goto('/notes/n1');
	await page.getByRole('button', { name: 'Note menu' }).click();
	await page.getByRole('menuitem', { name: 'Ask in a new chat' }).click();
	await expect(page.getByRole('button', { name: 'Remove Study plan' })).toBeVisible();
	// The parameter is spent: a reload does not attach it again.
	await expect(page).toHaveURL(/localhost:5174\/$/);
});

test('Save to note from a reply creates a note holding the reply as written', async ({ page }) => {
	await mockChat(page, { chats: convo(), user: withNotes });
	const seen = await mockNotes(page, []);
	await page.goto('/c/c1');
	const reply = page.getByTestId('response-message');
	await reply.getByRole('button', { name: 'More actions' }).click();
	await page.getByRole('menuitem', { name: 'Save to note' }).click();
	const dialog = page.getByRole('dialog', { name: 'Save to note' });
	await expect(dialog.getByRole('textbox', { name: 'Title' })).toHaveValue('Arithmetic');
	await dialog.getByRole('button', { name: 'Save', exact: true }).click();
	await expect.poll(() => seen.created.length).toBe(1);
	expect(seen.created[0]).toMatchObject({
		title: 'Arithmetic',
		data: { content: { md: REPLY, json: null, html: expect.stringContaining('print(2 + 2)') } }
	});
	await expect(page.getByText('Saved to "Arithmetic"')).toBeVisible();
	await page.getByRole('button', { name: 'Open', exact: true }).click();
	await expect(page).toHaveURL(/\/notes\/n11$/);
});

test('Explain in a new chat quotes the selection in the composer and attaches the note', async ({ page }) => {
	await mockChat(page, { user: withNotes });
	await mockNotes(page, [note('n1', 'Study plan', 'Limits first')]);
	await page.goto('/notes/n1');
	await page.getByRole('button', { name: 'Note menu' }).click();
	await expect(page.getByRole('menuitem', { name: 'Explain in a new chat' })).toBeDisabled();
	await page.keyboard.press('Escape');
	await page.getByRole('textbox', { name: 'Note content' }).click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.getByRole('button', { name: 'Note menu' }).click();
	await page.getByRole('menuitem', { name: 'Explain in a new chat' }).click();
	await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('> Limits first\n\nExplain this.');
	await expect(page.getByRole('button', { name: 'Remove Study plan' })).toBeVisible();
	await expect(page).toHaveURL(/localhost:5174\/$/);
});
