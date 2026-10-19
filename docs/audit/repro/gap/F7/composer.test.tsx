import { QueryProvider } from '@/lib/query/QueryProvider';
import { act, fireEvent, render, screen } from '../../../../../apps/web/node_modules/@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

const users = [
	{ id: 'u1', name: 'Alpha' },
	{ id: 'u2', name: 'Anna' },
	{ id: 'u3', name: 'Aaron' },
	{ id: 'u4', name: 'Abby' }
];
vi.mock('@/lib/apis', () => ({ getModels: async () => [{ id: 'llama', name: 'Llama' }] }));
vi.mock('@/lib/apis/channels', () => ({
	// the empty query resolves; any later query never does (still loading)
	getChannelMembersById: (_t: string, _c: string, q: string) =>
		q === '' ? Promise.resolve({ users, total: users.length }) : new Promise(() => {})
}));
vi.mock('@/lib/apis/users', () => ({
	searchUsers: (_t: string, q: string) => (q === '' ? Promise.resolve({ users: [] }) : new Promise(() => {}))
}));
vi.mock('@/lib/apis/files', () => ({ uploadFile: vi.fn() }));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'me', name: 'Me' } })
}));
vi.mock('@/lib/stores/configStore', () => ({
	useConfigStore: (sel: (s: unknown) => unknown) => sel({ config: { file: { max_size: null } } })
}));
vi.mock('@/routes/channels/useChannels', () => ({
	useChannelList: () => ({ data: [] })
}));

import { MessageComposer } from '@/routes/channels/MessageComposer';

describe('MessageComposer mention picker', () => {
	it('Enter on a highlighted row that the list no longer has throws instead of inserting', async () => {
		const errors: unknown[] = [];
		const onErr = (e: ErrorEvent) => {
			errors.push(e.error ?? e.message);
			e.preventDefault();
		};
		window.addEventListener('error', onErr);
		render(
			createElement(
				QueryProvider,
				null,
				createElement(MessageComposer, {
					channel: { id: 'c1', name: 'general', created_at: 1 },
					placeholder: 'Type here...',
					typingUsers: [],
					replyTo: null,
					onCancelReply: () => {},
					onTyping: () => {},
					onSubmit: () => {}
				})
			)
		);
		const box = screen.getByLabelText('Message') as HTMLTextAreaElement;
		fireEvent.change(box, { target: { value: '@', selectionStart: 1 } });
		await act(async () => {
			await new Promise((r) => setTimeout(r, 400));
		});
		console.log('options for "@":', screen.queryAllByRole('option').length);
		fireEvent.change(box, { target: { value: '@a', selectionStart: 2 } });
		// within the 200 ms debounce, the old user rows still match "a"
		for (let i = 0; i < 4; i++) fireEvent.keyDown(box, { key: 'ArrowDown' });
		const before = screen.queryAllByRole('option').length;
		await act(async () => {
			await new Promise((r) => setTimeout(r, 400));
		});
		const after = screen.queryAllByRole('option').length;
		console.log('options before/after debounce:', before, after);
		let thrown: unknown = null;
		try {
			fireEvent.keyDown(box, { key: 'Enter' });
		} catch (e) {
			thrown = e;
		}
		window.removeEventListener('error', onErr);
		console.log('thrown:', String(thrown), 'window errors:', errors.map(String), 'text now:', JSON.stringify(box.value));
		expect(thrown ?? errors[0]).toBeTruthy();
	});
});
