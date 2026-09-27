import { describe, expect, it } from 'vitest';
import { allCapable, commandAt, featureButtons, fillPromptVariables, imageTargetSize, isUrl, modelDefaults, replaceCommand } from './attachments';

const models = [{ id: 'a', info: { meta: { capabilities: { vision: false, web_search: true }, toolIds: ['t1', 'gone'], defaultFeatureIds: ['web_search'] } } }, { id: 'b' }];
const user = (features = {}, role = 'user') => ({ id: 'u', name: 'U', email: '', role, permissions: { features } }) as any;

describe('capabilities and buttons', () => {
	it('treats an unset capability as present', () => {
		expect(allCapable(['b'], models, 'vision')).toBe(true);
		expect(allCapable(['a', 'b'], models, 'vision')).toBe(false);
	});
	it('shows a feature only with the server switch, the permission and the capability', () => {
		const f = { enable_web_search: true, enable_image_generation: true };
		expect(featureButtons(['a'], models, user({ web_search: true }), f)).toEqual({ webSearch: true, imageGeneration: false, codeInterpreter: false });
		expect(featureButtons(['a'], models, user({}, 'admin'), f).imageGeneration).toBe(true);
	});
	it('starts a model with its tools and default features', () => {
		const d = modelDefaults(models[0], ['t1'], ['saved'], { webSearch: true, imageGeneration: false, codeInterpreter: false });
		expect(d).toEqual({ toolIds: ['t1'], webSearch: true, imageGeneration: null, codeInterpreter: null });
		expect(modelDefaults(models[1], ['t1'], ['saved'], { webSearch: true, imageGeneration: false, codeInterpreter: false }).toolIds).toEqual(['saved']);
	});
});

describe('images', () => {
	it('caps the user size by the server limit', () => {
		expect(imageTargetSize({ imageCompression: true, imageCompressionSize: { width: 2000, height: null } }, { file: { image_compression: { width: 1024 } } })).toEqual({ width: 1024, height: null });
		expect(imageTargetSize({}, {})).toBeNull();
		expect(imageTargetSize({}, { file: { image_compression: { height: 800 } } })).toEqual({ width: null, height: 800 });
	});
});

describe('commands', () => {
	it('recognises / at the start and # or @ at a word start', () => {
		expect(commandAt('/summ', 5)).toEqual({ trigger: '/', query: 'summ', start: 0 });
		expect(commandAt('hi /x', 5)).toBeNull();
		expect(commandAt('look at #docs', 13)).toEqual({ trigger: '#', query: 'docs', start: 8 });
		expect(commandAt('ask @ll', 7)).toEqual({ trigger: '@', query: 'll', start: 4 });
		expect(commandAt('mail@x', 6)).toBeNull();
	});
	it('replaces the command text, and fills variables', () => {
		expect(replaceCommand('look at #docs now', 8, 13, '')).toBe('look at  now');
		expect(fillPromptVariables('Hi {{USER_NAME}} on {{CURRENT_DATE}} {{X}}', { '{{USER_NAME}}': 'Ann', '{{CURRENT_DATE}}': '2026-01-01' })).toBe('Hi Ann on 2026-01-01 {{X}}');
		expect(isUrl('https://example.com/a')).toBe(true);
		expect(isUrl('example')).toBe(false);
	});
});

describe('input variables', () => {
	it('fills named variables, with or without a type', async () => {
		const { replaceInputVariables } = await import('./attachments');
		expect(replaceInputVariables('Write about {{topic}} in {{tone | select:options=["a","b"]}} {{other}}', { topic: 'cats', tone: 'a' })).toBe('Write about cats in a {{other}}');
	});
});
