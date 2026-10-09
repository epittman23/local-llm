import type { AccessGrant } from '@/lib/access/accessGrants';
import { parseHeaders } from './connectionModel';

// The rules behind AddToolServerModal.svelte, pulled out so they can be tested
// and shared with the Phase 10 personal Tools settings, which open the same
// modal with `direct` set (OpenAPI only, verified from the browser, no ID,
// headers or access control).

export type ToolServerConnection = {
	type?: string;
	url: string;
	spec_type?: string;
	spec?: string;
	path?: string;
	auth_type?: string;
	headers?: Record<string, unknown>;
	key?: string;
	config?: {
		enable?: boolean;
		function_name_filter_list?: string;
		access_grants?: AccessGrant[];
		[k: string]: unknown;
	};
	info?: { id?: string; name?: string; description?: string; [k: string]: unknown };
	[k: string]: unknown;
};

export type ToolServerFields = {
	type: 'openapi' | 'mcp';
	url: string;
	specType: 'url' | 'json';
	spec: string;
	path: string;
	authType: string;
	key: string;
	headers: string;
	functionNameFilterList: string;
	accessGrants: AccessGrant[];
	id: string;
	name: string;
	description: string;
	oauthClientInfo: unknown;
	oauthClientId: string;
	oauthClientSecret: string;
	oauthServerUrl: string;
	oauthScope: string;
	oauthResourceParameter: string;
	enable: boolean;
};

export const OAUTH_AUTH_TYPES = ['oauth_2.1', 'oauth_2.1_static'];
export const isOAuth21 = (authType: string) => OAUTH_AUTH_TYPES.includes(authType);

export const blankToolServerFields = (): ToolServerFields => ({
	type: 'openapi',
	url: '',
	specType: 'url',
	spec: '',
	path: 'openapi.json',
	authType: 'bearer',
	key: '',
	headers: '',
	functionNameFilterList: '',
	accessGrants: [],
	id: '',
	name: '',
	description: '',
	oauthClientInfo: null,
	oauthClientId: '',
	oauthClientSecret: '',
	oauthServerUrl: '',
	oauthScope: '',
	oauthResourceParameter: 'auto',
	enable: true
});

/** The form's starting values for an existing connection (or blank for a new one). */
export function toolServerFields(c: ToolServerConnection | null | undefined): ToolServerFields {
	const f = blankToolServerFields();
	if (!c) return f;
	const info = c.info ?? {};
	return {
		...f,
		type: c.type === 'mcp' ? 'mcp' : 'openapi',
		url: c.url ?? '',
		specType: c.spec_type === 'json' ? 'json' : 'url',
		spec: c.spec ?? '',
		path: c.path ?? 'openapi.json',
		authType: c.auth_type ?? 'bearer',
		headers: c.headers ? JSON.stringify(c.headers, null, 2) : '',
		key: c.key ?? '',
		id: (info.id as string) ?? '',
		name: (info.name as string) ?? '',
		description: (info.description as string) ?? '',
		oauthClientInfo: info.oauth_client_info ?? null,
		oauthClientId: (info.oauth_client_id as string) ?? '',
		oauthClientSecret: (info.oauth_client_secret as string) ?? '',
		oauthServerUrl: (info.oauth_server_url as string) ?? '',
		oauthScope: (info.oauth_scope as string) ?? '',
		oauthResourceParameter: (info.oauth_resource_parameter as string) ?? 'auto',
		enable: c.config?.enable ?? true,
		functionNameFilterList: c.config?.function_name_filter_list ?? '',
		accessGrants: c.config?.access_grants ?? []
	};
}

/** Where the OpenAPI spec is fetched from: `path` if it is a full URL, else joined onto the base URL. */
export const specRequestUrl = (url: string, path: string) =>
	path.includes('://') ? path : `${url}${path.startsWith('/') ? '' : '/'}${path}`;

/** The OAuth-only `info` keys, for an MCP server using OAuth 2.1. */
const oauthScopeInfo = (f: ToolServerFields) =>
	f.type === 'mcp' && isOAuth21(f.authType)
		? { ...(f.oauthScope ? { oauth_scope: f.oauthScope } : {}), oauth_resource_parameter: f.oauthResourceParameter }
		: {};

/**
 * What must be true before Save, as the message to toast, or null. Returns
 * the tidied form too: a non-MCP URL loses its trailing slash (MCP servers may
 * need theirs -- stripping it can turn into a 301 that drops the auth header),
 * and a JSON spec and the headers are pretty-printed.
 */
export function validateToolServer(
	f: ToolServerFields
): { error: string } | { fields: ToolServerFields; headers: Record<string, unknown> | null } {
	const next = { ...f, url: f.type === 'mcp' ? f.url : f.url.replace(/\/$/, '') };
	if (next.id.includes(':') || next.id.includes('|')) return { error: 'ID cannot contain ":" or "|" characters' };
	if (next.type === 'mcp' && isOAuth21(next.authType) && !next.oauthClientInfo)
		return { error: 'Please register the OAuth client' };
	if (next.specType === 'json') {
		try {
			next.spec = JSON.stringify(JSON.parse(next.spec), null, 2);
		} catch {
			return { error: 'Please enter a valid JSON spec' };
		}
	}
	try {
		const h = parseHeaders(next.headers);
		next.headers = h.text;
		return { fields: next, headers: h.value };
	} catch {
		return { error: 'Headers must be a valid JSON object' };
	}
}

/** The connection the modal submits. */
export function buildToolServer(f: ToolServerFields, headers: Record<string, unknown> | null): ToolServerConnection {
	return {
		type: f.type,
		url: f.url,
		spec_type: f.specType,
		spec: f.spec,
		path: f.path,
		auth_type: f.authType,
		headers: headers ?? undefined,
		key: f.key,
		config: { enable: f.enable, function_name_filter_list: f.functionNameFilterList, access_grants: f.accessGrants },
		info: {
			id: f.id,
			name: f.name,
			description: f.description,
			...oauthScopeInfo(f),
			...(f.oauthClientInfo ? { oauth_client_info: f.oauthClientInfo } : {}),
			...(f.authType === 'oauth_2.1_static'
				? {
						oauth_client_id: f.oauthClientId,
						oauth_client_secret: f.oauthClientSecret,
						oauth_server_url: f.oauthServerUrl
					}
				: {})
		}
	};
}

/** Checks the Verify button makes before it sends anything; the message to toast, or null. */
export function verifyProblem(f: ToolServerFields): string | null {
	if (!f.url) return 'Please enter a valid URL';
	if (f.type === 'openapi') {
		if (f.specType === 'json' && !f.spec) return 'Please enter a valid JSON spec';
		if (f.specType === 'url' && !f.path) return 'Please enter a valid path';
	}
	return null;
}

/** The body of `/configs/tool_servers/verify` (system connections only). */
export function verifyPayload(f: ToolServerFields, headers: Record<string, unknown> | null) {
	return {
		url: f.url,
		path: f.path,
		type: f.type,
		auth_type: f.authType,
		headers: headers ?? undefined,
		key: f.key,
		config: { enable: f.enable, access_grants: f.accessGrants },
		info: {
			id: f.id,
			name: f.name,
			description: f.description,
			...(isOAuth21(f.authType)
				? {
						...(f.oauthServerUrl ? { oauth_server_url: f.oauthServerUrl } : {}),
						...(f.oauthScope ? { oauth_scope: f.oauthScope } : {}),
						oauth_resource_parameter: f.oauthResourceParameter
					}
				: {})
		}
	};
}

/**
 * The body of the OAuth client registration. `client_id` is the tool server's
 * ID (the backend's lookup key for both flows); for a static client the secret
 * tells the backend to use the static path.
 */
export function registrationPayload(f: ToolServerFields) {
	return {
		url: f.url,
		client_id: f.id,
		...(f.oauthScope ? { oauth_scope: f.oauthScope } : {}),
		...(f.authType === 'oauth_2.1_static'
			? { client_secret: f.oauthClientSecret, oauth_server_url: f.oauthServerUrl }
			: {})
	};
}

/** Checks before registering an OAuth client; the message to toast, or null. */
export function registrationProblem(f: ToolServerFields): string | null {
	if (!f.url) return 'Please enter a valid URL';
	if (!f.id) return 'Please enter a valid ID';
	if (f.authType === 'oauth_2.1_static' && (!f.oauthClientId || !f.oauthClientSecret))
		return 'Please enter Client ID and Client Secret';
	return null;
}

/**
 * The export file: a one-element array. The API key is left out -- an export
 * is a file people pass around, and the Svelte modal wrote the key into it in
 * plain text. So are OAuth client secrets (never exported there either).
 */
export function exportToolServer(f: ToolServerFields, headers: Record<string, unknown> | null) {
	return [
		{
			type: f.type,
			url: f.url,
			spec_type: f.specType,
			spec: f.spec,
			path: f.path,
			auth_type: f.authType,
			headers: headers ?? undefined,
			info: { id: f.id, name: f.name, description: f.description, ...oauthScopeInfo(f) }
		}
	];
}

/**
 * Applies an imported file (an object, or an array whose first element is
 * used) over the form. Only fields present in the file change. `access_grants`
 * are ignored, so an imported server starts with the access it had in the form
 * rather than whatever a file someone sent says (as with Skills imports).
 * Throws on anything that is not a connection object.
 */
export function importToolServer(text: string, f: ToolServerFields): ToolServerFields {
	let data = JSON.parse(text);
	if (Array.isArray(data)) {
		if (data.length === 0) throw new Error('empty');
		data = data[0];
	}
	if (typeof data !== 'object' || data === null) throw new Error('not an object');
	const next = { ...f };
	if (data.type) next.type = data.type === 'mcp' ? 'mcp' : 'openapi';
	if (data.url) next.url = String(data.url);
	if (data.spec_type) next.specType = data.spec_type === 'json' ? 'json' : 'url';
	if (data.spec) next.spec = String(data.spec);
	if (data.path) next.path = String(data.path);
	if (data.auth_type) next.authType = String(data.auth_type);
	if (data.headers) next.headers = JSON.stringify(data.headers, null, 2);
	if (data.key) next.key = String(data.key);
	if (data.info) {
		next.id = data.info.id ?? '';
		next.name = data.info.name ?? '';
		next.description = data.info.description ?? '';
		next.oauthScope = data.info.oauth_scope ?? '';
		next.oauthResourceParameter = data.info.oauth_resource_parameter ?? 'auto';
	}
	if (data.config) next.enable = data.config.enable ?? true;
	return next;
}
