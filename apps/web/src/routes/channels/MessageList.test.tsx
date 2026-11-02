import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Channel, ChannelMessage } from './channelModel';
import { MessageList } from './MessageList';

vi.mock('./ChannelMessageView', () => ({
	ChannelMessageView: ({ message }: { message: { content: string } }) => <div>{message.content}</div>
}));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'me', name: 'Me', role: 'user' } })
}));

const channel = { id: 'c1', name: 'general', type: 'group', created_at: 0, write_access: true } as unknown as Channel;

describe('MessageList', () => {
	it('offers a retry in place of the channel start when a page failed to load', () => {
		const onLoadMore = vi.fn();
		render(<MessageList channel={channel} messages={[]} top={false} failed onLoadMore={onLoadMore} actions={{}} />);
		expect(screen.queryByText(/very beginning/)).toBeNull();
		expect(screen.queryByText('Loading...')).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		expect(onLoadMore).toHaveBeenCalledTimes(1);
	});

	it('says which messages failed: all of them on the first page, older ones after that', () => {
		const props = { channel, top: false, failed: true, onLoadMore: () => {}, actions: {} };
		const { rerender } = render(<MessageList {...props} messages={[]} />);
		expect(screen.getByText("Couldn't load messages.")).toBeTruthy();
		const loaded = [{ id: 'm1', content: 'hello', created_at: 1, updated_at: 1 }] as ChannelMessage[];
		rerender(<MessageList {...props} messages={loaded} />);
		expect(screen.getByText("Couldn't load older messages.")).toBeTruthy();
		expect(screen.getByText('hello')).toBeTruthy();
	});

	it('shows the loader, not the retry, while older history is still to load', () => {
		render(<MessageList channel={channel} messages={[]} top={false} onLoadMore={() => {}} actions={{}} />);
		expect(screen.getByText('Loading...')).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
	});
});
