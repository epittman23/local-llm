import { errorBody, errorDetail, requestError } from '@/lib/apis/errors';
import { WEBUI_API_BASE_URL } from '@/lib/constants';

export type SandboxStatus = { ready: boolean; reason: string | null };

/** Whether the sandbox engine can run, and if not, why (admin only). */
export const getSandboxStatus = async (token: string): Promise<SandboxStatus> => {
	let error = null;

	const res = await fetch(`${WEBUI_API_BASE_URL}/sandbox/status`, {
		method: 'GET',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`
		}
	})
		.then(async (res) => {
			if (!res.ok) throw await errorBody(res);
			return res.json();
		})
		.catch((err) => {
			console.error(err);
			error = errorDetail(err);
			return null;
		});

	if (error) {
		throw error;
	}

	return res;
};

/**
 * An HTML sandbox output with its content-security policy in front, as text
 * for an iframe's `srcdoc` (GET /sandbox/outputs/{id}/html). The route answers
 * JSON so the document never renders on the app's origin; it refuses one over
 * its size limit with 413. A refusal throws the response's error body;
 * `signal` cancels the request (the reply left the page).
 */
export const getSandboxOutputHtml = async (token: string, id: string, signal?: AbortSignal): Promise<string> => {
	const res = await fetch(`${WEBUI_API_BASE_URL}/sandbox/outputs/${encodeURIComponent(id)}/html`, {
		headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
		credentials: 'include',
		signal
	}).catch((err) => {
		throw requestError(err);
	});
	if (!res.ok) throw await errorBody(res);
	const body = (await res.json()) as { html?: unknown };
	if (typeof body?.html !== 'string') throw new Error('The server sent no document');
	return body.html;
};

/**
 * A sandbox output's start as text, at most `maxBytes` of it (GET
 * /files/{id}/content), decoded as UTF-8; `truncated` when the file is longer.
 * It stops reading at the cap, so a large file is never fetched whole, and
 * at once when `signal` aborts (the reply left the page).
 */
export const getSandboxOutputText = async (
	token: string,
	id: string,
	maxBytes: number,
	signal?: AbortSignal
): Promise<{ text: string; truncated: boolean }> => {
	const res = await fetch(`${WEBUI_API_BASE_URL}/files/${encodeURIComponent(id)}/content`, {
		headers: { Authorization: `Bearer ${token}` },
		credentials: 'include',
		signal
	}).catch((err) => {
		throw requestError(err);
	});
	if (!res.ok) throw await errorBody(res);
	const chunks: Uint8Array[] = [];
	let length = 0;
	let truncated = false;
	const reader = res.body?.getReader();
	if (reader) {
		while (length <= maxBytes) {
			if (signal?.aborted) {
				await reader.cancel().catch(() => {});
				signal.throwIfAborted();
			}
			const { value, done } = await reader.read();
			if (done) break;
			chunks.push(value);
			length += value.length;
		}
		truncated = length > maxBytes;
		if (truncated) await reader.cancel().catch(() => {});
	} else {
		const all = new Uint8Array(await res.arrayBuffer());
		chunks.push(all);
		length = all.length;
		truncated = length > maxBytes;
	}
	const bytes = new Uint8Array(Math.min(length, maxBytes));
	let at = 0;
	for (const chunk of chunks) {
		if (at >= bytes.length) break;
		const part = chunk.subarray(0, bytes.length - at);
		bytes.set(part, at);
		at += part.length;
	}
	// `stream: true` holds back a multi-byte character the cap cut in two instead of showing U+FFFD for it.
	return { text: new TextDecoder('utf-8').decode(bytes, { stream: truncated }), truncated };
};
