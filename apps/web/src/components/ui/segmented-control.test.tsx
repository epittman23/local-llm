import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
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
});
