import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Checkbox, CheckboxMark } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';

describe('Checkbox', () => {
	it('answers clicks across at least 24px, and 44px on touch (LAY-3)', () => {
		render(<Checkbox aria-label="Keep the model in memory" />);
		const box = screen.getByRole('checkbox');
		// 16px box, ::after 12px out on each side and 8px up and down: 40 by 32.
		expect(box).toHaveClass('size-4', 'after:-inset-x-3', 'after:-inset-y-2');
		// 16 + 2 × 14 = 44 under a coarse pointer.
		expect(box).toHaveClass('pointer-coarse:after:-inset-3.5');
	});

	it('does not animate its focus outline in', () => {
		render(<Checkbox aria-label="x" />);
		const box = screen.getByRole('checkbox');
		expect(box.className).toContain('transition-[color,background-color,border-color]');
		expect(box.className).not.toMatch(/\btransition-(?:all|colors)\b/);
	});

	it('toggles', () => {
		render(<Checkbox aria-label="x" />);
		const box = screen.getByRole('checkbox');
		fireEvent.click(box);
		expect(box).toHaveAttribute('data-state', 'checked');
	});
});

describe('CheckboxMark', () => {
	it('is a hidden picture, not a control', () => {
		const { container } = render(<CheckboxMark checked={false} />);
		const mark = container.querySelector('[data-slot="checkbox-mark"]');
		expect(mark?.tagName).toBe('SPAN');
		expect(mark).toHaveAttribute('aria-hidden', 'true');
		expect(mark).toHaveAttribute('data-state', 'unchecked');
		expect(mark).not.toHaveAttribute('data-checked');
		expect(mark?.querySelector('svg')).toBeNull();
	});

	it('shows the tick and the checked fill when checked', () => {
		const { container } = render(<CheckboxMark checked className="ml-2" />);
		const mark = container.querySelector('[data-slot="checkbox-mark"]');
		expect(mark).toHaveAttribute('data-state', 'checked');
		expect(mark).toHaveAttribute('data-checked', '');
		expect(mark).toHaveClass('data-checked:bg-primary', 'ml-2');
		expect(mark?.querySelector('svg')).not.toBeNull();
	});
});

describe('Switch', () => {
	it('answers clicks across 44px on touch (LAY-3)', () => {
		render(<Switch aria-label="Name new chats automatically" />);
		const control = screen.getByRole('switch');
		// 18.4px track + 2 × 16 under a coarse pointer; 14px at size sm + 32 = 46.
		expect(control).toHaveClass('after:-inset-y-2', 'pointer-coarse:after:-inset-y-4');
		expect(control.className).not.toMatch(/\btransition-all\b/);
	});
});
