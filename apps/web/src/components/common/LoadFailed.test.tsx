import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerUnreachableError } from '@/lib/apis/errors';
import { failureCause, LoadFailed } from './LoadFailed';

describe('LoadFailed', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('names what failed, says why, keeps the server message behind Details, and tries again', () => {
		const onRetry = vi.fn();
		render(<LoadFailed what="prompts" error="Database is locked" onRetry={onRetry} />);

		const alert = screen.getByRole('alert');
		expect(alert).toHaveTextContent("Couldn't load prompts");
		expect(alert).toHaveTextContent('The server answered with an error.');
		expect(screen.getByText('Details')).toBeInTheDocument();
		expect(screen.getByText('Database is locked')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it('says the server did not answer for a network failure, with no Details', () => {
		render(<LoadFailed what="models" error={new ServerUnreachableError()} onRetry={() => {}} />);
		expect(screen.getByRole('alert')).toHaveTextContent('The server did not answer. It may be restarting or stopped.');
		expect(screen.queryByText('Details')).toBeNull();
	});

	it('shows that it is trying again and cannot be pressed twice', () => {
		render(<LoadFailed what="tools" error={null} onRetry={() => {}} retrying />);
		expect(screen.getByRole('button', { name: 'Trying again…' })).toBeDisabled();
	});
});

describe('failureCause', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('says the computer is offline when the browser knows it is', () => {
		vi.stubGlobal('navigator', { onLine: false });
		expect(failureCause(null)).toEqual({
			cause: 'This computer is offline. It loads again when the connection is back.',
			detail: null
		});
	});

	it("treats fetch's TypeError as no answer, and an empty error as an error with no detail", () => {
		expect(failureCause(new TypeError('Failed to fetch')).detail).toBeNull();
		expect(failureCause(new TypeError('Failed to fetch')).cause).toMatch('did not answer');
		expect(failureCause(undefined)).toEqual({ cause: 'The server answered with an error.', detail: null });
	});
});
