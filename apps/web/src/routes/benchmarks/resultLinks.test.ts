import { describe, expect, it } from 'vitest';
import {
	knobKey,
	knobName,
	knobsText,
	profileVersionLink,
	serveLink,
	speculativeOnly,
	splitKnobs
} from './resultLinks';

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

	it('takes only speculative options as speculative flags, the rule the server enforces', () => {
		for (const ok of [
			'',
			'off',
			'--spec-type draft-mtp --spec-draft-n-max 3',
			'--spec_type ngram-mod',
			'-md /models/d.gguf -ngld -1',
			'--spec-default'
		])
			expect(speculativeOnly(ok), ok).toBe(true);
		for (const bad of [
			'--host 0.0.0.0',
			'--spec-type draft-mtp --port 9999',
			'--host=0.0.0.0',
			'--spec-draft-hf someone/model',
			'draft-mtp',
			'OFF'
		])
			expect(speculativeOnly(bad), bad).toBe(false);
	});

	it('puts flags other than speculative ones in neither link', () => {
		const overrides = { LLAMA_NGL: '22', LLAMA_SPEC: '--host 0.0.0.0' };
		expect(params(serveLink('qwen38', overrides))).toEqual({ profile: 'qwen38', ngl: '22' });
		expect(params(profileVersionLink('qwen38', overrides))).toEqual({ edit: 'qwen38', 'def.ngl': '22' });
		expect(splitKnobs(overrides)).toEqual({ serve: ['ngl'], version: ['ngl'], unsupported: ['spec'] });
		expect(serveLink('qwen38', { LLAMA_SPEC: 'off' })).toBe('/benchmarks/serve?profile=qwen38&spec=off');
	});
});
