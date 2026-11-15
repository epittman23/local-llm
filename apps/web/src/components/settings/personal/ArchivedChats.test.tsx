import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ChatTime } from '../controls';
import ArchivedChats, { ARCHIVED_PAGE_SIZE } from './ArchivedChats';

const api = vi.hoisted(() => ({
	getArchivedChatList: vi.fn(),
	archiveChatById: vi.fn(),
	deleteChatById: vi.fn(),
	getAllArchivedChats: vi.fn(),
	unarchiveAllChats: vi.fn()
}));
vi.mock('@/lib/apis/chats', () => api);
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const now = Math.floor(Date.now() / 1000);
const row = (i: number) => ({ id: `c${i}`, title: `Monte Carlo integration ${i}`, updated_at: now - 60 });

function mount() {
	return render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<MemoryRouter>
				<TooltipProvider>
					<ArchivedChats />
				</TooltipProvider>
			</MemoryRouter>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	api.archiveChatById.mockResolvedValue({});
	api.deleteChatById.mockResolvedValue(true);
});
afterEach(cleanup);

describe('Archived chats (#954)', () => {
	it('gives the title the free width, with its full text, a date and an Open action', async () => {
		api.getArchivedChatList.mockResolvedValue([row(1)]);
		mount();
		const title = await screen.findByTitle('Monte Carlo integration 1');
		const table = screen.getByRole('region', { name: 'Archived chats' });
		expect(title.tagName).toBe('TD');
		expect(title).toHaveClass('w-full');
		expect(title).toHaveAttribute('title', 'Monte Carlo integration 1');
		expect(within(table).getByRole('columnheader', { name: 'Title' })).toHaveAttribute('scope', 'col');
		expect(within(table).getByRole('link', { name: 'Open Monte Carlo integration 1' })).toHaveAttribute(
			'href',
			'/c/c1'
		);
		expect(table.querySelector('time')?.textContent).toMatch(/ago/);
	});

	it('stacks each row below 640 px, the title on its own line in full, so nothing scrolls sideways (DAT-6, LAY-4)', async () => {
		api.getArchivedChatList.mockResolvedValue([row(1)]);
		mount();
		const title = await screen.findByTitle('Monte Carlo integration 1');
		const row1 = title.closest('tr');
		expect(row1).toHaveClass('max-sm:grid', 'max-sm:grid-cols-[minmax(0,1fr)_auto]');
		expect(title).toHaveClass('max-sm:col-span-2', 'max-sm:max-w-none', 'max-sm:whitespace-normal');
		expect(screen.getByRole('columnheader', { name: 'Title' }).closest('tr')).toHaveClass('max-sm:sr-only');
		// Still a table to assistive technology once laid out as grids.
		expect(screen.getByRole('table')).toBeInTheDocument();
		expect(screen.getAllByRole('row')).toHaveLength(2);
		expect(within(row1 as HTMLElement).getAllByRole('cell')).toHaveLength(3);
	});

	it('asks for the next page only after a full page (no endless paging)', async () => {
		api.getArchivedChatList.mockResolvedValue([row(1), row(2)]);
		mount();
		await screen.findByTitle('Monte Carlo integration 1');
		await new Promise((r) => setTimeout(r, 20));
		expect(api.getArchivedChatList).toHaveBeenCalledTimes(1);
		expect(ARCHIVED_PAGE_SIZE).toBe(60);
	});

	it('says so when empty, and names a search that matched nothing', async () => {
		api.getArchivedChatList.mockResolvedValue([]);
		mount();
		expect(await screen.findByText(/No archived chats\. A chat you archive/)).toBeInTheDocument();
		fireEvent.change(screen.getByRole('textbox', { name: 'Search archived chats' }), { target: { value: 'bayes' } });
		expect(await screen.findByText('No archived chats match “bayes”.', {}, { timeout: 2000 })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
		expect(screen.getByRole('textbox', { name: 'Search archived chats' })).toHaveValue('');
	});

	it('shows a failure in place, with Try again', async () => {
		api.getArchivedChatList.mockRejectedValue(new Error('boom'));
		mount();
		expect(await screen.findByText("Couldn't load archived chats")).toBeInTheDocument();
	});

	it('unarchives and deletes a chat', async () => {
		api.getArchivedChatList.mockResolvedValue([row(1)]);
		mount();
		fireEvent.click(await screen.findByRole('button', { name: 'Unarchive Monte Carlo integration 1' }));
		await waitFor(() => expect(api.archiveChatById).toHaveBeenCalledWith('', 'c1'));
		fireEvent.click(screen.getByRole('button', { name: 'Delete Monte Carlo integration 1' }));
		expect(await screen.findByRole('alertdialog', { name: 'Delete “Monte Carlo integration 1”?' })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Delete chat' }));
		await waitFor(() => expect(api.deleteChatById).toHaveBeenCalledWith('', 'c1'));
	});

	it('unarchives everything after asking', async () => {
		api.getArchivedChatList.mockResolvedValue([row(1)]);
		api.unarchiveAllChats.mockResolvedValue(true);
		mount();
		await screen.findByTitle('Monte Carlo integration 1');
		fireEvent.click(screen.getByRole('button', { name: 'Unarchive all' }));
		fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Unarchive all' }));
		await waitFor(() => expect(api.unarchiveAllChats).toHaveBeenCalled());
	});
});

describe('ChatTime (DAT-5)', () => {
	it('is relative while recent, absolute for a record, an en dash when missing', () => {
		const { container, rerender } = render(<ChatTime seconds={now - 120} />);
		expect(container.textContent).toMatch(/minutes ago/);
		rerender(<ChatTime seconds={1_700_000_000} />);
		expect(container.textContent).toMatch(/^2023-11-1\d \d\d:\d\d$/);
		expect(container.querySelector('time')?.getAttribute('title')).toBe(container.textContent);
		rerender(<ChatTime />);
		expect(container.textContent).toBe('–');
	});
});
