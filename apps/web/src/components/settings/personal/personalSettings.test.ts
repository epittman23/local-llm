import { describe, expect, it } from 'vitest';
import { generalPatch, paramsForForm, variableRows, variablesPayload } from './personalSettings';

describe('General', () => {
	it('saves only the parameters that are set, stop as a list', () => {
		expect(generalPatch('', { temperature: 0.5, top_k: null, stop: 'a,b,', seed: '', custom_params: {} })).toEqual({ system: undefined, params: { temperature: 0.5, stop: ['a', 'b'] } });
		expect(generalPatch('Be brief', {}).system).toBe('Be brief');
	});
	it('shows saved stop sequences joined', () => {
		expect(paramsForForm({ stop: ['a', 'b'], temperature: 1 })).toEqual({ stop: 'a,b', temperature: 1 });
		expect(paramsForForm(undefined)).toEqual({ stop: null });
	});
});

describe('user variables', () => {
	it('drops blank rows and keeps values', () => {
		expect(variablesPayload([{ key: ' team ', value: 'a' }, { key: '', value: '' }])).toEqual({ team: 'a' });
	});
	it('rejects bad and duplicate keys', () => {
		expect(() => variablesPayload([{ key: 'Team', value: '' }])).toThrow('snake case');
		expect(() => variablesPayload([{ key: 'a', value: '1' }, { key: 'a', value: '2' }])).toThrow('unique');
		expect(() => variablesPayload([{ key: '', value: 'x' }])).toThrow('snake case');
	});
	it('round-trips rows', () => {
		expect(variableRows({ a: '1', b: 2 })).toEqual([{ key: 'a', value: '1' }, { key: 'b', value: '2' }]);
		expect(variableRows(null)).toEqual([]);
	});
});
