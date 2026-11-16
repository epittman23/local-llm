import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
const visibility = vi.hoisted(() => ({ single: false }));
vi.mock('../adminVisibility', () => ({ useAdminSingleUser: () => visibility.single }));

let admin: Record<string, unknown>;

beforeEach(() => {
	vi.clearAllMocks();
	visibility.single = false;
	Element.prototype.scrollIntoView = vi.fn();
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
	it('names the app URL in the app’s words, and gives this app’s build, not the upstream version (#1003, WRD-2)', async () => {
		await renderTab();
		expect(screen.getByLabelText('App URL')).toBeInTheDocument();
		expect(screen.queryByText('WebUI URL')).toBeNull();
		expect(screen.getByText('Build')).toBeInTheDocument();
		expect(screen.getByText(new RegExp(`· ${APP_BUILD_DATE}$`))).toBeInTheDocument();
		expect(screen.getByText('Derived from Open WebUI v0.11.3 (see NOTICE).')).toBeInTheDocument();
		expect(screen.queryByText('Version')).toBeNull();
	});

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

	it('opens and closes the default interface settings in place, bringing them into view (#960)', async () => {
		await renderTab();
		const toggle = screen.getByRole('button', { name: /^Default interface settings/ });
		expect(toggle).toHaveAttribute('aria-expanded', 'false');
		fireEvent.click(toggle);
		expect(toggle).toHaveAttribute('aria-expanded', 'true');
		expect(document.getElementById(toggle.getAttribute('aria-controls') ?? '')).toHaveTextContent(
			'0 settings configured'
		);
		expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
		fireEvent.click(toggle);
		expect(screen.queryByText('0 settings configured')).toBeNull();
	});

	it('says what each feature does, not who is allowed to use it (#1022, WRD-4)', async () => {
		await renderTab();
		expect(screen.queryByText(/Allow users|users/)).toBeNull();
		expect(screen.getByText('Organize chats into folders.')).toBeInTheDocument();
		expect(screen.getByPlaceholderText('e.g. http://127.0.0.1:4000')).toBeInTheDocument();
	});

	it('hides the parts for other accounts while this is the only one (S5-D2), and keeps the rest', async () => {
		visibility.single = true;
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<TooltipProvider>
					<General />
				</TooltipProvider>
			</QueryClientProvider>
		);
		await screen.findByRole('switch', { name: /^Folders/ });
		for (const name of [/^Channels/, /^User Webhooks/, /^User Status/])
			expect(screen.queryByRole('switch', { name })).toBeNull();
		expect(screen.queryByLabelText('Response Watermark')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Add banner' })).toBeNull();
		expect(screen.getByRole('switch', { name: /^Automations/ })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /^Default interface settings/ })).toBeInTheDocument();
	});

	it('asks before removing a banner with words in it; an empty one goes at once (ACT-3)', async () => {
		vi.mocked(getBanners).mockResolvedValue([
			{ id: 'b', type: 'info', title: '', content: 'Maintenance tonight', dismissible: false, timestamp: 1 }
		] as never);
		await renderTab();
		await screen.findByDisplayValue('Maintenance tonight');
		fireEvent.click(screen.getByRole('button', { name: 'Remove banner' }));
		const dialog = await screen.findByRole('alertdialog', { name: 'Remove this banner?' });
		expect(dialog).toHaveTextContent('“Maintenance tonight” stops showing above new chats once you save.');
		fireEvent.click(within(dialog).getByRole('button', { name: 'Remove banner' }));
		await waitFor(() => expect(screen.queryByDisplayValue('Maintenance tonight')).toBeNull());

		fireEvent.click(screen.getByRole('button', { name: 'Add banner' }));
		fireEvent.click(screen.getByRole('button', { name: 'Remove banner' }));
		expect(screen.queryByRole('alertdialog')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Remove banner' })).toBeNull();
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
