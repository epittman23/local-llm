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

		fireEvent.click(await screen.findByRole('button', { name: 'Continue this chat' }));

		await waitFor(() => expect(toastError).toHaveBeenCalledWith(detail));
		expect(cloneSharedChatById).toHaveBeenCalledWith('t', 'share-1');
	});
});

describe('SharedChatPage: its frame (#1005)', () => {
	it('says what it is in a header: the app, a shared conversation, the date it was captured', async () => {
		vi.mocked(getChatByShareId).mockResolvedValueOnce({
			id: 'share-1',
			user_id: 'someone',
			updated_at: new Date('2026-11-11T18:43:33').getTime() / 1000,
			chat: {
				title: 'shared chat',
				history: {
					currentId: 'm2',
					messages: {
						m1: { id: 'm1', parentId: null, childrenIds: ['m2'], role: 'user', content: 'question' },
						m2: { id: 'm2', parentId: 'm1', childrenIds: [], role: 'assistant', model: 'qwen', content: 'answer' }
					}
				}
			}
		});
		renderPage();
		const header = await screen.findByRole('banner');
		expect(header).toHaveTextContent('local-llm');
		// The mark and the name are one link home; the mark itself is decorative (WRD-3).
		const home = screen.getByRole('link', { name: 'local-llm' });
		expect(home.querySelector('[data-slot="app-mark"]')).toHaveAttribute('aria-hidden', 'true');
		expect(header).toHaveTextContent('Shared conversation · captured 2026-11-11');
		expect(screen.getByText('2026-11-11')).toHaveAttribute('title', '2026-11-11 18:43');
		expect(screen.getByRole('main')).toContainElement(screen.getByRole('heading', { level: 1 }));
		// The sharer's turns are the user's, not "You" to every reader.
		expect(screen.getByRole('region', { name: 'User' })).toHaveTextContent('question');
		expect(screen.getByRole('region', { name: 'Assistant' })).toHaveTextContent('qwen');
		expect(screen.queryByText('You')).toBeNull();
	});

	it('offers Continue this chat only to a signed-in viewer allowed to import, and says it is busy', async () => {
		let finish: (v: unknown) => void = () => {};
		vi.mocked(cloneSharedChatById).mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
		renderPage();
		const button = await screen.findByRole('button', { name: 'Continue this chat' });
		fireEvent.click(button);
		expect(await screen.findByRole('button', { name: 'Copying to your chats…' })).toBeDisabled();
		finish(null);
		expect(await screen.findByRole('button', { name: 'Continue this chat' })).toBeEnabled();
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
		await waitFor(() => expect(usePageTitleStore.getState().dynamic).toBe('Shared link not available'));
	});

	it('tells a signed-in viewer a private share is not open to them', async () => {
		vi.mocked(getChatByShareId).mockRejectedValueOnce(
			'You do not have permission to access this resource. Please contact your administrator for assistance.'
		);
		renderPage();
		expect(await screen.findByRole('heading', { name: 'This shared chat is not open to you.' })).toBeInTheDocument();
		// WRD-4: one owner, so no talk of "certain accounts".
		expect(
			screen.getByText('Sign in with the account that shared it, or ask for a link anyone can open.')
		).toBeInTheDocument();
		expect(screen.queryByText(/certain accounts/)).toBeNull();
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
