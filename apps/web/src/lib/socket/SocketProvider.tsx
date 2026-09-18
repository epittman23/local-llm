// Ports the connection lifecycle from apps/openwebui/src/routes/+layout.svelte's
// setupSocket() (roughly lines 165-250): same io() options, same auth token,
// same connect/disconnect/reconnect_attempt/reconnect_failed handling and
// heartbeat. Dropped, deliberately, because their prerequisites don't exist in
// this app yet: the "Reconnected"/"Connection lost" toasts (no toast system --
// see lib/auth/session.ts's own note), the version-mismatch auto-reload (needs
// the WEBUI_VERSION/WEBUI_DEPLOYMENT_ID stores this phase doesn't port), and the
// websocket_heartbeat_interval config read (needs the backend config store) --
// the heartbeat here runs on the same 30s literal Open WebUI itself defaults to
// when that config value is absent. All of these are real gaps, not silent
// ones: whichever later phase adds a toast system or the config store should
// wire them back in here rather than re-deriving this connection logic.

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { WEBUI_BASE_URL } from '@/lib/constants';
import { useAuthStore } from '@/lib/stores/authStore';

const HEARTBEAT_INTERVAL_MS = 30000;

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

		socket.on('connect_error', (err) => {
			console.log('connect_error', err);
		});

		socket.on('connect', () => {
			console.log('connected', socket.id);
			setConnected(true);

			socket.emit('user-join', { auth: { token } });

			heartbeatInterval = setInterval(() => {
				if (socket.connected) {
					socket.emit('heartbeat', {});
				}
			}, HEARTBEAT_INTERVAL_MS);
		});

		socket.on('reconnect_attempt', (attempt) => {
			console.log('reconnect_attempt', attempt);
		});

		socket.on('reconnect_failed', () => {
			console.log('reconnect_failed');
		});

		socket.on('disconnect', (reason) => {
			console.log(`Socket ${socket.id} disconnected due to ${reason}`);
			setConnected(false);
			if (heartbeatInterval) {
				clearInterval(heartbeatInterval);
				heartbeatInterval = null;
			}
		});

		return () => {
			if (heartbeatInterval) clearInterval(heartbeatInterval);
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
