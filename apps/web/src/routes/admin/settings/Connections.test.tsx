import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toastFailure } from '@/components/common/failureToast';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getModels } from '@/lib/apis';
import { getConnectionsConfig, setConnectionsConfig } from '@/lib/apis/configs';
import { getOllamaConfig, updateOllamaConfig } from '@/lib/apis/ollama';
import { getOpenAIConfig, getOpenAIModels, updateOpenAIConfig } from '@/lib/apis/openai';
import { useAuthStore } from '@/lib/stores/authStore';
import Connections from './Connections';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('@/lib/apis', () => ({ getModels: vi.fn() }));
vi.mock('@/lib/apis/configs', () => ({ getConnectionsConfig: vi.fn(), setConnectionsConfig: vi.fn() }));
vi.mock('@/lib/apis/ollama', () => ({ getOllamaConfig: vi.fn(), updateOllamaConfig: vi.fn() }));
vi.mock('@/lib/apis/openai', () => ({
	getOpenAIConfig: vi.fn(),
	getOpenAIModels: vi.fn(),
	updateOpenAIConfig: vi.fn()
}));
vi.mock('@/lib/settings/useAdminSaved', () => ({ useAdminConfigSaved: () => vi.fn() }));
vi.mock('@/components/common/failureToast', () => ({ toastFailure: vi.fn() }));
// The dialog has its own tests; here it hands back a connection or deletes one.
vi.mock('@/components/settings/AddConnectionModal', () => ({
	AddConnectionModal: ({
		open,
		edit,
		onSubmit,
		onDelete
	}: {
		open: boolean;
		edit?: boolean;
		onSubmit: (c: unknown) => Promise<void>;
		onDelete?: () => Promise<void>;
	}) =>
		open ? (
			<div role="dialog">
				{edit ? 'Edit connection dialog' : 'Add connection dialog'}
				<button
					type="button"
					onClick={() =>
						void onSubmit({ url: 'http://127.0.0.1:8090/v1/', key: 'nk', config: { enable: true } }).catch(() => {})
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

beforeEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({ token: 'tok' } as never);
	vi.mocked(getOpenAIConfig).mockResolvedValue({
		ENABLE_OPENAI_API: true,
		OPENAI_API_BASE_URLS: ['https://openrouter.ai/api/v1'],
		OPENAI_API_KEYS: ['k'],
		OPENAI_API_CONFIGS: { 0: { enable: true } }
	} as never);
	vi.mocked(getOllamaConfig).mockResolvedValue({
		ENABLE_OLLAMA_API: true,
		OLLAMA_BASE_URLS: ['http://localhost:11434'],
		OLLAMA_API_CONFIGS: { 0: { enable: true } }
	} as never);
	vi.mocked(getConnectionsConfig).mockResolvedValue({
		ENABLE_DIRECT_CONNECTIONS: false,
		ENABLE_BASE_MODELS_CACHE: true
	} as never);
	vi.mocked(getOpenAIModels).mockResolvedValue({ data: [] } as never);
	vi.mocked(updateOpenAIConfig).mockResolvedValue({} as never);
	vi.mocked(updateOllamaConfig).mockResolvedValue({} as never);
	vi.mocked(getModels).mockResolvedValue([] as never);
});

const renderTab = async () => {
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<Connections />
			</TooltipProvider>
		</QueryClientProvider>
	);
	await screen.findByRole('list', { name: 'OpenAI-compatible connections' });
};

const addButtons = () => screen.getAllByRole('button', { name: 'Add connection' });

describe('Connections', () => {
	it('opens the editor from a connection’s Edit button', async () => {
		await renderTab();
		fireEvent.click(screen.getByRole('button', { name: 'Edit https://openrouter.ai/api/v1' }));
		expect(screen.getByText('Edit connection dialog')).toBeTruthy();
	});

	it('adds an OpenAI-compatible connection, dropping its trailing slash, and says so once', async () => {
		await renderTab();
		fireEvent.click(addButtons()[0]);
		expect(screen.getByText('Add connection dialog')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Submit dialog' }));
		await waitFor(() => expect(updateOpenAIConfig).toHaveBeenCalledTimes(1));
		expect(vi.mocked(updateOpenAIConfig).mock.calls[0][1]).toMatchObject({
			OPENAI_API_BASE_URLS: ['https://openrouter.ai/api/v1', 'http://127.0.0.1:8090/v1'],
			OPENAI_API_KEYS: ['k', 'nk']
		});
		expect(toast.success).toHaveBeenCalledTimes(1);
		expect(toast.success).toHaveBeenCalledWith('“http://127.0.0.1:8090/v1/” added');
	});

	it('adds an Ollama connection with its key inside the config', async () => {
		await renderTab();
		fireEvent.click(addButtons()[1]);
		fireEvent.click(screen.getByRole('button', { name: 'Submit dialog' }));
		await waitFor(() => expect(updateOllamaConfig).toHaveBeenCalledTimes(1));
		expect(vi.mocked(updateOllamaConfig).mock.calls[0][1]).toMatchObject({
			OLLAMA_BASE_URLS: ['http://localhost:11434', 'http://127.0.0.1:8090/v1'],
			OLLAMA_API_CONFIGS: { 1: { enable: true, key: 'nk' } }
		});
	});

	it('turns a connection off from its switch, saving at once, and shows Off rather than fading', async () => {
		await renderTab();
		expect(screen.getByText('Changes are saved as you make them.')).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
		fireEvent.click(screen.getByRole('switch', { name: 'Enable https://openrouter.ai/api/v1' }));
		await waitFor(() => expect(updateOpenAIConfig).toHaveBeenCalledTimes(1));
		expect(vi.mocked(updateOpenAIConfig).mock.calls[0][1]).toMatchObject({
			OPENAI_API_CONFIGS: { 0: { enable: false } }
		});
		expect(toast.success).toHaveBeenCalledWith('“https://openrouter.ai/api/v1” is off');
		const row = screen.getByText('https://openrouter.ai/api/v1').closest('li') as HTMLElement;
		expect(within(row).getByText('Off')).toBeTruthy();
		expect(row.className).not.toMatch(/opacity/);
		expect(screen.getByText('https://openrouter.ai/api/v1').parentElement?.className).not.toMatch(/opacity/);
		expect(
			within(row).getByText('local-llm sends requests to https://openrouter.ai/api/v1/chat/completions')
		).toBeTruthy();
	});

	it('puts the old values back and says why when the server refuses a change', async () => {
		vi.mocked(updateOllamaConfig).mockRejectedValueOnce('Not allowed');
		await renderTab();
		const sw = screen.getByRole('switch', { name: 'Enable http://localhost:11434' });
		fireEvent.click(sw);
		await waitFor(() =>
			expect(toastFailure).toHaveBeenCalledWith("Couldn't save the Ollama connections.", 'Not allowed')
		);
		expect(sw.getAttribute('data-state')).toBe('checked');
		expect(toast.success).not.toHaveBeenCalled();
	});

	it('holds every control while a save is in flight, so a second change cannot overlap it', async () => {
		// Save A: toggling the OpenRouter connection, which the server then refuses.
		let refuse: (reason: unknown) => void = () => {};
		vi.mocked(updateOpenAIConfig).mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					refuse = reject;
				})
		);
		await renderTab();
		const sw = screen.getByRole('switch', { name: 'Enable https://openrouter.ai/api/v1' });
		fireEvent.click(sw);
		expect(await screen.findByText('Saving…')).toBeTruthy();
		expect(sw).toBeDisabled();
		expect(sw.getAttribute('data-state')).toBe('unchecked');
		// The rest of the tab waits too: no delete, no other list, no other switch.
		expect(screen.getByRole('button', { name: 'Edit https://openrouter.ai/api/v1' })).toBeDisabled();
		expect(screen.getByRole('switch', { name: 'Enable http://localhost:11434' })).toBeDisabled();
		expect(screen.getByRole('switch', { name: 'Direct connections' })).toBeDisabled();
		for (const add of screen.getAllByRole('button', { name: 'Add connection' })) expect(add).toBeDisabled();

		refuse('Not allowed');
		await waitFor(() => expect(screen.getByText('Changes are saved as you make them.')).toBeTruthy());
		// What the server holds is on screen again, and the tab can be used.
		expect(sw.getAttribute('data-state')).toBe('checked');
		expect(sw).toBeEnabled();
		expect(screen.getByRole('switch', { name: 'Enable http://localhost:11434' })).toBeEnabled();
		expect(updateOpenAIConfig).toHaveBeenCalledTimes(1);
	});

	it('deletes a connection from its dialog', async () => {
		await renderTab();
		fireEvent.click(screen.getByRole('button', { name: 'Edit http://localhost:11434' }));
		fireEvent.click(screen.getByRole('button', { name: 'Delete in dialog' }));
		await waitFor(() => expect(updateOllamaConfig).toHaveBeenCalledTimes(1));
		expect(vi.mocked(updateOllamaConfig).mock.calls[0][1]).toMatchObject({ OLLAMA_BASE_URLS: [] });
		expect(toast.success).toHaveBeenCalledWith('“http://localhost:11434” deleted');
	});

	it('names the OpenAI-compatible block for what it holds, with no Open WebUI help link (#1019)', async () => {
		await renderTab();
		expect(screen.getByText('OpenAI-compatible connections')).toBeTruthy();
		expect(screen.getByText('OpenRouter, or llama-server on :8090.')).toBeTruthy();
		expect(screen.queryByText(/Manage .* Connections/)).toBeNull();
		expect(screen.queryByText(/Trouble accessing Ollama/)).toBeNull();
		expect(document.querySelector('a[href*="open-webui"]')).toBeNull();
	});

	it('turns an API off and says so', async () => {
		await renderTab();
		fireEvent.click(screen.getByRole('switch', { name: 'OpenAI-compatible connections' }));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('OpenAI-compatible connections are off'));
		expect(screen.queryByRole('list', { name: 'OpenAI-compatible connections' })).toBeNull();
	});

	it('refreshes the model list when the cache is on', async () => {
		await renderTab();
		fireEvent.click(screen.getByRole('button', { name: 'Refresh the model list' }));
		await waitFor(() => expect(getModels).toHaveBeenCalledWith('tok', null, false, true));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Model list refreshed'));
	});

	it('saves a user-connections switch, and says a refusal', async () => {
		vi.mocked(setConnectionsConfig).mockResolvedValueOnce({} as never);
		vi.mocked(setConnectionsConfig).mockRejectedValueOnce('No');
		await renderTab();
		const directSwitch = screen.getByRole('switch', { name: 'Direct connections' });
		fireEvent.click(directSwitch);
		await waitFor(() =>
			expect(setConnectionsConfig).toHaveBeenCalledWith(
				'tok',
				expect.objectContaining({ ENABLE_DIRECT_CONNECTIONS: true })
			)
		);
		fireEvent.click(screen.getByRole('switch', { name: 'Cache the base model list' }));
		await waitFor(() => expect(toastFailure).toHaveBeenCalledWith("Couldn't save the change.", 'No'));
	});

	it('shows a tab that fails to load in place, with Try again', async () => {
		vi.mocked(getOpenAIConfig).mockRejectedValueOnce(new Error('down'));
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<TooltipProvider>
					<Connections />
				</TooltipProvider>
			</QueryClientProvider>
		);
		expect(await screen.findByText("Couldn't load the connections")).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByRole('list', { name: 'OpenAI-compatible connections' })).toBeTruthy();
	});
});
