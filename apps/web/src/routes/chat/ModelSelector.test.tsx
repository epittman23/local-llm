import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelSelector } from './ModelSelector';

const update = vi.hoisted(() => vi.fn(async (_: unknown) => undefined));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/settings/userSettings', () => ({
	useUserSettings: () => ({ settings: {}, update })
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
	fireEvent.click(screen.getByRole('button', { name: `Model: ${MODELS.find((m) => m.id === value)?.name}` }));
	return onChange;
}

afterEach(() => {
	cleanup();
	update.mockClear();
});

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
		// Each option's picture is decorative (its initials are hidden), so its name is the model's.
		expect(screen.getAllByRole('option')).toHaveLength(1);
		expect(screen.getByRole('option', { name: 'Math' })).toBeInTheDocument();
	});

	it('names its button after the model it shows, so the name contains the visible text (A11Y-2)', () => {
		render(<ModelSelector models={MODELS} selected={['math', '']} onChange={vi.fn()} />);
		const [first, second] = screen.getAllByRole('button', { name: /^Model: / });
		expect(first.getAttribute('aria-label')).toBe('Model: Math');
		expect(first.textContent).toContain('Math');
		expect(second.getAttribute('aria-label')).toBe('Model: Select a model');
	});

	it('saves the selection as the default from the model menu, and closes it', async () => {
		show('math');
		// The menu's copy of "Set as default" is the one shown on short screens (A11Y-5).
		const inMenu = screen.getAllByRole('button', { name: 'Set as default' });
		expect(inMenu).toHaveLength(2);
		fireEvent.click(inMenu[1]);
		expect(update).toHaveBeenCalledExactlyOnceWith({ models: ['math'] });
		expect(screen.queryByRole('listbox')).toBeNull();
	});

	it('saves the selection as the default from the row under the picker', () => {
		render(<ModelSelector models={MODELS} selected={['coder']} onChange={vi.fn()} />);
		const button = screen.getByRole('button', { name: 'Set as default' });
		expect(button.className).toContain('[@media(max-height:520px)]:hidden');
		fireEvent.click(button);
		expect(update).toHaveBeenCalledExactlyOnceWith({ models: ['coder'] });
	});

	it('adds an empty model slot with Add Model', () => {
		const onChange = show();
		fireEvent.click(screen.getByRole('button', { name: 'Add Model' }));
		expect(onChange).toHaveBeenCalledExactlyOnceWith(['coder', '']);
	});
});
