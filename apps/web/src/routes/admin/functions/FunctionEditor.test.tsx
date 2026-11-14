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
		await screen.findByLabelText('Function name');
		await vi.waitFor(() => expect(onChanges.length).toBeGreaterThan(0));
		act(() => onChanges[0](code));
		expect(screen.getByLabelText('Function name')).toHaveValue('Example Filter');
		expect(screen.getByLabelText('Function ID')).toHaveValue('example_filter');
		expect(screen.getByLabelText('Function description')).toHaveValue('Filters things');
	});

	it('keeps a typed name when the editor reports through a callback from before it was typed', async () => {
		// The editor seeds its boilerplate in an effect, through the callback of
		// the render it last saw; when that ran after a name was typed, the old
		// callback read the name as blank and the boilerplate's title replaced it
		// (admin-functions.spec.ts in CI: "Example Filter" where "Mine" was typed).
		show();
		await vi.waitFor(() => expect(onChanges.length).toBeGreaterThan(0));
		const stale = onChanges[0];
		fireEvent.change(screen.getByLabelText('Function name'), { target: { value: 'Mine' } });
		fireEvent.change(screen.getByLabelText('Function description'), { target: { value: 'My own' } });
		act(() => stale(code));
		expect(screen.getByLabelText('Function name')).toHaveValue('Mine');
		expect(screen.getByLabelText('Function ID')).toHaveValue('mine');
		expect(screen.getByLabelText('Function description')).toHaveValue('My own');
	});
});

describe('FunctionEditor fields (#1057, #983)', () => {
	afterEach(cleanup);

	it('gives each field a visible label tied to the shared input, with an example as its placeholder', async () => {
		show();
		const name = await screen.findByLabelText('Function name');
		expect(name).toHaveAttribute('data-slot', 'input');
		expect(name).toHaveAttribute('placeholder', 'e.g. My Filter');
		expect(screen.getByLabelText('Function ID')).toHaveAttribute('placeholder', 'e.g. my_filter');
		expect(screen.getByLabelText('Function description')).toBeRequired();
		expect(screen.getByText('Function description').tagName).toBe('LABEL');
	});

	it('shows an existing function’s id as text, not as a field', async () => {
		render(
			<MemoryRouter>
				<TooltipProvider>
					<FunctionEditor
						fn={{ id: 'fn_1', name: 'Function 1', meta: { description: 'd' }, content: 'x' }}
						edit
						onSave={vi.fn(async () => {})}
					/>
				</TooltipProvider>
			</MemoryRouter>
		);
		await screen.findByLabelText('Function name');
		expect(screen.queryByLabelText('Function ID')).toBeNull();
		expect(screen.getByTitle('fn_1')).toHaveTextContent('fn_1');
	});
});
