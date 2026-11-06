import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getChannelMembersById } from '@/lib/apis/channels';
import type { Channel } from './channelModel';
import { MessageComposer } from './MessageComposer';

// #256: the selection reset only when the query text changed, so when the
// suggestion list shrank under it (the debounced user search answering),
// Enter picked a suggestion that was no longer there: it threw, and nothing
// was inserted.

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/apis', () => ({ getModels: vi.fn(async () => []) }));
vi.mock('@/lib/apis/users', () => ({ searchUsers: vi.fn(async () => ({ users: [] })) }));
vi.mock('@/lib/apis/channels', () => ({ getChannelMembersById: vi.fn() }));
vi.mock('./useChannels', () => ({ useChannelList: () => ({ data: [] }) }));

const user = (id: string, name: string) => ({ id, name });
const channel = { id: 'c1', name: 'general', type: 'group' } as unknown as Channel;

describe('MessageComposer mentions (#256)', () => {
	it('Enter picks the last suggestion when the list shrank under the selection', async () => {
		vi.mocked(getChannelMembersById).mockResolvedValue({
			users: [user('u1', 'Ada'), user('u2', 'Alan'), user('u3', 'Alma')]
		});
		const client = new QueryClient();
		render(
			<QueryClientProvider client={client}>
				<MessageComposer
					channel={channel}
					placeholder="Message"
					typingUsers={[]}
					replyTo={null}
					onCancelReply={vi.fn()}
					onTyping={vi.fn()}
					onSubmit={vi.fn()}
				/>
			</QueryClientProvider>
		);
		const box = screen.getByPlaceholderText('Message') as HTMLTextAreaElement;
		fireEvent.change(box, { target: { value: '@a', selectionStart: 2 } });
		fireEvent.select(box, { target: { selectionStart: 2 } });
		await screen.findByRole('option', { name: /Alma/ }, { timeout: 2000 });
		fireEvent.keyDown(box, { key: 'ArrowDown' });
		fireEvent.keyDown(box, { key: 'ArrowDown' });
		expect(screen.getByRole('option', { name: /Alma/ })).toHaveAttribute('aria-selected', 'true');

		// The search answers again with fewer people, the query text unchanged.
		act(() => client.setQueryData(['channel-mention-users', 'c1', 'a'], [user('u1', 'Ada')]));
		await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
		expect(screen.getByRole('option', { name: /Ada/ })).toHaveAttribute('aria-selected', 'true');

		fireEvent.keyDown(box, { key: 'Enter' });
		await waitFor(() => expect(box.value).toBe('@Ada '));
	});

	it('the arrow keys step from the highlighted suggestion after the list shrank', async () => {
		vi.mocked(getChannelMembersById).mockResolvedValue({
			users: [user('u1', 'Ada'), user('u2', 'Alan'), user('u3', 'Alma')]
		});
		const client = new QueryClient();
		render(
			<QueryClientProvider client={client}>
				<MessageComposer
					channel={channel}
					placeholder="Message"
					typingUsers={[]}
					replyTo={null}
					onCancelReply={vi.fn()}
					onTyping={vi.fn()}
					onSubmit={vi.fn()}
				/>
			</QueryClientProvider>
		);
		const box = screen.getByPlaceholderText('Message') as HTMLTextAreaElement;
		fireEvent.change(box, { target: { value: '@a', selectionStart: 2 } });
		fireEvent.select(box, { target: { selectionStart: 2 } });
		await screen.findByRole('option', { name: /Alma/ }, { timeout: 2000 });
		fireEvent.keyDown(box, { key: 'ArrowDown' });
		fireEvent.keyDown(box, { key: 'ArrowDown' });

		act(() => client.setQueryData(['channel-mention-users', 'c1', 'a'], [user('u1', 'Ada'), user('u2', 'Alan')]));
		await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
		expect(screen.getByRole('option', { name: /Alan/ })).toHaveAttribute('aria-selected', 'true');
		// One step up from Alan is Ada, not a step spent on the gone Alma.
		fireEvent.keyDown(box, { key: 'ArrowUp' });
		expect(screen.getByRole('option', { name: /Ada/ })).toHaveAttribute('aria-selected', 'true');
	});

	it('a key typed right after picking a mention stays after it (the caret is placed at once)', async () => {
		// The caret used to be placed a frame later (requestAnimationFrame), so a
		// letter typed before that frame went in after the mention and the
		// frame then put the caret back in front of it: "welcome" was sent as
		// "elcomew" (channels.spec.ts in CI, 2026-11-06).
		vi.mocked(getChannelMembersById).mockResolvedValue({ users: [user('u1', 'Ada')] });
		render(
			<QueryClientProvider client={new QueryClient()}>
				<MessageComposer
					channel={channel}
					placeholder="Message"
					typingUsers={[]}
					replyTo={null}
					onCancelReply={vi.fn()}
					onTyping={vi.fn()}
					onSubmit={vi.fn()}
				/>
			</QueryClientProvider>
		);
		const box = screen.getByPlaceholderText('Message') as HTMLTextAreaElement;
		fireEvent.change(box, { target: { value: '@a', selectionStart: 2 } });
		fireEvent.select(box, { target: { selectionStart: 2 } });
		await screen.findByRole('option', { name: /Ada/ }, { timeout: 2000 });
		fireEvent.keyDown(box, { key: 'Enter' });
		expect(box.value).toBe('@Ada ');
		expect(box.selectionStart).toBe(5);

		// A letter typed before the next frame.
		box.setRangeText('w', 5, 5, 'end');
		fireEvent.change(box, { target: { value: '@Ada w', selectionStart: 6 } });
		await act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
		expect(box.selectionStart).toBe(6);
	});
});
