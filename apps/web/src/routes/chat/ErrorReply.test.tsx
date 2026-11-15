import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@/lib/chat/history';
import { useSettingsModalStore } from '@/lib/stores/settingsModalStore';
import { ErrorReply, errorDetail, errorHint } from './ErrorReply';

const auth = vi.hoisted(() => ({ role: 'admin' }));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'u1', role: auth.role } })
}));

const failed = (content: unknown): Message => ({
	id: 'a',
	parentId: 'u',
	childrenIds: [],
	role: 'assistant',
	content: '',
	done: true,
	error: { content }
});

beforeEach(() => {
	auth.role = 'admin';
	useSettingsModalStore.getState().closeSettings();
});
afterEach(cleanup);

describe('errorDetail and errorHint', () => {
	it('drops the stored "Uh-oh" sentence and keeps the cause', () => {
		expect(errorDetail(failed('Uh-oh! There was an issue with the response.\n401: bad key'))).toBe('401: bad key');
		expect(errorDetail(failed({ detail: 'x' }))).toBe('');
	});

	it('recognises a refused key and a local server that is not serving', () => {
		expect(errorHint('Error 401: Unauthorized')).toBe('key');
		expect(errorHint('No auth credentials found: invalid API key')).toBe('key');
		expect(errorHint('Cannot connect to host 127.0.0.1:8090')).toBe('local');
		expect(errorHint('[Errno 111] Connection refused')).toBe('local');
		expect(errorHint('The upstream model is overloaded.')).toBeNull();
	});
});

describe('ErrorReply', () => {
	const show = (content: unknown) =>
		render(
			<MemoryRouter>
				<ErrorReply message={failed(content)} />
			</MemoryRouter>
		);

	it('says the provider gave no reason when it gave none', () => {
		show(null);
		expect(screen.getByRole('alert').textContent).toContain('The provider gave no reason.');
	});

	it('points a refused key at Connections, and opens it for the owner', () => {
		show('401 Unauthorized');
		expect(screen.getByText('Check the API key in Admin Settings > Connections.')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Open Connections' }));
		expect(useSettingsModalStore.getState()).toMatchObject({ open: true, requestedTab: 'admin:connections' });
	});

	it('offers no Connections button to someone who cannot open it', () => {
		auth.role = 'user';
		show('401 Unauthorized');
		expect(screen.queryByRole('button', { name: 'Open Connections' })).toBeNull();
	});

	it('points a refused local connection at Benchmarks > Serve', () => {
		show('Cannot connect to host localhost:8090');
		expect(screen.getByText('The local server is not running. Start it from Benchmarks > Serve.')).toBeTruthy();
		expect(screen.getByRole('link', { name: 'Open Serve' }).getAttribute('href')).toBe('/benchmarks/serve');
	});
});
