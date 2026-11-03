import { json, mockChat, savedChat } from './chat-helpers';
import { expect, test } from './test';

// What GET /api/v1/configs/banners answers: the banners set in Admin Settings > General (#243).
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

test('banners show above a new chat; a dismissible one stays dismissed, another closes until reload (#243)', async ({
	page
}) => {
	await mockChat(page);
	await page.route('**/api/v1/configs/banners', (route) => json(route, BANNERS));
	await page.goto('/');
	const banners = page.getByTestId('chat-banner');
	await expect(banners).toHaveCount(2);
	await expect(banners.nth(0)).toContainText('Maintenance tonight');
	await expect(banners.nth(0).locator('strong')).toHaveText('tonight');
	await expect(banners.nth(1).getByRole('link', { name: 'Details' })).toHaveAttribute(
		'href',
		'https://example.com/notes'
	);

	await banners.nth(0).getByRole('button', { name: 'Close Banner' }).click();
	await banners.nth(0).getByRole('button', { name: 'Close Banner' }).click();
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
