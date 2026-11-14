import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as notifications from '@/lib/apis/notifications';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import Notifications from './Notifications';

vi.mock('@/lib/apis/notifications', async (original) => ({
	...(await original<typeof import('@/lib/apis/notifications')>()),
	getNotificationEvents: vi.fn(),
	getNotificationTargets: vi.fn()
}));
const stable = vi.hoisted(() => ({ settings: {}, update: async () => undefined }));
vi.mock('@/lib/settings/userSettings', () => ({ useUserSettings: () => stable }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

describe('Notifications tab webhook targets', () => {
	beforeEach(() => {
		useAuthStore.setState({ token: 'jwt', user: { id: 'u1', name: 'Ann', role: 'admin' } } as never);
		useConfigStore.setState({ config: { name: 'x', version: '1', features: { enable_user_webhooks: true } } } as never);
		vi.mocked(notifications.getNotificationEvents).mockResolvedValue(null as never);
		vi.mocked(notifications.getNotificationTargets).mockResolvedValue({
			targets: [
				{
					id: 'hook-a',
					enabled: true,
					is_default: true,
					events: ['chat.finished'],
					delivery: 'away',
					config: { url_masked: 'https://x/***' }
				}
			]
		} as never);
	});
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it('marks the default target and lists its enabled switch and delivery', async () => {
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<Notifications />
			</QueryClientProvider>
		);
		expect(await screen.findByText('Default')).toBeInTheDocument();
		expect(screen.getByRole('switch', { name: 'Enabled: hook-a' })).toBeChecked();
		expect(screen.getByText(/Only when away/)).toBeInTheDocument();
	});
});
