import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getTagsById, updateChatById } from '@/lib/apis/chats';
import { ChatTitle, RenameChatDialog } from './ChatTitle';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/apis/chats', () => ({
	getTagsById: vi.fn(async () => []),
	updateChatById: vi.fn(async () => ({}))
}));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't' })
}));

const renamed = vi.fn();

function Harness({ title = 'Sample variance' }: { title?: string }) {
	const [editing, setEditing] = useState(false);
	const [shown, setShown] = useState(title);
	return (
		<ChatTitle
			chatId="c1"
			title={shown}
			editing={editing}
			onEditingChange={setEditing}
			onRenamed={(t) => {
				renamed(t);
				setShown(t);
			}}
		/>
	);
}

function show(node = <Harness />) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const invalidate = vi.spyOn(client, 'invalidateQueries');
	render(
		<QueryClientProvider client={client}>
			<TooltipProvider>{node}</TooltipProvider>
		</QueryClientProvider>
	);
	return { invalidate };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getTagsById).mockResolvedValue([]);
});
afterEach(cleanup);

describe('ChatTitle', () => {
	it("shows the chat's title as a button that names what it does, truncated with the whole title (#928, TYP-7)", () => {
		show();
		const button = screen.getByRole('button', { name: 'Chat title: Sample variance. Rename' });
		const text = screen.getByText('Sample variance');
		expect(button).toContainElement(text);
		expect(text.className).toContain('truncate');
		expect(text.getAttribute('title')).toBe('Sample variance');
	});

	it('renames in place: Enter saves, says so, refreshes the lists and returns focus to the title', async () => {
		const { invalidate } = show();
		fireEvent.click(screen.getByRole('button', { name: /^Chat title/ }));
		const field = screen.getByRole('textbox', { name: 'Chat title' });
		expect(document.activeElement).toBe(field);
		expect(field).toHaveValue('Sample variance');
		fireEvent.change(field, { target: { value: '  Population variance ' } });
		fireEvent.keyDown(field, { key: 'Enter' });
		await waitFor(() => expect(updateChatById).toHaveBeenCalledWith('t', 'c1', { title: 'Population variance' }));
		await waitFor(() => expect(renamed).toHaveBeenCalledWith('Population variance'));
		expect(toast.success).toHaveBeenCalledWith('Chat renamed');
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ['chats'] });
		expect(updateChatById).toHaveBeenCalledTimes(1);
		const button = screen.getByRole('button', { name: 'Chat title: Population variance. Rename' });
		expect(document.activeElement).toBe(button);
	});

	it('cancels on Escape without saving, and keeps the title', () => {
		show();
		fireEvent.click(screen.getByRole('button', { name: /^Chat title/ }));
		const field = screen.getByRole('textbox', { name: 'Chat title' });
		fireEvent.change(field, { target: { value: 'Something else' } });
		fireEvent.keyDown(field, { key: 'Escape' });
		fireEvent.blur(field);
		expect(screen.queryByRole('textbox')).toBeNull();
		expect(updateChatById).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Chat title: Sample variance. Rename' }));
	});

	it('saves when the field is left, refuses an empty title, and saves nothing unchanged', async () => {
		show();
		fireEvent.click(screen.getByRole('button', { name: /^Chat title/ }));
		fireEvent.change(screen.getByRole('textbox', { name: 'Chat title' }), { target: { value: '   ' } });
		fireEvent.blur(screen.getByRole('textbox', { name: 'Chat title' }));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith("A chat's title can't be empty"));

		fireEvent.click(screen.getByRole('button', { name: /^Chat title/ }));
		fireEvent.blur(screen.getByRole('textbox', { name: 'Chat title' }));
		await Promise.resolve();
		expect(updateChatById).not.toHaveBeenCalled();
		expect(screen.getByText('Sample variance')).toBeInTheDocument();
	});

	it('says why a rename failed and keeps the old title', async () => {
		vi.mocked(updateChatById).mockRejectedValueOnce('Database is locked');
		show();
		fireEvent.click(screen.getByRole('button', { name: /^Chat title/ }));
		fireEvent.change(screen.getByRole('textbox', { name: 'Chat title' }), { target: { value: 'New' } });
		fireEvent.keyDown(screen.getByRole('textbox', { name: 'Chat title' }), { key: 'Enter' });
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Database is locked'));
		expect(renamed).not.toHaveBeenCalled();
		expect(screen.getByText('Sample variance')).toBeInTheDocument();
	});

	it('follows the title with up to three tags and "+N" for the rest', async () => {
		vi.mocked(getTagsById).mockResolvedValue([
			{ name: 'statistics' },
			{ name: 'python' },
			{ name: 'variance' },
			{ name: 'estimators' },
			{ name: 'homework' }
		]);
		show();
		const list = await screen.findByRole('list', { name: 'Tags' });
		expect([...list.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
			'statistics',
			'python',
			'variance',
			'+2'
		]);
		expect(screen.getByLabelText('2 more: estimators, homework').getAttribute('title')).toBe('estimators, homework');
		expect(getTagsById).toHaveBeenCalledWith('t', 'c1');
	});

	it('shows no tag list when the chat has none, or the answer is not a list', async () => {
		vi.mocked(getTagsById).mockResolvedValue({ detail: 'nope' } as never);
		show();
		await waitFor(() => expect(getTagsById).toHaveBeenCalled());
		expect(screen.queryByRole('list', { name: 'Tags' })).toBeNull();
	});
});

function DialogHarness() {
	const [open, setOpen] = useState(true);
	return (
		<RenameChatDialog chatId="c1" title="Sample variance" open={open} onOpenChange={setOpen} onRenamed={renamed} />
	);
}

describe('RenameChatDialog (a phone)', () => {
	it('renames from a short form and closes once saved', async () => {
		show(<DialogHarness />);
		expect(screen.getByRole('dialog', { name: 'Rename chat' })).toBeInTheDocument();
		const field = screen.getByRole('textbox', { name: 'Chat title' });
		expect(field).toHaveValue('Sample variance');
		fireEvent.change(field, { target: { value: 'Population variance' } });
		fireEvent.click(screen.getByRole('button', { name: 'Rename chat' }));
		await waitFor(() => expect(renamed).toHaveBeenCalledWith('Population variance'));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	});

	it('stays open when the title is empty, and Cancel closes it without saving', async () => {
		show(<DialogHarness />);
		fireEvent.change(screen.getByRole('textbox', { name: 'Chat title' }), { target: { value: '' } });
		fireEvent.click(screen.getByRole('button', { name: 'Rename chat' }));
		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		expect(screen.getByRole('dialog')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(updateChatById).not.toHaveBeenCalled();
	});
});
