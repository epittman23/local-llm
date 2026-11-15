import { fireEvent, render, screen, within } from '@testing-library/react';
import { type Ref, useImperativeHandle } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { CodeEditorHandle, CodeParseError } from '@/components/common/CodeEditor';
import { TooltipProvider } from '@/components/ui/tooltip';
import { CodeEditorFieldDemo, FailedRowDemo, RowStateDemo } from './workspaceDemos';

// CodeMirror is replaced by a field that reports Black's parse error when asked to format.
vi.mock('@/components/common/CodeEditor', () => ({
	default: ({
		ariaLabel,
		describedBy,
		onParseError,
		ref
	}: {
		ariaLabel?: string;
		describedBy?: string;
		onParseError?: (error: CodeParseError | null) => void;
		ref?: Ref<CodeEditorHandle>;
	}) => {
		useImperativeHandle(ref, () => ({
			formatPython: async () => {
				onParseError?.({ line: 3, column: 22, detail: 'Cannot parse: 3:22: EOF in multi-line statement' });
				return 'invalid';
			},
			focus: () => {},
			replace: () => {}
		}));
		return <textarea aria-label={ariaLabel} aria-describedby={describedBy} />;
	}
}));

describe('/ui workspace demos', () => {
	it("shows a row's state as a secondary badge, and names each switch for its row (DAT-3, A11Y-2)", () => {
		render(<RowStateDemo />);
		for (const word of ['Off', 'Hidden', 'Read only']) {
			expect(screen.getByText(word)).toHaveAttribute('data-variant', 'secondary');
		}
		expect(screen.getByRole('switch', { name: 'Enable Code reviewer' })).not.toBeChecked();
		expect(screen.queryByRole('switch', { name: 'Enable Shared glossary' })).toBeNull();
		fireEvent.click(screen.getByRole('switch', { name: 'Enable Statistics tutor' }));
		const tutor = screen.getByText('Statistics tutor').closest('li') as HTMLElement;
		expect(within(tutor).getByText('Off')).toBeInTheDocument();
	});

	it('keeps a failed row in place with its reason, Details, Retry and Dismiss (STA-4)', () => {
		render(
			<TooltipProvider>
				<FailedRowDemo />
			</TooltipProvider>
		);
		expect(screen.getByText("It was uploaded but couldn't be processed into searchable text.")).toBeInTheDocument();
		expect(screen.getByText('Details')).toBeInTheDocument();
		expect(screen.getAllByRole('button', { name: /^Retry / })).toHaveLength(1);
		fireEvent.click(screen.getByRole('button', { name: 'Dismiss sample-variance.md' }));
		expect(screen.queryByRole('button', { name: 'Dismiss sample-variance.md' })).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Show the rows again' }));
		expect(screen.getByRole('button', { name: 'Dismiss sample-variance.md' })).toBeInTheDocument();
	});

	it('shows the code editor as a labelled field whose parse error replaces its help line (CNT-2)', async () => {
		render(<CodeEditorFieldDemo />);
		const code = await screen.findByRole('textbox', { name: 'Tool code' });
		const help = () => document.getElementById(code.getAttribute('aria-describedby') as string);
		expect(help()).toHaveTextContent('Tab indents. Press Esc, then Tab, to leave the editor.');
		fireEvent.click(screen.getByRole('button', { name: 'Check the code' }));
		expect(await screen.findByRole('alert')).toHaveTextContent("Line 3, column 22: this line isn't valid Python.");
		expect(help()).toHaveAttribute('role', 'alert');
		expect(screen.getByText('Cannot parse: 3:22: EOF in multi-line statement')).toBeInTheDocument();
	});
});
