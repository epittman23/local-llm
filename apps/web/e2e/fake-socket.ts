import type { Page, WebSocketRoute } from '@playwright/test';

/**
 * A minimal Socket.IO server for specs that need live events: it answers the
 * app's websocket (Engine.IO v4, default namespace), records what the client
 * emits, and lets the spec push events to it. Registered after the fixture's
 * silent block in no-socket-proxy.ts, so it takes precedence for this page.
 * Like that block it never lets the request reach the dev server's proxy.
 */
export async function fakeSocketServer(page: Page) {
	const sockets: WebSocketRoute[] = [];
	const received: { event: string; data: any }[] = [];
	let ready: () => void;
	const connected = new Promise<void>((r) => (ready = r));

	await page.routeWebSocket(/\/ws\/socket\.io/, (ws) => {
		sockets.push(ws);
		ws.send(JSON.stringify({ sid: 'e1', upgrades: [], pingInterval: 25000, pingTimeout: 60000, maxPayload: 1000000 }).replace(/^/, '0'));
		ws.onMessage((raw) => {
			const msg = String(raw);
			if (msg.startsWith('40')) {
				ws.send('40{"sid":"s1"}');
				ready();
			} else if (msg === '2') ws.send('3');
			else if (msg.startsWith('42')) {
				const [event, data] = JSON.parse(msg.slice(2));
				received.push({ event, data });
			}
		});
	});

	return {
		connected,
		received,
		/** Sends an event to every connected client. */
		emit: (event: string, data: unknown) => sockets.forEach((ws) => ws.send(`42${JSON.stringify([event, data])}`)),
		emitted: (event: string) => received.filter((r) => r.event === event).map((r) => r.data)
	};
}
