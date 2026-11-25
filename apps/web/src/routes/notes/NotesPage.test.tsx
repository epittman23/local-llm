// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
	createNewNote,
	deleteNoteById,
	getPinnedNoteList,
	searchNotes,
	toggleNotePinnedStatusById
} from '@/lib/apis/notes';
import { NewNotePage, NotesPage } from './NotesPage';

// #210: a `?title=` link whose create failed left the page on its spinner,
// with nothing to say why.

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const singleUser = vi.hoisted(() => ({ value: true }));
vi.mock('@/routes/workspace/workspaceAccess', () => ({ useSingleUser: () => singleUser.value }));
vi.mock('@/routes/common/FeatureGate', () => ({ FeatureGate: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/lib/apis/notes', () => ({
	createNewNote: vi.fn(),
	searchNotes: vi.fn(async () => ({ items: [], total: 0 })),
	deleteNoteById: vi.fn(),
	getNoteById: vi.fn(),
	getPinnedNoteList: vi.fn(async () => []),
	toggleNotePinnedStatusById: vi.fn()
}));

function NoteProbe() {
	const location = useLocation();
	return <p>note page{(location.state as { fresh?: boolean } | null)?.fresh ? ' (fresh)' : ''}</p>;
}

const open = (entry: string) => {
	const router = createMemoryRouter(
		[
			{ path: '/notes', element: <NotesPage /> },
			{ path: '/notes/new', element: <NewNotePage /> },
			{ path: '/notes/:id', element: <NoteProbe /> },
			{ path: '/', element: <p>new chat</p> }
		],
		{ initialEntries: [entry] }
	);
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</QueryClientProvider>
	);
	return router;
};

describe('a ?title= link to Notes (#210)', () => {
	beforeEach(() => vi.clearAllMocks());

	for (const entry of ['/notes?title=Plan', '/notes/new?title=Plan']) {
		it(`${entry}: a refused create says why and opens the list`, async () => {
			vi.mocked(createNewNote).mockRejectedValueOnce('Notes are not allowed');
			const router = open(entry);
			await waitFor(() => expect(router.state.location.pathname).toBe('/notes'));
			expect(router.state.location.search).toBe('');
			expect(toast.error.mock.calls).toEqual([['Notes are not allowed']]);
			await waitFor(() => expect(searchNotes).toHaveBeenCalled());
		});

		it(`${entry}: a created note is opened`, async () => {
			vi.mocked(createNewNote).mockResolvedValueOnce({ id: 'n1' });
			const router = open(entry);
			expect(await screen.findByText(/^note page/)).toBeTruthy();
			expect(router.state.location.pathname).toBe('/notes/n1');
			expect(toast.error).not.toHaveBeenCalled();
		});
	}
});

describe('a Notes list that cannot load (STA-4, #981)', () => {
	beforeEach(() => vi.clearAllMocks());

	it('shows the failure in place of the list, with no toast, and tries again', async () => {
		vi.mocked(searchNotes).mockRejectedValueOnce('Database is locked');
		open('/notes');

		expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load notes");
		expect(screen.queryByText('No notes yet')).toBeNull();
		expect(toast.error).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByText('No notes yet')).toBeTruthy();
		expect(screen.queryByRole('alert')).toBeNull();
	});
});

const ns = (d: Date) => d.getTime() * 1_000_000;
const item = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
	id,
	title,
	updated_at: ns(new Date()),
	user: { name: 'Ada' },
	write_access: true,
	data: { content: { md: `# ${title}\n\n- [ ] first **step**` } },
	...extra
});
const openMenu = (title: string) =>
	fireEvent.pointerDown(screen.getByRole('button', { name: `More for ${title}` }), { button: 0, pointerType: 'mouse' });

describe('the Notes list (#1036, #1073, #963, #1037)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		singleUser.value = true;
		vi.mocked(getPinnedNoteList).mockResolvedValue([]);
	});

	it('heads the page, and with one account shows no ownership filters or author (LAY-5, WRD-4)', async () => {
		vi.mocked(searchNotes).mockResolvedValue({ items: [item('a', 'Plan')], total: 1 });
		open('/notes');
		expect(await screen.findByRole('heading', { level: 1, name: 'Notes' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'New note' })).toBeTruthy();
		expect(await screen.findByText('Plan')).toBeTruthy();
		// One line of the body, as read: no Markdown markers.
		expect(screen.getByText('Plan · first step')).toBeTruthy();
		expect(screen.queryByText('Ada')).toBeNull();
		expect(screen.queryByRole('button', { name: /View:/ })).toBeNull();
		expect(screen.getByText('now')).toBeTruthy();
	});

	it('with several accounts offers the ownership and access filters and names the author', async () => {
		singleUser.value = false;
		vi.mocked(searchNotes).mockResolvedValue({ items: [item('a', 'Plan')], total: 1 });
		open('/notes');
		expect(await screen.findByText('Ada')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'View: All' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Access: Can edit' })).toBeTruthy();
	});

	it('switches to a grid of cards with a plain-text preview', async () => {
		vi.mocked(searchNotes).mockResolvedValue({ items: [item('a', 'Plan')], total: 1 });
		open('/notes');
		await screen.findByText('Plan');
		fireEvent.click(screen.getByRole('radio', { name: 'Grid' }));
		expect(await screen.findByText(/first step/)).toHaveClass('line-clamp-4');
	});

	it('puts pinned notes first, marked, and out of the time groups', async () => {
		vi.mocked(searchNotes).mockResolvedValue({ items: [item('a', 'Plan'), item('b', 'Log')], total: 2 });
		vi.mocked(getPinnedNoteList).mockResolvedValue([item('b', 'Log', { is_pinned: true })]);
		open('/notes');
		const pinned = await screen.findByRole('region', { name: 'Pinned' });
		expect(pinned).toHaveTextContent('Log');
		expect(screen.getByRole('region', { name: 'Today' })).not.toHaveTextContent('Log');
		expect(screen.getAllByRole('img', { name: 'Pinned' })).toHaveLength(1);
	});

	it('asks about a note in a new chat from its row menu (#1135)', async () => {
		vi.mocked(searchNotes).mockResolvedValue({ items: [item('a', 'Plan')], total: 1 });
		const router = open('/notes');
		await screen.findByText('Plan');
		openMenu('Plan');
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Ask in a new chat' }));
		await waitFor(() => expect(router.state.location.pathname).toBe('/'));
		expect(router.state.location.search).toBe('?note=a');
	});

	it('opens a note from its row', async () => {
		vi.mocked(searchNotes).mockResolvedValue({ items: [item('a', 'Plan')], total: 1 });
		const router = open('/notes');
		fireEvent.click(await screen.findByText('Plan'));
		await waitFor(() => expect(router.state.location.pathname).toBe('/notes/a'));
	});

	it('pins with a toast, and deletes after a confirm with a toast (FBK-3, ACT-3)', async () => {
		vi.mocked(searchNotes).mockResolvedValue({ items: [item('a', 'Plan')], total: 1 });
		vi.mocked(toggleNotePinnedStatusById).mockResolvedValue({});
		vi.mocked(deleteNoteById).mockResolvedValue(true);
		open('/notes');
		await screen.findByText('Plan');
		openMenu('Plan');
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin to sidebar' }));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Note pinned'));
		openMenu('Plan');
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
		expect(await screen.findByRole('alertdialog')).toHaveTextContent('Delete “Plan”?');
		fireEvent.click(screen.getByRole('button', { name: 'Delete note' }));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Note deleted'));
		expect(deleteNoteById).toHaveBeenCalledWith('', 'a');
	});

	it('says why a pin or a delete failed', async () => {
		vi.mocked(searchNotes).mockResolvedValue({ items: [item('a', 'Plan', { is_pinned: true })], total: 1 });
		vi.mocked(toggleNotePinnedStatusById).mockRejectedValue('nope');
		vi.mocked(deleteNoteById).mockRejectedValue('locked');
		open('/notes');
		await screen.findByText('Plan');
		openMenu('Plan');
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Unpin' }));
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith('Couldn’t unpin “Plan”.'.replace('’', "'"), expect.anything())
		);
		openMenu('Plan');
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Delete note' }));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't delete “Plan”.", expect.anything()));
	});

	it('an empty list offers New note and Import, and New note opens the note as new (STA-3, S6-D4)', async () => {
		vi.mocked(searchNotes).mockResolvedValue({ items: [], total: 0 });
		vi.mocked(createNewNote).mockResolvedValue({ id: 'n9' });
		open('/notes');
		expect(await screen.findByText('No notes yet')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Import .md or .txt' })).toBeTruthy();
		const buttons = screen.getAllByRole('button', { name: 'New note' });
		fireEvent.click(buttons[buttons.length - 1]);
		expect(await screen.findByText('note page (fresh)')).toBeTruthy();
		expect(vi.mocked(createNewNote).mock.calls[0][1]).toMatchObject({ title: 'Untitled' });
	});

	it('a failed create says so', async () => {
		vi.mocked(searchNotes).mockResolvedValue({ items: [], total: 0 });
		vi.mocked(createNewNote).mockRejectedValueOnce('nope').mockResolvedValueOnce(null);
		open('/notes');
		await screen.findByText('No notes yet');
		fireEvent.click(screen.getAllByRole('button', { name: 'New note' })[0]);
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't create the note.", expect.anything()));
		fireEvent.click(screen.getAllByRole('button', { name: 'New note' })[0]);
		await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2));
	});

	it('a search that finds nothing says so, and clears', async () => {
		vi.mocked(searchNotes).mockResolvedValue({ items: [], total: 0 });
		open('/notes');
		fireEvent.change(await screen.findByRole('textbox', { name: 'Search notes' }), { target: { value: 'zzz' } });
		expect(await screen.findByText('Nothing matches “zzz”', {}, { timeout: 2000 })).toBeTruthy();
		// The empty state's, not the search box's own clear button.
		fireEvent.click(screen.getAllByRole('button', { name: 'Clear search' }).at(-1) as HTMLElement);
		expect(await screen.findByText('No notes yet', {}, { timeout: 2000 })).toBeTruthy();
	});

	it('imports .md and .txt files, refusing anything else', async () => {
		vi.mocked(searchNotes).mockResolvedValue({ items: [], total: 0 });
		vi.mocked(createNewNote).mockResolvedValue({ id: 'n9' });
		open('/notes');
		await screen.findByText('No notes yet');
		const input = screen.getByLabelText('Import note files');
		fireEvent.change(input, {
			target: { files: [new File(['- [ ] a'], 'plan.md', { type: 'text/markdown' })] }
		});
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Imported 1 note'));
		expect(vi.mocked(createNewNote).mock.calls[0][1]).toMatchObject({ title: 'plan' });
		fireEvent.change(input, { target: { files: [new File(['x'], 'a.pdf', { type: 'application/pdf' })] } });
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith("“a.pdf” is not a .md or .txt file, so it wasn't imported.")
		);
	});
});
