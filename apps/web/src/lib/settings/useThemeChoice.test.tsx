import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getUserSettings, updateUserSettings } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { applyTheme } from '@/lib/theme';
import { useUserSettings } from './userSettings';
import { useThemeChoice } from './useThemeChoice';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/apis/users', async (orig) => ({
	...(await orig<object>()),
	getUserSettings: vi.fn(),
	updateUserSettings: vi.fn()
}));

// One client per test, not per render: a wrapper that built a new client
// whenever it rendered could throw away settings that had already loaded.
let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={client}>{children}</QueryClientProvider>
);

beforeEach(() => {
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	vi.clearAllMocks();
	localStorage.clear();
	useAuthStore.setState({ status: 'authenticated', token: 't', user: { id: 'u1', role: 'user' } } as never);
	vi.mocked(getUserSettings).mockResolvedValue({ ui: { pinnedModels: ['m1'] } } as never);
	vi.mocked(updateUserSettings).mockResolvedValue({} as never);
});
afterEach(() => document.documentElement.classList.remove('dark', 'light', 'oled'));

describe('useThemeChoice (#1089)', () => {
	it('starts on dark in a browser that never chose, and on the cached choice otherwise', () => {
		expect(renderHook(() => useThemeChoice(), { wrapper }).result.current[0]).toBe('dark');
		localStorage.theme = 'light';
		expect(renderHook(() => useThemeChoice(), { wrapper }).result.current[0]).toBe('light');
	});

	it('applies a choice at once, caches it in this browser and saves it with the account', async () => {
		// The settings and the choice share one client, so waiting for the
		// settings to have loaded (not merely been asked for) is observable.
		const { result } = renderHook(() => ({ choice: useThemeChoice(), account: useUserSettings() }), { wrapper });
		await waitFor(() => expect(result.current.account.settings).not.toBeNull());
		act(() => result.current.choice[1]('oled-dark'));
		expect(result.current.choice[0]).toBe('oled-dark');
		expect(localStorage.theme).toBe('oled-dark');
		expect(document.documentElement.classList.contains('oled')).toBe(true);
		await waitFor(() =>
			expect(updateUserSettings).toHaveBeenCalledWith('t', {
				ui: expect.objectContaining({ theme: 'oled-dark', pinnedModels: ['m1'] })
			})
		);
		expect(toast.error).not.toHaveBeenCalled();
	});

	it('says the theme changed in this browser only when the account save fails', async () => {
		vi.mocked(updateUserSettings).mockRejectedValue('down');
		// The settings and the choice share one client, so waiting for the
		// settings to have loaded (not merely been asked for) is observable.
		const { result } = renderHook(() => ({ choice: useThemeChoice(), account: useUserSettings() }), { wrapper });
		await waitFor(() => expect(result.current.account.settings).not.toBeNull());
		act(() => result.current.choice[1]('light'));
		expect(localStorage.theme).toBe('light');
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				'The theme changed in this browser only: it could not be saved to your account.'
			)
		);
	});

	it('follows a theme applied elsewhere (the account’s, on load)', () => {
		const { result } = renderHook(() => useThemeChoice(), { wrapper });
		act(() => applyTheme('light'));
		expect(result.current[0]).toBe('light');
	});
});
