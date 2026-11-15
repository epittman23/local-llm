import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { History, Message } from '@/lib/chat/history';
import { ChatMessages, type MessageHandlers, ResponseMessage } from './ChatMessages';

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

function wrap(children: ReactNode) {
	return (
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider>
				<MemoryRouter>{children}</MemoryRouter>
			</TooltipProvider>
		</QueryClientProvider>
	);
}

function handlers(over: Partial<MessageHandlers> = {}): MessageHandlers {
	return { onBranch: vi.fn(), onRegenerate: vi.fn(), onFollowUp: vi.fn(), onSourceClick: vi.fn(), ...over };
}

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
	it('offers each suggested follow-up as an outlined button under "Suggested follow-ups" (#1087)', () => {
		const h = show(reply);
		const group = screen.getByRole('list', { name: 'Suggested follow-ups' });
		const button = within(group).getByRole('button', { name: 'What do they eat?' });
		expect(button.getAttribute('data-variant')).toBe('outline');
		fireEvent.click(button);
		expect(h.onFollowUp).toHaveBeenCalledExactlyOnceWith('What do they eat?');
		expect(screen.getByRole('button', { name: 'Why do they purr?' })).toBeTruthy();
	});

	it('offers none while the reply is still streaming', () => {
		show({ ...reply, done: false });
		expect(screen.queryByRole('button', { name: 'What do they eat?' })).toBeNull();
	});
});

describe('a reply’s name line and actions', () => {
	it('keeps its actions shown, muted, rather than hidden until hover (#902)', () => {
		show(reply);
		const row = screen.getByRole('button', { name: 'Copy' }).parentElement as HTMLElement;
		expect(row.className).toContain('text-foreground-muted');
		expect(row.className).not.toMatch(/opacity-0/);
	});

	it('shows the time beside the name, with the exact time in its title, and truncates the name (#1067)', () => {
		const at = Math.floor(Date.now() / 1000) - 120;
		show({ ...reply, model: 'qwen/qwen-2.5-coder-32b-instruct', timestamp: at });
		const time = document.querySelector('time') as HTMLTimeElement;
		expect(time.textContent).toBe('2 minutes ago');
		expect(time.getAttribute('title')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
		expect(time.className).not.toContain('invisible');
		const name = screen.getByText('qwen/qwen-2.5-coder-32b-instruct');
		expect(name.className).toContain('truncate');
		expect(name.getAttribute('title')).toBe('qwen/qwen-2.5-coder-32b-instruct');
	});
});

describe('a failed reply (#992)', () => {
	const failed: Message = {
		...reply,
		content: '',
		sources: [],
		followUps: [],
		error: { content: 'Uh-oh! There was an issue with the response.\nThe upstream model is overloaded.' }
	};

	it('says the model did not answer, with the provider’s words, and offers Retry and Try another model', () => {
		const onRetry = vi.fn();
		const onTryAnotherModel = vi.fn();
		show(failed, { onRetry, onTryAnotherModel });
		const alert = screen.getByRole('alert');
		expect(alert.textContent).toContain("The model didn't answer");
		expect(alert.textContent).toContain('The upstream model is overloaded.');
		expect(alert.textContent).not.toContain('Uh-oh');
		fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
		expect(onRetry).toHaveBeenCalledWith(failed);
		fireEvent.click(within(alert).getByRole('button', { name: 'Try another model' }));
		expect(onTryAnotherModel).toHaveBeenCalled();
	});

	it('offers no Copy or Regenerate for it, and neither labelled button without its handler', () => {
		show(failed);
		expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Regenerate' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Try another model' })).toBeNull();
	});

	it('tells the extra actions it is only an error', () => {
		const extraActions = vi.fn(() => null);
		show(failed, { extraActions });
		expect(extraActions).toHaveBeenCalledWith(failed, { isLast: true, errorOnly: true, cutOff: false });
	});
});

describe('a reply that ended early (#1081)', () => {
	const stopped: Message = { ...reply, sources: [], followUps: [], stopped: true };

	it('says Stopped, then offers Continue and Regenerate by name in place of the row’s Regenerate', () => {
		const onContinue = vi.fn();
		const onRetry = vi.fn();
		const h = show(stopped, { onContinue, onRetry });
		const line = screen.getByTestId('cut-off');
		expect(line.textContent).toContain('Stopped');
		fireEvent.click(within(line).getByRole('button', { name: 'Continue' }));
		expect(onContinue).toHaveBeenCalledWith(stopped);
		fireEvent.click(within(line).getByRole('button', { name: 'Regenerate' }));
		expect(onRetry).toHaveBeenCalledWith(stopped);
		expect(screen.getAllByRole('button', { name: 'Regenerate' })).toHaveLength(1);
		expect(h.onRegenerate).not.toHaveBeenCalled();
	});

	it('says it reached the token limit for a reply cut off by length', () => {
		show({ ...stopped, stopped: undefined, finish_reason: 'length' });
		expect(screen.getByTestId('cut-off').textContent).toContain('Reached the token limit');
	});

	it('says nothing for a reply that ended on its own', () => {
		show({ ...stopped, stopped: undefined, finish_reason: 'stop' });
		expect(screen.queryByTestId('cut-off')).toBeNull();
	});
});

describe('replies from two models side by side (#945, #991)', () => {
	const msg = (id: string, over: Partial<Message>): Message => ({
		id,
		parentId: 'u',
		childrenIds: [],
		role: 'assistant',
		content: `answer ${id}`,
		done: true,
		...over
	});
	const history: History = {
		currentId: 'a2',
		messages: {
			u: {
				id: 'u',
				parentId: null,
				childrenIds: ['a1', 'b1', 'a2'],
				role: 'user',
				content: 'compare',
				models: ['ma', 'mb']
			},
			a1: msg('a1', { model: 'ma', modelIdx: 0 }),
			b1: msg('b1', { model: 'mb', modelIdx: 1 }),
			a2: msg('a2', { model: 'ma', modelIdx: 0 })
		}
	};

	function showTurn(h = handlers()) {
		render(wrap(<ChatMessages history={history} h={h} chatId="c1" />));
		return { h, columns: screen.getAllByTestId('response-message') };
	}

	it('pages each column through its own model’s versions only', () => {
		const { columns } = showTurn();
		expect(within(columns[0]).getByLabelText('Versions').textContent).toContain('2/2');
		expect(within(columns[1]).queryByLabelText('Versions')).toBeNull();
	});

	it('marks the column the chat continues from Selected, and lets another be chosen by name', () => {
		const { h, columns } = showTurn();
		expect(within(columns[0]).getByText('Selected')).toBeTruthy();
		fireEvent.click(within(columns[1]).getByRole('button', { name: 'Continue with this answer' }));
		expect(h.onBranch).toHaveBeenCalledWith({ ...history, currentId: 'b1' });
	});

	it('gives every column its own actions, draws none dimmed, and widens the turn past the reading column', () => {
		const { columns } = showTurn();
		for (const c of columns) expect(within(c).getByRole('button', { name: 'Copy' })).toBeTruthy();
		const turn = screen.getByTestId('multi-response');
		expect(turn.parentElement?.className).toContain('max-w-6xl');
		expect(turn.innerHTML).not.toContain('opacity-80');
		expect(screen.getByTestId('chat-column').className).not.toContain('max-w-3xl');
	});
});
