// What the app window may do with a URL or a permission request. The window
// shows the server's own pages and nothing else: other sites open in the
// system browser, and only the server's origin gets the few permissions the
// app uses. Pure, so it is unit-tested directly.

export type OpenDecision = 'in-app' | 'external' | 'deny';

function parse(url: string): URL | null {
	try {
		return new URL(url);
	} catch {
		return null;
	}
}

export function isAppUrl(url: string, appOrigin: string): boolean {
	return parse(url)?.origin === appOrigin;
}

/** Where a navigation or `window.open` goes: the app, the system browser, or nowhere. */
export function classifyOpen(url: string, appOrigin: string): OpenDecision {
	const parsed = parse(url);
	if (!parsed) return 'deny';
	if (parsed.origin === appOrigin) return 'in-app';
	if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') return 'external';
	return 'deny';
}

// Notifications (chat and channel alerts), the clipboard (copy buttons and
// pasting), the microphone (voice input), and fullscreen (video, artifacts).
const ALLOWED_PERMISSIONS = new Set([
	'notifications',
	'clipboard-read',
	'clipboard-sanitized-write',
	'media',
	'fullscreen'
]);

export function isAllowedPermission(permission: string, requestingUrl: string, appOrigin: string): boolean {
	return ALLOWED_PERMISSIONS.has(permission) && isAppUrl(requestingUrl, appOrigin);
}
