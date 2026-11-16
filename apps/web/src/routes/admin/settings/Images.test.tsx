import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getConfig, updateConfig } from '@/lib/apis/images';
import { useAuthStore } from '@/lib/stores/authStore';
import Images from './Images';

// FRM-2: what Save refuses is said under the field it is about, which gets
// focus, rather than in a toast that can sit over the SaveBar.

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({
	toast: Object.assign(vi.fn(), { error: toastError, success: vi.fn(), warning: vi.fn() })
}));
vi.mock('@/lib/apis/images', () => ({
	getConfig: vi.fn(),
	getImageGenerationModels: vi.fn(async () => []),
	updateConfig: vi.fn(),
	verifyConfigUrl: vi.fn()
}));
vi.mock('@/lib/apis', () => ({ getBackendConfig: vi.fn(async () => null) }));

const config = (over: Record<string, unknown> = {}) => ({
	ENABLE_IMAGE_GENERATION: false,
	ENABLE_IMAGE_PROMPT_GENERATION: true,
	IMAGE_GENERATION_ENGINE: 'openai',
	IMAGE_GENERATION_MODEL: '',
	IMAGE_SIZE: '512x512',
	IMAGE_STEPS: 50,
	IMAGES_OPENAI_API_BASE_URL: 'https://api.openai.com/v1',
	IMAGES_OPENAI_API_KEY: '',
	IMAGES_OPENAI_API_PARAMS: { quality: 'hd' },
	AUTOMATIC1111_PARAMS: {},
	COMFYUI_BASE_URL: '',
	COMFYUI_WORKFLOW: '',
	COMFYUI_WORKFLOW_NODES: [],
	ENABLE_IMAGE_EDIT: false,
	IMAGE_EDIT_ENGINE: 'openai',
	IMAGES_EDIT_COMFYUI_WORKFLOW: '',
	IMAGES_EDIT_COMFYUI_WORKFLOW_NODES: [],
	...over
});

beforeEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({ token: 't' } as never);
	vi.mocked(updateConfig).mockImplementation(async (_token, body) => body as never);
});

const renderTab = async (stored: Record<string, unknown>) => {
	vi.mocked(getConfig).mockResolvedValue(stored as never);
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<Images />
			</TooltipProvider>
		</QueryClientProvider>
	);
	return screen.findByRole('button', { name: 'Save' });
};

describe('Images: what Save refuses is said under its field (FRM-2)', () => {
	it('Additional Parameters that are not JSON: under the box, focused, nothing sent until put right', async () => {
		const save = await renderTab(config());
		const params = within(screen.getByRole('region', { name: 'Create Image' })).getByLabelText('Additional Parameters');
		fireEvent.change(params, { target: { value: '[1' } });
		fireEvent.click(save);

		expect(params).toHaveAttribute('aria-invalid', 'true');
		expect(params).toHaveAccessibleDescription('Invalid JSON format for OpenAI Additional Parameters.');
		await waitFor(() => expect(params).toHaveFocus());
		expect(toastError).not.toHaveBeenCalled();
		expect(updateConfig).not.toHaveBeenCalled();

		fireEvent.change(params, { target: { value: '{"quality":"standard"}' } });
		expect(params).not.toHaveAttribute('aria-invalid');
		fireEvent.click(save);
		await waitFor(() => expect(updateConfig).toHaveBeenCalledOnce());
		expect(vi.mocked(updateConfig).mock.calls[0][1]).toMatchObject({
			IMAGES_OPENAI_API_PARAMS: { quality: 'standard' }
		});
	});

	it('a ComfyUI workflow that is not JSON: under its row, with focus on Edit', async () => {
		const save = await renderTab(config({ IMAGE_GENERATION_ENGINE: 'comfyui', COMFYUI_WORKFLOW: '{oops' }));
		fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'http://comfy:8188' } });
		fireEvent.click(save);

		const edit = await screen.findByRole('button', { name: 'Edit workflow.json content' });
		expect(edit).toHaveAccessibleDescription('Invalid JSON format for ComfyUI Workflow.');
		await waitFor(() => expect(edit).toHaveFocus());
		expect(updateConfig).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
		expect(screen.getByRole('button', { name: 'Edit workflow.json content' })).not.toHaveAccessibleDescription();
	});

	it('a missing engine key turns generation off and says why, rather than marking the field', async () => {
		await renderTab(config());
		fireEvent.click(screen.getByRole('switch', { name: 'Image Generation' }));
		fireEvent.change(await screen.findByLabelText('Model'), { target: { value: 'dall-e-3' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() => expect(toastError).toHaveBeenCalledWith('OpenAI API Key is required.'));
		expect(screen.getByRole('switch', { name: 'Image Generation' })).not.toBeChecked();
		expect(updateConfig).not.toHaveBeenCalled();
	});
});
