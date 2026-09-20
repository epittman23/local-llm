// Ports apps/openwebui/src/lib/constants/permissions.ts and the three copies
// of its "fill missing keys" merge that admin/Users/Groups/{EditGroupModal,
// Permissions}.svelte each carry. One merge function here instead.
export type PermissionGroupName = 'workspace' | 'sharing' | 'access_grants' | 'chat' | 'features' | 'settings';
export type PermissionGroup = Record<string, boolean>;
export type Permissions = Record<PermissionGroupName, PermissionGroup> & Record<string, unknown>;

export const DEFAULT_PERMISSIONS: Record<PermissionGroupName, PermissionGroup> = {
	workspace: {
		models: false,
		knowledge: false,
		prompts: false,
		tools: false,
		skills: false,
		models_import: false,
		models_export: false,
		prompts_import: false,
		prompts_export: false,
		tools_import: false,
		tools_export: false,
		skills_import: false,
		skills_export: false
	},
	sharing: {
		models: false,
		public_models: false,
		knowledge: false,
		public_knowledge: false,
		prompts: false,
		public_prompts: false,
		tools: false,
		public_tools: false,
		skills: false,
		public_skills: false,
		notes: false,
		public_notes: false,
		folders: false,
		public_chats: false,
		open_chats: false,
		public_calendars: false
	},
	access_grants: { allow_users: true, allow_groups: true },
	chat: {
		controls: true,
		valves: true,
		system_prompt: true,
		params: true,
		file_upload: true,
		web_upload: true,
		delete: true,
		delete_message: true,
		continue_response: true,
		regenerate_response: true,
		rate_response: true,
		edit: true,
		share: true,
		export: true,
		import: true,
		stt: true,
		tts: true,
		call: true,
		multiple_models: true,
		temporary: true,
		temporary_enforced: false
	},
	features: {
		api_keys: false,
		notes: true,
		channels: true,
		folders: true,
		direct_tool_servers: false,
		web_search: true,
		image_generation: true,
		code_interpreter: true,
		memories: true,
		automations: false,
		calendar: true,
		webhooks: false
	},
	settings: { interface: true }
};

export const permissionGroupNames = Object.keys(DEFAULT_PERMISSIONS) as PermissionGroupName[];

/**
 * A complete permissions object: every known group filled from the defaults
 * and overlaid with whatever `loaded` carries. Groups the defaults do not know
 * about pass through untouched (the Svelte merge spreads `...obj` first).
 */
export function withDefaults(loaded: Record<string, unknown> | null | undefined): Permissions {
	const source = loaded ?? {};
	const merged: Record<string, unknown> = { ...DEFAULT_PERMISSIONS, ...source };
	for (const name of permissionGroupNames) {
		merged[name] = { ...DEFAULT_PERMISSIONS[name], ...((source[name] as PermissionGroup | undefined) ?? {}) };
	}
	return merged as Permissions;
}

/** Immutable single-switch update. */
export function setPermission(
	permissions: Permissions,
	group: PermissionGroupName,
	key: string,
	value: boolean
): Permissions {
	return { ...permissions, [group]: { ...permissions[group], [key]: value } };
}
