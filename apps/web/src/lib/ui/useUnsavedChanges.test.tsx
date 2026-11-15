import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { createMemoryRouter, Link, RouterProvider, useNavigate } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { useUnsavedChanges } from './useUnsavedChanges';

function Editor({ message }: { message?: string }) {
	const [saved, setSaved] = useState('');
	const [value, setValue] = useState('');
	const navigate = useNavigate();
	const { dialog, allowNext } = useUnsavedChanges(value !== saved, { message });
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
			{dialog}
		</div>
	);
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
});
