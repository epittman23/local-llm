import { render, screen } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorDetails, errorText, toastFailure } from './failureToast';

afterEach(() => vi.restoreAllMocks());

describe('failureToast (FBK-4)', () => {
	it('reads the server words from a detail, a message, a string or anything else', () => {
		expect(errorText({ detail: 'd' })).toBe('d');
		expect(errorText(new Error('m'))).toBe('m');
		expect(errorText(' s ')).toBe('s');
		expect(errorText(42)).toBe('42');
		expect(errorText('')).toBeNull();
		expect(errorText(undefined)).toBeNull();
	});

	it('puts the server words behind Details, never as the message', () => {
		const error = vi.spyOn(toast, 'error').mockReturnValue('id');
		toastFailure('Couldn\'t delete "A".', { detail: 'Database is locked' });
		expect(error).toHaveBeenCalledWith('Couldn\'t delete "A".', {
			description: expect.objectContaining({ props: { detail: 'Database is locked' } })
		});
		toastFailure("Couldn't export the tools.");
		expect(error).toHaveBeenLastCalledWith("Couldn't export the tools.", undefined);
	});

	it('shows the detail inside a closed Details disclosure', () => {
		render(<ErrorDetails detail="Database is locked" />);
		expect(screen.getByText('Details').closest('details')).not.toHaveAttribute('open');
		expect(screen.getByText('Database is locked')).toBeInTheDocument();
	});
});
