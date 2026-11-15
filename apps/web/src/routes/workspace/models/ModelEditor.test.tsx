import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useAuthStore } from '@/lib/stores/authStore';
import { ModelEditor } from './ModelEditor';

vi.mock('@/lib/apis', () => ({ getModels: vi.fn(async () => []) }));
vi.mock('@/lib/apis/audio', () => ({ getVoices: vi.fn(async () => ({ voices: [] })) }));
vi.mock('@/lib/apis/configs', () => ({ getModelsDefaults: vi.fn(async () => ({})) }));
vi.mock('@/lib/apis/functions', () => ({ getFunctions: vi.fn(async () => []) }));
vi.mock('@/lib/apis/models', () => ({ getModelTags: vi.fn(async () => []), getBaseModelTags: vi.fn(async () => []) }));
vi.mock('@/lib/apis/skills', () => ({ getSkills: vi.fn(async () => []) }));
vi.mock('@/lib/apis/terminal', () => ({ getTerminalServers: vi.fn(async () => []) }));
vi.mock('@/lib/apis/tools', () => ({ getTools: vi.fn(async () => []) }));
vi.mock('@/lib/apis/knowledge', () => ({
	searchKnowledgeBases: vi.fn(async () => ({ items: [] })),
	searchKnowledgeFiles: vi.fn(async () => ({ items: [] }))
}));
vi.mock('@/lib/apis/notes', () => ({ searchNotes: vi.fn(async () => ({ items: [] })) }));
vi.mock('@/lib/apis/files', () => ({ uploadFile: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const renderEditor = (meta: Record<string, unknown> = {}) =>
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<MemoryRouter>
					<ModelEditor
						model={{ id: 'm1', name: 'My model', base_model_id: 'base', meta, params: {} }}
						edit
						onSubmit={vi.fn()}
						onBack={vi.fn()}
					/>
				</MemoryRouter>
			</TooltipProvider>
		</QueryClientProvider>
	);

describe('ModelEditor show/hide sections', () => {
	beforeEach(() => {
		useAuthStore.setState({ token: 'jwt', user: { id: 'u1', role: 'admin' } } as never);
	});

	it('toggles the JSON preview from its Show/Hide button', async () => {
		renderEditor();
		const section = (await screen.findByText('JSON Preview')).parentElement as HTMLElement;
		expect(section.parentElement?.querySelector('pre')).toBeNull();
		fireEvent.click(within(section).getByRole('button', { name: 'Show' }));
		await waitFor(() => expect(section.parentElement?.querySelector('pre')?.textContent).toContain('"id": "m1"'));
		fireEvent.click(within(section).getByRole('button', { name: 'Hide' }));
		expect(section.parentElement?.querySelector('pre')).toBeNull();
	});

	it('toggles the advanced parameters from their Show/Hide button', async () => {
		renderEditor();
		const section = (await screen.findByText('Advanced Params')).parentElement as HTMLElement;
		const body = () => section.parentElement?.textContent?.length ?? 0;
		const before = body();
		fireEvent.click(within(section).getByRole('button', { name: 'Show' }));
		expect(within(section).getByRole('button', { name: 'Hide' })).toBeInTheDocument();
		expect(body()).toBeGreaterThan(before);
		fireEvent.click(within(section).getByRole('button', { name: 'Hide' }));
		expect(body()).toBe(before);
	});
});

describe('ModelEditor toggles and reset', () => {
	beforeEach(() => {
		useAuthStore.setState({ token: 'jwt', user: { id: 'u1', role: 'admin' } } as never);
	});

	it('hides the description box once Custom is switched to Default, and shows it again', async () => {
		renderEditor();
		fireEvent.click(await screen.findByRole('button', { name: 'Custom description enabled' }));
		expect(screen.getByRole('button', { name: 'Default description enabled' })).toBeInTheDocument();
		expect(screen.queryByRole('textbox', { name: 'Description' })).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Default description enabled' }));
		expect(screen.getByRole('textbox', { name: 'Description' })).toBeInTheDocument();
	});

	it('switches prompt suggestions between Default and Custom', async () => {
		renderEditor();
		fireEvent.click(await screen.findByRole('button', { name: 'Default prompt suggestions' }));
		expect(screen.getByRole('button', { name: 'Custom prompt suggestions' })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Custom prompt suggestions' }));
		expect(screen.getByRole('button', { name: 'Default prompt suggestions' })).toBeInTheDocument();
	});

	it('puts the default profile image back from Reset, which then shows the initials (#924)', async () => {
		// jsdom never loads an image; this one loads at once, as a browser's would.
		class LoadingImage {
			listeners: Record<string, (event: { currentTarget: LoadingImage }) => void> = {};
			complete = false;
			naturalWidth = 0;
			addEventListener(type: string, listener: (event: { currentTarget: LoadingImage }) => void) {
				this.listeners[type] = listener;
			}
			removeEventListener() {}
			set src(_: string) {
				this.complete = true;
				this.naturalWidth = 10;
				queueMicrotask(() => this.listeners.load?.({ currentTarget: this }));
			}
		}
		vi.stubGlobal('Image', LoadingImage);
		renderEditor({ profile_image_url: 'data:image/png;base64,AAAA' });
		const upload = await screen.findByRole('button', { name: 'Upload profile image' });
		await waitFor(() => expect(upload.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA'));
		fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
		vi.unstubAllGlobals();
		expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();
		expect(upload.querySelector('[data-slot="avatar-fallback"]')).not.toBeNull();
	});
});

describe('ModelEditor fields (#1057, #983)', () => {
	beforeEach(() => {
		useAuthStore.setState({ token: 'jwt', user: { id: 'u1', role: 'admin' } } as never);
	});

	it('labels the name, id, system prompt and voice visibly, on the shared fields', async () => {
		renderEditor();
		const name = await screen.findByLabelText('Model name');
		expect(name).toHaveAttribute('data-slot', 'input');
		expect(name).toHaveValue('My model');
		expect(screen.getByText('Model name').tagName).toBe('LABEL');
		const id = screen.getByLabelText('Model ID');
		expect(id).toBeDisabled();
		expect(id).toHaveClass('font-mono');
		expect(screen.getByLabelText('System prompt')).toHaveAttribute('data-slot', 'textarea');
		expect(screen.getByLabelText('System prompt').getAttribute('placeholder')).toMatch(/^e\.g\. /);
		expect(screen.getByLabelText('TTS voice')).toHaveAttribute('list', 'tts-voices');
	});

	it('ties the Description label to its field once a custom description is on', async () => {
		renderEditor({ description: 'Explains statistics' });
		expect(await screen.findByLabelText('Description')).toHaveValue('Explains statistics');
		expect(screen.getByLabelText('Description')).toHaveAttribute('data-slot', 'textarea');
	});
});
