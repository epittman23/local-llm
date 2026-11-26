import type { Page } from '@playwright/test';
import { json, mockChat, savedChat } from './chat-helpers';
import { expect, test } from './test';

// Editing a page the model wrote, with its preview beside the source (Phase 4, CNV-5, CNV-6). The draft reaches the
// frame only as srcdoc, in a frame sandboxed to allow-scripts: an opaque origin that cannot read the app's DOM.
// The backend is mocked.

const uuid = (key: string) => `00000000-0000-4000-8000-${key.padStart(12, '0')}`;
const PAGE = uuid('c1');
const V2 = uuid('c2');
const POLICY = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'">`;
const START = '<!doctype html>\n<h1 id="title">Original</h1>\n<p id="parent">not run</p>\n';
// A draft whose script reports what it can reach from inside the frame.
const REPORTER = `<!doctype html>
<h1 id="title">Edited</h1>
<p id="parent">not run</p>
<script>
try { parent.document.title; document.getElementById('parent').textContent = 'parent reached'; } catch { document.getElementById('parent').textContent = 'parent blocked'; }
</script>
`;
const BLOCK = '<!doctype html>\n<html><body><h1>Block page</h1><p>Written in the reply.</p></body></html>';

const canvas = (page: Page) => page.getByRole('complementary', { name: 'Canvas' });
const sheet = (page: Page) => page.getByRole('dialog', { name: /page\.html|HTML/ });
const editor = (page: Page, name = 'page.html') => page.getByRole('textbox', { name: `Edit ${name}` });
const frameElement = (page: Page, title = 'Preview of page.html') => page.locator(`iframe[title="${title}"]`);
const frameHandle = async (page: Page, title?: string) => {
	const handle = await frameElement(page, title).elementHandle();
	const frame = await handle?.contentFrame();
	if (!frame) throw new Error('no frame');
	return frame;
};

async function mockPage(page: Page) {
	const saved: { id: string; text: string }[] = [];
	const posts: string[] = [];
	const asked: string[] = [];
	await mockChat(page, {
		chats: [
			savedChat('c1', 'Pages', [
				{ id: 'u1', role: 'user', content: 'Make a page' },
				{
					id: 'a1',
					role: 'assistant',
					content: `Here you go.\n\n\`\`\`html\n${BLOCK}\n\`\`\``,
					model: 'qwen',
					modelName: 'Qwen',
					done: true,
					files: [
						{
							type: 'file',
							id: PAGE,
							name: 'page.html',
							url: `/api/v1/files/${PAGE}/content`,
							size: START.length,
							meta: {
								source: 'sandbox_output',
								sandbox_path: '/workspace/outputs/page.html',
								content_type: 'text/html'
							}
						}
					]
				}
			])
		]
	});
	await page.route('**/api/v1/files/*/content*', (route) => {
		const file = new URL(route.request().url()).pathname.split('/').at(-2);
		const text = file === PAGE ? START : saved.find((v) => v.id === file)?.text;
		if (text === undefined) return route.fulfill({ status: 404, json: { detail: 'Not found' } });
		return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: text });
	});
	await page.route('**/api/v1/sandbox/outputs/*/html', (route) => {
		const file = new URL(route.request().url()).pathname.split('/').at(-2) ?? '';
		asked.push(file);
		const text = file === PAGE ? START : saved.find((v) => v.id === file)?.text;
		return text === undefined ? route.fulfill({ status: 404 }) : json(route, { html: POLICY + text });
	});
	await page.route('**/api/v1/files/*/versions', async (route) => {
		const request = route.request();
		if (request.method() === 'POST') {
			const body = request.postDataJSON() as { content: string };
			posts.push(body.content);
			saved.push({ id: V2, text: body.content });
			return route.fulfill({
				json: { id: V2, filename: 'page.html', data: {}, meta: { version: 2, size: body.content.length } }
			});
		}
		return route.fulfill({
			json: [
				{ id: PAGE, version: 1, size: START.length, created_at: 1_700_000_000, name: 'page.html' },
				...saved.map((v, i) => ({
					id: v.id,
					version: i + 2,
					size: v.text.length,
					created_at: 1_700_000_100,
					name: 'page.html'
				}))
			]
		});
	});
	return { posts, asked };
}

const openPage = async (page: Page) => {
	await page.goto('/c/c1');
	await page.getByTestId('document-card').filter({ hasText: 'page.html' }).click();
};
const replaceDraft = async (page: Page, text: string) => {
	await editor(page).fill(text);
};

test('a page is edited beside its preview, updated on request, and the frame cannot reach the app', async ({
	page
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const server = await mockPage(page);
	await openPage(page);
	await expect(canvas(page)).toBeVisible();
	await expect(frameElement(page)).toBeVisible();
	await canvas(page).getByRole('button', { name: 'Edit document' }).click();
	// From 44 rem the canvas shows the source and the preview side by side, and the View switch is gone.
	await canvas(page).getByRole('button', { name: 'Expand to the full width' }).click();
	await expect(editor(page)).toBeVisible();
	await expect(frameElement(page)).toBeVisible();
	await expect(canvas(page).getByRole('button', { name: 'Preview', exact: true })).toBeHidden();
	await expect((await frameHandle(page)).locator('#title')).toHaveText('Original');

	// Typing does not touch the frame; the chip says so; Ctrl+Enter updates it.
	await replaceDraft(page, REPORTER);
	await expect(canvas(page).getByText('Out of date')).toBeVisible();
	await expect((await frameHandle(page)).locator('#title')).toHaveText('Original');
	await editor(page).press('Control+Enter');
	await expect(canvas(page).getByText('Out of date')).toHaveCount(0);
	const inside = await frameHandle(page);
	await expect(inside.locator('#title')).toHaveText('Edited');
	// The frame ran on an opaque origin and could not read the app.
	await expect(inside.locator('#parent')).toHaveText('parent blocked');
	expect(await inside.evaluate(() => location.origin)).toBe('null');
	await expect(frameElement(page)).toHaveAttribute('sandbox', 'allow-scripts');
	await expect(frameElement(page)).not.toHaveAttribute('src', /.*/);
	// The draft only ever went into srcdoc, and never to the server before Save.
	expect(await frameElement(page).getAttribute('srcdoc')).toBe(
		REPORTER.replace('<!doctype html>', `<!doctype html>${POLICY}`)
	);
	expect(server.posts).toEqual([]);

	// Save stores the draft; the saved version is then shown through the server's policy route.
	await canvas(page).getByRole('button', { name: 'Save document' }).click();
	await expect(page.getByText('Saved as version 2')).toBeVisible();
	expect(server.posts).toEqual([REPORTER]);
	await expect.poll(() => server.asked).toContain(V2);
	await expect(editor(page)).toHaveCount(0);
	await expect((await frameHandle(page)).locator('#title')).toHaveText('Edited');
});

test('Update as I type is off until switched on, and Update preview works from the button', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await mockPage(page);
	await openPage(page);
	await canvas(page).getByRole('button', { name: 'Edit document' }).click();
	await canvas(page).getByRole('button', { name: 'Expand to the full width' }).click();
	const live = canvas(page).getByRole('switch', { name: 'Update as I type' });
	await expect(live).not.toBeChecked();
	await replaceDraft(page, '<h1 id="title">Typed</h1>');
	await page.waitForTimeout(1200);
	await expect((await frameHandle(page)).locator('#title')).toHaveText('Original');
	await live.click();
	await expect((await frameHandle(page)).locator('#title')).toHaveText('Typed', { timeout: 5000 });
	await live.click();
	await replaceDraft(page, '<h1 id="title">Button</h1>');
	await canvas(page).getByRole('button', { name: 'Update preview' }).click();
	await expect((await frameHandle(page)).locator('#title')).toHaveText('Button');
});

test('below 44 rem the View switch shows one pane at a time, and Preview shows the draft while editing', async ({
	page
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await mockPage(page);
	await openPage(page);
	await expect(sheet(page)).toBeVisible();
	await sheet(page).getByRole('button', { name: 'More actions for this document' }).click();
	await page.getByRole('menuitem', { name: 'Edit document' }).click();
	await expect(editor(page)).toBeVisible();
	await expect(frameElement(page)).toBeHidden();
	await replaceDraft(page, '<h1 id="title">Narrow</h1>');
	await sheet(page).getByRole('button', { name: 'Update preview' }).click();
	await sheet(page).getByRole('button', { name: 'Preview', exact: true }).click();
	await expect(frameElement(page)).toBeVisible();
	await expect(editor(page)).toBeHidden();
	await expect((await frameHandle(page)).locator('#title')).toHaveText('Narrow');
	// Still editing: the draft and the Save bar stay.
	await expect(sheet(page).getByRole('button', { name: 'Save document' })).toBeEnabled();
	await sheet(page).getByRole('button', { name: 'Source', exact: true }).click();
	await expect(editor(page)).toHaveValue('<h1 id="title">Narrow</h1>');
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a block of a reply can be tried, and nothing is saved', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const server = await mockPage(page);
	await page.goto('/c/c1');
	await page.getByTestId('document-card').filter({ hasText: 'HTML page' }).click();
	await expect(canvas(page)).toBeVisible();
	await canvas(page).getByRole('button', { name: 'Try changes' }).click();
	await canvas(page).getByRole('button', { name: 'Expand to the full width' }).click();
	const box = canvas(page).getByRole('textbox', { name: /^Edit / });
	await expect(box).toBeVisible();
	await expect(canvas(page).getByText('Changes to a code block are not saved. Copy or download them.')).toBeVisible();
	await expect(canvas(page).getByRole('button', { name: 'Save document' })).toHaveCount(0);
	await box.fill('<h1 id="title">Tried</h1>');
	await box.press('Control+Enter');
	await expect(canvas(page).locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
	await expect((await frameHandle(page, 'Preview of HTML page')).locator('#title')).toHaveText('Tried');
	await canvas(page).getByRole('button', { name: 'Discard changes' }).click();
	await expect(box).toHaveCount(0);
	expect(server.posts).toEqual([]);
});
