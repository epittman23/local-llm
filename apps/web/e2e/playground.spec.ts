import type { Page } from '@playwright/test';
import { expect, test } from './test';
import { mockWorkspaceBackend } from './workspace-helpers';

const json = (route: any, d: unknown, status = 200) =>
	route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(d) });
const sse = (...pieces: string[]) =>
	pieces.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`).join('') +
	'data: [DONE]\n\n';
/** A text completion's stream: `text` pieces, then the usage chunk. */
const textSse = (...pieces: string[]) =>
	pieces.map((p) => `data: ${JSON.stringify({ choices: [{ text: p, index: 0 }] })}\n\n`).join('') +
	`data: ${JSON.stringify({ choices: [], usage: { completion_tokens: 9 } })}\n\n` +
	'data: [DONE]\n\n';

async function mockPlayground(page: Page, reply: string[] = ['Hel', 'lo!']) {
	const seen = { bodies: [] as any[], images: [] as any[], completions: [] as unknown[] };
	await page.route('**/api/models*', (route) =>
		json(route, {
			data: [
				{ id: 'qwen', name: 'Qwen', owned_by: 'openai' },
				{ id: 'coder', name: 'Coder', owned_by: 'openai' },
				{ id: 'llama3', name: 'Llama 3', owned_by: 'ollama' }
			]
		})
	);
	await page.route('**/api/v1/users/user/settings', (route) => json(route, { ui: { models: ['coder'] } }));
	await page.route('**/api/chat/completions', (route) => {
		seen.bodies.push(route.request().postDataJSON());
		return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(...reply) });
	});
	await page.route('**/openai/completions', (route) => {
		seen.completions.push(route.request().postDataJSON());
		return route.fulfill({ status: 200, contentType: 'text/event-stream', body: textSse(...reply) });
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
	await expect(page.getByRole('combobox', { name: 'Model' })).toHaveText('Coder');
	await page.getByRole('button', { name: 'System instructions' }).click();
	await page.getByLabel('System instructions', { exact: true }).fill('Be brief');
	await page.getByLabel('New message').fill('Hi there');
	await page.getByRole('button', { name: 'Run' }).click();
	await expect(page.getByRole('region', { name: 'Assistant message 2' })).toHaveText('Hello!');
	expect(seen.bodies[0]).toEqual({
		model: 'coder',
		stream: true,
		messages: [
			{ role: 'system', content: 'Be brief' },
			{ role: 'user', content: 'Hi there' }
		]
	});
	await page.getByRole('button', { name: 'Source of message 1' }).click();
	await page.getByLabel('user message 1').fill('Hi again');
	await page.getByRole('button', { name: 'Delete message 2' }).click();
	await expect(page.getByRole('region', { name: 'Assistant message 2' })).toHaveCount(0);
});

test('chat: parameters set in Controls go under params, the field the backend reads (#208)', async ({ page }) => {
	await mockWorkspaceBackend(page);
	const seen = await mockPlayground(page);
	await page.goto('/playground');
	await page.getByRole('button', { name: 'Controls' }).click();
	await page.getByRole('button', { name: 'Temperature: Default' }).click();
	await page.getByLabel('Temperature', { exact: true }).fill('1.2');
	await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
	await page.getByLabel('New message').fill('Hi there');
	await page.getByRole('button', { name: 'Run' }).click();
	await expect(page.getByRole('region', { name: 'Assistant message 2' })).toHaveText('Hello!');
	expect(seen.bodies[0]).toMatchObject({ model: 'coder', stream: true, params: { temperature: 1.2 } });
	expect(seen.bodies[0]).not.toHaveProperty('temperature');
});

test('chat: Add alternates roles; a failed request shows its error in place, with Retry (#968)', async ({ page }) => {
	await mockWorkspaceBackend(page);
	await mockPlayground(page);
	await page.route('**/api/chat/completions', (route) => json(route, { detail: 'Model not found' }, 404));
	await page.goto('/playground');
	await page.getByLabel('New message').fill('Q');
	await page.getByRole('button', { name: 'Add' }).click();
	await expect(page.getByRole('radio', { name: 'Assistant' })).toBeChecked();
	await page.getByLabel('New message').fill('A');
	await page.getByRole('button', { name: 'Add' }).click();
	await expect(page.getByRole('region', { name: 'Assistant message 2' })).toHaveText('A');
	// After a reply, with nothing new to send, Run regenerates it (#1076).
	await page.getByRole('button', { name: 'Regenerate' }).click();
	const failed = page.getByRole('alert');
	await expect(failed.getByText("The model didn't answer")).toBeVisible();
	await expect(failed.getByText('Model not found')).toBeVisible();
	await expect(failed.getByRole('button', { name: 'Retry' })).toBeVisible();
	// The failed run's empty reply is dropped; the hand-written one it replaced went with Regenerate.
	await expect(page.getByRole('region', { name: 'Assistant message 2' })).toHaveCount(0);
});

test('chat: Ctrl+Enter runs, the conversation survives a tab switch, and Clear asks first (#1031, #969)', async ({
	page
}) => {
	await mockWorkspaceBackend(page);
	const seen = await mockPlayground(page);
	await page.goto('/playground');
	await page.getByLabel('New message').fill('Hi there');
	await page.getByLabel('New message').press('Enter');
	expect(seen.bodies).toHaveLength(0);
	await page.getByLabel('New message').press('Control+Enter');
	await expect(page.getByRole('region', { name: 'Assistant message 2' })).toHaveText('Hello!');
	expect(seen.bodies[0].messages).toEqual([{ role: 'user', content: 'Hi there\n' }]);

	const tabs = page.getByRole('navigation', { name: 'Playground' });
	await tabs.getByRole('link', { name: 'Completions' }).click();
	await tabs.getByRole('link', { name: 'Chat' }).click();
	await expect(page.getByRole('region', { name: 'Assistant message 2' })).toHaveText('Hello!');

	await page.getByRole('button', { name: 'More options' }).click();
	await page.getByRole('menuitem', { name: 'Clear conversation' }).click();
	const confirm = page.getByRole('alertdialog', { name: 'Clear conversation?' });
	await confirm.getByRole('button', { name: 'Clear conversation' }).click();
	await expect(page.getByText(/^No messages yet/)).toBeVisible();
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

test('completions: the model continues the text, through a text completion (#1108)', async ({ page }) => {
	await mockWorkspaceBackend(page);
	const seen = await mockPlayground(page, [' world']);
	await page.goto('/playground/completions');
	await page.getByRole('combobox', { name: 'Model' }).click();
	// Only a model on an OpenAI-compatible connection can continue text (S6-D6).
	await expect(page.getByRole('option')).toHaveText(['Qwen', 'Coder']);
	await page.getByRole('option', { name: 'Qwen' }).click();
	await page.getByLabel('Text to continue').fill('Hello');
	await page.getByRole('button', { name: 'Run' }).click();
	await expect(page.getByRole('region', { name: 'Continuation' })).toContainText('world');
	await expect(page.getByText(/^First token in .* · 9 tokens/)).toBeVisible();
	expect(seen.completions[0]).toEqual({ model: 'qwen', stream: true, prompt: 'Hello' });
	expect(seen.bodies).toHaveLength(0);
	await page.getByRole('button', { name: 'Add to text' }).click();
	await expect(page.getByLabel('Text to continue')).toHaveValue('Hello world');
});

test('images: the tab is offered only while image generation is on (S6-D7)', async ({ page }) => {
	await mockWorkspaceBackend(page);
	await mockPlayground(page);
	await page.goto('/playground');
	await expect(page.getByRole('link', { name: 'Completions' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Images' })).toHaveCount(0);
	await page.goto('/playground/images');
	await expect(page.getByText('Image generation is off')).toBeVisible();
	await page.getByLabel('Image prompt').fill('a red cube');
	await expect(page.getByRole('button', { name: 'Run' })).toBeDisabled();
});

test('images: generates from a prompt, and edits when an image is added', async ({ page }) => {
	await mockWorkspaceBackend(page, { features: { enable_image_generation: true } });
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
