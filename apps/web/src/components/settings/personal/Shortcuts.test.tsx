import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DEFAULT_KEYBINDINGS } from '@/lib/shortcuts';
import { useAuthStore } from '@/lib/stores/authStore';
import { KEYBINDINGS_KEY } from '@/lib/useShortcuts';
import Shortcuts from './Shortcuts';

// #808: a refused rebind left the new keys in the cache, so the tab kept
// showing them (and the app kept using them) until a reload.

const api = vi.hoisted(() => ({
	getUserSettings: vi.fn(),
	updateUserSettings: vi.fn()
}));
vi.mock('@/lib/apis/users', () => api);
vi.mock('@/lib/settings/userSettings', () => ({
	useUserSettings: () => ({ settings: {}, update: vi.fn() })
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const renderTab = () => {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	client.setQueryData(KEYBINDINGS_KEY, null);
	render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<Shortcuts />
			</TooltipProvider>
		</QueryClientProvider>
	);
	return client;
};

const rebind = () => {
	const button = screen.getByRole('button', { name: 'Change shortcut for New Chat' });
	fireEvent.click(button);
	fireEvent.keyDown(button, { key: 'j', ctrlKey: true });
	return button;
};

describe('rebinding a shortcut (#808)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useAuthStore.setState({ token: 'tok' });
	});

	it('puts the old keys back when the save is refused', async () => {
		api.updateUserSettings.mockRejectedValue(new Error('refused'));
		const client = renderTab();
		const button = rebind();
		await waitFor(() => expect(api.updateUserSettings).toHaveBeenCalled());
		await waitFor(() => expect(client.getQueryData(KEYBINDINGS_KEY)).toBeNull());
		expect(button.textContent).not.toMatch(/J/);
	});

	it('keeps the new keys when the save succeeds', async () => {
		api.updateUserSettings.mockResolvedValue({});
		const client = renderTab();
		rebind();
		await waitFor(() => expect(api.updateUserSettings).toHaveBeenCalled());
		expect(client.getQueryData(KEYBINDINGS_KEY)).toEqual({ ...DEFAULT_KEYBINDINGS, newChat: 'Cmd+J' });
	});

	it('shows what the server holds when an earlier save fails after a later one succeeded', async () => {
		let refuse: (e: Error) => void = () => {};
		api.updateUserSettings
			.mockImplementationOnce(() => new Promise((_, reject) => (refuse = reject)))
			.mockResolvedValueOnce({});
		const server = { ...DEFAULT_KEYBINDINGS, newChat: 'Cmd+J', search: 'Cmd+L' };
		api.getUserSettings.mockResolvedValue({ keybindings: server });
		const client = renderTab();
		const first = rebind();
		const second = screen.getByRole('button', { name: 'Change shortcut for Search' });
		fireEvent.click(second);
		fireEvent.keyDown(second, { key: 'l', ctrlKey: true });
		await waitFor(() => expect(api.updateUserSettings).toHaveBeenCalledTimes(2));
		refuse(new Error('refused'));
		await waitFor(() => expect(client.getQueryData(KEYBINDINGS_KEY)).toEqual(server));
		expect(first.textContent).toMatch(/J/);
	});
});
