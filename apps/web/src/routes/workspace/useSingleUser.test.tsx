import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchUsers } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { useSingleUser } from './workspaceAccess';

vi.mock('@/lib/apis/users', () => ({ searchUsers: vi.fn() }));
const search = vi.mocked(searchUsers);

const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
		{children}
	</QueryClientProvider>
);

beforeEach(() => useAuthStore.setState({ token: 't' }));
afterEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({ token: null });
});

describe('useSingleUser', () => {
	it('is true when the server counts one account', async () => {
		search.mockResolvedValue({ users: [], total: 1 });
		const { result } = renderHook(() => useSingleUser(), { wrapper });
		await waitFor(() => expect(search).toHaveBeenCalledWith('t'));
		expect(result.current).toBe(true);
	});

	it('is false once a second account exists', async () => {
		search.mockResolvedValue({ users: [], total: 2 });
		const { result } = renderHook(() => useSingleUser(), { wrapper });
		await waitFor(() => expect(result.current).toBe(false));
	});

	it('counts as one account while loading and when the count cannot be read', async () => {
		search.mockRejectedValue(new Error('nope'));
		const { result } = renderHook(() => useSingleUser(), { wrapper });
		expect(result.current).toBe(true);
		await waitFor(() => expect(search).toHaveBeenCalled());
		expect(result.current).toBe(true);
	});

	it('asks nothing without a session', () => {
		useAuthStore.setState({ token: null });
		const { result } = renderHook(() => useSingleUser(), { wrapper });
		expect(result.current).toBe(true);
		expect(search).not.toHaveBeenCalled();
	});
});
