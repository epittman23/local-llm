import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getChatList, getChatListBySearchText } from '@/lib/apis/chats';
import { groupByTime, SearchChatsDialog } from './ChatDialogs';

vi.mock('@/lib/apis/chats', () => ({ getChatListBySearchText: vi.fn(), getChatList: vi.fn() }));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'u1' } })
}));

const Where = () => <div data-testid="where">{useLocation().pathname}</div>;
const now = Math.floor(Date.now() / 1000);

function show(onOpenChange = vi.fn()) {
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<MemoryRouter initialEntries={['/start']}>
				<SearchChatsDialog open onOpenChange={onOpenChange} />
				<Where />
			</MemoryRouter>
		</QueryClientProvider>
	);
	return onOpenChange;
}

const field = () => screen.getByRole('combobox', { name: 'Search chats' });
const type = (text: string) => fireEvent.change(field(), { target: { value: text } });
/** The search for `text` alone, and the archived-only one beside it. */
const answer = (found: object[], archived: object[] = []) =>
	vi
		.mocked(getChatListBySearchText)
		.mockImplementation(async (_t, text) => (text.includes('archived:true') ? archived : found) as never);

beforeEach(() => {
	vi.mocked(getChatList).mockResolvedValue([] as never);
	vi.mocked(getChatListBySearchText).mockReset();
});
afterEach(cleanup);

describe('SearchChatsDialog', () => {
	it('offers a new chat before anything is typed, which opens the home page', async () => {
		const onOpenChange = show();
		// The main list leaves out chats in folders, so an empty one is not "no chats" (STA-3, WRD-1).
		expect(await screen.findByText(/Recent chats outside folders appear here/)).toBeInTheDocument();
		expect(screen.queryByText(/No chats yet/)).toBeNull();
		fireEvent.click(screen.getByRole('option', { name: 'New chat' }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(screen.getByTestId('where').textContent).toBe('/');
	});

	it('shows the recent chats loading, not "no chats", before they arrive (STA-2)', async () => {
		let resolve: (v: never) => void = () => {};
		vi.mocked(getChatList).mockImplementation(() => new Promise((r) => (resolve = r)));
		show();
		expect(await screen.findByRole('progressbar', { name: 'Loading recent chats' })).toBeInTheDocument();
		expect(screen.queryByText(/appear here|No chats yet/)).toBeNull();
		expect(screen.getByRole('option', { name: 'New chat' })).toBeInTheDocument();
		resolve([{ id: 'r1', title: 'Late arrival', updated_at: now }] as never);
		expect(await screen.findByRole('option', { name: /Late arrival/ })).toBeInTheDocument();
	});

	it('says in place when the recent chats fail, and tries again (STA-4)', async () => {
		let fail = true;
		vi.mocked(getChatList).mockImplementation(async () => {
			if (fail) throw 'Database is locked';
			return [{ id: 'r1', title: 'Back again', updated_at: now }] as never;
		});
		show();
		expect(await screen.findByText("Couldn't load recent chats")).toBeInTheDocument();
		expect(screen.queryByText(/appear here|No chats yet/)).toBeNull();
		fail = false;
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByRole('option', { name: /Back again/ })).toBeInTheDocument();
	});

	it('offers the most recent chats before anything is typed', async () => {
		vi.mocked(getChatList).mockResolvedValue([
			{ id: 'r1', title: 'Kaplan-Meier curves', updated_at: now - 60 },
			{ id: 'r2', title: 'ANOVA assumptions', updated_at: now - 120 }
		] as never);
		show();
		const group = await screen.findByRole('group', { name: 'Recent chats' });
		expect(
			within(group)
				.getAllByRole('option')
				.map((o) => o.textContent)
		).toEqual([expect.stringContaining('Kaplan-Meier curves'), expect.stringContaining('ANOVA assumptions')]);
		// The first is highlighted, so Enter opens it.
		await waitFor(() => expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true'));
		fireEvent.keyDown(field(), { key: 'Enter' });
		expect(screen.getByTestId('where').textContent).toBe('/c/r1');
	});

	it('lists the chats found and opens the one pressed', async () => {
		answer([{ id: 'c9', title: 'Pasta recipes', updated_at: now - 60 }]);
		const onOpenChange = show();
		type('pasta');
		fireEvent.click(await screen.findByRole('option', { name: /Pasta recipes/ }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(screen.getByTestId('where').textContent).toBe('/c/c9');
	});

	it('moves the highlight with the arrow keys and opens the highlighted chat with Enter (NAV-5)', async () => {
		answer([
			{ id: 'a', title: 'Sample variance', updated_at: now - 60 },
			{ id: 'b', title: 'Sample size', updated_at: now - 120 }
		]);
		show();
		type('sample');
		await screen.findByRole('option', { name: /Sample size/ });
		const [first, second] = screen.getAllByRole('option');
		await waitFor(() => expect(first).toHaveAttribute('aria-selected', 'true'));
		fireEvent.keyDown(field(), { key: 'ArrowDown' });
		expect(second).toHaveAttribute('aria-selected', 'true');
		expect(field()).toHaveFocus();
		fireEvent.keyDown(field(), { key: 'Enter' });
		expect(screen.getByTestId('where').textContent).toBe('/c/b');
	});

	it('shows the matching text and the date of each result, under its time heading', async () => {
		answer([
			{
				id: 'c1',
				title: 'Dice and the CLT',
				updated_at: now - 3600,
				time_range: 'Today',
				snippet: '...the standardised mean tends to N(0,1)...'
			}
		]);
		show();
		type('mean');
		const group = await screen.findByRole('group', { name: 'Today' });
		expect(within(group).getByText('...the standardised mean tends to N(0,1)...')).toBeInTheDocument();
		const time = within(group).getByText('an hour ago');
		expect(time.tagName).toBe('TIME');
		expect(time).toHaveAttribute('title', expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/));
	});

	it('adds archived matches last, marked Archived, from the server’s archived:true filter', async () => {
		answer(
			[{ id: 'c1', title: 'Live chat', updated_at: now }],
			[{ id: 'old', title: 'Monte Carlo integration', updated_at: now - 40 * 86400 }]
		);
		show();
		type('monte');
		const group = await screen.findByRole('group', { name: 'Archived' });
		expect(within(group).getByText('Monte Carlo integration')).toBeInTheDocument();
		expect(within(group).getByText('Archived')).toBeInTheDocument();
		expect(getChatListBySearchText).toHaveBeenCalledWith('t', 'monte archived:true', 1);
		fireEvent.click(within(group).getByRole('option'));
		expect(screen.getByTestId('where').textContent).toBe('/c/old');
	});

	it('says so below the results when the archived search fails, and tries it again (STA-4)', async () => {
		let fail = true;
		vi.mocked(getChatListBySearchText).mockImplementation(async (_t, text) => {
			if (!text.includes('archived:true')) return [] as never;
			if (fail) throw 'Database is locked';
			return [{ id: 'old', title: 'Monte Carlo integration', updated_at: now - 40 * 86400 }] as never;
		});
		show();
		type('monte');
		expect(await screen.findByText("Couldn't search archived chats.")).toBeInTheDocument();
		// Half the search failed, so it does not say nothing matched.
		expect(screen.queryByText(/No chats match/)).toBeNull();
		fail = false;
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByRole('group', { name: 'Archived' })).toBeInTheDocument();
	});

	it('does not add an archived search to one that names its own archived filter', async () => {
		vi.mocked(getChatListBySearchText).mockResolvedValue([{ id: 'c1', title: 'Old chat', updated_at: now }] as never);
		show();
		type('archived:true old');
		await screen.findByRole('option', { name: /Old chat/ });
		expect(getChatListBySearchText).toHaveBeenCalledTimes(1);
	});

	it('names the search when nothing matches, and offers to clear it (STA-3)', async () => {
		answer([]);
		show();
		type('zzz');
		expect(await screen.findByText('No chats match “zzz”.')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
		expect(field()).toHaveValue('');
	});

	it('says in place when the search fails, and tries again (STA-4)', async () => {
		vi.mocked(getChatListBySearchText).mockRejectedValue('Database is locked');
		show();
		type('fail');
		expect(await screen.findByText("Couldn't load search results")).toBeInTheDocument();
		vi.mocked(getChatListBySearchText).mockResolvedValue([{ id: 'c1', title: 'Back again', updated_at: now }] as never);
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByRole('option', { name: /Back again/ })).toBeInTheDocument();
	});

	it('has no close button over the field, and says which keys and filters work', () => {
		show();
		expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
		expect(screen.getByText(/Enter to open · Filters: tag: folder: pinned:/)).toBeInTheDocument();
	});
});

describe('groupByTime', () => {
	it('keeps the order the chats came in, under one heading per time range', () => {
		const groups = groupByTime([
			{ id: '1', title: 'a', time_range: 'Today' },
			{ id: '2', title: 'b', time_range: 'Yesterday' },
			{ id: '3', title: 'c', time_range: 'Today' }
		]);
		expect(groups.map(([label, chats]) => [label, chats.map((c) => c.id)])).toEqual([
			['Today', ['1', '3']],
			['Yesterday', ['2']]
		]);
	});

	it('works the range out from the date when the server sent none', () => {
		expect(groupByTime([{ id: '1', title: 'a', updated_at: now }])[0][0]).toBe('Today');
	});
});
