import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getChatList, getChatListByFolderId, getPinnedChatList } from '@/lib/apis/chats';
import { getFolders } from '@/lib/apis/folders';
import { ChatSidebar } from './ChatSidebar';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/apis/chats', () => ({
	getChatList: vi.fn(),
	getPinnedChatList: vi.fn(),
	getChatListByFolderId: vi.fn(),
	updateChatById: vi.fn(),
	getChatById: vi.fn(),
	cloneChatById: vi.fn(),
	cloneSharedChatById: vi.fn(),
	deleteChatById: vi.fn(),
	archiveChatById: vi.fn(),
	toggleChatPinnedStatusById: vi.fn(),
	updateChatFolderIdById: vi.fn(),
	getChatListBySearchText: vi.fn(async () => [])
}));
vi.mock('@/lib/apis/folders', () => ({
	getFolders: vi.fn(),
	createNewFolder: vi.fn(),
	deleteFolderById: vi.fn(),
	markFolderChatsReadById: vi.fn(),
	updateFolderById: vi.fn(),
	updateFolderIsExpandedById: vi.fn(async () => undefined)
}));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'u1' } })
}));

function show() {
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<MemoryRouter>
					<ChatSidebar />
				</MemoryRouter>
			</TooltipProvider>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	vi.mocked(getPinnedChatList).mockResolvedValue([]);
	vi.mocked(getFolders).mockResolvedValue([]);
	vi.mocked(getChatList).mockImplementation(async (_t, page) =>
		page === 1 ? ([{ id: 'c1', title: 'Fresh chat', updated_at: 50 }] as never) : ([] as never)
	);
	vi.mocked(getChatListByFolderId).mockResolvedValue([]);
});
afterEach(cleanup);

describe('ChatSidebar chat list', () => {
	it('shows a chat that was never read with an Unread marker', async () => {
		show();
		const link = await screen.findByRole('link', { name: /Fresh chat/ });
		expect(link.querySelector('[aria-label="Unread"]')).toBeTruthy();
	});

	it('shows no marker on a chat read after its last update', async () => {
		vi.mocked(getChatList).mockImplementation(
			async () => [{ id: 'c1', title: 'Old chat', updated_at: 50, last_read_at: 60 }] as never
		);
		show();
		const link = await screen.findByRole('link', { name: /Old chat/ });
		expect(link.querySelector('[aria-label="Unread"]')).toBeNull();
	});
});

describe('ChatSidebar folders', () => {
	it('loads more of an open folder with "Show more"', async () => {
		vi.mocked(getFolders).mockResolvedValue([{ id: 'f1', name: 'Work', parent_id: null }] as never);
		vi.mocked(getChatListByFolderId).mockImplementation(async (_t, _f, page) =>
			page === 1 ? ([{ id: 'w1', title: 'Work chat 1', last_read_at: 99 }] as never) : ([] as never)
		);
		show();
		fireEvent.click(await screen.findByRole('button', { name: 'Expand Work' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));
		await waitFor(() => expect(getChatListByFolderId).toHaveBeenCalledWith('t', 'f1', 2));
		await waitFor(() => expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull());
	});
});
