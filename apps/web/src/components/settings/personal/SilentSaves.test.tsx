import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as users from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import Audio from './Audio';
import Notifications from './Notifications';
import Personalization from './Personalization';
import Shortcuts from './Shortcuts';

vi.mock('@/lib/apis/users', async (original) => ({
	...(await original<typeof import('@/lib/apis/users')>()),
	getUserSettings: vi.fn(),
	updateUserSettings: vi.fn()
}));
vi.mock('@/lib/apis/memories', async (original) => ({
	...(await original<typeof import('@/lib/apis/memories')>()),
	getMemories: vi.fn().mockResolvedValue([])
}));
const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }));

const renderTab = (tab: ReactElement) =>
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			{tab}
		</QueryClientProvider>
	);

describe('personal settings tabs say so when a save is refused (#262)', () => {
	beforeEach(() => {
		useAuthStore.setState({ token: 'jwt', user: { id: 'u1', name: 'Ann', role: 'user' } } as never);
		useConfigStore.setState({ config: { name: 'x', version: '1', features: { enable_memories: true } } } as never);
		vi.mocked(users.getUserSettings).mockResolvedValue({ ui: {} });
		vi.mocked(users.updateUserSettings).mockRejectedValue('Access prohibited');
	});
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	const cases: [string, ReactElement, string][] = [
		['Audio', <Audio key="a" />, 'Auto-Playback Response'],
		['Personalization', <Personalization key="p" />, 'Memory'],
		['Notifications', <Notifications key="n" />, 'Notification Sound'],
		['Shortcuts', <Shortcuts key="s" />, 'Keyboard Shortcuts']
	];
	for (const [name, tab, label] of cases) {
		it(`${name}: shows the server's message and puts the switch back`, async () => {
			renderTab(tab);
			const sw = await screen.findByRole('switch', { name: label });
			await waitFor(() => expect(vi.mocked(users.getUserSettings)).toHaveBeenCalled());
			const before = sw.getAttribute('aria-checked');
			await waitFor(() => expect(screen.getByRole('switch', { name: label })).toBeEnabled());
			fireEvent.click(sw);
			await waitFor(() => expect(toastError).toHaveBeenCalledWith('Access prohibited'));
			await waitFor(() =>
				expect(screen.getByRole('switch', { name: label }).getAttribute('aria-checked')).toBe(before)
			);
		});
	}
});
