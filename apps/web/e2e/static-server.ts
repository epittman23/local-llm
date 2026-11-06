/**
 * Serves the e2e build (playwright.config.ts's webServer builds it first) the
 * way production serves `dist`, so the specs run against the bundle that
 * ships rather than `astro dev`'s unbundled modules, which a fresh browser
 * context fetches one by one on every page load.
 *
 * - A file that exists is served as is, and a directory as its index.html.
 * - Anything else falls back to index.html, as main.py's SPAStaticFiles mount
 *   does, except a missing `.js`, which stays a 404 there too.
 * - The paths `make backend` answers itself, and which astro.config.mjs
 *   proxies to it in dev, answer 502: what Vite's proxy returns when nothing
 *   listens on :4000, which is every e2e run. A spec that leaves one of them
 *   unmocked sees the same failure it saw under the dev server.
 *
 * Usage: bun e2e/static-server.ts <dir> <port>
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const [root, port] = [process.argv[2], Number(process.argv[3])];
if (!root || !port) throw new Error('usage: bun e2e/static-server.ts <dir> <port>');

const backendPrefixes = ['/api', '/ollama', '/openai', '/oauth', '/static', '/ws'];

const types: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json',
	'.csv': 'text/csv; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.mp3': 'audio/mpeg',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf'
};

async function find(path: string): Promise<string | null> {
	try {
		const info = await stat(path);
		if (info.isFile()) return path;
		if (info.isDirectory()) return find(join(path, 'index.html'));
	} catch {
		// Missing: the caller falls back.
	}
	return null;
}

createServer(async (request, response) => {
	let path: string;
	try {
		path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
	} catch {
		// A malformed escape: thrown here, it would end the server for the rest
		// of the run.
		response.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad Request');
		return;
	}
	if (backendPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
		response.writeHead(502, { 'Content-Type': 'text/plain' }).end();
		return;
	}
	// normalize() before join() keeps a `..` segment inside root.
	let file = await find(join(root, normalize(`/${path}`)));
	if (!file && path.endsWith('.js')) {
		response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not Found');
		return;
	}
	file ??= join(root, 'index.html');
	response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
	createReadStream(file).pipe(response);
}).listen(port, 'localhost', () => console.log(`e2e static server: ${root} on http://localhost:${port}`));
