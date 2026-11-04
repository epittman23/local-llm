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
});
