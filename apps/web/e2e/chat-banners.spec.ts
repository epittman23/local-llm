import { json, mockChat, savedChat } from './chat-helpers';
import { expect, test } from './test';

// What GET /api/v1/configs/banners answers: the banners set in Admin > Settings > General (#243).
const BANNERS = [
	{ id: 'b1', type: 'warning', content: 'Maintenance **tonight**', dismissible: true, timestamp: 0 },
	{
		id: 'b2',
		type: 'info',
		content: 'Read the notes',
		url: 'https://example.com/notes',
		dismissible: false,
		timestamp: 0
	}
];

test('banners show above a new chat; a dismissible one stays dismissed, another stays closed until reload (#243)', async ({
	page
}) => {
	await mockChat(page);
	await page.route('**/api/v1/configs/banners', (route) => json(route, BANNERS));
	await page.goto('/');
	const banners = page.getByTestId('chat-banner');
	await expect(banners).toHaveCount(2);
	await expect(banners.nth(0)).toContainText('Maintenance tonight');
	await expect(banners.nth(0).locator('strong')).toHaveText('tonight');

	await page.getByRole('button', { name: 'Close warning banner' }).click();
	await page.getByRole('button', { name: 'Close info banner' }).click();
	await expect(banners).toHaveCount(0);

	await page.reload();
	await expect(banners).toHaveCount(1);
	await expect(banners.first()).toContainText('Read the notes');
});

test('banners are not shown inside an existing chat (#243)', async ({ page }) => {
	await mockChat(page, {
		chats: [savedChat('c1', 'Chat', [{ id: 'u1', role: 'user', content: 'Hi' }])]
	});
	await page.route('**/api/v1/configs/banners', (route) => json(route, BANNERS));
	await page.goto('/c/c1');
	await expect(page.getByTestId('user-message')).toBeVisible();
	await expect(page.getByTestId('chat-banner')).toHaveCount(0);
});

for (const [width, height] of [
	[1440, 900],
	[390, 844]
]) {
	test(`a temporary chat keeps saying it is not saved after the first message, and a reload asks first (${width} px, #1080)`, async ({
		page
	}) => {
		await page.setViewportSize({ width, height });
		const chat = await mockChat(page, { user: { role: 'admin' } });
		await page.route('**/api/chat/completions', async (route) => {
			chat.seen.completions.push(route.request().postDataJSON());
			return json(route, { status: true, task_id: 't1' });
		});
		await page.goto('/');
		await chat.socket.connected;
		const toggle = page.getByRole('button', { name: 'Temporary chat', exact: true });
		await expect(toggle).toHaveAttribute('aria-pressed', 'false');
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-pressed', 'true');
		await page.getByRole('textbox', { name: 'Message' }).fill('secret');
		await page.keyboard.press('Enter');
		await expect.poll(() => chat.seen.completions.length).toBe(1);

		const notice = page.getByText('Temporary: not saved');
		await expect(notice).toBeVisible();
		// It replaces the toggle: a temporary chat cannot be made permanent halfway.
		await expect(page.getByRole('button', { name: 'Temporary chat', exact: true })).toHaveCount(0);

		let asked = false;
		page.once('dialog', (dialog) => {
			asked = dialog.type() === 'beforeunload';
			void dialog.accept();
		});
		await page.reload();
		expect(asked).toBe(true);
	});
}
