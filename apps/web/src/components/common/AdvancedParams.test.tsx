import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getOllamaConfig } from '@/lib/apis/ollama';
import { AdvancedParams } from './AdvancedParams';

vi.mock('@/lib/apis/ollama', () => ({ getOllamaConfig: vi.fn() }));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't' })
}));

function show(props: Partial<Parameters<typeof AdvancedParams>[0]> = {}) {
	const onChange = vi.fn();
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<AdvancedParams params={{}} onChange={onChange} {...props} />
		</QueryClientProvider>
	);
	return onChange;
}
const toggle = (name: RegExp | string) => screen.getByRole('button', { name });

afterEach(() => {
	cleanup();
	vi.mocked(getOllamaConfig).mockReset();
});

describe('AdvancedParams: the Common group (#996)', () => {
	it('shows temperature, max tokens, reasoning effort and seed first, each with its help', () => {
		show();
		const rows = screen.getAllByRole('button', { name: /: Default/ }).map((b) => b.getAttribute('aria-label'));
		expect(rows).toEqual(['Temperature: Default', 'Max tokens: Default', 'Reasoning effort: Default', 'Seed: Default']);
		expect(screen.getByText('The longest reply the model may write, in tokens.')).toBeInTheDocument();
		// The API name sits beside the name, hidden from the accessible name.
		expect(screen.getByText('max_tokens').getAttribute('aria-hidden')).toBe('true');
	});

	it('says what a row falls back to, where it is known', () => {
		show({ defaults: { temperature: 0.7, stream_response: false } });
		expect(toggle('Temperature: Default (0.7)')).toBeInTheDocument();
		fireEvent.click(toggle(/More parameters/));
		expect(toggle('Stream the reply: Default (Off)')).toBeInTheDocument();
	});

	it('turns a row to Custom with its starting value, and edits it in the shared field', () => {
		const onChange = show({ params: { temperature: 0.8 } });
		expect(toggle('Temperature: Custom')).toBeInTheDocument();
		fireEvent.change(screen.getByRole('spinbutton', { name: 'Temperature' }), { target: { value: '1.2' } });
		expect(onChange).toHaveBeenLastCalledWith({ temperature: 1.2 });
		fireEvent.click(toggle('Temperature: Custom'));
		expect(onChange).toHaveBeenLastCalledWith({ temperature: null });
	});

	it('Reset all puts every row back to its default, shown only when something is set', () => {
		show();
		expect(screen.queryByRole('button', { name: /Reset all/ })).toBeNull();
		cleanup();
		const onChange = show({ params: { temperature: 1, top_p: 0.5, custom_params: { a: '1' } } });
		fireEvent.click(screen.getByRole('button', { name: /Reset all/ }));
		const next = onChange.mock.calls[0][0];
		expect(next).toMatchObject({ temperature: null, top_p: null, seed: null, custom_params: { a: '1' } });
	});
});

describe('AdvancedParams: More parameters (FRM-6)', () => {
	it('is closed, counts what it holds, and filters by name or API name', () => {
		show({ params: { top_p: 0.5 } });
		const more = toggle(/More parameters/);
		expect(more.getAttribute('aria-expanded')).toBe('false');
		expect(more.textContent).toContain('(1 set)');
		expect(screen.queryByRole('button', { name: /^Top P/ })).toBeNull();
		fireEvent.click(more);
		const filter = screen.getByRole('searchbox', { name: 'Filter parameters' });
		fireEvent.change(filter, { target: { value: 'penalty' } });
		expect(screen.getAllByRole('button', { name: /penalty: Default/ }).length).toBe(3);
		fireEvent.change(filter, { target: { value: 'top_k' } });
		expect(screen.getAllByRole('button', { name: /: Default|: Custom/ }).map((b) => b.textContent)).toContain(
			'Default'
		);
		fireEvent.change(filter, { target: { value: 'zzz' } });
		expect(screen.getByText('No parameters match “zzz”')).toBeInTheDocument();
	});

	it('cycles a tri-state row and shows its extra fields', () => {
		const onChange = show({ params: { reasoning_tags: ['<t>', '</t>'] } });
		fireEvent.click(toggle(/More parameters/));
		fireEvent.change(screen.getByRole('textbox', { name: 'End tag' }), { target: { value: '</x>' } });
		expect(onChange).toHaveBeenLastCalledWith({ reasoning_tags: ['<t>', '</x>'] });
		fireEvent.click(toggle('Reasoning tags: Custom'));
		expect(onChange).toHaveBeenLastCalledWith({ reasoning_tags: true });
	});
});

describe('AdvancedParams: Ollama only (owner decision S3-D3)', () => {
	it('is not offered to someone who is not an admin, who cannot read the Ollama setting', () => {
		show();
		expect(screen.queryByRole('button', { name: /Ollama only/ })).toBeNull();
		expect(getOllamaConfig).not.toHaveBeenCalled();
	});

	it('is a closed group while the Ollama connection is on', async () => {
		vi.mocked(getOllamaConfig).mockResolvedValue({ ENABLE_OLLAMA_API: true });
		show({ admin: true, params: { num_ctx: 4096 } });
		const group = await screen.findByRole('button', { name: /Ollama only/ });
		expect(group.getAttribute('aria-expanded')).toBe('false');
		fireEvent.click(group);
		expect(screen.getByRole('spinbutton', { name: 'Context window' })).toHaveValue(4096);
	});

	it('goes while the Ollama connection is off', async () => {
		vi.mocked(getOllamaConfig).mockResolvedValue({ ENABLE_OLLAMA_API: false });
		show({ admin: true });
		await vi.waitFor(() => expect(screen.queryByRole('button', { name: /Ollama only/ })).toBeNull());
	});

	it('stays, closed, where the setting cannot be read', async () => {
		vi.mocked(getOllamaConfig).mockRejectedValue(new Error('403'));
		show({ admin: true });
		expect(await screen.findByRole('button', { name: /Ollama only/ })).toBeInTheDocument();
	});
});

describe('AdvancedParams: custom parameters', () => {
	it('adds, edits and removes a free-form pair (admin)', () => {
		const onChange = show({ admin: true, custom: true, params: { custom_params: { a: '1' } } });
		fireEvent.change(screen.getByRole('textbox', { name: 'Custom parameter value' }), { target: { value: '2' } });
		expect(onChange).toHaveBeenLastCalledWith({ custom_params: { a: '2' } });
		fireEvent.click(screen.getByRole('button', { name: 'Remove a' }));
		expect(onChange).toHaveBeenLastCalledWith({ custom_params: {} });
	});

	it('keeps a new row to itself until it has a name, then adds it (no unnamed key ever reaches the caller)', () => {
		const onChange = show({ admin: true, custom: true, params: { custom_params: { a: '1' } } });
		fireEvent.click(screen.getByRole('button', { name: /Add custom parameter/ }));
		expect(onChange).not.toHaveBeenCalled();
		const [, name] = screen.getAllByRole('textbox', { name: 'Custom parameter name' });
		const [, value] = screen.getAllByRole('textbox', { name: 'Custom parameter value' });
		expect(document.activeElement).toBe(name);
		// A value typed before the name, and focus moving inside the row, add nothing yet.
		fireEvent.change(value, { target: { value: 'v' } });
		fireEvent.blur(name, { relatedTarget: value });
		fireEvent.blur(value);
		expect(onChange).not.toHaveBeenCalled();
		// Add again while the row has no name goes back to its name.
		fireEvent.click(screen.getByRole('button', { name: /Add custom parameter/ }));
		expect(document.activeElement).toBe(name);
		fireEvent.change(name, { target: { value: ' top_k ' } });
		fireEvent.blur(name);
		expect(onChange).toHaveBeenLastCalledWith({ custom_params: { a: '1', top_k: 'v' } });
	});

	it('adds a named row on Enter, and drops a new row on Remove this parameter', () => {
		const onChange = show({ admin: true, custom: true, params: {} });
		fireEvent.click(screen.getByRole('button', { name: /Add custom parameter/ }));
		fireEvent.change(screen.getByRole('textbox', { name: 'Custom parameter name' }), { target: { value: 'gone' } });
		const remove = screen.getByRole('button', { name: 'Remove this parameter' });
		fireEvent.keyDown(remove, { key: 'Enter' });
		fireEvent.click(remove);
		expect(onChange).not.toHaveBeenCalled();
		expect(screen.queryByRole('textbox', { name: 'Custom parameter name' })).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: /Add custom parameter/ }));
		const name = screen.getByRole('textbox', { name: 'Custom parameter name' });
		fireEvent.keyDown(name, { key: 'Enter' });
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.change(name, { target: { value: 'seed_offset' } });
		fireEvent.keyDown(name, { key: 'Enter' });
		expect(onChange).toHaveBeenLastCalledWith({ custom_params: { seed_offset: '' } });
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it('drops an unnamed key stored from before at the next edit, and names its Remove', () => {
		const onChange = show({ admin: true, custom: true, params: { custom_params: { '': '', a: '1' } } });
		expect(screen.getByRole('button', { name: 'Remove this parameter' })).toBeInTheDocument();
		fireEvent.change(screen.getAllByRole('textbox', { name: 'Custom parameter value' })[1], {
			target: { value: '2' }
		});
		expect(onChange).toHaveBeenLastCalledWith({ custom_params: { a: '2' } });
	});
});
