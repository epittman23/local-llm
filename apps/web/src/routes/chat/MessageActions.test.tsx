import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { History, Message } from '@/lib/chat/history';
import { chatPrefs } from '@/lib/chat/prefs';
import { useMessageActions } from './MessageActions';

vi.mock('./useModels', () => ({ useModels: () => ({ models: [] }) }));
vi.mock('./useChatPrefs', () => ({ useChatPrefs: () => chatPrefs(null) }));
vi.mock('./useReadAloud', () => ({ useReadAloud: () => ({ speakingId: null, speak: vi.fn(), stop: vi.fn() }) }));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'u1', role: 'admin' } })
}));
vi.mock('@/lib/stores/configStore', () => ({
	useConfigStore: (sel: (s: unknown) => unknown) => sel({ config: { features: {} } })
}));

const user: Message = { id: 'u', parentId: null, childrenIds: ['a'], role: 'user', content: 'hi', done: true };
const reply = (over: Partial<Message> = {}): Message => ({
	id: 'a',
	parentId: 'u',
	childrenIds: [],
	role: 'assistant',
	content: 'hello',
	done: true,
	model: 'm1',
	...over
});

function Harness({ message, session }: { message: Message; session: Parameters<typeof useMessageActions>[0] }) {
	const h = useMessageActions(session);
	return (
		<div>
			{h.editing?.(message)}
			{h.extraActions?.(message, { isLast: true })}
			{h.below?.(message)}
		</div>
	);
}

function show(message: Message, over: Partial<Parameters<typeof useMessageActions>[0]> = {}) {
	const history: History = { messages: { u: user, [message.id]: message }, currentId: message.id };
	const session = {
		chatId: 'c1',
		history,
		editMessage: vi.fn(async () => undefined),
		removeMessage: vi.fn(async () => undefined),
		continueReply: vi.fn(async () => undefined),
		regenerate: vi.fn(async () => undefined),
		rate: vi.fn(async () => undefined),
		runAction: vi.fn(async () => undefined),
		...over
	};
	render(
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider>
				<Harness message={message} session={session} />
			</TooltipProvider>
		</QueryClientProvider>
	);
	return session;
}

afterEach(cleanup);

describe('message actions', () => {
	it('opens the editor from Edit', () => {
		show(reply());
		fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
		expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
	});

	it('asks before deleting, then removes the message', async () => {
		const session = show(reply());
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		expect(session.removeMessage).not.toHaveBeenCalled();
		const dialog = await screen.findByRole('alertdialog');
		fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
		await waitFor(() => expect(session.removeMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' })));
	});

	it('rates a reply good, which opens the feedback form', async () => {
		const session = show(reply());
		fireEvent.click(screen.getByRole('button', { name: 'Good Response' }));
		await waitFor(() => expect(session.rate).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 1));
	});

	it('rates a reply bad', async () => {
		const session = show(reply());
		fireEvent.click(screen.getByRole('button', { name: 'Bad Response' }));
		await waitFor(() => expect(session.rate).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), -1));
	});

	it('marks a bad rating as pressed instead of the good one', () => {
		show(reply({ annotation: { rating: -1 } }));
		expect(screen.getByRole('button', { name: 'Bad Response' }).getAttribute('aria-pressed')).toBe('true');
		expect(screen.getByRole('button', { name: 'Good Response' }).getAttribute('aria-pressed')).toBe('false');
	});

	it('marks the rating given as pressed', () => {
		show(reply({ annotation: { rating: 1 } }));
		expect(screen.getByRole('button', { name: 'Good Response' }).getAttribute('aria-pressed')).toBe('true');
		expect(screen.getByRole('button', { name: 'Bad Response' }).getAttribute('aria-pressed')).toBe('false');
	});
});

describe('the rating form', () => {
	const rated = () => reply({ annotation: { rating: 1 } });

	async function open(message = rated()) {
		const session = show(message);
		fireEvent.click(screen.getByRole('button', { name: 'Good Response' }));
		await screen.findByTestId('rate-comment');
		return session;
	}

	it('opens after a rating and closes with its Close button', async () => {
		await open();
		fireEvent.click(screen.getByRole('button', { name: 'Close feedback' }));
		expect(screen.queryByTestId('rate-comment')).toBeNull();
	});

	it('marks the chosen score 1 to 10 as pressed, one at a time', async () => {
		await open();
		expect(screen.getAllByRole('button', { name: /^Rate \d+ out of 10$/ })).toHaveLength(10);
		fireEvent.click(screen.getByRole('button', { name: 'Rate 7 out of 10' }));
		expect(screen.getByRole('button', { name: 'Rate 7 out of 10' }).getAttribute('aria-pressed')).toBe('true');
		fireEvent.click(screen.getByRole('button', { name: 'Rate 3 out of 10' }));
		expect(screen.getByRole('button', { name: 'Rate 7 out of 10' }).getAttribute('aria-pressed')).toBe('false');
	});

	it('offers reasons for a good rating, marking the chosen one pressed', async () => {
		await open();
		const reasons = within(screen.getByTestId('rate-comment'))
			.getAllByRole('button')
			.filter((b) => b.hasAttribute('aria-pressed') && !/^Rate /.test(b.getAttribute('aria-label') ?? ''));
		expect(reasons.length).toBeGreaterThan(0);
		fireEvent.click(reasons[0]);
		expect(reasons[0].getAttribute('aria-pressed')).toBe('true');
	});
});
