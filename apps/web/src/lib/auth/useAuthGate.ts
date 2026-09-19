import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useAuthStore } from '@/lib/stores/authStore';
import { routePaths } from '@/routes/routePaths';

// Ports apps/openwebui/src/routes/(app)/+layout.svelte's own gate: `gotoAuth()`
// fires whenever `$user` is undefined/null, both on mount and reactively (its
// `$: if (loaded && ($user === undefined || $user === null)) void gotoAuth();`),
// navigating to `/auth?redirect=<currentUrl>` so the auth page can send the
// user back where they started. Ours reads useAuthStore's `status` instead of
// a nullable user, but the trigger condition and the redirect URL shape are
// the same.
//
// Uses react-router's own navigate(), not window.location -- this changed in
// Phase 6: /auth was still a SvelteKit-only page when this file was first
// written (Phase 4), so a full page navigation was the only option, same
// reasoning LegacyFallback.tsx still gives for everything it bounces to.
// Now that this app owns /auth (routes/public/AuthPage.tsx), a full reload
// just to land back in the same SPA is wasted work.
export function useAuthGate() {
	const status = useAuthStore((state) => state.status);
	const location = useLocation();
	const navigate = useNavigate();
	const currentUrl = location.pathname + location.search;

	// Guards against firing the same navigation twice for the same
	// (status, currentUrl) pair on a re-render this effect's own deps
	// wouldn't otherwise re-trigger for (e.g. a parent re-rendering for an
	// unrelated reason while still anonymous). A second identical navigate()
	// call is harmless either way, but worth guarding so a test asserting
	// "redirected once" is actually asserting that and not just getting lucky.
	const firedFor = useRef<string | null>(null);

	useEffect(() => {
		if (status !== 'anonymous') return;

		const key = `${status}:${currentUrl}`;
		if (firedFor.current === key) return;
		firedFor.current = key;

		navigate(`${routePaths.auth}?redirect=${encodeURIComponent(currentUrl)}`, { replace: true });
	}, [status, currentUrl, navigate]);

	return status;
}
