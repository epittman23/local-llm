import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EditorError, parseProblem, saveProblem } from './EditorError';

describe('EditorError (#1015, FBK-1, FBK-4)', () => {
	it('locates a parse error in words and keeps Black’s message for Details', () => {
		expect(parseProblem({ line: 30, column: 12, detail: 'cannot parse: 30:12' })).toEqual({
			message: "Line 30, column 12: this line isn't valid Python.",
			detail: 'cannot parse: 30:12'
		});
	});

	it('says what a failed save means rather than the server’s wrapper', () => {
		expect(saveProblem('[ERROR: Error updating tool]', 'tool')).toEqual({
			message: "Couldn't save the tool. The server couldn't load its code; check that it runs.",
			detail: 'Error updating tool'
		});
		expect(saveProblem('[ERROR: Server storage is not writable.]', 'function')).toEqual({
			message: "Couldn't save the function. Server storage is not writable.",
			detail: null
		});
		expect(saveProblem('Uh-oh! This id is already registered. Please choose another id string.', 'tool')).toEqual({
			message: 'This ID is already used by another tool. Choose another.',
			detail: null
		});
		expect(saveProblem(new TypeError('Failed to fetch'), 'tool').message).toBe(
			"Couldn't save the tool. The server did not answer. It may be restarting or stopped."
		);
	});

	it('is an alert with the help line’s id, and hides the detail behind Details', () => {
		render(<EditorError id="help" problem={{ message: 'Line 2, column 1: bad', detail: 'raw\nwords' }} />);
		const alert = screen.getByRole('alert');
		expect(alert).toHaveAttribute('id', 'help');
		expect(alert).toHaveTextContent('Line 2, column 1: bad');
		expect(screen.getByText('Details').tagName).toBe('SUMMARY');
	});

	it('shows no Details when there is nothing more to say', () => {
		render(<EditorError id="help" problem={{ message: 'Couldn’t save the tool.', detail: null }} />);
		expect(screen.queryByText('Details')).toBeNull();
	});
});
