import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerDialogs } from './ServerDialogs';
import type { ServerDialog } from './useChatSession';

const ask = (reply: (v: unknown) => void): ServerDialog => ({
	type: 'ask_user',
	reply,
	data: {
		questions: [
			{
				id: 'q1',
				question: 'Which language?',
				options: [{ label: 'Python', description: 'batteries included' }, { label: 'Rust' }]
			}
		]
	}
});

afterEach(cleanup);

describe('ask_user dialog', () => {
	it('keeps Submit disabled until each question has an answer', () => {
		render(<ServerDialogs dialog={ask(vi.fn())} onClose={vi.fn()} />);
		expect((screen.getByRole('button', { name: 'Submit answers' }) as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(screen.getByRole('button', { name: /Rust/ }));
		expect((screen.getByRole('button', { name: 'Submit answers' }) as HTMLButtonElement).disabled).toBe(false);
	});

	it('marks the picked option pressed, one at a time', () => {
		render(<ServerDialogs dialog={ask(vi.fn())} onClose={vi.fn()} />);
		const python = screen.getByRole('button', { name: /Python/ });
		const rust = screen.getByRole('button', { name: /Rust/ });
		fireEvent.click(python);
		expect(python.getAttribute('aria-pressed')).toBe('true');
		fireEvent.click(rust);
		expect(python.getAttribute('aria-pressed')).toBe('false');
		expect(rust.getAttribute('aria-pressed')).toBe('true');
	});

	it('replies with the chosen option and closes on Submit', () => {
		const reply = vi.fn();
		const onClose = vi.fn();
		render(<ServerDialogs dialog={ask(reply)} onClose={onClose} />);
		fireEvent.click(screen.getByRole('button', { name: /Python/ }));
		fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }));
		expect(reply).toHaveBeenCalledExactlyOnceWith({
			status: 'answered',
			answers: { q1: { type: 'option', option_index: 0, label: 'Python', description: 'batteries included' } }
		});
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('replies "cancelled" on Skip', () => {
		const reply = vi.fn();
		render(<ServerDialogs dialog={ask(reply)} onClose={vi.fn()} />);
		fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
		expect(reply).toHaveBeenCalledExactlyOnceWith({ status: 'cancelled', answers: {} });
	});
});
