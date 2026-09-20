import { describe, expect, it } from 'vitest';
import { formToValves, valvesToForm } from './pipelineValves';

const spec = { properties: { tags: { type: 'array' }, name: { type: 'string' } } };

describe('pipeline valves', () => {
	it('joins array valves for editing and leaves the rest alone', () => {
		expect(valvesToForm({ tags: ['a', 'b'], name: 'x' }, spec)).toEqual({ tags: 'a,b', name: 'x' });
		expect(valvesToForm({ tags: null }, spec).tags).toBe('');
	});
	it('splits and trims them back', () => {
		expect(formToValves({ tags: 'a, b ,c', name: 'x' }, spec)).toEqual({ tags: ['a', 'b', 'c'], name: 'x' });
	});
	it('keeps an unset array valve null instead of [""]', () => {
		expect(formToValves({ tags: null }, spec).tags).toBeNull();
	});
	it('round-trips', () => {
		const valves = { tags: ['x', 'y'], name: 'n' };
		expect(formToValves(valvesToForm(valves, spec), spec)).toEqual(valves);
	});
});
