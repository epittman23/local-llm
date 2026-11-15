import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	archiveChatById,
	getPinnedChatList,
	toggleChatPinnedStatusById,
	updateChatFolderIdById
} from '@/lib/apis/chats';
import type { ChatListItem } from '@/lib/chat/chatList';
import { ChatItem } from './ChatItem';
import { CHAT_PAGE_SIZE, FOLDER_PAGE_SIZE, nextPage } from './useChatList';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/apis/chats', () => ({
	archiveChatById: vi.fn(async () => ({})),
	cloneChatById: vi.fn(),
	deleteChatById: vi.fn(),
	getChatById: vi.fn(),
	getPinnedChatList: vi.fn(),
	markChatUnreadById: vi.fn(),
	toggleChatPinnedStatusById: vi.fn(async () => ({})),
	updateChatById: vi.fn(),
	updateChatFolderIdById: vi.fn(async () => ({}))
}));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'u1' } })
}));

const LONG = 'A very long title about comparing the bias and variance of three estimators';

function show(chat: Partial<ChatListItem> = {}, folderId?: string) {
	const item = { id: 'c1', title: LONG, updated_at: 50, last_read_at: 60, ...chat } as ChatListItem;
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<MemoryRouter>
				<ChatItem chat={item} folders={[{ id: 'f1', name: 'Work' } as never]} folderId={folderId} />
			</MemoryRouter>
		</QueryClientProvider>
	);
}

async function openMenu() {
	fireEvent.pointerDown(screen.getByRole('button', { name: /^Chat menu:/ }), {
		button: 0,
		ctrlKey: false,
		pointerType: 'mouse'
	});
	return screen.findByRole('menu');
}

/** The Undo action of the last success toast. */
function undoOfLastToast() {
	const calls = vi.mocked(toast.success).mock.calls;
	const options = calls.at(-1)?.[1] as { action?: { label: string; onClick: () => void } } | undefined;
	return options?.action;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getPinnedChatList).mockResolvedValue([]);
});
afterEach(cleanup);

describe('ChatItem row', () => {
	it('truncates the title and keeps the whole of it in a tooltip (#904, TYP-7)', () => {
		show();
		const title = screen.getByText(LONG);
		expect(title.className).toContain('truncate');
		expect(title.getAttribute('title')).toBe(LONG);
	});

	it('keeps its menu button inside the row, shown on focus and always on touch (A11Y-4)', () => {
		show();
		const row = screen.getByTestId('chat-item');
		const button = screen.getByRole('button', { name: `Chat menu: ${LONG}` });
		expect(row.contains(button)).toBe(true);
		expect(row.className).toContain('min-w-0');
		expect(button.className).toContain('group-focus-within:opacity-100');
		expect(button.className).toContain('pointer-coarse:opacity-100');
		// Transparent rather than removed, so focus can come back to it when its menu closes (NAV-4).
		expect(button.className).not.toMatch(/(^|\s)hidden(\s|$)/);
	});
});

describe('ChatItem pin', () => {
	it('offers Pin on a chat that is not pinned, and says so when done (#948, FBK-3)', async () => {
		show();
		await openMenu();
		fireEvent.click(screen.getByRole('menuitem', { name: 'Pin' }));
		await waitFor(() => expect(toggleChatPinnedStatusById).toHaveBeenCalledWith('t', 'c1'));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Chat pinned'));
	});

	it('offers Unpin on a chat in the pinned list, which the list items do not say (#948)', async () => {
		vi.mocked(getPinnedChatList).mockResolvedValue([{ id: 'c1', title: LONG }] as never);
		show();
		await waitFor(() => expect(getPinnedChatList).toHaveBeenCalled());
		await openMenu();
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Unpin' }));
		expect(screen.queryByRole('menuitem', { name: 'Pin' })).toBeNull();
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Chat unpinned'));
	});
});

describe('ChatItem archive', () => {
	it('archives with Undo on the toast, and Undo unarchives (#1002, ACT-3)', async () => {
		show();
		await openMenu();
		fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
		await waitFor(() => expect(undoOfLastToast()?.label).toBe('Undo'));
		expect(vi.mocked(toast.success).mock.calls.at(-1)?.[0]).toBe('Chat archived');
		undoOfLastToast()?.onClick();
		await waitFor(() => expect(archiveChatById).toHaveBeenCalledTimes(2));
		expect(updateChatFolderIdById).not.toHaveBeenCalled();
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Chat restored'));
	});

	it('puts a chat that was in a folder back in it, and pins it again if it was pinned', async () => {
		vi.mocked(getPinnedChatList).mockResolvedValue([{ id: 'c1', title: LONG }] as never);
		show({ folder_id: 'f1' });
		await waitFor(() => expect(getPinnedChatList).toHaveBeenCalled());
		await openMenu();
		await screen.findByRole('menuitem', { name: 'Unpin' });
		fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
		await waitFor(() => expect(undoOfLastToast()?.label).toBe('Undo'));
		undoOfLastToast()?.onClick();
		// Moving it back into the folder unarchives it on the server, so archive is not toggled again.
		await waitFor(() => expect(updateChatFolderIdById).toHaveBeenCalledWith('t', 'c1', 'f1'));
		await waitFor(() => expect(toggleChatPinnedStatusById).toHaveBeenCalledWith('t', 'c1'));
		expect(archiveChatById).toHaveBeenCalledTimes(1);
	});

	it("files a chat back into the folder whose list showed it, which the folder's list items do not say", async () => {
		show({}, 'f1');
		await openMenu();
		fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
		await waitFor(() => expect(undoOfLastToast()?.label).toBe('Undo'));
		undoOfLastToast()?.onClick();
		await waitFor(() => expect(updateChatFolderIdById).toHaveBeenCalledWith('t', 'c1', 'f1'));
		expect(toggleChatPinnedStatusById).not.toHaveBeenCalled();
	});

	it('moves a chat out of the folder whose list showed it', async () => {
		show({}, 'f1');
		await openMenu();
		fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Move' }), { key: 'ArrowRight' });
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Out of the folder' }));
		await waitFor(() => expect(updateChatFolderIdById).toHaveBeenCalledWith('t', 'c1', undefined));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Chat moved'));
	});

	it('offers no Undo when archiving failed', async () => {
		vi.mocked(archiveChatById).mockRejectedValueOnce('nope');
		show();
		await openMenu();
		fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith('nope'));
		expect(toast.success).not.toHaveBeenCalled();
	});
});

describe('nextPage (#1070)', () => {
	it('asks for another page only after a full one', () => {
		expect(nextPage(FOLDER_PAGE_SIZE)(new Array(10), [new Array(10)])).toBe(2);
		expect(nextPage(FOLDER_PAGE_SIZE)(new Array(3), [new Array(10), new Array(3)])).toBeUndefined();
		expect(nextPage(CHAT_PAGE_SIZE)(new Array(60), [new Array(60)])).toBe(2);
		expect(nextPage(CHAT_PAGE_SIZE)([], [[]])).toBeUndefined();
	});
});
