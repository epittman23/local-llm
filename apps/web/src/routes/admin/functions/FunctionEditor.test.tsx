import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { FunctionEditor } from './FunctionEditor';

// The code editor, reduced to what FunctionEditor gives it: every onChange it
// was rendered with, oldest first.
const { onChanges } = vi.hoisted(() => ({ onChanges: [] as ((value: string) => void)[] }));
// The editors guard unsaved changes with useBlocker, which needs a data router.
const Routed = ({ children }: { children: ReactNode }) => (
	<RouterProvider router={createMemoryRouter([{ path: '*', element: children }])} />
);

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
		<Routed>
			<TooltipProvider>
				<FunctionEditor fn={null} onSave={vi.fn(async () => {})} />
			</TooltipProvider>
		</Routed>
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

	it('takes a hand-typed id', async () => {
		show();
		fireEvent.change(await screen.findByLabelText('Function ID'), { target: { value: 'profanity_filter' } });
		expect(screen.getByLabelText('Function ID')).toHaveValue('profanity_filter');
	});

	it('shows an existing function’s id as text, not as a field', async () => {
		render(
			<Routed>
				<TooltipProvider>
					<FunctionEditor
						fn={{ id: 'fn_1', name: 'Function 1', meta: { description: 'd' }, content: 'x' }}
						edit
						onSave={vi.fn(async () => {})}
					/>
				</TooltipProvider>
			</Routed>
		);
		await screen.findByLabelText('Function name');
		expect(screen.queryByLabelText('Function ID')).toBeNull();
		expect(screen.getByTitle('fn_1')).toHaveTextContent('fn_1');
	});
});

describe('FunctionEditor code field (#910, #987)', () => {
	afterEach(cleanup);
	it('labels the code and says how to leave it with the keyboard', async () => {
		show();
		expect(await screen.findByText('Function code')).toBeInTheDocument();
		expect(screen.getByText('Tab indents. Press Esc, then Tab, to leave the editor.')).toHaveAttribute('id');
	});
});

describe('FunctionEditor errors stay above the footer (#1015)', () => {
	afterEach(cleanup);
	it('shows why a save failed in place of the help line', async () => {
		render(
			<Routed>
				<TooltipProvider>
					<FunctionEditor
						fn={{ id: 'f', name: 'F', meta: { description: 'd' }, content: 'x = 1' }}
						edit
						onSave={vi.fn().mockRejectedValue('[ERROR: Error updating function]')}
					/>
				</TooltipProvider>
			</Routed>
		);
		fireEvent.submit((await screen.findByLabelText('Function name')).closest('form') as HTMLFormElement);
		expect(await screen.findByRole('alert')).toHaveTextContent(
			"Couldn't save the function. The server couldn't load its code; check that it runs."
		);
	});
});

describe('FunctionEditor saves on request (#905, #1011, FRM-3)', () => {
	afterEach(cleanup);
	it('names its save for what it does, and asks before leaving with unsaved changes', async () => {
		const router = createMemoryRouter(
			[
				{ path: '/admin/functions', element: <p>Functions list</p> },
				{
					path: '/admin/functions/edit',
					element: (
						<TooltipProvider>
							<FunctionEditor
								fn={{ id: 'f', name: 'F', meta: { description: 'd' }, content: 'x = 1' }}
								edit
								onSave={vi.fn()}
							/>
						</TooltipProvider>
					)
				}
			],
			{ initialEntries: ['/admin/functions', '/admin/functions/edit'], initialIndex: 1 }
		);
		render(<RouterProvider router={router} />);
		expect(await screen.findByRole('button', { name: 'Save changes' })).toBeDisabled();
		fireEvent.change(screen.getByLabelText('Function description'), { target: { value: 'changed' } });
		expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
		fireEvent.click(screen.getByRole('button', { name: 'Back' }));
		expect(await screen.findByRole('alertdialog', { name: 'Discard changes?' })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
		expect(await screen.findByText('Functions list')).toBeInTheDocument();
	});

	it('creates code written here without an acknowledgement, then returns to the list', async () => {
		const onSave = vi.fn().mockResolvedValue(true);
		const router = createMemoryRouter(
			[
				{ path: '/admin/functions', element: <p>Functions list</p> },
				{
					path: '/admin/functions/create',
					element: (
						<TooltipProvider>
							<FunctionEditor fn={null} onSave={onSave} />
						</TooltipProvider>
					)
				}
			],
			{ initialEntries: ['/admin/functions/create'] }
		);
		render(<RouterProvider router={router} />);
		fireEvent.change(await screen.findByLabelText('Function name'), { target: { value: 'Mine' } });
		fireEvent.change(screen.getByLabelText('Function description'), { target: { value: 'Mine' } });
		fireEvent.click(screen.getByRole('button', { name: 'Create function' }));
		// Code written here is the person's own: no acknowledgement (S4-D4).
		expect(await screen.findByText('Functions list')).toBeInTheDocument();
		expect(onSave).toHaveBeenCalledOnce();
	});
});

describe('FunctionEditor acknowledgement (#1098, S4-D4)', () => {
	afterEach(cleanup);
	it('asks once before creating a clone, naming where its code came from', async () => {
		const onSave = vi.fn().mockResolvedValue(false);
		render(
			<Routed>
				<TooltipProvider>
					<FunctionEditor
						fn={{ id: 'f_clone', name: 'F (Clone)', meta: { description: 'd' }, content: 'x = 1' }}
						clone
						source={{ kind: 'clone', from: 'F' }}
						onSave={onSave}
					/>
				</TooltipProvider>
			</Routed>
		);
		fireEvent.click(await screen.findByRole('button', { name: 'Create function' }));
		const ack = await screen.findByRole('alertdialog', { name: 'Create function?' });
		expect(ack).toHaveTextContent(
			'The code is copied from "F", and functions run their code on this server: create it only if you trust that code.'
		);
		expect(onSave).not.toHaveBeenCalled();
		fireEvent.click(within(ack).getByRole('button', { name: 'Create function' }));
		await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
	});
});
