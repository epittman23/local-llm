import { mockChat, savedChat } from './chat-helpers';
import { expect, test } from './test';

const convo = (content = 'It is 4') => [
	savedChat('c1', 'Arithmetic', [
		{ id: 'u1', role: 'user', content: 'What is 2+2?' },
		{ id: 'a1', role: 'assistant', content, model: 'qwen', modelName: 'Qwen', done: true }
	])
];

test('the controls panel sets the chat system prompt; it is sent and saved', async ({ page }) => {
	const chat = await mockChat(page, { chats: convo() });
	await page.goto('/c/c1');
	await page.getByRole('button', { name: 'Controls' }).click();
	const panel = page.getByRole('complementary', { name: 'Controls' });
	await panel.getByLabel('System prompt').fill('Answer in French.');
	// Saved with the chat after a short pause.
	await expect.poll(() => chat.seen.updates.at(-1)?.chat?.params?.system).toBe('Answer in French.');

	await page.getByRole('textbox', { name: 'Message' }).fill('And 3+3?');
	await page.keyboard.press('Enter');
	await expect.poll(() => chat.seen.completions.length).toBe(1);
	expect(chat.seen.completions[0].params.system).toBe('Answer in French.');
	expect(chat.seen.completions[0].messages?.[0]).toMatchObject({ role: 'system', content: 'Answer in French.' });

	await panel.getByRole('button', { name: 'Close controls' }).click();
	await expect(panel).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Controls' })).toBeFocused();
});

test('a controls edit is saved to its chat even when the page is left at once (#525)', async ({ page }) => {
	// An admin, who may open the workspace: a page other than the chat's.
	const chat = await mockChat(page, { chats: convo(), user: { role: 'admin' } });
	await page.goto('/c/c1');
	const workspace = page.getByRole('link', { name: 'Workspace' });
	await expect(workspace).toBeVisible();
	await page.getByRole('button', { name: 'Controls' }).click();
	const panel = page.getByRole('complementary', { name: 'Controls' });
	await panel.getByLabel('System prompt').fill('Answer in French.');
	// Well within the autosave's pause: the chat page unmounts before it ends.
	await workspace.click();
	await expect(page).toHaveURL(/\/workspace/);

	await expect.poll(() => chat.seen.updates.find((u) => u.chat?.params?.system === 'Answer in French.')?.id).toBe('c1');
});

test('a controls edit is saved to the chat it was made in when another chat opens at once', async ({ page }) => {
	const chat = await mockChat(page, {
		chats: [...convo(), savedChat('c2', 'Other', [{ id: 'u2', role: 'user', content: 'Hi' }])]
	});
	await page.goto('/c/c1');
	const other = page.getByRole('link', { name: 'Other' });
	await expect(other).toBeVisible();
	await page.getByRole('button', { name: 'Controls' }).click();
	await page.getByRole('complementary', { name: 'Controls' }).getByLabel('System prompt').fill('Answer in French.');
	await other.click();
	await expect(page).toHaveURL(/\/c\/c2$/);

	await expect.poll(() => chat.seen.updates.find((u) => u.chat?.params?.system === 'Answer in French.')?.id).toBe('c1');
	expect(chat.seen.updates.filter((u) => u.id === 'c2' && u.chat?.params)).toEqual([]);
});

test('the header menu downloads, and deletes after confirming', async ({ page }) => {
	const chat = await mockChat(page, { chats: convo() });
	await page.goto('/c/c1');
	for (const [item, file] of [
		['Markdown (.md)', 'chat-Arithmetic.md'],
		['Plain text (.txt)', 'chat-Arithmetic.txt'],
		['JSON (.json)', 'chat-Arithmetic.json']
	]) {
		await page.getByRole('button', { name: 'Chat menu', exact: true }).click();
		await page.getByRole('menuitem', { name: 'Download' }).click();
		const download = page.waitForEvent('download');
		await page.getByRole('menuitem', { name: item }).click();
		expect((await download).suggestedFilename()).toBe(file);
	}

	await page.getByRole('button', { name: 'Chat menu', exact: true }).click();
	await page.locator('#delete-chat-button').click();
	await page.getByRole('button', { name: 'Delete chat', exact: true }).click();
	await expect.poll(() => chat.seen.actions).toContain('delete:c1');
	await expect(page).toHaveURL(/localhost:5174\/$/);
});

test('the header shows the chat title and renames it in place, by keyboard (#928)', async ({ page }) => {
	const chat = await mockChat(page, { chats: convo() });
	await page.goto('/c/c1');
	const title = page.getByRole('button', { name: 'Chat title: Arithmetic. Rename' });
	await expect(title).toBeVisible();
	await title.focus();
	await page.keyboard.press('Enter');
	const field = page.getByRole('textbox', { name: 'Chat title' });
	await expect(field).toBeFocused();
	await field.fill('Sums');
	await page.keyboard.press('Enter');
	await expect.poll(() => chat.seen.updates.at(-1)?.chat?.title).toBe('Sums');
	await expect(page.getByRole('button', { name: 'Chat title: Sums. Rename' })).toBeFocused();
	await expect(page).toHaveTitle(/^Sums/);

	// From the menu too, with Escape giving up the edit.
	await page.getByRole('button', { name: 'Chat menu', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Rename' }).click();
	await expect(field).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(field).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Chat title: Sums. Rename' })).toBeFocused();
});

test('an html page in a reply is a card that opens the canvas, framed in a sandbox', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const html = '<!doctype html><title>Hello page</title><h1 id="x">Hello artifact</h1>';
	await mockChat(page, { chats: convo(`Here:\n\n\`\`\`html\n${html}\n\`\`\``) });
	await page.goto('/c/c1');
	const card = page.getByTestId('document-card');
	await expect(card).toContainText('Hello page');
	await expect(page.getByTestId('code-block')).toHaveCount(0);
	await card.click();
	// The canvas holds the page (CNV-2), its id in the address (CNV-7), focus on its heading (NAV-4).
	await expect(page).toHaveURL(/\?canvas=block%3Aa1%3A0$/);
	const panel = page.getByRole('complementary', { name: 'Canvas' });
	await expect(panel.getByRole('heading')).toBeFocused();
	await expect(card).toHaveAttribute('aria-current', 'true');
	const frame = panel.locator('iframe');
	await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
	await expect(page.frameLocator('iframe[title="Preview of Hello page"]').locator('#x')).toHaveText('Hello artifact');
	await panel.getByRole('button', { name: 'Source' }).click();
	await expect(panel.locator('iframe')).toHaveCount(0);
	await expect(panel).toContainText('Hello artifact');
	await panel.getByRole('button', { name: 'Close canvas' }).click();
	await expect(panel).toHaveCount(0);
	await expect(page).not.toHaveURL(/canvas=/);
	await expect(card).toBeFocused();
});
