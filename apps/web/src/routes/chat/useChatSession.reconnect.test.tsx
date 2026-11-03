import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as apis from '@/lib/apis';
import * as chatsApi from '@/lib/apis/chats';
import { useAuthStore } from '@/lib/stores/authStore';
import { useChatSession } from './useChatSession';

// #214: a reply whose done event was missed (a dropped socket, a backend
// reload) stayed "generating" forever. The stored chat is loaded again when
// the chat goes inactive with a reply still pending, and on reconnect when
// the server has no task left for it.

const { socket, tasks } = vi.hoisted(() => ({
	socket: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), id: 's1', connected: true },
	tasks: { ids: [] as string[] }
}));
vi.mock('@/lib/socket/SocketProvider', () => ({ useSocket: () => ({ socket, connected: true }) }));

const writing = {
	currentId: 'a1',
	messages: {
		q1: { id: 'q1', parentId: null, childrenIds: ['a1'], role: 'user', content: 'q' },
		a1: { id: 'a1', parentId: 'q1', childrenIds: [], role: 'assistant', content: 'half', done: false }
	}
};
const finished = {
	...writing,
	messages: { ...writing.messages, a1: { ...writing.messages.a1, content: 'whole answer', done: true } }
};

vi.mock('@/lib/apis/chats', async (orig) => ({
	...(await orig<object>()),
	getChatById: vi.fn(),
	updateChatById: vi.fn(async () => null)
}));
vi.mock('@/lib/apis', async (orig) => ({
	...(await orig<object>()),
	getTaskIdsByChatId: vi.fn(async () => ({ task_ids: tasks.ids }))
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
	return <Probe id={useParams().id ?? ''} />;
}

/** The chat is open with its reply still marked as being written (its task still running). */
async function openWritingChat() {
	tasks.ids = ['t1'];
	vi.mocked(chatsApi.getChatById).mockResolvedValue({ id: 'C', chat: { title: 'c', history: writing } } as never);
	const router = createMemoryRouter([{ path: '/c/:id', element: <Route /> }], { initialEntries: ['/c/C'] });
	render(
		<QueryClientProvider client={new QueryClient()}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	);
	await waitFor(() => expect(session.history.messages.a1?.content).toBe('half'));
	expect(session.history.messages.a1.done).toBe(false);
	// From now on the server has finished it.
	tasks.ids = [];
	vi.mocked(chatsApi.getChatById).mockClear();
	vi.mocked(chatsApi.getChatById).mockResolvedValue({ id: 'C', chat: { title: 'c', history: finished } } as never);
}

const listener = (name: string) => {
	const calls = socket.on.mock.calls.filter(([event]) => event === name);
	const call = calls.at(-1);
	if (!call) throw new Error(`no ${name} listener`);
	return call[1] as (...args: unknown[]) => unknown;
};

describe('useChatSession: a missed done event (#214)', () => {
	beforeEach(() => {
		useAuthStore.setState({ token: 't' } as never);
		socket.on.mockClear();
		vi.mocked(apis.getTaskIdsByChatId).mockClear();
	});
	afterEach(() => {
		useAuthStore.setState({ token: null } as never);
	});

	it('reloads the chat when it goes inactive with the reply still pending', async () => {
		await openWritingChat();

		await act(async () =>
			listener('events')({ chat_id: 'C', message_id: 'a1', data: { type: 'chat:active', data: { active: false } } })
		);

		await waitFor(() => expect(session.history.messages.a1.content).toBe('whole answer'));
		expect(session.history.messages.a1.done).toBe(true);
	});

	it('on reconnect, reloads the chat when the server has no task left for a pending reply', async () => {
		await openWritingChat();

		await act(async () => listener('connect')());

		await waitFor(() => expect(session.history.messages.a1.done).toBe(true));
		expect(chatsApi.getChatById).toHaveBeenCalled();
	});

	it('on reconnect, leaves a reply alone while its task still runs', async () => {
		await openWritingChat();
		tasks.ids = ['t1'];

		await act(async () => listener('connect')());

		expect(chatsApi.getChatById).not.toHaveBeenCalled();
		expect(session.history.messages.a1.done).toBe(false);
	});
});
