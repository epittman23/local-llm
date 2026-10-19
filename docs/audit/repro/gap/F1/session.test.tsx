import { QueryClient, QueryClientProvider } from '../../../../../apps/web/node_modules/@tanstack/react-query/build/modern/index.js';
import { act, render, waitFor } from '../../../../../apps/web/node_modules/@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from '../../../../../apps/web/node_modules/react-router/dist/development/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/lib/stores/authStore';
import { useChatSession } from '@/routes/chat/useChatSession';
import * as chats from '@/lib/apis/chats';
import * as apis from '@/lib/apis';
import * as openai from '@/lib/apis/openai';

const S = vi.hoisted(() => ({
	settings: {} as Record<string, unknown>,
	handlers: [] as ((e: unknown, cb?: unknown) => void)[],
	chats: {} as Record<string, unknown>,
	deferB: null as null | ((v: unknown) => void),
	deferAction: null as null | ((v: unknown) => void),
	tasks: [] as string[],
	selected: ['m'] as string[]
}));

vi.mock('@/lib/settings/userSettings', () => ({ useUserSettings: () => ({ settings: S.settings }) }));
vi.mock('@/lib/socket/SocketProvider', () => {
	const socket = {
		id: 'sid',
		on: (ev: string, h: (e: unknown) => void) => ev === 'events' && S.handlers.push(h),
		off: (ev: string, h: (e: unknown) => void) => {
			const i = S.handlers.indexOf(h);
			if (i >= 0) S.handlers.splice(i, 1);
		},
		emit: () => {}
	};
	return { useSocket: () => ({ socket }) };
});
vi.mock('@/lib/apis/chats', async (orig) => ({
	...(await orig<object>()),
	getChatById: vi.fn((_t: string, id: string) =>
		id === 'B' && S.deferB === null
			? new Promise((r) => (S.deferB = r))
			: Promise.resolve(S.chats[id])
	),
	updateChatById: vi.fn(async () => null)
}));
vi.mock('@/lib/apis', async (orig) => ({
	...(await orig<object>()),
	getTaskIdsByChatId: vi.fn(async () => ({ task_ids: S.tasks })),
	stopTasksByChatId: vi.fn(async () => ({})),
	stopTask: vi.fn(async () => ({})),
	chatAction: vi.fn(() => new Promise((r) => (S.deferAction = r))),
	generateTags: vi.fn(async () => [])
}));
vi.mock('@/lib/apis/openai', async (orig) => ({
	...(await orig<object>()),
	generateOpenAIChatCompletion: vi.fn(async () => ({ status: true, task_id: 't-new', chat_id: 'A' }))
}));
vi.mock('@/lib/apis/users', async (orig) => ({ ...(await orig<object>()), getUserSettings: vi.fn(async () => ({ ui: {} })) }));

const chatRecord = (id: string, replyDone: boolean, replyContent = '') => ({
	id,
	chat: {
		title: `chat ${id}`,
		models: ['m'],
		history: {
			currentId: `${id}-a`,
			messages: {
				[`${id}-u`]: { id: `${id}-u`, parentId: null, childrenIds: [`${id}-a`], role: 'user', content: `hello from ${id}` },
				[`${id}-a`]: {
					id: `${id}-a`, parentId: `${id}-u`, childrenIds: [], role: 'assistant', model: 'm',
					content: replyContent, done: replyDone
				}
			}
		}
	}
});

type Session = ReturnType<typeof useChatSession>;
let session: Session;
function Probe({ id }: { id: string }) {
	session = useChatSession({
		routeChatId: id,
		folderId: null,
		models: [{ id: 'm', name: 'M' } as never, { id: 'm2', name: 'M2' } as never],
		selectedModels: S.selected,
		temporary: false,
		toggles: { webSearch: false, imageGeneration: false, codeInterpreter: false },
		toolIds: []
	});
	return null;
}
const Route = () => <Probe id={useParams().id!} />;
function renderAt(id: string) {
	const router = createMemoryRouter([{ path: '/c/:id', element: <Route /> }], { initialEntries: [`/c/${id}`] });
	render(
		<QueryClientProvider client={new QueryClient()}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	);
	return router;
}
const fire = (e: unknown) => act(async () => S.handlers.forEach((h) => h(e)));

describe('F1 useChatSession', () => {
	beforeEach(() => {
		useAuthStore.setState({
			status: 'authenticated',
			token: 't',
			user: { id: 'u', email: 'e', name: 'n', role: 'user', profile_image_url: '' }
		} as never);
		vi.clearAllMocks();
		S.handlers.length = 0;
		S.deferB = null;
		S.deferAction = null;
		S.selected = ['m'];
	});
	afterEach(() => useAuthStore.setState({ status: 'pending', token: null, user: null } as never));

	it('queue off: sending during a reply does not stop it', async () => {
		S.settings = { enableMessageQueue: false };
		S.tasks = ['t-old'];
		S.chats.A = chatRecord('A', false, 'partial…');
		renderAt('A');
		await waitFor(() => expect(session.history.currentId).toBe('A-a'));
		expect(session.generating).toBe(true);
		await act(async () => void session.submit('second', []));
		await waitFor(() => expect(openai.generateOpenAIChatCompletion).toHaveBeenCalled());
		const second = Object.values(session.history.messages).find((m) => m.content === 'second')!;
		console.log('stopTasksByChatId calls:', (apis.stopTasksByChatId as any).mock.calls.length,
			'| stopTask calls:', (apis.stopTask as any).mock.calls.length,
			'| new prompt parentId:', second.parentId,
			'| old reply done:', session.history.messages['A-a'].done);
		expect(apis.stopTasksByChatId).not.toHaveBeenCalled();
		expect(second.parentId).toBe('A-a');
		expect(session.history.messages['A-a'].done).toBe(false);
	});

	it('queued prompt is dropped when the reply it waited on fails with no content', async () => {
		S.settings = {};
		S.tasks = ['t-old'];
		S.chats.A = chatRecord('A', false, '');
		renderAt('A');
		await waitFor(() => expect(session.history.currentId).toBe('A-a'));
		await act(async () => void session.submit('queued prompt', []));
		expect(session.queue.map((q) => q.prompt)).toEqual(['queued prompt']);
		await fire({ chat_id: 'A', message_id: 'A-a', data: { type: 'chat:message:error', data: { error: { content: 'boom' } } } });
		await fire({ chat_id: 'A', message_id: 'A-a', data: { type: 'chat:tasks:cancel' } });
		await waitFor(() => expect(session.generating).toBe(false));
		await new Promise((r) => setTimeout(r, 50));
		const sent = Object.values(session.history.messages).some((m) => m.content === 'queued prompt');
		console.log('queue after:', JSON.stringify(session.queue), '| prompt in history:', sent,
			'| completion requests:', (openai.generateOpenAIChatCompletion as any).mock.calls.length);
		expect(session.queue).toEqual([]);
		expect(sent).toBe(false);
		expect(openai.generateOpenAIChatCompletion).not.toHaveBeenCalled();
	});

	it("an action finishing while another chat loads saves the old chat's history into the new one", async () => {
		S.settings = {};
		S.tasks = [];
		S.chats.A = chatRecord('A', true, 'reply in A');
		S.chats.B = chatRecord('B', true, 'reply in B');
		const router = renderAt('A');
		await waitFor(() => expect(session.history.currentId).toBe('A-a'));
		let p!: Promise<void>;
		act(() => {
			p = session.runAction('act', session.history.messages['A-a']);
		});
		await waitFor(() => expect(S.deferAction).not.toBeNull());
		await act(() => router.navigate('/c/B'));
		await waitFor(() => expect(S.deferB).not.toBeNull());
		await act(async () => {
			S.deferAction!({ messages: [{ id: 'A-a', content: 'action output' }] });
			await p;
		});
		const calls = (chats.updateChatById as any).mock.calls.map((c: any[]) => [c[1], Object.keys(c[2].history?.messages ?? {})]);
		console.log('updateChatById calls (chat id, message ids saved):', JSON.stringify(calls));
		expect(calls).toContainEqual(['B', ['A-u', 'A-a']]);
		await act(async () => S.deferB!(S.chats.B));
	});
	it('chat:active false for a reply whose done event was missed leaves it generating (Svelte reloaded)', async () => {
		S.settings = {};
		S.tasks = ['t-old'];
		S.chats.A = chatRecord('A', false, 'partial…');
		renderAt('A');
		await waitFor(() => expect(session.history.currentId).toBe('A-a'));
		const loadsBefore = (chats.getChatById as any).mock.calls.length;
		S.tasks = [];
		await fire({ chat_id: 'A', message_id: 'A-a', data: { type: 'chat:active', data: { active: false } } });
		await new Promise((r) => setTimeout(r, 50));
		console.log('after chat:active=false: generating =', session.generating, '| reply done =', session.history.messages['A-a'].done,
			'| extra getChatById calls =', (chats.getChatById as any).mock.calls.length - loadsBefore);
		expect(session.generating).toBe(true);
	});

	it('multi-model: a failed POST fails only the first column and leaves the input generating', async () => {
		S.settings = {};
		S.tasks = [];
		S.selected = ['m', 'm2'];
		S.chats.A = chatRecord('A', true, 'done reply');
		(openai.generateOpenAIChatCompletion as any).mockRejectedValueOnce({ detail: 'Model not found' });
		renderAt('A');
		await waitFor(() => expect(session.history.currentId).toBe('A-a'));
		await act(async () => void session.submit('two models please', []));
		await waitFor(() => expect(openai.generateOpenAIChatCompletion).toHaveBeenCalled());
		await new Promise((r) => setTimeout(r, 50));
		const u = Object.values(session.history.messages).find((m) => m.content === 'two models please')!;
		const kids = u.childrenIds.map((c) => session.history.messages[c]);
		console.log('replies:', JSON.stringify(kids.map((k) => ({ model: k.model, done: k.done, error: Boolean(k.error) }))),
			'| current is', session.history.currentId === kids[1].id ? 'second column' : 'other', '| generating =', session.generating);
		expect(session.generating).toBe(true);
	});
});
