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

// --- untrusted input --------------------------------------------------------
// Three places feed this page data it did not create: a message from the
// Open WebUI community site (a cross-origin window), a prompt stashed in
// sessionStorage, and an imported JSON file. None of them is allowed to choose
// who a prompt is shared with, so all three go through the functions below.

const asString = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');

const NAME_MAX = 200;
const COMMAND_MAX = 200;
const CONTENT_MAX = 100_000;
const TAG_MAX = 100;
const TAGS_MAX = 50;

/**
 * Builds a create-form draft from data that came from outside the app.
 * Only name, command, content and tags are read, each coerced to a bounded
 * string; anything else is dropped -- in particular `access_grants`, which is
 * always empty, so a crafted message cannot pre-fill a prompt as public (or
 * shared with a chosen user) for a user who then just clicks "Save & Create".
 * Returns null when the value is not an object at all.
 */
export function sanitizeExternalDraft(raw: unknown): PromptDraft | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const p = raw as Record<string, unknown>;
	return {
		name: asString(p.name ?? p.title, NAME_MAX) || 'Prompt',
		command: asString(p.command, COMMAND_MAX),
		content: asString(p.content, CONTENT_MAX),
		tags: Array.isArray(p.tags)
			? p.tags.filter((t): t is string => typeof t === 'string').map((t) => t.slice(0, TAG_MAX)).slice(0, TAGS_MAX)
			: [],
		access_grants: []
	};
}

/** Parses an imported prompts file: a JSON array of objects; entries without a command are skipped. */
export function parsePromptImport(text: string): Array<{ command: string; name: string; content: string }> {
	const parsed: unknown = JSON.parse(text);
	if (!Array.isArray(parsed)) throw new Error('Expected a JSON array of prompts.');
	return parsed.flatMap((item) => {
		if (!item || typeof item !== 'object') return [];
		const p = item as Record<string, unknown>;
		const command = asString(p.command, COMMAND_MAX).replace(/^\//, '');
		if (!isValidCommand(command)) return [];
		return [{ command, name: asString(p.name, NAME_MAX) || command, content: asString(p.content, CONTENT_MAX) }];
	});
}

/**
 * What "Share to Community" hands to the community site: the fields it needs to
 * pre-fill its own create form, and nothing else. The list row also carries the
 * author's name and email and the prompt's access grants, none of which belong
 * on another origin.
 */
export function communitySharePayload(p: PromptListItem) {
	return { name: p.name, command: p.command, content: p.content ?? '', tags: p.tags ?? [] };
}
