import { normalizeTags, type Tag } from '@/lib/utils/tags';

// The rules behind AddConnectionModal.svelte, pulled out of the component so they
// can be tested and shared with the Phase 10 Direct Connections UI, which reuses
// the same modal with `direct` set.

export type ConnectionConfig = Record<string, any>;
export type Connection = { url: string; key: string; config: ConnectionConfig };

export type ConnectionFields = {
	url: string;
	key: string;
	authType: string;
	connectionType: string;
	provider: string;
	prefixId: string;
	enable: boolean;
	apiVersion: string;
	apiType: string;
	headers: string;
	passthroughParams: string;
	tags: Tag[];
	modelIds: string[];
};

export type ConnectionMode = { ollama: boolean; direct: boolean };

/**
 * Whether a URL's host looks like an Azure AI endpoint: an `azure` label with
 * more after it (`my.openai.azure.com`, `x.services.ai.azure.com`) or the
 * legacy `cognitive.microsoft.com`. This only presets the form's Azure fields,
 * it is not a trust decision; it checks the parsed hostname so `azure.` in a
 * path or query doesn't count. A URL typed without a scheme is read as
 * https; one that still doesn't parse isn't Azure yet.
 */
const isAzureHost = (url: string) => {
	let host: string;
	try {
		host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
	} catch {
		return false;
	}
	return (
		/(^|\.)azure\.[a-z0-9-]/.test(host) ||
		host === 'cognitive.microsoft.com' ||
		host.endsWith('.cognitive.microsoft.com')
	);
};

/** Azure OpenAI is chosen explicitly, or guessed from an Azure host (never for direct connections, or the `/openai/v1` compatibility path). */
export const isAzure = (provider: string, url: string, direct: boolean) =>
	provider === 'azure' || (isAzureHost(url) && !direct && provider === '' && !/\/openai\/v1(\/|$)/.test(url));

/** `"thinking, output_config"` -> `['thinking','output_config']`. */
export const parsePassthroughParams = (value: string) =>
	value
		.split(',')
		.map((p) => p.trim())
		.filter(Boolean);

/**
 * Headers are typed as JSON and must be an object. Empty is fine (null); the
 * returned `text` is the same object pretty-printed, which the form puts back
 * in the box.
 */
export function parseHeaders(text: string): { value: Record<string, unknown> | null; text: string } {
	if (!text.trim()) return { value: null, text };
	const parsed = JSON.parse(text);
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
		throw new Error('Headers must be a valid JSON object');
	return { value: parsed, text: JSON.stringify(parsed, null, 2) };
}

export const blankFields = (): ConnectionFields => ({
	url: '',
	key: '',
	authType: 'bearer',
	connectionType: 'external',
	provider: '',
	prefixId: '',
	enable: true,
	apiVersion: '',
	apiType: '',
	headers: '',
	passthroughParams: '',
	tags: [],
	modelIds: []
});

/** The form's starting values for an existing connection (or blank for a new one). */
export function fieldsFromConnection(
	connection: Connection | null | undefined,
	{ ollama }: { ollama: boolean }
): ConnectionFields {
	const fields = blankFields();
	if (ollama) fields.connectionType = 'local';
	if (!connection) return fields;
	const c = connection.config ?? {};
	return {
		...fields,
		url: connection.url,
		key: connection.key,
		authType: c.auth_type ?? 'bearer',
		headers: c.headers ? JSON.stringify(c.headers, null, 2) : '',
		enable: c.enable ?? true,
		tags: normalizeTags(c.tags),
		prefixId: c.prefix_id ?? '',
		passthroughParams: Array.isArray(c.passthrough_params)
			? c.passthrough_params.join(', ')
			: (c.passthrough_params ?? ''),
		modelIds: [...new Set<string>(c.model_ids ?? [])],
		connectionType: c.connection_type ?? (ollama ? 'local' : 'external'),
		...(ollama
			? {}
			: {
					provider: c.provider ?? (c.azure ? 'azure' : ''),
					apiVersion: c.api_version ?? '',
					apiType: c.api_type ?? ''
				})
	};
}

/** A field of the connection form that a check can point at. */
export type ConnectionField = 'url' | 'apiVersion' | 'key' | 'modelIds';

/**
 * What must be true before Save: the field at fault, what to say under it
 * (FRM-2), and whether the Advanced section, where that field lives, should
 * be opened; null when the form is fine.
 */
export function validateConnection(
	f: ConnectionFields,
	{ ollama, direct }: ConnectionMode
): { field: ConnectionField; message: string; openAdvanced?: boolean } | null {
	// An Ollama connection may be saved without a URL, as it always could.
	const urlCheck = ollama && !f.url.trim() ? null : urlProblem(f.url);
	if (urlCheck) return { field: 'url', message: urlCheck };
	if (isAzure(f.provider, f.url, direct)) {
		if (!f.apiVersion.trim())
			return { field: 'apiVersion', message: 'Enter the Azure API version.', openAdvanced: true };
		if (!f.key && !['azure_ad', 'microsoft_entra_id'].includes(f.authType))
			return { field: 'key', message: 'Enter the API key. Azure OpenAI needs one.' };
		if (f.modelIds.length === 0)
			return {
				field: 'modelIds',
				message: 'Add a deployment name. Azure OpenAI needs at least one.',
				openAdvanced: true
			};
	}
	return null;
}

/** The connection the modal submits. A trailing slash on the URL is dropped. */
export function buildConnection(
	f: ConnectionFields,
	{ ollama, direct }: ConnectionMode,
	headers: Record<string, unknown> | null
): Connection {
	const azure = isAzure(f.provider, f.url, direct);
	return {
		url: f.url.replace(/\/$/, ''),
		key: f.key,
		config: {
			enable: f.enable,
			tags: f.tags,
			prefix_id: f.prefixId,
			model_ids: f.modelIds,
			connection_type: f.connectionType,
			auth_type: f.authType,
			headers: headers ?? undefined,
			passthrough_params: parsePassthroughParams(f.passthroughParams),
			...(f.provider ? { provider: f.provider } : {}),
			...(!ollama && azure ? { azure: true } : {}),
			...(azure ? { api_version: f.apiVersion } : {}),
			...(f.apiType ? { api_type: f.apiType } : {})
		}
	};
}

/** The config the "verify" button sends for an OpenAI-style server. */
export function verifyConfig(
	f: ConnectionFields,
	{ direct }: { direct: boolean },
	headers: Record<string, unknown> | null
): ConnectionConfig {
	const azure = isAzure(f.provider, f.url, direct);
	return {
		auth_type: f.authType,
		...(f.provider ? { provider: f.provider } : {}),
		...(azure ? { azure: true } : {}),
		api_version: f.apiVersion,
		passthrough_params: parsePassthroughParams(f.passthroughParams),
		...(headers ? { headers } : {})
	};
}

/** What a connection test found: a line in the success colour, or the reason, under the URL. */
export type TestResult = { ok: true; text: string } | { ok: false; text: string };

/** "Reachable: 2 models" from a model-list answer, or the reason it is not one. */
export function modelListResult(answer: unknown): TestResult {
	const data = (answer as { data?: unknown } | null)?.data;
	const list = Array.isArray(answer) ? answer : Array.isArray(data) ? data : null;
	if (!list) return { ok: false, text: "Reached the server, but it didn't return a model list." };
	return { ok: true, text: `Reachable: ${list.length} model${list.length === 1 ? '' : 's'}` };
}

/** FRM-2: the http/https check made before a URL is sent anywhere; null when it is fine. */
export function urlProblem(url: string): string | null {
	const value = url.trim();
	if (!value) return 'Enter the server’s URL.';
	try {
		const parsed = new URL(value);
		if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return null;
	} catch {
		/* not a URL at all */
	}
	return 'Enter a URL that starts with http:// or https://.';
}
