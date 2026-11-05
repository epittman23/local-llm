import { render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/lib/stores/authStore';
import { SocketProvider, useSocket } from './SocketProvider';

// #519: the backend joins the user's room while the socket connects, so an
// event can arrive in the same moment. A listener that attaches only after
// that missed it.

type Handler = (...args: unknown[]) => void;

/** Enough of a socket.io-client Socket: handlers, and a connect that a server answers at once. */
class FakeSocket {
	handlers = new Map<string, Handler[]>();
	connected = false;
	id = 's1';
	io = { on: vi.fn(), off: vi.fn() };
	on(event: string, h: Handler) {
		this.handlers.set(event, [...(this.handlers.get(event) ?? []), h]);
		return this;
	}
	off(event: string, h: Handler) {
		this.handlers.set(
			event,
			(this.handlers.get(event) ?? []).filter((x) => x !== h)
		);
		return this;
	}
	emit = vi.fn();
	fire(event: string, ...args: unknown[]) {
		for (const h of this.handlers.get(event) ?? []) h(...args);
	}
	/** Connected, then the first event the server sends, with nothing in between. */
	connect() {
		this.connected = true;
		this.fire('connect');
		this.fire('events', { data: { type: 'first' } });
		return this;
	}
	disconnect = vi.fn(() => {
		this.connected = false;
		return this;
	});
}

const made: FakeSocket[] = [];
vi.mock('socket.io-client', () => ({
	io: (_url: unknown, opts: { autoConnect?: boolean }) => {
		const s = new FakeSocket();
		made.push(s);
		// As the real client does: connect on its own unless told not to.
		if (opts?.autoConnect !== false) queueMicrotask(() => s.connect());
		return s;
	}
}));

function Listener({ seen }: { seen: unknown[] }) {
	const { socket } = useSocket();
	useEffect(() => {
		if (!socket) return;
		const on = (e: unknown) => seen.push(e);
		socket.on('events', on);
		return () => void socket.off('events', on);
	}, [socket, seen]);
	return null;
}

/** The socket the provider last gave its children. */
let current: unknown = 'unset';
function Probe() {
	current = useSocket().socket;
	return null;
}

describe('SocketProvider', () => {
	beforeEach(() => useAuthStore.setState({ token: 't' } as never));
	afterEach(() => {
		useAuthStore.setState({ token: null } as never);
		made.length = 0;
	});

	it('gives the socket to its children before it connects, so the first event is not lost (#519)', async () => {
		const seen: unknown[] = [];
		render(
			<SocketProvider>
				<Listener seen={seen} />
			</SocketProvider>
		);

		await waitFor(() => expect(made[0]?.connected).toBe(true));
		expect(seen).toEqual([{ data: { type: 'first' } }]);
	});

	it('still joins the user room on connect, with the token', async () => {
		render(
			<SocketProvider>
				<Listener seen={[]} />
			</SocketProvider>
		);

		await waitFor(() => expect(made[0]?.connected).toBe(true));
		expect(made[0].emit).toHaveBeenCalledWith('user-join', { auth: { token: 't' } });
	});

	it('disconnects on sign-out and gives its children no socket', async () => {
		render(
			<SocketProvider>
				<Probe />
			</SocketProvider>
		);
		await waitFor(() => expect(made[0]?.connected).toBe(true));
		expect(current).toBe(made[0]);

		useAuthStore.setState({ token: null } as never);

		await waitFor(() => expect(current).toBeNull());
		expect(made[0].disconnect).toHaveBeenCalled();
	});
});
