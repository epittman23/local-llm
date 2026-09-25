import { describe, expect, it } from 'vitest';
import { DEFAULT_EDIT_WORKFLOW_NODES, DEFAULT_WORKFLOW_NODES, fromNodeRows, isJsonObject, missingGenerationSetting, parseParams, prepareImagesConfig, prettyJson, toFormState, toNodeRows } from './images';

describe('toNodeRows / fromNodeRows', () => {
	it('starts from the defaults and lets the server override a type it knows, joining id lists', () => {
		const rows = toNodeRows(DEFAULT_WORKFLOW_NODES, [{ type: 'prompt', key: 'text', node_ids: ['6', '7'] }, { type: 'seed', key: 'noise_seed', node_ids: '3' }]);
		expect(rows.map((r) => r.type)).toEqual(DEFAULT_WORKFLOW_NODES.map((r) => r.type));
		expect(rows[0]).toEqual({ type: 'prompt', key: 'text', node_ids: '6,7' });
		expect(rows.find((r) => r.type === 'seed')).toEqual({ type: 'seed', key: 'noise_seed', node_ids: '3' });
		expect(rows.find((r) => r.type === 'width')).toEqual(DEFAULT_WORKFLOW_NODES[2]);
	});
	it('copes with the server sending nothing', () => {
		expect(toNodeRows(DEFAULT_EDIT_WORKFLOW_NODES, null)).toEqual(DEFAULT_EDIT_WORKFLOW_NODES);
		expect(toNodeRows(DEFAULT_EDIT_WORKFLOW_NODES, undefined)).toEqual(DEFAULT_EDIT_WORKFLOW_NODES);
	});
	it('turns the text back into trimmed id lists without blanks', () => {
		expect(fromNodeRows([{ type: 'prompt', key: 'text', node_ids: ' 6 , ,7,' }, { type: 'seed', key: 'seed', node_ids: '' }])).toEqual([
			{ type: 'prompt', key: 'text', node_ids: ['6', '7'] },
			{ type: 'seed', key: 'seed', node_ids: [] }
		]);
	});
});

describe('prettyJson', () => {
	it('indents JSON and leaves anything else as it was', () => {
		expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
		expect(prettyJson('not json')).toBe('not json');
		expect(prettyJson(null)).toBe('');
	});
});

describe('parseParams / isJsonObject', () => {
	it('blank is an empty object; only a JSON object is otherwise accepted', () => {
		expect(parseParams('')).toEqual({});
		expect(parseParams('  ')).toEqual({});
		expect(parseParams(undefined)).toEqual({});
		expect(parseParams('{"a":1}')).toEqual({ a: 1 });
		expect(parseParams({ a: 1 })).toEqual({ a: 1 });
		for (const bad of ['{a', '[1]', '"s"', '5', 'null']) expect(parseParams(bad)).toBeNull();
	});
	it('a workflow must be a non-empty JSON object', () => {
		expect(isJsonObject('{"3":{"class_type":"KSampler"}}')).toBe(true);
		expect(isJsonObject('')).toBe(false);
		expect(isJsonObject('[1]')).toBe(false);
		expect(isJsonObject('{oops')).toBe(false);
	});
});

describe('missingGenerationSetting', () => {
	const on = { ENABLE_IMAGE_GENERATION: true };
	it('names what the chosen engine still needs', () => {
		expect(missingGenerationSetting({ ...on, IMAGE_GENERATION_ENGINE: 'automatic1111', AUTOMATIC1111_BASE_URL: '' })).toBe('AUTOMATIC1111 Base URL is required.');
		expect(missingGenerationSetting({ ...on, IMAGE_GENERATION_ENGINE: 'comfyui', COMFYUI_BASE_URL: ' ' })).toBe('ComfyUI Base URL is required.');
		expect(missingGenerationSetting({ ...on, IMAGE_GENERATION_ENGINE: 'openai', IMAGES_OPENAI_API_KEY: '' })).toBe('OpenAI API Key is required.');
		expect(missingGenerationSetting({ ...on, IMAGE_GENERATION_ENGINE: 'gemini', IMAGES_GEMINI_API_KEY: null })).toBe('Gemini API Key is required.');
	});
	it('is satisfied by a value, and never asked while generation is off', () => {
		expect(missingGenerationSetting({ ...on, IMAGE_GENERATION_ENGINE: 'openai', IMAGES_OPENAI_API_KEY: 'sk' })).toBeNull();
		expect(missingGenerationSetting({ ENABLE_IMAGE_GENERATION: false, IMAGE_GENERATION_ENGINE: 'openai', IMAGES_OPENAI_API_KEY: '' })).toBeNull();
	});
});

describe('prepareImagesConfig', () => {
	const base = { ENABLE_IMAGE_GENERATION: false, IMAGE_GENERATION_ENGINE: 'openai', AUTOMATIC1111_PARAMS: '', IMAGES_OPENAI_API_PARAMS: '{"quality":"hd"}', COMFYUI_WORKFLOW: '', IMAGES_EDIT_COMFYUI_WORKFLOW: '', KEEP: 'me' };
	const rows = DEFAULT_WORKFLOW_NODES.map((r) => (r.type === 'prompt' ? { ...r, node_ids: '6' } : r));

	it('parses the params into objects and passes every other key through', () => {
		const r = prepareImagesConfig(base, rows, DEFAULT_EDIT_WORKFLOW_NODES);
		expect(r).toEqual({ ok: true, payload: { ...base, AUTOMATIC1111_PARAMS: {}, IMAGES_OPENAI_API_PARAMS: { quality: 'hd' } } });
	});
	it('takes the node lists from the rows only for a workflow that is set', () => {
		const withWorkflow = prepareImagesConfig({ ...base, COMFYUI_WORKFLOW: '{"1":{}}' }, rows, DEFAULT_EDIT_WORKFLOW_NODES);
		expect(withWorkflow.ok && withWorkflow.payload.COMFYUI_WORKFLOW_NODES[0]).toEqual({ type: 'prompt', key: 'text', node_ids: ['6'] });
		expect(withWorkflow.ok && 'IMAGES_EDIT_COMFYUI_WORKFLOW_NODES' in withWorkflow.payload).toBe(false);
		const none = prepareImagesConfig(base, rows, DEFAULT_EDIT_WORKFLOW_NODES);
		expect(none.ok && 'COMFYUI_WORKFLOW_NODES' in none.payload).toBe(false);
	});
	it('refuses a workflow that is not JSON, and says which', () => {
		expect(prepareImagesConfig({ ...base, COMFYUI_WORKFLOW: '{oops' }, rows, [])).toEqual({ ok: false, error: 'Invalid JSON format for ComfyUI Workflow.' });
		expect(prepareImagesConfig({ ...base, IMAGES_EDIT_COMFYUI_WORKFLOW: '[1]' }, rows, [])).toEqual({ ok: false, error: 'Invalid JSON format for ComfyUI Edit Workflow.' });
	});
	it('refuses bad params instead of throwing', () => {
		expect(prepareImagesConfig({ ...base, AUTOMATIC1111_PARAMS: '{x' }, rows, []).ok).toBe(false);
		expect(prepareImagesConfig({ ...base, IMAGES_OPENAI_API_PARAMS: '[1]' }, rows, []).ok).toBe(false);
	});
	it('a missing engine setting refuses the save and asks for generation to be switched off', () => {
		expect(prepareImagesConfig({ ...base, ENABLE_IMAGE_GENERATION: true, IMAGES_OPENAI_API_KEY: '' }, rows, [])).toEqual({ ok: false, error: 'OpenAI API Key is required.', disableGeneration: true });
	});
});

describe('toFormState', () => {
	it('shows workflows and params indented, and the node lists as rows', () => {
		const s = toFormState({
			COMFYUI_WORKFLOW: '{"1":{}}',
			IMAGES_EDIT_COMFYUI_WORKFLOW: '',
			AUTOMATIC1111_PARAMS: { a: 1 },
			IMAGES_OPENAI_API_PARAMS: null,
			COMFYUI_WORKFLOW_NODES: [{ type: 'prompt', key: 'text', node_ids: ['9'] }],
			IMAGES_EDIT_COMFYUI_WORKFLOW_NODES: []
		});
		expect(s.config.COMFYUI_WORKFLOW).toBe('{\n  "1": {}\n}');
		expect(s.config.IMAGES_EDIT_COMFYUI_WORKFLOW).toBe('');
		expect(s.config.AUTOMATIC1111_PARAMS).toBe('{\n  "a": 1\n}');
		expect(s.config.IMAGES_OPENAI_API_PARAMS).toBe('{}');
		expect(s.nodes[0].node_ids).toBe('9');
		expect(s.editNodes).toEqual(DEFAULT_EDIT_WORKFLOW_NODES);
	});
});
