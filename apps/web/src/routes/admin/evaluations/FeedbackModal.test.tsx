import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFeedbackById } from '@/lib/apis/evaluations';
import { useAuthStore } from '@/lib/stores/authStore';
import { type FeedbackItem, FeedbackModal } from './FeedbackModal';

vi.mock('@/lib/apis/evaluations', () => ({ getFeedbackById: vi.fn() }));

const FEEDBACK: FeedbackItem = {
	id: 'f1',
	meta: { chat_id: 'chat-9', message_id: 'm2' },
	data: {
		model_id: 'qwen/qwen3.6-27b',
		rating: -1,
		reason: 'Too long',
		comment: 'Rambles',
		tags: ['verbose', 'slow'],
		details: { rating: 1 }
	},
	updated_at: 1700000000
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getFeedbackById).mockResolvedValue({
		meta: { message_id: 'm2' },
		snapshot: {
			chat: {
				chat: { history: { messages: { m1: { content: 'What is 2+2?' }, m2: { content: 'Four.', parentId: 'm1' } } } }
			}
		}
	} as never);
	useAuthStore.setState({ token: 'tok' } as never);
});

const renderModal = () => {
	const onOpenChange = vi.fn();
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<FeedbackModal open onOpenChange={onOpenChange} feedback={FEEDBACK} />
		</QueryClientProvider>
	);
	return onOpenChange;
};

describe('FeedbackModal', () => {
	it('shows the prompt and the response the feedback was about', async () => {
		renderModal();
		expect(await screen.findByText('What is 2+2?')).toBeTruthy();
		expect(screen.getByText('Four.')).toBeTruthy();
	});

	it('shows the reason, the comment and each tag', async () => {
		renderModal();
		expect(await screen.findByText('Too long')).toBeTruthy();
		expect(screen.getByText('Rambles')).toBeTruthy();
		expect(screen.getByText('verbose')).toBeTruthy();
		expect(screen.getByText('slow')).toBeTruthy();
	});

	it('links the chat the feedback came from', async () => {
		renderModal();
		const link = await screen.findByRole('link', { name: 'Open chat (opens in a new tab)' });
		expect(link.getAttribute('href')).toContain('/s/chat-9');
	});

	it('names the model, the result in words and the date (#1027)', async () => {
		renderModal();
		expect(await screen.findByText('qwen/qwen3.6-27b')).toHaveClass('font-mono');
		expect(screen.getByText('Down')).toBeInTheDocument();
		expect(screen.getByRole('heading', { name: 'Rating details' })).toBeInTheDocument();
		expect(screen.getByText('Rated').nextElementSibling?.querySelector('time')).toHaveAttribute(
			'datetime',
			new Date(1700000000 * 1000).toISOString()
		);
	});

	it('closes from the Close button', async () => {
		const onOpenChange = renderModal();
		const buttons = await screen.findAllByRole('button', { name: 'Close' });
		fireEvent.click(buttons.find((b) => b.textContent === 'Close') as HTMLElement);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
