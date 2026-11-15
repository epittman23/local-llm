import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getChatList, getChatListByFolderId, getPinnedChatList } from '@/lib/apis/chats';
import { createNewFolder, deleteFolderById, getFolders, updateFolderById } from '@/lib/apis/folders';
import type { SessionUser } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { ChatSidebar } from './ChatSidebar';
import { CHAT_PAGE_SIZE } from './useChatList';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const menuOf = async (name: string) =>
	fireEvent.pointerDown(await screen.findByRole('button', { name }), {
		button: 0,
		ctrlKey: false,
		pointerType: 'mouse'
	});
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
const auth = vi.hoisted(() => ({ user: { id: 'u1' } as Partial<SessionUser> }));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: auth.user })
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
	auth.user = { id: 'u1', role: 'user' };
	useConfigStore.setState({ config: { name: 'local-llm', version: '1', features: { enable_folders: true } } });
	vi.mocked(getFolders).mockClear();
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

const workChats = (n: number, from = 0) =>
	Array.from({ length: n }, (_, i) => ({ id: `w${from + i}`, title: `Work chat ${from + i}`, last_read_at: 99 }));

describe('ChatSidebar empty and failed', () => {
	it('says what will appear when there are no chats and no folders (#1092, STA-3)', async () => {
		vi.mocked(getChatList).mockResolvedValue([] as never);
		show();
		expect(await screen.findByText('Your chats will appear here.')).toBeInTheDocument();
		expect(screen.getByText('Group chats and give them shared instructions.')).toBeInTheDocument();
	});

	it('does not say chats will appear above folders, which hold chats the list leaves out (STA-3)', async () => {
		vi.mocked(getChatList).mockResolvedValue([] as never);
		vi.mocked(getFolders).mockResolvedValue([{ id: 'f1', name: 'Work', parent_id: null }] as never);
		show();
		expect(await screen.findByText('Chats outside folders appear here.')).toBeInTheDocument();
		expect(screen.queryByText('Your chats will appear here.')).toBeNull();
	});

	it('says nothing about an empty list while the folders are still loading', async () => {
		vi.mocked(getChatList).mockResolvedValue([] as never);
		vi.mocked(getFolders).mockImplementation(() => new Promise(() => {}));
		show();
		expect(await screen.findByRole('button', { name: 'Folders' })).toBeInTheDocument();
		await waitFor(() => expect(getChatList).toHaveBeenCalled());
		await new Promise((r) => setTimeout(r, 20));
		expect(screen.queryByText(/appear here/)).toBeNull();
	});

	it('shows a failed load in place with Try again, not an empty list (STA-4)', async () => {
		vi.mocked(getChatList)
			.mockRejectedValueOnce('Database is locked')
			.mockResolvedValue([] as never);
		show();
		expect(await screen.findByText("Couldn't load chats")).toBeInTheDocument();
		expect(screen.queryByText('Your chats will appear here.')).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByText('Your chats will appear here.')).toBeInTheDocument();
	});

	it('shows a failed folder in place with Try again', async () => {
		vi.mocked(getFolders).mockResolvedValue([{ id: 'f1', name: 'Work', parent_id: null }] as never);
		vi.mocked(getChatListByFolderId)
			.mockRejectedValueOnce('nope')
			.mockResolvedValue(workChats(1) as never);
		show();
		fireEvent.click(await screen.findByRole('button', { name: 'Expand Work' }));
		expect(await screen.findByText("Couldn't load this folder's chats.")).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByRole('link', { name: /Work chat 0/ })).toBeInTheDocument();
	});
});

describe('ChatSidebar when part of it fails or folders are off', () => {
	it('keeps the chats when the folders are refused, saying so under Folders (403)', async () => {
		vi.mocked(getFolders).mockRejectedValue('You do not have permission to access this resource.');
		show();
		expect(await screen.findByText("Couldn't load folders.")).toBeInTheDocument();
		expect(screen.getByRole('link', { name: /Fresh chat/ })).toBeInTheDocument();
		expect(screen.queryByText("Couldn't load chats")).toBeNull();
	});

	it('keeps the chats when the pinned chats fail, saying so under Pinned', async () => {
		let fail = true;
		vi.mocked(getPinnedChatList).mockImplementation(async () => {
			if (fail) throw 'nope';
			return [{ id: 'p1', title: 'Pinned one' }] as never;
		});
		show();
		expect(await screen.findByText("Couldn't load pinned chats.")).toBeInTheDocument();
		expect(await screen.findByRole('link', { name: /Fresh chat/ })).toBeInTheDocument();
		fail = false;
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByRole('link', { name: /Pinned one/ })).toBeInTheDocument();
	});

	it('hides Folders and asks for none while the server has folders off', async () => {
		useConfigStore.setState({ config: { name: 'local-llm', version: '1', features: { enable_folders: false } } });
		show();
		expect(await screen.findByRole('link', { name: /Fresh chat/ })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Folders' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'New folder' })).toBeNull();
		expect(getFolders).not.toHaveBeenCalled();
	});

	it('hides Folders from an account denied them, but not from an admin', async () => {
		auth.user = { id: 'u1', role: 'user', permissions: { features: { folders: false } } as never };
		show();
		expect(await screen.findByRole('link', { name: /Fresh chat/ })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Folders' })).toBeNull();
		expect(getFolders).not.toHaveBeenCalled();
		cleanup();
		auth.user = { id: 'u1', role: 'admin', permissions: { features: { folders: false } } as never };
		show();
		expect(await screen.findByRole('button', { name: 'Folders' })).toBeInTheDocument();
		await waitFor(() => expect(getFolders).toHaveBeenCalled());
	});

	it('keeps the loaded chats when a further page fails, and tries that page again below them', async () => {
		vi.stubGlobal(
			'IntersectionObserver',
			class {
				constructor(private cb: (e: { isIntersecting: boolean }[]) => void) {}
				observe() {
					this.cb([{ isIntersecting: true }]);
				}
				disconnect() {}
			}
		);
		const full = Array.from({ length: CHAT_PAGE_SIZE }, (_, i) => ({
			id: `c${i}`,
			title: `Chat ${i}`,
			updated_at: 50
		}));
		vi.mocked(getChatList).mockImplementation(async (_t, page) => {
			if (page === 1) return full as never;
			throw 'Database is locked';
		});
		show();
		expect(await screen.findByText("Couldn't load more chats.")).toBeInTheDocument();
		expect(screen.getByRole('link', { name: /Chat 0/ })).toBeInTheDocument();
		expect(screen.queryByText("Couldn't load chats")).toBeNull();
		vi.mocked(getChatList).mockImplementation(async (_t, page) =>
			page === 1 ? (full as never) : ([{ id: 'late', title: 'Late chat', updated_at: 50 }] as never)
		);
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByRole('link', { name: /Late chat/ })).toBeInTheDocument();
		expect(screen.getByRole('link', { name: /Chat 59/ })).toBeInTheDocument();
		vi.unstubAllGlobals();
	});
});

describe('ChatSidebar folders', () => {
	it('offers no "Show more" under a folder whose first page is short (#1070)', async () => {
		vi.mocked(getFolders).mockResolvedValue([{ id: 'f1', name: 'Work', parent_id: null }] as never);
		vi.mocked(getChatListByFolderId).mockResolvedValue(workChats(1) as never);
		show();
		fireEvent.click(await screen.findByRole('button', { name: 'Expand Work' }));
		expect(await screen.findByRole('link', { name: /Work chat 0/ })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
	});

	it('says an empty folder is empty, and says nothing under one that holds only folders', async () => {
		vi.mocked(getFolders).mockResolvedValue([
			{ id: 'f1', name: 'Work', parent_id: null, is_expanded: true },
			{ id: 'f2', name: 'Sub', parent_id: 'f1' }
		] as never);
		show();
		fireEvent.click(await screen.findByRole('button', { name: 'Expand Sub' }));
		await waitFor(() => expect(screen.getAllByText('No chats yet. Move one here from its menu.')).toHaveLength(1));
	});

	it('names the folder menu after what each item does, Delete last (#1071, ACT-2, ACT-3)', async () => {
		vi.mocked(getFolders).mockResolvedValue([{ id: 'f1', name: 'Work', parent_id: null }] as never);
		show();
		expect(await screen.findByRole('button', { name: 'New folder' })).toBeInTheDocument();
		fireEvent.pointerDown(await screen.findByRole('button', { name: 'Folder menu: Work' }), {
			button: 0,
			ctrlKey: false,
			pointerType: 'mouse'
		});
		const items = await screen.findAllByRole('menuitem');
		expect(items.map((i) => i.textContent?.trim())).toEqual([
			'New subfolder',
			'Mark all as read',
			'Edit folder',
			'Delete folder'
		]);
		expect(screen.getByRole('menu').className).toContain('w-52');
	});

	it('loads more of an open folder with "Show more" when a page is full', async () => {
		vi.mocked(getFolders).mockResolvedValue([{ id: 'f1', name: 'Work', parent_id: null }] as never);
		vi.mocked(getChatListByFolderId).mockImplementation(async (_t, _f, page) =>
			page === 1 ? (workChats(10) as never) : (workChats(1, 10) as never)
		);
		show();
		fireEvent.click(await screen.findByRole('button', { name: 'Expand Work' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));
		await waitFor(() => expect(getChatListByFolderId).toHaveBeenCalledWith('t', 'f1', 2));
		expect(await screen.findByRole('link', { name: /Work chat 10/ })).toBeInTheDocument();
		await waitFor(() => expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull());
	});
});

describe('ChatSidebar folder actions', () => {
	beforeEach(() => vi.mocked(toast.success).mockClear());

	it('creates a folder and says "Folder created" (ACT-2)', async () => {
		vi.mocked(createNewFolder).mockResolvedValue({ id: 'f9' } as never);
		show();
		fireEvent.click(await screen.findByRole('button', { name: 'New folder' }));
		fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Travel' } });
		fireEvent.click(screen.getByRole('button', { name: 'Create folder' }));
		await waitFor(() =>
			expect(createNewFolder).toHaveBeenCalledWith('t', { name: 'Travel', data: undefined, parent_id: null })
		);
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Folder created'));
	});

	it('edits a folder from its menu and says "Folder updated"', async () => {
		vi.mocked(getFolders).mockResolvedValue([{ id: 'f1', name: 'Work', parent_id: null }] as never);
		vi.mocked(updateFolderById).mockResolvedValue({ id: 'f1' } as never);
		show();
		await menuOf('Folder menu: Work');
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit folder' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Save folder' }));
		await waitFor(() => expect(updateFolderById).toHaveBeenCalled());
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Folder updated'));
	});

	it('deletes a folder from its menu and says "Folder deleted"', async () => {
		vi.mocked(getFolders).mockResolvedValue([{ id: 'f1', name: 'Work', parent_id: null }] as never);
		vi.mocked(deleteFolderById).mockResolvedValue(true as never);
		show();
		await menuOf('Folder menu: Work');
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete folder' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
		await waitFor(() => expect(deleteFolderById).toHaveBeenCalledWith('t', 'f1', false));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Folder deleted'));
	});
});
