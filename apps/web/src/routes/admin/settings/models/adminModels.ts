import { DEFAULT_CAPABILITIES } from '@/lib/constants';
import { configuredParams } from '../interfaceTasks';

type Rec = Record<string, any>;
export type ModelItem = { id: string; name?: string } & Rec;

// --- what a model is, as the list shows it ---------------------------------------

export const isPublicModel = (model: Rec | null | undefined): boolean =>
	(model?.access_grants ?? []).some((g: Rec) => g.principal_type === 'user' && g.principal_id === '*' && g.permission === 'read');

export const isSharedModel = (model: Rec | null | undefined): boolean => (model?.access_grants ?? []).length > 0 && !isPublicModel(model);

/** A preset is a model an admin built on top of another; anything else is a connection model. */
export const isPresetModel = (model: Rec | null | undefined): boolean => Boolean(model?.preset || model?.base_model_id || model?.info?.base_model_id);

export const accessLabel = (model: Rec | null | undefined): 'Public' | 'Shared' | 'Private' => (isPublicModel(model) ? 'Public' : isSharedModel(model) ? 'Shared' : 'Private');

export const VIEW_OPTIONS = [
	['', 'All'],
	['enabled', 'Enabled'],
	['disabled', 'Disabled'],
	['visible', 'Visible'],
	['hidden', 'Hidden'],
	['public', 'Public'],
	['private', 'Private'],
	['selected', 'Selected'],
	['pinned', 'Pinned']
] as const;

export type ViewOption = (typeof VIEW_OPTIONS)[number][0];

// --- building the list ----------------------------------------------------------

/**
 * Every model an admin can manage: the ones the app serves, plus connection
 * models that are not enabled yet (`providerModels`), each overlaid with its
 * stored record (`baseModels`) when it has one. A model with no record is
 * shown as enabled, which is what it is until someone stores a record.
 * With a tag chosen, only models that have a record carrying it are kept.
 */
export function mergeModels(served: ModelItem[], providerModels: ModelItem[], baseModels: ModelItem[], selectedTag: string): ModelItem[] {
	const known = new Set(served.map((m) => m.id));
	const all = [...served, ...providerModels.filter((m) => !known.has(m.id))];
	const records = new Map(baseModels.map((m) => [m.id, m]));
	return all
		.filter((m) => !selectedTag || records.has(m.id))
		.map((m) => {
			const record = records.get(m.id);
			return record ? { ...m, ...record } : { ...m, id: m.id, name: m.name, is_active: true };
		});
}

/** The saved order, minus models that no longer exist, then any new ones alphabetically. */
export function orderIds(saved: string[], models: ModelItem[]): string[] {
	const present = new Set(models.map((m) => m.id));
	const kept = saved.filter((id) => present.has(id));
	const keptSet = new Set(kept);
	return [
		...kept,
		...models
			.map((m) => m.id)
			.filter((id) => !keptSet.has(id))
			.sort((a, b) => a.localeCompare(b))
	];
}

export type Filters = { search: string; view: ViewOption; order: string[]; selectedIds: ReadonlySet<string>; pinnedIds: ReadonlySet<string> };

/** The models to show: filtered by search text and view, in the saved order (name breaks ties). */
export function filterModels(models: ModelItem[], { search, view, order, selectedIds, pinnedIds }: Filters): ModelItem[] {
	const rank = new Map(order.map((id, i) => [id, i]));
	const needle = search.toLowerCase();
	const matches = (m: ModelItem) => {
		if (needle && !(m.name ?? m.id).toLowerCase().includes(needle)) return false;
		switch (view) {
			case 'enabled':
				return m.is_active ?? true;
			case 'disabled':
				return !(m.is_active ?? true);
			case 'visible':
				return !(m.meta?.hidden ?? false);
			case 'hidden':
				return m.meta?.hidden === true;
			case 'public':
				return isPublicModel(m);
			case 'private':
				return !isPublicModel(m);
			case 'selected':
				return selectedIds.has(m.id);
			case 'pinned':
				return pinnedIds.has(m.id);
			default:
				return true;
		}
	};
	return models
		.filter(matches)
		.sort((a, b) => {
			const ra = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
			const rb = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
			return ra !== rb ? ra - rb : (a.name ?? a.id).localeCompare(b.name ?? b.id);
		});
}

/** Reordering only makes sense on the whole list: a filtered view hides the rows a drop would land among. */
export const canReorder = (f: Pick<Filters, 'search' | 'view'> & { selectedTag: string }): boolean => f.search === '' && f.view === '' && f.selectedTag === '';

/** `list` with the item at `from` moved to `to`. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
	if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
	const next = [...list];
	const [item] = next.splice(from, 1);
	next.splice(to, 0, item);
	return next;
}

/** `ids` with `id` added, or removed if it is already there. */
export const toggleId = (ids: readonly string[], id: string): string[] => (ids.includes(id) ? ids.filter((x) => x !== id) : [...new Set([...ids, id])]);

export const splitIds = (csv: string | null | undefined): string[] => (csv ?? '').split(',').filter((id) => id);

// --- what saving sends -----------------------------------------------------------

export type ModelsConfigParts = { selectedIds: string[]; pinnedIds: string[]; order: string[]; metadata?: Rec | null; params?: Rec | null };

/** The body of `POST /configs/models`: the three lists, plus the defaults it already had unless new ones are given. */
export function modelsConfigBody(config: Rec | null | undefined, { selectedIds, pinnedIds, order, metadata, params }: ModelsConfigParts) {
	return {
		DEFAULT_MODELS: selectedIds.join(','),
		DEFAULT_PINNED_MODELS: pinnedIds.join(','),
		MODEL_ORDER_LIST: order,
		DEFAULT_MODEL_METADATA: metadata !== undefined ? metadata : (config?.DEFAULT_MODEL_METADATA ?? null),
		DEFAULT_MODEL_PARAMS: params !== undefined ? params : (config?.DEFAULT_MODEL_PARAMS ?? null)
	};
}

export type PromptSuggestion = { content: string; title: [string, string] };

/** What the "Model Defaults" panel edits. */
export type DefaultsState = { capabilities: Rec; defaultFeatureIds: string[]; builtinTools: Rec; params: Rec; promptSuggestions: PromptSuggestion[] };

export function defaultsFromConfig(config: Rec | null | undefined, suggestions: PromptSuggestion[] | null | undefined): DefaultsState {
	const saved = config?.DEFAULT_MODEL_METADATA;
	const hasSaved = saved && Object.keys(saved).length > 0;
	return {
		capabilities: hasSaved ? (saved.capabilities ?? { ...DEFAULT_CAPABILITIES }) : { ...DEFAULT_CAPABILITIES },
		defaultFeatureIds: hasSaved ? (saved.defaultFeatureIds ?? []) : [],
		builtinTools: hasSaved ? (saved.builtinTools ?? {}) : {},
		params: config?.DEFAULT_MODEL_PARAMS ?? {},
		promptSuggestions: suggestions ?? []
	};
}

/** The `DEFAULT_MODEL_METADATA` to store: empty feature and tool lists are left out. */
export const defaultsMetadata = (d: DefaultsState): Rec => ({
	capabilities: d.capabilities,
	...(d.defaultFeatureIds.length > 0 ? { defaultFeatureIds: d.defaultFeatureIds } : {}),
	...(Object.keys(d.builtinTools).length > 0 ? { builtinTools: d.builtinTools } : {})
});

export const nonBlankSuggestions = (list: PromptSuggestion[]) => list.filter((p) => p.content !== '');

/** Two states with the same snapshot are the same as far as saving goes (unset params and blank suggestions do not count). */
export const defaultsSnapshot = (d: DefaultsState): string =>
	JSON.stringify({ capabilities: d.capabilities, defaultFeatureIds: d.defaultFeatureIds, params: configuredParams(d.params), builtinTools: d.builtinTools, promptSuggestions: nonBlankSuggestions(d.promptSuggestions) });

export const savedParams = (d: DefaultsState) => configuredParams(d.params);

// --- changing one model ------------------------------------------------------------

export type Plan = { action: 'update'; id: string; body: Rec } | { action: 'create'; body: Rec };

/**
 * How to store a change to `model`: update its record if it has one (or is a
 * preset), else create the record. A non-preset is never given a base model.
 */
export function upsertPlan(model: ModelItem, overrides: Rec, recordIds: ReadonlySet<string>): Plan {
	const next = { ...model, ...(isPresetModel(model) ? {} : { base_model_id: null }), ...overrides };
	if (recordIds.has(next.id) || isPresetModel(next)) return { action: 'update', id: next.id, body: next };
	return { action: 'create', body: { meta: {}, base_model_id: null, params: {}, access_grants: [], ...next } };
}

/** The enable switch: a model that has no record yet is created (in its new state); one that has flips. */
export function togglePlan(model: ModelItem, nextActive: boolean): { action: 'create'; body: Rec } | { action: 'toggle'; id: string } {
	if (!('base_model_id' in model) && !isPresetModel(model)) {
		return { action: 'create', body: { id: model.id, name: model.name, base_model_id: null, meta: {}, params: {}, access_grants: [], is_active: nextActive } };
	}
	return { action: 'toggle', id: model.id };
}

/** Access grants after making a model public (the everyone-can-read grant added) or private (all grants dropped). */
export const nextAccessGrants = (model: Rec): Rec[] =>
	isPublicModel(model) ? [] : [...(model.access_grants ?? []), { principal_type: 'user', principal_id: '*', permission: 'read' }];
