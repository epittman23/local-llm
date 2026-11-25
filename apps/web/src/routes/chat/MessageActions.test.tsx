import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { visibleText } from '@/lib/chat/history';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { History, Message } from '@/lib/chat/history';
import { chatPrefs } from '@/lib/chat/prefs';
import type { ExtraActionsContext } from './ChatMessages';
import { useMessageActions } from './MessageActions';

const state = vi.hoisted(() => ({
	features: {} as Record<string, unknown>,
	models: [] as { id: string; actions?: { id: string; name: string; icon?: string | null }[] }[],
	prefs: {} as Record<string, unknown>
}));

vi.mock('@/lib/apis/notes', () => ({ searchNotes: vi.fn(async () => ({ items: [] })) }));
vi.mock('./useModels', () => ({ useModels: () => ({ models: state.models }) }));
vi.mock('./useChatPrefs', () => ({ useChatPrefs: () => chatPrefs(state.prefs) }));
vi.mock('./useReadAloud', () => ({ useReadAloud: () => ({ speakingId: null, speak: vi.fn(), stop: vi.fn() }) }));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'u1', role: 'admin' } })
}));
vi.mock('@/lib/stores/configStore', () => ({
	useConfigStore: (sel: (s: unknown) => unknown) => sel({ config: { features: state.features } })
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

type Session = Parameters<typeof useMessageActions>[0];

function Harness({ message, session, ctx }: { message: Message; session: Session; ctx: ExtraActionsContext }) {
	const h = useMessageActions(session);
	return (
		<div>
			{h.editing?.(message)}
			{h.extraActions?.(message, ctx)}
			{h.regenerate?.(message)}
			{h.below?.(message)}
			<Button data-testid="retry" onClick={() => h.onRetry?.(message)} />
			<Button data-testid="continue" onClick={() => h.onContinue?.(message)} />
		</div>
	);
}

function show(message: Message, over: Partial<Session> = {}, ctx: ExtraActionsContext = { isLast: true }) {
	const history: History = { messages: { u: user, [message.id]: message }, currentId: message.id };
	const session = {
		chatId: 'c1',
		history,
		editMessage: vi.fn(async () => undefined),
		removeMessage: vi.fn(async () => undefined),
		continueReply: vi.fn(async () => undefined),
		regenerate: vi.fn(async () => undefined),
		rate: vi.fn(async () => undefined),
		unrate: vi.fn(async () => undefined),
		ratingIds: new Set<string>(),
		runAction: vi.fn(async () => undefined),
		...over
	};
	render(
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider>
				<MemoryRouter>
					<Harness message={message} session={session} ctx={ctx} />
				</MemoryRouter>
			</TooltipProvider>
		</QueryClientProvider>
	);
	return session;
}

/** One reply whose session's pending ratings the test sets on each render. */
function BusyHarness({
	message,
	ratingIds,
	rate
}: {
	message: Message;
	ratingIds: ReadonlySet<string>;
	rate: Session['rate'];
}) {
	const session: Session = {
		chatId: 'c1',
		history: { messages: { u: user, [message.id]: message }, currentId: message.id },
		editMessage: async () => undefined,
		removeMessage: async () => undefined,
		continueReply: async () => undefined,
		regenerate: async () => undefined,
		rate,
		unrate: async () => undefined,
		ratingIds,
		runAction: async () => undefined
	};
	return (
		<QueryClientProvider client={busyClient}>
			<TooltipProvider>
				<Harness message={message} session={session} ctx={{ isLast: true }} />
			</TooltipProvider>
		</QueryClientProvider>
	);
}
const busyClient = new QueryClient();

/** Opens a Radix menu the way a keyboard does (jsdom has no pointer events for it). */
async function openMenu(name: string) {
	const trigger = screen.getByRole('button', { name });
	trigger.focus();
	fireEvent.keyDown(trigger, { key: 'Enter' });
	return screen.findByRole('menu');
}

beforeEach(() => {
	state.features = { enable_message_rating: true };
	state.models = [];
	state.prefs = {};
});
afterEach(cleanup);

describe('Save to note on a reply (#1135)', () => {
	it('is in the More actions menu, before Delete, where notes are on, and opens the dialog named for the chat', async () => {
		state.features = { enable_message_rating: true, enable_notes: true };
		show(reply(), { title: 'Sums' });
		const menu = await openMenu('More actions');
		expect(
			within(menu)
				.getAllByRole('menuitem')
				.map((i) => i.textContent)
		).toEqual(['Edit', 'Read aloud', 'Continue', 'Save to note', 'Delete']);
		fireEvent.click(within(menu).getByRole('menuitem', { name: 'Save to note' }));
		expect(await screen.findByRole('dialog', { name: 'Save to note' })).toBeTruthy();
		expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe('Sums');
	});

	it('offers the reply as read, without its reasoning and tool-call blocks', async () => {
		state.features = { enable_message_rating: true, enable_notes: true };
		const content =
			'<details type="reasoning" done="true"><summary>Thought</summary>\n> hmm</details>\nIt is 4\n<details type="tool_calls" done="true"><summary>Tool</summary>x</details>';
		show(reply({ content }));
		fireEvent.click(within(await openMenu('More actions')).getByRole('menuitem', { name: 'Save to note' }));
		await screen.findByRole('dialog', { name: 'Save to note' });
		// What is saved is what Copy copies.
		expect(visibleText(reply({ content }))).toBe('It is 4');
	});

	it('is not offered on a reply that is only reasoning', async () => {
		state.features = { enable_message_rating: true, enable_notes: true };
		show(reply({ content: '<details type="reasoning" done="true"><summary>Thought</summary>x</details>' }));
		expect(within(await openMenu('More actions')).queryByRole('menuitem', { name: 'Save to note' })).toBeNull();
	});

	it('is hidden where notes are off', async () => {
		show(reply());
		expect(within(await openMenu('More actions')).queryByRole('menuitem', { name: 'Save to note' })).toBeNull();
	});

	it('is not offered on a reply with nothing to save', async () => {
		state.features = { enable_message_rating: true, enable_notes: true };
		show(reply({ content: '  ' }));
		expect(within(await openMenu('More actions')).queryByRole('menuitem', { name: 'Save to note' })).toBeNull();
	});
});

describe('a reply’s More actions menu (#995)', () => {
	it('holds Edit, Read aloud, Continue, the model’s actions, then Delete last below a separator', async () => {
		state.models = [{ id: 'm1', actions: [{ id: 'sum', name: 'Summarize', icon: null }] }];
		show(reply());
		const menu = await openMenu('More actions');
		expect(
			within(menu)
				.getAllByRole('menuitem')
				.map((i) => i.textContent)
		).toEqual(['Edit', 'Read aloud', 'Continue', 'Summarize', 'Delete']);
		expect(within(menu).getByRole('separator')).toBeTruthy();
	});

	it('opens the editor from Edit', async () => {
		show(reply());
		fireEvent.click(within(await openMenu('More actions')).getByRole('menuitem', { name: 'Edit' }));
		expect(await screen.findByRole('textbox', { name: 'Edit message' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Save as copy' })).toBeTruthy();
	});

	it('asks before deleting, naming the message, then removes it', async () => {
		const session = show(reply());
		fireEvent.click(within(await openMenu('More actions')).getByRole('menuitem', { name: 'Delete' }));
		expect(session.removeMessage).not.toHaveBeenCalled();
		const dialog = await screen.findByRole('alertdialog', { name: 'Delete message?' });
		expect(dialog.textContent).toContain('This reply and everything after it are deleted.');
		fireEvent.click(within(dialog).getByRole('button', { name: 'Delete message' }));
		await waitFor(() => expect(session.removeMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' })));
	});

	it('runs a model’s action and continues a reply from the menu', async () => {
		state.models = [{ id: 'm1', actions: [{ id: 'sum', name: 'Summarize', icon: 'data:image/svg+xml,x' }] }];
		const session = show(reply());
		fireEvent.click(within(await openMenu('More actions')).getByRole('menuitem', { name: 'Summarize' }));
		expect(session.runAction).toHaveBeenCalledWith('sum', expect.objectContaining({ id: 'a' }));
		fireEvent.click(within(await openMenu('More actions')).getByRole('menuitem', { name: 'Continue' }));
		expect(session.continueReply).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
	});

	it('leaves Continue out for a reply that is not the last, or that says Continue under it already', async () => {
		show(reply(), {}, { isLast: false });
		expect(within(await openMenu('More actions')).queryByRole('menuitem', { name: 'Continue' })).toBeNull();
		cleanup();
		show(reply({ stopped: true }), {}, { isLast: true, cutOff: true });
		expect(within(await openMenu('More actions')).queryByRole('menuitem', { name: 'Continue' })).toBeNull();
	});

	it('offers only Delete for a reply that is only an error, with no thumbs (#992)', async () => {
		show(reply({ content: '', error: { content: 'down' } }), {}, { isLast: true, errorOnly: true });
		expect(screen.queryByRole('button', { name: 'Good response' })).toBeNull();
		const menu = await openMenu('More actions');
		expect(
			within(menu)
				.getAllByRole('menuitem')
				.map((i) => i.textContent)
		).toEqual(['Delete']);
		expect(within(menu).queryByRole('separator')).toBeNull();
	});

	it('shows Generation info for a reply that holds usage', () => {
		show(reply({ usage: { prompt_tokens: 1, completion_tokens: 2 } }));
		expect(screen.getByRole('button', { name: 'Generation info' })).toBeTruthy();
	});

	it('gives a prompt Edit and Delete buttons of its own', async () => {
		const session = show({ ...user, childrenIds: [], parentId: 'root' });
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		const dialog = await screen.findByRole('alertdialog', { name: 'Delete message?' });
		expect(dialog.textContent).toContain('This message and the replies under it are deleted.');
		fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
		fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
		expect(await screen.findByRole('textbox', { name: 'Edit message' })).toBeTruthy();
		expect(session.removeMessage).not.toHaveBeenCalled();
	});
});

describe('rating a reply (S3-D2)', () => {
	it('saves a thumb at once and opens nothing', async () => {
		const session = show(reply());
		fireEvent.click(screen.getByRole('button', { name: 'Good response' }));
		await waitFor(() => expect(session.rate).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 1));
		expect(screen.queryByTestId('rate-note')).toBeNull();
	});

	it('rates a reply bad', async () => {
		const session = show(reply());
		fireEvent.click(screen.getByRole('button', { name: 'Bad response' }));
		await waitFor(() => expect(session.rate).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), -1));
	});

	it('names the given rating "Rated" and marks it pressed', () => {
		show(reply({ annotation: { rating: -1 } }));
		expect(screen.getByRole('button', { name: 'Rated bad' }).getAttribute('aria-pressed')).toBe('true');
		expect(screen.getByRole('button', { name: 'Good response' }).getAttribute('aria-pressed')).toBe('false');
	});

	it('removes the given rating when its thumb is pressed again, closing its note (S3-D2b)', async () => {
		const session = show(reply({ annotation: { rating: 1 } }));
		expect(screen.getByRole('button', { name: 'Bad response' }).getAttribute('aria-pressed')).toBe('false');
		fireEvent.click(screen.getByRole('button', { name: 'Add a note' }));
		expect(await screen.findByTestId('rate-note')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Rated good' }));
		expect(session.rate).not.toHaveBeenCalled();
		expect(session.unrate).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
		expect(screen.queryByTestId('rate-note')).toBeNull();
	});

	it('makes both thumbs and the note wait while the rating is saved (ACT-5)', async () => {
		const session = show(reply({ annotation: { rating: 1 } }), { ratingIds: new Set(['a']) });
		fireEvent.click(screen.getByRole('button', { name: 'Add a note' }));
		expect(await screen.findByTestId('rate-note')).toBeTruthy();
		for (const name of ['Rated good', 'Bad response', 'Save note']) {
			const button = screen.getByRole('button', { name });
			expect(button.getAttribute('aria-disabled')).toBe('true');
			fireEvent.click(button);
		}
		expect(session.rate).not.toHaveBeenCalled();
		expect(session.unrate).not.toHaveBeenCalled();
	});

	it('shows the pressed thumb busy until its rating is saved (ACT-5)', async () => {
		const message = reply();
		const rate = vi.fn(async () => undefined);
		const { rerender } = render(<BusyHarness message={message} ratingIds={new Set()} rate={rate} />);
		fireEvent.click(screen.getByRole('button', { name: 'Good response' }));
		expect(rate).toHaveBeenCalledTimes(1);
		rerender(<BusyHarness message={message} ratingIds={new Set(['a'])} rate={rate} />);
		const saving = screen.getByRole('button', { name: 'Saving rating…' });
		expect(saving.getAttribute('aria-busy')).toBe('true');
		expect(saving.getAttribute('aria-disabled')).toBe('true');
		// Still focusable: the keyboard focus stays on the thumb pressed.
		saving.focus();
		expect(document.activeElement).toBe(saving);
		expect(screen.getByRole('button', { name: 'Bad response' }).getAttribute('aria-disabled')).toBe('true');
		expect(screen.getByRole('button', { name: 'Bad response' }).getAttribute('aria-busy')).toBeNull();
		rerender(<BusyHarness message={message} ratingIds={new Set()} rate={rate} />);
		expect(screen.getByRole('button', { name: 'Good response' }).getAttribute('aria-disabled')).toBeNull();
	});

	it('shows no thumb busy while a note is saved after a thumb press', () => {
		const rate = vi.fn(async () => undefined);
		const { rerender } = render(<BusyHarness message={reply()} ratingIds={new Set()} rate={rate} />);
		fireEvent.click(screen.getByRole('button', { name: 'Good response' }));
		const rated = reply({ annotation: { rating: 1 } });
		rerender(<BusyHarness message={rated} ratingIds={new Set()} rate={rate} />);
		fireEvent.click(screen.getByRole('button', { name: 'Add a note' }));
		fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
		rerender(<BusyHarness message={rated} ratingIds={new Set(['a'])} rate={rate} />);
		expect(screen.queryByRole('button', { name: /Removing rating|Saving rating/ })).toBeNull();
		expect(screen.getByRole('button', { name: 'Rated good' }).getAttribute('aria-disabled')).toBe('true');
	});

	it('switches the rating with the other thumb', async () => {
		const session = show(reply({ annotation: { rating: 1 } }));
		fireEvent.click(screen.getByRole('button', { name: 'Bad response' }));
		await waitFor(() => expect(session.rate).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), -1));
		expect(session.unrate).not.toHaveBeenCalled();
	});

	it('shows no thumbs while rating is off', () => {
		state.features = { enable_message_rating: false };
		show(reply({ annotation: { rating: 1 } }));
		expect(screen.queryByRole('button', { name: /Good response|Rated good/ })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Add a note' })).toBeNull();
	});

	it('shows no thumbs in a chat that is not saved', () => {
		show(reply(), { chatId: null });
		expect(screen.queryByRole('button', { name: 'Good response' })).toBeNull();
	});
});

describe('the note on a rating (S3-D2)', () => {
	it('is offered only once the reply is rated', () => {
		show(reply());
		expect(screen.queryByRole('button', { name: 'Add a note' })).toBeNull();
	});

	it('opens a comment box and saves the comment alone', async () => {
		const session = show(reply({ annotation: { rating: 1 } }));
		fireEvent.click(screen.getByRole('button', { name: 'Add a note' }));
		const note = await screen.findByTestId('rate-note');
		expect(within(note).queryAllByRole('button', { name: /out of 10/ })).toHaveLength(0);
		fireEvent.change(within(note).getByRole('textbox', { name: 'Note on your rating' }), {
			target: { value: 'Clear' }
		});
		fireEvent.click(within(note).getByRole('button', { name: 'Save note' }));
		await waitFor(() =>
			expect(session.rate).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), null, { comment: 'Clear' })
		);
		expect(screen.queryByTestId('rate-note')).toBeNull();
	});

	it('says Edit note for a note already given, filled in, and closes with Close or Escape', async () => {
		show(reply({ annotation: { rating: -1, comment: 'Too long' } }));
		fireEvent.click(screen.getByRole('button', { name: 'Edit note' }));
		const box = await screen.findByRole('textbox', { name: 'Note on your rating' });
		expect((box as HTMLTextAreaElement).value).toBe('Too long');
		fireEvent.keyDown(box, { key: 'Escape' });
		expect(screen.queryByTestId('rate-note')).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Edit note' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Close note' }));
		expect(screen.queryByTestId('rate-note')).toBeNull();
	});
});

describe('regenerating', () => {
	it('labels the menu in sentence case and still sends the suggestion as written', async () => {
		const session = show(reply());
		const menu = await openMenu('Regenerate options');
		expect(within(menu).getByRole('menuitem', { name: 'Try again' })).toBeTruthy();
		await act(async () => {
			fireEvent.click(within(menu).getByRole('menuitem', { name: 'Add details' }));
		});
		expect(session.regenerate).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'Add Details');
	});

	it('is a single button when the menu is turned off', () => {
		state.prefs = { regenerateMenu: false };
		const session = show(reply());
		expect(screen.queryByRole('button', { name: 'Regenerate options' })).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
		expect(session.regenerate).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
	});

	it('hands ChatMessages a Retry and a Continue for the labelled buttons', () => {
		const session = show(reply());
		fireEvent.click(screen.getByTestId('retry'));
		fireEvent.click(screen.getByTestId('continue'));
		expect(session.regenerate).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
		expect(session.continueReply).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
	});
});
