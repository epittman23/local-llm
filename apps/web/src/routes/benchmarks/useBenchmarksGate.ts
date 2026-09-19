import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { routePaths } from '@/routes/routePaths';

// Ports apps/openwebui/src/routes/(app)/benchmarks/+layout.svelte's own gate
// verbatim in spirit: `$user?.role !== 'admin' || $config?.features?.enable_benchmarks
// === false` redirects to `/`, with react-router's own `navigate()` -- `/`
// is one of *our* real routes (routePaths.home), so there's no reason to
// leave the SPA for it. (useAuthGate now does the same for `/auth`; it only
// used a full navigation before Phase 6, when `/auth` was still Svelte's.)
//
// Returns 'pending' while the session or config bootstrap is still in
// flight (see lib/auth/session.ts's initAuth, which fetches both), so the
// caller can render a loading state instead of a flash of the gated
// content, then either 'allowed' or 'denied'.
export function useBenchmarksGate() {
	const authStatus = useAuthStore((state) => state.status);
	const role = useAuthStore((state) => state.user?.role);
	const config = useConfigStore((state) => state.config);
	const navigate = useNavigate();
	const redirected = useRef(false);

	// Config loads *after* the session resolves (session.ts's initAuth), so
	// 'authenticated' with config still null means "config hasn't arrived
	// yet", not "no config" -- treated the same as auth's own 'pending'.
	const settled = authStatus !== 'pending' && (authStatus !== 'authenticated' || config !== null);
	const allowed = authStatus === 'authenticated' && role === 'admin' && config?.features?.enable_benchmarks !== false;

	useEffect(() => {
		if (!settled || allowed || redirected.current) return;
		redirected.current = true;
		navigate(routePaths.home, { replace: true });
	}, [settled, allowed, navigate]);

	if (!settled) return 'pending';
	return allowed ? 'allowed' : 'denied';
}
