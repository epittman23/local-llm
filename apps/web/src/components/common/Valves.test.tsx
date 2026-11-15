import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { defaultText, enumOption, isSecret, settingLabel, Valves } from './Valves';

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
	it('offers "Not set" first, and stores choosing it as null (#1016)', () => {
		const onChange = vi.fn();
		render(
			<Valves
				spec={{ properties: { level: { title: 'Level', type: 'integer', enum: [1, 2, 3] } } }}
				valves={{ level: 2 }}
				onChange={onChange}
			/>
		);
		fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
		expect(onChange).toHaveBeenCalledWith({ level: null });
	});

	it('offers no null option for an Optional Literal', () => {
		render(
			<Valves
				spec={{ properties: { level: { title: 'Level', enum: [null, 1, 2] } } }}
				valves={{ level: 1 }}
				onChange={vi.fn()}
			/>
		);
		expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Not set', '1', '2']);
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

describe('a password valve', () => {
	it('masks the value until the show button is pressed', () => {
		render(
			<Valves
				spec={{ properties: { key: { title: 'Key', type: 'string', input: { type: 'password' } } } }}
				valves={{ key: 'abc' }}
				onChange={vi.fn()}
			/>
		);
		const field = () => document.getElementById('valve-key') as HTMLInputElement;
		expect(field().type).toBe('password');
		fireEvent.click(screen.getByRole('button', { name: 'Show value' }));
		expect(field().type).toBe('text');
		expect(screen.getByRole('button', { name: 'Hide value' })).toBeInTheDocument();
	});
});

describe('settings shown at once (#1016)', () => {
	const spec = {
		properties: {
			api_base: { title: 'Api Base', type: 'string', default: 'http://example.com' },
			api_key: { title: 'Api Key', type: 'string', default: '' },
			max_rows: { title: 'Max Rows', type: 'integer', default: 100, description: 'Row **limit**' },
			verbose: { title: 'Verbose', type: 'boolean', default: false },
			prompt: { title: 'Prompt', type: 'string', default: 'line one\nline two' }
		},
		required: ['api_key']
	};

	it('labels each setting in sentence case, with its default as the help line', () => {
		render(<Valves spec={spec} valves={{}} onChange={vi.fn()} />);
		const base = screen.getByLabelText('API base');
		expect(base).toHaveValue('');
		expect(base).not.toHaveAttribute('placeholder');
		expect(document.getElementById(base.getAttribute('aria-describedby') ?? '')).toHaveTextContent(
			'Default: http://example.com'
		);
		expect(screen.getByText('Default: 100')).toBeInTheDocument();
		expect(screen.getByText('Default: off')).toBeInTheDocument();
		expect(screen.getByText('Required.')).toBeInTheDocument();
		expect(screen.getByText('limit').tagName).toBe('STRONG');
		expect(screen.getByLabelText('Prompt').tagName).toBe('TEXTAREA');
	});

	it('masks a secret found by its name, and stores an emptied field as the default (null)', () => {
		const onChange = vi.fn();
		render(<Valves spec={spec} valves={{ api_key: 'abc', max_rows: 5 }} onChange={onChange} />);
		expect((document.getElementById('valve-api_key') as HTMLInputElement).type).toBe('password');
		fireEvent.change(screen.getByLabelText('Max rows'), { target: { value: '' } });
		expect(onChange).toHaveBeenLastCalledWith({ api_key: 'abc', max_rows: null });
		fireEvent.change(screen.getByLabelText('Max rows'), { target: { value: '7' } });
		expect(onChange).toHaveBeenLastCalledWith({ api_key: 'abc', max_rows: '7' });
	});

	it('shows a boolean at its default, and stores a switch back at the default as null', () => {
		const onChange = vi.fn();
		const { rerender } = render(<Valves spec={spec} valves={{}} onChange={onChange} />);
		const sw = screen.getByRole('switch', { name: 'Verbose' });
		expect(sw).toHaveAttribute('aria-checked', 'false');
		fireEvent.click(sw);
		expect(onChange).toHaveBeenLastCalledWith({ verbose: true });
		rerender(<Valves spec={spec} valves={{ verbose: true }} onChange={onChange} />);
		fireEvent.click(screen.getByRole('switch', { name: 'Verbose' }));
		expect(onChange).toHaveBeenLastCalledWith({ verbose: null });
	});

	it('checks a multiselect from its default, and renders nothing without settings', () => {
		const onChange = vi.fn();
		const { container } = render(
			<Valves
				spec={{
					properties: {
						days: {
							title: 'Days',
							type: 'array',
							default: ['mon'],
							input: { type: 'multiselect', options: ['mon', 'tue'] }
						}
					}
				}}
				valves={{}}
				onChange={onChange}
			/>
		);
		fireEvent.click(screen.getAllByRole('checkbox')[1] as HTMLElement);
		expect(onChange).toHaveBeenLastCalledWith({ days: ['mon', 'tue'] });
		container.remove();
		const empty = render(<Valves spec={{ properties: {} }} valves={{}} onChange={vi.fn()} />);
		expect(empty.container).toBeEmptyDOMElement();
	});

	it('names, finds secrets and says defaults as the person reads them', () => {
		expect(settingLabel('api_base')).toBe('API base');
		expect(settingLabel('MaxTurns')).toBe('Max turns');
		expect(isSecret('github_token', {})).toBe(true);
		expect(isSecret('units', { format: 'password' })).toBe(true);
		expect(isSecret('units', {})).toBe(false);
	});

	it('masks a setting whose name has a secret word in it, never one that only contains its letters', () => {
		for (const name of [
			'github_token',
			'api_key',
			'OPENAI_API_KEY',
			'apiKey',
			'APIKey',
			'APIKEY',
			'openai_key',
			'KEY',
			'client_secret',
			'accessToken',
			'db-password',
			'smtp passwd',
			'private_key',
			'aws.credentials'
		]) {
			expect(isSecret(name, {}), name).toBe(true);
		}
		for (const name of [
			'keywords',
			'sort_key',
			'tokenizer',
			'max_tokens',
			'passwordless',
			'key_count',
			'primaryKey',
			'monkey'
		]) {
			expect(isSecret(name, {}), name).toBe(false);
		}
		expect(defaultText({ default: true })).toBe('Default: on');
		expect(defaultText({ default: ['a', 'b'] })).toBe('Default: a, b');
		expect(defaultText({ default: '' })).toBeNull();
	});
});
