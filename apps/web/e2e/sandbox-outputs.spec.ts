import { json, mockChat, savedChat } from './chat-helpers';
import { expect, test } from './test';

// A 1x1 PNG.
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
	'base64'
);

// What GET /api/v1/sandbox/outputs/{id}/html sends: the policy first, then the model's document,
// whose script reports what it could reach from inside the frame.
const HTML = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'">
<p id="ran">no script</p><p id="parent"></p><p id="cookie"></p>
<script>
document.getElementById('ran').textContent = 'script ran';
try { parent.document.title; document.getElementById('parent').textContent = 'parent reached'; } catch { document.getElementById('parent').textContent = 'parent blocked'; }
try { document.cookie; document.getElementById('cookie').textContent = 'cookie reached'; } catch { document.getElementById('cookie').textContent = 'cookie blocked'; }
</script>`;

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';

/** A file id as the server makes them (a UUID), from a short hex key. */
const id = (key: string) => `00000000-0000-4000-8000-${key.padStart(12, '0')}`;
const content = (key: string) => `/api/v1/files/${id(key)}/content`;

// Each output with the type the server stores and the bytes it serves.
const FILES: Record<string, { name: string; type: string; body: Buffer | string; meta?: Record<string, unknown> }> = {
	a1: { name: 'plot.png', type: 'image/png', body: PNG },
	a2: { name: 'chart.svg', type: 'image/svg+xml', body: SVG },
	a3: { name: 'report.html', type: 'text/html', body: '<p>never served raw</p>' },
	a4: { name: 'paper.pdf', type: 'application/pdf', body: '%PDF-1.4' },
	a6: { name: 'page-2.png', type: 'image/png', body: PNG, meta: { preview_of: id('a4'), preview_page: 2 } },
	a5: { name: 'page-1.png', type: 'image/png', body: PNG, meta: { preview_of: id('a4'), preview_page: 1 } },
	a7: { name: 'model.pkl', type: 'application/octet-stream', body: 'pickle' }
};

// The Content-Type the file routes serve a sandbox output with (sandbox/outputs.py `served_type`).
const SERVED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'application/pdf'];
const served = (type: string) => (SERVED.includes(type) ? type : 'application/octet-stream');

const out = (key: string) => {
	const f = FILES[key];
	return {
		type: 'file',
		id: id(key),
		name: f.name,
		url: content(key),
		size: 100,
		meta: { source: 'sandbox_output', sandbox_path: `/workspace/outputs/${f.name}`, content_type: f.type, ...f.meta }
	};
};

test('a reply shows its sandbox outputs: images, SVG, sandboxed HTML frame, PDF previews and a download', async ({
	page
}) => {
	await mockChat(page, {
		chats: [
			savedChat('c1', 'Plots', [
				{ id: 'u1', role: 'user', content: 'Plot it' },
				{
					id: 'a1',
					role: 'assistant',
					content: 'Done.',
					model: 'qwen',
					modelName: 'Qwen',
					done: true,
					files: Object.keys(FILES).map(out)
				}
			])
		]
	});
	const asked: string[] = [];
	await page.route('**/api/v1/files/*/content*', (route) => {
		const path = new URL(route.request().url()).pathname;
		asked.push(path);
		const f = Object.entries(FILES).find(([key]) => path === content(key))?.[1];
		if (!f) return route.fulfill({ status: 404 });
		// As the server sends every sandbox output (routers/files.py): an attachment, never sniffed, inert as a page.
		return route.fulfill({
			status: 200,
			contentType: served(f.type),
			headers: {
				'Content-Disposition': `attachment; filename="${f.name}"`,
				'X-Content-Type-Options': 'nosniff',
				'Content-Security-Policy': "default-src 'none'; sandbox"
			},
			body: f.body
		});
	});
	await page.route('**/api/v1/sandbox/outputs/*/html', (route) => json(route, { html: HTML }));
	await page.goto('/c/c1');

	const reply = page.getByTestId('response-message');
	const plot = reply.getByRole('img', { name: 'plot.png' });
	await expect(plot).toHaveAttribute('src', content('a1'));
	// It renders, though the route sends it as an attachment with nosniff and a sandboxing policy.
	await expect.poll(() => plot.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1);
	// SVG too, as an <img> (never inline), which needs the route to keep its image/svg+xml type.
	const chart = reply.getByRole('img', { name: 'chart.svg' });
	await expect(chart).toHaveAttribute('src', content('a2'));
	await expect.poll(() => chart.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(10);
	await expect(reply.locator('svg:not(.lucide)')).toHaveCount(0);

	const frame = reply.locator('iframe[title="Output report.html"]');
	await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
	const inside = page.frameLocator('iframe[title="Output report.html"]');
	await expect(inside.locator('#ran')).toHaveText('script ran');
	await expect(inside.locator('#parent')).toHaveText('parent blocked');
	await expect(inside.locator('#cookie')).toHaveText('cookie blocked');

	await expect(reply.getByRole('img', { name: /^paper\.pdf, page/ })).toHaveCount(2);
	const page1 = reply.getByRole('img', { name: 'paper.pdf, page 1' });
	await expect(page1).toHaveAttribute('src', content('a5'));
	await expect.poll(() => page1.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1);
	const pdf = reply.getByTestId('sandbox-output').filter({ hasText: 'paper.pdf' });
	await expect(pdf.getByRole('link', { name: 'Download paper.pdf' })).toHaveAttribute(
		'href',
		`${content('a4')}?attachment=true`
	);
	const bin = reply.getByTestId('sandbox-output').filter({ hasText: 'model.pkl' });
	await expect(bin).toHaveAttribute('data-kind', 'download');
	await expect(bin.getByRole('link', { name: 'Download model.pkl' })).toHaveAttribute(
		'href',
		`${content('a7')}?attachment=true`
	);

	await reply.getByRole('button', { name: 'Enlarge' }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
	await expect(page.frameLocator('iframe[title="Output report.html, enlarged"]').locator('#ran')).toHaveText(
		'script ran'
	);
	// The HTML output is never fetched from the file content route.
	expect(asked).not.toContain(content('a3'));
});
