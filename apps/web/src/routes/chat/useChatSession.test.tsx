import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/lib/stores/authStore';
import { useChatSession } from './useChatSession';

// docs/bug-review-2026-09-27.md H3: a slow load of the chat the user just
// left must not overwrite the one now open.

const pending: Record<string, (v: unknown) => void> = {};

vi.mock('@/lib/apis/chats', async (orig) => ({
	...(await orig<object>()),
	getChatById: vi.fn(async (_t: string, id: string) => ({
		id,
		chat: {
			title: `chat ${id}`,
			models: [`model-${id}`],
			history: {
				currentId: `${id}-m`,
				messages: {
					[`${id}-m`]: { id: `${id}-m`, parentId: null, childrenIds: [], role: 'user', content: `hello from ${id}` }
				}
			}
		}
	})),
	updateChatById: vi.fn(async () => null)
}));

vi.mock('@/lib/apis', async (orig) => ({
	...(await orig<object>()),
	// Resolves only when the test says so, per chat.
	getTaskIdsByChatId: vi.fn(
		(_t: string, id: string) => new Promise((resolve) => (pending[id] = () => resolve({ task_ids: [] })))
	)
}));

vi.mock('@/lib/apis/users', async (orig) => ({
	...(await orig<object>()),
	getUserSettings: vi.fn(async () => ({ ui: {} }))
}));

type Session = ReturnType<typeof useChatSession>;
let session: Session;

function Probe({ id }: { id: string }) {
	session = useChatSession({
		routeChatId: id,
		folderId: null,
		models: [],
		selectedModels: [],
		temporary: false,
		toggles: { webSearch: false, imageGeneration: false, codeInterpreter: false },
		toolIds: []
	});
	return null;
}

function Route() {
	return <Probe id={useParams().id!} />;
}

function renderAt(id: string) {
	const client = new QueryClient();
	const router = createMemoryRouter([{ path: '/c/:id', element: <Route /> }], { initialEntries: [`/c/${id}`] });
	render(
		<QueryClientProvider client={client}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	);
	return router;
}

describe('useChatSession loadChat', () => {
	beforeEach(() =>
		useAuthStore.setState({
			status: 'authenticated',
			token: 't',
			user: { id: 'u', email: 'e', name: 'n', role: 'user', profile_image_url: '' }
		})
	);
	afterEach(() => {
		useAuthStore.setState({ status: 'pending', token: null, user: null });
		for (const k of Object.keys(pending)) delete pending[k];
	});

	it('keeps the chat that is open when an earlier load finishes last', async () => {
		const router = renderAt('A');
		await waitFor(() => expect(pending.A).toBeDefined());

		await act(() => router.navigate('/c/B'));
		await waitFor(() => expect(pending.B).toBeDefined());

		// B finishes first, then the stale load of A.
		await act(async () => pending.B(undefined));
		await waitFor(() => expect(session.chat?.id).toBe('B'));
		await act(async () => pending.A(undefined));

		expect(session.chat?.id).toBe('B');
		expect(session.history.messages['B-m']?.content).toBe('hello from B');
		expect(session.history.messages['A-m']).toBeUndefined();
	});
});
