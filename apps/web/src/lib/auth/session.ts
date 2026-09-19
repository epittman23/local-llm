// Ports apps/openwebui/src/routes/+layout.svelte's token-expiry/401-detection
// pattern (its `clearExpiredSession`/`checkTokenExpiry`/`isAuthenticatedBackendFetch`/
// `isCurrentSessionUnauthorized`, roughly lines 879-1079), which is genuinely new
// infrastructure for this app rather than a port of any $lib/apis module: the
// SvelteKit app has no shared fetch wrapper either, and Phase 4's own checklist
// (docs/migration-plan.md) calls for one. Behavior kept identical; the toast
// notifications on session expiry are dropped -- there is no toast system in
// this app yet, so a session expiry is a console.warn until one exists.

import { getBackendConfig } from '@/lib/apis';
import { getSessionUser, userSignOut } from '@/lib/apis/auths';
import { WEBUI_API_BASE_URL, WEBUI_BASE_URL } from '@/lib/constants';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';

const TOKEN_EXPIRY_BUFFER = 60; // seconds
const TOKEN_CHECK_INTERVAL_MS = 15000;

let tokenTimer: ReturnType<typeof setInterval> | null = null;
let isAuthRedirectInProgress = false;
let fetchGuardInstalled = false;

const resolveFetchUrl = (input: RequestInfo | URL) => {
	if (input instanceof Request) {
		return new URL(input.url, window.location.origin);
	}
	return new URL(input as string | URL, window.location.origin);
};

const resolveFetchHeaders = (input: RequestInfo | URL, init?: RequestInit) => {
	if (init?.headers) {
		return new Headers(init.headers);
	}
	if (input instanceof Request) {
		return input.headers;
	}
	return new Headers();
};

const isAuthenticatedBackendFetch = (input: RequestInfo | URL, init?: RequestInit) => {
	try {
		const requestUrl = resolveFetchUrl(input);
		const backendOrigin = new URL(WEBUI_BASE_URL || '/', window.location.origin).origin;

		return (
			requestUrl.origin === backendOrigin && resolveFetchHeaders(input, init).has('authorization')
		);
	} catch {
		return false;
	}
};

const isCurrentSessionUnauthorized = async (originalFetch: typeof fetch) => {
	return originalFetch(`${WEBUI_API_BASE_URL}/auths/`, {
		method: 'GET',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${localStorage.token}`
		},
		credentials: 'include'
	})
		.then((res) => res.status === 401)
		.catch(() => false);
};

const stopTokenTimer = () => {
	if (tokenTimer) {
		clearInterval(tokenTimer);
		tokenTimer = null;
	}
};

/** Clears the session and signs out, as if the token had expired server-side. */
export const clearExpiredSession = () => {
	if (isAuthRedirectInProgress) return;

	isAuthRedirectInProgress = true;
	stopTokenTimer();
	useAuthStore.getState().clearSession();
	localStorage.removeItem('token');
	// Clears the OAuth token cookie so /auth doesn't auto-login and redirect-loop.
	document.cookie = 'token=; Max-Age=0; path=/';
	userSignOut().catch((error) => {
		console.error('Error signing out expired session:', error);
	});
	console.warn('Session expired. Please sign in again.');
	isAuthRedirectInProgress = false;
};

/** A voluntary sign-out, as opposed to clearExpiredSession's involuntary one. */
export const signOut = async () => {
	stopTokenTimer();
	useAuthStore.getState().clearSession();
	localStorage.removeItem('token');
	document.cookie = 'token=; Max-Age=0; path=/';
	await userSignOut().catch((error) => {
		console.error('Error signing out:', error);
	});
};

const checkTokenExpiry = () => {
	const exp = useAuthStore.getState().user?.expires_at;
	if (!exp) return;

	const now = Math.floor(Date.now() / 1000);
	if (now >= exp - TOKEN_EXPIRY_BUFFER) {
		clearExpiredSession();
	}
};

/** Installs the global 401-detection wrapper exactly once per page load. */
const installAuthFetchGuard = () => {
	if (fetchGuardInstalled || typeof window === 'undefined') return;
	fetchGuardInstalled = true;

	const originalFetch = window.fetch.bind(window);
	window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const response = await originalFetch(input, init);

		if (
			response.status === 401 &&
			localStorage.token &&
			isAuthenticatedBackendFetch(input, init) &&
			(await isCurrentSessionUnauthorized(originalFetch))
		) {
			clearExpiredSession();
		}

		return response;
	};
};

/**
 * Bootstraps the session from localStorage.token: fetches the current user,
 * populates useAuthStore, starts the expiry-check timer, and installs the
 * fetch guard. Safe to call once from the app root. Returns a cleanup
 * function that stops the timer (the fetch guard and its module-level
 * dedup flag are process-lifetime, matching the SvelteKit app's own
 * per-page-load `window.fetch` patch).
 */
export const initAuth = async () => {
	installAuthFetchGuard();

	// Fetched unconditionally, before any session check -- matching
	// +layout.svelte's own onMount exactly (getBackendConfig() runs first
	// thing, session or not: "Initialize i18n even if we didn't get a
	// backend config, so /error can show something that's not undefined").
	// This was wrongly gated behind a successful session restore until
	// Phase 6 needed it: main.py's own /api/config groups `auth`,
	// `enable_login_form`, `enable_ldap`, `enable_signup`, and `oauth`/
	// `onboarding` under "Public: required by login/signup page pre-auth"
	// (read directly, not inferred) -- an anonymous visitor landing on
	// /auth needs exactly these fields before any session exists, and the
	// old gated-fetch version never gave them one.
	try {
		const backendConfig = await getBackendConfig();
		if (backendConfig) {
			useConfigStore.getState().setConfig(backendConfig);
		}
	} catch (error) {
		console.error('Failed to load backend config:', error);
	}

	const token = localStorage.getItem('token');
	if (!token) {
		useAuthStore.getState().clearSession();
		return () => stopTokenTimer();
	}

	try {
		const sessionUser = await getSessionUser(token);
		useAuthStore.getState().setSession(token, sessionUser);
	} catch (error) {
		console.error('Failed to restore session:', error);
		useAuthStore.getState().clearSession();
		localStorage.removeItem('token');
		return () => stopTokenTimer();
	}

	stopTokenTimer();
	tokenTimer = setInterval(checkTokenExpiry, TOKEN_CHECK_INTERVAL_MS);

	return () => stopTokenTimer();
};
