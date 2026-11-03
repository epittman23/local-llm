import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as apis from '@/lib/apis';
import * as chatsApi from '@/lib/apis/chats';
import * as usersApi from '@/lib/apis/users';
import { updateMessage } from '@/lib/chat/history';
import { useAuthStore } from '@/lib/stores/authStore';
import { useChatSession } from './useChatSession';

// docs/history/bug-review-2026-09-27.md H3: a slow load of the chat the user just
// left must not overwrite the one now open.

const pending: Record<string, (v: unknown) => void> = {};
const DOC = { type: 'file', id: 'd1', content_type: 'application/pdf' };

vi.mock('@/lib/apis/chats', async (orig) => ({
	...(await orig<object>()),
	getChatById: vi.fn(async (_t: string, id: string) => ({
		id,
		chat: {
			title: `chat ${id}`,
			models: [`model-${id}`],
			...(id === 'F' ? { files: [DOC] } : {}),
			history:
				id === 'F'
					? // The document was attached on branch q1; the open branch, q2, has none.
						{
							currentId: 'a2',
							messages: {
								q1: { id: 'q1', parentId: null, childrenIds: ['a1'], role: 'user', content: 'read', files: [DOC] },
								a1: { id: 'a1', parentId: 'q1', childrenIds: [], role: 'assistant', content: 'ok', done: true },
								q2: { id: 'q2', parentId: null, childrenIds: ['a2'], role: 'user', content: 'other' },
								a2: { id: 'a2', parentId: 'q2', childrenIds: [], role: 'assistant', content: 'x', done: true }
							}
						}
					: id === 'M'
						? // Two models answered; the current reply finished, its sibling was saved mid-stream.
							{
								currentId: 'a',
								messages: {
									q: { id: 'q', parentId: null, childrenIds: ['b', 'a'], role: 'user', content: 'q' },
									b: { id: 'b', parentId: 'q', childrenIds: [], role: 'assistant', content: 'y', done: false },
									a: { id: 'a', parentId: 'q', childrenIds: [], role: 'assistant', content: 'x', done: true }
								}
							}
						: {
								currentId: `${id}-m`,
								messages: {
									[`${id}-m`]: {
										id: `${id}-m`,
										parentId: null,
										childrenIds: [],
										role: 'user',
										content: `hello from ${id}`
									}
								}
							}
		}
	})),
	updateChatById: vi.fn(async () => null),
	// The server's copy after a delete: the sibling still saved mid-stream.
	deleteChatMessageById: vi.fn(async () => ({
		chat: {
			history: {
				currentId: 'a',
				messages: {
					q: { id: 'q', parentId: null, childrenIds: ['b', 'a'], role: 'user', content: 'q' },
					b: { id: 'b', parentId: 'q', childrenIds: [], role: 'assistant', content: 'y', done: false },
					a: { id: 'a', parentId: 'q', childrenIds: [], role: 'assistant', content: 'x', done: true }
				}
			}
		}
	}))
}));

vi.mock('@/lib/apis', async (orig) => ({
	...(await orig<object>()),
	// Resolves only when the test says so, per chat.
	getTaskIdsByChatId: vi.fn(
		(_t: string, id: string) => new Promise((resolve) => (pending[id] = (v) => resolve(v ?? { task_ids: [] })))
	),
	stopTasksByChatId: vi.fn(async () => true),
	generateTags: vi.fn(async () => ['tagged']),
	chatAction: vi.fn(() => new Promise((resolve) => (pending.action = resolve)))
}));

vi.mock('@/lib/apis/evaluations', async (orig) => ({
	...(await orig<object>()),
	createNewFeedback: vi.fn(() => new Promise((resolve) => (pending.feedback = resolve))),
	updateFeedbackById: vi.fn(async () => ({}))
}));

vi.mock('@/lib/apis/openai', async (orig) => ({
	...(await orig<object>()),
	generateOpenAIChatCompletion: vi.fn(async () => ({}))
}));

vi.mock('@/lib/apis/users', async (orig) => ({
	...(await orig<object>()),
	getUserSettings: vi.fn(async () => ({ ui: {} }))
}));

type Session = ReturnType<typeof useChatSession>;
let session: Session;
/** The models the probe offers; most tests send nothing, so none. */
let probeModels: { id: string }[] = [];

function Probe({ id }: { id: string }) {
	session = useChatSession({
		routeChatId: id,
		folderId: null,
		models: probeModels as never,
		selectedModels: probeModels.map((m) => m.id),
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

	it('with no task running, finishes a sibling reply saved mid-stream (#150)', async () => {
		renderAt('M');
		await waitFor(() => expect(pending.M).toBeDefined());
		await act(async () => pending.M({ task_ids: [] }));
		await waitFor(() => expect(session.chat?.id).toBe('M'));
		expect(session.history.messages.b.done).toBe(true);
	});

	it("after a delete, finishes the sibling again in the server's copy", async () => {
		renderAt('M');
		await waitFor(() => expect(pending.M).toBeDefined());
		await act(async () => pending.M({ task_ids: [] }));
		await waitFor(() => expect(session.chat?.id).toBe('M'));
		await act(() => session.removeMessage(session.history.messages.a));
		expect(session.history.messages.b.done).toBe(true);
	});

	it('leaves that sibling streaming while its task still runs', async () => {
		renderAt('M');
		await waitFor(() => expect(pending.M).toBeDefined());
		await act(async () => pending.M({ task_ids: ['t-b'] }));
		await waitFor(() => expect(session.chat?.id).toBe('M'));
		expect(session.history.messages.b.done).toBe(false);
	});

	async function openChatA() {
		const router = renderAt('A');
		await waitFor(() => expect(pending.A).toBeDefined());
		await act(async () => pending.A(undefined));
		await waitFor(() => expect(session.chat?.id).toBe('A'));
		return router;
	}

	/** A reply still being written under chat A's message. */
	const writing = () =>
		act(() =>
			session.setHistory((h) => ({
				currentId: 'r',
				messages: {
					...h.messages,
					'A-m': { ...h.messages['A-m'], childrenIds: ['r'] },
					r: { id: 'r', parentId: 'A-m', childrenIds: [], role: 'assistant', content: '', done: false }
				}
			}))
		);
	const asked = (prompt: string) =>
		Object.values(session.history.messages).some((m) => m.role === 'user' && m.content === prompt);

	it('a queued prompt is sent even when the reply it waited on failed with nothing written (#213)', async () => {
		await openChatA();
		writing();
		act(() => void session.submit('next', [], 'm'));
		expect(session.queue).toHaveLength(1);
		act(() =>
			session.setHistory((h) => updateMessage(h, 'r', { done: true, content: '', error: { content: 'boom' } }))
		);
		await waitFor(() => expect(asked('next')).toBe(true));
		expect(session.queue).toHaveLength(0);
	});

	it('with the queue off, sending stops the reply being written first (#212)', async () => {
		vi.mocked(usersApi.getUserSettings).mockClear();
		vi.mocked(usersApi.getUserSettings).mockResolvedValue({ ui: { enableMessageQueue: false } } as never);
		try {
			await openChatA();
			await waitFor(() => expect(usersApi.getUserSettings).toHaveBeenCalled());
			await act(async () => {});
			writing();
			act(() => void session.submit('next', [], 'm'));
			await waitFor(() => expect(asked('next')).toBe(true));
			expect(apis.stopTasksByChatId).toHaveBeenCalledWith('t', 'A');
			expect(session.history.messages.r.done).toBe(true);
			expect(session.queue).toHaveLength(0);
		} finally {
			vi.mocked(usersApi.getUserSettings).mockResolvedValue({ ui: {} } as never);
		}
	});

	it('an action that finishes after another chat opened does not save into that chat (#215)', async () => {
		const router = await openChatA();
		vi.mocked(chatsApi.updateChatById).mockClear();
		let run: Promise<void> | undefined;
		act(() => {
			run = session.runAction('act', session.history.messages['A-m']);
		});
		await act(() => router.navigate('/c/B'));
		await waitFor(() => expect(pending.B).toBeDefined());
		await act(async () => pending.B(undefined));
		await waitFor(() => expect(session.chat?.id).toBe('B'));
		await act(async () => {
			pending.action({ messages: [{ id: 'A-m', content: 'rewritten' }] });
			await run;
		});
		expect(chatsApi.updateChatById).not.toHaveBeenCalled();
		expect(session.history.messages['B-m']?.content).toBe('hello from B');
	});

	const savedTo = () => vi.mocked(chatsApi.updateChatById).mock.calls.map((c) => c[1]);

	it('a rating is saved to its chat, with the feedback id and the tags', async () => {
		await openChatA();
		vi.mocked(chatsApi.updateChatById).mockClear();
		let run: Promise<void> | undefined;
		act(() => {
			run = session.rate(session.history.messages['A-m'], 1);
		});
		await waitFor(() => expect(pending.feedback).toBeDefined());
		await act(async () => {
			pending.feedback({ id: 'fb1' });
			await run;
		});
		expect(session.history.messages['A-m'].feedbackId).toBe('fb1');
		expect(session.history.messages['A-m'].annotation).toMatchObject({ rating: 1, tags: ['tagged'] });
		expect(new Set(savedTo())).toEqual(new Set(['A']));
	});

	it('a rating that finishes after another chat opened is saved to its own chat (#215)', async () => {
		const router = await openChatA();
		vi.mocked(chatsApi.updateChatById).mockClear();
		delete pending.feedback;
		let run: Promise<void> | undefined;
		act(() => {
			run = session.rate(session.history.messages['A-m'], 1);
		});
		await waitFor(() => expect(pending.feedback).toBeDefined());
		await act(() => router.navigate('/c/B'));
		await waitFor(() => expect(pending.B).toBeDefined());
		await act(async () => pending.B(undefined));
		await waitFor(() => expect(session.chat?.id).toBe('B'));
		await act(async () => {
			pending.feedback({ id: 'fb2' });
			await run;
		});
		expect(savedTo()).toEqual(['A']);
		const body = vi.mocked(chatsApi.updateChatById).mock.calls[0][2] as {
			history: { messages: Record<string, Record<string, unknown>> };
		};
		expect(body.history.messages['A-m']).toMatchObject({ feedbackId: 'fb2', annotation: { rating: 1 } });
		expect(session.history.messages['B-m'].annotation).toBeUndefined();
	});
});

describe('useChatSession chat documents (#160)', () => {
	beforeEach(() => {
		useAuthStore.setState({ token: 't' } as never);
		probeModels = [{ id: 'm' }];
	});
	afterEach(() => {
		probeModels = [];
	});

	it('a document from another branch is neither sent nor kept', async () => {
		const send = vi.mocked((await import('@/lib/apis/openai')).generateOpenAIChatCompletion);
		send.mockClear();
		renderAt('F');
		await waitFor(() => expect(pending.F).toBeDefined());
		await act(async () => pending.F({ task_ids: [] }));
		await waitFor(() => expect(session.chatFiles).toEqual([DOC]));

		await act(async () => void (await session.submit('next', [], 'm')));

		await waitFor(() => expect(send).toHaveBeenCalled());
		const body = send.mock.calls.at(-1)?.[1] as { files?: unknown } | undefined;
		expect(body).toBeDefined();
		expect(body?.files).toBeUndefined();
		expect(session.chatFiles).toEqual([]);
	});
});
