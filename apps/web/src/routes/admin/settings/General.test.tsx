import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getAdminConfig, updateAdminConfig } from '@/lib/apis/auths';
import { getBanners, setBanners } from '@/lib/apis/configs';
import { useAuthStore } from '@/lib/stores/authStore';
import General from './General';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('./Events', () => ({ Events: () => <div>events section</div> }));
vi.mock('@/lib/apis/auths', () => ({ getAdminConfig: vi.fn(), updateAdminConfig: vi.fn() }));
vi.mock('@/lib/apis/configs', () => ({ getBanners: vi.fn(), setBanners: vi.fn() }));
vi.mock('@/lib/settings/useAdminSaved', () => ({ useAdminConfigSaved: () => vi.fn() }));

let admin: Record<string, unknown>;

beforeEach(() => {
	vi.clearAllMocks();
	admin = { ENABLE_MEMORIES: true, ENABLE_MEMORY_SYSTEM_CONTEXT: false, DEFAULT_INTERFACE_SETTINGS: {} };
	useAuthStore.setState({ token: 'tok', user: { role: 'admin' } } as never);
	vi.mocked(getAdminConfig).mockImplementation(async () => admin as never);
	vi.mocked(getBanners).mockResolvedValue([] as never);
	vi.mocked(updateAdminConfig).mockResolvedValue({} as never);
	vi.mocked(setBanners).mockResolvedValue([] as never);
});

const renderTab = async () => {
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<General />
			</TooltipProvider>
		</QueryClientProvider>
	);
	await screen.findByRole('button', { name: 'Add banner' });
};

describe('General settings', () => {
	it('shows the memory system context switch only while memories are on', async () => {
		await renderTab();
		const context = screen.getByRole('switch', { name: /Memory System Context/ });
		expect(context.getAttribute('aria-checked')).toBe('false');
		fireEvent.click(screen.getByRole('switch', { name: /^Memories/ }));
		expect(screen.queryByRole('switch', { name: /Memory System Context/ })).toBeNull();
	});

	it('adds a banner row from the Add banner button', async () => {
		await renderTab();
		expect(screen.queryByRole('button', { name: 'Remove banner' })).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Add banner' }));
		expect(screen.getByRole('button', { name: 'Remove banner' })).toBeTruthy();
	});

	it('does not add a second banner while the last one is still empty', async () => {
		await renderTab();
		fireEvent.click(screen.getByRole('button', { name: 'Add banner' }));
		fireEvent.click(screen.getByRole('button', { name: 'Add banner' }));
		expect(screen.getAllByRole('button', { name: 'Remove banner' })).toHaveLength(1);
	});

	it('opens and closes the default interface settings', async () => {
		await renderTab();
		const toggle = screen.getByRole('button', { name: 'Configure Default Interface Settings' });
		fireEvent.click(toggle);
		expect(screen.getByRole('button', { name: /^Default Interface Settings/ }).getAttribute('aria-expanded')).toBe(
			'true'
		);
		expect(screen.getByText('0 settings configured')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Close Default Interface Settings' }));
		expect(screen.queryByText('0 settings configured')).toBeNull();
	});

	it('saves the edited config and the banners', async () => {
		await renderTab();
		fireEvent.click(screen.getByRole('switch', { name: /^Folders/ }));
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(updateAdminConfig).toHaveBeenCalledTimes(1));
		expect(vi.mocked(updateAdminConfig).mock.calls[0][1]).toMatchObject({ ENABLE_FOLDERS: true });
		expect(setBanners).toHaveBeenCalledWith('tok', []);
	});
});
