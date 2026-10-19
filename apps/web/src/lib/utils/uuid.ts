/**
 * An RFC 4122 version 4 UUID, in every context the app is served from.
 *
 * `crypto.randomUUID` exists only in secure contexts (HTTPS, or a loopback
 * host), so a page opened over plain HTTP from another machine on the LAN has
 * none, and every caller that used it threw (#241). `crypto.getRandomValues`
 * has no such restriction, and is all a v4 UUID needs. Checked on each call,
 * not once at import, so the fallback is the one used wherever randomUUID is
 * missing.
 */
export function uuid(): string {
	const c = globalThis.crypto;
	if (typeof c?.randomUUID === 'function') return c.randomUUID();

	const b = c.getRandomValues(new Uint8Array(16));
	b[6] = (b[6] & 0x0f) | 0x40; // version 4
	b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
	const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
