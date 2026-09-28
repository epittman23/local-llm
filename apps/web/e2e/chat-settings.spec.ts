import type { Page } from '@playwright/test';
import { json, mockChat, savedChat } from './chat-helpers';
import { expect, test } from './test';

// The personal settings chat reads (docs/code-review.md M1, M2, M7): each was
// saved by the Settings modal but ignored by chat before.

const withSettings = (page: Page, ui: Record<string, unknown>) => page.route('**/api/v1/users/user/settings', (route) => json(route, { ui: { models: ['qwen'], ...ui } }));

test('Temporary Chat by Default: a new chat starts temporary and is not saved', async ({ page }) => {
	const chat = await mockChat(page, { user: { role: 'admin' } });
	await withSettings(page, { temporaryChatByDefault: true });
	await page.goto('/');
	await chat.socket.connected;
	await expect(page.getByRole('button', { name: 'Temporary Chat' })).toHaveAttribute('aria-pressed', 'true');
	await page.getByRole('textbox', { name: 'Message' }).fill('Off the record');
	await page.keyboard.press('Enter');
	await expect.poll(() => chat.seen.completions.length).toBe(1);
	expect(chat.seen.completions[0].chat_id).toMatch(/^temporary:/);
	await expect(page).toHaveURL(/\/$/);
});

test('web search confirmation: asked once per chat before a prompt with search on; cancel sends nothing', async ({ page }) => {
	const chat = await mockChat(page, { user: { role: 'admin', features: { enable_web_search: true, enable_web_search_confirmation: true, web_search_confirmation_content: 'Queries go to **Example Search**.' } } });
	await withSettings(page, {});
	await page.goto('/');
	await chat.socket.connected;
	await page.getByRole('button', { name: 'Integrations' }).click();
	await page.getByRole('switch', { name: 'Web Search' }).click();
	await page.keyboard.press('Escape');
	const box = page.getByRole('textbox', { name: 'Message' });

	await box.fill('What is new?');
	await page.keyboard.press('Enter');
	const dialog = page.getByRole('alertdialog', { name: 'Use Web Search?' });
	await expect(dialog.locator('strong', { hasText: 'Example Search' })).toBeVisible();
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toHaveCount(0);
	await expect(box).toHaveValue('What is new?');
	expect(chat.seen.completions).toHaveLength(0);

	await expect(box).toBeFocused();
	await box.press('Enter');
	await dialog.getByRole('button', { name: 'Continue' }).click();
	await expect.poll(() => chat.seen.completions.length).toBe(1);
	expect(chat.seen.completions[0]).toMatchObject({ features: { web_search: true } });
	await expect(box).toHaveValue('');

	// Confirmed for this chat, which keeps it when the server names the chat.
	await chat.stream('Here you go.');
	await box.fill('And more?');
	await page.keyboard.press('Enter');
	await expect.poll(() => chat.seen.completions.length).toBe(2);
	await expect(dialog).toHaveCount(0);
});

test('Web Search in Chat: Always starts a new chat with search on', async ({ page }) => {
	const chat = await mockChat(page, { user: { role: 'admin', features: { enable_web_search: true } } });
	await withSettings(page, { webSearch: 'always' });
	await page.goto('/');
	await chat.socket.connected;
	await expect(page.getByRole('button', { name: 'Web Search (on)' })).toBeVisible();
	await page.getByRole('textbox', { name: 'Message' }).fill('Latest news');
	await page.keyboard.press('Enter');
	await expect.poll(() => chat.seen.completions.length).toBe(1);
	expect(chat.seen.completions[0]).toMatchObject({ features: { web_search: true } });
});

test('display settings: no bubbles, Markdown in user messages, widescreen, direction, plain regenerate, title', async ({ page }) => {
	const chat = await mockChat(page, {
		user: { role: 'admin' },
		chats: [savedChat('c1', 'Formatting', [{ id: 'u', role: 'user', content: 'Make it **bold**' }, { id: 'a', role: 'assistant', model: 'qwen', content: 'Done', done: true }])]
	});
	await withSettings(page, { chatBubble: false, widescreenMode: true, chatDirection: 'RTL', regenerateMenu: false, showChatTitleInTab: false });
	await page.goto('/c/c1');
	await chat.socket.connected;
	const user = page.getByTestId('user-message');
	await expect(user.getByText('You', { exact: true })).toBeVisible();
	await expect(user.locator('strong', { hasText: 'bold' })).toBeVisible();
	const column = page.getByTestId('chat-column');
	await expect(column).toHaveAttribute('dir', 'rtl');
	await expect(column).not.toHaveClass(/max-w-3xl/);
	await expect(page.getByRole('button', { name: 'Regenerate', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Regenerate options' })).toHaveCount(0);
	await expect(page).toHaveTitle('local-llm');
});

test('Insert Follow-Up Prompt to Input puts a follow-up in the input instead of sending it', async ({ page }) => {
	const chat = await mockChat(page, { user: { role: 'admin' } });
	await withSettings(page, { insertFollowUpPrompt: true });
	await page.goto('/');
	await chat.socket.connected;
	await page.getByRole('textbox', { name: 'Message' }).fill('Hi');
	await page.keyboard.press('Enter');
	await expect.poll(() => chat.seen.completions.length).toBe(1);
	await chat.stream('Hello!');
	chat.event('chat:message:follow_ups', { follow_ups: ['Tell me more'] });
	await page.getByRole('button', { name: 'Tell me more' }).click();
	await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Tell me more');
	expect(chat.seen.completions).toHaveLength(1);
});

test('Paste Large Text as File attaches long pasted text as a file', async ({ page }) => {
	const chat = await mockChat(page, { user: { role: 'admin' } });
	await withSettings(page, { largeTextAsFile: true });
	const uploads: string[] = [];
	await page.route(/\/api\/v1\/files\/(\?|$)/, async (route) => {
		uploads.push(route.request().url());
		return json(route, { id: 'file1', filename: 'Pasted_Text.txt', meta: { content_type: 'text/plain', collection_name: 'c' } });
	});
	await page.route(/\/api\/v1\/files\/[^/]+\/process\/status/, (route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"status":"completed"}\n\ndata: [DONE]\n\n' }));
	await page.goto('/');
	await chat.socket.connected;
	const box = page.getByRole('textbox', { name: 'Message' });
	await box.evaluate((el, text) => {
		const data = new DataTransfer();
		data.setData('text/plain', text);
		el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
	}, 'x'.repeat(1500));
	await expect.poll(() => uploads.length).toBe(1);
	await expect(page.getByTestId('input-file')).toContainText(/Pasted_Text_\d+\.txt/);
	await expect(box).toHaveValue('');
});

test('Auto-Playback Response reads a finished reply aloud, but not one already done on load', async ({ page }) => {
	await page.addInitScript(() => {
		const spoken: string[] = [];
		(window as unknown as { __spoken: string[] }).__spoken = spoken;
		window.speechSynthesis.speak = (u: SpeechSynthesisUtterance) => void spoken.push(u.text);
	});
	const chat = await mockChat(page, { user: { role: 'admin' }, chats: [savedChat('c1', 'Old', [{ id: 'u', role: 'user', content: 'Hi' }, { id: 'a', role: 'assistant', model: 'qwen', content: 'Old reply', done: true }])] });
	await withSettings(page, { responseAutoPlayback: true });
	await page.goto('/c/c1');
	await chat.socket.connected;
	await expect(page.getByText('Old reply')).toBeVisible();
	await page.getByRole('textbox', { name: 'Message' }).fill('Again');
	await page.keyboard.press('Enter');
	await expect.poll(() => chat.seen.completions.length).toBe(1);
	await chat.stream('Fresh reply');
	await expect.poll(() => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken)).toEqual(['Fresh reply']);
});

test('the Interface tab only offers what the app does', async ({ page }) => {
	await mockChat(page, { user: { role: 'admin' } });
	await withSettings(page, {});
	await page.goto('/?settings=interface');
	const modal = page.getByRole('dialog');
	await expect(modal.getByRole('switch', { name: 'Chat Bubble UI' })).toBeVisible();
	for (const name of ['Rich Text Input for Chat', 'iframe Sandbox Allow Same Origin', 'Toast Notifications for New Updates', 'Floating Quick Actions', 'Allow Voice Interruption in Call']) {
		await expect(modal.getByRole('switch', { name })).toHaveCount(0);
	}
	await expect(modal.getByRole('button', { name: /Landing Page Mode/ })).toHaveCount(0);
});
