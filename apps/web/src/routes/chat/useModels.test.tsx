// #764: a direct connection's models (`direct: true`) are left out of the lists,
// as chat to them needs a browser-side handler this app does not have.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/lib/stores/authStore';
import { useModels } from './useModels';

const api = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('@/lib/apis', () => ({ getModels: async () => api.list }));
vi.mock('@/lib/settings/userSettings', () => ({ useUserSettings: () => ({ settings: null }) }));

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useModels', () => {
	beforeEach(() => useAuthStore.setState({ token: 't' }));

	it('leaves out direct-connection models', async () => {
		api.list = [
			{ id: 'qwen', name: 'Qwen' },
			{ id: 'mine.llama', name: 'Llama', direct: true },
			{ id: 'other', name: 'Other', direct: false }
		];
		const { result } = renderHook(() => useModels(), { wrapper });
		await waitFor(() => expect(result.current.loaded).toBe(true));
		expect(result.current.models.map((m) => m.id)).toEqual(['qwen', 'other']);
	});
});
