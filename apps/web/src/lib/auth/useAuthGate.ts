import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';
import { useAuthStore } from '@/lib/stores/authStore';

// Ports apps/openwebui/src/routes/(app)/+layout.svelte's own gate: `gotoAuth()`
// fires whenever `$user` is undefined/null, both on mount and reactively (its
// `$: if (loaded && ($user === undefined || $user === null)) void gotoAuth();`),
// navigating to `/auth?redirect=<currentUrl>` so the auth page can send the
// user back where they started. Ours reads useAuthStore's `status` instead of
// a nullable user, but the trigger condition and the redirect URL shape are
// the same. A full `window.location` navigation, not react-router's: `/auth`
// is still a SvelteKit page (Phase 6 owns porting it), so react-router has no
// route to hand this to, same reasoning as LegacyFallback.tsx.
export function useAuthGate() {
	const status = useAuthStore((state) => state.status);
	const location = useLocation();
	const currentUrl = location.pathname + location.search;

	// Guards against firing the same navigation twice for the same
	// (status, currentUrl) pair on a re-render this effect's own deps
	// wouldn't otherwise re-trigger for (e.g. a parent re-rendering for an
	// unrelated reason while still anonymous). Harmless in a real browser
	// either way -- a second identical window.location.assign is a no-op,
	// the first one already started navigating away -- but worth guarding
	// so a test asserting "redirected once" is actually asserting that and
	// not just getting lucky.
	const firedFor = useRef<string | null>(null);

	useEffect(() => {
		if (status !== 'anonymous') return;

		const key = `${status}:${currentUrl}`;
		if (firedFor.current === key) return;
		firedFor.current = key;

		window.location.assign(`/auth?redirect=${encodeURIComponent(currentUrl)}`);
	}, [status, currentUrl]);

	return status;
}
