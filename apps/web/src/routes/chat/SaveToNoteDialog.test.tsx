import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNewNote, getNoteById, searchNotes, updateNoteById } from '@/lib/apis/notes';
import { useAuthStore } from '@/lib/stores/authStore';
import { SaveToNoteDialog } from './SaveToNoteDialog';

vi.mock('@/lib/apis/notes', () => ({
	createNewNote: vi.fn(),
	getNoteById: vi.fn(),
	updateNoteById: vi.fn(async () => ({})),
	searchNotes: vi.fn(async () => ({ items: [] }))
}));
const toast = vi.hoisted(() => ({ error: vi.fn(() => 'id'), success: vi.fn(), warning: vi.fn(), dismiss: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const REPLY = 'Use `sum()`:\n\n```py\nsum([1, 2])\n```\n\n$e^{i\\pi}$';
const Where = () => <div data-testid="where">{useLocation().pathname}</div>;
const onOpenChange = vi.fn();

function show() {
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<MemoryRouter>
				<Where />
				<SaveToNoteDialog open onOpenChange={onOpenChange} markdown={REPLY} chatTitle="Sums" />
			</MemoryRouter>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	useAuthStore.setState({ token: 't', user: { id: 'u', role: 'admin' } } as never);
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe('the Save to note dialog (#1135)', () => {
	it('starts on a new note titled after the chat, and saves the reply as Markdown and HTML', async () => {
		vi.mocked(createNewNote).mockResolvedValue({ id: 'n7' });
		show();
		expect(screen.getByRole('heading', { name: 'Save to note' })).toBeTruthy();
		const title = screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement;
		expect(title.value).toBe('Sums');
		fireEvent.change(title, { target: { value: 'My sums' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(createNewNote).toHaveBeenCalledTimes(1));
		const body = vi.mocked(createNewNote).mock.calls[0][1] as {
			title: string;
			data: { content: { md: string; html: string; json: unknown } };
		};
		expect(body.title).toBe('My sums');
		expect(body.data.content.md).toBe(REPLY);
		expect(body.data.content.html).toContain('sum([1, 2])');
		expect(body.data.content.json).toBeNull();
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(toast.success).toHaveBeenCalledWith(
			'Saved to "My sums"',
			expect.objectContaining({ action: expect.objectContaining({ label: 'Open' }) })
		);
	});

	it('Open in the toast goes to the note', async () => {
		vi.mocked(createNewNote).mockResolvedValue({ id: 'n7' });
		show();
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(toast.success).toHaveBeenCalled());
		const options = (toast.success.mock.calls[0] as unknown as [string, { action: { onClick: () => void } }])[1];
		options.action.onClick();
		await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/notes/n7'));
	});

	it('adds to a note chosen from the searchable list, after what it holds', async () => {
		vi.mocked(searchNotes).mockImplementation(async (_t, q) => ({
			items: [
				{ id: 'a', title: 'Alpha' },
				{ id: 'b', title: 'Beta' }
			].filter((n) => !q || n.title.toLowerCase().includes(String(q)))
		}));
		vi.mocked(getNoteById).mockResolvedValue({
			id: 'b',
			title: 'Beta',
			data: { content: { md: 'Existing', html: '<p>Existing</p>', json: null } }
		});
		show();
		fireEvent.click(screen.getByRole('radio', { name: 'Add to an existing note' }));
		expect(await screen.findByRole('option', { name: 'Alpha' })).toBeTruthy();
		fireEvent.change(screen.getByRole('textbox', { name: 'Search notes' }), { target: { value: 'bet' } });
		await waitFor(() => expect(screen.queryByRole('option', { name: 'Alpha' })).toBeNull());
		fireEvent.click(await screen.findByRole('option', { name: 'Beta' }));
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(updateNoteById).toHaveBeenCalledTimes(1));
		const [, id, body] = vi.mocked(updateNoteById).mock.calls[0];
		expect(id).toBe('b');
		expect((body.data as { content: { md: string } }).content.md).toBe(`Existing\n\n${REPLY}`);
		expect(createNewNote).not.toHaveBeenCalled();
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Saved to "Beta"', expect.anything()));
	});

	it('lists only notes the user may write, and says so when a chosen one turns out read only (FBK-4)', async () => {
		vi.mocked(searchNotes).mockResolvedValue({ items: [{ id: 'a', title: 'Alpha' }] });
		vi.mocked(getNoteById).mockResolvedValue({ id: 'a', title: 'Alpha', write_access: false, data: { content: {} } });
		show();
		fireEvent.click(screen.getByRole('radio', { name: 'Add to an existing note' }));
		fireEvent.click(await screen.findByRole('option', { name: 'Alpha' }));
		expect(vi.mocked(searchNotes).mock.calls[0].slice(2, 4)).toEqual([null, 'write']);
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('you can only read it')));
		expect(updateNoteById).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
	});

	it('does not save until a note is chosen', async () => {
		vi.mocked(searchNotes).mockResolvedValue({ items: [{ id: 'a', title: 'Alpha' }] });
		show();
		fireEvent.click(screen.getByRole('radio', { name: 'Add to an existing note' }));
		await screen.findByRole('option', { name: 'Alpha' });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(updateNoteById).not.toHaveBeenCalled();
		expect(createNewNote).not.toHaveBeenCalled();
	});

	it('says why a save failed, with the server words behind Details, and keeps the dialog open (FBK-4)', async () => {
		vi.mocked(createNewNote).mockRejectedValue('Database is locked');
		show();
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith("Couldn't save the reply to the note. Try again.", expect.anything())
		);
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
		expect(toast.success).not.toHaveBeenCalled();
	});

	it('Cancel closes it without saving', () => {
		show();
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(createNewNote).not.toHaveBeenCalled();
	});
});
