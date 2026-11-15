import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LineTextarea, Textarea } from './textarea';

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

describe('LineTextarea (#958)', () => {
	it('wraps a long name to three lines at most, submits on Enter and keeps line breaks out', () => {
		const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
		const onChange = vi.fn();
		render(
			<form onSubmit={onSubmit}>
				<LineTextarea aria-label="Tool name" onChange={(e) => onChange(e.target.value)} />
			</form>
		);
		const field = screen.getByRole('textbox', { name: 'Tool name' });
		expect(field).toHaveAttribute('rows', '1');
		expect(field.className).toContain('max-h-[calc(3lh_+_1rem_+_2px)]');
		fireEvent.change(field, { target: { value: 'Unit\nconverter' } });
		expect(onChange).toHaveBeenLastCalledWith('Unit converter');
		fireEvent.keyDown(field, { key: 'Enter' });
		expect(onSubmit).toHaveBeenCalledTimes(1);
		fireEvent.keyDown(field, { key: 'a' });
		expect(onSubmit).toHaveBeenCalledTimes(1);
	});
});
