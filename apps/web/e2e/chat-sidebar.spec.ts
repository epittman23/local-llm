import type { Page } from '@playwright/test';
import { mockChat, savedChat } from './chat-helpers';
import { expect, test } from './test';

const now = () => Math.floor(Date.now() / 1000);
const chats = () => [
	savedChat('c1', 'Trip planning', [{ id: 'u', role: 'user', content: 'Plan a trip' }, { id: 'a', role: 'assistant', content: 'Sure', model: 'qwen', done: true }], { updated_at: now(), last_read_at: now() - 100 }),
	savedChat('c2', 'Recipe ideas', [{ id: 'u', role: 'user', content: 'Soup?' }], { updated_at: now() - 86400, last_read_at: now() }),
	savedChat('c3', 'Pinned notes', [], { pinned: true, updated_at: now() - 50, last_read_at: now() }),
	savedChat('c4', 'Work stuff', [], { folder_id: 'f1', updated_at: now() - 60, last_read_at: now() })
];
const folders = [{ id: 'f1', name: 'Work', parent_id: null }, { id: 'f2', name: 'Sub', parent_id: 'f1' }];

async function open(page: Page) {
	await page.context().addInitScript(() => window.localStorage.setItem('sidebar', 'true'));
	const chat = await mockChat(page, { chats: chats(), folders });
	await page.goto('/');
	return chat;
}
const item = (page: Page, title: string) => page.getByTestId('chat-item').filter({ hasText: title });

test('lists pinned chats, folders and chats by time, with unread marks', async ({ page }) => {
	await open(page);
	const list = page.locator('[aria-label="Chat list"]');
	await expect(list.getByText('Today')).toBeVisible();
	await expect(list.getByText('Yesterday')).toBeVisible();
	await expect(item(page, 'Trip planning').getByLabel('Unread')).toBeVisible();
	await expect(item(page, 'Recipe ideas').getByLabel('Unread')).toHaveCount(0);
	await expect(page.getByText('Pinned', { exact: true })).toBeVisible();
	await expect(item(page, 'Pinned notes')).toBeVisible();
	const tree = page.getByRole('list', { name: 'Folders' });
	await expect(tree.getByRole('link', { name: 'Work' })).toBeVisible();
	await expect(tree.getByRole('link', { name: 'Sub' })).toHaveCount(0);
	await tree.getByRole('button', { name: 'Expand Work' }).click();
	await expect(tree.getByRole('link', { name: 'Sub' })).toBeVisible();
	await expect(item(page, 'Work stuff')).toBeVisible();
});

test('opening a chat clears its unread mark and tells the server', async ({ page }) => {
	const chat = await open(page);
	await chat.socket.connected;
	await item(page, 'Trip planning').getByRole('link').click();
	await expect(page).toHaveURL(/\/c\/c1$/);
	await expect(page.getByTestId('response-message')).toContainText('Sure');
	await expect(item(page, 'Trip planning').getByLabel('Unread')).toHaveCount(0);
	await expect.poll(() => chat.socket.emitted('events:chat').some((d) => d.chat_id === 'c1' && d.data.type === 'last_read_at')).toBe(true);
});

test('rename in place, pin, clone and delete from the menu', async ({ page }) => {
	const chat = await open(page);
	await item(page, 'Recipe ideas').getByRole('link').dblclick();
	const input = page.getByRole('textbox', { name: 'Chat title' });
	await input.fill('Soup recipes');
	await input.press('Enter');
	await expect(item(page, 'Soup recipes')).toBeVisible();
	await expect.poll(() => chat.seen.updates.some((u) => u.id === 'c2' && u.chat.title === 'Soup recipes')).toBe(true);

	await item(page, 'Soup recipes').hover();
	await page.getByRole('button', { name: 'Chat menu: Soup recipes' }).click();
	await page.getByRole('menuitem', { name: 'Pin' }).click();
	await expect.poll(() => chat.seen.actions).toContain('pin:c2');

	await item(page, 'Trip planning').hover();
	await page.getByRole('button', { name: 'Chat menu: Trip planning' }).click();
	await page.getByRole('menuitem', { name: 'Clone' }).click();
	await expect(page).toHaveURL(/\/c\/c1-clone$/);
	await expect(item(page, 'Clone of Trip planning')).toBeVisible();

	await item(page, 'Clone of Trip planning').hover();
	await page.getByRole('button', { name: 'Chat menu: Clone of Trip planning' }).click();
	await page.getByRole('menuitem', { name: 'Delete' }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
	await expect(page).toHaveURL(/localhost:5174\/$/);
	await expect(item(page, 'Clone of Trip planning')).toHaveCount(0);
});

test('share copies a link to the public page, and move puts a chat in a folder', async ({ page }) => {
	const chat = await open(page);
	await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
	await item(page, 'Trip planning').hover();
	await page.getByRole('button', { name: 'Chat menu: Trip planning' }).click();
	await page.getByRole('menuitem', { name: 'Share' }).click();
	await page.getByRole('button', { name: 'Copy Link' }).click();
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/s\/share-c1$/);

	await item(page, 'Recipe ideas').hover();
	await page.getByRole('button', { name: 'Chat menu: Recipe ideas' }).click();
	await page.getByRole('menuitem', { name: 'Move' }).click();
	await page.getByRole('menuitem', { name: 'Work' }).click();
	await expect.poll(() => chat.seen.actions).toContain('folder:c2');
	await expect(page.locator('[aria-label="Chat list"]').getByText('Recipe ideas')).toHaveCount(0);
});

test('archiving the open chat goes home', async ({ page }) => {
	const chat = await open(page);
	await item(page, 'Trip planning').getByRole('link').click();
	await expect(page).toHaveURL(/\/c\/c1$/);
	await item(page, 'Trip planning').hover();
	await page.getByRole('button', { name: 'Chat menu: Trip planning' }).click();
	await page.getByRole('menuitem', { name: 'Archive' }).click();
	await expect(page).toHaveURL(/localhost:5174\/$/);
	expect(chat.seen.actions).toContain('archive:c1');
});

test('search finds chats with Ctrl+K and opens one', async ({ page }) => {
	const chat = await open(page);
	await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
	await page.keyboard.press('Control+k');
	await page.getByRole('textbox', { name: 'Search chats' }).fill('recipe');
	await page.getByRole('listbox', { name: 'Search results' }).getByRole('option', { name: /Recipe ideas/ }).click();
	await expect(page).toHaveURL(/\/c\/c2$/);
	expect(chat.seen.searches).toContain('recipe');
});

test('folders: create, edit with a system prompt, and delete', async ({ page }) => {
	const chat = await open(page);
	await page.getByRole('button', { name: 'New Folder' }).click();
	await page.getByLabel('Folder Name').fill('Travel');
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('list', { name: 'Folders' }).getByRole('link', { name: 'Travel' })).toBeVisible();
	expect(chat.seen.folderCalls).toContain('POST /');

	await page.getByRole('list', { name: 'Folders' }).getByRole('link', { name: 'Work' }).hover();
	await page.getByRole('button', { name: 'Folder menu: Work' }).click();
	await page.getByRole('menuitem', { name: 'Edit' }).click();
	await page.getByLabel('System Prompt').fill('Be formal');
	await page.getByRole('button', { name: 'Save' }).click();
	await expect.poll(() => chat.seen.folderCalls).toContain('POST /f1/update');

	await page.getByRole('list', { name: 'Folders' }).getByRole('link', { name: 'Travel' }).hover();
	await page.getByRole('button', { name: 'Folder menu: Travel' }).click();
	await page.getByRole('menuitem', { name: 'Delete' }).click();
	await page.getByRole('dialog', { name: 'Delete folder?' }).getByRole('button', { name: 'Delete' }).click();
	await expect(page.getByRole('list', { name: 'Folders' }).getByRole('link', { name: 'Travel' })).toHaveCount(0);
});
