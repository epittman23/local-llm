import type { Page } from '@playwright/test';
import { json, mockChat } from './chat-helpers';
import { expect, test } from './test';

async function mockExtras(page: Page) {
	const seen = { uploads: 0, urls: [] as string[] };
	await page.route(/\/api\/v1\/files\/(\?|$)/, async (route) => {
		seen.uploads++;
		return json(route, { id: `file${seen.uploads}`, filename: 'report.pdf', meta: { content_type: 'application/pdf', collection_name: 'file-col' } });
	});
	await page.route(/\/api\/v1\/files\/[^/]+\/process\/status/, (route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"status":"completed"}\n\ndata: [DONE]\n\n' }));
	await page.route('**/api/v1/retrieval/process/url*', async (route) => {
		const body = route.request().postDataJSON();
		seen.urls.push(body.url);
		return json(route, { status: true, collection_name: 'web-col', name: 'Example page', content: 'page text', url: body.url });
	});
	await page.route('**/api/v1/prompts/', (route) => json(route, [{ command: 'summary', title: 'Summarize', content: 'Summarize this for {{USER_NAME}} in {{tone | select:options=["short","long"]}}' }]));
	await page.route(/\/api\/v1\/knowledge\/search/, (route) => json(route, { items: [{ id: 'kb1', name: 'Handbook', description: 'Company handbook' }], total: 1 }));
	await page.route(/\/api\/v1\/knowledge\/files\/search/, (route) => json(route, { items: [], total: 0 }));
	await page.route(/\/api\/v1\/tools\/(\?|$)/, (route) => json(route, [{ id: 'calc', name: 'Calculator' }]));
	return seen;
}

test('upload a document: it shows as attached and goes with the message', async ({ page }) => {
	const chat = await mockChat(page);
	const seen = await mockExtras(page);
	await page.goto('/');
	await chat.socket.connected;
	await page.getByLabel('Upload files').setInputFiles({ name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') });
	await expect(page.getByTestId('input-file')).toContainText('report.pdf');
	await expect(page.getByTestId('input-file').locator('.animate-spin')).toHaveCount(0);
	await page.getByRole('textbox', { name: 'Message' }).fill('Summarize the report');
	await page.keyboard.press('Enter');
	await expect.poll(() => chat.seen.completions.length).toBe(1);
	const body = chat.seen.completions[0];
	expect(body.user_message.files[0]).toMatchObject({ type: 'file', id: 'file1', name: 'report.pdf', status: 'uploaded' });
	expect(body.files).toEqual([expect.objectContaining({ id: 'file1' })]);
	expect(seen.uploads).toBe(1);
	await expect(page.getByTestId('input-file')).toHaveCount(0);
	await expect(page.getByTestId('user-message')).toContainText('report.pdf');
});

test('attach a web page from the menu, and one typed after #', async ({ page }) => {
	const chat = await mockChat(page);
	const seen = await mockExtras(page);
	await page.goto('/');
	await page.getByRole('button', { name: 'More' }).click();
	await page.getByRole('menuitem', { name: 'Attach Webpage' }).click();
	await page.getByLabel('Webpage URLs').fill('https://example.com/a');
	await page.getByRole('button', { name: 'Add' }).click();
	await expect(page.getByTestId('input-file')).toContainText('Example page');

	const box = page.getByRole('textbox', { name: 'Message' });
	await box.pressSequentially('#https://example.org/b');
	await page.getByRole('listbox', { name: 'Suggestions' }).getByRole('option', { name: /example\.org/ }).click();
	await expect(page.getByTestId('input-file')).toHaveCount(2);
	expect(seen.urls).toEqual(['https://example.com/a', 'https://example.org/b']);
	await expect(box).toHaveValue('');
	await box.fill('read these');
	await page.keyboard.press('Enter');
	await expect.poll(() => chat.seen.completions.length).toBe(1);
	expect(chat.seen.completions[0].files.map((f: any) => f.type)).toEqual(['text', 'text']);
});

test('# offers knowledge, / inserts a prompt and asks for its variables, @ picks a model for one message', async ({ page }) => {
	const chat = await mockChat(page);
	await mockExtras(page);
	await page.goto('/');
	await chat.socket.connected;
	const box = page.getByRole('textbox', { name: 'Message' });
	await box.pressSequentially('#hand');
	await page.getByRole('option', { name: /Handbook/ }).click();
	await expect(page.getByTestId('input-file')).toContainText('Handbook');

	await box.pressSequentially('/sum');
	// Enter picks the highlighted suggestion only once the prompt list has loaded;
	// pressing it sooner sends "/sum" as a message, which is also what a user would get.
	await expect(page.getByRole('option', { name: /Summarize/ })).toBeVisible();
	await page.keyboard.press('Enter');
	const dialog = page.getByRole('dialog', { name: 'Input Variables' });
	await dialog.getByLabel('tone').selectOption('short');
	await dialog.getByRole('button', { name: 'Save' }).click();
	await expect(box).toHaveValue('Summarize this for Test User in short');

	await page.keyboard.press('End');
	await box.pressSequentially(' @lla');
	await page.getByRole('option', { name: /Llama/ }).click();
	await expect(page.getByText('Talking to')).toContainText('Llama');
	await page.keyboard.press('Enter');
	await expect.poll(() => chat.seen.completions.length).toBe(1);
	const body = chat.seen.completions[0];
	expect(body.model).toBe('llama');
	expect(body.files).toEqual([expect.objectContaining({ id: 'kb1', type: 'collection' })]);
	expect(body.user_message.content.trim()).toBe('Summarize this for Test User in short');
});

test('tools and web search from the integrations menu go with the request', async ({ page }) => {
	const chat = await mockChat(page, { user: { role: 'admin', features: { enable_web_search: true } } });
	await mockExtras(page);
	await page.goto('/');
	await chat.socket.connected;
	await page.getByRole('button', { name: 'Integrations' }).click();
	await page.getByRole('switch', { name: 'Web Search' }).click();
	await page.getByRole('switch', { name: 'Calculator' }).click();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('button', { name: 'Web Search (on)' })).toBeVisible();
	await page.getByRole('textbox', { name: 'Message' }).fill('What is new?');
	await page.keyboard.press('Enter');
	await expect.poll(() => chat.seen.completions.length).toBe(1);
	expect(chat.seen.completions[0]).toMatchObject({ tool_ids: ['calc'], features: { web_search: true } });
});

test('a youtube link from /watch is attached to the new chat', async ({ page }) => {
	await mockChat(page);
	const seen = await mockExtras(page);
	await page.goto('/?youtube=dQw4w9WgXcQ');
	await expect(page.getByTestId('input-file')).toBeVisible();
	expect(seen.urls).toEqual(['https://www.youtube.com/watch?v=dQw4w9WgXcQ']);
});
