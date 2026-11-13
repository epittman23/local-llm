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
// `media` is granted for audio only: the camera is never granted, and a media
// request that names no type is refused.
const ALLOWED_PERMISSIONS = new Set([
	'notifications',
	'clipboard-read',
	'clipboard-sanitized-write',
	'media',
	'fullscreen'
]);

export function isAllowedPermission(
	permission: string,
	requestingUrl: string,
	appOrigin: string,
	mediaTypes: readonly string[] = []
): boolean {
	if (!ALLOWED_PERMISSIONS.has(permission) || !isAppUrl(requestingUrl, appOrigin)) return false;
	if (permission === 'media') return mediaTypes.length > 0 && mediaTypes.every((type) => type === 'audio');
	return true;
}

/** Whether a URL is a document of the page's own making: `about:srcdoc` (an iframe's `srcdoc`) or `about:blank`. */
function isInlineDocument(url: string): boolean {
	const parsed = parse(url);
	const path = parsed?.pathname.toLowerCase();
	return parsed?.protocol === 'about:' && (path === 'srcdoc' || path === 'blank');
}

/**
 * Whether a sub-frame may navigate. A frame showing an inline document (a
 * sandbox output's HTML is an `about:srcdoc` iframe; an iframe starts as
 * `about:blank`) may go only to another inline document, unless the app's own
 * page starts the navigation, as when an iframe's `src` loads. Otherwise
 * model-written script in the frame could send what it holds to any URL by
 * navigating itself, which neither the iframe's `sandbox` flags nor the
 * document's content-security policy stop (docs/guides/sandbox.md, "Outputs").
 * This covers navigation only: WebRTC from the frame is beyond both it and CSP.
 * `frameUrl` is the frame's current URL, empty before its first document;
 * `initiatorOrigin` is the origin of the frame that started the navigation, if
 * any (a sandboxed frame's is "null").
 */
export function isAllowedFrameNavigation(
	frameUrl: string,
	url: string,
	initiatorOrigin: string | null,
	appOrigin: string
): boolean {
	if (frameUrl !== '' && !isInlineDocument(frameUrl)) return true;
	return isInlineDocument(url) || initiatorOrigin === appOrigin;
}
