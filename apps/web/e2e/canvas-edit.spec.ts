import type { Page } from '@playwright/test';
import { mockChat, savedChat } from './chat-helpers';
import { expect, test } from './test';

// The canvas editor (Phase 3, CNV-6): a text file is edited in its Source and saved as a new version; the
// document stays the original, whose versions are counted in its heading. The backend is mocked.

const uuid = (key: string) => `00000000-0000-4000-8000-${key.padStart(12, '0')}`;
const FIT = uuid('f1');
const V2 = uuid('f2');
const SOURCE = 'import numpy as np\n\ndef fit(x):\n    return np.mean(x)\n';

const canvas = (page: Page) => page.getByRole('complementary', { name: 'Canvas' });

/** A chat with one output script, a content route that serves each version's text, and the version routes. */
async function mockEditable(page: Page) {
	const saved: { id: string; text: string }[] = [];
	const posts: { path: string; content: string }[] = [];
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
							size: SOURCE.length,
							meta: { source: 'sandbox_output', sandbox_path: '/workspace/outputs/fit.py' }
						}
					]
				}
			])
		]
	});
	await page.route('**/api/v1/files/*/content*', (route) => {
		const file = new URL(route.request().url()).pathname.split('/').at(-2);
		const text = file === FIT ? SOURCE : saved.find((v) => v.id === file)?.text;
		if (text === undefined) return route.fulfill({ status: 404, json: { detail: 'Not found' } });
		return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: text });
	});
	await page.route('**/api/v1/files/*/versions', async (route) => {
		const request = route.request();
		if (request.method() === 'POST') {
			const body = request.postDataJSON() as { content: string };
			posts.push({ path: new URL(request.url()).pathname, content: body.content });
			const id = saved.length ? uuid(`f${saved.length + 2}`) : V2;
			saved.push({ id, text: body.content });
			return route.fulfill({
				json: { id, filename: 'fit.py', data: {}, meta: { version: saved.length + 1, size: body.content.length } }
			});
		}
		return route.fulfill({
			json: [
				{ id: FIT, version: 1, size: SOURCE.length, created_at: 1_700_000_000, name: 'fit.py' },
				...saved.map((v, i) => ({
					id: v.id,
					version: i + 2,
					size: v.text.length,
					created_at: 1_700_000_100,
					name: 'fit.py'
				}))
			]
		});
	});
	return { posts };
}

const openFit = async (page: Page) => {
	await page.goto('/c/c1');
	await page.getByTestId('document-card').filter({ hasText: 'fit.py' }).click();
	await expect(canvas(page)).toBeVisible();
};
const editor = (page: Page) => canvas(page).getByRole('textbox', { name: 'Edit fit.py' });

test.beforeEach(async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
});

test('edit, save as a version, and the heading says Version 2 of 2', async ({ page }) => {
	const server = await mockEditable(page);
	await openFit(page);
	await canvas(page).getByRole('button', { name: 'Edit document' }).click();
	await expect(editor(page)).toBeFocused();
	await expect(canvas(page).getByText('All changes saved')).toBeVisible();
	await editor(page).press('Control+End');
	await editor(page).pressSequentially('# edited');
	await expect(canvas(page).getByText('Unsaved changes')).toBeVisible();
	await canvas(page).getByRole('button', { name: 'Save document' }).click();
	await expect(page.getByText('Saved as version 2')).toBeVisible();
	await expect(canvas(page).getByRole('heading', { level: 2 })).toContainText('Version 2 of 2');
	await expect(canvas(page).getByRole('heading', { level: 2 })).toBeFocused();
	await expect(editor(page)).toHaveCount(0);
	await expect(canvas(page)).toContainText('# edited');
	expect(server.posts).toEqual([{ path: `/api/v1/files/${FIT}/versions`, content: `${SOURCE}# edited` }]);
	// Version 1 is one choice away, read-only, with the way back.
	await canvas(page).getByRole('button', { name: 'Versions' }).click();
	await page.getByRole('menuitemradio', { name: 'Version 1 (original)' }).click();
	await expect(canvas(page).getByText('You are viewing version 1 of 2.')).toBeVisible();
	await expect(canvas(page).getByRole('button', { name: 'Edit document' })).toHaveCount(0);
	await canvas(page).getByRole('button', { name: 'Back to version 2' }).click();
	await expect(canvas(page).getByRole('heading', { level: 2 })).toContainText('Version 2 of 2');
});

test('Discard changes puts the text back, and Ctrl+S saves', async ({ page }) => {
	const server = await mockEditable(page);
	await openFit(page);
	await canvas(page).getByRole('button', { name: 'Edit document' }).click();
	await editor(page).pressSequentially('zzz');
	await canvas(page).getByRole('button', { name: 'Discard changes' }).click();
	await expect(editor(page)).toHaveCount(0);
	await expect(canvas(page)).not.toContainText('zzz');
	await expect(canvas(page).getByRole('heading', { level: 2 })).toBeFocused();
	await canvas(page).getByRole('button', { name: 'Edit document' }).click();
	await editor(page).pressSequentially('!');
	await editor(page).press('Control+s');
	await expect(page.getByText('Saved as version 2')).toBeVisible();
	expect(server.posts).toHaveLength(1);
});

test('unsaved edits are guarded: Close, Escape on the panel, and the browser’s Back', async ({ page }) => {
	await mockEditable(page);
	await openFit(page);
	await canvas(page).getByRole('button', { name: 'Edit document' }).click();
	await editor(page).pressSequentially('x');

	const ask = page.getByRole('alertdialog', { name: 'Discard changes?' });
	// Escape in the editor stays in the editor; on the heading it asks.
	await editor(page).press('Escape');
	await expect(ask).toHaveCount(0);
	await expect(canvas(page)).toBeVisible();
	await canvas(page).getByRole('heading', { level: 2 }).focus();
	await page.keyboard.press('Escape');
	await expect(ask).toBeVisible();
	await ask.getByRole('button', { name: 'Keep editing' }).click();

	await canvas(page).getByRole('button', { name: 'Close canvas' }).click();
	await expect(ask).toBeVisible();
	await ask.getByRole('button', { name: 'Keep editing' }).click();
	await expect(ask).toHaveCount(0);
	await expect(editor(page)).toHaveValue(`x${SOURCE}`);
	// Keep editing puts focus back on what raised the question: the Close button.
	await expect(canvas(page).getByRole('button', { name: 'Close canvas' })).toBeFocused();

	await page.goBack();
	await expect(ask).toBeVisible();
	await ask.getByRole('button', { name: 'Discard changes' }).click();
	await expect(canvas(page)).toHaveCount(0);
	await expect(page).not.toHaveURL(/canvas=/);
});

test('Tab leaves the editor until something is typed, then indents; Escape then Tab leaves again', async ({ page }) => {
	await mockEditable(page);
	await openFit(page);
	await canvas(page).getByRole('button', { name: 'Edit document' }).click();
	const box = editor(page);
	await expect(box).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(box).not.toBeFocused();

	await box.click();
	await box.press('Control+Home');
	await box.pressSequentially('a');
	await box.press('Tab');
	await expect(box).toBeFocused();
	await expect(box).toHaveValue(`a  ${SOURCE}`.replace('a  import', 'a  import'));
	await box.press('Escape');
	await expect(canvas(page)).toBeVisible();
	await page.keyboard.press('Tab');
	await expect(box).not.toBeFocused();
	await expect(canvas(page).getByText('Tab indents. Press Esc, then Tab, to leave the editor.')).toBeVisible();
});

test('the editor looks like the source: one face, one box, the same pixels', async ({ page }) => {
	await mockEditable(page);
	await openFit(page);
	const surface = canvas(page).locator('.code-surface');
	const pre = surface.locator('pre');
	await expect(pre).toContainText('def fit');
	const props = [
		'fontFamily',
		'fontSize',
		'lineHeight',
		'letterSpacing',
		'tabSize',
		'whiteSpace',
		'paddingTop',
		'paddingLeft'
	] as const;
	const styleOf = (locator: ReturnType<typeof pre.locator>) =>
		locator.evaluate((el, names) => {
			const style = getComputedStyle(el);
			return names.map((name) => style[name as never] as string);
		}, props);
	const clip = async () => {
		const box = await surface.boundingBox();
		if (!box) throw new Error('no surface');
		return { x: box.x, y: box.y, width: Math.min(box.width, 700), height: 5 * 22 };
	};

	const box = await pre.boundingBox();
	const styles = await styleOf(pre);
	const area = await clip();
	await page.mouse.move(0, 0);
	const reading = await page.screenshot({ clip: area, animations: 'disabled', caret: 'hide' });

	await canvas(page).getByRole('button', { name: 'Edit document' }).click();
	const textarea = canvas(page).getByRole('textbox', { name: 'Edit fit.py' });
	await expect(textarea).toBeFocused();
	expect(await styleOf(textarea)).toEqual(styles);
	const editing = await textarea.boundingBox();
	// It starts where the text starts and covers all of it (and the cell's right padding, so the caret is never outside).
	for (const key of ['x', 'y'] as const) expect(editing?.[key]).toBeCloseTo(box?.[key] ?? -1, 0);
	expect(editing?.width).toBeGreaterThanOrEqual(box?.width ?? Number.POSITIVE_INFINITY);
	expect(editing?.height).toBeGreaterThanOrEqual(box?.height ?? Number.POSITIVE_INFINITY);
	// Same text in the same place: the first lines are identical to the pixel.
	const writing = await page.screenshot({ clip: area, animations: 'disabled', caret: 'hide' });
	expect(writing.equals(reading)).toBe(true);
});
