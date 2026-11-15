import { json, mockChat, savedChat } from './chat-helpers';
import { expect, test } from './test';

const convo = () => [
	savedChat('c1', 'Chat', [
		{ id: 'u1', role: 'user', content: 'What is 2+2?' },
		{ id: 'a1', role: 'assistant', content: 'It is 4', model: 'qwen', modelName: 'Qwen', done: true }
	])
];

test('edit a prompt and send it again as a new version', async ({ page }) => {
	const chat = await mockChat(page, { chats: convo() });
	await page.goto('/c/c1');
	await chat.socket.connected;
	const prompt = page.getByTestId('user-message');
	await prompt.hover();
	await prompt.getByRole('button', { name: 'Edit' }).click();
	await page.getByRole('textbox', { name: 'Edit message' }).fill('What is 3+3?');
	await page.getByTestId('message-editor').getByRole('button', { name: 'Send' }).click();
	await expect.poll(() => chat.seen.completions.length).toBe(1);
	expect(chat.seen.completions[0].user_message).toMatchObject({ content: 'What is 3+3?', parentId: null });
	await chat.stream('It is 6');
	await expect(page.getByTestId('response-message')).toContainText('It is 6');
	await expect(prompt.getByLabel('Versions')).toContainText('2/2');
});

test('edit a reply in place, or save it as a copy', async ({ page }) => {
	const chat = await mockChat(page, { chats: convo() });
	await page.goto('/c/c1');
	const reply = page.getByTestId('response-message');
	// A reply's Edit is in its More actions menu (#995).
	await reply.getByRole('button', { name: 'More actions' }).click();
	await page.getByRole('menuitem', { name: 'Edit' }).click();
	await page.getByRole('textbox', { name: 'Edit message' }).fill('Four.');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(reply).toContainText('Four.');
	await expect
		.poll(() => chat.seen.updates.at(-1)?.chat.history.messages.a1)
		.toMatchObject({ content: 'Four.', originalContent: 'It is 4' });

	await reply.getByRole('button', { name: 'More actions' }).click();
	await page.getByRole('menuitem', { name: 'Edit' }).click();
	await page.getByRole('textbox', { name: 'Edit message' }).fill('4 (copy)');
	await page.getByRole('button', { name: 'Save as copy' }).click();
	await expect(reply).toContainText('4 (copy)');
	await expect(reply.getByLabel('Versions')).toContainText('2/2');
});

test('a thumb saves the rating at once, and a note is added on its own (S3-D2)', async ({ page }) => {
	const chat = await mockChat(page, { chats: convo() });
	await page.goto('/c/c1');
	await page.getByRole('button', { name: 'Good response' }).click();
	await expect.poll(() => chat.seen.feedback.length).toBeGreaterThan(0);
	expect(chat.seen.feedback[0]).toMatchObject({
		type: 'rating',
		data: { rating: 1, model_id: 'qwen' },
		meta: { chat_id: 'c1', message_id: 'a1' }
	});
	await expect(page.getByRole('button', { name: 'Rated good' })).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByTestId('rate-note')).toHaveCount(0);
	await page.getByRole('button', { name: 'Add a note' }).click();
	const note = page.getByTestId('rate-note');
	await expect(note.getByRole('button', { name: /out of 10/ })).toHaveCount(0);
	await note.getByRole('textbox', { name: 'Note on your rating' }).fill('Clear');
	await note.getByRole('button', { name: 'Save note' }).click();
	await expect
		.poll(() => chat.seen.feedback.some((f) => f.data?.comment === 'Clear' && f.data?.rating === 1))
		.toBe(true);
	expect(chat.seen.feedback.at(-1)!.url).toMatch(/feedback\/fb1$/);
});

test('continue a reply and regenerate with a suggestion', async ({ page }) => {
	const chat = await mockChat(page, { chats: convo() });
	await page.goto('/c/c1');
	await chat.socket.connected;
	await page.getByRole('button', { name: 'More actions' }).click();
	await page.getByRole('menuitem', { name: 'Continue' }).click();
	await expect.poll(() => chat.seen.completions.length).toBe(1);
	expect(chat.seen.completions[0]).toMatchObject({ id: 'a1', assistant_message_id: 'a1', chat_id: 'c1' });
	await chat.stream(' exactly.');
	await expect(page.getByTestId('response-message')).toContainText('It is 4 exactly.');

	await page.getByRole('button', { name: 'Regenerate options' }).click();
	await page.getByRole('menuitem', { name: 'More concise' }).click();
	await expect.poll(() => chat.seen.completions.length).toBe(2);
	expect(chat.seen.completions[1].regeneration_prompt).toBe('More Concise');
});

test('delete a reply', async ({ page }) => {
	const chat = await mockChat(page, { chats: convo() });
	await page.goto('/c/c1');
	await page.getByTestId('response-message').getByRole('button', { name: 'More actions' }).click();
	await page.getByRole('menuitem', { name: 'Delete' }).click();
	await page
		.getByRole('alertdialog', { name: 'Delete message?' })
		.getByRole('button', { name: 'Delete message' })
		.click();
	await expect(page.getByTestId('response-message')).toHaveCount(0);
	expect(chat.seen.deletedMessages).toEqual(['a1']);
});

test('a user without the permissions sees no edit, rate or delete on replies', async ({ page }) => {
	await mockChat(page, { chats: convo(), user: { config: {} } });
	await page.route('**/api/v1/auths/', (route) =>
		route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify({
				id: 'u1',
				name: 'U',
				email: 'u@x',
				role: 'user',
				permissions: { chat: { edit: false, rate_response: false, delete_message: false } },
				expires_at: Math.floor(Date.now() / 1000) + 3600
			})
		})
	);
	await page.goto('/c/c1');
	const reply = page.getByTestId('response-message');
	await expect(reply.getByRole('button', { name: 'Copy' })).toBeVisible();
	await expect(reply.getByRole('button', { name: 'Good response' })).toHaveCount(0);
	await reply.getByRole('button', { name: 'More actions' }).click();
	await expect(page.getByRole('menuitem', { name: 'Read aloud' })).toBeVisible();
	await expect(page.getByRole('menuitem', { name: 'Edit' })).toHaveCount(0);
	await expect(page.getByRole('menuitem', { name: 'Delete' })).toHaveCount(0);
});

test("a model's Action runs on its reply, and the messages it returns replace theirs", async ({ page }) => {
	const chat = await mockChat(page, {
		user: { role: 'admin' },
		chats: [
			savedChat('c1', 'Actions', [
				{ id: 'u', role: 'user', content: 'Hi' },
				{ id: 'a', role: 'assistant', model: 'qwen', content: 'Hello', done: true }
			])
		]
	});
	await page.route('**/api/models*', (route) =>
		json(route, {
			data: [
				{ id: 'qwen', name: 'Qwen', actions: [{ id: 'summarize.run', name: 'Summarize', icon: null }] },
				{ id: 'llama', name: 'Llama' }
			]
		})
	);
	const calls: { url: string; body: Record<string, any> }[] = [];
	await page.route('**/api/chat/actions/**', (route) => {
		calls.push({ url: route.request().url(), body: route.request().postDataJSON() });
		return json(route, { messages: [{ id: 'a', content: 'Hello, summarized' }] });
	});
	await page.goto('/c/c1');
	await chat.socket.connected;
	await page.getByRole('button', { name: 'More actions' }).click();
	await page.getByRole('menuitem', { name: 'Summarize' }).click();
	await expect.poll(() => calls.length).toBe(1);
	expect(calls[0].url).toContain('/api/chat/actions/summarize.run');
	expect(calls[0].body).toMatchObject({
		model: 'qwen',
		chat_id: 'c1',
		id: 'a',
		model_item: { id: 'qwen' },
		messages: [
			{ id: 'u', role: 'user', content: 'Hi' },
			{ id: 'a', role: 'assistant', content: 'Hello' }
		]
	});
	await expect(page.getByText('Hello, summarized')).toBeVisible();
	await expect
		.poll(() => chat.seen.updates.at(-1)?.chat?.history?.messages?.a)
		.toMatchObject({ content: 'Hello, summarized', originalContent: 'Hello' });
});

test('a failed reply says the model did not answer and retries by name (#992)', async ({ page }) => {
	const chat = await mockChat(page, {
		chats: [
			savedChat('c1', 'Chat', [
				{ id: 'u1', role: 'user', content: 'Q' },
				{
					id: 'a1',
					role: 'assistant',
					content: '',
					model: 'qwen',
					done: true,
					error: { content: 'Error 401: Unauthorized' }
				}
			])
		]
	});
	await page.goto('/c/c1');
	await chat.socket.connected;
	const alert = page.getByTestId('response-message').getByRole('alert');
	await expect(alert).toContainText("The model didn't answer");
	await expect(alert).toContainText('Check the API key in Admin Settings > Connections.');
	await expect(page.getByTestId('response-message').getByRole('button', { name: 'Copy' })).toHaveCount(0);
	await alert.getByRole('button', { name: 'Retry' }).click();
	await expect.poll(() => chat.seen.completions.length).toBe(1);
});

test('a stopped reply says so after a reload, and continues by name (#1081)', async ({ page }) => {
	const chat = await mockChat(page, {
		chats: [
			savedChat('c1', 'Chat', [
				{ id: 'u1', role: 'user', content: 'Q' },
				{ id: 'a1', role: 'assistant', content: 'It is', model: 'qwen', done: true, stopped: true }
			])
		]
	});
	await page.goto('/c/c1');
	await chat.socket.connected;
	const line = page.getByTestId('cut-off');
	await expect(line).toContainText('Stopped');
	await line.getByRole('button', { name: 'Continue' }).click();
	await expect.poll(() => chat.seen.completions.length).toBe(1);
	expect(chat.seen.completions[0]).toMatchObject({ id: 'a1', assistant_message_id: 'a1' });
	await chat.stream(' 4.');
	await expect(page.getByTestId('response-message')).toContainText('It is 4.');
	await expect(page.getByTestId('cut-off')).toHaveCount(0);
});

test('generation info opens by click and shows tokens in words (#994)', async ({ page }) => {
	await mockChat(page, {
		chats: [
			savedChat('c1', 'Chat', [
				{ id: 'u1', role: 'user', content: 'Q' },
				{
					id: 'a1',
					role: 'assistant',
					content: 'A',
					model: 'qwen',
					done: true,
					usage: {
						prompt_tokens: 42,
						completion_tokens: 255,
						input_tokens: 42,
						output_tokens: 255,
						predicted_per_second: 31.2
					}
				}
			])
		]
	});
	await page.goto('/c/c1');
	await page.getByRole('button', { name: 'Generation info' }).click();
	const info = page.getByRole('dialog');
	await expect(info).toContainText('42 prompt + 255 completion');
	await expect(info).toContainText('31.2 tokens/s');
	await expect(info).not.toContainText('input_tokens');
});
