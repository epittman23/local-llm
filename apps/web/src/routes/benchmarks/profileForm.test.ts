import { describe, expect, it } from 'vitest';
import { errorMessage } from '@/lib/apis/benchmarks/profiles';
import { argvToText, textToArgv } from './ProfileDefinitionForm';

// docs/history/bug-review-2026-09-27.md M7 and L7.
describe('profile argv fields', () => {
	it('splits on whitespace, like a command line', () => {
		expect(textToArgv('--temp 1.0   --top-p 0.95 ')).toEqual(['--temp', '1.0', '--top-p', '0.95']);
		expect(textToArgv('   ')).toEqual([]);
	});

	it('keeps quoted values with spaces or commas as one token', () => {
		expect(textToArgv(`-ot "a=CUDA0,b=CUDA0" --x 'two words'`)).toEqual(['-ot', 'a=CUDA0,b=CUDA0', '--x', 'two words']);
		expect(textToArgv(`--empty ''`)).toEqual(['--empty', '']);
	});

	it('round-trips any token list', () => {
		for (const argv of [
			['--spec-type', 'draft-mtp', '--spec-draft-n-max', '2'],
			['--chat-template-kwargs', '{"a":1,"b":"x y"}'],
			["it's", 'a "quote"', '', 'plain']
		]) {
			expect(textToArgv(argvToText(argv))).toEqual(argv);
		}
	});
});

describe('errorMessage', () => {
	it('flattens a 422 detail list instead of [object Object]', () => {
		const detail = [{ loc: ['body', 'definition', 'ctx'], msg: 'Input should be a valid integer' }];
		expect(errorMessage(detail)).toBe('definition.ctx: Input should be a valid integer');
	});

	it('passes strings and errors through', () => {
		expect(errorMessage('Not found')).toBe('Not found');
		expect(errorMessage(new TypeError('Failed to fetch'))).toBe('Failed to fetch');
	});
});
