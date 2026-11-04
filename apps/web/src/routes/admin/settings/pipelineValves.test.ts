import { describe, expect, it } from 'vitest';
import { formToValves, valvesToForm } from './pipelineValves';

const spec = { properties: { tags: { type: 'array' }, name: { type: 'string' } } };

describe('pipeline valves', () => {
	it('joins array valves for editing and leaves the rest alone', () => {
		expect(valvesToForm({ tags: ['a', 'b'], name: 'x' }, spec)).toEqual({ tags: 'a,b', name: 'x' });
		// An unset one stays unset: the form shows it as None, not an empty Custom field (#251).
		expect(valvesToForm({ tags: null }, spec).tags).toBeNull();
		expect(valvesToForm({}, spec).tags).toBeNull();
	});
	it('splits and trims them back', () => {
		expect(formToValves({ tags: 'a, b ,c', name: 'x' }, spec)).toEqual({ tags: ['a', 'b', 'c'], name: 'x' });
	});
	it('keeps an unset array valve null instead of [""]', () => {
		expect(formToValves({ tags: null }, spec).tags).toBeNull();
	});
	it('loads and saves an unset array valve as unset, not as [""] (#251)', () => {
		expect(formToValves(valvesToForm({ tags: null, name: 'n' }, spec), spec)).toEqual({ tags: null, name: 'n' });
	});
	it('round-trips', () => {
		const valves = { tags: ['x', 'y'], name: 'n' };
		expect(formToValves(valvesToForm(valves, spec), spec)).toEqual(valves);
	});
});
