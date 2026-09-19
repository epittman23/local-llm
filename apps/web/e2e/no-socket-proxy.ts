import type { Page } from '@playwright/test';

/**
 * Keeps the app's Socket.IO connection from reaching the dev server's `/ws`
 * proxy. With no backend on :4000 (which is every e2e run), that proxied
 * websocket fails, and Vite's proxy error handler then calls
 * `socket.destroySoon()` -- which Bun's socket does not implement. The
 * resulting TypeError takes the whole `astro dev` process down, a few seconds
 * in, and every test still running fails with ERR_CONNECTION_REFUSED.
 *
 * Short specs finished before it fired, which is how this went unnoticed
 * through Phases 5 and 6; it needs a run of ~30s to show. Answering the
 * websocket here (and never completing the Socket.IO handshake) means the
 * request never gets proxied at all.
 */
export async function blockSocketProxy(page: Page) {
	await page.routeWebSocket(/\/ws\//, () => {
		/* accept and stay silent: no handshake, no proxy */
	});
}
