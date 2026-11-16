import { toast } from 'sonner';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/lib/stores/authStore';
import { emptyChat, emptyCompletions, usePlaygroundStore } from '@/routes/playground/playgroundStore';
import { clearExpiredSession, initAuth, sessionEndReason, signOut } from './session';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

// One stub for the whole file: initAuth's fetch guard captures window.fetch the
// first time it runs, so each test changes what this stub does instead.
const fetch = vi.fn();
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeAll(() => vi.stubGlobal('fetch', fetch));
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
	fetch.mockReset();
	localStorage.clear();
	localStorage.setItem('token', 'saved-token');
});

const route = (sessionAnswer: () => Promise<Response>) =>
	fetch.mockImplementation(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith('/api/config')) return json({ name: 'Local LLM', features: {} });
		if (url.includes('/auths/')) return sessionAnswer();
		return json({});
	});

describe('restoring the session at startup (#240)', () => {
	it('keeps the saved token when the server cannot be reached', async () => {
		route(async () => {
			throw new TypeError('Failed to fetch');
		});
		await initAuth();
		expect(localStorage.getItem('token')).toBe('saved-token');
	});

	it('drops the saved token when the server refuses it', async () => {
		route(async () => json({ detail: 'Your session has expired or the token is invalid.' }, 401));
		await initAuth();
		expect(localStorage.getItem('token')).toBeNull();
	});
});

describe('the time zone (#324)', () => {
	it('is sent on every load with a session, not only at sign-in', async () => {
		const sent: unknown[] = [];
		fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith('/api/config')) return json({ name: 'Local LLM', features: {} });
			if (url.endsWith('/auths/update/timezone')) {
				sent.push(JSON.parse(String(init?.body)));
				return json(true);
			}
			if (url.includes('/auths/')) return json({ id: 'u', token: 'saved-token', role: 'user' });
			return json({});
		});

		await initAuth();

		expect(sent).toEqual([{ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }]);
	});
});

describe('a session that runs out (#1061)', () => {
	it('records why it ended instead of raising a toast, and forgets it at the next sign-in', async () => {
		route(async () => json({ id: 'u', token: 'saved-token', role: 'user' }));
		await initAuth();
		expect(useAuthStore.getState().status).toBe('authenticated');
		expect(sessionEndReason()).toBeNull();

		clearExpiredSession();

		expect(sessionEndReason()).toBe('expired');
		expect(useAuthStore.getState().status).toBe('anonymous');
		expect(localStorage.getItem('token')).toBeNull();
		expect(toast.error).not.toHaveBeenCalled();

		useAuthStore.getState().setSession('new-token', { id: 'u', role: 'user' } as never);
		expect(sessionEndReason()).toBeNull();
	});

	it('keeps the unsent drafts and forgets the rest of the tab session; a chosen sign-out forgets them too', async () => {
		route(async () => json({ id: 'u', token: 'saved-token', role: 'user' }));
		await initAuth();
		sessionStorage.setItem('chat-draft:u:new:', 'half a question');
		sessionStorage.setItem('other', 'x');

		clearExpiredSession();

		await vi.waitFor(() => expect(sessionStorage.getItem('other')).toBeNull());
		expect(sessionStorage.getItem('chat-draft:u:new:')).toBe('half a question');
		await signOut();
		expect(sessionStorage.getItem('chat-draft:u:new:')).toBeNull();
	});

	it('gives drafts kept through an expiry back to the same account only, and forgets them for another', async () => {
		route(async () => json({ id: 'u', token: 'saved-token', role: 'user' }));
		await initAuth();
		sessionStorage.setItem('chat-draft:u:c1', 'mine');
		clearExpiredSession();
		await vi.waitFor(() => expect(useAuthStore.getState().status).toBe('anonymous'));

		useAuthStore.getState().setSession('same-token', { id: 'u', role: 'user' } as never);
		expect(sessionStorage.getItem('chat-draft:u:c1')).toBe('mine');

		clearExpiredSession();
		useAuthStore.getState().setSession('other-token', { id: 'someone-else', role: 'user' } as never);
		expect(sessionStorage.getItem('chat-draft:u:c1')).toBeNull();
	});

	it('records nothing for a sign-out the person chose', async () => {
		route(async () => json({ id: 'u', token: 'saved-token', role: 'user' }));
		await initAuth();
		clearExpiredSession();
		await signOut();
		expect(sessionEndReason()).toBeNull();
	});

	it('marks a saved token the server refuses on a cold load as an expired session', async () => {
		// A fresh page load: no session yet, and no reason left from an earlier one.
		await signOut();
		localStorage.setItem('token', 'saved-token');
		useAuthStore.setState({ status: 'pending', token: null, user: null });
		route(async () => json({ detail: 'Your session has expired or the token is invalid.' }, 401));

		await initAuth();

		expect(sessionEndReason()).toBe('expired');
		expect(useAuthStore.getState().status).toBe('anonymous');
		expect(localStorage.getItem('token')).toBeNull();
		expect(toast.error).not.toHaveBeenCalled();
	});

	it('says nothing about expiry to someone who never signed in', async () => {
		await signOut();
		localStorage.clear();
		useAuthStore.setState({ status: 'pending', token: null, user: null });
		route(async () => json({ detail: 'Not authenticated' }, 401));

		await initAuth();

		expect(sessionEndReason()).toBeNull();
		expect(useAuthStore.getState().status).toBe('anonymous');
	});

	it('does not call a server it could not reach an expired session', async () => {
		await signOut();
		localStorage.setItem('token', 'saved-token');
		useAuthStore.setState({ status: 'pending', token: null, user: null });
		route(async () => {
			throw new TypeError('Failed to fetch');
		});

		await initAuth();

		expect(sessionEndReason()).toBeNull();
		expect(localStorage.getItem('token')).toBe('saved-token');
	});

	it('marks a request refused for an expired session, through the fetch guard', async () => {
		route(async () => json({ id: 'u', token: 'saved-token', role: 'user' }));
		await initAuth();
		fetch.mockImplementation(async () => json({ detail: 'Not authenticated' }, 401));

		await window.fetch('/api/v1/chats/', { headers: { authorization: 'Bearer saved-token' } });

		expect(sessionEndReason()).toBe('expired');
		expect(useAuthStore.getState().status).toBe('anonymous');
	});
});

describe("the Playground's work (S6-D6)", () => {
	const filled = () => {
		usePlaygroundStore.getState().setChat({ system: 'Be terse', messages: [{ role: 'user', content: 'mine' }] });
		usePlaygroundStore.getState().setCompletions({ prompt: 'Once upon' });
		usePlaygroundStore.getState().setImagePrompt('a lighthouse');
		expect(sessionStorage.getItem('lllm-playground')).toContain('Once upon');
	};
	const empty = () => {
		const s = usePlaygroundStore.getState();
		expect([s.chat, s.completions, s.imagePrompt]).toEqual([emptyChat, emptyCompletions, '']);
		expect(sessionStorage.getItem('lllm-playground')).toBeNull();
	};

	it('is forgotten on sign-out, so the next account in this tab starts empty', async () => {
		route(async () => json({ id: 'u', token: 'saved-token', role: 'admin' }));
		await initAuth();
		filled();
		await signOut();
		empty();
	});

	it('is forgotten when the session runs out too', async () => {
		route(async () => json({ id: 'u', token: 'saved-token', role: 'admin' }));
		await initAuth();
		filled();
		clearExpiredSession();
		empty();
	});
});
