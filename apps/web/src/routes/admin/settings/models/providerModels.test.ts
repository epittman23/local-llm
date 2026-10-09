import { describe, expect, it } from 'vitest';
import {
	displayNameOf,
	hasOllamaManagement,
	managementConnections,
	modelIdOf,
	normalizeCatalog,
	providerLabel,
	providerSupportsDelete,
	statusClass,
	statusOf,
	unloadIdOf
} from './providerModels';

describe('model identity', () => {
	it('finds the id in whichever field the provider uses', () => {
		expect(modelIdOf({ key: 'k', id: 'i' })).toBe('k');
		expect(modelIdOf({ id: 'i', name: 'n' })).toBe('i');
		expect(modelIdOf({ name: 'n' })).toBe('n');
		expect(modelIdOf({ model: 'm' })).toBe('m');
		expect(modelIdOf({})).toBe('');
	});
	it('shows the display name when there is one', () => {
		expect(displayNameOf({ id: 'a', display_name: 'Alpha' })).toBe('Alpha');
		expect(displayNameOf({ id: 'a' })).toBe('a');
	});
	it('unloads the first loaded instance, else the model', () => {
		expect(unloadIdOf({ id: 'a', loaded_instances: [{ id: 'inst-1' }, { id: 'inst-2' }] })).toBe('inst-1');
		expect(unloadIdOf({ id: 'a', loaded_instances: [] })).toBe('a');
	});
});

describe('statusOf', () => {
	it('is loaded whenever an instance is', () => {
		expect(statusOf({ id: 'a', loaded_instances: [{}] }, 'lmstudio')).toBe('loaded');
	});
	it('LM Studio models that are not loaded are unloaded', () => {
		expect(statusOf({ id: 'a' }, 'lmstudio')).toBe('unloaded');
	});
	it('otherwise reads the status, as a string or an object, defaulting to available', () => {
		expect(statusOf({ id: 'a', status: 'loading' }, 'llama.cpp')).toBe('loading');
		expect(statusOf({ id: 'a', status: { value: 'sleeping' } }, 'llama.cpp')).toBe('sleeping');
		expect(statusOf({ id: 'a', status: {} }, 'llama.cpp')).toBe('available');
		expect(statusOf({ id: 'a' }, 'llama.cpp')).toBe('available');
	});
	it('colours loaded and busy states', () => {
		expect(statusClass('loaded')).toMatch(/green/);
		expect(statusClass('downloading')).toMatch(/yellow/);
		expect(statusClass('unloaded')).toMatch(/muted/);
	});
});

describe('normalizeCatalog', () => {
	it('accepts an array, or an object holding models, data or items', () => {
		expect(normalizeCatalog(['b', 'a']).map(modelIdOf)).toEqual(['a', 'b']);
		expect(normalizeCatalog({ models: [{ id: 'x' }] }).map(modelIdOf)).toEqual(['x']);
		expect(normalizeCatalog({ data: [{ id: 'y' }] }).map(modelIdOf)).toEqual(['y']);
		expect(normalizeCatalog({ items: [{ id: 'z' }] }).map(modelIdOf)).toEqual(['z']);
	});
	it('drops entries with no id, and copes with nothing', () => {
		expect(normalizeCatalog([{ id: 'a' }, {}, { display_name: 'nameless' }]).map(modelIdOf)).toEqual(['a']);
		expect(normalizeCatalog(null)).toEqual([]);
		expect(normalizeCatalog({ models: 'nope' })).toEqual([]);
	});
});

describe('providers', () => {
	it('labels and gates deletion', () => {
		expect(providerLabel('lmstudio')).toBe('LM Studio');
		expect(providerLabel('llama.cpp')).toBe('llama.cpp');
		expect(providerLabel('other')).toBe('other');
		expect(providerSupportsDelete('llama.cpp')).toBe(true);
		expect(providerSupportsDelete('lmstudio')).toBe(false);
	});
	it("lists only llama.cpp and LM Studio connections, finding each one's settings by index, text index or URL", () => {
		const conns = managementConnections({
			ENABLE_OPENAI_API: true,
			OPENAI_API_BASE_URLS: ['http://a', 'http://b', 'http://c', 'http://d'],
			OPENAI_API_CONFIGS: {
				0: { provider: 'llama.cpp' },
				'1': { provider: 'openai' },
				'http://c': { provider: 'lmstudio' }
			}
		});
		expect(conns.map((c) => [c.idx, c.provider])).toEqual([
			[0, 'llama.cpp'],
			[2, 'lmstudio']
		]);
	});
	it('lists none while the OpenAI API is off or unset', () => {
		expect(
			managementConnections({
				ENABLE_OPENAI_API: false,
				OPENAI_API_BASE_URLS: ['x'],
				OPENAI_API_CONFIGS: { 0: { provider: 'llama.cpp' } }
			})
		).toEqual([]);
		expect(managementConnections(null)).toEqual([]);
	});
	it('Ollama has something to manage only when enabled with an instance', () => {
		expect(hasOllamaManagement({ ENABLE_OLLAMA_API: true, OLLAMA_BASE_URLS: ['x'] })).toBe(true);
		expect(hasOllamaManagement({ ENABLE_OLLAMA_API: true, OLLAMA_BASE_URLS: [] })).toBe(false);
		expect(hasOllamaManagement({ ENABLE_OLLAMA_API: false, OLLAMA_BASE_URLS: ['x'] })).toBe(false);
		expect(hasOllamaManagement(null)).toBe(false);
	});
});
