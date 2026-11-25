import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOT_FOUND_DETAIL } from '@/components/common/Gone';
import { TooltipProvider } from '@/components/ui/tooltip';
import { deleteNoteById, getNoteById, toggleNotePinnedStatusById, updateNoteById } from '@/lib/apis/notes';
import { useAuthStore } from '@/lib/stores/authStore';
import { usePageTitleStore } from '@/lib/ui/pageTitle';
import { NoteEditorPage, SaveState, useNoteSaver } from './NoteEditorPage';

// The selection's HTML: ProseMirror's own serializer is the editor's business.
vi.mock('@tiptap/core', () => ({ getHTMLFromFragment: () => '<p>one</p><p>two **x**</p>' }));
const editor = vi.hoisted(() => ({ selected: false }));
vi.mock('@/lib/apis/notes', () => ({
	updateNoteById: vi.fn(async () => ({})),
	getNoteById: vi.fn(),
	deleteNoteById: vi.fn(async () => true),
	toggleNotePinnedStatusById: vi.fn(async () => ({})),
	updateNoteAccessGrants: vi.fn(async () => ({ access_grants: [] }))
}));
const toast = vi.hoisted(() => ({
	error: vi.fn(() => 'failure-toast'),
	success: vi.fn(),
	warning: vi.fn(),
	dismiss: vi.fn()
}));
vi.mock('sonner', () => ({ toast }));
const singleUser = vi.hoisted(() => ({ value: true }));
vi.mock('@/routes/workspace/workspaceAccess', () => ({ useSingleUser: () => singleUser.value }));
vi.mock('@/routes/common/FeatureGate', () => ({ FeatureGate: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/lib/settings/userSettings', () => ({ useUserSettings: () => ({ settings: {} }) }));
// Access's dialog is its own tests' business: here a button saves a grant.
vi.mock('@/components/common/AccessControlModal', () => ({
	AccessControlModal: ({ open, onChange }: { open: boolean; onChange: (grants: unknown[]) => unknown }) =>
		open ? (
			<button type="button" onClick={() => onChange([])}>
				Save access
			</button>
		) : null
}));
const clipboard = vi.hoisted(() => ({ ok: true }));
vi.mock('@/lib/utils', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/utils')>()),
	copyToClipboard: vi.fn(async () => clipboard.ok)
}));
// The editor itself is RichTextEditor's own tests' business: here a textarea reports edits.
vi.mock('@/components/common/RichTextEditor', () => ({
	default: ({
		onChange,
		onReady
	}: {
		onChange: (v: { html: string; json: null; md: string }) => void;
		onReady?: (e: unknown) => void;
	}) => (
		<>
			<textarea
				aria-label="Note content"
				onChange={(e) => onChange({ html: `<p>${e.target.value}</p>`, json: null, md: e.target.value })}
			/>
			<button
				type="button"
				onClick={() => {
					// A stand-in editor whose selection the test sets.
					const listeners: (() => void)[] = [];
					onReady?.({
						on: (_: string, fn: () => void) => listeners.push(fn),
						schema: {},
						state: {
							get selection() {
								return { empty: !editor.selected, content: () => ({ content: {} }) };
							}
						}
					});
					for (const fn of listeners) fn();
				}}
			>
				select
			</button>
		</>
	)
}));

const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

beforeEach(() => {
	useAuthStore.setState({ token: 't', user: { id: 'u', role: 'admin' } } as never);
	singleUser.value = true;
});
afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe('useNoteSaver', () => {
	beforeEach(() => vi.useFakeTimers());

	it('saves the last edit after the pause, without keepalive', () => {
		const { result } = renderHook(() => useNoteSaver('n1'), { wrapper });
		act(() => {
			result.current.schedule('A', null);
			result.current.schedule('AB', null);
		});
		act(() => void vi.advanceTimersByTime(500));
		expect(updateNoteById).toHaveBeenCalledExactlyOnceWith('t', 'n1', { title: 'AB', data: {} }, false);
	});

	it('saves a pending edit as the page goes away, with keepalive, and only once (#675)', () => {
		const { result, unmount } = renderHook(() => useNoteSaver('n1'), { wrapper });
		act(() => result.current.schedule('Draft', null));
		act(() => void window.dispatchEvent(new Event('pagehide')));
		expect(updateNoteById).toHaveBeenCalledExactlyOnceWith('t', 'n1', { title: 'Draft', data: {} }, true);
		act(() => void vi.advanceTimersByTime(500));
		unmount();
		window.dispatchEvent(new Event('pagehide'));
		expect(updateNoteById).toHaveBeenCalledTimes(1);
	});

	it('says Saving, then Saved (FBK-1, #1037)', async () => {
		const { result } = renderHook(() => useNoteSaver('n1'), { wrapper });
		expect(result.current.status).toBe('idle');
		act(() => result.current.schedule('A', null));
		await act(async () => void vi.advanceTimersByTime(500));
		expect(result.current.status).toBe('saved');
	});

	it('keeps a refused save, merged under later edits, and Retry sends it again (FBK-4)', async () => {
		const content = { json: null, html: '<p>x</p>', md: 'x' };
		vi.mocked(updateNoteById).mockRejectedValueOnce('Internal Server Error').mockRejectedValueOnce('Still down');
		const { result } = renderHook(() => useNoteSaver('n1'), { wrapper });
		act(() => result.current.schedule('A', content));
		await act(async () => void vi.advanceTimersByTime(500));
		expect(result.current.status).toBe('failed');
		// A second failure replaces the first toast rather than stacking.
		await act(async () => void (await result.current.retry()));
		expect(toast.dismiss).toHaveBeenCalledWith('failure-toast');
		expect(result.current.status).toBe('failed');
		expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/^Couldn't save the note\./), expect.anything());
		await act(async () => void (await result.current.retry()));
		expect(updateNoteById).toHaveBeenLastCalledWith('t', 'n1', { title: 'A', data: { content } }, false);
		expect(result.current.status).toBe('saved');
		expect(toast.dismiss).toHaveBeenCalledTimes(2);
	});
});

describe('SaveState', () => {
	it('says where the save stands, with Retry when it failed', () => {
		const onRetry = vi.fn();
		const { rerender } = render(<SaveState status="idle" onRetry={onRetry} />);
		expect(screen.queryByText(/Sav/)).toBeNull();
		rerender(<SaveState status="saving" onRetry={onRetry} />);
		expect(screen.getByText('Saving…')).toBeTruthy();
		rerender(<SaveState status="saved" onRetry={onRetry} />);
		expect(screen.getByText('Saved')).toBeTruthy();
		rerender(<SaveState status="failed" onRetry={onRetry} />);
		expect(screen.getByText('Not saved')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		expect(onRetry).toHaveBeenCalled();
	});
});

const stored = (extra: Record<string, unknown> = {}) => ({
	id: 'n1',
	title: 'Untitled',
	user_id: 'u',
	write_access: true,
	is_pinned: false,
	data: { content: { json: null, html: '', md: '' } },
	updated_at: 100,
	...extra
});

function openNote(state?: unknown) {
	const router = createMemoryRouter(
		[
			{ path: '/notes', element: <p>notes list</p> },
			{ path: '/notes/:id', element: <NoteEditorPage /> },
			{ path: '/elsewhere', element: <p>elsewhere</p> },
			{ path: '/', element: <p>new chat</p> }
		],
		{ initialEntries: [{ pathname: '/notes/n1', state }] }
	);
	render(
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</QueryClientProvider>
	);
	return router;
}
const openMenu = () =>
	fireEvent.pointerDown(screen.getByRole('button', { name: 'Note menu' }), { button: 0, pointerType: 'mouse' });

describe('the note page', () => {
	it('says a missing note no longer exists, in place, with the way back (NAV-3, #1110)', async () => {
		vi.mocked(getNoteById).mockRejectedValueOnce(NOT_FOUND_DETAIL);
		const router = openNote();
		expect(await screen.findByRole('heading', { level: 2, name: 'This note no longer exists' })).toBeTruthy();
		expect(screen.getByRole('link', { name: 'Back to notes' })).toHaveAttribute('href', '/notes');
		expect(router.state.location.pathname).toBe('/notes/n1');
		expect(toast.error).not.toHaveBeenCalled();
		expect(usePageTitleStore.getState().dynamic).toBe('Note not found');
	});

	it('shows a failed load in place, with Try again (STA-4)', async () => {
		vi.mocked(getNoteById)
			.mockRejectedValueOnce('Database is locked')
			.mockResolvedValueOnce(stored({ title: 'Plan' }));
		openNote();
		expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the note");
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByDisplayValue('Plan')).toBeTruthy();
	});

	it('opens a new note on its title, selected, and deletes it on the way out if nothing was typed (S6-D4)', async () => {
		vi.mocked(getNoteById).mockResolvedValue(stored());
		const router = openNote({ fresh: true });
		const title = (await screen.findByRole('textbox', { name: 'Title' })) as HTMLInputElement;
		await waitFor(() => expect(document.activeElement).toBe(title));
		expect([title.selectionStart, title.selectionEnd]).toEqual([0, 'Untitled'.length]);
		// The flag leaves the history entry, so a reload never counts as new.
		await waitFor(() => expect(router.state.location.state).toBeNull());
		await act(() => router.navigate('/elsewhere'));
		await waitFor(() => expect(deleteNoteById).toHaveBeenCalledExactlyOnceWith('t', 'n1'));
		// Read again first: the copy loaded on the way in may be out of date.
		expect(getNoteById).toHaveBeenCalledTimes(2);
		expect(toast.success).not.toHaveBeenCalled();
	});

	it('keeps a new note another tab wrote in, though this tab saw it empty (S6-D4)', async () => {
		vi.mocked(getNoteById)
			.mockResolvedValueOnce(stored())
			.mockResolvedValueOnce(stored({ title: 'Plan', data: { content: { md: 'Typed elsewhere' } }, updated_at: 200 }));
		const router = openNote({ fresh: true });
		await screen.findByDisplayValue('Untitled');
		await act(() => router.navigate('/elsewhere'));
		await waitFor(() => expect(getNoteById).toHaveBeenCalledTimes(2));
		await screen.findByText('elsewhere');
		expect(deleteNoteById).not.toHaveBeenCalled();
	});

	it('keeps a new note saved since it was opened, even if it is empty again (S6-D4)', async () => {
		vi.mocked(getNoteById)
			.mockResolvedValueOnce(stored())
			.mockResolvedValueOnce(stored({ updated_at: 300 }));
		const router = openNote({ fresh: true });
		await screen.findByDisplayValue('Untitled');
		await act(() => router.navigate('/elsewhere'));
		await waitFor(() => expect(getNoteById).toHaveBeenCalledTimes(2));
		expect(deleteNoteById).not.toHaveBeenCalled();
	});

	it('keeps a new note it could not read again', async () => {
		vi.mocked(getNoteById).mockResolvedValueOnce(stored()).mockRejectedValueOnce('Database is locked');
		const router = openNote({ fresh: true });
		await screen.findByDisplayValue('Untitled');
		await act(() => router.navigate('/elsewhere'));
		await waitFor(() => expect(getNoteById).toHaveBeenCalledTimes(2));
		expect(deleteNoteById).not.toHaveBeenCalled();
	});

	it('deletes an untouched new note when another note opens in its place (S6-D4)', async () => {
		vi.mocked(getNoteById).mockImplementation(async (_t, id) =>
			id === 'n1' ? stored() : stored({ id: 'n2', title: 'Other', data: { content: { md: 'kept' } } })
		);
		const router = openNote({ fresh: true });
		await screen.findByDisplayValue('Untitled');
		await act(() => router.navigate('/notes/n2'));
		expect(await screen.findByDisplayValue('Other')).toBeTruthy();
		await waitFor(() => expect(deleteNoteById).toHaveBeenCalledExactlyOnceWith('t', 'n1'));
		// The note opened in its place was only opened: leaving it deletes nothing more.
		await act(() => router.navigate('/elsewhere'));
		await screen.findByText('elsewhere');
		expect(deleteNoteById).toHaveBeenCalledTimes(1);
	});

	it('treats a note opened fresh in place of another as new too', async () => {
		vi.mocked(getNoteById).mockImplementation(async (_t, id) =>
			id === 'n1' ? stored({ title: 'Plan', data: { content: { md: 'text' } } }) : stored({ id: 'n2' })
		);
		const router = openNote();
		await screen.findByDisplayValue('Plan');
		await act(() => router.navigate('/notes/n2', { state: { fresh: true } }));
		await screen.findByDisplayValue('Untitled');
		await act(() => router.navigate('/elsewhere'));
		await waitFor(() => expect(deleteNoteById).toHaveBeenCalledExactlyOnceWith('t', 'n2'));
	});

	it.each([
		['Pin to sidebar', 'Note pinned'],
		['Copy link', 'Copied link to clipboard']
	])('keeps a new note after %s: that is using it (S6-D4)', async (item, said) => {
		vi.mocked(getNoteById).mockResolvedValue(stored());
		const router = openNote({ fresh: true });
		await screen.findByDisplayValue('Untitled');
		openMenu();
		fireEvent.click(await screen.findByRole('menuitem', { name: item }));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith(said));
		await act(() => router.navigate('/elsewhere'));
		await screen.findByText('elsewhere');
		expect(deleteNoteById).not.toHaveBeenCalled();
	});

	it('keeps a new note after its access is saved (S6-D4)', async () => {
		singleUser.value = false;
		vi.mocked(getNoteById).mockResolvedValue(stored());
		const router = openNote({ fresh: true });
		await screen.findByDisplayValue('Untitled');
		openMenu();
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Access' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Save access' }));
		await act(() => router.navigate('/elsewhere'));
		await screen.findByText('elsewhere');
		expect(deleteNoteById).not.toHaveBeenCalled();
	});

	it('keeps a new note that was typed in', async () => {
		vi.mocked(getNoteById).mockResolvedValue(stored());
		const router = openNote({ fresh: true });
		fireEvent.change(await screen.findByRole('textbox', { name: 'Note content' }), { target: { value: 'x' } });
		await act(() => router.navigate('/elsewhere'));
		await waitFor(() => expect(updateNoteById).toHaveBeenCalled());
		expect(deleteNoteById).not.toHaveBeenCalled();
	});

	it('never deletes a note that was only opened, however empty', async () => {
		vi.mocked(getNoteById).mockResolvedValue(stored());
		const router = openNote();
		await screen.findByRole('textbox', { name: 'Title' });
		expect(document.activeElement).not.toBe(screen.getByRole('textbox', { name: 'Title' }));
		await act(() => router.navigate('/elsewhere'));
		await screen.findByText('elsewhere');
		expect(deleteNoteById).not.toHaveBeenCalled();
	});

	it('shows the save status beside the title (FBK-1)', async () => {
		vi.mocked(getNoteById).mockResolvedValue(stored({ title: 'Plan' }));
		openNote();
		fireEvent.change(await screen.findByRole('textbox', { name: 'Title' }), { target: { value: 'Plan B' } });
		expect(await screen.findByText('Saved', {}, { timeout: 2000 })).toBeTruthy();
		expect(updateNoteById).toHaveBeenCalledWith('t', 'n1', { title: 'Plan B', data: {} }, false);
	});

	it('pins with a toast, and deletes after a confirm naming the note (FBK-3, ACT-3)', async () => {
		vi.mocked(getNoteById).mockResolvedValue(stored({ title: 'Plan' }));
		const router = openNote();
		await screen.findByDisplayValue('Plan');
		openMenu();
		expect(screen.queryByRole('menuitem', { name: 'Access' })).toBeNull();
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin to sidebar' }));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Note pinned'));
		expect(toggleNotePinnedStatusById).toHaveBeenCalledWith('t', 'n1');

		openMenu();
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
		const dialog = await screen.findByRole('alertdialog');
		expect(dialog).toHaveTextContent('Delete “Plan”?');
		fireEvent.click(screen.getByRole('button', { name: 'Delete note' }));
		await waitFor(() => expect(router.state.location.pathname).toBe('/notes'));
		expect(toast.success).toHaveBeenLastCalledWith('Note deleted');
	});

	it('says why a pin or a delete failed, and stays on the note', async () => {
		vi.mocked(getNoteById).mockResolvedValue(stored({ title: 'Plan', is_pinned: true }));
		vi.mocked(toggleNotePinnedStatusById).mockRejectedValueOnce('nope');
		vi.mocked(deleteNoteById).mockRejectedValueOnce('locked');
		const router = openNote();
		await screen.findByDisplayValue('Plan');
		openMenu();
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Unpin' }));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't unpin the note.", expect.anything()));
		openMenu();
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Delete note' }));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't delete the note.", expect.anything()));
		expect(router.state.location.pathname).toBe('/notes/n1');
	});

	it('asks about the note in a new chat from its menu, with the note in the URL and no draft (#1135)', async () => {
		vi.mocked(getNoteById).mockResolvedValue(stored({ title: 'Plan' }));
		const router = openNote();
		await screen.findByDisplayValue('Plan');
		openMenu();
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Ask in a new chat' }));
		await waitFor(() => expect(router.state.location.pathname).toBe('/'));
		expect(router.state.location.search).toBe('?note=n1');
		expect(router.state.location.state).toBeNull();
	});

	it('offers Explain in a new chat only with a selection, quoting it in the navigation state (#1135)', async () => {
		vi.mocked(getNoteById).mockResolvedValue(stored({ title: 'Plan' }));
		const router = openNote();
		await screen.findByDisplayValue('Plan');
		openMenu();
		const item = await screen.findByRole('menuitem', { name: 'Explain in a new chat' });
		expect(item).toHaveAttribute('aria-disabled', 'true');
		fireEvent.keyDown(item, { key: 'Escape' });

		editor.selected = true;
		fireEvent.click(screen.getByRole('button', { name: 'select' }));
		openMenu();
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Explain in a new chat' }));
		await waitFor(() => expect(router.state.location.pathname).toBe('/'));
		expect(router.state.location.search).toBe('?note=n1');
		expect(router.state.location.state).toEqual({ draft: '> one\n> two **x**\n\nExplain this.' });
		editor.selected = false;
	});

	it('offers Access only where there is someone to share with (WRD-4)', async () => {
		singleUser.value = false;
		vi.mocked(getNoteById).mockResolvedValue(stored({ title: 'Plan' }));
		openNote();
		await screen.findByDisplayValue('Plan');
		openMenu();
		expect(await screen.findByRole('menuitem', { name: 'Access' })).toBeTruthy();
	});
});
