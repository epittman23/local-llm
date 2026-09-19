import { describe, expect, it } from 'vitest';
import {
	type EditorState,
	buildModelInfo,
	getBaseModelItems,
	getChatVariablesPreview,
	initialEditorState,
	migrateKnowledge,
	modelIdFromName,
	toKnowledgeReference
} from './modelEditorLogic';

const fresh = (over: Partial<EditorState> = {}): EditorState => ({ ...initialEditorState(null, {}, { edit: false, baseModels: [] }), id: 'm1', name: 'M1', ...over });
const withBase = (state: EditorState, base = 'llama3'): EditorState => ({ ...state, info: { ...state.info, base_model_id: base } });

describe('modelIdFromName', () => {
	it('lowercases, hyphenates whitespace and drops everything else', () => {
		expect(modelIdFromName('My Model 2!')).toBe('my-model-2');
		expect(modelIdFromName('Café  Bot')).toBe('caf-bot');
	});
});

describe('buildModelInfo: validation', () => {
	it('checks id, name, base model (for presets) and pending uploads, in that order', () => {
		expect(buildModelInfo(fresh({ id: '' }), { preset: true })).toEqual({ ok: false, error: 'Model ID is required.' });
		expect(buildModelInfo(fresh({ name: '' }), { preset: true })).toEqual({ ok: false, error: 'Model Name is required.' });
		expect(buildModelInfo(fresh(), { preset: true })).toEqual({ ok: false, error: 'Base Model is required.' });
		expect(buildModelInfo(fresh(), { preset: false }).ok).toBe(true); // a non-preset needs no base
		expect(buildModelInfo(withBase(fresh({ knowledge: [{ id: 'k', status: 'uploading' }] })), { preset: true })).toEqual({
			ok: false,
			error: 'Please wait until all files are uploaded.'
		});
	});
});

describe('buildModelInfo: what is stored', () => {
	const build = (state: EditorState) => {
		const r = buildModelInfo(withBase(state), { preset: true });
		if (!r.ok) throw new Error(r.error);
		return r.info;
	};

	it('does not mutate the form state it was given', () => {
		const state = withBase(fresh({ toolIds: ['t'] }));
		const before = JSON.stringify(state);
		buildModelInfo(state, { preset: true });
		expect(JSON.stringify(state)).toBe(before);
	});

	it('removes optional meta keys when empty and keeps them when set', () => {
		const empty = build(fresh());
		for (const key of ['knowledge', 'toolIds', 'skillIds', 'filterIds', 'defaultFilterIds', 'actionIds', 'defaultFeatureIds', 'builtinTools', 'terminalId']) {
			expect(empty.meta).not.toHaveProperty(key);
		}
		const full = build(fresh({ toolIds: ['t'], skillIds: ['s'], filterIds: ['f'], actionIds: ['a'], defaultFeatureIds: ['web_search'], builtinTools: { time: false }, terminalId: 'term' }));
		expect(full.meta).toMatchObject({ toolIds: ['t'], skillIds: ['s'], filterIds: ['f'], actionIds: ['a'], defaultFeatureIds: ['web_search'], builtinTools: { time: false }, terminalId: 'term' });
	});

	it('stores an empty stale key as absent: a previously saved toolIds is deleted when none are selected', () => {
		const state = withBase(fresh());
		state.info = { ...state.info, meta: { ...state.info.meta, toolIds: ['old'] } };
		expect(build(state).meta).not.toHaveProperty('toolIds');
	});

	it('saves knowledge as references only', () => {
		const info = build(fresh({ knowledge: [{ id: 'k1', name: 'KB', type: 'collection', files: [{ big: 'record' }], status: 'uploaded', user: { x: 1 } }] }));
		expect(info.meta.knowledge).toEqual([{ id: 'k1', name: 'KB', type: 'collection' }]);
	});

	it('description: off or blank -> null; otherwise kept', () => {
		expect(build(fresh({ enableDescription: false })).meta.description).toBeNull();
		const state = withBase(fresh());
		state.info = { ...state.info, meta: { ...state.info.meta, description: '   ' } };
		expect(build(state).meta.description).toBeNull();
		state.info = { ...state.info, meta: { ...state.info.meta, description: 'Helpful' } };
		expect(build(state).meta.description).toBe('Helpful');
	});

	it('system prompt: blank -> dropped; stop: comma string -> trimmed-nonblank list; empty params are removed', () => {
		const info = build(fresh({ system: '  ', params: { system: '', stop: 'END, ,STOP', temperature: 0.5, seed: '', top_k: null, custom_params: { a: 'b' } } }));
		expect(info.params).not.toHaveProperty('system');
		// Entries are not trimmed (a leading space can be part of a stop sequence); only blank ones are dropped.
		expect(info.params.stop).toEqual(['END', 'STOP']);
		expect(build(fresh({ params: { stop: 'a, b' } })).params.stop).toEqual(['a', ' b']);
		expect(info.params).toMatchObject({ temperature: 0.5, custom_params: { a: 'b' } });
		expect(info.params).not.toHaveProperty('seed');
		expect(info.params).not.toHaveProperty('top_k');
		expect(build(fresh({ system: 'Be brief', params: { stop: '' } })).params).toMatchObject({ system: 'Be brief' });
	});

	it('tts: sets a voice, and removes an emptied one without leaving {} behind', () => {
		expect(build(fresh({ tts: { voice: 'alloy' } })).meta.tts).toEqual({ voice: 'alloy' });
		const state = withBase(fresh({ tts: { voice: '' } }));
		state.info = { ...state.info, meta: { ...state.info.meta, tts: { voice: 'old' } } };
		expect(build(state).meta).not.toHaveProperty('tts');
		state.info = { ...state.info, meta: { ...state.info.meta, tts: { voice: 'old', speed: 2 } } };
		expect(build(state).meta.tts).toEqual({ speed: 2 });
	});

	it('carries capabilities and access grants', () => {
		const grants = [{ principal_type: 'user' as const, principal_id: '*', permission: 'read' as const }];
		const info = build(fresh({ capabilities: { vision: false }, accessGrants: grants }));
		expect(info.meta.capabilities).toEqual({ vision: false });
		expect(info.access_grants).toEqual(grants);
	});
});

describe('initialEditorState', () => {
	const bases = [{ id: 'llama3:latest' }, { id: 'gpt-4o' }, { id: 'a-preset', preset: true }];

	it('layers admin defaults under the model\'s own capabilities, features and tools', () => {
		const s = initialEditorState(
			{ id: 'm', name: 'M', meta: { capabilities: { vision: false }, defaultFeatureIds: ['web_search'] } },
			{ capabilities: { vision: true, file_upload: false }, defaultFeatureIds: ['code_interpreter'], builtinTools: { time: false } },
			{ edit: true, baseModels: bases }
		);
		expect(s.capabilities).toMatchObject({ vision: false, file_upload: false });
		expect(s.defaultFeatureIds).toEqual(['web_search']);
		expect(s.builtinTools).toEqual({ time: false });
	});

	it('resolves a base model id by exact or :latest match; a clone loses an unknown base, an edit keeps it', () => {
		const model = (base: string) => ({ id: 'm', name: 'M', base_model_id: base, meta: {} });
		expect(initialEditorState(model('llama3'), {}, { edit: false, baseModels: bases }).info.base_model_id).toBe('llama3:latest');
		expect(initialEditorState(model('gone'), {}, { edit: false, baseModels: bases }).info.base_model_id).toBeNull();
		expect(initialEditorState(model('gone'), {}, { edit: true, baseModels: bases }).info.base_model_id).toBe('gone');
		// A preset is never a valid base for a clone, but is kept when editing a model already built on it.
		expect(initialEditorState(model('a-preset'), {}, { edit: false, baseModels: bases }).info.base_model_id).toBeNull();
		expect(initialEditorState(model('a-preset'), {}, { edit: true, baseModels: bases }).info.base_model_id).toBe('a-preset');
	});

	it('copies the model (edits never leak back), and turns stop lists into a comma string', () => {
		const model = { id: 'm', name: 'M', meta: { tags: [{ name: 'x' }] }, params: { stop: ['a', 'b'], system: 'S' } };
		const s = initialEditorState(model, {}, { edit: true, baseModels: [] });
		expect(s.params.stop).toBe('a,b');
		expect(s.system).toBe('S');
		s.info.meta.tags.push({ name: 'y' });
		expect(model.meta.tags).toHaveLength(1);
	});

	it('a null description means "default description" (toggle off)', () => {
		expect(initialEditorState({ id: 'm', name: 'M', meta: { description: null } }, {}, { edit: true, baseModels: [] }).enableDescription).toBe(false);
		expect(initialEditorState({ id: 'm', name: 'M', meta: { description: 'x' } }, {}, { edit: true, baseModels: [] }).enableDescription).toBe(true);
	});
});

describe('knowledge', () => {
	it('migrates legacy collection references', () => {
		expect(migrateKnowledge([{ collection_name: 'c1', name: 'Old' }, { collection_names: ['a', 'b'], name: 'Multi' }, { id: 'k', type: 'file', collection_name: 'x' }])).toEqual([
			{ id: 'c1', name: 'Old', legacy: true },
			{ name: 'Multi', type: 'collection', collection_names: ['a', 'b'], legacy: true },
			{ id: 'k', type: 'file', collection_name: 'x' }
		]);
		expect(migrateKnowledge(null)).toEqual([]);
	});
	it('reference keeps only the whitelisted, non-empty keys', () => {
		expect(toKnowledgeReference({ id: 'k', name: '', description: null, context: 'full', files: [1] })).toEqual({ id: 'k', context: 'full' });
	});
});

describe('getChatVariablesPreview', () => {
	it('lists chat and user variables', () => {
		const p = getChatVariablesPreview('Hi {{chat.variables.tone | select:options=["a","b"]}} {{user.variables.city}}');
		expect(p.fields.map((f) => f.key)).toEqual(['tone']);
		expect(p.userFields.map((f) => f.key)).toEqual(['city']);
		expect(p.warnings).toEqual([]);
	});
	it('warns about non-snake-case keys, select without options, conflicting duplicates and typed user variables', () => {
		const w = getChatVariablesPreview('{{chat.variables.BadKey | text}} {{chat.variables.pick | select}} {{chat.variables.x | text}} {{chat.variables.x | number}} {{user.variables.u | text}}').warnings;
		expect(w).toContain('BadKey must be lowercase snake case');
		expect(w).toContain('pick select needs options=[...]');
		expect(w).toContain('x has conflicting duplicate definitions');
		expect(w).toContain('u uses metadata, but User Variables are configured by each user');
	});
});

describe('getBaseModelItems', () => {
	const models = [
		{ id: 'self', name: 'Self' },
		{ id: 'a', name: 'A' },
		{ id: 'p', name: 'Preset', preset: true },
		{ id: 'arena', name: 'Arena', owned_by: 'arena' },
		{ id: 'd', name: 'Direct', direct: true },
		{ id: 'h', name: 'Hidden', info: { meta: { hidden: true } } }
	];
	it('excludes self, presets, arena, direct and (for non-admins) hidden models', () => {
		const ids = (isAdmin: boolean) => getBaseModelItems(models, { currentModelId: 'self', edit: false, selectedBaseId: null, isAdmin }).map((i) => i.value);
		expect(ids(false)).toEqual(['a']);
		expect(ids(true)).toEqual(['a', 'h']);
	});
	it('always keeps the currently selected base, even a preset or hidden one', () => {
		const ids = getBaseModelItems(models, { currentModelId: 'self', edit: true, selectedBaseId: 'p', isAdmin: false }).map((i) => i.value);
		expect(ids).toContain('p');
		expect(getBaseModelItems(models, { edit: false, selectedBaseId: 'h', isAdmin: false }).map((i) => i.value)).toContain('h');
	});
});
