import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as apis from '@/lib/apis';
import * as chatsApi from '@/lib/apis/chats';
import * as usersApi from '@/lib/apis/users';
import { updateMessage } from '@/lib/chat/history';
import { getOutputText } from '@/lib/chat/structuredOutput';
import { useAuthStore } from '@/lib/stores/authStore';
import { useChatSession } from './useChatSession';

// docs/history/bug-review-2026-09-27.md H3: a slow load of the chat the user just
// left must not overwrite the one now open.

const pending: Record<string, (v: unknown) => void> = {};

vi.mock('@/lib/apis/chats', async (orig) => ({
	...(await orig<object>()),
	getChatById: vi.fn(async (_t: string, id: string) => ({
		id,
		chat: {
			title: `chat ${id}`,
			models: [`model-${id}`],
			history:
				id === 'M'
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
	stopTask: vi.fn(async () => true),
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
/** The models selected, when not all of `probeModels`. */
let probeSelected: string[] | null = null;

function Probe({ id }: { id: string | undefined }) {
	session = useChatSession({
		routeChatId: id ?? null,
		folderId: null,
		models: probeModels as never,
		selectedModels: probeSelected ?? probeModels.map((m) => m.id),
		temporary: false,
		toggles: { webSearch: false, imageGeneration: false, codeInterpreter: false },
		toolIds: []
	});
	return null;
}

function Route() {
	return <Probe id={useParams().id} />;
}

/** Renders the session at chat `id`, or at a new chat (`/`) when `id` is null. */
function renderAt(id: string | null) {
	const client = new QueryClient();
	const router = createMemoryRouter(
		[
			{ path: '/', element: <Route /> },
			{ path: '/c/:id', element: <Route /> }
		],
		{ initialEntries: [id ? `/c/${id}` : '/'] }
	);
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

	it('a queued prompt waits while another chat is open, then goes in its own chat (#218)', async () => {
		const router = await openChatA();
		writing();
		act(() => void session.submit('next', [], 'm'));
		expect(session.queue).toHaveLength(1);

		await act(() => router.navigate('/c/B'));
		await waitFor(() => expect(pending.B).toBeDefined());
		await act(async () => pending.B(undefined));
		await waitFor(() => expect(session.chat?.id).toBe('B'));
		// Not shown, and not sent, in the chat opened meanwhile.
		expect(session.queue).toHaveLength(0);
		expect(asked('next')).toBe(false);

		delete pending.A;
		await act(() => router.navigate('/c/A'));
		await waitFor(() => expect(pending.A).toBeDefined());
		await act(async () => pending.A(undefined));
		await waitFor(() => expect(session.chat?.id).toBe('A'));
		await waitFor(() => expect(asked('next')).toBe(true));
		expect(session.queue).toHaveLength(0);
	});

	it("a queued prompt goes to its own chat's models, not those of the chat opened meanwhile (#218)", async () => {
		probeModels = [{ id: 'mA' }, { id: 'mB' }];
		probeSelected = ['mA'];
		try {
			const router = await openChatA();
			writing();
			act(() => void session.submit('next'));
			expect(session.queue).toHaveLength(1);

			// Chat B uses another model; ChatPage selects it when B opens.
			probeSelected = ['mB'];
			await act(() => router.navigate('/c/B'));
			await waitFor(() => expect(pending.B).toBeDefined());
			await act(async () => pending.B(undefined));
			await waitFor(() => expect(session.chat?.id).toBe('B'));

			const send = vi.mocked((await import('@/lib/apis/openai')).generateOpenAIChatCompletion);
			send.mockClear();
			delete pending.A;
			await act(() => router.navigate('/c/A'));
			await waitFor(() => expect(pending.A).toBeDefined());
			await act(async () => pending.A(undefined));
			await waitFor(() => expect(send).toHaveBeenCalled());

			const asked = Object.values(session.history.messages).find((m) => m.content === 'next');
			expect(asked?.models).toEqual(['mA']);
			expect(send.mock.calls[0][1]).toMatchObject({ model: 'mA' });
		} finally {
			probeModels = [];
			probeSelected = null;
		}
	});

	it('a queued prompt is dropped, with a message, when its chat cannot be opened again (#218)', async () => {
		const router = await openChatA();
		writing();
		act(() => void session.submit('next', [], 'm'));
		await act(() => router.navigate('/c/B'));
		await waitFor(() => expect(pending.B).toBeDefined());
		await act(async () => pending.B(undefined));
		await waitFor(() => expect(session.chat?.id).toBe('B'));

		const send = vi.mocked((await import('@/lib/apis/openai')).generateOpenAIChatCompletion);
		send.mockClear();
		vi.mocked(chatsApi.getChatById).mockRejectedValueOnce(new Error('gone'));
		await act(() => router.navigate('/c/A'));
		await act(async () => {});

		expect(session.queue).toHaveLength(0);
		expect(send).not.toHaveBeenCalled();
		expect(asked('next')).toBe(false);
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

	/** Opens chat B from wherever the test is, and waits for it to load. */
	async function openChatB(router: ReturnType<typeof renderAt>) {
		await act(() => router.navigate('/c/B'));
		await waitFor(() => expect(pending.B).toBeDefined());
		await act(async () => pending.B(undefined));
		await waitFor(() => expect(session.chat?.id).toBe('B'));
	}

	/** Opens chat A, starts a reply there whose POST answers only when told, then opens chat B. */
	async function startInAThenOpenB(start: () => void, setup?: () => void) {
		const { send, answer } = await holdNextPost();
		const router = await openChatA();
		if (setup) act(setup);
		act(start);
		await waitFor(() => expect(send).toHaveBeenCalled());
		await openChatB(router);
		return (value: unknown) => act(async () => answer.resolve(value));
	}

	/** Sends in a new chat (`/`), opens chat B before the POST answers, then goes back to a new chat. */
	async function sendInNewChatThenLeave() {
		const { send, answer } = await holdNextPost();
		const router = renderAt(null);
		await waitFor(() => expect(session.loading).toBe(false));
		act(() => session.setParams({ temperature: 0.2 }));
		act(() => void session.submit('first', [], 'm'));
		await waitFor(() => expect(send).toHaveBeenCalled());
		await openChatB(router);
		await act(() => router.navigate('/'));
		await waitFor(() => expect(session.chat).toBeNull());
		return { router, answer: (value: unknown) => act(async () => answer.resolve(value)) };
	}

	it('a new chat whose POST answers while the user is still in it is opened at its id', async () => {
		probeModels = [{ id: 'm' }];
		try {
			const { send, answer } = await holdNextPost();
			const router = renderAt(null);
			await waitFor(() => expect(session.loading).toBe(false));
			act(() => void session.submit('first', [], 'm'));
			await waitFor(() => expect(send).toHaveBeenCalled());
			await act(async () => answer.resolve({ chat_id: 'X', task_ids: ['t1'] }));

			await waitFor(() => expect(router.state.location.pathname).toBe('/c/X'));
			expect(session.taskIds).toEqual(['t1']);
			expect(Object.values(session.history.messages).map((m) => m.content)).toContain('first');
		} finally {
			probeModels = [];
		}
	});

	it('a new chat left before its POST answers is not opened when the user starts another (#515)', async () => {
		probeModels = [{ id: 'm' }];
		try {
			const { router, answer } = await sendInNewChatThenLeave();
			await answer({ chat_id: 'X', task_ids: ['t1'] });

			expect(router.state.location.pathname).toBe('/');
			expect(session.taskIds).toBeNull();
			expect(Object.keys(session.history.messages)).toHaveLength(0);
		} finally {
			probeModels = [];
		}
	});

	it('a new chat left before its POST answers is still listed and keeps its params (#515)', async () => {
		probeModels = [{ id: 'm' }];
		const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
		vi.mocked(chatsApi.updateChatById).mockClear();
		try {
			const { answer } = await sendInNewChatThenLeave();
			invalidate.mockClear();
			await answer({ chat_id: 'X', task_ids: ['t1'] });

			expect(invalidate).toHaveBeenCalledWith({ queryKey: ['chats'] });
			expect(chatsApi.updateChatById).toHaveBeenCalledWith('t', 'X', { params: { temperature: 0.2 } });
		} finally {
			invalidate.mockRestore();
			probeModels = [];
		}
	});

	it('stopping in a new chat does not cancel the tasks of a reply in the chat left (#515)', async () => {
		probeModels = [{ id: 'm' }];
		try {
			const { send, answer } = await holdNextPost();
			const router = await openChatA();
			act(() => void session.submit('in A', [], 'm'));
			await waitFor(() => expect(send).toHaveBeenCalled());
			await act(() => router.navigate('/'));
			await waitFor(() => expect(session.chat).toBeNull());
			await act(async () => answer.resolve({ task_ids: ['tA'] }));
			vi.mocked(apis.stopTask).mockClear();

			await act(() => session.stop());

			expect(apis.stopTask).not.toHaveBeenCalled();
		} finally {
			probeModels = [];
		}
	});

	it('a reply started before another chat opened does not put its tasks in that chat (#515)', async () => {
		probeModels = [{ id: 'm' }];
		try {
			const answer = await startInAThenOpenB(() => void session.submit('in A', [], 'm'));
			await answer({ task_ids: ['tA'] });

			expect(session.taskIds).toBeNull();
			expect(session.generating).toBe(false);
		} finally {
			probeModels = [];
		}
	});

	it('a continue started before another chat opened does not put its tasks there (#515)', async () => {
		probeModels = [{ id: 'm' }];
		try {
			const answer = await startInAThenOpenB(
				() => void session.continueReply(session.history.messages.r),
				() =>
					session.setHistory((h) => ({
						currentId: 'r',
						messages: {
							...h.messages,
							'A-m': { ...h.messages['A-m'], childrenIds: ['r'] },
							r: {
								id: 'r',
								parentId: 'A-m',
								childrenIds: [],
								role: 'assistant',
								content: 'half',
								done: true,
								model: 'm'
							}
						}
					}))
			);
			await answer({ task_ids: ['tA'] });

			expect(session.taskIds).toBeNull();
		} finally {
			probeModels = [];
		}
	});

	it("an action's new text replaces the reply's output text too, which the next request reads (#502)", async () => {
		await openChatA();
		const before = session.history.messages['A-m'];
		act(() =>
			session.setHistory((h) =>
				updateMessage(h, 'A-m', {
					output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: before.content }] }]
				})
			)
		);
		let run: Promise<void> | undefined;
		act(() => {
			run = session.runAction('act', session.history.messages['A-m']);
		});
		await waitFor(() => expect(pending.action).toBeDefined());
		await act(async () => {
			pending.action({ messages: [{ id: 'A-m', content: 'rewritten' }] });
			await run;
		});

		const after = session.history.messages['A-m'];
		expect(after.content).toBe('rewritten');
		expect(after.originalContent).toBe(before.content);
		expect(getOutputText(after.output)).toBe('rewritten');
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

	/** The next completion POST, held until the test answers it. */
	async function holdNextPost() {
		const send = vi.mocked((await import('@/lib/apis/openai')).generateOpenAIChatCompletion);
		send.mockClear();
		const answer: { resolve: (v: unknown) => void } = { resolve: () => undefined };
		send.mockImplementationOnce(() => new Promise((r) => (answer.resolve = r)) as never);
		return { send, answer };
	}

	it.each([
		['the request is refused', (send: ReturnType<typeof vi.fn>) => send.mockRejectedValueOnce(new Error('offline'))],
		['the response is an error', (send: ReturnType<typeof vi.fn>) => send.mockResolvedValueOnce({ error: 'no key' })]
	])('a multi-model send whose %s fails every column and stops generating (#216)', async (_case, fail) => {
		probeModels = [{ id: 'm1' }, { id: 'm2' }];
		try {
			await openChatA();
			const send = vi.mocked((await import('@/lib/apis/openai')).generateOpenAIChatCompletion);
			send.mockClear();
			fail(send as never);
			act(() => void session.submit('both'));
			await waitFor(() => expect(send).toHaveBeenCalled());

			await waitFor(() => {
				const replies = Object.values(session.history.messages).filter((m) => m.role === 'assistant');
				expect(replies).toHaveLength(2);
				for (const reply of replies) expect(reply).toMatchObject({ done: true, error: expect.anything() });
			});
			expect(session.generating).toBe(false);
		} finally {
			probeModels = [];
		}
	});

	it('in a saved chat, a stop pressed before the task exists stops it once it does (#151)', async () => {
		probeModels = [{ id: 'm' }];
		try {
			await openChatA();
			const { send, answer } = await holdNextPost();
			act(() => void session.submit('next', [], 'm'));
			await waitFor(() => expect(send).toHaveBeenCalled());

			await act(async () => session.stop());
			vi.mocked(apis.stopTasksByChatId).mockClear();
			await act(async () => answer.resolve({ task_ids: ['t1'] }));

			// By chat id, which the chat's owner may use; stopping one task by id is admin-only.
			expect(apis.stopTasksByChatId).toHaveBeenCalledWith('t', 'A');
			expect(session.taskIds).toBeNull();
		} finally {
			probeModels = [];
		}
	});

	it('a send after a stop waits for the stopped request to cancel its tasks first (#516)', async () => {
		probeModels = [{ id: 'm' }];
		try {
			await openChatA();
			const first = await holdNextPost();
			act(() => void session.submit('first', [], 'm'));
			await waitFor(() => expect(first.send).toHaveBeenCalledTimes(1));
			await act(async () => session.stop());
			vi.mocked(apis.stopTasksByChatId).mockClear();

			first.send.mockImplementationOnce(async () => ({ task_ids: ['t2'] }) as never);
			act(() => void session.submit('second', [], 'm'));
			await waitFor(() => expect(asked('second')).toBe(true));
			await act(async () => {});
			// Cancelling the first request's tasks by chat id would also take the
			// second reply, so the second POST waits for it.
			expect(first.send).toHaveBeenCalledTimes(1);

			await act(async () => first.answer.resolve({ task_ids: ['t1'] }));
			await waitFor(() => expect(first.send).toHaveBeenCalledTimes(2));
			expect(apis.stopTasksByChatId).toHaveBeenCalledWith('t', 'A');
			expect(vi.mocked(apis.stopTasksByChatId).mock.invocationCallOrder[0]).toBeLessThan(
				first.send.mock.invocationCallOrder[1]
			);
			await waitFor(() => expect(session.taskIds).toEqual(['t2']));
		} finally {
			probeModels = [];
		}
	});

	it('a send still waiting when another chat opens is not sent (#516)', async () => {
		probeModels = [{ id: 'm' }];
		try {
			const router = await openChatA();
			const first = await holdNextPost();
			act(() => void session.submit('first', [], 'm'));
			await waitFor(() => expect(first.send).toHaveBeenCalledTimes(1));
			await act(async () => session.stop());
			act(() => void session.submit('second', [], 'm'));
			await waitFor(() => expect(asked('second')).toBe(true));

			await act(async () => router.navigate('/c/B'));
			await waitFor(() => expect(pending.B).toBeDefined());
			await act(async () => pending.B(undefined));
			await act(async () => first.answer.resolve({ task_ids: ['t1'] }));
			await act(async () => {});

			// The waiting send would have been built from chat B's history.
			expect(first.send).toHaveBeenCalledTimes(1);
		} finally {
			probeModels = [];
		}
	});

	it('a stop in the chat opened next does not cancel the chat left behind (#151)', async () => {
		probeModels = [{ id: 'm' }];
		try {
			const router = await openChatA();
			const { send, answer } = await holdNextPost();
			act(() => void session.submit('next', [], 'm'));
			await waitFor(() => expect(send).toHaveBeenCalled());

			await act(async () => router.navigate('/c/B'));
			await waitFor(() => expect(pending.B).toBeDefined());
			await act(async () => pending.B(undefined));
			await act(async () => session.stop());
			vi.mocked(apis.stopTasksByChatId).mockClear();
			vi.mocked(apis.stopTask).mockClear();
			await act(async () => answer.resolve({ task_ids: ['tA'] }));

			expect(apis.stopTasksByChatId).not.toHaveBeenCalled();
			expect(apis.stopTask).not.toHaveBeenCalled();
		} finally {
			probeModels = [];
		}
	});

	it.each([
		['the POST fails', () => Promise.reject(new Error('offline'))],
		['the server answers with an error', async () => ({ error: { detail: 'model gone' } })]
	])('continuing a reply that fails because %s marks it failed', async (_case, post) => {
		probeModels = [{ id: 'm' }];
		try {
			await openChatA();
			writing();
			act(() => session.setHistory((h) => updateMessage(h, 'r', { done: true, content: 'half', model: 'm' })));
			const send = vi.mocked((await import('@/lib/apis/openai')).generateOpenAIChatCompletion);
			send.mockImplementationOnce(post as never);
			await act(async () => session.continueReply(session.history.messages.r));

			expect(session.history.messages.r.error).toBeTruthy();
			expect(session.taskIds).toBeNull();
		} finally {
			probeModels = [];
		}
	});

	it('continuing a reply is stopped the same way (#151)', async () => {
		probeModels = [{ id: 'm' }];
		try {
			await openChatA();
			writing();
			act(() => session.setHistory((h) => updateMessage(h, 'r', { done: true, content: 'half', model: 'm' })));
			const { send, answer } = await holdNextPost();
			act(() => void session.continueReply(session.history.messages.r));
			await waitFor(() => expect(send).toHaveBeenCalled());

			await act(async () => session.stop());
			vi.mocked(apis.stopTasksByChatId).mockClear();
			await act(async () => answer.resolve({ task_id: 't3' }));

			expect(apis.stopTasksByChatId).toHaveBeenCalledWith('t', 'A');
			expect(session.taskIds).toBeNull();
		} finally {
			probeModels = [];
		}
	});
});
