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
const features = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('@/lib/stores/configStore', () => ({
	useConfigStore: (sel: (s: unknown) => unknown) => sel({ config: { features: features.value } })
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
	features.value = {};
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
		expect(errorHint('Missing api_key')).toBe('key');
		expect(errorHint('Cannot connect to host 127.0.0.1:8090')).toBe('local');
		expect(errorHint('Cannot connect to host localhost:8090 ssl:default [Connection refused]')).toBe('local');
		expect(errorHint('The upstream model is overloaded.')).toBeNull();
	});

	it('gives no hint for a bare "key" or another host refusing the connection', () => {
		expect(errorHint("unknown key 'reasoning'")).toBeNull();
		expect(errorHint('duplicate key value violates unique constraint "chat_pkey"')).toBeNull();
		expect(errorHint('[Errno 111] Connection refused')).toBeNull();
		expect(
			errorHint('Cannot connect to host openrouter.ai:443 ssl:default [Temporary failure in name resolution]')
		).toBeNull();
		expect(errorHint('Cannot connect to host 10.0.0.5:8090')).toBeNull();
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
		expect(screen.getByText('Check the API key in Admin > Settings > Connections.')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Open Connections' }));
		// A page under Admin since S5-D1: the app's useSettingsUrl navigates there.
		expect(useSettingsModalStore.getState()).toMatchObject({ open: false, leaveTo: '/admin/settings/connections' });
	});

	it('offers no Connections button to someone who cannot open it', () => {
		auth.role = 'user';
		show('401 Unauthorized');
		expect(screen.queryByRole('button', { name: 'Open Connections' })).toBeNull();
	});

	it('points a refused local connection at Benchmarks > Serve', () => {
		show('Cannot connect to host localhost:8090');
		expect(
			screen.getByText('If this is the local server, it may not be running: start it from Benchmarks > Serve.')
		).toBeTruthy();
		expect(screen.getByRole('link', { name: 'Open Serve' }).getAttribute('href')).toBe('/benchmarks/serve');
	});

	it('offers Open Serve only to an admin with Benchmarks on', () => {
		auth.role = 'user';
		show('Cannot connect to host 127.0.0.1:8090');
		expect(screen.getByText(/If this is the local server/)).toBeTruthy();
		expect(screen.queryByRole('link', { name: 'Open Serve' })).toBeNull();
		cleanup();
		auth.role = 'admin';
		features.value = { enable_benchmarks: false };
		show('Cannot connect to host 127.0.0.1:8090');
		expect(screen.queryByRole('link', { name: 'Open Serve' })).toBeNull();
	});

	it('gives an offline provider no misleading hint', () => {
		show('Cannot connect to host openrouter.ai:443 ssl:default [Temporary failure in name resolution]');
		expect(screen.queryByText(/local server/)).toBeNull();
		expect(screen.queryByText(/API key/)).toBeNull();
		expect(screen.queryByRole('link', { name: 'Open Serve' })).toBeNull();
	});
});
