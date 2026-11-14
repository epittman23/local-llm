import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getTerminalServerConnections, getToolServerConnections, setToolServerConnections } from '@/lib/apis/configs';
import { useAuthStore } from '@/lib/stores/authStore';
import Integrations from './Integrations';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('./ExternalKnowledge', () => ({ ExternalKnowledge: () => <div>external knowledge section</div> }));
vi.mock('@/components/settings/AddToolServerModal', () => ({
	AddToolServerModal: ({ open, edit }: { open: boolean; edit?: boolean }) =>
		open ? <div role="dialog">{edit ? 'Edit tool server dialog' : 'Add tool server dialog'}</div> : null
}));
vi.mock('@/components/settings/AddTerminalServerModal', () => ({
	AddTerminalServerModal: ({ open, edit }: { open: boolean; edit?: boolean }) =>
		open ? <div role="dialog">{edit ? 'Edit terminal dialog' : 'Add terminal dialog'}</div> : null
}));
vi.mock('@/lib/apis/configs', () => ({
	getTerminalServerConnections: vi.fn(),
	getToolServerConnections: vi.fn(),
	setTerminalServerConnections: vi.fn(),
	setToolServerConnections: vi.fn()
}));

beforeEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({ token: 'tok' } as never);
	vi.mocked(getToolServerConnections).mockResolvedValue({
		TOOL_SERVER_CONNECTIONS: [{ url: 'https://tools.example.com', type: 'openapi', info: { name: 'Tools', id: 't1' } }]
	} as never);
	vi.mocked(getTerminalServerConnections).mockResolvedValue({
		TERMINAL_SERVER_CONNECTIONS: [{ id: 'term1', name: 'Box', url: 'https://term.example.com', enabled: true }]
	} as never);
	vi.mocked(setToolServerConnections).mockResolvedValue({} as never);
});

const renderTab = async () => {
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<Integrations />
			</TooltipProvider>
		</QueryClientProvider>
	);
	await screen.findByRole('button', { name: 'Configure Tools' });
};

describe('Integrations', () => {
	it('opens the add dialog from the tool server plus button', async () => {
		await renderTab();
		fireEvent.click(screen.getByRole('button', { name: 'Add Tool Server' }));
		expect(screen.getByText('Add tool server dialog')).toBeTruthy();
	});

	it('opens the editor from a tool server configure button', async () => {
		await renderTab();
		fireEvent.click(screen.getByRole('button', { name: 'Configure Tools' }));
		expect(screen.getByText('Edit tool server dialog')).toBeTruthy();
	});

	it('opens the add dialog from the terminal plus button', async () => {
		await renderTab();
		fireEvent.click(screen.getByRole('button', { name: 'Add Terminal Connection' }));
		expect(screen.getByText('Add terminal dialog')).toBeTruthy();
	});

	it('opens the editor from a terminal configure button', async () => {
		await renderTab();
		fireEvent.click(screen.getByRole('button', { name: 'Configure Box' }));
		expect(screen.getByText('Edit terminal dialog')).toBeTruthy();
	});

	it('saves the tool servers when one is switched off', async () => {
		await renderTab();
		fireEvent.click(screen.getByRole('switch', { name: 'Disable Tools' }));
		await waitFor(() => expect(setToolServerConnections).toHaveBeenCalledTimes(1));
		expect(vi.mocked(setToolServerConnections).mock.calls[0][1]).toMatchObject({
			TOOL_SERVER_CONNECTIONS: [{ config: { enable: false } }]
		});
	});
});
