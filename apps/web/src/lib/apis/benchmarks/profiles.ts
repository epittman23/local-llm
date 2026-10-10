// New code, not a port: backend/open_webui/routers/benchmarks/profiles.py's
// CRUD endpoints (list, get, get-default, list-versions, create, clone,
// add-version, set-display-name, set-default, archive, unarchive) have no
// SvelteKit frontend at all -- see this file's own docstring, and decision
// 11 in docs/history/migration-plan.md ("Full CRUD from the Serve page"), which the
// existing Serve.svelte never actually built. Follows the same fetch/error
// shape as the rest of d863707:apps/openwebui/src/lib/apis/benchmarks/index.ts
// (ported verbatim elsewhere) so this reads as one module, not two styles.

import { WEBUI_API_BASE_URL } from '@/lib/constants';

const BASE = `${WEBUI_API_BASE_URL}/benchmarks/profiles`;

/**
 * A FastAPI error `detail` as one readable string: a 422's list of
 * `{loc, msg}` objects otherwise reached the page as "[object Object]".
 */
export function errorMessage(detail: unknown): string {
	if (typeof detail === 'string') return detail;
	if (Array.isArray(detail))
		return detail
			.map((d) => {
				const loc = Array.isArray(d?.loc) ? d.loc.filter((p: unknown) => p !== 'body').join('.') : '';
				return loc ? `${loc}: ${d?.msg ?? d}` : String(d?.msg ?? d);
			})
			.join('; ');
	if (detail instanceof Error) return detail.message;
	return String(detail ?? 'Request failed');
}

/**
 * Unlike the ported helpers, this always throws on failure -- a network error
 * or a non-JSON error body included -- so a caller never mistakes `null` for
 * success (docs/history/bug-review-2026-09-27.md L7). What it throws is a string.
 */
const request = async (path: string, token: string, init?: RequestInit) => {
	let res: Response;
	try {
		res = await fetch(`${BASE}${path}`, {
			...init,
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				authorization: `Bearer ${token}`,
				...init?.headers
			}
		});
	} catch (err) {
		throw errorMessage(err);
	}
	const body = await res.json().catch(() => null);
	if (!res.ok) throw errorMessage(body?.detail ?? body ?? `${res.status} ${res.statusText}`);
	return body;
};

export type ProfileDefinition = {
	arch: string;
	alias: string;
	model_path: string;
	hf_repo?: string;
	hf_pattern?: string;
	ctx: number;
	threads: number;
	ngl: number;
	moe?: number | null;
	override_tensors?: string | null;
	parallel?: number;
	cache_k?: string;
	cache_v?: string;
	batch?: number;
	ubatch?: number;
	spec?: string[];
	samplers?: string[];
	extra?: string[];
	reasoning_effort_default?: string | null;
	notes?: string;
};

export type ProfileModel = {
	profile_id: number;
	name: string;
	display_name: string;
	is_default: boolean;
	created_at: number;
	archived_at: number | null;
};

export type ProfileVersionModel = ProfileDefinition & {
	version_id: number;
	profile_id: number;
	version: number;
	created_at: number;
	created_by: string | null;
	note: string | null;
};

export type ProfileEntry = {
	profile: ProfileModel;
	version: ProfileVersionModel;
};

export const listProfiles = async (token: string = '', includeArchived: boolean = false): Promise<ProfileEntry[]> =>
	request(`/?include_archived=${includeArchived}`, token, { method: 'GET' });

export const getProfile = async (token: string = '', name: string): Promise<ProfileEntry> =>
	request(`/${encodeURIComponent(name)}`, token, { method: 'GET' });

export const listProfileVersions = async (token: string = '', name: string): Promise<ProfileVersionModel[]> =>
	request(`/${encodeURIComponent(name)}/versions`, token, { method: 'GET' });

export const createProfile = async (
	token: string = '',
	form: { name: string; display_name: string; definition: ProfileDefinition; note?: string }
): Promise<ProfileEntry> => request('/', token, { method: 'POST', body: JSON.stringify(form) });

export const cloneProfile = async (
	token: string = '',
	name: string,
	form: { name: string; display_name: string; note?: string }
): Promise<ProfileEntry> =>
	request(`/${encodeURIComponent(name)}/clone`, token, {
		method: 'POST',
		body: JSON.stringify(form)
	});

export const addProfileVersion = async (
	token: string = '',
	name: string,
	form: { definition: ProfileDefinition; note?: string }
): Promise<ProfileEntry> =>
	request(`/${encodeURIComponent(name)}/versions`, token, {
		method: 'POST',
		body: JSON.stringify(form)
	});

export const setProfileDisplayName = async (
	token: string = '',
	name: string,
	displayName: string
): Promise<ProfileEntry> =>
	request(`/${encodeURIComponent(name)}/display-name`, token, {
		method: 'POST',
		body: JSON.stringify({ display_name: displayName })
	});

export const setDefaultProfile = async (token: string = '', name: string): Promise<ProfileEntry> =>
	request(`/${encodeURIComponent(name)}/default`, token, { method: 'POST' });

export const archiveProfile = async (token: string = '', name: string): Promise<ProfileEntry> =>
	request(`/${encodeURIComponent(name)}/archive`, token, { method: 'POST' });

export const unarchiveProfile = async (token: string = '', name: string): Promise<ProfileEntry> =>
	request(`/${encodeURIComponent(name)}/unarchive`, token, { method: 'POST' });
