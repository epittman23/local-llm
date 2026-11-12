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

// The workspace cap and deletion dialog (owner decision Q15). Every route acts
// only on the signed-in user's own workspaces.

/** The query key of the pending workspace ids; invalidate it to ask again (a reply finishing may have hit the cap). */
export const PENDING_WORKSPACE_IDS_KEY = ['sandbox', 'pending-workspaces'] as const;

/** One file of a workspace, its path relative to `/workspace`. */
export type WorkspaceFile = { path: string; size: number; mtime: number };

/** What a workspace holds: at most a few hundred files listed, and totals over all of them. */
export type WorkspaceContents = {
	files: WorkspaceFile[];
	file_count: number;
	total_bytes: number;
	/** False when part of it could not be read, so the totals may be short. */
	complete: boolean;
};

/** Another of the user's workspaces, which a `cap` request may remove instead. */
export type OtherWorkspace = { id: string; chat_id: string; chat_title: string | null; last_used_at: number };

/** A workspace whose deletion waits for the user's answer. */
export type PendingWorkspace = {
	id: string;
	chat_id: string;
	chat_title: string | null;
	/** `cap`: the user is at the workspace limit and another chat needs one; `expired`: unused too long. */
	reason: 'cap' | 'expired';
	since: number | null;
	created_at: number;
	last_used_at: number;
	contents: WorkspaceContents | null;
	contents_error: string | null;
	/** For `cap`: the chat whose new workspace waits, and the user's other workspaces. */
	waiting_chat_id?: string | null;
	waiting_chat_title?: string | null;
	workspaces?: OtherWorkspace[];
};

export type PendingWorkspaces = {
	pending: PendingWorkspace[];
	max_workspaces: number | null;
	retention_days: number | null;
};

const authHeaders = (token: string) => ({ Accept: 'application/json', Authorization: `Bearer ${token}` });

/**
 * The ids of the user's workspaces that wait for an answer (GET
 * /sandbox/pending/ids): one cheap query, asked on load and after each reply.
 * A body without a list of ids reads as none.
 */
export const getPendingWorkspaceIds = async (token: string, signal?: AbortSignal): Promise<string[]> => {
	const res = await fetch(`${WEBUI_API_BASE_URL}/sandbox/pending/ids`, {
		headers: authHeaders(token),
		credentials: 'include',
		signal
	}).catch((err) => {
		throw requestError(err);
	});
	if (!res.ok) throw await errorBody(res);
	const body = (await res.json().catch(() => null)) as { ids?: unknown } | null;
	return Array.isArray(body?.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : [];
};

/**
 * The user's workspaces that wait for an answer, each with its contents (GET
 * /sandbox/pending). Slow when several are listed: each listing may start a
 * helper VM on the server.
 */
export const getPendingWorkspaces = async (token: string, signal?: AbortSignal): Promise<PendingWorkspaces> => {
	const res = await fetch(`${WEBUI_API_BASE_URL}/sandbox/pending`, {
		headers: authHeaders(token),
		credentials: 'include',
		signal
	}).catch((err) => {
		throw requestError(err);
	});
	if (!res.ok) throw await errorBody(res);
	const body = (await res.json()) as Partial<PendingWorkspaces> | null;
	return {
		pending: Array.isArray(body?.pending) ? body.pending : [],
		max_workspaces: body?.max_workspaces ?? null,
		retention_days: body?.retention_days ?? null
	};
};

/**
 * Answer a waiting workspace (POST /sandbox/pending/{id}): `keep` it, or
 * `remove` it; for a `cap` request, `workspace` names another of the user's
 * workspaces to remove instead. A refusal throws the response's error body.
 */
export const answerPendingWorkspace = async (
	token: string,
	id: string,
	action: 'remove' | 'keep',
	workspace?: string
): Promise<void> => {
	const res = await fetch(`${WEBUI_API_BASE_URL}/sandbox/pending/${encodeURIComponent(id)}`, {
		method: 'POST',
		headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify(workspace && workspace !== id ? { action, workspace } : { action })
	}).catch((err) => {
		throw requestError(err);
	});
	if (!res.ok) throw await errorBody(res);
};
