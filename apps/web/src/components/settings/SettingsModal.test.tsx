import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/lib/stores/authStore';
import { useSettingsModalStore } from '@/lib/stores/settingsModalStore';
import { SettingsModal } from './SettingsModal';

// #836: opening a tab whose code was never loaded while the server was down
// crashed the whole page (an uncaught dynamic-import rejection).

const loaders = vi.hoisted(() => ({
	general: vi.fn(),
	interface: vi.fn()
}));

vi.mock('./adminTabComponents', () => ({
	tabLoaders: loaders,
	implementedTabIds: new Set(['general', 'interface'])
}));

const tab = (text: string) => ({ default: () => <p>{text}</p> });

beforeEach(() => {
	loaders.general.mockReset();
	loaders.interface.mockReset();
	loaders.interface.mockResolvedValue(tab('Interface tab body'));
	useAuthStore.setState({ user: { id: 'u', name: 'U', email: 'u@x', role: 'user' } as never });
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	act(() => useSettingsModalStore.getState().closeSettings());
	vi.restoreAllMocks();
});

describe('a Settings tab whose import fails (#836)', () => {
	it('shows a recoverable message, retries, and leaves other tabs working', async () => {
		loaders.general.mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'));
		render(<SettingsModal />);
		act(() => useSettingsModalStore.getState().openSettings('general'));

		expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');

		fireEvent.click(screen.getByRole('tab', { name: /interface/i }));
		expect(await screen.findByText('Interface tab body')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('tab', { name: /general/i }));
		expect(await screen.findByRole('alert')).toBeInTheDocument();

		loaders.general.mockResolvedValue(tab('General tab body'));
		fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		expect(await screen.findByText('General tab body')).toBeInTheDocument();
		await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
	});
});
