import { expect, test } from '@playwright/test';

test('the app shell renders the home route with a working sidebar link', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible();

	// The sidebar defaults closed (mirrors apps/openwebui/src/lib/components/
	// layout/Sidebar.svelte's own localStorage.sidebar default), so its nav
	// links don't exist in the DOM until it's opened.
	await page.getByRole('button', { name: /open sidebar/i }).click();
	await expect(page.getByRole('link', { name: /new chat/i })).toBeVisible();

	await page.getByRole('link', { name: /workspace/i }).click();
	await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
	await expect(page).toHaveURL(/\/workspace$/);
});
