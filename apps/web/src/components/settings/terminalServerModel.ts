import type { AccessGrant } from '@/lib/access/accessGrants';

// The rules behind AddTerminalServerModal.svelte. A terminal connection points
// at an Open Terminal instance, or at an Orchestrator that provisions them; for
// an Orchestrator the admin also edits a provisioning *policy* (image,
// resources, storage, env, lifecycle JSON) that is saved to the Orchestrator
// itself, through the backend proxy, before the connection is saved here.

export type ServerType = 'orchestrator' | 'terminal' | null;
export type ChatContext = 'default' | 'chat_id' | 'off';
export type AutomationContext = 'default' | 'automation_id' | 'off';

export type TerminalConnection = {
	id?: string;
	url?: string;
	name?: string;
	key?: string;
	path?: string;
	auth_type?: string;
	enabled?: boolean;
	server_type?: ServerType;
	policy_id?: string;
	config?: Record<string, any>;
	[k: string]: unknown;
};

export type EnvPair = { key: string; value: string };

export type TerminalFields = {
	id: string;
	url: string;
	key: string;
	name: string;
	authType: string;
	path: string;
	enabled: boolean;
	chatUploads: 'default' | 'filesystem';
	chatContext: ChatContext;
	automationContext: AutomationContext;
	accessGrants: AccessGrant[];
	serverType: ServerType;
	policyId: string;
};

export type PolicyFields = {
	image: string;
	envPairs: EnvPair[];
	cpu: string;
	memory: string;
	storage: 'ephemeral' | 'persistent';
	storageSize: string;
	idleTimeout: number;
	lifecycleJson: string;
};

export const blankPolicy = (): PolicyFields => ({
	image: '',
	envPairs: [],
	cpu: '1',
	memory: '1Gi',
	storage: 'ephemeral',
	storageSize: '5Gi',
	idleTimeout: 30,
	lifecycleJson: '{}'
});

/**
 * The form's starting values. A new connection starts *disabled* (as in the
 * original: it is enabled once someone has checked it works); an existing one
 * without the flag counts as enabled. Contexts are only read for an Orchestrator.
 */
export function terminalFields(c: TerminalConnection | null | undefined): TerminalFields {
	if (!c) {
		return {
			id: '',
			url: '',
			key: '',
			name: '',
			authType: 'bearer',
			path: '/openapi.json',
			enabled: false,
			chatUploads: 'default',
			chatContext: 'default',
			automationContext: 'default',
			accessGrants: [],
			serverType: null,
			policyId: ''
		};
	}
	const serverType: ServerType = c.server_type ?? (c.policy_id ? 'orchestrator' : null);
	const contexts = serverType === 'orchestrator' ? (c.config?.contexts ?? {}) : {};
	return {
		id: c.id ?? '',
		url: c.url ?? '',
		key: c.key ?? '',
		name: c.name ?? '',
		authType: c.auth_type ?? 'bearer',
		path: c.path ?? '/openapi.json',
		enabled: c.enabled ?? true,
		chatUploads: c.config?.chat_uploads === 'filesystem' ? 'filesystem' : 'default',
		chatContext: contexts.chat === false ? 'off' : contexts.chat?.context_id === 'chat_id' ? 'chat_id' : 'default',
		automationContext:
			contexts.automation === false
				? 'off'
				: contexts.automation?.context_id === 'automation_id'
					? 'automation_id'
					: 'default',
		accessGrants: c.config?.access_grants ?? [],
		serverType,
		policyId: c.policy_id ?? ''
	};
}

/** The policy form from what the Orchestrator returned (`policy.data`, `lifecycle.data`). */
export function policyFromServer(
	data: Record<string, any> | null | undefined,
	lifecycle: Record<string, any> | null | undefined
): PolicyFields {
	const d = data ?? {};
	return {
		image: d.image ?? '',
		idleTimeout: d.idle_timeout_minutes ?? 30,
		storage: d.storage ? 'persistent' : 'ephemeral',
		storageSize: d.storage ?? '5Gi',
		envPairs: Object.entries(d.env ?? {}).map(([key, value]) => ({ key, value: String(value) })),
		cpu: d.cpu_limit ?? '1',
		memory: d.memory_limit ?? '1Gi',
		lifecycleJson: JSON.stringify(lifecycle && Object.keys(lifecycle).length ? lifecycle : {}, null, 2)
	};
}

/** The policy the Orchestrator is sent: blanks are left out, env pairs with no key dropped, storage only when persistent. */
export function buildPolicyData(p: PolicyFields): Record<string, unknown> {
	const data: Record<string, unknown> = {};
	if (p.image) data.image = p.image;
	if (p.cpu) data.cpu_limit = p.cpu;
	if (p.memory) data.memory_limit = p.memory;
	if (p.storage === 'persistent') data.storage = p.storageSize;
	if (p.idleTimeout > 0) data.idle_timeout_minutes = p.idleTimeout;
	const env: Record<string, string> = {};
	for (const pair of p.envPairs) if (pair.key.trim()) env[pair.key.trim()] = pair.value;
	if (Object.keys(env).length) data.env = env;
	return data;
}

/** The lifecycle JSON as an object, or the message to show: it must be a JSON object. */
export function parseLifecycle(text: string): { value: Record<string, unknown> } | { error: string } {
	try {
		const parsed = JSON.parse(text || '{}');
		if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
			return { error: 'Lifecycle JSON must be a JSON object' };
		return { value: parsed };
	} catch {
		return { error: 'Lifecycle JSON contains invalid JSON' };
	}
}

/** A policy ID suggested when an Orchestrator is first detected: the connection ID, else a slug of the name, else "default". */
export const suggestPolicyId = (id: string, name: string) =>
	id ||
	name
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '') ||
	'default';

/**
 * The connection the modal submits. The URL loses a trailing slash and the key
 * is trimmed (whitespace in a bearer key breaks the terminal WebSocket's auth:
 * HTTP headers strip it, the JSON handshake does not). Any other keys already
 * in `config` are kept; access grants are only for system (non-direct)
 * connections, contexts only for an Orchestrator and only when one differs
 * from the default.
 */
export function buildTerminalConnection(
	f: TerminalFields,
	previousConfig: Record<string, any> | undefined,
	{ direct }: { direct: boolean }
): TerminalConnection {
	const contexts: Record<string, false | { context_id: string }> = {};
	if (f.chatContext === 'off') contexts.chat = false;
	else if (f.chatContext === 'chat_id') contexts.chat = { context_id: 'chat_id' };
	if (f.automationContext === 'off') contexts.automation = false;
	else if (f.automationContext === 'automation_id') contexts.automation = { context_id: 'automation_id' };

	const config: Record<string, any> = previousConfig && typeof previousConfig === 'object' ? { ...previousConfig } : {};
	if (!direct) config.access_grants = f.accessGrants;
	else delete config.access_grants;
	if (!direct && f.serverType === 'orchestrator' && Object.keys(contexts).length) config.contexts = contexts;
	else delete config.contexts;
	if (f.chatUploads === 'filesystem') config.chat_uploads = 'filesystem';
	else delete config.chat_uploads;

	return {
		...(!direct && f.id.trim() ? { id: f.id.trim() } : {}),
		url: f.url.replace(/\/$/, ''),
		key: f.key.trim(),
		name: f.name,
		path: f.path,
		auth_type: f.authType,
		enabled: f.enabled,
		config,
		...(f.serverType ? { server_type: f.serverType } : {}),
		...(f.serverType === 'orchestrator' && f.policyId ? { policy_id: f.policyId } : {})
	};
}
