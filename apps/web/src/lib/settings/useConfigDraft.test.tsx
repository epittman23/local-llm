import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';
import { useConfigDraft } from './useConfigDraft';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
		{children}
	</QueryClientProvider>
);

describe('useConfigDraft', () => {
	it('treats a load that resolves to nothing as a failure, not a spinner (#240)', async () => {
		const { result } = renderHook(() => useConfigDraft(['nothing'], async () => null), { wrapper });
		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.isLoading).toBe(false);
		expect(result.current.draft).toBeNull();
		expect(toast.error).toHaveBeenCalledWith('Could not load these settings');
	});

	it('seeds the draft from a successful load', async () => {
		const { result } = renderHook(() => useConfigDraft(['some'], async () => ({ enabled: true })), { wrapper });
		await waitFor(() => expect(result.current.draft).toEqual({ enabled: true }));
		expect(result.current.isError).toBe(false);
	});
});
