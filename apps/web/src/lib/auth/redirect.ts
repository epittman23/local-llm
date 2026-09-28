/**
 * A `?redirect=` target, if it is a path on this app: `/notes`, `/c/abc?x=1`.
 * Anything else (`https://…`, `//host/…`, `/\\host`, `javascript:…`) is
 * dropped, so signing in lands home instead of react-router throwing
 * "External navigation is not allowed" and leaving the user on the sign-in
 * form (docs/code-review.md L9).
 */
export function safeRedirect(target: string | null | undefined): string | null {
	if (!target || !target.startsWith('/') || target.startsWith('//') || target.startsWith('/\\')) return null;
	return target;
}
