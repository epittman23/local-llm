import { useEffect } from 'react';
import { initAuth } from '@/lib/auth/session';

/**
 * Owns the session bootstrap's lifecycle: mounted once at the app root
 * (see src/components/App.tsx), it starts initAuth() and stops the
 * expiry-check timer on unmount. Renders children immediately -- the
 * route gate (Phase 4's routing shell) is what actually waits on
 * useAuthStore().status before deciding what to show.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
	useEffect(() => {
		let cleanup: (() => void) | undefined;
		let cancelled = false;

		initAuth().then((stop) => {
			if (cancelled) {
				stop();
			} else {
				cleanup = stop;
			}
		});

		return () => {
			cancelled = true;
			cleanup?.();
		};
	}, []);

	return children;
}
