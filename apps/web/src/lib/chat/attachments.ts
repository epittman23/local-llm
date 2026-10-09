import type { SessionUser } from '@/lib/stores/authStore';
import type { ChatFile } from './history';

// What the chat input may attach and how (MessageInput.svelte, InputMenu,
// IntegrationsMenu, Commands/*), as pure rules.

type ModelLike = {
	id: string;
	info?: { meta?: { capabilities?: Record<string, boolean>; toolIds?: string[]; defaultFeatureIds?: string[] } };
};
export type Capability =
	| 'vision'
	| 'file_upload'
	| 'web_search'
	| 'image_generation'
	| 'code_interpreter'
	| 'citations';

/** Every selected model has the capability (a capability that is not set counts as present, as in the Svelte app). */
export function allCapable(selected: string[], models: ModelLike[], cap: Capability): boolean {
	return selected.every((id) => models.find((m) => m.id === id)?.info?.meta?.capabilities?.[cap] ?? true);
}

const perm = (user: SessionUser | null, group: 'chat' | 'features', key: string, fallback: boolean) =>
	user?.role === 'admin' ||
	((user?.permissions as Record<string, Record<string, boolean | undefined>> | undefined)?.[group]?.[key] ?? fallback);

export const canUploadFiles = (user: SessionUser | null) => perm(user, 'chat', 'file_upload', true);
export const canUploadWeb = (user: SessionUser | null) => perm(user, 'chat', 'web_upload', true);

export type FeatureButtons = { webSearch: boolean; imageGeneration: boolean; codeInterpreter: boolean };

/** Which feature switches the input shows: the server feature is on, the user may use it, and every selected model supports it. */
export function featureButtons(
	selected: string[],
	models: ModelLike[],
	user: SessionUser | null,
	features: Record<string, unknown>
): FeatureButtons {
	const show = (flag: string, permKey: string, cap: Capability) =>
		Boolean(features[flag]) && perm(user, 'features', permKey, false) && allCapable(selected, models, cap);
	return {
		webSearch: show('enable_web_search', 'web_search', 'web_search'),
		imageGeneration: show('enable_image_generation', 'image_generation', 'image_generation'),
		codeInterpreter: show('enable_code_interpreter', 'code_interpreter', 'code_interpreter')
	};
}

/** The tools and feature switches a single selected model starts with (Chat.svelte's setDefaults). */
export function modelDefaults(
	model: ModelLike | undefined,
	knownToolIds: string[],
	savedTools: string[] | undefined,
	buttons: FeatureButtons
) {
	const meta = model?.info?.meta;
	const toolIds = meta?.toolIds
		? [...new Set(meta.toolIds.filter((id) => knownToolIds.includes(id)))]
		: (savedTools ?? []);
	const on = (f: string) => Boolean(meta?.defaultFeatureIds?.includes(f));
	return {
		toolIds,
		webSearch: buttons.webSearch && meta?.capabilities?.web_search ? on('web_search') : null,
		imageGeneration: buttons.imageGeneration && meta?.capabilities?.image_generation ? on('image_generation') : null,
		codeInterpreter: buttons.codeInterpreter && meta?.capabilities?.code_interpreter ? on('code_interpreter') : null
	};
}

export const isImageFile = (f: Pick<ChatFile, 'type' | 'content_type'>) =>
	f.type === 'image' || (f.content_type ?? '').startsWith('image/');

/**
 * The size an uploaded image is scaled down to, or null to keep it: the
 * user's size if they turned compression on (for chats), capped by the
 * server's limit.
 */
export function imageTargetSize(
	settings: Record<string, any> | null,
	config: { file?: { image_compression?: { width?: number | null; height?: number | null } } } | null
): { width: number | null; height: number | null } | null {
	const cw = config?.file?.image_compression?.width ?? null;
	const ch = config?.file?.image_compression?.height ?? null;
	const userOn = Boolean(settings?.imageCompression);
	if (!userOn && !cw && !ch) return null;
	let width: number | null = userOn ? (settings?.imageCompressionSize?.width ?? null) : null;
	let height: number | null = userOn ? (settings?.imageCompressionSize?.height ?? null) : null;
	if (cw && (width === null || width > cw)) width = cw;
	if (ch && (height === null || height > ch)) height = ch;
	return width || height ? { width, height } : null;
}

/** A web address typed after `#`: offered as "attach this page". */
export const isUrl = (s: string) => /^https?:\/\/\S+\.\S+/.test(s.trim());

export type CommandTrigger = '/' | '#' | '@';

/** The command being typed at the cursor: `/prompt` only at the very start, `#` and `@` at any word start. */
export function commandAt(
	text: string,
	cursor: number
): { trigger: CommandTrigger; query: string; start: number } | null {
	const before = text.slice(0, cursor);
	const slash = /^\/(\S*)$/.exec(before);
	if (slash) return { trigger: '/', query: slash[1], start: 0 };
	const m = /(^|\s)([#@])(\S*)$/.exec(before);
	return m ? { trigger: m[2] as CommandTrigger, query: m[3], start: cursor - m[3].length - 1 } : null;
}

/** The text with the command at `start..cursor` replaced by `insert`. */
export const replaceCommand = (text: string, start: number, cursor: number, insert: string) =>
	text.slice(0, start) + insert + text.slice(cursor);

/** Fills the built-in `{{...}}` variables a prompt can use (the input's textVariableHandler). */
export function fillPromptVariables(text: string, vars: Record<string, unknown>): string {
	let out = text;
	for (const [k, v] of Object.entries(vars))
		if (v !== undefined && v !== null && v !== '') out = out.replaceAll(k, String(v));
	return out;
}

/** Replaces `{{name}}` / `{{name | type:...}}` with the values given; unknown names are left as they are. */
export const replaceInputVariables = (text: string, values: Record<string, unknown>) =>
	text.replace(/{{\s*([^|}]+)(?:\|[^}]*)?\s*}}/g, (match, name: string) =>
		Object.hasOwn(values, name.trim()) ? String(values[name.trim()]) : match
	);
