import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getChatListBySearchText } from '@/lib/apis/chats';
import { SearchChatsDialog } from './ChatDialogs';

vi.mock('@/lib/apis/chats', () => ({ getChatListBySearchText: vi.fn() }));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'u1' } })
}));

const Where = () => <div data-testid="where">{useLocation().pathname}</div>;

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

afterEach(cleanup);

describe('SearchChatsDialog', () => {
	it('offers a new conversation before anything is typed, which opens the home page', () => {
		const onOpenChange = show();
		fireEvent.click(screen.getByRole('button', { name: 'Start a new conversation' }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(screen.getByTestId('where').textContent).toBe('/');
	});

	it('lists the chats found and opens the one pressed', async () => {
		vi.mocked(getChatListBySearchText).mockResolvedValue([
			{ id: 'c9', title: 'Pasta recipes', time_range: 'Today' }
		] as never);
		const onOpenChange = show();
		fireEvent.change(screen.getByRole('textbox', { name: 'Search chats' }), { target: { value: 'pasta' } });
		fireEvent.click(await screen.findByRole('option', { name: /Pasta recipes/ }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(screen.getByTestId('where').textContent).toBe('/c/c9');
	});

	it('says so when no chat matches', async () => {
		vi.mocked(getChatListBySearchText).mockResolvedValue([]);
		show();
		fireEvent.change(screen.getByRole('textbox', { name: 'Search chats' }), { target: { value: 'zzz' } });
		expect(await screen.findByText('No results found')).toBeTruthy();
	});
});
