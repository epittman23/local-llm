import { errorBody, requestError } from '@/lib/apis/errors';
import { WEBUI_API_BASE_URL } from '@/lib/constants';

/** One entry of a file's version list (GET /files/{id}/versions), oldest first; the original is version 1. */
export type FileVersion = {
	id: string;
	version: number;
	size: number | null;
	/** Seconds since the epoch. */
	created_at: number | null;
	name: string;
};

/** The part of the saved version's file record (POST /files/{id}/versions) the canvas reads. */
export type SavedVersion = {
	id: string;
	filename?: string;
	/** `status: 'failed'` when the server could not prepare the text for the model; the save still stands. */
	data?: { status?: string } | null;
	meta?: { version?: number; version_of?: string; size?: number; content_type?: string } | null;
};

const headers = (token: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

/**
 * The file's saved versions, oldest first (the root is version 1). `id` may
 * be the original or any version. A refusal throws the response's error body.
 */
export const listFileVersions = async (token: string, id: string, signal?: AbortSignal): Promise<FileVersion[]> => {
	const res = await fetch(`${WEBUI_API_BASE_URL}/files/${encodeURIComponent(id)}/versions`, {
		headers: headers(token),
		credentials: 'include',
		signal
	}).catch((err) => {
		throw requestError(err);
	});
	if (!res.ok) throw await errorBody(res);
	const body: unknown = await res.json();
	if (!Array.isArray(body)) throw new Error('The server sent no version list');
	return body as FileVersion[];
};

/**
 * Saves `content` as a new version of the file (text only, 256 KiB at most);
 * the original stays as it was. Throws the response's error body on a refusal.
 */
export const createFileVersion = async (token: string, id: string, content: string): Promise<SavedVersion> => {
	const res = await fetch(`${WEBUI_API_BASE_URL}/files/${encodeURIComponent(id)}/versions`, {
		method: 'POST',
		headers: headers(token),
		credentials: 'include',
		body: JSON.stringify({ content })
	}).catch((err) => {
		throw requestError(err);
	});
	if (!res.ok) throw await errorBody(res);
	const body = (await res.json()) as SavedVersion | null;
	if (typeof body?.id !== 'string') throw new Error('The server sent no version');
	return body;
};
