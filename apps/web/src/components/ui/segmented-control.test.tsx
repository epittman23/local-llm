import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SegmentedControl } from './segmented-control';

afterEach(cleanup);

function Theme() {
	const [value, setValue] = useState<'dark' | 'light'>('dark');
	return (
		<SegmentedControl
			aria-label="Theme"
			value={value}
			onValueChange={setValue}
			options={[
				{ value: 'dark', label: 'Dark', icon: Moon },
				{ value: 'light', label: 'Light', icon: Sun }
			]}
		/>
	);
}

describe('SegmentedControl (FRM-4)', () => {
	it('is a named radio group of words with line icons, the choice checked', () => {
		const { container } = render(<Theme />);
		expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
		expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
		expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'false');
		expect(container.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(2);
	});

	it('chooses by click', () => {
		render(<Theme />);
		fireEvent.click(screen.getByRole('radio', { name: 'Light' }));
		expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
		expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'false');
	});

	it('starts with nothing chosen for a value no option has, and does not choose a disabled option', () => {
		const onValueChange = vi.fn();
		render(
			<SegmentedControl<'' | 'anyone' | 'me'>
				aria-label="Who"
				value=""
				onValueChange={onValueChange}
				options={[
					{ value: 'anyone', label: 'Anyone', disabled: true },
					{ value: 'me', label: 'Only me' }
				]}
			/>
		);
		expect(screen.getByRole('radio', { name: 'Anyone' })).toHaveAttribute('aria-checked', 'false');
		expect(screen.getByRole('radio', { name: 'Only me' })).toHaveAttribute('aria-checked', 'false');
		expect(screen.getByRole('radio', { name: 'Anyone' })).toBeDisabled();
		fireEvent.click(screen.getByRole('radio', { name: 'Anyone' }));
		expect(onValueChange).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('radio', { name: 'Only me' }));
		expect(onValueChange).toHaveBeenCalledWith('me');
	});

	it('draws a disabled segment in the disabled colour, not faded, and each segment with the 8 px corner (COL-2, SHP-1)', () => {
		render(
			<SegmentedControl<'a' | 'b'>
				aria-label="Pick"
				value="b"
				onValueChange={() => {}}
				options={[
					{ value: 'a', label: 'A', disabled: true },
					{ value: 'b', label: 'B' }
				]}
			/>
		);
		const disabled = screen.getByRole('radio', { name: 'A' });
		expect(disabled).toHaveAttribute('data-disabled');
		expect(disabled.className).toContain('data-disabled:text-foreground-disabled');
		expect(disabled.className).toContain('data-disabled:cursor-not-allowed');
		expect(disabled.className).not.toMatch(/opacity-\d/);
		expect(disabled).toHaveClass('rounded-lg');
		expect(disabled).not.toHaveClass('rounded-md');
	});
});
