import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
	deleteProviderModel,
	downloadProviderModel,
	getProviderModelCatalog,
	loadProviderModel,
	unloadProviderModel
} from '@/lib/apis/openai';
import { useAuthStore } from '@/lib/stores/authStore';
import { ManageProviderModels } from './ManageProviderModels';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('@/lib/apis/openai', () => ({
	deleteProviderModel: vi.fn(),
	downloadProviderModel: vi.fn(),
	getErrorMessage: (e: unknown) => String(e),
	getProviderModelCatalog: vi.fn(),
	loadProviderModel: vi.fn(),
	unloadProviderModel: vi.fn()
}));

beforeEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({ token: 'tok' } as never);
	vi.mocked(getProviderModelCatalog).mockResolvedValue([
		{ id: 'org/alpha', display_name: 'Alpha', status: 'unloaded' },
		{ id: 'org/beta', display_name: 'Beta', loaded_instances: [{ id: 'inst-1' }] }
	] as never);
});

const renderPanel = async (supportsDelete = true) => {
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<ManageProviderModels urlIdx={2} provider="llama.cpp" label="llama.cpp" supportsDelete={supportsDelete} />
			</TooltipProvider>
		</QueryClientProvider>
	);
	await screen.findByText('Alpha');
};

describe('ManageProviderModels', () => {
	it('lists each model with its status', async () => {
		await renderPanel();
		expect(screen.getByText('Beta')).toBeTruthy();
		expect(screen.getByText('loaded')).toBeTruthy();
		expect(screen.getByText('unloaded')).toBeTruthy();
	});

	it('disables Load on a loaded model and Unload on an unloaded one', async () => {
		await renderPanel();
		expect((screen.getByRole('button', { name: 'Load Beta' }) as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByRole('button', { name: 'Load Alpha' }) as HTMLButtonElement).disabled).toBe(false);
		expect((screen.getByRole('button', { name: 'Unload Alpha' }) as HTMLButtonElement).disabled).toBe(true);
	});

	it('loads a model from its Load button', async () => {
		vi.mocked(loadProviderModel).mockResolvedValue({ ok: true } as never);
		await renderPanel();
		fireEvent.click(screen.getByRole('button', { name: 'Load Alpha' }));
		await waitFor(() => expect(loadProviderModel).toHaveBeenCalledWith('tok', 2, 'org/alpha'));
	});

	it('unloads a loaded model by its instance id', async () => {
		vi.mocked(unloadProviderModel).mockResolvedValue({ ok: true } as never);
		await renderPanel();
		fireEvent.click(screen.getByRole('button', { name: 'Unload Beta' }));
		await waitFor(() => expect(unloadProviderModel).toHaveBeenCalledWith('tok', 2, 'org/beta', 'inst-1'));
	});

	it('asks before deleting, then deletes the model', async () => {
		vi.mocked(deleteProviderModel).mockResolvedValue({ ok: true } as never);
		await renderPanel();
		fireEvent.click(screen.getByRole('button', { name: 'Delete Alpha' }));
		expect(await screen.findByText('This will delete the cached model and cannot be undone.')).toBeTruthy();
		expect(deleteProviderModel).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
		await waitFor(() => expect(deleteProviderModel).toHaveBeenCalledWith('tok', 2, 'org/alpha'));
	});

	it('has no Delete buttons when the provider cannot delete', async () => {
		await renderPanel(false);
		expect(screen.queryByRole('button', { name: 'Delete Alpha' })).toBeNull();
	});

	it('starts a download from the typed model ref', async () => {
		vi.mocked(downloadProviderModel).mockResolvedValue({ ok: true } as never);
		await renderPanel();
		const download = screen.getByRole('button', { name: 'Download Model' }) as HTMLButtonElement;
		expect(download.disabled).toBe(true);
		fireEvent.change(screen.getByLabelText('Model ref'), { target: { value: 'org/gamma' } });
		expect(download.disabled).toBe(false);
		fireEvent.click(download);
		await waitFor(() => expect(downloadProviderModel).toHaveBeenCalledWith('tok', 2, 'org/gamma'));
	});

	it('reloads the catalog from the Refresh button', async () => {
		await renderPanel();
		fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
		await waitFor(() => expect(getProviderModelCatalog).toHaveBeenCalledTimes(2));
	});
});
