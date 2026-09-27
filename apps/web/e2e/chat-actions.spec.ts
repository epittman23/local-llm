import { mockChat, savedChat } from './chat-helpers';
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
	await reply.getByRole('button', { name: 'Edit' }).click();
	await page.getByRole('textbox', { name: 'Edit message' }).fill('Four.');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(reply).toContainText('Four.');
	await expect.poll(() => chat.seen.updates.at(-1)?.chat.history.messages.a1).toMatchObject({ content: 'Four.', originalContent: 'It is 4' });

	await reply.getByRole('button', { name: 'Edit' }).click();
	await page.getByRole('textbox', { name: 'Edit message' }).fill('4 (copy)');
	await page.getByRole('button', { name: 'Save As Copy' }).click();
	await expect(reply).toContainText('4 (copy)');
	await expect(reply.getByLabel('Versions')).toContainText('2/2');
});

test('rate a reply, then add details; the feedback is recorded', async ({ page }) => {
	const chat = await mockChat(page, { chats: convo() });
	await page.goto('/c/c1');
	await page.getByRole('button', { name: 'Good Response' }).click();
	await expect.poll(() => chat.seen.feedback.length).toBeGreaterThan(0);
	expect(chat.seen.feedback[0]).toMatchObject({ type: 'rating', data: { rating: 1, model_id: 'qwen' }, meta: { chat_id: 'c1', message_id: 'a1' } });
	const form = page.getByTestId('rate-comment');
	await form.getByRole('button', { name: 'Rate 8 out of 10' }).click();
	await form.getByRole('button', { name: 'Thorough explanation' }).click();
	await form.getByRole('textbox', { name: 'Additional feedback comments' }).fill('Clear');
	await form.getByRole('button', { name: 'Save' }).click();
	await expect.poll(() => chat.seen.feedback.some((f) => f.data?.reason === 'thorough_explanation' && f.data?.comment === 'Clear' && f.data?.details?.rating === 8)).toBe(true);
	expect(chat.seen.feedback.at(-1)!.url).toMatch(/feedback\/fb1$/);
	await expect(page.getByRole('button', { name: 'Good Response' })).toHaveAttribute('aria-pressed', 'true');
});

test('continue a reply and regenerate with a suggestion', async ({ page }) => {
	const chat = await mockChat(page, { chats: convo() });
	await page.goto('/c/c1');
	await chat.socket.connected;
	await page.getByRole('button', { name: 'Continue Response' }).click();
	await expect.poll(() => chat.seen.completions.length).toBe(1);
	expect(chat.seen.completions[0]).toMatchObject({ id: 'a1', assistant_message_id: 'a1', chat_id: 'c1' });
	await chat.stream(' exactly.');
	await expect(page.getByTestId('response-message')).toContainText('It is 4 exactly.');

	await page.getByRole('button', { name: 'Regenerate options' }).click();
	await page.getByRole('menuitem', { name: 'More Concise' }).click();
	await expect.poll(() => chat.seen.completions.length).toBe(2);
	expect(chat.seen.completions[1].regeneration_prompt).toBe('More Concise');
});

test('delete a reply', async ({ page }) => {
	const chat = await mockChat(page, { chats: convo() });
	await page.goto('/c/c1');
	await page.getByTestId('response-message').getByRole('button', { name: 'Delete' }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
	await expect(page.getByTestId('response-message')).toHaveCount(0);
	expect(chat.seen.deletedMessages).toEqual(['a1']);
});

test('a user without the permissions sees no edit, rate or delete on replies', async ({ page }) => {
	await mockChat(page, { chats: convo(), user: { config: {} } });
	await page.route('**/api/v1/auths/', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'u1', name: 'U', email: 'u@x', role: 'user', permissions: { chat: { edit: false, rate_response: false, delete_message: false } }, expires_at: Math.floor(Date.now() / 1000) + 3600 }) }));
	await page.goto('/c/c1');
	const reply = page.getByTestId('response-message');
	await expect(reply.getByRole('button', { name: 'Copy' })).toBeVisible();
	await expect(reply.getByRole('button', { name: 'Edit' })).toHaveCount(0);
	await expect(reply.getByRole('button', { name: 'Good Response' })).toHaveCount(0);
	await expect(reply.getByRole('button', { name: 'Delete' })).toHaveCount(0);
});
