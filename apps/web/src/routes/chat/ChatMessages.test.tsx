import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { History, Message } from '@/lib/chat/history';
import { type MessageHandlers, ResponseMessage } from './ChatMessages';

vi.mock('./useModels', () => ({ useModels: () => ({ models: [] }) }));
vi.mock('@/lib/settings/userSettings', () => ({ useUserSettings: () => ({ settings: {} }) }));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'u1', name: 'Test User' } })
}));

const reply: Message = {
	id: 'a1',
	parentId: null,
	childrenIds: [],
	role: 'assistant',
	content: 'Cats are mammals.',
	done: true,
	model: 'm1',
	sources: [
		{ source: { name: 'Cats' }, document: ['cats purr'], metadata: [{ source: 'https://a.example/cats' }] },
		{ source: { name: 'Dogs' }, document: ['dogs bark'], metadata: [{ source: 'https://b.example/dogs' }] }
	] as Message['sources'],
	followUps: ['Why do they purr?', 'What do they eat?']
};

function show(message: Message, over: Partial<MessageHandlers> = {}) {
	const h: MessageHandlers = {
		onBranch: vi.fn(),
		onRegenerate: vi.fn(),
		onFollowUp: vi.fn(),
		onSourceClick: vi.fn(),
		...over
	};
	const history: History = { messages: { [message.id]: message }, currentId: message.id };
	render(
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider>
				<MemoryRouter>
					<ResponseMessage history={history} message={message} h={h} isLast chatId="c1" />
				</MemoryRouter>
			</TooltipProvider>
		</QueryClientProvider>
	);
	return h;
}

afterEach(cleanup);

describe('ResponseMessage sources', () => {
	it('counts the sources on a button that expands to one numbered button each', () => {
		show(reply);
		const toggle = screen.getByRole('button', { name: '2 Sources' });
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		expect(screen.queryByRole('button', { name: /b.example\/dogs/ })).toBeNull();
		fireEvent.click(toggle);
		expect(toggle.getAttribute('aria-expanded')).toBe('true');
		expect(screen.getByRole('button', { name: /a.example\/cats/ })).toBeTruthy();
		expect(screen.getByRole('button', { name: /b.example\/dogs/ })).toBeTruthy();
	});

	it('reports which source was opened, counting from 1', () => {
		const h = show(reply);
		fireEvent.click(screen.getByRole('button', { name: '2 Sources' }));
		fireEvent.click(screen.getByRole('button', { name: /b.example\/dogs/ }));
		expect(h.onSourceClick).toHaveBeenCalledWith(reply, 2);
	});

	it('says "1 Source" for a single source', () => {
		show({ ...reply, sources: reply.sources?.slice(0, 1) });
		expect(screen.getByRole('button', { name: '1 Source' })).toBeTruthy();
	});
});

describe('ResponseMessage follow-ups', () => {
	it('offers each suggested follow-up as a button that sends it', () => {
		const h = show(reply);
		fireEvent.click(screen.getByRole('button', { name: 'What do they eat?' }));
		expect(h.onFollowUp).toHaveBeenCalledExactlyOnceWith('What do they eat?');
		expect(screen.getByRole('button', { name: 'Why do they purr?' })).toBeTruthy();
	});

	it('offers none while the reply is still streaming', () => {
		show({ ...reply, done: false });
		expect(screen.queryByRole('button', { name: 'What do they eat?' })).toBeNull();
	});
});
