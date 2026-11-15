import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatPlaceholder } from './ChatPlaceholder';

vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { name: 'Ada' } })
}));
vi.mock('@/lib/stores/configStore', () => ({
	useConfigStore: (sel: (s: unknown) => unknown) => sel({ config: { default_prompt_suggestions: [] } })
}));

const model = {
	id: 'coder',
	name: 'Coder',
	info: { meta: { suggestion_prompts: [{ content: 'Explain recursion', title: ['Recursion', 'in plain words'] }] } }
};

afterEach(cleanup);

describe('ChatPlaceholder suggestions', () => {
	it('offers each suggestion as a button showing its title, sending its content when pressed', () => {
		const onSelect = vi.fn();
		render(<ChatPlaceholder model={model} temporary={false} onSelect={onSelect} />);
		const button = screen.getByRole('button', { name: /Recursion/ });
		expect(button.textContent).toContain('in plain words');
		fireEvent.click(button);
		expect(onSelect).toHaveBeenCalledExactlyOnceWith('Explain recursion');
	});

	it('shows no suggestions when the model has none and the server has no defaults', () => {
		render(<ChatPlaceholder model={{ id: 'm', name: 'M' }} temporary={false} onSelect={vi.fn()} />);
		expect(screen.queryByRole('button')).toBeNull();
	});

	it('shows only the model, with no empty "Suggested" box, under the new default of none (#1065)', () => {
		const { container } = render(
			<ChatPlaceholder model={{ id: 'qwen', name: 'Qwen Coder' }} temporary={false} onSelect={vi.fn()} />
		);
		expect(screen.getByRole('heading', { level: 1, name: 'Qwen Coder' })).toBeInTheDocument();
		expect(screen.queryByText('Suggested')).toBeNull();
		// A model without a picture shows its initials (#924).
		expect(container.querySelector('[data-slot="avatar-fallback"]')?.textContent).toBe('QC');
	});
});

describe('ChatPlaceholder heading (#927, #1065)', () => {
	it('shows the entry’s name on the heading step (TYP-2), with its id beneath in mono (DAT-4)', () => {
		const { container } = render(<ChatPlaceholder model={model} temporary={false} onSelect={vi.fn()} />);
		expect(screen.getByRole('heading', { level: 1, name: 'Coder' }).className).toContain('text-heading');
		expect(container.querySelector('.font-mono.text-caption')?.textContent).toBe('coder');
	});

	it('shows an entry with no name of its own as its id, monospaced, wrapping after / and - (TYP-7)', () => {
		const id = 'qwen/qwen-2.5-coder-32b-instruct';
		render(<ChatPlaceholder model={{ id, name: id }} temporary={false} onSelect={vi.fn()} />);
		const h1 = screen.getByRole('heading', { level: 1 });
		expect(h1.textContent).toBe(id);
		expect(h1.className).toContain('font-mono');
		expect(h1.className).toContain('text-title');
		expect(h1.className).not.toContain('line-clamp');
		expect(h1.querySelectorAll('wbr')).toHaveLength(5);
	});

	it('greets the user when there is no model, and says when the chat is temporary', () => {
		render(<ChatPlaceholder model={undefined} temporary onSelect={vi.fn()} />);
		expect(screen.getByRole('heading', { level: 1, name: 'Hello, Ada' })).toBeInTheDocument();
		expect(screen.getByText(/^Temporary chat: /)).toBeInTheDocument();
	});
});

describe('ChatPlaceholder suggestion order (#927)', () => {
	it('keeps the source order and shows the first six, the same on every render', () => {
		const suggestion_prompts = Array.from({ length: 7 }, (_, i) => ({ content: `Prompt ${i + 1}` }));
		const shown = () => screen.getAllByRole('button').map((b) => b.textContent);
		const m = { id: 'm', name: 'M', info: { meta: { suggestion_prompts } } };
		const { rerender } = render(<ChatPlaceholder model={m} temporary={false} onSelect={vi.fn()} />);
		const first = shown();
		expect(first).toEqual(['Prompt 1', 'Prompt 2', 'Prompt 3', 'Prompt 4', 'Prompt 5', 'Prompt 6']);
		rerender(<ChatPlaceholder model={{ ...m }} temporary={false} onSelect={vi.fn()} />);
		expect(shown()).toEqual(first);
	});
});
