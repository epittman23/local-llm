// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNewNote, searchNotes } from '@/lib/apis/notes';
import { NewNotePage, NotesPage } from './NotesPage';

// #210: a `?title=` link whose create failed left the page on its spinner,
// with nothing to say why.

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/routes/common/FeatureGate', () => ({ FeatureGate: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/lib/apis/notes', () => ({
	createNewNote: vi.fn(),
	searchNotes: vi.fn(async () => ({ items: [], total: 0 })),
	deleteNoteById: vi.fn(),
	getNoteById: vi.fn(),
	toggleNotePinnedStatusById: vi.fn()
}));

const open = (entry: string) => {
	const router = createMemoryRouter(
		[
			{ path: '/notes', element: <NotesPage /> },
			{ path: '/notes/new', element: <NewNotePage /> },
			{ path: '/notes/:id', element: <p>note page</p> }
		],
		{ initialEntries: [entry] }
	);
	render(
		<QueryClientProvider client={new QueryClient()}>
			<RouterProvider router={router} />
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
			expect(await screen.findByText('note page')).toBeTruthy();
			expect(router.state.location.pathname).toBe('/notes/n1');
			expect(toast.error).not.toHaveBeenCalled();
		});
	}
});
