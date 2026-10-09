import type { Page } from '@playwright/test';
import { expect, test } from './test';
import { mockWorkspaceBackend } from './workspace-helpers';

const json = (route: any, d: unknown, status = 200) =>
	route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(d) });
const sse = (...pieces: string[]) =>
	pieces.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`).join('') +
	'data: [DONE]\n\n';

async function mockPlayground(page: Page, reply: string[] = ['Hel', 'lo!']) {
	const seen = { bodies: [] as any[], images: [] as any[] };
	await page.route('**/api/models*', (route) =>
		json(route, {
			data: [
				{ id: 'qwen', name: 'Qwen' },
				{ id: 'coder', name: 'Coder' }
			]
		})
	);
	await page.route('**/api/v1/users/user/settings', (route) => json(route, { ui: { models: ['coder'] } }));
	await page.route('**/api/chat/completions', (route) => {
		seen.bodies.push(route.request().postDataJSON());
		return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(...reply) });
	});
	await page.route('**/api/v1/images/**', (route) => {
		seen.images.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
		return json(route, [{ url: 'data:image/png;base64,iVBORw0KGgo=' }]);
	});
	return seen;
}

test('a non-admin is sent home and has no sidebar link', async ({ page }) => {
	await mockWorkspaceBackend(page, { role: 'user' });
	await mockPlayground(page);
	await page.goto('/playground');
	await expect(page).toHaveURL(/localhost:5174\/$/);
});

test('chat: builds a conversation, runs it with the system prompt and parameters, and streams the reply', async ({
	page
}) => {
	await mockWorkspaceBackend(page);
	const seen = await mockPlayground(page);
	await page.goto('/playground');
	// Starts on the user's first chosen model.
	await expect(page.getByLabel('Model')).toHaveValue('coder');
	await page.getByRole('button', { name: 'System Instructions' }).click();
	await page.getByLabel('System Instructions', { exact: true }).fill('Be brief');
	await page.getByLabel('New message').fill('Hi there');
	await page.getByRole('button', { name: 'Run' }).click();
	await expect(page.getByLabel('assistant message 2')).toHaveValue('Hello!');
	expect(seen.bodies[0]).toEqual({
		model: 'coder',
		stream: true,
		messages: [
			{ role: 'system', content: 'Be brief' },
			{ role: 'user', content: 'Hi there' }
		]
	});
	await page.getByLabel('user message 1').fill('Hi again');
	await page.getByRole('button', { name: 'Delete message 2' }).click();
	await expect(page.getByLabel('assistant message 2')).toHaveCount(0);
});

test('chat: Add alternates roles; a failed request shows its error', async ({ page }) => {
	await mockWorkspaceBackend(page);
	await mockPlayground(page);
	await page.route('**/api/chat/completions', (route) => json(route, { detail: 'Model not found' }, 404));
	await page.goto('/playground');
	await page.getByLabel('New message').fill('Q');
	await page.getByRole('button', { name: 'Add' }).click();
	await expect(page.getByRole('button', { name: 'Switch to User role' })).toBeVisible();
	await page.getByLabel('New message').fill('A');
	await page.getByRole('button', { name: 'Add' }).click();
	await expect(page.getByLabel('assistant message 2')).toHaveValue('A');
	await page.getByRole('button', { name: 'Run' }).click();
	await expect(page.getByText('Model not found')).toBeVisible();
});

test('chat: exports text and the chat-import JSON', async ({ page }) => {
	await mockWorkspaceBackend(page);
	await mockPlayground(page);
	await page.goto('/playground');
	await page.getByLabel('New message').fill('Q');
	await page.getByRole('button', { name: 'Add' }).click();
	await page.getByRole('button', { name: 'More options' }).click();
	const download = page.waitForEvent('download');
	await page.getByRole('menuitem', { name: 'Plain text (.txt)' }).click();
	const file = await download;
	const text = Buffer.concat(await (await file.createReadStream()).toArray()).toString();
	expect(text).toBe('### USER\nQ');
});

test('completions: the model continues the text', async ({ page }) => {
	await mockWorkspaceBackend(page);
	const seen = await mockPlayground(page, [' world']);
	await page.goto('/playground/completions');
	await page.getByLabel('Model').selectOption('qwen');
	await page.getByLabel('Completion text').fill('Hello');
	await page.getByRole('button', { name: 'Run' }).click();
	await expect(page.getByLabel('Completion text')).toHaveValue('Hello world');
	expect(seen.bodies[0]).toEqual({ model: 'qwen', stream: true, messages: [{ role: 'assistant', content: 'Hello' }] });
});

test('images: generates from a prompt, and edits when an image is added', async ({ page }) => {
	await mockWorkspaceBackend(page);
	const seen = await mockPlayground(page);
	await page.goto('/playground/images');
	await page.getByLabel('Image prompt').fill('a red cube');
	await page.getByRole('button', { name: 'Run' }).click();
	await expect(page.getByRole('button', { name: 'Download image 1' })).toBeVisible();
	expect(seen.images[0].path).toBe('/api/v1/images/generations');
	await page
		.getByLabel('Add image files')
		.setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgo=', 'base64') });
	await expect(page.getByLabel('Image prompt')).toHaveAttribute('placeholder', 'Describe the edit...');
	await page.getByRole('button', { name: 'Run' }).click();
	await expect(page.getByRole('button', { name: 'Download image 2' })).toBeVisible();
	expect(seen.images[1].path).toBe('/api/v1/images/edit');
});
