import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ModelSelector, matchModel, modelDetail, storedDefault } from './ModelSelector';
import { openModelPicker } from './modelPickerStore';

const update = vi.hoisted(() => vi.fn(async (_: unknown) => undefined));
const state = vi.hoisted(() => ({ settings: {} as Record<string, unknown>, config: {} as Record<string, unknown> }));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/lib/settings/userSettings', () => ({
	useUserSettings: () => ({ settings: state.settings, update })
}));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'u1', role: 'admin' } })
}));
vi.mock('@/lib/stores/configStore', () => ({
	useConfigStore: (sel: (s: unknown) => unknown) => sel({ config: state.config })
}));
vi.mock('@/lib/useShortcuts', () => ({ useKeybindings: () => ({ openModelSelector: 'mod+shift+M' }) }));

const MODELS = [
	{ id: 'coder', name: 'Coder', info: { meta: { description: 'For **code**\nreview' } } },
	{ id: 'math', name: 'Math', info: { base_model_id: 'qwen/qwen3.6-27b' } },
	{ id: 'qwen/qwen-2.5', name: 'qwen/qwen-2.5', info: { meta: { tags: [{ name: 'local' }] } } },
	{ id: 'hidden', name: 'Hidden', info: { meta: { hidden: true } } }
];

function show(selected = ['coder'], props: Partial<Parameters<typeof ModelSelector>[0]> = {}) {
	const onChange = vi.fn();
	const view = render(
		<TooltipProvider>
			<ModelSelector models={MODELS} selected={selected} onChange={onChange} {...props} />
		</TooltipProvider>
	);
	return { onChange, view };
}
const open = (name: string) => fireEvent.click(screen.getByRole('button', { name: `Model: ${name}` }));
const field = () => screen.getByRole('combobox', { name: 'Search models' });

beforeEach(() => {
	state.settings = {};
	state.config = {};
});
afterEach(() => {
	cleanup();
	update.mockClear();
	toast.success.mockClear();
});

describe('ModelSelector: the list (NAV-5, #943)', () => {
	it('lists the visible models, each with its second line, the current one marked', () => {
		show(['math']);
		open('Math');
		const options = screen.getAllByRole('option');
		expect(options.map((o) => o.textContent)).toEqual([
			'CCoderFor **code** review',
			'MMathqwen/qwen3.6-27b(current)',
			'Qqwen/qwen-2.5',
			'Make default'
		]);
		expect(screen.queryByText('Hidden')).toBeNull();
	});

	it('narrows to what is typed; ArrowDown then Enter chooses and closes the list', () => {
		const { onChange } = show();
		open('Coder');
		fireEvent.change(field(), { target: { value: '2.5' } });
		expect(screen.getAllByRole('option')).toHaveLength(1);
		fireEvent.keyDown(field(), { key: 'ArrowDown' });
		fireEvent.keyDown(field(), { key: 'Enter' });
		expect(onChange).toHaveBeenCalledExactlyOnceWith(['qwen/qwen-2.5']);
		expect(screen.queryByRole('listbox')).toBeNull();
	});

	it('picks the model pressed, and says when nothing matches', () => {
		const { onChange } = show();
		open('Coder');
		fireEvent.change(field(), { target: { value: 'zzz' } });
		expect(screen.getByText('No models match “zzz”')).toBeInTheDocument();
		fireEvent.change(field(), { target: { value: '' } });
		fireEvent.click(screen.getByRole('option', { name: /Math/ }));
		expect(onChange).toHaveBeenCalledExactlyOnceWith(['math']);
	});

	it('names its button after the model it shows (A11Y-2), and its tooltip gives the shortcut', async () => {
		show(['math']);
		const button = screen.getByRole('button', { name: 'Model: Math' });
		expect(button.textContent).toContain('Math');
		fireEvent.focus(button);
		expect((await screen.findAllByText(/Choose a model \(/)).length).toBeGreaterThan(0);
	});
});

describe('ModelSelector: Make default (#944)', () => {
	it('saves the selection, without empty ids, and closes the list', async () => {
		show(['math', '']);
		open('Math');
		fireEvent.click(screen.getByRole('option', { name: /Make default/ }));
		expect(update).toHaveBeenCalledExactlyOnceWith({ models: ['math'] });
		await act(async () => {});
		expect(toast.success).toHaveBeenCalledWith('Default model saved');
		expect(screen.queryByRole('listbox')).toBeNull();
	});

	it('is not offered when the selection already is the default: the user’s, else the server’s', () => {
		state.settings = { models: ['coder'] };
		show(['coder']);
		open('Coder');
		expect(screen.queryByRole('option', { name: /Make default/ })).toBeNull();
		cleanup();
		state.settings = {};
		state.config = { default_models: 'math' };
		show(['math']);
		open('Math');
		expect(screen.queryByRole('option', { name: /Make default/ })).toBeNull();
	});

	it('is no longer a line under the picker', () => {
		show(['coder']);
		expect(screen.queryByRole('button', { name: /default/i })).toBeNull();
	});
});

describe('ModelSelector: adding and removing a model', () => {
	it('Add model opens the new picker at once and adds the model chosen', () => {
		const { onChange } = show();
		fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
		expect(screen.getByRole('button', { name: 'Model: Choose a model' })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('option', { name: /Math/ }));
		expect(onChange).toHaveBeenCalledExactlyOnceWith(['coder', 'math']);
	});

	it('an added picker dismissed with no choice goes again, saving nothing, and focus returns to Add model', async () => {
		const { onChange } = show();
		const add = screen.getByRole('button', { name: 'Add model' });
		fireEvent.click(add);
		fireEvent.keyDown(field(), { key: 'Escape' });
		await act(() => new Promise((done) => setTimeout(done, 0)));
		expect(screen.queryByRole('button', { name: 'Model: Choose a model' })).toBeNull();
		expect(onChange).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(add);
	});

	it('Remove model drops that model', () => {
		const { onChange } = show(['coder', 'math']);
		fireEvent.click(screen.getByRole('button', { name: 'Remove model' }));
		expect(onChange).toHaveBeenCalledExactlyOnceWith(['coder']);
	});

	it('marks an empty saved slot as an error with its help line (FRM-2)', () => {
		show(['coder', '']);
		const empty = screen.getByRole('button', { name: 'Model: Choose a model' });
		expect(empty.getAttribute('aria-invalid')).toBe('true');
		const help = document.getElementById(empty.getAttribute('aria-describedby') ?? '');
		expect(help?.textContent?.trim()).toBe('Choose a model or remove this one');
	});
});

describe('ModelSelector: opened from elsewhere', () => {
	it('openModelPicker() opens the slot asked for, but not while disabled', () => {
		const { view } = show(['coder', 'math'], { disabled: true });
		act(() => openModelPicker(1));
		expect(screen.queryByRole('listbox')).toBeNull();
		view.rerender(
			<TooltipProvider>
				<ModelSelector models={MODELS} selected={['coder', 'math']} onChange={vi.fn()} />
			</TooltipProvider>
		);
		act(() => openModelPicker(1));
		expect(screen.getByRole('option', { name: /Math.*current/ })).toBeInTheDocument();
	});

	it('does not open for a request made before it was on screen', () => {
		act(() => openModelPicker());
		show();
		expect(screen.queryByRole('listbox')).toBeNull();
	});
});

describe('ModelSelector compact (the phone’s message box)', () => {
	it('is one chip naming the model, opening the list with Add model', () => {
		const { onChange } = show(['coder'], { compact: true });
		open('Coder');
		expect(screen.getByRole('option', { name: /Add model/ })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('option', { name: /Math/ }));
		expect(onChange).toHaveBeenCalledExactlyOnceWith(['math']);
	});

	it('Add model from the chip shows the new slot’s list, with a way back', () => {
		const { onChange } = show(['coder'], { compact: true });
		open('Coder');
		fireEvent.click(screen.getByRole('option', { name: /Add model/ }));
		// Back drops the unfilled slot: one model again, so its list.
		fireEvent.click(screen.getByRole('button', { name: /All models/ }));
		expect(screen.getByRole('option', { name: /Coder.*current/ })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('option', { name: /Add model/ }));
		fireEvent.click(screen.getByRole('option', { name: /Math/ }));
		expect(onChange).toHaveBeenCalledExactlyOnceWith(['coder', 'math']);
	});

	it('with several models reads "2 models" and lists them to change or remove', () => {
		const { onChange } = show(['coder', 'math'], { compact: true });
		open('2 models');
		fireEvent.click(screen.getByRole('button', { name: 'Remove model 2' }));
		expect(onChange).toHaveBeenLastCalledWith(['coder']);
		fireEvent.click(screen.getByRole('button', { name: /Make default/ }));
		expect(update).toHaveBeenCalledExactlyOnceWith({ models: ['coder', 'math'] });
		open('2 models');
		fireEvent.click(screen.getByRole('button', { name: 'Change model 2: Math' }));
		fireEvent.click(screen.getByRole('option', { name: /qwen-2\.5/ }));
		expect(onChange).toHaveBeenLastCalledWith(['coder', 'qwen/qwen-2.5']);
	});

	it('opens from openModelPicker() too', () => {
		show(['coder'], { compact: true });
		act(() => openModelPicker());
		expect(field()).toBeInTheDocument();
	});
});

describe('ModelSelector helpers', () => {
	it('modelDetail: Arena, then the description, then the base model in mono, else nothing', () => {
		expect(modelDetail({ id: 'arena-model', name: 'Arena Model', owned_by: 'arena' })).toEqual({
			text: 'Answers with a random model'
		});
		expect(modelDetail(MODELS[0])).toEqual({ text: 'For **code** review' });
		expect(modelDetail(MODELS[1])).toEqual({ text: 'qwen/qwen3.6-27b', mono: true });
		expect(modelDetail({ id: 'x', name: 'X' })).toBeNull();
	});

	it('matchModel matches the id, the name or a tag, ignoring case', () => {
		expect(matchModel('qwen/qwen3.6-27b', '3.6')).toBe(1);
		expect(matchModel('coder', 'COD')).toBe(1);
		expect(matchModel('x', 'loc', ['X', 'local'])).toBe(1);
		expect(matchModel('x', 'nope', ['X'])).toBe(0);
	});

	it('storedDefault prefers the user’s list without empty ids, then the server’s', () => {
		expect(storedDefault({ models: ['a', ''] }, 'b')).toEqual(['a']);
		expect(storedDefault({ models: [''] }, 'b,c')).toEqual(['b', 'c']);
		expect(storedDefault(null, null)).toEqual([]);
	});
});
