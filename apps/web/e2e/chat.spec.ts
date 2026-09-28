import { expect, test } from './test';
import { json, mockChat, savedChat } from './chat-helpers';

test('a new chat: greeting and suggestions, send, stream, and the URL becomes the saved chat', async ({ page }) => {
	const chat = await mockChat(page);
	await page.goto('/');
	await chat.socket.connected;
	await expect(page.getByRole('heading', { name: 'Qwen' })).toBeVisible();
	await expect(page.getByText('fast', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: /Tell me/ })).toBeVisible();

	const box = page.getByRole('textbox', { name: 'Message' });
	await box.fill('Hello there');
	await box.press('Enter');
	await expect.poll(() => chat.seen.completions.length).toBe(1);
	const body = chat.seen.completions[0];
	expect('chat_id' in body).toBe(false);
	expect(body).toMatchObject({ model: 'qwen', stream: true, user_message: { role: 'user', content: 'Hello there' }, background_tasks: { title_generation: true } });
	expect(body.session_id).toBeTruthy();
	await expect(page.getByTestId('user-message')).toContainText('Hello there');
	await expect(page).toHaveURL(/\/c\/new1$/);
	await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();

	await chat.stream('Hi! **How** can I help?');
	const reply = page.getByTestId('response-message');
	await expect(reply).toContainText('Hi! How can I help?');
	await expect(reply.locator('strong')).toHaveText('How');
	await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
	// The chat was not reloaded when its URL changed.
	await expect(page.getByTestId('user-message')).toHaveCount(1);

	chat.event('chat:title', 'Greetings');
	await expect(page).toHaveTitle(/^Greetings/);
});

test('a follow-up in a saved chat sends its id and no title request; stop ends the reply', async ({ page }) => {
	const chat = await mockChat(page, { chats: [savedChat('c1', 'Old chat', [{ id: 'u1', role: 'user', content: 'First question' }, { id: 'a1', role: 'assistant', content: 'First answer', model: 'qwen', done: true }])] });
	await page.goto('/c/c1');
	await chat.socket.connected;
	await expect(page.getByTestId('response-message')).toContainText('First answer');
	await page.getByRole('textbox', { name: 'Message' }).fill('Second');
	await page.keyboard.press('Enter');
	await expect.poll(() => chat.seen.completions.length).toBe(1);
	expect(chat.seen.completions[0]).toMatchObject({ chat_id: 'c1', parent_id: 'a1', background_tasks: { follow_up_generation: true } });
	expect(chat.seen.completions[0].background_tasks.title_generation).toBeUndefined();
	await page.getByRole('button', { name: 'Stop' }).click();
	await expect.poll(() => chat.seen.stops.some((u) => u.includes('/api/tasks/chat/c1/stop'))).toBe(true);
	await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
});

test('regenerate makes a second version, and the arrows move between them', async ({ page }) => {
	const chat = await mockChat(page, { chats: [savedChat('c1', 'Chat', [{ id: 'u1', role: 'user', content: 'Q' }, { id: 'a1', role: 'assistant', content: 'Version one', model: 'qwen', done: true }])] });
	await page.goto('/c/c1');
	await chat.socket.connected;
	await page.getByRole('button', { name: 'Regenerate', exact: true }).click();
	await expect.poll(() => chat.seen.completions.length).toBe(1);
	await chat.stream('Version two');
	await expect(page.getByTestId('response-message')).toContainText('Version two');
	await expect(page.getByLabel('Versions')).toContainText('2/2');
	await page.getByRole('button', { name: 'Previous version' }).click();
	await expect(page.getByTestId('response-message')).toContainText('Version one');
	await expect.poll(() => chat.seen.updates.length).toBeGreaterThan(0);
});

test('an error from the model shows on the reply', async ({ page }) => {
	const chat = await mockChat(page);
	await page.goto('/');
	await chat.socket.connected;
	await page.getByRole('textbox', { name: 'Message' }).fill('x');
	await page.keyboard.press('Enter');
	await expect.poll(() => chat.seen.completions.length).toBe(1);
	chat.event('chat:completion', { error: { detail: 'Model is overloaded' } });
	await expect(page.getByRole('alert').filter({ hasText: 'Model is overloaded' })).toBeVisible();
});

test('status, sources and follow-ups arrive with the reply', async ({ page }) => {
	const chat = await mockChat(page);
	await page.goto('/');
	await chat.socket.connected;
	await page.getByRole('textbox', { name: 'Message' }).fill('search it');
	await page.keyboard.press('Enter');
	await expect.poll(() => chat.seen.completions.length).toBe(1);
	chat.event('status', { description: 'Searching the web', done: false });
	await expect(page.getByText('Searching the web')).toBeVisible();
	chat.event('source', { source: { name: 'Example', url: 'https://example.com/a' }, document: ['text'] });
	await chat.stream('It is 42 [1].');
	await expect(page.getByRole('button', { name: 'View source: Example' })).toBeVisible();
	await page.getByRole('button', { name: '1 Source' }).click();
	await page.getByLabel('Sources').getByRole('button', { name: /Example/ }).click();
	await expect(page.getByRole('dialog', { name: 'Citation' })).toContainText('text');
	await page.keyboard.press('Escape');
	chat.event('chat:message:follow_ups', { follow_ups: ['Why 42?'] });
	await page.getByRole('button', { name: 'Why 42?' }).click();
	await expect.poll(() => chat.seen.completions.length).toBe(2);
	expect(chat.seen.completions[1].user_message.content).toBe('Why 42?');
});

test('two models answer side by side', async ({ page }) => {
	const chat = await mockChat(page);
	await page.goto('/');
	await chat.socket.connected;
	await page.getByRole('button', { name: 'Add Model' }).click();
	await page.getByRole('button', { name: 'Select a model' }).nth(1).click();
	await page.getByRole('option', { name: 'Llama' }).click();
	await page.getByRole('textbox', { name: 'Message' }).fill('Compare');
	await page.keyboard.press('Enter');
	await expect.poll(() => chat.seen.completions.length).toBe(1);
	const body = chat.seen.completions[0];
	expect(body.message_ids.map((m: any) => [m.model_id, m.modelIdx])).toEqual([['qwen', 0], ['llama', 1]]);
	for (const [i, t] of body.message_ids.entries()) {
		chat.socket.emit('events', { chat_id: 'new1', message_id: t.message_id, data: { type: 'chat:completion', data: { choices: [{ delta: { content: `Answer ${i}` } }], done: true } } });
	}
	const cols = page.getByTestId('multi-response').getByTestId('response-message');
	await expect(cols).toHaveCount(2);
	await expect(cols.nth(1)).toContainText('Answer 1');
});

test('a message sent while replying is queued and goes when the reply ends', async ({ page }) => {
	const chat = await mockChat(page);
	await page.goto('/');
	await chat.socket.connected;
	const box = page.getByRole('textbox', { name: 'Message' });
	await box.fill('one');
	await box.press('Enter');
	await expect.poll(() => chat.seen.completions.length).toBe(1);
	await box.fill('two');
	await box.press('Enter');
	await expect(page.getByLabel('Queued messages')).toContainText('two');
	await chat.stream('done');
	await expect.poll(() => chat.seen.completions.length).toBe(2);
	expect(chat.seen.completions[1].user_message.content).toBe('two');
});

test('a server confirmation is answered through the socket', async ({ page }) => {
	const chat = await mockChat(page);
	await page.goto('/');
	await chat.socket.connected;
	await page.getByRole('textbox', { name: 'Message' }).fill('do it');
	await page.keyboard.press('Enter');
	await expect.poll(() => chat.seen.completions.length).toBe(1);
	const body = chat.seen.completions[0];
	const answer = chat.socket.emitWithAck('events', { chat_id: 'new1', message_id: body.id, data: { type: 'confirmation', data: { title: 'Run tool?', message: 'It will send an email.' } } });
	await expect(page.getByRole('dialog', { name: 'Run tool?' })).toBeVisible();
	await page.getByRole('button', { name: 'Confirm' }).click();
	expect(await answer).toBe(true);
});

test('a missing chat sends you home', async ({ page }) => {
	await mockChat(page);
	await page.goto('/c/nope');
	await expect(page).toHaveURL(/localhost:5174\/$/);
});

test('a temporary chat sends the whole conversation and asks for no title', async ({ page }) => {
	const chat = await mockChat(page, { user: { role: 'admin' } });
	await page.route('**/api/chat/completions', async (route) => {
		chat.seen.completions.push(route.request().postDataJSON());
		return json(route, { status: true, task_id: 't1' });
	});
	await page.goto('/');
	await chat.socket.connected;
	await page.getByRole('button', { name: 'Temporary Chat' }).click();
	await expect(page.getByText(/won't appear in history/)).toBeVisible();
	await page.getByRole('textbox', { name: 'Message' }).fill('secret');
	await page.keyboard.press('Enter');
	await expect.poll(() => chat.seen.completions.length).toBe(1);
	expect(chat.seen.completions[0].chat_id).toMatch(/^temporary:/);
	expect(chat.seen.completions[0].messages).toEqual([{ role: 'user', content: 'secret' }]);
	await expect(page).toHaveURL(/localhost:5174\/$/);
});

// docs/bug-review-2026-09-27.md H2: switching chats in place (no reload) used
// to keep the first chat's models, so the next message went to the wrong one.
test('switching to another saved chat uses that chat\'s own models', async ({ page }) => {
	await page.context().addInitScript(() => window.localStorage.setItem('sidebar', 'true'));
	const llama = savedChat('c2', 'Llama chat', [{ id: 'u2', role: 'user', content: 'Q2' }, { id: 'a2', role: 'assistant', content: 'From llama', model: 'llama', done: true }]);
	llama.chat.models = ['llama'];
	const chat = await mockChat(page, {
		chats: [savedChat('c1', 'Qwen chat', [{ id: 'u1', role: 'user', content: 'Q1' }, { id: 'a1', role: 'assistant', content: 'From qwen', model: 'qwen', done: true }]), llama]
	});
	await page.goto('/c/c1');
	await chat.socket.connected;
	await expect(page.getByTestId('response-message')).toContainText('From qwen');

	await page.getByTestId('chat-item').filter({ hasText: 'Llama chat' }).getByRole('link').click();
	await expect(page).toHaveURL(/\/c\/c2$/);
	await expect(page.getByTestId('response-message')).toContainText('From llama');

	await page.getByRole('textbox', { name: 'Message' }).fill('Next');
	await page.keyboard.press('Enter');
	await expect.poll(() => chat.seen.completions.length).toBe(1);
	expect(chat.seen.completions[0]).toMatchObject({ chat_id: 'c2', model: 'llama' });
});

test('the message box waits while a chat loads, so nothing is sent onto the previous one', async ({ page }) => {
	const chat = await mockChat(page, { chats: [savedChat('c1', 'Slow', [{ id: 'u', role: 'user', content: 'Hi' }, { id: 'a', role: 'assistant', model: 'qwen', content: 'Hello there', done: true }])] });
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	await page.route('**/api/v1/chats/c1', async (route) => {
		await gate;
		return route.fallback();
	});
	await page.goto('/c/c1');
	await chat.socket.connected;
	const box = page.getByRole('textbox', { name: 'Message' });
	await expect(box).toBeDisabled();
	release();
	await expect(page.getByText('Hello there')).toBeVisible();
	await expect(box).toBeEnabled();
});

test('a dropped connection is announced, and so is getting it back', async ({ page }) => {
	const chat = await mockChat(page);
	await page.goto('/');
	await chat.socket.connected;
	chat.socket.drop();
	await expect(page.getByText('Connection lost. Reconnecting...')).toBeVisible({ timeout: 10_000 });
	chat.socket.restore();
	await expect(page.getByText('Reconnected')).toBeVisible({ timeout: 15_000 });
});

test('a request refused because the session expired signs out and says so', async ({ page }) => {
	const chat = await mockChat(page);
	let expired = false;
	await page.route('**/api/v1/auths/', (route) => (expired ? route.fulfill({ status: 401, contentType: 'application/json', body: '{"detail":"Not authenticated"}' }) : route.fallback()));
	await page.route('**/api/chat/completions', (route) => {
		expired = true;
		return route.fulfill({ status: 401, contentType: 'application/json', body: '{"detail":"Not authenticated"}' });
	});
	await page.goto('/');
	await chat.socket.connected;
	await page.getByRole('textbox', { name: 'Message' }).fill('Hi');
	await page.keyboard.press('Enter');
	await expect(page.getByText('Session expired. Please sign in again.')).toBeVisible();
	await expect(page).toHaveURL(/\/auth\?redirect=/);
});
