/**
 * The most a page may have in flight in `keepalive` request bodies, in bytes
 * (the Fetch standard's quota: a request past it fails at once).
 */
export const KEEPALIVE_QUOTA = 64 * 1024;

/**
 * The fetch options for an autosave: `{ keepalive: true }` for one sent as the
 * page goes away (a reload, a closed tab), so the browser does not cancel it
 * with the page (#675). A body past the quota goes without it, as every save
 * did before: keepalive would make it fail for certain, while without it the
 * request may still reach the server.
 */
export const keepaliveInit = (body: string, keepalive: boolean): RequestInit =>
	keepalive && new TextEncoder().encode(body).length <= KEEPALIVE_QUOTA ? { keepalive: true } : {};
