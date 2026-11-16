import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchUsers } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { type BackendConfig, useConfigStore } from '@/lib/stores/configStore';
import { useAccountCountKnown, useAdminSingleUser } from './adminVisibility';

vi.mock('@/lib/apis/users', () => ({ searchUsers: vi.fn() }));
const search = vi.mocked(searchUsers);

const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
		{children}
	</QueryClientProvider>
);

const withSignup = (enable_signup: boolean | undefined) =>
	useConfigStore.setState({ config: { name: 'x', version: '0', features: { enable_signup } } as BackendConfig });

beforeEach(() => useAuthStore.setState({ token: 't' }));
afterEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({ token: null });
	useConfigStore.setState({ config: null });
});

describe('useAdminSingleUser', () => {
	it('is true with one account and sign-ups off', async () => {
		search.mockResolvedValue({ users: [], total: 1 });
		withSignup(false);
		const { result } = renderHook(() => useAdminSingleUser(), { wrapper });
		await waitFor(() => expect(search).toHaveBeenCalled());
		expect(result.current).toBe(true);
	});

	it('is false once a second account exists', async () => {
		search.mockResolvedValue({ users: [], total: 2 });
		withSignup(false);
		const { result } = renderHook(() => useAdminSingleUser(), { wrapper });
		await waitFor(() => expect(result.current).toBe(false));
	});

	it('is false while sign-ups are on, even with one account', async () => {
		search.mockResolvedValue({ users: [], total: 1 });
		withSignup(true);
		const { result } = renderHook(() => useAdminSingleUser(), { wrapper });
		await waitFor(() => expect(search).toHaveBeenCalled());
		expect(result.current).toBe(false);
	});

	it('treats a config without the flag as sign-ups off', () => {
		search.mockResolvedValue({ users: [], total: 1 });
		withSignup(undefined);
		const { result } = renderHook(() => useAdminSingleUser(), { wrapper });
		expect(result.current).toBe(true);
	});
});

describe('useAccountCountKnown', () => {
	it('is false until the count answers, then true', async () => {
		let answer: (value: unknown) => void = () => {};
		search.mockReturnValue(new Promise((resolve) => (answer = resolve)) as never);
		const { result } = renderHook(() => useAccountCountKnown(), { wrapper });
		expect(result.current).toBe(false);
		answer({ total: 1 });
		await waitFor(() => expect(result.current).toBe(true));
	});

	it('is true once the count has failed too: the install then counts as one account', async () => {
		search.mockRejectedValue(new Error('down'));
		const { result } = renderHook(() => useAccountCountKnown(), { wrapper });
		await waitFor(() => expect(result.current).toBe(true));
	});
});
