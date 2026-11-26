import type { Page } from '@playwright/test';
import { mockChat, savedChat } from './chat-helpers';
import { expect, test } from './test';

// A knowledge file a reply cites opens in the canvas, read-only (CNV-1, CNV-4, CNV-7). The backend is mocked:
// the server's own access check is covered by the backend tests.

const FILE = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';
const TEXT = '# Standard error\n\nThe whole file.\n';
const PASSAGE = 'The standard error shrinks with the square root of n.';

const canvas = (page: Page) => page.getByRole('complementary', { name: 'Canvas' });

const convo = () => [
	savedChat('c1', 'Stats', [
		{ id: 'u1', role: 'user', content: 'What is the standard error?' },
		{
			id: 'a1',
			role: 'assistant',
			content: 'It shrinks with n [1].',
			model: 'qwen',
			modelName: 'Qwen',
			done: true,
			sources: [
				{
					source: { name: 'stats.md' },
					document: [PASSAGE],
					metadata: [{ file_id: FILE, name: 'stats.md', source: 'stats.md' }]
				}
			]
		}
	])
];

async function mock(page: Page, access: boolean) {
	await mockChat(page, { chats: convo() });
	await page.route('**/api/v1/files/*/content*', (route) =>
		access
			? route.fulfill({ status: 200, contentType: 'text/plain', body: TEXT })
			: route.fulfill({ status: 404, json: { detail: "We could not find what you're looking for :/" } })
	);
}

test('Open in canvas shows the file with its passage, and the address restores it on reload', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await mock(page, true);
	await page.goto('/c/c1');
	await page.getByRole('button', { name: '1 Source' }).click();
	await page
		.getByLabel('Sources')
		.getByRole('button', { name: /stats\.md/ })
		.click();
	await page.getByRole('button', { name: 'Open in canvas' }).click();
	await expect(page.getByRole('dialog', { name: 'Citation' })).toHaveCount(0);
	await expect(canvas(page)).toBeVisible();
	await expect(page).toHaveURL(new RegExp(`\\?canvas=file%3A${FILE}$`));
	await expect(canvas(page).getByRole('heading', { name: 'stats.md Markdown, from a knowledge source' })).toBeVisible();
	await expect(canvas(page).getByText(PASSAGE)).toBeVisible();
	// Read-only: no editing, no versions.
	await expect(canvas(page).getByRole('button', { name: /Edit document/ })).toHaveCount(0);
	await expect(canvas(page).getByRole('button', { name: /Version/ })).toHaveCount(0);
	await canvas(page).getByRole('button', { name: 'Source' }).click();
	await expect(canvas(page).getByText('The whole file.')).toBeVisible();

	await page.reload();
	await expect(canvas(page).getByText(PASSAGE)).toBeVisible();
	await expect(canvas(page).getByRole('heading', { name: /stats\.md/ })).toBeVisible();
});

test('a file the server refuses shows one Note and no data', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await mock(page, false);
	await page.goto(`/c/c1?canvas=file:${FILE}`);
	await expect(canvas(page).getByText(/You can’t open this file/)).toBeVisible();
	await expect(canvas(page).getByText('The whole file.')).toHaveCount(0);
});

test('a file:<id> the chat does not cite is gone, and never fetched', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await mock(page, true);
	let fetched = false;
	await page.route(`**/api/v1/files/${OTHER}/**`, (route) => {
		fetched = true;
		return route.abort();
	});
	await page.goto(`/c/c1?canvas=file:${OTHER}`);
	await expect(canvas(page).getByText('This document is no longer in the chat')).toBeVisible();
	expect(fetched).toBe(false);
});
