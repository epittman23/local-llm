// Any origin works: the target is resolved against it only to see whether
// the result stays on it.
const ORIGIN = 'http://app.invalid';

/**
 * A `?redirect=` target, if it is a path on this app: `/notes`, `/c/abc?x=1`.
 * Anything else (`https://…`, `//host/…`, `/\\host`, `javascript:…`) is
 * dropped, so signing in lands home instead of react-router throwing
 * "External navigation is not allowed" and leaving the user on the sign-in
 * form (docs/history/code-review.md L9).
 *
 * The target is resolved as a URL, as the router does, rather than checked
 * against a list of prefixes: URL parsing drops a tab or newline and reads a
 * backslash as a slash, so `/\t/host` resolves to `//host` and left the app
 * past the old prefix checks (#206). What is returned is the resolved path,
 * which resolves to itself again, so the router sees the path that was
 * checked.
 */
export function safeRedirect(target: string | null | undefined): string | null {
	if (!target?.startsWith('/')) return null;
	let url: URL;
	try {
		url = new URL(target, ORIGIN);
	} catch {
		// A target that URL cannot parse at all (`//[`) is no path here either.
		return null;
	}
	// A dot segment can leave a path starting `//` on this origin
	// (`/.//host`), which the router would then read as another host.
	if (url.origin !== ORIGIN || url.pathname.startsWith('//')) return null;
	return `${url.pathname}${url.search}${url.hash}`;
}
