import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelSelector } from './ModelSelector';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/settings/userSettings', () => ({
	useUserSettings: () => ({ settings: {}, update: vi.fn(async () => undefined) })
}));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'u1', role: 'admin' } })
}));

const MODELS = [
	{ id: 'coder', name: 'Coder' },
	{ id: 'math', name: 'Math' }
];

function show(value = 'coder') {
	const onChange = vi.fn();
	render(<ModelSelector models={MODELS} selected={[value]} onChange={onChange} />);
	fireEvent.click(screen.getByRole('button', { name: 'Select a model' }));
	return onChange;
}

afterEach(cleanup);

describe('ModelSelector', () => {
	it('lists every model as an option and marks the current one selected', () => {
		show('math');
		expect(screen.getAllByRole('option')).toHaveLength(2);
		expect(screen.getByRole('option', { name: 'Math' }).getAttribute('aria-selected')).toBe('true');
		expect(screen.getByRole('option', { name: 'Coder' }).getAttribute('aria-selected')).toBe('false');
	});

	it('picks the model whose option is pressed and closes the list', () => {
		const onChange = show();
		fireEvent.click(screen.getByRole('option', { name: 'Math' }));
		expect(onChange).toHaveBeenCalledExactlyOnceWith(['math']);
		expect(screen.queryByRole('listbox')).toBeNull();
	});

	it('narrows the options to the search text', () => {
		show();
		fireEvent.change(screen.getByRole('textbox', { name: 'Search a model' }), { target: { value: 'mat' } });
		expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Math']);
	});

	it('adds an empty model slot with Add Model', () => {
		const onChange = show();
		fireEvent.click(screen.getByRole('button', { name: 'Add Model' }));
		expect(onChange).toHaveBeenCalledExactlyOnceWith(['coder', '']);
	});
});
