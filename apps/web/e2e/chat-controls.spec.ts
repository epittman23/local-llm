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
	await panel.getByLabel('System Prompt').fill('Answer in French.');
	// Saved with the chat after a short pause.
	await expect.poll(() => chat.seen.updates.at(-1)?.chat?.params?.system).toBe('Answer in French.');

	await page.getByRole('textbox', { name: 'Message' }).fill('And 3+3?');
	await page.keyboard.press('Enter');
	await expect.poll(() => chat.seen.completions.length).toBe(1);
	expect(chat.seen.completions[0].params.system).toBe('Answer in French.');
	expect(chat.seen.completions[0].messages?.[0]).toMatchObject({ role: 'system', content: 'Answer in French.' });

	await panel.getByRole('button', { name: 'Close controls' }).click();
	await expect(panel).toHaveCount(0);
});

test('a controls edit is saved to its chat even when the page is left at once (#525)', async ({ page }) => {
	// An admin, who may open the workspace: a page other than the chat's.
	const chat = await mockChat(page, { chats: convo(), user: { role: 'admin' } });
	await page.goto('/c/c1');
	await page.getByRole('button', { name: 'Open sidebar' }).click();
	const workspace = page.getByRole('link', { name: 'Workspace' });
	await expect(workspace).toBeVisible();
	await page.getByRole('button', { name: 'Controls' }).click();
	const panel = page.getByRole('complementary', { name: 'Controls' });
	await panel.getByLabel('System Prompt').fill('Answer in French.');
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
	await page.getByRole('button', { name: 'Open sidebar' }).click();
	const other = page.getByRole('link', { name: 'Other' });
	await expect(other).toBeVisible();
	await page.getByRole('button', { name: 'Controls' }).click();
	await page.getByRole('complementary', { name: 'Controls' }).getByLabel('System Prompt').fill('Answer in French.');
	await other.click();
	await expect(page).toHaveURL(/\/c\/c2$/);

	await expect.poll(() => chat.seen.updates.find((u) => u.chat?.params?.system === 'Answer in French.')?.id).toBe('c1');
	expect(chat.seen.updates.filter((u) => u.id === 'c2' && u.chat?.params)).toEqual([]);
});

test('the header menu downloads, and deletes after confirming', async ({ page }) => {
	const chat = await mockChat(page, { chats: convo() });
	await page.goto('/c/c1');
	await page.getByRole('button', { name: 'Chat menu' }).click();
	await page.getByRole('menuitem', { name: 'Download' }).click();
	const download = page.waitForEvent('download');
	await page.getByRole('menuitem', { name: 'Plain text (.txt)' }).click();
	expect((await download).suggestedFilename()).toBe('chat-Arithmetic.txt');

	await page.getByRole('button', { name: 'Chat menu' }).click();
	await page.locator('#delete-chat-button').click();
	await page.getByRole('button', { name: 'Delete', exact: true }).click();
	await expect.poll(() => chat.seen.actions).toContain('delete:c1');
	await expect(page).toHaveURL(/localhost:5174\/$/);
});

test('an html code block previews in a sandboxed frame', async ({ page }) => {
	await mockChat(page, { chats: convo('Here:\n\n```html\n<h1 id="x">Hello artifact</h1>\n```') });
	await page.goto('/c/c1');
	await page.getByTestId('code-block').getByRole('button', { name: 'Preview' }).click();
	const panel = page.getByRole('complementary', { name: 'Artifacts' });
	const frame = panel.locator('iframe');
	await expect(frame).toHaveAttribute('sandbox', /allow-scripts/);
	await expect(frame).not.toHaveAttribute('sandbox', /allow-same-origin/);
	await expect(page.frameLocator('iframe[title="Artifact preview"]').locator('#x')).toHaveText('Hello artifact');
	await panel.getByRole('button', { name: 'Close artifacts' }).click();
	await expect(panel).toHaveCount(0);
});
