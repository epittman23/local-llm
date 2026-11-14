import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SensitiveInput } from './SensitiveInput';

describe('SensitiveInput', () => {
	const toggle = () => screen.getByRole('button', { name: 'Make password visible in the user interface' });

	it('masks the value until the eye button is pressed', () => {
		render(<SensitiveInput value="secret" onChange={vi.fn()} placeholder="API key" />);
		expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'password');
		expect(toggle()).toHaveAttribute('aria-pressed', 'false');
		fireEvent.click(toggle());
		expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'text');
		expect(toggle()).toHaveAttribute('aria-pressed', 'true');
	});

	it('masks the value again on a second press', () => {
		render(<SensitiveInput value="secret" onChange={vi.fn()} placeholder="API key" variant="settings" />);
		fireEvent.click(toggle());
		fireEvent.click(toggle());
		expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'password');
	});
});
