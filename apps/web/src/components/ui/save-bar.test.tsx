import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SaveBar } from './save-bar';

afterEach(cleanup);

describe('SaveBar (FRM-3)', () => {
	it('says all is saved, and offers nothing to do, while clean', () => {
		render(<SaveBar dirty={false} onDiscard={() => {}} />);
		expect(screen.getByRole('status')).toHaveTextContent('All changes saved');
		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Discard changes' })).toBeDisabled();
	});

	it('says what is unsaved, discards, and saves through onSave outside a form', () => {
		const onDiscard = vi.fn();
		const onSave = vi.fn();
		render(<SaveBar dirty onDiscard={onDiscard} onSave={onSave} saveLabel="Save profile" />);
		expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes');
		fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
		fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
		expect(onDiscard).toHaveBeenCalled();
		expect(onSave).toHaveBeenCalled();
		expect(screen.getByRole('button', { name: 'Save profile' })).toHaveAttribute('type', 'button');
	});

	it('submits its form when given no onSave, and is busy while saving', () => {
		const { rerender } = render(<SaveBar dirty onDiscard={() => {}} />);
		expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('type', 'submit');
		rerender(<SaveBar dirty saving onDiscard={() => {}} />);
		const busy = screen.getByRole('button', { name: /Saving…/ });
		expect(busy).toBeDisabled();
		expect(busy).toHaveAttribute('aria-busy', 'true');
		rerender(<SaveBar dirty disabled onDiscard={() => {}} />);
		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
	});
});
