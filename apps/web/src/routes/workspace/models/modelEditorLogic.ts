import type { AccessGrant } from '@/lib/access/accessGrants';
import { DEFAULT_CAPABILITIES } from '@/lib/constants';
import { extractInputVariables } from '@/lib/utils/variables';

// The model editor's data flow, lifted out of ModelEditor.svelte: how a saved
// model becomes the editor's form state (`initialEditorState`), and how the form
// state becomes the object the API saves (`buildModelInfo`). The Svelte version
// does both inline in a 1,074-line component; here they are pure functions so
// the fiddly parts -- which meta keys are deleted when empty, how legacy
// knowledge references are migrated, when a base model id is kept -- can be
// tested without rendering the form.

/**
 * What a new model starts with (S4-D2, 2026-11-15): what this install's
 * text and coding models use. Memory, web search and the code interpreter
 * are on; vision, image generation and the terminal are off. The admin's
 * model defaults still apply on top. `DEFAULT_CAPABILITIES` stays as it is:
 * Admin > Models reads it, and it fills keys an existing model never stored.
 */
export const NEW_MODEL_CAPABILITIES: Record<string, boolean> = {
	file_context: true,
	vision: false,
	file_upload: true,
	web_search: true,
	image_generation: false,
	code_interpreter: true,
	terminal: false,
	citations: true,
	status_updates: true,
	usage: true,
	memory: true,
	builtin_tools: true
};

type Json = Record<string, any>;

export type KnowledgeItem = Record<string, any> & { status?: string };

export type ModelInfo = {
	id: string;
	name: string;
	base_model_id: string | null;
	meta: Json;
	params: Json;
	access_grants?: AccessGrant[];
	[key: string]: unknown;
};

export type EditorState = {
	id: string;
	name: string;
	info: ModelInfo;
	system: string;
	params: Json;
	knowledge: KnowledgeItem[];
	toolIds: string[];
	skillIds: string[];
	filterIds: string[];
	defaultFilterIds: string[];
	actionIds: string[];
	capabilities: Json;
	defaultFeatureIds: string[];
	builtinTools: Record<string, boolean>;
	terminalId: string;
	tts: { voice: string };
	accessGrants: AccessGrant[];
};

/** Admin-configured defaults (`DEFAULT_MODEL_METADATA`), applied under a model's own settings. */
export type ModelDefaults = {
	capabilities?: Json;
	defaultFeatureIds?: string[];
	builtinTools?: Record<string, boolean>;
};

/** "My Model 2" -> "my-model-2": what the id becomes as you type a name into a new model. */
export const modelIdFromName = (name: string): string =>
	name
		.replace(/\s+/g, '-')
		.replace(/[^a-zA-Z0-9-]/g, '')
		.toLowerCase();

const blankInfo = (): ModelInfo => ({
	id: '',
	base_model_id: null,
	name: '',
	// No picture of its own: the avatar draws the initials (S4-D2).
	meta: { profile_image_url: null, description: '', suggestion_prompts: null, tags: [] },
	params: { system: '' }
});

/** Older saves stored knowledge as collection_name / collection_names; give them the current shape, marked legacy. */
export const migrateKnowledge = (items: KnowledgeItem[] | null | undefined): KnowledgeItem[] =>
	(items ?? []).map((item) => {
		if (item?.collection_name && item?.type !== 'file')
			return { id: item.collection_name, name: item.name, legacy: true };
		if (item?.collection_names)
			return { name: item.name, type: 'collection', collection_names: item.collection_names, legacy: true };
		return item;
	});

const REFERENCE_KEYS = [
	'id',
	'name',
	'type',
	'description',
	'context',
	'legacy',
	'collection_name',
	'collection_names'
];

/** What is saved for an attached knowledge item: a reference, not the whole record. */
export const toKnowledgeReference = (item: KnowledgeItem): KnowledgeItem => {
	if (!item || typeof item !== 'object') return item;
	return Object.fromEntries(
		REFERENCE_KEYS.filter((k) => item[k] !== undefined && item[k] !== null && item[k] !== '').map((k) => [k, item[k]])
	);
};

const stopToString = (stop: unknown): string | null =>
	stop ? (typeof stop === 'string' ? stop.split(',') : ((stop as string[]) ?? [])).join(',') : null;

/** Builds the form state for a model being edited or cloned (or for a brand-new one when `model` is null). */
export function initialEditorState(
	model: (Json & { id: string; name: string }) | null,
	defaults: ModelDefaults,
	{ edit, baseModels }: { edit: boolean; baseModels: Array<{ id: string; preset?: boolean; arena?: boolean }> }
): EditorState {
	const state: EditorState = {
		id: '',
		name: '',
		info: blankInfo(),
		system: '',
		params: { system: '' },
		knowledge: [],
		toolIds: [],
		skillIds: [],
		filterIds: [],
		defaultFilterIds: [],
		actionIds: [],
		capabilities: { ...(model ? DEFAULT_CAPABILITIES : NEW_MODEL_CAPABILITIES), ...(defaults.capabilities ?? {}) },
		defaultFeatureIds: defaults.defaultFeatureIds ?? [],
		builtinTools: defaults.builtinTools ?? {},
		terminalId: '',
		tts: { voice: '' },
		accessGrants: []
	};
	if (!model) return state;

	// Structured clone: the editor mutates its copy, never the caller's model.
	const copy = JSON.parse(JSON.stringify(model)) as Json;
	state.name = model.name;
	state.id = model.id;

	if (copy.base_model_id) {
		const base = baseModels
			.filter((m) => (!m?.preset && !(m?.arena ?? false)) || (edit && m.id === copy.base_model_id))
			.find((m) => [copy.base_model_id, `${copy.base_model_id}:latest`].includes(m.id));
		if (base) copy.base_model_id = base.id;
		else if (!edit) copy.base_model_id = null;
	}

	state.system = model.params?.system ?? '';
	state.params = { ...state.params, ...(model.params ?? {}) };
	state.params.stop = stopToString(state.params.stop);
	state.knowledge = migrateKnowledge(model.meta?.knowledge);
	state.toolIds = model.meta?.toolIds ?? [];
	state.skillIds = model.meta?.skillIds ?? [];
	state.filterIds = model.meta?.filterIds ?? [];
	state.defaultFilterIds = model.meta?.defaultFilterIds ?? [];
	state.actionIds = model.meta?.actionIds ?? [];
	// A model's own settings win over the admin defaults.
	state.capabilities = { ...state.capabilities, ...(model.meta?.capabilities ?? {}) };
	state.defaultFeatureIds = model.meta?.defaultFeatureIds ?? state.defaultFeatureIds;
	state.builtinTools = model.meta?.builtinTools ?? state.builtinTools;
	state.terminalId = model.meta?.terminalId ?? '';
	state.tts = { voice: model.meta?.tts?.voice ?? '' };
	state.accessGrants = model.access_grants ?? [];
	state.info = { ...state.info, ...copy } as ModelInfo;
	return state;
}

/** The fields the editor checks, in the order they appear on the page. */
export type EditorField = 'name' | 'id' | 'base' | 'knowledge';
export type EditorErrors = Partial<Record<EditorField, string>>;

export type BuildResult = { ok: true; info: ModelInfo } | { ok: false; field: EditorField; error: string };

/**
 * FRM-2: what is wrong with the form, field by field, in words that say how
 * to put it right. `takenIds` are the ids a new model may not reuse.
 */
export function validateEditor(
	state: EditorState,
	{ preset, takenIds = [] }: { preset: boolean; takenIds?: string[] }
): EditorErrors {
	const errors: EditorErrors = {};
	if (state.name.trim() === '') errors.name = 'Enter a name for this model.';
	if (state.id === '') errors.id = 'Enter an ID: it names the model in the API.';
	else if (takenIds.includes(state.id))
		errors.id = `Another model already uses the ID “${state.id}”. Choose a different ID.`;
	if (preset && !state.info.base_model_id) errors.base = 'Choose the model this one is built on.';
	if (state.knowledge.some((item) => item.status === 'uploading'))
		errors.knowledge = 'Wait for the files to finish uploading, then save.';
	return errors;
}

/** The first field with an error, in page order. */
export const firstError = (errors: EditorErrors): EditorField | undefined =>
	(['name', 'id', 'base', 'knowledge'] as const).find((field) => errors[field]);

/** Sets `meta[key]` when there is something to store, deletes it when there is not. */
const setOrDelete = (meta: Json, key: string, present: boolean, value: unknown) => {
	if (present) meta[key] = value;
	else delete meta[key];
};

/**
 * Validates the form and assembles the object the API saves. Nothing is
 * mutated: the returned `info` is built on a copy. Every optional meta key is
 * *removed* -- not left empty -- when unset, as ModelEditor.svelte's
 * submitHandler did.
 */
export function buildModelInfo(
	state: EditorState,
	{ preset, takenIds }: { preset: boolean; takenIds?: string[] }
): BuildResult {
	const errors = validateEditor(state, { preset, takenIds });
	const field = firstError(errors);
	if (field) return { ok: false, field, error: errors[field] as string };

	const info: ModelInfo = JSON.parse(JSON.stringify({ ...state.info, id: state.id, name: state.name }));
	info.meta = info.meta ?? {};
	info.params = { ...info.params, ...state.params };
	info.access_grants = state.accessGrants;
	info.meta.capabilities = state.capabilities;

	// An empty description is stored as null, as before: the model then has no description of its own.
	const description = info.meta.description ?? '';
	info.meta.description = description.trim() === '' ? null : description;

	setOrDelete(info.meta, 'knowledge', state.knowledge.length > 0, state.knowledge.map(toKnowledgeReference));
	setOrDelete(info.meta, 'toolIds', state.toolIds.length > 0, state.toolIds);
	setOrDelete(info.meta, 'skillIds', state.skillIds.length > 0, state.skillIds);
	setOrDelete(info.meta, 'filterIds', state.filterIds.length > 0, state.filterIds);
	setOrDelete(info.meta, 'defaultFilterIds', state.defaultFilterIds.length > 0, state.defaultFilterIds);
	setOrDelete(info.meta, 'actionIds', state.actionIds.length > 0, state.actionIds);
	setOrDelete(info.meta, 'defaultFeatureIds', state.defaultFeatureIds.length > 0, state.defaultFeatureIds);
	setOrDelete(info.meta, 'builtinTools', Object.keys(state.builtinTools).length > 0, state.builtinTools);
	setOrDelete(info.meta, 'terminalId', Boolean(state.terminalId), state.terminalId);

	if (state.tts.voice !== '') {
		info.meta.tts = { ...(info.meta.tts ?? {}), voice: state.tts.voice };
	} else if (info.meta.tts?.voice) {
		delete info.meta.tts.voice;
		if (Object.keys(info.meta.tts).length === 0) delete info.meta.tts;
	}

	info.params.system = state.system.trim() === '' ? null : state.system;
	const stop = state.params.stop;
	info.params.stop = stop
		? (typeof stop === 'string' ? stop.split(',') : (stop as string[])).filter((s) => s.trim())
		: null;
	for (const key of Object.keys(info.params)) {
		if (info.params[key] === '' || info.params[key] === null) delete info.params[key];
	}
	return { ok: true, info };
}

// --- prompt-variable preview ---------------------------------------------------

const VARIABLE_KEY = /^[a-z][a-z0-9_]*$/;

export type VariablesPreview = {
	fields: Array<{ key: string; type?: string; required?: boolean; options?: unknown }>;
	userFields: Array<{ key: string }>;
	warnings: string[];
};

/**
 * What the "Detected Variables" panel under the system prompt shows: the
 * `{{chat.variables.x | ...}}` and `{{user.variables.x}}` placeholders found in
 * it, and warnings for definitions that would not work.
 */
export function getChatVariablesPreview(prompt: string): VariablesPreview {
	const variables = extractInputVariables(prompt);
	const warnings: string[] = [];
	const seen: Record<string, string> = {};

	for (const m of prompt.matchAll(/{{\s*chat\.variables\.([a-zA-Z0-9_.-]+)\s*\|\s*([^}]*)\s*}}/g)) {
		const definition = m[2].trim();
		if (seen[m[1]] && seen[m[1]] !== definition) warnings.push(`${m[1]} has conflicting duplicate definitions`);
		seen[m[1]] = definition;
	}

	const fields: VariablesPreview['fields'] = Object.entries(variables)
		.filter(([name]) => name.startsWith('chat.variables.'))
		.map(([name, field]) => ({ ...(field as object), key: name.replace('chat.variables.', '') }));
	const userFields = Object.keys(variables)
		.filter((name) => name.startsWith('user.variables.'))
		.map((name) => ({ key: name.replace('user.variables.', '') }));

	for (const m of prompt.matchAll(/{{\s*user\.variables\.([a-zA-Z0-9_.-]+)\s*\|\s*([^}]*)\s*}}/g)) {
		warnings.push(`${m[1]} uses metadata, but User Variables are configured by each user`);
	}
	for (const field of fields) {
		if (!VARIABLE_KEY.test(field.key)) {
			warnings.push(`${field.key} must be lowercase snake case`);
			continue;
		}
		if (field.type === 'select' && (!Array.isArray(field.options) || field.options.length === 0)) {
			warnings.push(`${field.key} select needs options=[...]`);
		}
	}
	for (const field of userFields) {
		if (!VARIABLE_KEY.test(field.key)) warnings.push(`${field.key} must be lowercase snake case`);
	}
	return { fields, userFields, warnings };
}

// --- base model choices ---------------------------------------------------------

type BaseModelCandidate = {
	id: string;
	name: string;
	preset?: boolean;
	owned_by?: string;
	direct?: boolean;
	info?: { meta?: { hidden?: boolean } };
};

/**
 * Models offered as "Base Model (From)": not the model being edited, not other
 * presets, not arena or direct-connection models, and not hidden ones unless
 * the viewer is an admin. The currently chosen base model is always kept so an
 * existing selection never disappears from its own picker.
 */
export function getBaseModelItems(
	models: BaseModelCandidate[],
	{
		currentModelId,
		edit,
		selectedBaseId,
		isAdmin
	}: { currentModelId?: string; edit: boolean; selectedBaseId: string | null; isAdmin: boolean }
) {
	return models
		.filter(
			(m) =>
				(!currentModelId || m.id !== currentModelId || (edit && m.id === selectedBaseId)) &&
				(!m?.preset || (edit && m.id === selectedBaseId)) &&
				m?.owned_by !== 'arena' &&
				!(m?.direct ?? false) &&
				(isAdmin || !(m?.info?.meta?.hidden ?? false) || m.id === selectedBaseId)
		)
		.map((m) => ({ value: m.id, label: m.name, model: m }));
}

// --- unsaved changes --------------------------------------------------------------

/**
 * Whether two form states hold the same values (FRM-3's "Unsaved changes"):
 * a deep comparison where key order does not matter and a key set to
 * `undefined` counts as absent, so switching something off and on again reads
 * as unchanged.
 */
export function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
	const ao = a as Json;
	const bo = b as Json;
	const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
	for (const key of keys) if (!sameValue(ao[key], bo[key])) return false;
	return true;
}
