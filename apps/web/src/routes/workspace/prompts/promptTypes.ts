import type { AccessGrant } from '@/lib/access/accessGrants';

/** What the create form and the "save a new version" modal hand to the API. */
export type PromptDraft = {
	id?: string;
	name: string;
	command: string;
	content: string;
	tags: string[];
	access_grants: AccessGrant[];
	commit_message?: string;
	is_production?: boolean;
};

/** A prompt as the edit page holds it (a subset of the backend's full record). */
export type EditablePrompt = {
	id: string;
	name: string;
	command: string;
	content: string;
	version_id?: string | null;
	tags: string[];
	access_grants: AccessGrant[];
};

/** A row of the list endpoint. Only the fields the list reads are named. */
export type PromptListItem = {
	id: string;
	name: string;
	command: string;
	content?: string;
	tags?: string[];
	is_active?: boolean;
	write_access?: boolean;
	created_at: number;
	updated_at?: number;
	access_grants?: AccessGrant[];
	user?: { id?: string; name?: string; email?: string } | null;
};

/** The route's `/workspace/prompts/:id` shape, from a fetched prompt. */
export function toEditablePrompt(p: {
	id: string;
	name: string;
	command: string;
	content: string;
	version_id?: string | null;
	tags?: string[];
	access_grants?: AccessGrant[];
}): EditablePrompt {
	return {
		id: p.id,
		name: p.name,
		command: p.command,
		content: p.content,
		version_id: p.version_id,
		tags: p.tags ?? [],
		access_grants: p.access_grants === undefined ? [] : p.access_grants
	};
}

/** A list row -> a create-form draft, for Clone and for prompts arriving from the community site. */
export function toPromptDraft(p: Partial<PromptListItem> & { title?: string }): PromptDraft {
	return {
		name: p.name || p.title || 'Prompt',
		command: p.command || '',
		content: p.content || '',
		tags: p.tags || [],
		access_grants: p.access_grants !== undefined ? p.access_grants : []
	};
}

/** Commands are alphanumerics, hyphens and underscores only -- what the backend accepts. */
export const isValidCommand = (command: string) => /^[a-zA-Z0-9-_]+$/.test(command);
