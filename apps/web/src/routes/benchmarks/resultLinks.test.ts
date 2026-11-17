import { describe, expect, it } from 'vitest';
import { knobKey, knobName, knobsText, profileVersionLink, serveLink, splitKnobs } from './resultLinks';

const params = (link: string | null) => Object.fromEntries(new URL(link ?? '', 'http://x').searchParams);

describe('result links (B-D8)', () => {
	it('reads llama-env keys and short keys alike', () => {
		expect(knobKey('LLAMA_UBATCH')).toBe('ubatch');
		expect(knobKey('ngl')).toBe('ngl');
		expect(knobName('LLAMA_NGL')).toBe('GPU layers');
		expect(knobName('LLAMA_FA')).toBe('flash attention');
		expect(knobName('LLAMA_SOMETHING')).toBe('something');
		expect(knobsText({ LLAMA_NGL: '22', LLAMA_UBATCH: 1024, LLAMA_OT: '' })).toBe('ngl 22, ubatch 1024');
		expect(knobsText(null)).toBe('');
	});

	it('fills the Serve form with only the overrides it takes', () => {
		const link = serveLink('qwen38', {
			LLAMA_NGL: '22',
			LLAMA_THREADS: 8,
			LLAMA_CTX: '16384',
			LLAMA_PARALLEL: '1',
			LLAMA_OT: 'blk.*=CPU',
			LLAMA_REASONING: 'low',
			LLAMA_SPEC: '--spec-type draft-mtp',
			LLAMA_UBATCH: '1024'
		});
		expect(link?.startsWith('/benchmarks/serve?')).toBe(true);
		expect(params(link)).toEqual({
			profile: 'qwen38',
			ngl: '22',
			threads: '8',
			ctx: '16384',
			parallel: '1',
			ot: 'blk.*=CPU',
			reasoning: 'low',
			spec: '--spec-type draft-mtp'
		});
		expect(serveLink('qwen38', { ubatch: '1024', batch: '1024' })).toBeNull();
		expect(serveLink('qwen38', undefined)).toBeNull();
	});

	it("opens the profile's Edit form with each field as def.<field>, and the note", () => {
		const link = profileVersionLink(
			'qwen38',
			{ LLAMA_UBATCH: '1024', LLAMA_OT: 'exps=CPU', LLAMA_REASONING: 'high', LLAMA_FA: 'on', ngl: 22 },
			'From Tune sweep s-1'
		);
		expect(params(link)).toEqual({
			edit: 'qwen38',
			'def.ubatch': '1024',
			'def.override_tensors': 'exps=CPU',
			'def.reasoning_effort_default': 'high',
			'def.ngl': '22',
			note: 'From Tune sweep s-1'
		});
		expect(link).toContain('def.override_tensors=exps%3DCPU');
		expect(params(profileVersionLink('qwen38', { batch: '512' }))).toEqual({ edit: 'qwen38', 'def.batch': '512' });
		expect(profileVersionLink('qwen38', { LLAMA_FA: 'on' }, 'note')).toBeNull();
	});

	it('says which knobs each link carries, and which neither can', () => {
		expect(splitKnobs({ LLAMA_NGL: '22', LLAMA_UBATCH: '1024', LLAMA_FA: 'on', LLAMA_MOE: null })).toEqual({
			serve: ['ngl'],
			version: ['ngl', 'ubatch'],
			unsupported: ['fa']
		});
		expect(splitKnobs(undefined)).toEqual({ serve: [], version: [], unsupported: [] });
	});
});
