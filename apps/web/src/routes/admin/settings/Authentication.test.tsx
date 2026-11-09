import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/lib/stores/authStore';
import Authentication from './Authentication';

// The OAuth provider is built from the environment at startup, so Admin
// Settings > Authentication offers none of its fields and says where they are
// set (#286). The settings the backend does read per request stay.

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

const ADMIN = { DEFAULT_USER_ROLE: 'pending', DEFAULT_GROUP_ID: '', ENABLE_SIGNUP: true };
const OAUTH = {
	ENABLE_OAUTH_PERSISTENT_CONFIG: true,
	ENABLE_OAUTH: true,
	OAUTH_EMAIL_CLAIM: 'email',
	OAUTH_ALLOWED_DOMAINS: '*'
};

beforeEach(() => {
	useAuthStore.setState({ token: 't' } as never);
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
		const path = String(url);
		if (path.endsWith('/auths/admin/config/oauth')) return new Response(JSON.stringify(OAUTH));
		if (path.endsWith('/auths/admin/config')) return new Response(JSON.stringify(ADMIN));
		return new Response(JSON.stringify([]));
	});
});

afterEach(() => vi.restoreAllMocks());

describe('Authentication settings and the OAuth provider', () => {
	it('shows a note that the provider is set through the environment, and none of its fields', async () => {
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<Authentication />
			</QueryClientProvider>
		);
		const note = await screen.findByTestId('oauth-env-note');
		expect(note.textContent).toContain('environment variables');
		expect(note.textContent).toContain('docs/guides/oauth.md');
		expect(screen.getByLabelText('Email Claim')).toBeTruthy();
		for (const label of ['Provider Name', 'Provider URL', 'Client ID', 'Client Secret', 'Redirect URI', 'Scopes']) {
			expect(screen.queryByLabelText(label)).toBeNull();
		}
	});
});
