import { expect, test } from '@playwright/test';

test('the Astro + React + shadcn/ui root renders', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'local-llm' })).toBeVisible();
	await expect(page.getByRole('button', { name: /shadcn\/ui/ })).toBeVisible();
});
