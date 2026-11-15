import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cloneSharedChatById, getChatByShareId } from '@/lib/apis/chats';
import { useAuthStore } from '@/lib/stores/authStore';
import { usePageTitleStore } from '@/lib/ui/pageTitle';
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
					<Route path="/auth" element={<p>sign-in page</p>} />
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

describe('SharedChatPage: its tab and heading', () => {
	it('names the tab after the chat through the shared title hook, and sizes the heading on the scale', async () => {
		renderPage();
		const heading = await screen.findByRole('heading', { level: 1, name: 'shared chat' });
		expect(heading.className).toContain('text-heading');
		await waitFor(() => expect(usePageTitleStore.getState().dynamic).toBe('shared chat'));
	});
});

describe('SharedChatPage: a link that no longer works (NAV-3, #953)', () => {
	it('tells a signed-in viewer, in place, that a missing share is no longer available', async () => {
		vi.mocked(getChatByShareId).mockRejectedValueOnce("We could not find what you're looking for :/");
		renderPage();
		expect(
			await screen.findByRole('heading', { level: 1, name: 'This shared link is no longer available.' })
		).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Go to your chats' })).toHaveAttribute('href', '/');
	});

	it('tells a signed-in viewer a private share is not open to them', async () => {
		vi.mocked(getChatByShareId).mockRejectedValueOnce(
			'You do not have permission to access this resource. Please contact your administrator for assistance.'
		);
		renderPage();
		expect(await screen.findByRole('heading', { name: 'This shared chat is not open to you.' })).toBeInTheDocument();
	});

	it('offers to try again when the share failed to load (STA-4)', async () => {
		vi.mocked(getChatByShareId).mockRejectedValueOnce('Database is locked');
		renderPage();
		expect(await screen.findByText("Couldn't load this shared chat")).toBeInTheDocument();
	});

	it('still sends an anonymous viewer to sign in, since the server answers a missing and a private share alike', async () => {
		useAuthStore.setState({ status: 'anonymous', token: null, user: null } as never);
		vi.mocked(getChatByShareId).mockRejectedValueOnce('401 Unauthorized');
		renderPage();
		expect(await screen.findByText('sign-in page')).toBeInTheDocument();
	});
});
