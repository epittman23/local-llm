import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { deleteModel, getOllamaModels, pullModel } from '@/lib/apis/ollama';
import { useAuthStore } from '@/lib/stores/authStore';
import { ManageOllama } from './ManageOllama';
import { useDownloadPool } from './ollamaDownloads';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn() }) }));
vi.mock('@/lib/apis/ollama', () => ({
	createModel: vi.fn(),
	deleteModel: vi.fn(),
	downloadModel: vi.fn(),
	getOllamaModels: vi.fn(),
	pullModel: vi.fn(),
	uploadModel: vi.fn()
}));

beforeEach(() => {
	vi.clearAllMocks();
	useDownloadPool.setState({ pool: {} });
	useAuthStore.setState({ token: 'tok' } as never);
	vi.mocked(getOllamaModels).mockResolvedValue([
		{ id: 'mistral:7b', name: 'mistral:7b', size: 4 * 1024 ** 3 }
	] as never);
});

const renderPanel = async () => {
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<ManageOllama urlIdx={1} />
			</TooltipProvider>
		</QueryClientProvider>
	);
	await screen.findByLabelText('Model tag to pull');
};

describe('ManageOllama', () => {
	it('enables Pull Model only once a tag is typed', async () => {
		await renderPanel();
		const pull = screen.getByRole('button', { name: 'Pull Model' }) as HTMLButtonElement;
		expect(pull.disabled).toBe(true);
		fireEvent.change(screen.getByLabelText('Model tag to pull'), { target: { value: 'llama3' } });
		expect(pull.disabled).toBe(false);
	});

	it('enables Delete Model once a model is chosen and confirms before deleting', async () => {
		vi.mocked(deleteModel).mockResolvedValue(true as never);
		await renderPanel();
		const del = screen.getByRole('button', { name: 'Delete Model' }) as HTMLButtonElement;
		expect(del.disabled).toBe(true);
		fireEvent.change(screen.getByLabelText('Model to delete'), { target: { value: 'mistral:7b' } });
		fireEvent.click(del);
		expect(await screen.findByText('This will delete mistral:7b and cannot be undone.')).toBeTruthy();
		expect(deleteModel).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
		await waitFor(() => expect(deleteModel).toHaveBeenCalledWith('tok', 'mistral:7b', '1'));
	});

	it('shows the progress and digest of a download in flight', async () => {
		useDownloadPool.setState({ pool: { 'llama3:8b': { done: false, pullProgress: 40, digest: 'sha256:abc' } } });
		await renderPanel();
		expect(screen.getByText('40%')).toBeTruthy();
		expect(screen.getByText('sha256:abc')).toBeTruthy();
	});

	it('aborts a download from its cancel button', async () => {
		const abortController = new AbortController();
		useDownloadPool.setState({
			pool: { 'llama3:8b': { done: false, pullProgress: 10, abortController } }
		});
		await renderPanel();
		fireEvent.click(screen.getByRole('button', { name: 'Cancel llama3:8b download' }));
		expect(abortController.signal.aborted).toBe(true);
	});

	it('shows which model is being updated and cancels the update', async () => {
		const abort = new AbortController();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"status":"pulling","digest":"d1","completed":1,"total":4}\n'));
				abort.signal.addEventListener('abort', () => controller.close());
			}
		});
		vi.mocked(pullModel).mockResolvedValue([new Response(body), abort] as never);
		await renderPanel();
		fireEvent.click(screen.getByRole('button', { name: 'Update All Models' }));
		expect(await screen.findByText(/Updating "mistral:7b"/)).toBeTruthy();
		fireEvent.click(await screen.findByRole('button', { name: 'Cancel update' }));
		await waitFor(() => expect(abort.signal.aborted).toBe(true));
		await waitFor(() => expect(toast.info).toHaveBeenCalledWith('Model update cancelled'));
	});

	it('hides the experimental upload section until it is shown', async () => {
		await renderPanel();
		expect(screen.queryByText('Upload a GGUF model')).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Show' }));
		expect(screen.getByText('Upload a GGUF model')).toBeTruthy();
	});

	it('opens the file picker from the select button and shows the chosen file', async () => {
		await renderPanel();
		fireEvent.click(screen.getByRole('button', { name: 'Show' }));
		const input = screen.getByLabelText('GGUF file') as HTMLInputElement;
		const click = vi.spyOn(input, 'click');
		fireEvent.click(screen.getByRole('button', { name: 'Click here to select' }));
		expect(click).toHaveBeenCalledTimes(1);
		fireEvent.change(input, { target: { files: [new File(['x'], 'model.gguf')] } });
		expect(screen.getByRole('button', { name: 'model.gguf' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Upload Model' })).toBeTruthy();
	});

	it('switches the upload between file and URL mode', async () => {
		await renderPanel();
		fireEvent.click(screen.getByRole('button', { name: 'Show' }));
		fireEvent.click(screen.getByRole('button', { name: 'File Mode' }));
		expect(screen.getByLabelText('Hugging Face URL')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'URL Mode' })).toBeTruthy();
	});
});
