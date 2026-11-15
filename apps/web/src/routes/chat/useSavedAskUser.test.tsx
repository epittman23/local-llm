// A reply that paused on an ask_user call under native function calling is
// only stored; nothing comes over the socket. The page asks from the stored
// reply and answers through the resolve endpoint, which resumes the reply.
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { History } from '@/lib/chat/history';

const resolveChatMessageToolCall = vi.fn();
const toastError = vi.fn();
vi.mock('@/lib/apis/chats', () => ({
	resolveChatMessageToolCall: (...a: unknown[]) => resolveChatMessageToolCall(...a)
}));
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }));

const { useSavedAskUser } = await import('./useSavedAskUser');

const questions = [{ id: 'q1', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }];
const paused = (output?: unknown[]): History =>
	({
		currentId: 'a',
		messages: {
			q: { id: 'q', parentId: null, childrenIds: ['a'], role: 'user', content: 'q' },
			a: {
				id: 'a',
				parentId: 'q',
				childrenIds: [],
				role: 'assistant',
				content: '',
				done: false,
				output: output ?? [
					{
						type: 'function_call',
						id: 'call_1',
						call_id: 'call_1',
						name: 'ask_user',
						arguments: JSON.stringify({ questions, allow_other: true, timeout_ms: 120000 }),
						status: 'pending'
					}
				]
			}
		}
	}) as unknown as History;

function setup(history: History, chatId: string | null = 'chat-1') {
	const onResolved = vi.fn();
	const props = { history, chatId, token: 't', onResolved };
	const hook = renderHook(() => useSavedAskUser(props));
	return { props, onResolved, ...hook };
}

beforeEach(() => {
	resolveChatMessageToolCall.mockReset().mockResolvedValue({ paused: false });
	toastError.mockReset();
});

describe('useSavedAskUser', () => {
	it('turns the stored question into an ask_user dialog with no time limit', () => {
		const { result } = setup(paused());
		expect(result.current.dialog).toMatchObject({ type: 'ask_user', data: { questions, allow_other: true } });
		expect(result.current.dialog?.data.timeout_ms).toBeUndefined();
	});

	it('asks nothing for a temporary or unsaved chat, or a reply with no question', () => {
		expect(setup(paused(), null).result.current.dialog).toBeNull();
		expect(setup(paused(), 'local:abc').result.current.dialog).toBeNull();
		expect(setup(paused([])).result.current.dialog).toBeNull();
	});

	it('answers through the resolve endpoint, hides the dialog, then reloads', async () => {
		const { result, onResolved } = setup(paused());
		const answers = { q1: { type: 'option', option_index: 0, label: 'A' } };
		act(() => result.current.dialog?.reply({ status: 'answered', answers }));
		expect(result.current.dialog).toBeNull();
		expect(resolveChatMessageToolCall).toHaveBeenCalledExactlyOnceWith('t', 'chat-1', 'a', 'call_1', 'answer', {
			answers
		});
		await waitFor(() => expect(onResolved).toHaveBeenCalledOnce());
	});

	it('rejects the call on Skip or dismissal', async () => {
		const { result, onResolved } = setup(paused());
		act(() => result.current.dialog?.reply({ status: 'cancelled', answers: {} }));
		expect(resolveChatMessageToolCall).toHaveBeenCalledExactlyOnceWith('t', 'chat-1', 'a', 'call_1', 'reject');
		await waitFor(() => expect(onResolved).toHaveBeenCalledOnce());
	});

	it('shows the error and asks again when resolving fails', async () => {
		resolveChatMessageToolCall.mockRejectedValueOnce('Tool call has already been resolved.');
		const { result, onResolved } = setup(paused());
		act(() => result.current.dialog?.reply({ status: 'answered', answers: {} }));
		await waitFor(() => expect(toastError).toHaveBeenCalledWith('Tool call has already been resolved.'));
		expect(onResolved).toHaveBeenCalledOnce();
		expect(result.current.dialog).not.toBeNull();
	});

	it('keeps the same dialog across history updates and new callbacks, so picked answers survive', () => {
		const { result, props, rerender } = setup(paused());
		const first = result.current.dialog;
		props.history = paused();
		props.onResolved = vi.fn();
		rerender();
		expect(result.current.dialog).toBe(first);
	});
});
