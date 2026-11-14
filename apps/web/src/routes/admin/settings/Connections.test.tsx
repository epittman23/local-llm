import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getModels } from '@/lib/apis';
import { getConnectionsConfig } from '@/lib/apis/configs';
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
vi.mock('@/components/settings/AddConnectionModal', () => ({
	AddConnectionModal: ({ open, edit }: { open: boolean; edit?: boolean }) =>
		open ? <div role="dialog">{edit ? 'Edit connection dialog' : 'Add connection dialog'}</div> : null
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
	await screen.findByRole('button', { name: 'Add OpenAI Connection' });
};

describe('Connections', () => {
	it('opens the editor from a connection cog', async () => {
		await renderTab();
		fireEvent.click(screen.getByRole('button', { name: 'Configure https://openrouter.ai/api/v1' }));
		expect(screen.getByText('Edit connection dialog')).toBeTruthy();
	});

	it('opens the add dialog from the OpenAI plus button', async () => {
		await renderTab();
		fireEvent.click(screen.getByRole('button', { name: 'Add OpenAI Connection' }));
		expect(screen.getByText('Add connection dialog')).toBeTruthy();
	});

	it('opens the add dialog from the Ollama plus button', async () => {
		await renderTab();
		fireEvent.click(screen.getByRole('button', { name: 'Add Ollama Connection' }));
		expect(screen.getByText('Add connection dialog')).toBeTruthy();
	});

	it('disables a connection from its switch and saves at once', async () => {
		await renderTab();
		fireEvent.click(screen.getByRole('switch', { name: 'Disable https://openrouter.ai/api/v1' }));
		await waitFor(() => expect(updateOpenAIConfig).toHaveBeenCalledTimes(1));
		expect(vi.mocked(updateOpenAIConfig).mock.calls[0][1]).toMatchObject({
			OPENAI_API_CONFIGS: { 0: { enable: false } }
		});
	});

	it('refreshes the model list from the Refresh button when the cache is on', async () => {
		await renderTab();
		fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
		await waitFor(() => expect(getModels).toHaveBeenCalledWith('tok', null, false, true));
	});
});
