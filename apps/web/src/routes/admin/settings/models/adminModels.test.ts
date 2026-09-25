import { describe, expect, it } from 'vitest';
import {
	type ViewOption,
	accessLabel,
	canReorder,
	defaultsFromConfig,
	defaultsMetadata,
	defaultsSnapshot,
	filterModels,
	isPresetModel,
	mergeModels,
	modelsConfigBody,
	moveItem,
	nextAccessGrants,
	orderIds,
	splitIds,
	toggleId,
	togglePlan,
	upsertPlan
} from './adminModels';

const pub = { principal_type: 'user', principal_id: '*', permission: 'read' };
const grp = { principal_type: 'group', principal_id: 'g1', permission: 'read' };

describe('access and kind', () => {
	it('labels a model public, shared or private', () => {
		expect(accessLabel({ access_grants: [pub] })).toBe('Public');
		expect(accessLabel({ access_grants: [grp] })).toBe('Shared');
		expect(accessLabel({ access_grants: [grp, pub] })).toBe('Public');
		expect(accessLabel({ access_grants: [] })).toBe('Private');
		expect(accessLabel({})).toBe('Private');
		expect(accessLabel(null)).toBe('Private');
	});
	it('a public write grant is not public', () => {
		expect(accessLabel({ access_grants: [{ ...pub, permission: 'write' }] })).toBe('Shared');
	});
	it('a preset is one with a base model (or the preset flag), a connection model is not', () => {
		expect(isPresetModel({ base_model_id: 'llama' })).toBe(true);
		expect(isPresetModel({ preset: true })).toBe(true);
		expect(isPresetModel({ info: { base_model_id: 'x' } })).toBe(true);
		expect(isPresetModel({ base_model_id: null })).toBe(false);
		expect(isPresetModel({ id: 'gpt' })).toBe(false);
	});
	it('making public adds the everyone grant to what is there; making private drops all', () => {
		expect(nextAccessGrants({ access_grants: [grp] })).toEqual([grp, pub]);
		expect(nextAccessGrants({ access_grants: [grp, pub] })).toEqual([]);
		expect(nextAccessGrants({})).toEqual([pub]);
	});
});

describe('mergeModels', () => {
	const served = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
	const provider = [{ id: 'b', name: 'B again' }, { id: 'c', name: 'C' }];
	const records = [{ id: 'a', name: 'A', is_active: false, base_model_id: null, meta: { tags: [{ name: 'fast' }] } }];
	it('adds connection models that are not served, and lays each record over its model', () => {
		const merged = mergeModels(served, provider, records, '');
		expect(merged.map((m) => m.id)).toEqual(['a', 'b', 'c']);
		expect(merged[0]).toMatchObject({ id: 'a', is_active: false });
		expect(merged[1]).toMatchObject({ id: 'b', name: 'B', is_active: true });
		expect(merged[2]).toMatchObject({ id: 'c', is_active: true });
	});
	it('with a tag, keeps only models that have a record', () => {
		expect(mergeModels(served, provider, records, 'fast').map((m) => m.id)).toEqual(['a']);
	});
});

describe('orderIds', () => {
	it('keeps the saved order, drops missing models, and appends new ones alphabetically', () => {
		const models = [{ id: 'z' }, { id: 'm' }, { id: 'a' }, { id: 'b' }];
		expect(orderIds(['b', 'gone', 'z'], models)).toEqual(['b', 'z', 'a', 'm']);
		expect(orderIds([], models)).toEqual(['a', 'b', 'm', 'z']);
	});
});

describe('filterModels', () => {
	const models = [
		{ id: 'a', name: 'Alpha', is_active: true, access_grants: [pub] },
		{ id: 'b', name: 'Beta', is_active: false, meta: { hidden: true } },
		{ id: 'c', name: 'Gamma' }
	];
	const base = { search: '', view: '' as ViewOption, order: [] as string[], selectedIds: new Set<string>(), pinnedIds: new Set<string>() };
	const ids = (f: Partial<typeof base>) => filterModels(models, { ...base, ...f }).map((m) => m.id);

	it('searches the name, ignoring case', () => {
		expect(ids({ search: 'AL' })).toEqual(['a']);
		expect(ids({ search: 'a' })).toEqual(['a', 'b', 'c']);
	});
	it('applies each view', () => {
		expect(ids({ view: 'enabled' })).toEqual(['a', 'c']);
		expect(ids({ view: 'disabled' })).toEqual(['b']);
		expect(ids({ view: 'hidden' })).toEqual(['b']);
		expect(ids({ view: 'visible' })).toEqual(['a', 'c']);
		expect(ids({ view: 'public' })).toEqual(['a']);
		expect(ids({ view: 'private' })).toEqual(['b', 'c']);
		expect(ids({ view: 'selected', selectedIds: new Set(['c']) })).toEqual(['c']);
		expect(ids({ view: 'pinned', pinnedIds: new Set(['b']) })).toEqual(['b']);
	});
	it('orders by the saved order, unlisted models last by name, and does not touch the input', () => {
		expect(ids({ order: ['c', 'a'] })).toEqual(['c', 'a', 'b']);
		expect(models.map((m) => m.id)).toEqual(['a', 'b', 'c']);
	});
	it('a model without a name is searched by id', () => {
		expect(filterModels([{ id: 'raw-model' }], { ...base, search: 'raw' })).toHaveLength(1);
	});
});

describe('reordering', () => {
	it('is only offered with no search, view or tag', () => {
		expect(canReorder({ search: '', view: '', selectedTag: '' })).toBe(true);
		expect(canReorder({ search: 'x', view: '', selectedTag: '' })).toBe(false);
		expect(canReorder({ search: '', view: 'enabled', selectedTag: '' })).toBe(false);
		expect(canReorder({ search: '', view: '', selectedTag: 't' })).toBe(false);
	});
	it('moveItem moves one element and leaves the input alone', () => {
		const list = ['a', 'b', 'c', 'd'];
		expect(moveItem(list, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
		expect(moveItem(list, 3, 1)).toEqual(['a', 'd', 'b', 'c']);
		expect(list).toEqual(['a', 'b', 'c', 'd']);
	});
	it('moveItem ignores a no-op or out-of-range move', () => {
		expect(moveItem(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
		expect(moveItem(['a', 'b'], 0, 5)).toEqual(['a', 'b']);
		expect(moveItem(['a', 'b'], -1, 0)).toEqual(['a', 'b']);
	});
});

describe('id lists', () => {
	it('toggleId adds without duplicating, and removes', () => {
		expect(toggleId(['a'], 'b')).toEqual(['a', 'b']);
		expect(toggleId(['a', 'b'], 'a')).toEqual(['b']);
	});
	it('splitIds drops empties', () => {
		expect(splitIds('a,,b,')).toEqual(['a', 'b']);
		expect(splitIds('')).toEqual([]);
		expect(splitIds(null)).toEqual([]);
	});
});

describe('modelsConfigBody', () => {
	const config = { DEFAULT_MODEL_METADATA: { capabilities: { vision: true } }, DEFAULT_MODEL_PARAMS: { temperature: 0.3 } };
	it('joins the lists and carries the stored defaults', () => {
		expect(modelsConfigBody(config, { selectedIds: ['a', 'b'], pinnedIds: ['b'], order: ['b', 'a'] })).toEqual({
			DEFAULT_MODELS: 'a,b',
			DEFAULT_PINNED_MODELS: 'b',
			MODEL_ORDER_LIST: ['b', 'a'],
			DEFAULT_MODEL_METADATA: { capabilities: { vision: true } },
			DEFAULT_MODEL_PARAMS: { temperature: 0.3 }
		});
	});
	it('takes new defaults when given, including an explicit empty one, and null when there is nothing', () => {
		const body = modelsConfigBody(config, { selectedIds: [], pinnedIds: [], order: [], metadata: { capabilities: {} }, params: {} });
		expect(body.DEFAULT_MODEL_METADATA).toEqual({ capabilities: {} });
		expect(body.DEFAULT_MODEL_PARAMS).toEqual({});
		const none = modelsConfigBody(null, { selectedIds: [], pinnedIds: [], order: [] });
		expect(none.DEFAULT_MODEL_METADATA).toBeNull();
		expect(none.DEFAULT_MODEL_PARAMS).toBeNull();
	});
});

describe('model defaults', () => {
	it('starts from the built-in capabilities when nothing is saved', () => {
		const d = defaultsFromConfig({ DEFAULT_MODEL_METADATA: {} }, null);
		expect(d.capabilities.vision).toBe(true);
		expect(d.defaultFeatureIds).toEqual([]);
		expect(d.params).toEqual({});
		expect(d.promptSuggestions).toEqual([]);
	});
	it('reads what is saved', () => {
		const d = defaultsFromConfig({ DEFAULT_MODEL_METADATA: { capabilities: { vision: false }, defaultFeatureIds: ['web_search'], builtinTools: { time: false } }, DEFAULT_MODEL_PARAMS: { top_p: 0.9 } }, [{ content: 'Hi', title: ['t', 's'] }]);
		expect(d).toEqual({ capabilities: { vision: false }, defaultFeatureIds: ['web_search'], builtinTools: { time: false }, params: { top_p: 0.9 }, promptSuggestions: [{ content: 'Hi', title: ['t', 's'] }] });
	});
	it('stores empty feature and tool lists as absent', () => {
		expect(defaultsMetadata({ capabilities: { vision: true }, defaultFeatureIds: [], builtinTools: {}, params: {}, promptSuggestions: [] })).toEqual({ capabilities: { vision: true } });
		expect(defaultsMetadata({ capabilities: {}, defaultFeatureIds: ['web_search'], builtinTools: { time: false }, params: {}, promptSuggestions: [] })).toEqual({ capabilities: {}, defaultFeatureIds: ['web_search'], builtinTools: { time: false } });
	});
	it('a snapshot ignores unset params and blank suggestions, but sees real changes', () => {
		const d = defaultsFromConfig(null, []);
		const same = { ...d, params: { temperature: null, seed: '' }, promptSuggestions: [{ content: '', title: ['x', 'y'] as [string, string] }] };
		expect(defaultsSnapshot(same)).toBe(defaultsSnapshot(d));
		expect(defaultsSnapshot({ ...d, params: { temperature: 0.2 } })).not.toBe(defaultsSnapshot(d));
		expect(defaultsSnapshot({ ...d, capabilities: { ...d.capabilities, vision: false } })).not.toBe(defaultsSnapshot(d));
	});
});

describe('upsertPlan', () => {
	const records = new Set(['has-record']);
	it('updates a model that has a record, never giving a connection model a base model', () => {
		const p = upsertPlan({ id: 'has-record', name: 'X', base_model_id: 'stale' }, { is_active: true }, records);
		expect(p.action).toBe('update');
		// It IS a preset (has a base model), so the base is kept.
		expect(p.action === 'update' && p.body.base_model_id).toBe('stale');
		const q = upsertPlan({ id: 'has-record', name: 'X', base_model_id: null }, { is_active: false }, records);
		expect(q.action === 'update' && q.body).toMatchObject({ base_model_id: null, is_active: false });
	});
	it('updates a preset even without a known record', () => {
		expect(upsertPlan({ id: 'p', name: 'P', base_model_id: 'llama' }, {}, new Set()).action).toBe('update');
	});
	it('creates a record for a connection model that has none, with the override applied', () => {
		const p = upsertPlan({ id: 'gpt', name: 'GPT', is_active: true }, { is_active: false }, records);
		expect(p.action).toBe('create');
		expect(p.action === 'create' && p.body).toMatchObject({ id: 'gpt', name: 'GPT', base_model_id: null, meta: {}, params: {}, access_grants: [], is_active: false });
	});
});

describe('togglePlan', () => {
	it('creates the record, in its new state, for a model that has none', () => {
		expect(togglePlan({ id: 'gpt', name: 'GPT' }, false)).toEqual({ action: 'create', body: { id: 'gpt', name: 'GPT', base_model_id: null, meta: {}, params: {}, access_grants: [], is_active: false } });
	});
	it('flips one that has a record (it carries base_model_id) or is a preset', () => {
		expect(togglePlan({ id: 'a', name: 'A', base_model_id: null }, true)).toEqual({ action: 'toggle', id: 'a' });
		expect(togglePlan({ id: 'p', name: 'P', base_model_id: 'x' }, true)).toEqual({ action: 'toggle', id: 'p' });
	});
});
