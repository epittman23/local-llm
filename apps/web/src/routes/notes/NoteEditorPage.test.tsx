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

vi.mock('@/lib/apis/notes', () => ({
	updateNoteById: vi.fn(async () => ({})),
	getNoteById: vi.fn(),
	deleteNoteById: vi.fn(async () => true),
	toggleNotePinnedStatusById: vi.fn(async () => ({})),
	updateNoteAccessGrants: vi.fn()
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
vi.mock('@/components/common/AccessControlModal', () => ({ AccessControlModal: () => null }));
// The editor itself is RichTextEditor's own tests' business: here a textarea reports edits.
vi.mock('@/components/common/RichTextEditor', () => ({
	default: ({ onChange }: { onChange: (v: { html: string; json: null; md: string }) => void }) => (
		<textarea
			aria-label="Note content"
			onChange={(e) => onChange({ html: `<p>${e.target.value}</p>`, json: null, md: e.target.value })}
		/>
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
	...extra
});

function openNote(state?: unknown) {
	const router = createMemoryRouter(
		[
			{ path: '/notes', element: <p>notes list</p> },
			{ path: '/notes/:id', element: <NoteEditorPage /> },
			{ path: '/elsewhere', element: <p>elsewhere</p> }
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
		expect(toast.success).not.toHaveBeenCalled();
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

	it('offers Access only where there is someone to share with (WRD-4)', async () => {
		singleUser.value = false;
		vi.mocked(getNoteById).mockResolvedValue(stored({ title: 'Plan' }));
		openNote();
		await screen.findByDisplayValue('Plan');
		openMenu();
		expect(await screen.findByRole('menuitem', { name: 'Access' })).toBeTruthy();
	});
});
