import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toastFailure } from '@/components/common/failureToast';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
	getTerminalServerConnections,
	getToolServerConnections,
	setTerminalServerConnections,
	setToolServerConnections
} from '@/lib/apis/configs';
import { useAuthStore } from '@/lib/stores/authStore';
import Integrations from './Integrations';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('./ExternalKnowledge', () => ({ ExternalKnowledge: () => <div>external knowledge section</div> }));
vi.mock('@/components/common/failureToast', () => ({ toastFailure: vi.fn() }));
// The dialogs have their own tests; here each hands back a connection or deletes one.
type DialogProps = {
	open: boolean;
	edit?: boolean;
	onSubmit: (c: Record<string, unknown>) => Promise<void>;
	onDelete?: () => Promise<void>;
};
vi.mock('@/components/settings/AddToolServerModal', () => ({
	AddToolServerModal: ({ open, edit, onSubmit, onDelete }: DialogProps) =>
		open ? (
			<div role="dialog">
				{edit ? 'Edit tool server dialog' : 'Add tool server dialog'}
				<button
					type="button"
					onClick={() =>
						void onSubmit({ url: 'https://mcp.example.com/', type: 'mcp', info: { name: 'Docs' } }).catch(() => {})
					}
				>
					Submit dialog
				</button>
				<button type="button" onClick={() => void onDelete?.()}>
					Delete in dialog
				</button>
			</div>
		) : null
}));
vi.mock('@/components/settings/AddTerminalServerModal', () => ({
	AddTerminalServerModal: ({ open, edit, onSubmit, onDelete }: DialogProps) =>
		open ? (
			<div role="dialog">
				{edit ? 'Edit terminal dialog' : 'Add terminal dialog'}
				<button
					type="button"
					onClick={() => void onSubmit({ name: 'Lab', url: 'http://localhost:9900' }).catch(() => {})}
				>
					Submit dialog
				</button>
				<button type="button" onClick={() => void onDelete?.()}>
					Delete in dialog
				</button>
			</div>
		) : null
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
	await screen.findByRole('button', { name: 'Edit Tools' });
};

describe('Integrations', () => {
	it('adds a tool server from Add tool server, saving the list at once and saying so once', async () => {
		await renderTab();
		expect(screen.getByText('Changes are saved as you make them.')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Add tool server' }));
		expect(screen.getByText('Add tool server dialog')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Submit dialog' }));
		await waitFor(() => expect(setToolServerConnections).toHaveBeenCalledTimes(1));
		expect(
			(vi.mocked(setToolServerConnections).mock.calls[0][1] as { TOOL_SERVER_CONNECTIONS: unknown[] })
				.TOOL_SERVER_CONNECTIONS
		).toHaveLength(2);
		expect(toast.success).toHaveBeenCalledTimes(1);
		expect(toast.success).toHaveBeenCalledWith('“Docs” added');
	});

	it('opens the editor from a tool server Edit button, and deletes it from there', async () => {
		await renderTab();
		expect(screen.getByText('OpenAPI')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Edit Tools' }));
		expect(screen.getByText('Edit tool server dialog')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Delete in dialog' }));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('“Tools” deleted'));
		expect(vi.mocked(setToolServerConnections).mock.calls[0][1]).toEqual({ TOOL_SERVER_CONNECTIONS: [] });
	});

	it('adds a terminal from Add terminal connection', async () => {
		vi.mocked(setTerminalServerConnections).mockResolvedValue({} as never);
		await renderTab();
		fireEvent.click(screen.getByRole('button', { name: 'Add terminal connection' }));
		expect(screen.getByText('Add terminal dialog')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Submit dialog' }));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('“Lab” added'));
		const saved = (
			vi.mocked(setTerminalServerConnections).mock.calls[0][1] as {
				TERMINAL_SERVER_CONNECTIONS: Record<string, unknown>[];
			}
		).TERMINAL_SERVER_CONNECTIONS;
		expect(saved).toHaveLength(2);
		expect(saved[1].id).toBeTruthy();
	});

	it('edits and deletes a terminal from its Edit button', async () => {
		vi.mocked(setTerminalServerConnections).mockResolvedValue({} as never);
		await renderTab();
		fireEvent.click(screen.getByRole('button', { name: 'Edit Box' }));
		expect(screen.getByText('Edit terminal dialog')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Submit dialog' }));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('“Lab” saved'));
		expect(
			(
				vi.mocked(setTerminalServerConnections).mock.calls[0][1] as {
					TERMINAL_SERVER_CONNECTIONS: Record<string, unknown>[];
				}
			).TERMINAL_SERVER_CONNECTIONS[0]
		).toMatchObject({
			id: 'term1',
			name: 'Lab'
		});
		fireEvent.click(screen.getByRole('button', { name: 'Delete in dialog' }));
		await waitFor(() => expect(setTerminalServerConnections).toHaveBeenCalledTimes(2));
	});

	it('turns a tool server off, saving the list, and shows Off; a refusal puts it back', async () => {
		await renderTab();
		fireEvent.click(screen.getByRole('switch', { name: 'Enable Tools' }));
		await waitFor(() => expect(setToolServerConnections).toHaveBeenCalledTimes(1));
		expect(vi.mocked(setToolServerConnections).mock.calls[0][1]).toMatchObject({
			TOOL_SERVER_CONNECTIONS: [{ config: { enable: false } }]
		});
		expect(toast.success).toHaveBeenCalledWith('“Tools” is off');
		expect(screen.getByText('Off')).toBeTruthy();
		vi.mocked(setToolServerConnections).mockRejectedValueOnce('No');
		fireEvent.click(screen.getByRole('switch', { name: 'Enable Tools' }));
		await waitFor(() => expect(toastFailure).toHaveBeenCalledWith("Couldn't save the tool servers.", 'No'));
		expect(screen.getByRole('switch', { name: 'Enable Tools' }).getAttribute('data-state')).toBe('unchecked');
	});

	it('turns a terminal off, and says a refused save', async () => {
		vi.mocked(setTerminalServerConnections).mockRejectedValueOnce('No');
		await renderTab();
		fireEvent.click(screen.getByRole('switch', { name: 'Enable Box' }));
		await waitFor(() => expect(toastFailure).toHaveBeenCalledWith("Couldn't save the terminal connections.", 'No'));
		expect(screen.getByRole('switch', { name: 'Enable Box' }).getAttribute('data-state')).toBe('checked');
	});

	it('links nowhere outside the app, and says when nothing is set up', async () => {
		vi.mocked(getToolServerConnections).mockResolvedValue({ TOOL_SERVER_CONNECTIONS: [] } as never);
		vi.mocked(getTerminalServerConnections).mockResolvedValue({ TERMINAL_SERVER_CONNECTIONS: [] } as never);
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<TooltipProvider>
					<Integrations />
				</TooltipProvider>
			</QueryClientProvider>
		);
		expect(await screen.findAllByText('None yet.')).toHaveLength(2);
		expect(document.querySelector('a[href*="open-webui"]')).toBeNull();
	});

	it('shows a tab that fails to load in place, with Try again', async () => {
		vi.mocked(getToolServerConnections).mockRejectedValueOnce(new Error('down'));
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<TooltipProvider>
					<Integrations />
				</TooltipProvider>
			</QueryClientProvider>
		);
		expect(await screen.findByText("Couldn't load the integrations")).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByRole('button', { name: 'Edit Tools' })).toBeTruthy();
	});
});
