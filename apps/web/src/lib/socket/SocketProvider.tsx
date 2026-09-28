// Ports the connection lifecycle from d863707:apps/openwebui/src/routes/+layout.svelte's
// setupSocket() (roughly lines 118-250): same io() options, same auth token,
// same connect/disconnect/reconnect_attempt/reconnect_failed handling and
// heartbeat, and its "Connection lost. Reconnecting..." / "Reconnected" toasts
// (docs/code-review.md L12; the Svelte app's extra grace period after a tab
// resumes is left out). Still not ported: the version-mismatch auto-reload
// (needs the WEBUI_VERSION/WEBUI_DEPLOYMENT_ID stores) and the
// websocket_heartbeat_interval config read; the heartbeat runs on the same 30s
// literal Open WebUI itself defaults to when that config value is absent.

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { toast } from 'sonner';
import { WEBUI_BASE_URL } from '@/lib/constants';
import { useAuthStore } from '@/lib/stores/authStore';

const HEARTBEAT_INTERVAL_MS = 30000;
/** A drop shorter than this (a quick reconnect) is not worth a toast. */
const DISCONNECT_TOAST_DELAY_MS = 2000;

type SocketContextValue = {
	socket: Socket | null;
	connected: boolean;
};

const SocketContext = createContext<SocketContextValue>({ socket: null, connected: false });

export const useSocket = () => useContext(SocketContext);

/**
 * Mounted once at the app root (see src/components/App.tsx), inside
 * react-router's persistent root, so the connection survives client-side
 * navigation instead of being torn down and re-established per route.
 */
export function SocketProvider({ children }: { children: React.ReactNode }) {
	const token = useAuthStore((state) => state.token);
	const [connected, setConnected] = useState(false);
	const socketRef = useRef<Socket | null>(null);

	useEffect(() => {
		if (!token) return;

		const socket = io(WEBUI_BASE_URL || undefined, {
			reconnection: true,
			reconnectionDelay: 1000,
			reconnectionDelayMax: 5000,
			randomizationFactor: 0.5,
			path: '/ws/socket.io',
			transports: ['websocket', 'polling'],
			auth: { token }
		});
		socketRef.current = socket;

		let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
		let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
		let warned = false;
		const clearDisconnectTimer = () => {
			if (disconnectTimer) clearTimeout(disconnectTimer);
			disconnectTimer = null;
		};

		socket.on('connect_error', (err) => {
			console.log('connect_error', err);
		});

		socket.on('connect', () => {
			console.log('connected', socket.id);
			setConnected(true);
			clearDisconnectTimer();
			// Only after the reader saw the warning.
			if (warned) toast.success('Reconnected');
			warned = false;

			socket.emit('user-join', { auth: { token } });

			heartbeatInterval = setInterval(() => {
				if (socket.connected) {
					socket.emit('heartbeat', {});
				}
			}, HEARTBEAT_INTERVAL_MS);
		});

		// Manager events in socket.io-client v4: registered on `socket.io`, not
		// on the socket, or they never fire.
		const onReconnectAttempt = (attempt: number) => console.log('reconnect_attempt', attempt);
		const onReconnectFailed = () => console.log('reconnect_failed');
		socket.io.on('reconnect_attempt', onReconnectAttempt);
		socket.io.on('reconnect_failed', onReconnectFailed);

		socket.on('disconnect', (reason) => {
			console.log(`Socket ${socket.id} disconnected due to ${reason}`);
			setConnected(false);
			if (heartbeatInterval) {
				clearInterval(heartbeatInterval);
				heartbeatInterval = null;
			}
			// A connection that dropped, not one this client closed (sign-out, a new token).
			// Once per outage: a failed reconnect attempt can report another disconnect.
			if (reason === 'io client disconnect' || disconnectTimer || warned) return;
			disconnectTimer = setTimeout(() => {
				disconnectTimer = null;
				if (socket.connected || document.visibilityState !== 'visible') return;
				warned = true;
				toast.warning('Connection lost. Reconnecting...');
			}, DISCONNECT_TOAST_DELAY_MS);
		});

		return () => {
			socket.io.off('reconnect_attempt', onReconnectAttempt);
			socket.io.off('reconnect_failed', onReconnectFailed);
			if (heartbeatInterval) clearInterval(heartbeatInterval);
			clearDisconnectTimer();
			socket.disconnect();
			socketRef.current = null;
			setConnected(false);
		};
	}, [token]);

	return (
		<SocketContext.Provider value={{ socket: socketRef.current, connected }}>
			{children}
		</SocketContext.Provider>
	);
}
