import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cloneSharedChatById } from '@/lib/apis/chats';
import { useAuthStore } from '@/lib/stores/authStore';
import { SharedChatPage } from './SharedChatPage';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({
	toast: Object.assign(vi.fn(), { error: toastError, success: vi.fn(), info: vi.fn() })
}));

vi.mock('@/components/chat/markdown/Markdown', () => ({
	Markdown: ({ content }: { content: string }) => <p>{content}</p>
}));

vi.mock('@/lib/apis/chats', () => ({
	getChatByShareId: vi.fn(async () => ({
		id: 'share-1',
		chat: {
			title: 'shared chat',
			history: {
				currentId: 'm1',
				messages: { m1: { id: 'm1', parentId: null, childrenIds: [], role: 'user', content: 'question' } }
			}
		}
	})),
	cloneSharedChatById: vi.fn()
}));

const renderPage = () =>
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<MemoryRouter initialEntries={['/s/share-1']}>
				<Routes>
					<Route path="/s/:id" element={<SharedChatPage />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>
	);

beforeEach(() => {
	toastError.mockReset();
	useAuthStore.setState({ status: 'authenticated', token: 't', user: { role: 'user', permissions: {} } } as never);
});

describe('SharedChatPage: cloning the share', () => {
	it('shows the server refusal instead of failing silently', async () => {
		// cloneSharedChatById rejects with the 409's detail string.
		const detail = 'This share holds an unfinished response; its owner needs to share the chat again.';
		vi.mocked(cloneSharedChatById).mockRejectedValueOnce(detail);
		renderPage();

		fireEvent.click(await screen.findByRole('button', { name: 'Clone Chat' }));

		await waitFor(() => expect(toastError).toHaveBeenCalledWith(detail));
		expect(cloneSharedChatById).toHaveBeenCalledWith('t', 'share-1');
	});
});
