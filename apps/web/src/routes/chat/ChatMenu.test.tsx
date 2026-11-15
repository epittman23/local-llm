import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import saveAs from 'file-saver';
import { MemoryRouter, Route, Routes } from 'react-router';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
	addTagById,
	archiveChatById,
	deleteChatById,
	deleteTagById,
	getAllTags,
	getChatById,
	getPinnedChatList,
	getTagsById,
	toggleChatPinnedStatusById
} from '@/lib/apis/chats';
import { ChatMenu } from './ChatMenu';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('file-saver', () => ({ default: vi.fn() }));
vi.mock('./sidebar/ChatDialogs', () => ({
	ShareChatDialog: ({ open }: { open: boolean }) => (open ? <div role="dialog" aria-label="Share chat" /> : null)
}));
vi.mock('@/lib/apis/chats', () => ({
	addTagById: vi.fn(async () => []),
	archiveChatById: vi.fn(async () => ({})),
	deleteChatById: vi.fn(async () => true),
	deleteTagById: vi.fn(async () => []),
	getAllTags: vi.fn(async () => [{ name: 'statistics' }, { name: 'python' }]),
	getChatById: vi.fn(),
	getPinnedChatList: vi.fn(async () => []),
	getTagsById: vi.fn(async () => [{ name: 'statistics' }]),
	toggleChatPinnedStatusById: vi.fn(async () => ({}))
}));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't' })
}));

const onRename = vi.fn();
const SAVED = {
	id: 'c1',
	chat: {
		title: 'Sample / variance',
		history: {
			currentId: 'a',
			messages: {
				u: { id: 'u', parentId: null, role: 'user', content: 'What is $\\sigma^2$?' },
				a: { id: 'a', parentId: 'u', role: 'assistant', modelName: 'Qwen', content: 'The mean square.' }
			}
		}
	}
};

function show() {
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<MemoryRouter initialEntries={['/c/c1']}>
					<Routes>
						<Route path="/c/:id" element={<ChatMenu chatId="c1" title="Sample / variance" onRename={onRename} />} />
						<Route path="/" element={<p>Home</p>} />
					</Routes>
				</MemoryRouter>
			</TooltipProvider>
		</QueryClientProvider>
	);
}

async function openMenu() {
	fireEvent.pointerDown(screen.getByRole('button', { name: 'Chat menu' }), { button: 0, pointerType: 'mouse' });
	return screen.findByRole('menu');
}

async function openDownload() {
	const menu = await openMenu();
	const sub = within(menu).getByRole('menuitem', { name: 'Download' });
	fireEvent.keyDown(sub, { key: 'ArrowRight' });
	return screen.findByRole('menuitem', { name: 'Markdown (.md)' });
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getChatById).mockResolvedValue(SAVED as never);
});
afterEach(cleanup);

describe('ChatMenu', () => {
	it('offers what the sidebar row does, grouped, Delete last, and not Controls (#928, #1085, OVL-3)', async () => {
		show();
		const menu = await openMenu();
		expect(
			within(menu)
				.getAllByRole('menuitem')
				.map((i) => i.textContent?.trim())
		).toEqual(['Rename', 'Pin', 'Tags…', 'Share', 'Download', 'Archive', 'Delete']);
		expect(within(menu).getByRole('separator')).toBeInTheDocument();
		expect(within(menu).queryByRole('menuitem', { name: 'Controls' })).toBeNull();
	});

	it('Rename asks the page for its title editor once the menu has closed, so the editor keeps focus', async () => {
		show();
		await openMenu();
		fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
		await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
		await waitFor(() => expect(onRename).toHaveBeenCalledTimes(1));
		// Closing it otherwise asks for nothing.
		await openMenu();
		fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
		expect(onRename).toHaveBeenCalledTimes(1);
	});

	it('pins and unpins the chat, as the sidebar does', async () => {
		show();
		await openMenu();
		fireEvent.click(screen.getByRole('menuitem', { name: 'Pin' }));
		await waitFor(() => expect(toggleChatPinnedStatusById).toHaveBeenCalledWith('t', 'c1'));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Chat pinned'));
		cleanup();

		vi.mocked(getPinnedChatList).mockResolvedValue([{ id: 'c1', title: 'Sample / variance' }] as never);
		show();
		const menu = await openMenu();
		await within(menu).findByRole('menuitem', { name: 'Unpin' });
		vi.mocked(toggleChatPinnedStatusById).mockRejectedValueOnce('nope');
		fireEvent.click(within(menu).getByRole('menuitem', { name: 'Unpin' }));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith('nope'));
	});

	it('edits the tags in a dialog, suggesting the ones in use', async () => {
		show();
		await openMenu();
		fireEvent.click(screen.getByRole('menuitem', { name: 'Tags…' }));
		const dialog = await screen.findByRole('dialog', { name: 'Tags' });
		await within(dialog).findByRole('button', { name: /statistics/ });
		expect(getAllTags).toHaveBeenCalledWith('t');
		const field = within(dialog).getByRole('combobox', { name: 'Add a tag' });
		fireEvent.change(field, { target: { value: 'variance' } });
		fireEvent.keyDown(field, { key: 'Enter' });
		await waitFor(() => expect(addTagById).toHaveBeenCalledWith('t', 'c1', 'variance'));
		fireEvent.click(within(dialog).getByRole('button', { name: /statistics/ }));
		await waitFor(() => expect(deleteTagById).toHaveBeenCalledWith('t', 'c1', 'statistics'));
		vi.mocked(addTagById).mockRejectedValueOnce('Tag refused');
		fireEvent.change(field, { target: { value: 'other' } });
		fireEvent.keyDown(field, { key: 'Enter' });
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Tag refused'));
	});

	it('opens Share', async () => {
		show();
		await openMenu();
		fireEvent.click(screen.getByRole('menuitem', { name: 'Share' }));
		expect(await screen.findByRole('dialog', { name: 'Share chat' })).toBeInTheDocument();
	});

	it('downloads Markdown, plain text and JSON, each named after the chat (#1085)', async () => {
		show();
		const md = await openDownload();
		const sub = md.closest('[role="menu"]') as HTMLElement;
		expect(
			within(sub)
				.getAllByRole('menuitem')
				.map((i) => i.textContent)
		).toEqual(['Markdown (.md)', 'Plain text (.txt)', 'JSON (.json)']);
		fireEvent.click(md);
		await waitFor(() => expect(saveAs).toHaveBeenCalledTimes(1));
		const [blob, name] = vi.mocked(saveAs).mock.calls[0] as unknown as [Blob, string];
		expect(name).toBe('chat-Sample _ variance.md');
		expect(blob.type).toBe('text/markdown');
		expect(await blob.text()).toBe(
			'# Sample / variance\n\n## You\n\nWhat is $\\sigma^2$?\n\n## Qwen\n\nThe mean square.\n'
		);

		fireEvent.click(await openDownload().then(() => screen.getByRole('menuitem', { name: 'Plain text (.txt)' })));
		await waitFor(() => expect(saveAs).toHaveBeenCalledTimes(2));
		expect(vi.mocked(saveAs).mock.calls[1][1]).toBe('chat-Sample _ variance.txt');

		fireEvent.click(await openDownload().then(() => screen.getByRole('menuitem', { name: 'JSON (.json)' })));
		await waitFor(() => expect(saveAs).toHaveBeenCalledTimes(3));
		const [json, jsonName] = vi.mocked(saveAs).mock.calls[2] as unknown as [Blob, string];
		expect(jsonName).toBe('chat-Sample _ variance.json');
		expect(JSON.parse(await json.text())).toEqual([SAVED]);
	});

	it('says why a download could not be made', async () => {
		vi.mocked(getChatById).mockRejectedValueOnce('Database is locked');
		show();
		fireEvent.click(await openDownload());
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Database is locked'));
		expect(saveAs).not.toHaveBeenCalled();
	});

	it('archives the chat and leaves it', async () => {
		show();
		await openMenu();
		fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
		await waitFor(() => expect(archiveChatById).toHaveBeenCalledWith('t', 'c1'));
		expect(await screen.findByText('Home')).toBeInTheDocument();
	});

	it('deletes only after a confirmation that names the chat, with a danger button (ACT-3)', async () => {
		show();
		await openMenu();
		fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
		const dialog = await screen.findByRole('alertdialog', { name: 'Delete chat?' });
		expect(dialog.textContent).toContain('This deletes Sample / variance and its messages.');
		const confirm = within(dialog).getByRole('button', { name: 'Delete chat' });
		expect(confirm.getAttribute('data-variant')).toBe('destructive');
		fireEvent.click(confirm);
		await waitFor(() => expect(deleteChatById).toHaveBeenCalledWith('t', 'c1'));
		expect(await screen.findByText('Home')).toBeInTheDocument();
	});

	it('stays on the chat and says why when deleting failed', async () => {
		vi.mocked(deleteChatById).mockRejectedValueOnce('nope');
		show();
		await openMenu();
		fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Delete chat' }));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith('nope'));
		expect(screen.queryByText('Home')).toBeNull();
		expect(getTagsById).not.toHaveBeenCalled();
	});
});
