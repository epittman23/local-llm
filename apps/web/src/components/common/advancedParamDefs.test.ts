import { describe, expect, it } from 'vitest';
import {
	matchesFilter,
	nextTri,
	overriddenCount,
	paramDefs,
	paramGroups,
	shownValue,
	triLabel
} from './advancedParamDefs';

describe('paramDefs', () => {
	it('has one row per key, each named in words with one sentence of help (WRD-2)', () => {
		const keys = paramDefs.map((d) => d.key);
		expect(new Set(keys).size).toBe(keys.length);
		for (const d of paramDefs) {
			expect(d.label, d.key).toMatch(/^[A-Z]/);
			expect(d.label.slice(1), d.key).not.toMatch(/ [A-Z][a-z]/);
			expect(d.label, d.key).not.toMatch(/_|\(Ollama\)/);
			expect(d.help.endsWith('.'), d.key).toBe(true);
			expect(d.help.slice(0, -1), d.key).not.toMatch(/\. [A-Z]/);
		}
	});
	it('keeps Ollama-level and server settings admin-only', () => {
		const admin = paramDefs.filter((d) => d.admin).map((d) => d.key);
		expect(admin).toEqual(
			expect.arrayContaining(['num_ctx', 'num_gpu', 'keep_alive', 'use_mmap', 'stream_delta_chunk_size'])
		);
		expect(paramDefs.find((d) => d.key === 'temperature')?.admin).toBeUndefined();
	});
	it('seeds every range within its own bounds', () => {
		for (const d of paramDefs) if (d.kind === 'range') expect(d.seed >= d.min && d.seed <= d.max).toBe(true);
	});
});

describe('groups (#996)', () => {
	it('puts temperature, max tokens, reasoning effort and seed first, in that order', () => {
		expect(paramGroups().common.map((d) => d.key)).toEqual(['temperature', 'max_tokens', 'reasoning_effort', 'seed']);
	});
	it('keeps the Ollama-only ones in their own group, admin-only', () => {
		const ollama = paramGroups().ollama;
		expect(ollama.map((d) => d.key)).toEqual(
			expect.arrayContaining(['num_ctx', 'num_gpu', 'keep_alive', 'think', 'use_mmap'])
		);
		expect(ollama.every((d) => d.admin)).toBe(true);
		expect(paramGroups().more.map((d) => d.key)).toContain('top_p');
	});
	it('counts the rows that hold a value of their own', () => {
		expect(overriddenCount({ temperature: 0.2, top_k: null, seed: 0, other: 1 })).toBe(2);
		expect(overriddenCount(undefined)).toBe(0);
	});
	it('filters by name, API name or help, and shows values as words', () => {
		const topP = paramDefs.find((d) => d.key === 'top_p');
		if (!topP) throw new Error('no top_p');
		expect([
			matchesFilter(topP, 'TOP_P'),
			matchesFilter(topP, 'top p'),
			matchesFilter(topP, 'add up'),
			matchesFilter(topP, 'zzz')
		]).toEqual([true, true, true, false]);
		expect([shownValue(0.7), shownValue(true), shownValue(['<a>', '</a>'])]).toEqual(['0.7', 'On', '<a>, </a>']);
	});
});

describe('tri-state cycles', () => {
	const walk = (tri: Parameters<typeof nextTri>[0], steps: number) => {
		const seen: unknown[] = [];
		let v: unknown = null;
		for (let i = 0; i < steps; i++) seen.push((v = nextTri(tri, v)));
		return seen;
	};
	it('stream_response: default -> on -> off -> default', () =>
		expect(walk('stream_response', 3)).toEqual([true, false, null]));
	it('function_calling: default -> native -> legacy -> default', () =>
		expect(walk('function_calling', 3)).toEqual(['native', 'legacy', null]));
	it('think: default -> on -> effort string -> off -> default', () =>
		expect(walk('think', 4)).toEqual([true, 'medium', false, null]));
	it('reasoning_tags: default -> custom pair -> enabled -> disabled -> default', () =>
		expect(walk('reasoning_tags', 4)).toEqual([['', ''], true, false, null]));
	it('labels each state', () => {
		expect(triLabel('think', 'high')).toBe('Custom');
		expect(triLabel('reasoning_tags', ['<a>', '</a>'])).toBe('Custom');
		expect(triLabel('reasoning_tags', false)).toBe('Disabled');
		expect(triLabel('function_calling', undefined)).toBe('Default');
	});
});
