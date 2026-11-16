import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import Authentication from './Authentication';

// The OAuth provider is built from the environment at startup, so Admin
// Settings > Authentication offers none of its fields and says where they are
// set (#286). The settings the backend does read per request stay.

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

let ADMIN: Record<string, unknown>;
let OAUTH: Record<string, unknown>;
const oauth = () => ({
	ENABLE_OAUTH_PERSISTENT_CONFIG: true,
	ENABLE_OAUTH: true,
	OAUTH_EMAIL_CLAIM: 'email',
	OAUTH_ALLOWED_DOMAINS: '*'
});

const renderTab = () =>
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<Authentication />
		</QueryClientProvider>
	);

beforeEach(() => {
	ADMIN = { DEFAULT_USER_ROLE: 'pending', DEFAULT_GROUP_ID: '', ENABLE_SIGNUP: true };
	OAUTH = oauth();
	useAuthStore.setState({ token: 't' } as never);
	// A provider named by the environment, as `/api/config` lists it.
	useConfigStore.setState({
		config: { name: 'local-llm', version: '', oauth: { providers: { oidc: 'SSO' } } }
	} as never);
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
		renderTab();
		const fold = await screen.findByRole('button', { name: /^Sign-in with an identity provider/ });
		expect(fold).toHaveTextContent('On');
		expect(screen.queryByTestId('oauth-env-note')).toBeNull();
		fireEvent.click(fold);
		expect(fold).toHaveAttribute('aria-expanded', 'true');
		const note = screen.getByTestId('oauth-env-note');
		expect(note.textContent).toContain('environment variables');
		expect(note.textContent).toContain('docs/guides/oauth.md');
		expect(screen.getByLabelText('Email Claim')).toBeTruthy();
		for (const label of ['Provider Name', 'Provider URL', 'Client ID', 'Client Secret', 'Redirect URI', 'Scopes']) {
			expect(screen.queryByLabelText(label)).toBeNull();
		}
	});

	it('folds an OAuth block set by the environment to one line saying so (S5-D2)', async () => {
		OAUTH = { ...oauth(), ENABLE_OAUTH_PERSISTENT_CONFIG: false, ENABLE_OAUTH: false };
		renderTab();
		const fold = await screen.findByRole('button', { name: /^Sign-in with an identity provider/ });
		expect(fold).toHaveTextContent('Off (set by environment variables)');
		expect(fold).toHaveAttribute('aria-expanded', 'false');
	});

	it('says Not configured while the environment names no provider, whatever ENABLE_OAUTH says (#1022)', async () => {
		useConfigStore.setState({ config: { name: 'local-llm', version: '', oauth: { providers: {} } } } as never);
		OAUTH = { ...oauth(), ENABLE_OAUTH_PERSISTENT_CONFIG: false, ENABLE_OAUTH: true };
		renderTab();
		const fold = await screen.findByRole('button', { name: /^Sign-in with an identity provider/ });
		expect(fold).toHaveTextContent(/Not configured$/);
	});

	it('names the default role’s choices in words, keeping the stored ids (WRD-1)', async () => {
		renderTab();
		const role = (await screen.findByLabelText('Default User Role')) as HTMLSelectElement;
		expect(Array.from(role.options).map((o) => [o.value, o.text])).toEqual([
			['pending', 'Pending'],
			['user', 'User'],
			['admin', 'Admin']
		]);
	});

	it('hides the settings for new accounts while this is the only one and sign-ups are off (S5-D2)', async () => {
		ADMIN = { ...ADMIN, ENABLE_SIGNUP: false };
		renderTab();
		const signUps = await screen.findByRole('switch', { name: /^New Sign Ups/ });
		expect(screen.queryByLabelText('Default User Role')).toBeNull();
		expect(screen.queryByLabelText('Default Group')).toBeNull();
		expect(screen.queryByRole('heading', { name: 'Pending Accounts' })).toBeNull();
		expect(screen.queryByText(/Allow users|new users/)).toBeNull();
		// Turning sign-ups on brings them back before it is saved.
		fireEvent.click(signUps);
		expect(screen.getByLabelText('Default User Role')).toBeInTheDocument();
		expect(screen.getByRole('heading', { name: 'Pending Accounts' })).toBeInTheDocument();
	});
});
