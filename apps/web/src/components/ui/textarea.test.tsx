import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Textarea } from './textarea';

describe('Textarea (LAY-3, #1009)', () => {
	it('is at least `rows` lines tall, on touch too, where it is never under the 44 px target', () => {
		render(<Textarea aria-label="System prompt" rows={8} />);
		const field = screen.getByRole('textbox', { name: 'System prompt' });
		expect(field.style.getPropertyValue('--rows')).toBe('8');
		expect(field).toHaveAttribute('rows', '8');
		expect(field.className).toContain('min-h-[calc(var(--rows)*1lh_+_1rem_+_2px)]');
		expect(field.className).toContain('pointer-coarse:min-h-[max(var(--control-touch),calc(var(--rows)*1lh_+_1rem_+_2px))]');
	});

	it('starts at two lines, and a caller may still set its own height and style', () => {
		render(<Textarea aria-label="Notes" className="min-h-0" style={{ color: 'red' }} />);
		const field = screen.getByRole('textbox', { name: 'Notes' });
		expect(field.style.getPropertyValue('--rows')).toBe('2');
		expect(field.style.color).toBe('red');
		expect(field).toHaveClass('min-h-0');
		expect(field.className).not.toContain('min-h-[calc');
	});
});
