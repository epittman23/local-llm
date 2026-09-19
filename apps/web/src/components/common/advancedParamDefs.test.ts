import { describe, expect, it } from 'vitest';
import { nextTri, paramDefs, triLabel } from './advancedParamDefs';

describe('paramDefs', () => {
	it('has one row per key, each with a tooltip', () => {
		const keys = paramDefs.map((d) => d.key);
		expect(new Set(keys).size).toBe(keys.length);
		expect(paramDefs.every((d) => d.tip.length > 10 && d.label)).toBe(true);
	});
	it('keeps Ollama-level and server settings admin-only', () => {
		const admin = paramDefs.filter((d) => d.admin).map((d) => d.key);
		expect(admin).toEqual(expect.arrayContaining(['num_ctx', 'num_gpu', 'keep_alive', 'use_mmap', 'stream_delta_chunk_size']));
		expect(paramDefs.find((d) => d.key === 'temperature')?.admin).toBeUndefined();
	});
	it('seeds every range within its own bounds', () => {
		for (const d of paramDefs) if (d.kind === 'range') expect(d.seed >= d.min && d.seed <= d.max).toBe(true);
	});
});

describe('tri-state cycles', () => {
	const walk = (tri: Parameters<typeof nextTri>[0], steps: number) => {
		const seen: unknown[] = [];
		let v: unknown = null;
		for (let i = 0; i < steps; i++) seen.push((v = nextTri(tri, v)));
		return seen;
	};
	it('stream_response: default -> on -> off -> default', () => expect(walk('stream_response', 3)).toEqual([true, false, null]));
	it('function_calling: default -> native -> legacy -> default', () => expect(walk('function_calling', 3)).toEqual(['native', 'legacy', null]));
	it('think: default -> on -> effort string -> off -> default', () => expect(walk('think', 4)).toEqual([true, 'medium', false, null]));
	it('reasoning_tags: default -> custom pair -> enabled -> disabled -> default', () => expect(walk('reasoning_tags', 4)).toEqual([['', ''], true, false, null]));
	it('labels each state', () => {
		expect(triLabel('think', 'high')).toBe('Custom');
		expect(triLabel('reasoning_tags', ['<a>', '</a>'])).toBe('Custom');
		expect(triLabel('reasoning_tags', false)).toBe('Disabled');
		expect(triLabel('function_calling', undefined)).toBe('Default');
	});
});
