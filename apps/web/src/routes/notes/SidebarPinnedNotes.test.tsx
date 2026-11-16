import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPinnedNoteList } from '@/lib/apis/notes';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { SidebarPinnedNotes } from './SidebarPinnedNotes';

vi.mock('@/lib/apis/notes', () => ({ getPinnedNoteList: vi.fn() }));

const mount = (onNavigate = vi.fn()) => {
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<MemoryRouter initialEntries={['/notes/b']}>
				<SidebarPinnedNotes onNavigate={onNavigate} />
			</MemoryRouter>
		</QueryClientProvider>
	);
	return onNavigate;
};

beforeEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({ token: 't', user: { id: 'u', role: 'user', permissions: {} } } as never);
	useConfigStore.setState({ config: { features: { enable_notes: true } } } as never);
});

describe('the sidebar’s Pinned notes (#963)', () => {
	it('links each pinned note, marking the open one', async () => {
		vi.mocked(getPinnedNoteList).mockResolvedValue([
			{ id: 'a', title: 'Plan' },
			{ id: 'b', title: '' }
		]);
		const onNavigate = mount();
		const plan = await screen.findByRole('link', { name: 'Plan' });
		expect(plan).toHaveAttribute('href', '/notes/a');
		expect(screen.getByRole('link', { name: 'Untitled' })).toHaveAttribute('aria-current', 'page');
		expect(screen.getByRole('region', { name: 'Pinned notes' })).toBeTruthy();
		fireEvent.click(plan);
		expect(onNavigate).toHaveBeenCalled();
	});

	it('shows nothing with no pinned note', async () => {
		vi.mocked(getPinnedNoteList).mockResolvedValue([]);
		mount();
		await waitFor(() => expect(getPinnedNoteList).toHaveBeenCalled());
		expect(screen.queryByRole('region', { name: 'Pinned notes' })).toBeNull();
	});

	it('asks for nothing while notes are off', () => {
		useConfigStore.setState({ config: { features: { enable_notes: false } } } as never);
		mount();
		expect(getPinnedNoteList).not.toHaveBeenCalled();
		expect(screen.queryByText('Pinned notes')).toBeNull();
	});

	it('says in place when the pins could not load, and tries again (STA-4)', async () => {
		vi.mocked(getPinnedNoteList)
			.mockRejectedValueOnce('down')
			.mockResolvedValueOnce([{ id: 'a', title: 'Plan' }]);
		mount();
		expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load pinned notes.");
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByRole('link', { name: 'Plan' })).toBeTruthy();
	});
});
