import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import DataControls from './DataControls';

const api = vi.hoisted(() => ({
	archiveAllChats: vi.fn(),
	deleteAllChats: vi.fn(),
	deleteSharedChatById: vi.fn(),
	getAllChats: vi.fn(),
	getSharedChatList: vi.fn(),
	importChats: vi.fn()
}));
vi.mock('@/lib/apis/chats', () => api);
const clip = vi.hoisted(() => vi.fn());
vi.mock('@/lib/utils', async (orig) => ({ ...(await orig<object>()), copyToClipboard: clip }));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

function mount() {
	return render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<MemoryRouter>
				<TooltipProvider>
					<DataControls />
				</TooltipProvider>
			</MemoryRouter>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	clip.mockReset();
	toast.success.mockReset();
});
afterEach(cleanup);

describe('Shared chats manager (#1006)', () => {
	it('lists each shared chat with its link, Copy link and Stop sharing', async () => {
		api.getSharedChatList.mockResolvedValue([
			{ id: 'c1', title: 'Explaining the central limit theorem', share_id: 's1', updated_at: 1_700_000_000 }
		]);
		api.deleteSharedChatById.mockResolvedValue(true);
		clip.mockResolvedValue(true);
		mount();
		fireEvent.click(screen.getByRole('button', { name: 'Manage shared chats' }));
		const dialog = await screen.findByRole('dialog', { name: 'Shared chats' });
		const link = await within(dialog).findByRole('link', { name: 'Explaining the central limit theorem' });
		expect(link).toHaveAttribute('href', '/s/s1');
		// A page shorter than 60 rows is the last: it was asked for once.
		expect(api.getSharedChatList).toHaveBeenCalledTimes(1);
		fireEvent.click(within(dialog).getByRole('button', { name: 'Copy link to Explaining the central limit theorem' }));
		await waitFor(() => expect(clip).toHaveBeenCalledWith(`${window.location.origin}/s/s1`));
		expect(toast.success).toHaveBeenCalledWith('Link copied');
		fireEvent.click(within(dialog).getByRole('button', { name: 'Stop sharing Explaining the central limit theorem' }));
		await waitFor(() => expect(api.deleteSharedChatById).toHaveBeenCalledWith('', 'c1'));
	});

	it('says how to share when nothing is shared', async () => {
		api.getSharedChatList.mockResolvedValue([]);
		mount();
		fireEvent.click(screen.getByRole('button', { name: 'Manage shared chats' }));
		expect(await screen.findByText(/No shared chats\. Share a chat from its menu/)).toBeInTheDocument();
	});
});
