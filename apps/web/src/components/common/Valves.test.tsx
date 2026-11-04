import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { enumOption, Valves } from './Valves';

// #201: the enum <select> stored its DOM text, so a plugin's Literal[1, 2, 3]
// valve was sent "2", and the backend's pydantic model refused the save.

describe('an enum valve', () => {
	const pick = (enumValues: Array<string | number | boolean>, current: unknown, text: string, type = 'integer') => {
		const onChange = vi.fn();
		render(
			<Valves
				spec={{ properties: { level: { title: 'Level', type, enum: enumValues } } }}
				valves={{ level: current }}
				onChange={onChange}
			/>
		);
		fireEvent.change(screen.getByRole('combobox'), { target: { value: text } });
		return onChange.mock.calls[0][0];
	};

	it('keeps a numeric option a number', () => {
		expect(pick([1, 2, 3], 1, '2')).toEqual({ level: 2 });
	});

	it('keeps a string option a string', () => {
		expect(pick(['low', 'high'], 'low', 'high', 'string')).toEqual({ level: 'high' });
	});

	it('shows the current numeric value as selected', () => {
		render(
			<Valves
				spec={{ properties: { level: { title: 'Level', type: 'integer', enum: [1, 2, 3] } } }}
				valves={{ level: 3 }}
				onChange={vi.fn()}
			/>
		);
		expect(screen.getByRole('combobox')).toHaveValue('3');
	});
});

describe('an enum valve with no default', () => {
	it('starts at its first option when made Custom, not at an unsavable empty value', () => {
		const onChange = vi.fn();
		render(
			<Valves
				spec={{ properties: { level: { title: 'Level', type: 'integer', enum: [1, 2, 3] } } }}
				valves={{ level: null }}
				onChange={onChange}
			/>
		);
		fireEvent.click(screen.getByRole('button', { name: /Default/ }));
		expect(onChange).toHaveBeenCalledWith({ level: 1 });
	});

	it('offers no null option for an Optional Literal', () => {
		render(
			<Valves
				spec={{ properties: { level: { title: 'Level', enum: [null, 1, 2] } } }}
				valves={{ level: 1 }}
				onChange={vi.fn()}
			/>
		);
		expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['1', '2']);
	});
});

describe('enumOption', () => {
	it('is the entry the text stands for, with its own type', () => {
		expect(enumOption([1, 2, 3], '2')).toBe(2);
		expect(enumOption([0.5, 1.5], '1.5')).toBe(1.5);
		expect(enumOption([true, false], 'false')).toBe(false);
		expect(enumOption(['a', 'b'], 'b')).toBe('b');
	});

	it('is the text itself when no entry matches, and never a null entry', () => {
		expect(enumOption([1, 2], 'x')).toBe('x');
		expect(enumOption([null, 1], 'null')).toBe('null');
	});
});
