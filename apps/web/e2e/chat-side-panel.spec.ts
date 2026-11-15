import { mockChat, savedChat } from './chat-helpers';
import { expect, test } from './test';

// The chat's side panel (canvas Phase 1, CNV-2, LAY-4, NAV-4): a resizable
// column where the space beside the sidebar holds it and 24 rem of chat, else
// a full-screen sheet over the chat.

const convo = () => [
	savedChat('c1', 'Arithmetic', [
		{ id: 'u1', role: 'user', content: 'What is 2+2?' },
		{ id: 'a1', role: 'assistant', content: 'It is 4', model: 'qwen', modelName: 'Qwen', done: true }
	])
];

const controls = (page: import('@playwright/test').Page) => page.getByRole('button', { name: 'Controls', exact: true });

test('at 390 px Controls is a full-screen sheet over the chat, and closes back to it (#901)', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await mockChat(page, { chats: convo() });
	await page.goto('/c/c1');
	await controls(page).click();

	const sheet = page.getByRole('dialog', { name: 'Controls' });
	await expect(sheet.getByRole('heading', { name: 'Controls' })).toBeFocused();
	// It covers the whole screen, with its own surface, so nothing of the chat shows through.
	// (Polled: it slides in.)
	await expect.poll(async () => await sheet.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
	expect(await sheet.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toMatch(/rgba\(.*, 0\)|transparent/);
	await expect(page.getByRole('complementary', { name: 'Controls' })).toHaveCount(0);
	await expect(sheet.getByRole('button', { name: /close/i })).toHaveCount(1);
	await expect(sheet.getByRole('separator')).toHaveCount(0);

	await sheet.getByRole('button', { name: 'Close controls' }).click();
	await expect(sheet).toHaveCount(0);
	await expect(controls(page)).toBeFocused();

	// Escape closes it too, back to the same place.
	await controls(page).click();
	await expect(page.getByRole('dialog', { name: 'Controls' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog', { name: 'Controls' })).toHaveCount(0);
	await expect(controls(page)).toBeFocused();
});

test('at 1440 px Controls is a column beside the chat; the arrows resize it and a reload keeps the width', async ({
	page
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await mockChat(page, { chats: convo() });
	await page.goto('/c/c1');
	await controls(page).click();

	const panel = page.getByRole('complementary', { name: 'Controls' });
	await expect(panel.getByRole('heading', { name: 'Controls' })).toBeFocused();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	expect((await panel.boundingBox())?.width).toBe(320);
	// The chat stays usable beside it.
	await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();

	const handle = panel.getByRole('separator', { name: 'Resize controls' });
	await handle.focus();
	await page.keyboard.press('ArrowLeft');
	await page.keyboard.press('Shift+ArrowLeft');
	await expect(handle).toHaveAttribute('aria-valuenow', '400');
	expect((await panel.boundingBox())?.width).toBe(400);
	await page.keyboard.press('ArrowRight');
	await expect(handle).toHaveAttribute('aria-valuenow', '384');

	await page.reload();
	await controls(page).click();
	await expect(page.getByRole('separator', { name: 'Resize controls' })).toHaveAttribute('aria-valuenow', '384');

	// Escape from inside closes it and focus returns to Controls; Escape in the message box does not.
	await page.getByRole('textbox', { name: 'Message' }).focus();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('complementary', { name: 'Controls' })).toBeVisible();
	await page.getByRole('complementary', { name: 'Controls' }).getByLabel('System prompt').focus();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('complementary', { name: 'Controls' })).toHaveCount(0);
	await expect(controls(page)).toBeFocused();
});

test('the column resizes by dragging its handle', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await mockChat(page, { chats: convo() });
	await page.goto('/c/c1');
	await controls(page).click();
	const handle = page.getByRole('separator', { name: 'Resize controls' });
	const box = await handle.boundingBox();
	if (!box) throw new Error('The resize handle has no box');
	await page.mouse.move(box.x + box.width / 2, box.y + 200);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2 - 100, box.y + 200, { steps: 5 });
	await page.mouse.up();
	await expect(handle).toHaveAttribute('aria-valuenow', '420');
});

test('at 768 px with the sidebar open there is no room for a column: a sheet', async ({ page }) => {
	await page.setViewportSize({ width: 768, height: 900 });
	await mockChat(page, { chats: convo() });
	await page.goto('/c/c1');
	await expect(page.getByRole('complementary', { name: 'Sidebar' })).toHaveAttribute('class', /w-64/);
	await controls(page).click();
	await expect(page.getByRole('dialog', { name: 'Controls' })).toBeVisible();
	await expect(page.getByRole('complementary', { name: 'Controls' })).toHaveCount(0);
});

test('at 1024 px with the sidebar open Controls is a column', async ({ page }) => {
	await page.setViewportSize({ width: 1024, height: 768 });
	await mockChat(page, { chats: convo() });
	await page.goto('/c/c1');
	await controls(page).click();
	await expect(page.getByRole('complementary', { name: 'Controls' })).toBeVisible();
	await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('at 390 px the chat has one header row, the app bar, holding its title, Controls and menu (#1091)', async ({
	page
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await mockChat(page, { chats: convo() });
	await page.goto('/c/c1');
	const bar = page.getByRole('banner');
	await expect(bar.getByText('Arithmetic')).toBeVisible();
	await expect(bar.getByRole('button', { name: 'Controls', exact: true })).toBeVisible();
	await expect(bar.getByRole('button', { name: 'Chat menu', exact: true })).toBeVisible();
	await expect(page.locator('header[data-page-top]')).toHaveCount(0);
	// The model picker moved to the composer.
	await expect(page.locator('#model-selector-model-button')).toBeVisible();
	const message = await page.getByRole('textbox', { name: 'Message' }).boundingBox();
	const picker = await page.locator('#model-selector-model-button').boundingBox();
	expect(picker && message && picker.y > message.y).toBe(true);
	// Nothing in the bar is pushed off the screen.
	const box = await bar.boundingBox();
	expect(box?.width).toBe(390);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('on a short phone the bar folds and the chat’s buttons float at the top right, still reachable (A11Y-5)', async ({
	page
}) => {
	await page.setViewportSize({ width: 390, height: 500 });
	await mockChat(page, { chats: convo() });
	await page.goto('/c/c1');
	const controls = page.getByRole('button', { name: 'Controls', exact: true });
	await expect(controls).toBeVisible();
	const slot = page.getByTestId('shell-bar-slot');
	expect(await slot.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
	const box = await slot.boundingBox();
	expect(box && box.x + box.width).toBeGreaterThan(370);
	expect(box?.y).toBe(8);
	await controls.click();
	await expect(page.getByRole('dialog', { name: 'Controls' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(controls).toBeFocused();
});
