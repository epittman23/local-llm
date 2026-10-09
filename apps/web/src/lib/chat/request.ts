import type { BackendConfig } from '@/lib/stores/configStore';
import type { SessionUser } from '@/lib/stores/authStore';
import { type ChatFile, type History, type Message, type ResponseTarget, messagesList, toApiMessages } from './history';

// How Chat.svelte builds a completion request (sendMessageSocket), its
// feature switches and model selection, as pure functions.

export const TEMPORARY_PREFIX = 'temporary:';
export const temporaryChatId = (sessionId: string | undefined) => `${TEMPORARY_PREFIX}${sessionId}`;
export const isTemporaryChatId = (id: string | null | undefined) =>
	Boolean(id && (id.startsWith(TEMPORARY_PREFIX) || id.startsWith('local:')));

const pad = (n: number) => String(n).padStart(2, '0');
export function promptVariables(user: { name?: string; email?: string } | null, location?: string, at = new Date()) {
	const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
	const time = at.toTimeString().split(' ')[0];
	let language = 'en-US';
	try {
		language = localStorage.getItem('locale') || 'en-US';
	} catch {
		/* storage unavailable */
	}
	return {
		'{{USER_NAME}}': user?.name,
		'{{USER_EMAIL}}': user?.email || 'Unknown',
		'{{USER_LOCATION}}': location || 'Unknown',
		'{{CURRENT_DATETIME}}': `${date} ${time}`,
		'{{CURRENT_DATE}}': date,
		'{{CURRENT_TIME}}': time,
		'{{CURRENT_WEEKDAY}}': ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][at.getDay()],
		'{{CURRENT_TIMEZONE}}': Intl.DateTimeFormat().resolvedOptions().timeZone,
		'{{USER_LANGUAGE}}': language
	};
}

/** Stop sequences from a list or a comma-separated string, with escapes like `\n` decoded. */
export function stopTokens(stop: unknown): string[] | undefined {
	if (!stop) return undefined;
	const tokens = Array.isArray(stop)
		? stop
		: String(stop)
				.split(',')
				.map((s) => s.trim());
	return tokens.filter(Boolean).map((t) => {
		try {
			return decodeURIComponent(JSON.parse(`"${String(t).replace(/"/g, '\\"')}"`));
		} catch {
			return String(t);
		}
	});
}

type Perms = { features?: Record<string, boolean>; chat?: Record<string, boolean> };
const perms = (u: SessionUser | null) => (u?.permissions ?? {}) as Perms;

export type FeatureToggles = {
	webSearch: boolean;
	imageGeneration: boolean;
	codeInterpreter: boolean;
	voice?: boolean;
};

/** What the request's `features` says: each switch only if the server and the user's permissions allow it. */
export function requestFeatures(
	t: FeatureToggles,
	user: SessionUser | null,
	config: BackendConfig | null,
	settings: Record<string, any> | null
) {
	const f = (config?.features ?? {}) as Record<string, unknown>;
	const admin = user?.role === 'admin';
	const can = (flag: string, perm: string) => Boolean(f[flag]) && (admin || Boolean(perms(user).features?.[perm]));
	const features: Record<string, boolean> = {
		voice: Boolean(t.voice),
		image_generation: can('enable_image_generation', 'image_generation') ? t.imageGeneration : false,
		code_interpreter: can('enable_code_interpreter', 'code_interpreter') ? t.codeInterpreter : false,
		web_search: t.webSearch
	};
	if (settings?.memory ?? f.enable_memories ?? false) features.memory = true;
	return features;
}

type ModelLike = { id: string; name?: string; info?: { meta?: { hidden?: boolean } } };

/**
 * The models a new chat starts with (Chat.svelte's initNewChat): the URL's
 * `?models=`/`?model=`, else the folder's, else the user's saved models, else
 * the server defaults; unknown and hidden models dropped; at least one kept.
 */
export function initialModels(opts: {
	url?: string | null;
	folderModels?: string[] | null;
	userModels?: string[] | null;
	defaults?: string | null;
	models: ModelLike[];
}): string[] {
	const available = opts.models.filter((m) => !m.info?.meta?.hidden).map((m) => m.id);
	const known = opts.models.map((m) => m.id);
	const defaults = opts.defaults
		? opts.defaults
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
		: [];
	let selected: string[];
	if (opts.url) selected = opts.url.split(',').filter((id) => known.includes(id));
	else
		selected = (
			opts.folderModels?.length ? opts.folderModels : opts.userModels?.length ? opts.userModels : defaults
		).filter((id) => available.includes(id));
	if (selected.length === 0 || (selected.length === 1 && !selected[0])) {
		selected = defaults.filter((id) => available.includes(id));
		if (!selected.length) selected = [available[0] ?? ''];
	}
	return selected;
}

/** Files the server should read for this turn: the chat's documents plus the new message's non-image files, deduplicated. */
export function turnFiles(chatFiles: ChatFile[], userMessage: Message | undefined): ChatFile[] {
	const docTypes = ['doc', 'text', 'note', 'chat', 'collection', 'folder'];
	const isDoc = (f: ChatFile) =>
		docTypes.includes(f.type ?? '') || (f.type === 'file' && !(f.content_type ?? '').startsWith('image/'));
	const all = [...chatFiles, ...(userMessage?.files ?? []).filter(isDoc)];
	return all.filter((f, i) => all.findIndex((g) => JSON.stringify(g) === JSON.stringify(f)) === i);
}

export type CompletionContext = {
	history: History;
	responseId: string;
	targets?: ResponseTarget[];
	model: ModelLike;
	chatId: string | null;
	temporary: boolean;
	sessionId?: string;
	folderId?: string | null;
	params: Record<string, any>;
	settings: Record<string, any> | null;
	chatFiles: ChatFile[];
	features: Record<string, boolean>;
	toolIds?: string[];
	filterIds?: string[];
	skillIds?: string[];
	variables: Record<string, unknown>;
	regenerationPrompt?: string | null;
	continueResponse?: boolean;
	/** Used instead of the path to `responseId` (a regeneration with a suggestion). */
	messages?: Message[] | null;
};

/** The POST /api/chat/completions body (sendMessageSocket). */
export function completionBody(c: CompletionContext) {
	const response = c.history.messages[c.responseId];
	const user = response ? c.history.messages[response.parentId ?? ''] : undefined;
	const system = c.params?.system ?? c.settings?.system;
	let messages: Record<string, unknown>[] = system ? [{ role: 'system', content: String(system) }] : [];
	// Saved chats are read from the database; a temporary one has to carry its conversation.
	if (c.temporary) messages = [...messages, ...toApiMessages(c.messages ?? messagesList(c.history, c.responseId))];
	const files = turnFiles(c.chatFiles, user);
	const newChat = !c.chatId;
	const stream =
		(c.model as { info?: { params?: { stream_response?: boolean } } }).info?.params?.stream_response ??
		c.settings?.params?.stream_response ??
		c.params?.stream_response ??
		true;
	return {
		stream,
		model: c.model.id,
		...(messages.length ? { messages } : {}),
		params: {
			...(c.settings?.params ?? {}),
			...c.params,
			stop: stopTokens(c.params?.stop ?? c.settings?.params?.stop)
		},
		files: files.length ? files : undefined,
		filter_ids: c.filterIds?.length ? c.filterIds : undefined,
		tool_ids: c.toolIds?.length ? c.toolIds : undefined,
		skill_ids: c.skillIds?.length ? c.skillIds : undefined,
		features: c.features,
		variables: c.variables,
		model_item: c.model,
		session_id: c.sessionId,
		chat_id: c.chatId || undefined,
		folder_id: c.folderId ?? undefined,
		id: c.responseId,
		...(c.targets ? { message_ids: c.targets } : {}),
		parent_id: user?.parentId ?? null,
		user_message: user,
		...(c.regenerationPrompt ? { regeneration_prompt: c.regenerationPrompt } : {}),
		...(c.continueResponse ? { assistant_message_id: c.responseId } : {}),
		background_tasks: {
			...(!c.temporary && newChat
				? { title_generation: c.settings?.title?.auto ?? true, tags_generation: c.settings?.autoTags ?? true }
				: {}),
			follow_up_generation: c.settings?.autoFollowUps ?? true
		}
	};
}

/**
 * Whether a new chat starts temporary (Chat.svelte's initNewChat): always
 * when the admin enforces it, otherwise when the user may use temporary
 * chats and turned on "Temporary Chat by Default" (docs/code-review.md M1).
 */
export const newChatTemporary = (o: { enforced: boolean; allowed: boolean; byDefault: boolean }) =>
	o.enforced || (o.allowed && o.byDefault);

type SearchConfirmConfig = { features?: Record<string, unknown> } | null | undefined;

/**
 * Whether sending now must first ask the user to confirm web search: the
 * admin requires it (ENABLE_WEB_SEARCH_CONFIRMATION), web search is on for
 * this message, and the user has not confirmed it in this chat yet
 * (Chat.svelte's submitPrompt; docs/code-review.md M2).
 */
export const needsWebSearchConfirm = (config: SearchConfirmConfig, webSearchOn: boolean, confirmed: boolean) =>
	config?.features?.enable_web_search_confirmation === true && webSearchOn && !confirmed;

/** What the confirmation says: the admin's text, or the Svelte app's default. */
export function webSearchConfirmText(config: SearchConfirmConfig) {
	const text = config?.features?.web_search_confirmation_content;
	return (typeof text === 'string' && text.trim()) || 'Your query will be sent to the configured web search provider.';
}
