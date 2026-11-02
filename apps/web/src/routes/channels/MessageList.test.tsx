import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Channel } from './channelModel';
import { MessageList } from './MessageList';

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

	it('shows the loader, not the retry, while older history is still to load', () => {
		render(<MessageList channel={channel} messages={[]} top={false} onLoadMore={() => {}} actions={{}} />);
		expect(screen.getByText('Loading...')).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
	});
});
