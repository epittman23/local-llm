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
});
