/**
 * How the API helpers turn a failed request into the error they throw.
 *
 * Every helper used to `throw await res.json()` on a bad status and then
 * throw `err.detail`. A network failure has no `detail`, and neither has the
 * SyntaxError a non-JSON body (a proxy's 502 page) raises, so the helper
 * threw `undefined`'s falsy cousin: nothing. It resolved `null`, and callers
 * reported success or lost the failure silently (#240). These two functions
 * are that pattern with the gaps closed.
 */

/** The server could not be reached at all: no response, as opposed to a refusal. */
export class ServerUnreachableError extends Error {
	constructor(cause?: unknown) {
		super('Could not reach the server', { cause });
		this.name = 'ServerUnreachableError';
	}
	// Callers show errors with `${err}`; the message alone reads better.
	toString() {
		return this.message;
	}
}

export const isServerUnreachable = (err: unknown): err is ServerUnreachableError =>
	err instanceof ServerUnreachableError;

/** An aborted request (unmount, a newer search, a timeout signal): callers usually ignore it. */
export const isAbort = (err: unknown) =>
	err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError');

/**
 * The body of a non-OK response, for `if (!res.ok) throw await errorBody(res)`.
 * JSON as the server sent it; anything else becomes `{ detail: '502 Bad Gateway' }`
 * (with the start of the text, when there is any), so it has a `detail` like
 * every other error body.
 */
export async function errorBody(res: Response): Promise<unknown> {
	const text = await res.text().catch(() => '');
	try {
		const body = JSON.parse(text);
		if (body !== null && body !== undefined) return body;
	} catch {
		// not JSON
	}
	const status = `${res.status} ${res.statusText}`.trim();
	let snippet = text
		.replace(/<[^>]*>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	// A proxy's error page usually repeats the status as its heading.
	if (snippet.startsWith(status)) snippet = snippet.slice(status.length).trim();
	snippet = snippet.slice(0, 200);
	return { detail: snippet ? `${status}: ${snippet}` : status };
}

/**
 * The failure itself, with a network failure made recognisable: for helpers
 * whose callers read the thrown error body as an object (`err.detail`), so
 * it stays as it is, but `fetch`'s TypeError becomes ServerUnreachableError.
 */
export function requestError(err: unknown): unknown {
	if (err instanceof TypeError) return new ServerUnreachableError(err);
	return err ?? new Error('Request failed');
}

/**
 * What a helper throws for a failure: the body's `detail` (FastAPI's 422
 * list joined into one line), an abort as it is, a network failure as
 * ServerUnreachableError, and anything else as itself. Never falsy, so
 * `if (error) throw error` always throws.
 */
export function errorDetail(err: unknown): unknown {
	if (isAbort(err) || err instanceof TypeError) return requestError(err);
	const detail = (err as { detail?: unknown } | null | undefined)?.detail;
	if (Array.isArray(detail)) {
		return detail.map((e: { msg?: string }) => e?.msg || JSON.stringify(e)).join(', ');
	}
	if (detail !== undefined && detail !== null && detail !== '') return detail;
	return requestError(err);
}

/**
 * A failure as one line of text, whatever shape it came in: a network
 * failure, FastAPI's `detail` (string or validation list), an OpenAI-style
 * `{ error: { message } }`, Ollama's `{ error: '...' }`, or a bare `message`.
 * For messages built around it, where an object would print as
 * "[object Object]".
 */
export function errorMessage(err: unknown, fallback = 'Request failed'): string {
	if (err instanceof TypeError || isServerUnreachable(err)) return new ServerUnreachableError(err).message;
	const e = err as Record<string, any> | null | undefined;
	const detail = errorDetail(err);
	const candidates = [
		typeof detail === 'string' ? detail : undefined,
		e?.detail?.error?.message,
		e?.detail?.message,
		typeof e?.error === 'string' ? e.error : undefined,
		e?.error?.message,
		e?.message,
		typeof err === 'string' ? err : undefined
	];
	return candidates.find((c): c is string => typeof c === 'string' && c !== '') ?? fallback;
}
