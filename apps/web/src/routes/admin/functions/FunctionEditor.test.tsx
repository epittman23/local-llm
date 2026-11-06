import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { FunctionEditor } from './FunctionEditor';

// The code editor, reduced to what FunctionEditor gives it: every onChange it
// was rendered with, oldest first.
const { onChanges } = vi.hoisted(() => ({ onChanges: [] as ((value: string) => void)[] }));
vi.mock('@/components/common/CodeEditor', () => ({
	default: ({ onChange }: { onChange: (value: string) => void }) => {
		onChanges.push(onChange);
		return null;
	}
}));

// A header with both fields the editor fills in.
const code = '"""\ntitle: Example Filter\ndescription: Filters things\n"""\n';

function show() {
	render(
		<MemoryRouter>
			<TooltipProvider>
				<FunctionEditor fn={null} onSave={vi.fn(async () => {})} />
			</TooltipProvider>
		</MemoryRouter>
	);
}

describe('FunctionEditor (create): the code header fills only a blank name or description', () => {
	afterEach(() => {
		cleanup();
		onChanges.length = 0;
	});

	it('fills a blank name and description from the code header', async () => {
		show();
		await screen.findByLabelText('Function Name');
		await vi.waitFor(() => expect(onChanges.length).toBeGreaterThan(0));
		act(() => onChanges[0](code));
		expect(screen.getByLabelText('Function Name')).toHaveValue('Example Filter');
		expect(screen.getByLabelText('Function ID')).toHaveValue('example_filter');
		expect(screen.getByLabelText('Function Description')).toHaveValue('Filters things');
	});

	it('keeps a typed name when the editor reports through a callback from before it was typed', async () => {
		// The editor seeds its boilerplate in an effect, through the callback of
		// the render it last saw; when that ran after a name was typed, the old
		// callback read the name as blank and the boilerplate's title replaced it
		// (admin-functions.spec.ts in CI: "Example Filter" where "Mine" was typed).
		show();
		await vi.waitFor(() => expect(onChanges.length).toBeGreaterThan(0));
		const stale = onChanges[0];
		fireEvent.change(screen.getByLabelText('Function Name'), { target: { value: 'Mine' } });
		fireEvent.change(screen.getByLabelText('Function Description'), { target: { value: 'My own' } });
		act(() => stale(code));
		expect(screen.getByLabelText('Function Name')).toHaveValue('Mine');
		expect(screen.getByLabelText('Function ID')).toHaveValue('mine');
		expect(screen.getByLabelText('Function Description')).toHaveValue('My own');
	});
});
