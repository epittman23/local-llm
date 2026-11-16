import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { createMemoryRouter, Link, RouterProvider, useNavigate } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useConfirmLeave, useUnsavedChanges } from './useUnsavedChanges';

function Editor({ message }: { message?: string }) {
	const [saved, setSaved] = useState('');
	const [value, setValue] = useState('');
	const navigate = useNavigate();
	const [closed, setClosed] = useState(false);
	const { dialog, allowNext, confirmLeave } = useUnsavedChanges(value !== saved, { message });
	if (closed) return <p>The list, in place</p>;
	return (
		<div>
			<label>
				Draft
				<input value={value} onChange={(e) => setValue(e.target.value)} />
			</label>
			<Link to="/list">Back</Link>
			<Link to="/editor?id=2">Other item</Link>
			<button
				type="button"
				onClick={() => {
					setSaved(value);
					allowNext();
					navigate('/list');
				}}
			>
				Save and leave
			</button>
			<button type="button" onClick={() => setSaved(value)}>
				Save
			</button>
			<button type="button" onClick={() => confirmLeave(() => setClosed(true))}>
				Close in place
			</button>
			<button type="button" onClick={() => confirmLeave(() => setValue(saved))}>
				Close draft
			</button>
			<button type="button" onClick={() => confirmLeave(() => navigate('/list'))}>
				Back by navigate
			</button>
			{dialog}
		</div>
	);
}

// A dialog holding a draft, as the Edit prompt dialog does. "Scrim" raises the
// question the way a scrim press does: focus leaves for <body> just after
// (`after`), or has already left (`before`). "Gone" is a control that goes as
// it raises the question, so focus has nowhere to return to.
function DraftDialog() {
	const [open, setOpen] = useState(true);
	const [value, setValue] = useState('');
	const [gone, setGone] = useState(false);
	const guard = useUnsavedChanges(value !== '');
	const close = () => guard.confirmLeave(() => setOpen(false));
	const scrim = (when: 'before' | 'after') => () => {
		if (when === 'before') (document.activeElement as HTMLElement | null)?.blur();
		close();
		if (when === 'after') (document.activeElement as HTMLElement | null)?.blur();
	};
	return (
		<>
			<Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
				<DialogContent showCloseButton={false} aria-describedby={undefined}>
					<DialogTitle>Edit</DialogTitle>
					<label>
						Content
						<input value={value} onChange={(e) => setValue(e.target.value)} />
					</label>
					<button type="button" onPointerDown={scrim('after')}>
						Scrim by mouse
					</button>
					<button type="button" onPointerDown={scrim('before')}>
						Scrim by touch
					</button>
					<label>
						Note
						<input />
					</label>
					{!gone && (
						<button
							type="button"
							onClick={() => {
								setGone(true);
								close();
							}}
						>
							Gone
						</button>
					)}
				</DialogContent>
			</Dialog>
			{guard.dialog}
		</>
	);
}

function setupDialog() {
	const router = createMemoryRouter([{ path: '/', element: <DraftDialog /> }]);
	render(<RouterProvider router={router} />);
	const field = screen.getByRole('textbox', { name: 'Content' });
	fireEvent.change(field, { target: { value: 'half a prompt' } });
	field.focus();
	return field;
}

function setup(message?: string) {
	const router = createMemoryRouter(
		[
			{ path: '/editor', element: <Editor message={message} /> },
			{ path: '/list', element: <p>The list</p> }
		],
		{ initialEntries: ['/list', '/editor'], initialIndex: 1 }
	);
	render(<RouterProvider router={router} />);
	return router;
}

const type = (text: string) =>
	fireEvent.change(screen.getByRole('textbox', { name: 'Draft' }), { target: { value: text } });

const unload = () => {
	const event = new Event('beforeunload', { cancelable: true });
	window.dispatchEvent(event);
	return event.defaultPrevented;
};

describe('useUnsavedChanges', () => {
	afterEach(() => {
		delete (window as { lllmDesktop?: unknown }).lllmDesktop;
	});

	it('leaves at once while nothing has changed', async () => {
		setup();
		fireEvent.click(screen.getByRole('link', { name: 'Back' }));
		expect(await screen.findByText('The list')).toBeTruthy();
		expect(screen.queryByRole('alertdialog')).toBeNull();
	});

	it('asks before a link loses changes; Keep editing stays with the draft', async () => {
		const router = setup();
		type('half a system prompt');
		fireEvent.click(screen.getByRole('link', { name: 'Back' }));
		const ask = await screen.findByRole('alertdialog', { name: 'Discard changes?' });
		expect(ask.textContent).toContain('Your changes are not saved. They are lost if you leave this page.');
		fireEvent.click(within(ask).getByRole('button', { name: 'Keep editing' }));
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		expect(router.state.location.pathname).toBe('/editor');
		expect((screen.getByRole('textbox', { name: 'Draft' }) as HTMLInputElement).value).toBe('half a system prompt');
	});

	it('leaves after Discard changes', async () => {
		const router = setup('This model is not saved.');
		type('x');
		fireEvent.click(screen.getByRole('link', { name: 'Back' }));
		const ask = await screen.findByRole('alertdialog');
		expect(ask.textContent).toContain('This model is not saved.');
		fireEvent.click(within(ask).getByRole('button', { name: 'Discard changes' }));
		expect(await screen.findByText('The list')).toBeTruthy();
		expect(router.state.location.pathname).toBe('/list');
	});

	it('asks on the browser’s Back, and Escape keeps the page', async () => {
		const router = setup();
		type('x');
		act(() => {
			router.navigate(-1);
		});
		const ask = await screen.findByRole('alertdialog');
		fireEvent.keyDown(ask, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		expect(router.state.location.pathname).toBe('/editor');
	});

	it('leaves on the browser’s Back after Discard changes', async () => {
		const router = setup();
		type('x');
		act(() => {
			router.navigate(-1);
		});
		fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
		expect(await screen.findByText('The list')).toBeTruthy();
		expect(router.state.location.pathname).toBe('/list');
	});

	it('asks when only the query changes (another item in the same editor)', async () => {
		const router = setup();
		type('x');
		fireEvent.click(screen.getByRole('link', { name: 'Other item' }));
		expect(await screen.findByRole('alertdialog')).toBeTruthy();
		expect(router.state.location.search).toBe('');
	});

	it('still asks on the next way out after Discard changes kept the page mounted (another item)', async () => {
		const router = setup();
		type('x');
		fireEvent.click(screen.getByRole('link', { name: 'Other item' }));
		fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
		await waitFor(() => expect(router.state.location.search).toBe('?id=2'));
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		fireEvent.click(screen.getByRole('link', { name: 'Back' }));
		expect(await screen.findByRole('alertdialog')).toBeTruthy();
		expect(router.state.location.pathname).toBe('/editor');
	});

	it('lets a successful save’s navigation through with allowNext', async () => {
		const router = setup();
		type('x');
		fireEvent.click(screen.getByRole('button', { name: 'Save and leave' }));
		expect(await screen.findByText('The list')).toBeTruthy();
		expect(screen.queryByRole('alertdialog')).toBeNull();
		expect(router.state.location.pathname).toBe('/list');
	});

	it('stops asking once the changes are saved (a new baseline), and asks again after the next edit', async () => {
		setup();
		type('x');
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(unload()).toBe(false);
		type('xy');
		expect(unload()).toBe(true);
		fireEvent.click(screen.getByRole('link', { name: 'Back' }));
		expect(await screen.findByRole('alertdialog')).toBeTruthy();
	});

	it('confirmLeave runs a leave that is not a navigation at once while nothing has changed', () => {
		setup();
		fireEvent.click(screen.getByRole('button', { name: 'Close in place' }));
		expect(screen.getByText('The list, in place')).toBeTruthy();
		expect(screen.queryByRole('alertdialog')).toBeNull();
	});

	it('confirmLeave asks first while dirty: Keep editing stays, Discard changes leaves', async () => {
		setup('Your changes to “Tutor” are not saved.');
		type('x');
		fireEvent.click(screen.getByRole('button', { name: 'Close in place' }));
		const ask = await screen.findByRole('alertdialog', { name: 'Discard changes?' });
		expect(ask.textContent).toContain('Your changes to “Tutor” are not saved.');
		fireEvent.click(within(ask).getByRole('button', { name: 'Keep editing' }));
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		expect((screen.getByRole('textbox', { name: 'Draft' }) as HTMLInputElement).value).toBe('x');
		fireEvent.click(screen.getByRole('button', { name: 'Close in place' }));
		fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
		expect(await screen.findByText('The list, in place')).toBeTruthy();
	});

	it('still guards the next navigation after confirmLeave discarded a draft without leaving', async () => {
		const router = setup();
		type('x');
		fireEvent.click(screen.getByRole('button', { name: 'Close draft' }));
		fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		await act(() => new Promise((resolve) => setTimeout(resolve)));
		type('y');
		fireEvent.click(screen.getByRole('link', { name: 'Back' }));
		expect(await screen.findByRole('alertdialog')).toBeTruthy();
		expect(router.state.location.pathname).toBe('/editor');
	});

	it('confirmLeave asks once for a leave that navigates', async () => {
		const router = setup();
		type('x');
		fireEvent.click(screen.getByRole('button', { name: 'Back by navigate' }));
		fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
		expect(await screen.findByText('The list')).toBeTruthy();
		expect(screen.queryByRole('alertdialog')).toBeNull();
		expect(router.state.location.pathname).toBe('/list');
	});

	it('has the browser ask before a reload only while there are unsaved changes', () => {
		setup();
		expect(unload()).toBe(false);
		type('x');
		expect(unload()).toBe(true);
		type('');
		expect(unload()).toBe(false);
	});

	it('leaves the desktop app’s unload alone, since Electron would refuse it without asking', () => {
		Object.assign(window, { lllmDesktop: {} });
		setup();
		type('x');
		expect(unload()).toBe(false);
	});

	it('Keep editing after a mouse click on the scrim puts focus back on the field that had it (NAV-4)', async () => {
		const field = setupDialog();
		fireEvent.pointerDown(screen.getByRole('button', { name: 'Scrim by mouse' }));
		expect(document.activeElement).not.toBe(field);
		fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Keep editing' }));
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(field));
	});

	it('Keep editing after focus had already left for <body> returns it to the control focused last', async () => {
		const field = setupDialog();
		const note = screen.getByRole('textbox', { name: 'Note' });
		note.focus();
		fireEvent.pointerDown(screen.getByRole('button', { name: 'Scrim by touch' }));
		fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Keep editing' }));
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(note));
		expect((field as HTMLInputElement).value).toBe('half a prompt');
	});

	it('Keep editing focuses the dialog’s first control when the control that had focus has gone', async () => {
		const field = setupDialog();
		const gone = screen.getByRole('button', { name: 'Gone' });
		gone.focus();
		fireEvent.click(gone);
		fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Keep editing' }));
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		expect(screen.queryByRole('button', { name: 'Gone' })).toBeNull();
		await waitFor(() => expect(document.activeElement).toBe(field));
	});

	it('Escape on the question returns focus to the field too', async () => {
		const field = setupDialog();
		fireEvent.pointerDown(screen.getByRole('button', { name: 'Scrim by touch' }));
		fireEvent.keyDown(await screen.findByRole('alertdialog'), { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(field));
	});

	it('Discard changes leaves focus to the closed dialog, never to a field that has gone', async () => {
		setupDialog();
		fireEvent.pointerDown(screen.getByRole('button', { name: 'Scrim by mouse' }));
		fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		expect(screen.queryByRole('textbox', { name: 'Content' })).toBeNull();
		expect(document.activeElement?.closest('[role="dialog"], [role="alertdialog"]') ?? null).toBeNull();
	});

	it('Keep editing on a page with no dialog under it leaves focus to where the question came from', async () => {
		setup();
		type('x');
		const back = screen.getByRole('link', { name: 'Back' });
		back.focus();
		fireEvent.click(back);
		fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Keep editing' }));
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(back));
	});
});

// An editor hosted inside a page that already guards navigation, as the model
// editor is inside an Admin settings tab: its own Back asks, the page's guard
// asks on a navigation, and only one of them ever asks.
function HostedEditor() {
	const [hostDirty, setHostDirty] = useState(false);
	const [value, setValue] = useState('');
	const [closed, setClosed] = useState(false);
	const host = useUnsavedChanges(hostDirty || value !== '');
	const own = useConfirmLeave(value !== '', { message: 'The editor has changes.' });
	return (
		<div>
			<label>
				Draft
				<input value={value} onChange={(e) => setValue(e.target.value)} />
			</label>
			<button type="button" onClick={() => setHostDirty(true)}>
				Dirty the host
			</button>
			{closed ? <p>Editor closed</p> : null}
			<button type="button" onClick={() => own.confirmLeave(() => setClosed(true))}>
				Editor back
			</button>
			<Link to="/list">Other tab</Link>
			{host.dialog}
			{own.dialog}
		</div>
	);
}

function OwnOnly() {
	return useConfirmLeave(true).dialog;
}

describe('useConfirmLeave', () => {
	const setupHosted = () => {
		const router = createMemoryRouter(
			[
				{ path: '/editor', element: <HostedEditor /> },
				{ path: '/list', element: <p>The list</p> }
			],
			{ initialEntries: ['/editor'] }
		);
		render(<RouterProvider router={router} />);
		return router;
	};
	const typeDraft = (text: string) =>
		fireEvent.change(screen.getByRole('textbox', { name: 'Draft' }), { target: { value: text } });

	it('runs its leave at once while nothing has changed', () => {
		setupHosted();
		fireEvent.click(screen.getByRole('button', { name: 'Editor back' }));
		expect(screen.getByText('Editor closed')).toBeTruthy();
		expect(screen.queryByRole('alertdialog')).toBeNull();
	});

	it('asks with its own message before its leave while dirty', async () => {
		setupHosted();
		typeDraft('x');
		fireEvent.click(screen.getByRole('button', { name: 'Editor back' }));
		const ask = await screen.findByRole('alertdialog', { name: 'Discard changes?' });
		expect(ask.textContent).toContain('The editor has changes.');
		fireEvent.click(within(ask).getByRole('button', { name: 'Discard changes' }));
		expect(await screen.findByText('Editor closed')).toBeTruthy();
	});

	it('leaves navigation to the host, which still asks, once (one blocker per router)', async () => {
		const router = setupHosted();
		typeDraft('x');
		fireEvent.click(screen.getByRole('link', { name: 'Other tab' }));
		const asks = await screen.findAllByRole('alertdialog');
		expect(asks).toHaveLength(1);
		expect(asks[0].textContent).toContain('Your changes are not saved.');
		fireEvent.click(within(asks[0]).getByRole('button', { name: 'Discard changes' }));
		expect(await screen.findByText('The list')).toBeTruthy();
		expect(router.state.location.pathname).toBe('/list');
	});

	it('never has the browser ask before a reload (the host does that)', () => {
		const add = vi.spyOn(window, 'addEventListener');
		const router = createMemoryRouter([{ path: '/', element: <OwnOnly /> }]);
		render(<RouterProvider router={router} />);
		expect(add.mock.calls.some(([type]) => type === 'beforeunload')).toBe(false);
		add.mockRestore();
	});
});
