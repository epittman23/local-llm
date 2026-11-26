import type { Page } from '@playwright/test';
import { mockChat, savedChat } from './chat-helpers';
import { expect, test } from './test';

// Editing a CSV file as a table (Phase 4, CNV-6): a faithful file is a table with a field in every cell, saved as a
// new version; a file that is too large or not comma-separated is edited as text. The backend is mocked.

const uuid = (key: string) => `00000000-0000-4000-8000-${key.padStart(12, '0')}`;
const DATA = uuid('d1');
const V2 = uuid('d2');
const START = 'name,qty\nAda,3\nBo,4\n';

const canvas = (page: Page) => page.getByRole('complementary', { name: 'Canvas' });
const sheet = (page: Page) => page.getByRole('dialog', { name: /data\.csv/ });
const cell = (page: Page, row: number, col: number) =>
	page.getByRole('textbox', { name: row === 0 ? `Heading of column ${col}` : `Row ${row}, column ${col}` });

/** A chat with one output CSV, a content route that serves each version's text, and the version routes. */
async function mockCsv(page: Page, start = START) {
	const saved: { id: string; text: string }[] = [];
	const posts: { path: string; content: string }[] = [];
	await mockChat(page, {
		chats: [
			savedChat('c1', 'Data', [
				{ id: 'u1', role: 'user', content: 'Make a table' },
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
							id: DATA,
							name: 'data.csv',
							url: `/api/v1/files/${DATA}/content`,
							size: start.length,
							meta: { source: 'sandbox_output', sandbox_path: '/workspace/outputs/data.csv' }
						}
					]
				}
			])
		]
	});
	await page.route('**/api/v1/files/*/content*', (route) => {
		const file = new URL(route.request().url()).pathname.split('/').at(-2);
		const text = file === DATA ? start : saved.find((v) => v.id === file)?.text;
		if (text === undefined) return route.fulfill({ status: 404, json: { detail: 'Not found' } });
		return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: text });
	});
	await page.route('**/api/v1/files/*/versions', async (route) => {
		const request = route.request();
		if (request.method() === 'POST') {
			const body = request.postDataJSON() as { content: string };
			posts.push({ path: new URL(request.url()).pathname, content: body.content });
			saved.push({ id: V2, text: body.content });
			return route.fulfill({
				json: { id: V2, filename: 'data.csv', data: {}, meta: { version: 2, size: body.content.length } }
			});
		}
		return route.fulfill({
			json: [
				{ id: DATA, version: 1, size: start.length, created_at: 1_700_000_000, name: 'data.csv' },
				...saved.map((v) => ({
					id: v.id,
					version: 2,
					size: v.text.length,
					created_at: 1_700_000_100,
					name: 'data.csv'
				}))
			]
		});
	});
	return { posts };
}

const openData = async (page: Page) => {
	await page.goto('/c/c1');
	await page.getByTestId('document-card').filter({ hasText: 'data.csv' }).click();
	await expect(canvas(page).or(sheet(page))).toBeVisible();
};

test.beforeEach(async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
});

test('edit two cells and add a row, save as a version, and the table shows it', async ({ page }) => {
	const server = await mockCsv(page);
	await openData(page);
	await canvas(page).getByRole('button', { name: 'Edit document' }).click();
	await expect(cell(page, 0, 1)).toBeFocused();
	await expect(canvas(page).getByText('All changes saved')).toBeVisible();
	await cell(page, 1, 2).fill('30');
	await cell(page, 2, 1).fill('Bo B');
	await expect(canvas(page).getByText('Unsaved changes')).toBeVisible();
	await canvas(page).getByRole('button', { name: 'Add row' }).click();
	await expect(cell(page, 3, 1)).toBeFocused();
	await page.keyboard.type('Cy');
	await page.keyboard.press('Tab');
	await page.keyboard.type('5');
	await canvas(page).getByRole('button', { name: 'Save document' }).click();
	await expect(page.getByText('Saved as version 2')).toBeVisible();
	await expect(canvas(page).getByRole('button', { name: 'Version 2 of 2' })).toBeVisible();
	expect(server.posts).toEqual([
		{ path: `/api/v1/files/${DATA}/versions`, content: 'name,qty\nAda,30\nBo B,4\nCy,5\n' }
	]);
	await expect(cell(page, 1, 1)).toHaveCount(0);
	await expect(canvas(page).getByRole('cell', { name: 'Bo B' })).toBeVisible();
	await expect(canvas(page).getByRole('cell', { name: 'Cy' })).toBeVisible();
});

test('Enter moves down, Shift+Enter up, and Tab moves across', async ({ page }) => {
	await mockCsv(page);
	await openData(page);
	await canvas(page).getByRole('button', { name: 'Edit document' }).click();
	await page.keyboard.press('Enter');
	await expect(cell(page, 1, 1)).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(cell(page, 2, 1)).toBeFocused();
	await page.keyboard.press('Shift+Enter');
	await expect(cell(page, 1, 1)).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(cell(page, 1, 2)).toBeFocused();
});

test('delete a row and a column, then Discard changes puts the table back and the Close guard asks', async ({
	page
}) => {
	const server = await mockCsv(page);
	await openData(page);
	await canvas(page).getByRole('button', { name: 'Edit document' }).click();
	await canvas(page).getByRole('button', { name: 'Delete row 1' }).click();
	await canvas(page).getByRole('button', { name: 'Column 1 actions' }).click();
	await page.getByRole('menuitem', { name: 'Delete column' }).click();
	await expect(cell(page, 1, 1)).toHaveValue('4');
	const ask = page.getByRole('alertdialog', { name: 'Discard changes?' });
	await canvas(page).getByRole('button', { name: 'Close canvas' }).click();
	await expect(ask).toBeVisible();
	await ask.getByRole('button', { name: 'Keep editing' }).click();
	await expect(ask).toHaveCount(0);
	await canvas(page).getByRole('button', { name: 'Discard changes' }).click();
	await expect(cell(page, 1, 1)).toHaveCount(0);
	await expect(canvas(page).getByRole('cell', { name: 'Ada' })).toBeVisible();
	await expect(canvas(page).getByRole('heading', { level: 2 })).toBeFocused();
	expect(server.posts).toEqual([]);
});

test('a CRLF file is saved as CRLF', async ({ page }) => {
	const server = await mockCsv(page, 'a,b\r\n1,2\r\n');
	await openData(page);
	await canvas(page).getByRole('button', { name: 'Edit document' }).click();
	await cell(page, 1, 2).fill('3');
	await canvas(page).getByRole('button', { name: 'Save document' }).click();
	await expect(page.getByText('Saved as version 2')).toBeVisible();
	expect(server.posts.map((p) => p.content)).toEqual(['a,b\r\n1,3\r\n']);
});

test('a file past 500 rows is edited as text, with the reason', async ({ page }) => {
	await mockCsv(page, Array.from({ length: 501 }, (_, i) => `${i},x`).join('\n'));
	await openData(page);
	await canvas(page).getByRole('button', { name: 'Edit document' }).click();
	await expect(canvas(page).getByRole('textbox', { name: 'Edit data.csv' })).toBeFocused();
	await expect(canvas(page).getByText('Too large to edit as a table. Edit it as text.')).toBeVisible();
});

test('at 390 px the table is edited in the sheet and Edit as text is in its menu', async ({ page }) => {
	const server = await mockCsv(page);
	await page.setViewportSize({ width: 390, height: 844 });
	await openData(page);
	await sheet(page).getByRole('button', { name: 'More actions for this document' }).click();
	await page.getByRole('menuitem', { name: 'Edit document' }).click();
	await expect(cell(page, 0, 1)).toBeVisible();
	await cell(page, 1, 1).fill('Ada L');
	await sheet(page).getByRole('button', { name: 'More actions for this document' }).click();
	await page.getByRole('menuitem', { name: 'Edit as text' }).click();
	await expect(sheet(page).getByRole('textbox', { name: 'Edit data.csv' })).toHaveValue('name,qty\nAda L,3\nBo,4\n');
	expect(server.posts).toEqual([]);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
