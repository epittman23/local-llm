import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BoundToggle } from './boundFields';

describe('BoundToggle', () => {
	it('flips the bound key through set', () => {
		const set = vi.fn();
		render(<BoundToggle config={{ enabled: false }} set={set} name="enabled" label="Enable thing" />);
		const toggle = screen.getByRole('switch', { name: 'Enable thing' });
		expect(toggle).not.toBeChecked();
		fireEvent.click(toggle);
		expect(set).toHaveBeenCalledWith({ enabled: true });
	});

	it('shows the switch on when the key is truthy', () => {
		render(<BoundToggle config={{ enabled: true }} set={vi.fn()} name="enabled" label="Enable thing" muted />);
		expect(screen.getByRole('switch', { name: 'Enable thing' })).toBeChecked();
	});
});
