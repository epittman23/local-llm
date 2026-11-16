import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

vi.mock('@/components/chat/markdown/Markdown', () => ({
	Markdown: ({ content }: { content: string }) => <p>{content}</p>
}));

const reply = (content: string, meta: ChannelMessage['meta']) =>
	({ id: 'r1', channel_id: 'c1', user_id: 'me', content, meta, created_at: 1, updated_at: 1 }) as ChannelMessage;

const show = (message: ChannelMessage, props: Partial<React.ComponentProps<typeof ChannelMessageView>> = {}) =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider>
				<MemoryRouter>
					<ChannelMessageView message={message} channelId="c1" showAuthor actions={{}} {...props} />
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

const plain = (extra: Partial<ChannelMessage> = {}) =>
	({
		id: 'm1',
		channel_id: 'c1',
		user_id: 'me',
		content: 'hello there',
		created_at: 1,
		updated_at: 1,
		...extra
	}) as ChannelMessage;

describe('a message toolbar', () => {
	it('deletes after the author confirms', async () => {
		const onDelete = vi.fn();
		const message = plain();
		show(message, { actions: { onDelete } });
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Delete message' }));
		await waitFor(() => expect(onDelete).toHaveBeenCalledWith(message));
	});

	it('hides Delete from someone who did not write the message', () => {
		show(plain({ user_id: 'someone-else' }), { actions: { onDelete: vi.fn() } });
		expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
	});

	it('offers Unpin on a pinned message and labels it Pinned', () => {
		const onPin = vi.fn();
		show(plain({ is_pinned: true }), { actions: { onPin } });
		expect(screen.getByText('Pinned')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Unpin' }));
		expect(onPin).toHaveBeenCalledTimes(1);
	});
});

describe('message highlighting and replies', () => {
	it('marks a highlighted message with the brand border', () => {
		show(plain(), { highlighted: true });
		expect(screen.getByTestId('channel-message').className).toContain('border-brand');
	});

	it('marks a message that replies to me with the warning border', () => {
		const quoted = plain({ id: 'q1', user_id: 'me', user: { id: 'me', name: 'Me' } as never });
		show(plain({ id: 'm2', user_id: 'other', reply_to_message: quoted }));
		expect(screen.getByTestId('channel-message').className).toContain('border-warning');
	});

	it('scrolls the quoted message into view and flags it when the quote is pressed', () => {
		const target = document.createElement('div');
		target.id = 'message-q1';
		target.scrollIntoView = vi.fn();
		document.body.appendChild(target);
		const quoted = plain({ id: 'q1', user: { id: 'u2', name: 'Quinn' } as never, content: 'the original' });
		show(plain({ id: 'm2', reply_to_message: quoted }));
		fireEvent.click(screen.getByRole('button', { name: /Quinn/ }));
		expect(target.scrollIntoView).toHaveBeenCalled();
		expect(target.classList.contains('bg-brand/10')).toBe(true);
		target.remove();
	});

	it('does nothing when the quoted message is not on the page', () => {
		const quoted = plain({ id: 'gone', user: { id: 'u2', name: 'Quinn' } as never });
		show(plain({ id: 'm2', reply_to_message: quoted }));
		expect(() => fireEvent.click(screen.getByRole('button', { name: /Quinn/ }))).not.toThrow();
	});
});

describe('message body and reactions', () => {
	it('shows (edited) once a message has been changed', () => {
		show(plain({ updated_at: 5 }));
		expect(screen.getByText('(edited)')).toBeTruthy();
	});

	it('shows my reaction as pressed and toggles it', () => {
		const onReaction = vi.fn();
		const message = plain({
			reactions: [
				{ name: 'tada', users: [{ id: 'me', name: 'Me' }] },
				{ name: 'eyes', users: [{ id: 'u2', name: 'Quinn' }] }
			] as never
		});
		show(message, { actions: { onReaction } });
		const mine = screen.getByRole('button', { name: 'tada 1' });
		expect(mine).toHaveAttribute('aria-pressed', 'true');
		expect(screen.getByRole('button', { name: 'eyes 1' })).toHaveAttribute('aria-pressed', 'false');
		fireEvent.click(mine);
		expect(onReaction).toHaveBeenCalledWith(message, 'tada');
	});
});

describe('a message on touch (A11Y-4, #914)', () => {
	const message = reply('hello', undefined);
	it('offers its actions in a Message actions menu', async () => {
		const onReply = vi.fn();
		const onThread = vi.fn();
		const onPin = vi.fn();
		const onDelete = vi.fn();
		show(message, { actions: { onReply, onThread, onPin, onDelete, onEdit: vi.fn(), onReaction: vi.fn() } });
		const open = () =>
			fireEvent.pointerDown(screen.getByRole('button', { name: 'Message actions' }), { button: 0, ctrlKey: false });
		open();
		for (const name of ['Add reaction', 'Reply', 'Reply in thread', 'Pin', 'Edit', 'Delete'])
			expect(await screen.findByRole('menuitem', { name })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('menuitem', { name: 'Reply' }));
		expect(onReply).toHaveBeenCalledWith(message);
		open();
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Reply in thread' }));
		expect(onThread).toHaveBeenCalledWith('r1');
		open();
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin' }));
		expect(onPin).toHaveBeenCalledWith(message);
		open();
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
		expect(screen.getByLabelText('Edit message')).toHaveValue('hello');
	});

	it('opens the emoji picker from the menu, and deletes after confirming', async () => {
		const onDelete = vi.fn();
		show(message, { actions: { onDelete, onReaction: vi.fn() } });
		const trigger = screen.getByRole('button', { name: 'Message actions' });
		fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Add reaction' }));
		expect(await screen.findByLabelText('Search emojis')).toBeInTheDocument();
		fireEvent.keyDown(screen.getByLabelText('Search emojis'), { key: 'Escape' });
		fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Delete message' }));
		await waitFor(() => expect(onDelete).toHaveBeenCalledWith(message));
	});

	it('keeps the pointer toolbar in the page, transparent until hover or focus', () => {
		show(message, { actions: { onReply: vi.fn() } });
		const toolbar = screen.getByRole('button', { name: 'Reply' }).closest('div.absolute') as HTMLElement;
		expect(toolbar.className).toContain('opacity-0');
		expect(toolbar.className).toContain('group-focus-within:opacity-100');
		expect(toolbar.className).not.toMatch(/(^|\s)hidden(\s|$)/);
	});
});
