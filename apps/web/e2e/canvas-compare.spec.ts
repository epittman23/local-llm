import type { Page } from '@playwright/test';
import { mockChat, savedChat } from './chat-helpers';
import { expect, test } from './test';

// The canvas's Changes view (Phase 4, CNV-9): two saved versions of a text file compared as a line diff.
// The backend is mocked: a file with two versions, each served by its own content route.

const uuid = (key: string) => `00000000-0000-4000-8000-${key.padStart(12, '0')}`;
const FIT = uuid('f1');
const V2 = uuid('f2');
const BEFORE = `${Array.from({ length: 40 }, (_, i) => `step_${i + 1} = ${i + 1}`).join('\n')}\nresult = mean(step_1)\n`;
const AFTER = `import numpy as np\n${BEFORE.replace('result = mean(step_1)', 'result = np.median(step_1)')}`;

const canvas = (page: Page) => page.getByRole('complementary', { name: 'Canvas' });
const sheet = (page: Page) => page.getByRole('dialog', { name: /fit\.py/ });

async function mockVersioned(page: Page) {
	await mockChat(page, {
		chats: [
			savedChat('c1', 'Fit', [
				{ id: 'u1', role: 'user', content: 'Fit it' },
				{
					id: 'a1',
					role: 'assistant',
					content: 'Done.',
					model: 'qwen',
					modelName: 'Qwen',
					done: true,
					files: [
						{
							type: 'file',
							id: FIT,
							name: 'fit.py',
							url: `/api/v1/files/${FIT}/content`,
							size: BEFORE.length,
							meta: { source: 'sandbox_output', sandbox_path: '/workspace/outputs/fit.py' }
						}
					]
				}
			])
		]
	});
	await page.route('**/api/v1/files/*/content*', (route) => {
		const file = new URL(route.request().url()).pathname.split('/').at(-2);
		return route.fulfill({
			status: 200,
			contentType: 'application/octet-stream',
			body: file === V2 ? AFTER : BEFORE
		});
	});
	await page.route('**/api/v1/files/*/versions', (route) =>
		route.fulfill({
			json: [
				{ id: FIT, version: 1, size: BEFORE.length, created_at: 1_700_000_000, name: 'fit.py' },
				{ id: V2, version: 2, size: AFTER.length, created_at: 1_700_000_100, name: 'fit.py' }
			]
		})
	);
}

test('Changes shows what was added and removed between two versions, and Swap reads it backwards', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await mockVersioned(page);
	await page.goto('/c/c1');
	await page.getByTestId('document-card').filter({ hasText: 'fit.py' }).click();
	await expect(canvas(page)).toBeVisible();

	await canvas(page).getByRole('button', { name: 'Changes' }).click();
	const rows = canvas(page).getByRole('region', { name: 'Changes from version 1 to version 2' });
	await expect(rows).toBeVisible();
	await expect(canvas(page).getByRole('status')).toHaveText('2 lines added, 1 removed');
	await expect(rows).toContainText('Added: import numpy as np');
	await expect(rows).toContainText('Removed: result = mean(step_1)');
	await expect(rows).toContainText('Added: result = np.median(step_1)');
	// The 40 unchanged lines are folded, and Edit is not offered in a read-only view.
	await expect(canvas(page).getByRole('button', { name: 'Show 40 unchanged lines' })).toBeVisible();
	await expect(canvas(page).getByRole('button', { name: 'Edit document' })).toHaveCount(0);

	await canvas(page).getByRole('button', { name: 'Show 40 unchanged lines' }).click();
	await expect(rows).toContainText('step_20 = 20');

	await canvas(page).getByRole('button', { name: 'Swap From and To' }).click();
	const backwards = canvas(page).getByRole('region', { name: 'Changes from version 2 to version 1' });
	await expect(backwards).toContainText('Removed: import numpy as np');
	await expect(canvas(page).getByRole('status')).toHaveText('1 line added, 2 removed');

	// The same version cannot be both: the other selector refuses it.
	await canvas(page).getByRole('combobox', { name: 'From version' }).click();
	await expect(page.getByRole('option', { name: 'Version 1 (original)' })).toHaveAttribute('aria-disabled', 'true');
	await page.keyboard.press('Escape');

	await canvas(page).getByRole('button', { name: 'Source' }).click();
	await expect(canvas(page).getByRole('button', { name: 'Edit document' })).toBeVisible();
});

test('Changes in the sheet at 390 px scrolls inside the sheet, not the page', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await mockVersioned(page);
	await page.goto('/c/c1');
	await page.getByTestId('document-card').filter({ hasText: 'fit.py' }).click();
	await expect(sheet(page)).toBeVisible();
	await sheet(page).getByRole('button', { name: 'Changes' }).click();
	const rows = sheet(page).getByRole('region', { name: 'Changes from version 1 to version 2' });
	await sheet(page).getByRole('button', { name: 'Show 40 unchanged lines' }).click();
	await expect(rows).toContainText('step_40 = 40');
	// The region is the thing that scrolls, in both directions, and the page itself does not.
	const scrolls = await rows.evaluate((el) => ({
		down: el.scrollHeight > el.clientHeight,
		inside: el.getBoundingClientRect().right <= window.innerWidth
	}));
	expect(scrolls).toEqual({ down: true, inside: true });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await rows.focus();
	await expect(rows).toBeFocused();
	await page.keyboard.press('End');
	await expect.poll(() => rows.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});
