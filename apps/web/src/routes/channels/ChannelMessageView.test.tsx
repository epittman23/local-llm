import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ChannelMessageView } from './ChannelMessageView';
import type { ChannelMessage } from './channelModel';

// A model's reply starts empty and shows "Thinking" until it has text. One
// that finished with no text (a reply that ends with reasoning only, say)
// must not spin for good (#329). A failure before the pipeline started is
// saved as the reply's text, which the backend tests check.

vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'me', name: 'Me', role: 'user' } })
}));

const reply = (content: string, meta: ChannelMessage['meta']) =>
	({ id: 'r1', channel_id: 'c1', user_id: 'me', content, meta, created_at: 1, updated_at: 1 }) as ChannelMessage;

const show = (message: ChannelMessage) =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider>
				<MemoryRouter>
					<ChannelMessageView message={message} channelId="c1" showAuthor actions={{}} />
				</MemoryRouter>
			</TooltipProvider>
		</QueryClientProvider>
	);

afterEach(cleanup);

describe('a model reply', () => {
	it('shows "Thinking" while it is empty and not done', () => {
		show(reply('', { model_id: 'calc', model_name: 'Calc' }));
		expect(screen.getByLabelText('Thinking')).toBeTruthy();
	});

	it('says there was no response once it is done and still empty', () => {
		show(reply('', { model_id: 'calc', model_name: 'Calc', done: true }));
		expect(screen.queryByLabelText('Thinking')).toBeNull();
		expect(screen.getByText('No response')).toBeTruthy();
	});

	it('shows only its files when it is done with files and no text', () => {
		const message = {
			...reply('', { model_id: 'calc', model_name: 'Calc', done: true }),
			data: { files: [{ type: 'file', id: 'f1', name: 'answer.csv' }] }
		} as ChannelMessage;
		show(message);
		expect(screen.queryByLabelText('Thinking')).toBeNull();
		expect(screen.queryByText('No response')).toBeNull();
		expect(screen.getByText('answer.csv')).toBeTruthy();
	});
});
