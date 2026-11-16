import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { toastFailure } from '@/components/common/failureToast';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
	getOrchestratorLifecycle,
	getOrchestratorPolicy,
	putOrchestratorLifecycle,
	putOrchestratorPolicy,
	refreshOrchestratorTerminals,
	verifyTerminalServerConnection
} from '@/lib/apis/configs';
import { getTerminalConfig } from '@/lib/apis/terminal';
import { useAuthStore } from '@/lib/stores/authStore';
import { AddTerminalServerModal } from './AddTerminalServerModal';
import type { TerminalConnection } from './terminalServerModel';

// Admin's one-account rule (S5-D2) is tested where it is decided; here there are two accounts.
const visibility = vi.hoisted(() => ({ single: false }));
vi.mock('@/routes/admin/adminVisibility', () => ({ useAdminSingleUser: () => visibility.single }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/components/common/failureToast', () => ({ toastFailure: vi.fn() }));
vi.mock('@/lib/apis/terminal', () => ({ getTerminalConfig: vi.fn() }));
vi.mock('@/lib/apis/configs', () => ({
	getOrchestratorLifecycle: vi.fn(),
	getOrchestratorPolicy: vi.fn(),
	putOrchestratorLifecycle: vi.fn(),
	putOrchestratorPolicy: vi.fn(),
	refreshOrchestratorTerminals: vi.fn(),
	verifyTerminalServerConnection: vi.fn()
}));

beforeAll(() => {
	Element.prototype.scrollIntoView = vi.fn();
	Element.prototype.hasPointerCapture = vi.fn(() => false);
	Element.prototype.releasePointerCapture = vi.fn();
});

beforeEach(() => {
	vi.clearAllMocks();
	visibility.single = false;
	useAuthStore.setState({ token: 'jwt' } as never);
});

const ORCHESTRATOR: TerminalConnection = {
	id: 'orc',
	name: 'Orchestrator',
	url: 'http://127.0.0.1:9900',
	key: 'k',
	auth_type: 'bearer',
	server_type: 'orchestrator',
	policy_id: 'python-ds',
	config: { enable: true }
} as TerminalConnection;

function renderModal(props: Partial<Parameters<typeof AddTerminalServerModal>[0]> = {}) {
	const onSubmit = vi.fn();
	const onDelete = vi.fn();
	render(
		<TooltipProvider>
			<AddTerminalServerModal open onOpenChange={vi.fn()} onSubmit={onSubmit} onDelete={onDelete} {...props} />
		</TooltipProvider>
	);
	return { onSubmit, onDelete };
}

const url = () => screen.getByLabelText('URL');
const test = () => fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

describe('AddTerminalServerModal (#933)', () => {
	it('labels its fields on the shared controls, with Advanced closed', () => {
		renderModal();
		expect(screen.getByRole('heading', { name: 'Add terminal connection' })).toBeTruthy();
		expect(screen.getByLabelText(/^Name/).getAttribute('data-slot')).toBe('input');
		expect(screen.getByLabelText(/^ID/).getAttribute('data-slot')).toBe('input');
		expect(screen.getByRole('combobox', { name: 'Authentication' })).toBeTruthy();
		expect(screen.getByRole('combobox', { name: 'Chat uploads' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Advanced' }).getAttribute('aria-expanded')).toBe('false');
		expect(screen.queryByRole('button', { name: 'Orchestrator' })).toBeNull();
	});

	it('finds an Orchestrator, suggests a policy ID, and opens its settings behind a disclosure', async () => {
		vi.mocked(verifyTerminalServerConnection).mockResolvedValue({ type: 'orchestrator' } as never);
		renderModal();
		fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Data Science' } });
		fireEvent.change(url(), { target: { value: 'http://127.0.0.1:9900/' } });
		test();
		expect(await screen.findByText('Reachable: an Orchestrator')).toBeTruthy();
		expect(vi.mocked(verifyTerminalServerConnection).mock.calls[0][1]).toMatchObject({ url: 'http://127.0.0.1:9900' });
		const disclosure = screen.getByRole('button', { name: 'Orchestrator' });
		fireEvent.click(disclosure);
		expect((screen.getByLabelText('Policy ID') as HTMLInputElement).value).toBe('data-science');
		expect(screen.getByRole('combobox', { name: 'Chat terminals' })).toBeTruthy();
	});

	it('says under the URL why a test failed, and checks the URL first', async () => {
		vi.mocked(verifyTerminalServerConnection).mockRejectedValueOnce('Connection refused at 127.0.0.1:9.');
		renderModal();
		test();
		await waitFor(() => expect(url()).toHaveAccessibleDescription('Enter the server’s URL.'));
		fireEvent.change(url(), { target: { value: 'http://127.0.0.1:9' } });
		test();
		await waitFor(() => expect(url()).toHaveAccessibleDescription('Connection refused at 127.0.0.1:9.'));
		vi.mocked(verifyTerminalServerConnection).mockResolvedValueOnce(null as never);
		test();
		await waitFor(() =>
			expect(url()).toHaveAccessibleDescription("Couldn't reach a terminal there. Check the URL and the key.")
		);
	});

	it('tests a direct terminal from the browser', async () => {
		vi.mocked(getTerminalConfig).mockResolvedValueOnce({} as never);
		renderModal({ direct: true });
		expect(screen.queryByLabelText(/^ID/)).toBeNull();
		fireEvent.change(url(), { target: { value: 'http://localhost:9900' } });
		test();
		expect(await screen.findByText('Reachable')).toBeTruthy();
	});

	it('says a missing URL under it on Save, and saves a plain terminal', async () => {
		const { onSubmit } = renderModal();
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(url()).toHaveAccessibleDescription('Enter the server’s URL.'));
		expect(onSubmit).not.toHaveBeenCalled();
		fireEvent.change(url(), { target: { value: 'http://localhost:9900' } });
		expect(url().getAttribute('aria-invalid')).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
		expect(screen.getByLabelText('Spec path or URL')).toHaveAccessibleDescription(
			'local-llm sends requests to http://localhost:9900/openapi.json'
		);
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		expect(onSubmit.mock.calls[0][0]).toMatchObject({ url: 'http://localhost:9900' });
	});

	it('loads a saved Orchestrator policy back, refuses bad lifecycle JSON under its field, then writes the policy first', async () => {
		vi.mocked(getOrchestratorPolicy).mockResolvedValue({ data: { image: 'img:1' } } as never);
		vi.mocked(getOrchestratorLifecycle).mockResolvedValue({ data: {} } as never);
		vi.mocked(putOrchestratorPolicy).mockResolvedValue({} as never);
		vi.mocked(putOrchestratorLifecycle).mockResolvedValue({} as never);
		const { onSubmit } = renderModal({ edit: true, connection: ORCHESTRATOR });
		await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
		fireEvent.click(screen.getByRole('button', { name: 'Orchestrator' }));
		expect((screen.getByLabelText(/^Image/) as HTMLInputElement).value).toBe('img:1');
		expect(screen.getByLabelText('Policy ID')).toBeDisabled();
		fireEvent.change(screen.getByLabelText(/^Lifecycle/), { target: { value: '[' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() =>
			expect(screen.getByLabelText(/^Lifecycle/)).toHaveAccessibleDescription(
				'Enter the lifecycle as a JSON object, or leave it empty.'
			)
		);
		expect(putOrchestratorPolicy).not.toHaveBeenCalled();
		fireEvent.change(screen.getByLabelText(/^Lifecycle/), { target: { value: '{}' } });
		fireEvent.click(screen.getByRole('button', { name: 'Add variable' }));
		fireEvent.change(screen.getByLabelText('Variable 1 name'), { target: { value: 'A' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		expect(putOrchestratorPolicy).toHaveBeenCalledTimes(1);
		expect(putOrchestratorLifecycle).toHaveBeenCalledTimes(1);
	});

	it('turns Save off and says why while the saved policy cannot be read', async () => {
		vi.mocked(getOrchestratorPolicy).mockRejectedValue(new Error('down'));
		renderModal({ edit: true, connection: ORCHESTRATOR });
		expect(await screen.findByText("Couldn't load the Orchestrator's policy, so Save is off: down")).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
	});

	it('says a refused policy save, and refreshes the running terminals', async () => {
		vi.mocked(getOrchestratorPolicy).mockResolvedValue({ data: {} } as never);
		vi.mocked(getOrchestratorLifecycle).mockResolvedValue({ data: {} } as never);
		vi.mocked(putOrchestratorPolicy).mockRejectedValueOnce(new Error('no'));
		vi.mocked(refreshOrchestratorTerminals).mockResolvedValueOnce({ refreshed: 2 } as never);
		const { onSubmit } = renderModal({ edit: true, connection: ORCHESTRATOR });
		await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() =>
			expect(toastFailure).toHaveBeenCalledWith(
				"Couldn't save the Orchestrator's policy. The connection is not saved.",
				expect.any(Error)
			)
		);
		expect(onSubmit).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: 'Orchestrator' }));
		fireEvent.click(screen.getByLabelText('Reset their saved files'));
		fireEvent.click(screen.getByRole('button', { name: 'Refresh terminals' }));
		await waitFor(() => expect(refreshOrchestratorTerminals).toHaveBeenCalledTimes(1));
		expect(vi.mocked(refreshOrchestratorTerminals).mock.calls[0][3]).toEqual({
			policy_id: 'python-ds',
			only_idle: true,
			reset: true
		});
		const { toast } = await import('sonner');
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Refreshing 2 terminals'));
	});

	it('asks before deleting, naming the terminal, destructive (ACT-3)', async () => {
		vi.mocked(getOrchestratorPolicy).mockResolvedValue({ data: {} } as never);
		vi.mocked(getOrchestratorLifecycle).mockResolvedValue({ data: {} } as never);
		const { onDelete } = renderModal({ edit: true, connection: ORCHESTRATOR });
		fireEvent.click(screen.getByRole('button', { name: 'Delete connection' }));
		const ask = await screen.findByRole('alertdialog', { name: 'Delete “Orchestrator”?' });
		fireEvent.click(within(ask).getByRole('button', { name: 'Delete connection' }));
		await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
	});

	it('stays open when the save is refused', async () => {
		const onSubmit = vi.fn(async () => {
			throw new Error('refused');
		});
		const onOpenChange = vi.fn();
		render(
			<TooltipProvider>
				<AddTerminalServerModal open onOpenChange={onOpenChange} onSubmit={onSubmit} />
			</TooltipProvider>
		);
		fireEvent.change(url(), { target: { value: 'http://localhost:9900' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
	});
});

describe('Closing the terminal dialog with unsaved changes (FRM-3)', () => {
	it('closes at once while untouched; after an edit Escape asks, Keep editing returns to the field', async () => {
		const onOpenChange = vi.fn();
		renderModal({ onOpenChange });
		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		onOpenChange.mockClear();

		fireEvent.change(url(), { target: { value: 'http://127.0.0.1:8000' } });
		url().focus();
		fireEvent.keyDown(url(), { key: 'Escape' });
		const ask = await screen.findByRole('alertdialog', { name: 'Discard changes?' });
		expect(ask).toHaveTextContent('This terminal connection is not added yet.');
		fireEvent.click(within(ask).getByRole('button', { name: 'Keep editing' }));
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(url()));
		expect(onOpenChange).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it('counts the loaded policy as the start, and a change to it as unsaved', async () => {
		vi.mocked(getOrchestratorPolicy).mockResolvedValue({ data: { image: 'img:1' } } as never);
		vi.mocked(getOrchestratorLifecycle).mockResolvedValue({ data: {} } as never);
		const onOpenChange = vi.fn();
		renderModal({ edit: true, connection: ORCHESTRATOR, onOpenChange });
		await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		onOpenChange.mockClear();

		fireEvent.click(screen.getByRole('button', { name: 'Orchestrator' }));
		fireEvent.change(screen.getByLabelText(/^Image/), { target: { value: 'img:2' } });
		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		const ask = await screen.findByRole('alertdialog', { name: 'Discard changes?' });
		expect(ask).toHaveTextContent('The changes to this terminal connection are not saved.');
		expect(onOpenChange).not.toHaveBeenCalled();
	});
});

describe('A tall terminal dialog (OVL-1)', () => {
	it('scrolls its fields in DialogBody while the title and Save stay pinned', () => {
		renderModal();
		const body = document.querySelector('[data-slot="dialog-body"]') as HTMLElement;
		expect(body).toContainElement(url());
		expect(body).not.toContainElement(screen.getByRole('button', { name: 'Save' }));
		expect(body.parentElement?.tagName).toBe('FORM');
		expect(body.parentElement?.parentElement).toHaveAttribute('data-slot', 'dialog-content');
	});
});

describe('Access control on the terminal dialog (S5-D2)', () => {
	it('offers it while there is more than one account, and hides it for one', () => {
		renderModal();
		expect(screen.getByRole('button', { name: /Access control/ })).toBeInTheDocument();
		cleanup();
		visibility.single = true;
		renderModal();
		expect(screen.queryByRole('button', { name: /Access control/ })).toBeNull();
	});
});
