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
	const acks = new Map<number, (value: unknown) => void>();
	let nextAck = 1;
	let ready: () => void;
	const connected = new Promise<void>((r) => (ready = r));
	let refusing = false;

	await page.routeWebSocket(/\/ws\/socket\.io/, (ws) => {
		const open = () =>
			ws.send(
				JSON.stringify({
					sid: 'e1',
					upgrades: [],
					pingInterval: 25000,
					pingTimeout: 60000,
					maxPayload: 1000000
				}).replace(/^/, '0')
			);
		// Refused: the transport opens and then closes, so the client sees a failed attempt
		// and retries on its own schedule (closing before it opens leaves it waiting).
		if (refusing) {
			open();
			return void setTimeout(() => ws.close(), 50);
		}
		sockets.push(ws);
		open();
		ws.onMessage((raw) => {
			const msg = String(raw);
			if (msg.startsWith('40')) {
				ws.send('40{"sid":"s1"}');
				ready();
			} else if (msg === '2') ws.send('3');
			else if (msg.startsWith('43')) {
				const m = /^43(\d+)(.*)$/.exec(msg);
				if (m) acks.get(Number(m[1]))?.(JSON.parse(m[2])[0]);
			} else if (msg.startsWith('42')) {
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
		emitted: (event: string) => received.filter((r) => r.event === event).map((r) => r.data),
		/** Drops every connection, as a lost network would, and refuses new ones until `restore()`. */
		drop: () => {
			refusing = true;
			sockets.splice(0).forEach((ws) => ws.close());
		},
		restore: () => {
			refusing = false;
		},
		/** Sends an event that expects an acknowledgement; resolves with the client's answer. */
		emitWithAck: (event: string, data: unknown) =>
			new Promise<unknown>((resolve) => {
				const id = nextAck++;
				acks.set(id, resolve);
				sockets.forEach((ws) => ws.send(`42${id}${JSON.stringify([event, data])}`));
			})
	};
}
