import { json, mockChat, savedChat } from './chat-helpers';
import { expect, test } from './test';

// The canvas (Phase 2): documents the model provides are cards in the reply that open in the side panel,
// with the open document in the address (CNV-7, NAV-3).

const PAGE = '<!doctype html><title>Hello page</title><h1 id="x">Hello artifact</h1>';
const fence = (lang: string, code: string) => `\`\`\`${lang}\n${code}\n\`\`\``;

const convo = (content: string, extra: Record<string, unknown> = {}) => [
	savedChat('c1', 'Pages', [
		{ id: 'u1', role: 'user', content: 'Make a page' },
		{ id: 'a1', role: 'assistant', content, model: 'qwen', modelName: 'Qwen', done: true, ...extra }
	])
];

const canvas = (page: import('@playwright/test').Page) => page.getByRole('complementary', { name: 'Canvas' });

test('the open document is in the address: it restores on reload and follows Back and Forward', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await mockChat(page, { chats: convo(`Here:\n\n${fence('html', PAGE)}`) });
	await page.goto('/c/c1');
	await page.getByTestId('document-card').click();
	await expect(canvas(page)).toBeVisible();
	await expect(page).toHaveURL(/\?canvas=block%3Aa1%3A0$/);

	await page.reload();
	await expect(canvas(page)).toBeVisible();
	await expect(page.frameLocator('iframe[title="Preview of Hello page"]').locator('#x')).toHaveText('Hello artifact');

	await page.goBack();
	await expect(canvas(page)).toHaveCount(0);
	await expect(page).not.toHaveURL(/canvas=/);
	await page.goForward();
	await expect(canvas(page)).toBeVisible();
});

test('a document that is not in the chat says so, with a way out (NAV-3)', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await mockChat(page, { chats: convo('Nothing to open.') });
	await page.goto('/c/c1?canvas=00000000-0000-4000-8000-000000000000');
	await expect(canvas(page).getByText('This document is no longer in the chat')).toBeVisible();
	await canvas(page).getByRole('button', { name: 'Close the canvas' }).click();
	await expect(canvas(page)).toHaveCount(0);
	await expect(page).not.toHaveURL(/canvas=/);
});

test('beside the chat as a column at 1440 px, over it as a sheet at 390 px', async ({ page }) => {
	await mockChat(page, { chats: convo(fence('html', PAGE)) });
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/c/c1?canvas=block%3Aa1%3A0');
	await expect(canvas(page)).toBeVisible();
	// The chat stays beside it.
	await expect(page.getByTestId('response-message')).toBeVisible();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	// Half of the room beside the sidebar, to start with.
	const width = (await canvas(page).boundingBox())?.width ?? 0;
	expect(width).toBeGreaterThan(400);

	await page.setViewportSize({ width: 390, height: 844 });
	await expect(canvas(page)).toHaveCount(0);
	const sheet = page.getByRole('dialog', { name: /Hello page/ });
	await expect(sheet).toBeVisible();
	await expect.poll(async () => await sheet.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
	await expect(sheet.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
});

test("a fenced page's frame document starts with the content-security policy", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await mockChat(page, { chats: convo(fence('html', PAGE)) });
	await page.goto('/c/c1?canvas=block%3Aa1%3A0');
	const frame = canvas(page).locator('iframe');
	await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
	// After the doctype, the one place a policy <meta> is read, and before anything the model wrote.
	await expect(frame).toHaveAttribute(
		'srcdoc',
		/^<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; /
	);
	const srcdoc = (await frame.getAttribute('srcdoc')) ?? '';
	expect(srcdoc.indexOf('Content-Security-Policy')).toBeLessThan(srcdoc.indexOf('<title>'));
});

test('an uploaded page opens with its source and a download, never as a frame', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const fileId = '00000000-0000-4000-8000-0000000000f1';
	const raw: string[] = [];
	await mockChat(page, {
		chats: [
			savedChat('c1', 'Upload', [
				{
					id: 'u1',
					role: 'user',
					content: 'Look at this',
					files: [{ type: 'file', id: fileId, name: 'mine.html', size: 30 }]
				},
				{ id: 'a1', role: 'assistant', content: 'Seen.', model: 'qwen', modelName: 'Qwen', done: true }
			])
		]
	});
	await page.route('**/api/v1/files/*/content*', (route) => {
		raw.push(new URL(route.request().url()).pathname);
		return route.fulfill({ status: 200, contentType: 'text/html', body: '<p id="mine">uploaded markup</p>' });
	});
	await page.route('**/api/v1/sandbox/outputs/*/html', (route) => json(route, { html: '<p>never asked</p>' }));
	await page.goto('/c/c1');
	await page.getByRole('button', { name: 'Open mine.html' }).click();
	await expect(canvas(page)).toBeVisible();
	await expect(canvas(page)).toContainText('uploaded markup');
	await expect(canvas(page).locator('iframe')).toHaveCount(0);
	await expect(canvas(page).getByRole('button', { name: 'Preview' })).toHaveCount(0);
	// Download is in the menu beside Copy.
	await canvas(page).getByRole('button', { name: 'Copy' }).click();
	await expect(page.getByRole('menuitem', { name: 'Download' })).toHaveAttribute(
		'href',
		`/api/v1/files/${fileId}/content?attachment=true`
	);
	await page.keyboard.press('Escape');
	await canvas(page).getByRole('button', { name: 'Close canvas' }).click();
	await expect(page.getByRole('button', { name: 'Open mine.html' })).toBeFocused();
});

test('a page still being written is a card that says so; Preview comes with the closing fence', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const chat = await mockChat(page);
	await page.goto('/');
	await chat.socket.connected;
	const box = page.getByRole('textbox', { name: 'Message' });
	await box.fill('Make a page');
	await box.press('Enter');
	await expect.poll(() => chat.seen.completions.length).toBe(1);
	const delta = (content: string) => chat.event('chat:completion', { choices: [{ delta: { content } }] });
	delta('Here:\n\n```html\n<!doctype html>\n<title>Live page</title>\n');
	delta('<p id="p">hello</p>\n');

	const card = page.getByTestId('document-card');
	await expect(card).toContainText('Writing…');
	await card.click();
	// Its source fills in; Preview is not there to press yet.
	await expect(canvas(page)).toBeVisible();
	await expect(canvas(page).getByRole('button', { name: 'Preview' })).toBeDisabled();
	await expect(canvas(page)).toContainText('hello');
	await expect(canvas(page).locator('iframe')).toHaveCount(0);

	delta('```');
	chat.event('chat:completion', { done: true });
	await expect(card).not.toContainText('Writing…');
	await expect(canvas(page).getByRole('button', { name: 'Preview' })).toBeEnabled();
	await expect(page.frameLocator('iframe[title="Preview of Live page"]').locator('#p')).toHaveText('hello');
});

test('a long block of other code stays a code block and opens in the canvas as source', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const code = Array.from({ length: 20 }, (_, i) => `x${i} = ${i}`).join('\n');
	await mockChat(page, { chats: convo(fence('python', code)) });
	await page.goto('/c/c1');
	await expect(page.getByTestId('document-card')).toHaveCount(0);
	const open = page.getByTestId('code-block').getByRole('button', { name: 'Open in canvas' });
	await open.click();
	await expect(page).toHaveURL(/\?canvas=block%3Aa1%3A0$/);
	await expect(canvas(page)).toContainText('x19 = 19');
	// Source only: there is no view to switch to.
	await expect(canvas(page).getByRole('button', { name: 'Preview' })).toHaveCount(0);
	await canvas(page).getByRole('button', { name: 'Close canvas' }).click();
	await expect(open).toBeFocused();
});

test('a reply that finishes with one document opens it by itself on a wide window, not on a narrow one', async ({
	page
}) => {
	const send = async () => {
		const chat = await mockChat(page);
		await page.goto('/');
		await chat.socket.connected;
		const box = page.getByRole('textbox', { name: 'Message' });
		await box.fill('Make a page');
		await box.press('Enter');
		await expect.poll(() => chat.seen.completions.length).toBe(1);
		await chat.stream(`Here:\n\n${fence('html', PAGE)}`);
		await expect(page.getByTestId('document-card')).toContainText('Hello page');
		return box;
	};

	await page.setViewportSize({ width: 1440, height: 900 });
	const box = await send();
	await expect(canvas(page)).toBeVisible();
	await expect(page).toHaveURL(/\/c\/new1\?canvas=block%3Aa2%3A0$|\/c\/new1\?canvas=block%3A[^&]+%3A0$/);
	// The person typing the next message keeps focus.
	await expect(box).toBeFocused();
});

test('on a narrow window a reply with one document does not cover the chat', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const chat = await mockChat(page);
	await page.goto('/');
	await chat.socket.connected;
	const box = page.getByRole('textbox', { name: 'Message' });
	await box.fill('Make a page');
	await box.press('Enter');
	await expect.poll(() => chat.seen.completions.length).toBe(1);
	await chat.stream(`Here:\n\n${fence('html', PAGE)}`);
	await expect(page.getByTestId('document-card')).toContainText('Hello page');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page).not.toHaveURL(/canvas=/);
});
