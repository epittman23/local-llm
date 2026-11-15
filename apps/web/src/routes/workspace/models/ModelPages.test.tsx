import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NOT_FOUND_DETAIL } from '@/components/common/Gone';
import { createNewModel, getModelById, updateModelById } from '@/lib/apis/models';
import { useAuthStore } from '@/lib/stores/authStore';
import { ModelCreatePage, ModelEditPage } from './ModelPages';
import type { ModelInfo } from './modelEditorLogic';

vi.mock('@/lib/apis/models', () => ({ createNewModel: vi.fn(), getModelById: vi.fn(), updateModelById: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const info: ModelInfo = {
	id: 'tutor',
	name: 'Tutor',
	base_model_id: 'base',
	meta: { profile_image_url: null, suggestion_prompts: [{ content: '' }, { content: 'Hi' }] },
	params: {}
};

// The editor itself is tested in ModelEditor.test.tsx; here it only hands over what it would save.
vi.mock('./ModelEditor', () => ({
	ModelEditor: ({
		model,
		onSubmit,
		onBack
	}: {
		model: { name: string } | null;
		onSubmit: (i: ModelInfo) => Promise<void>;
		onBack: () => void;
	}) => (
		<div>
			<p>Editing {model?.name ?? 'a new model'}</p>
			<button
				type="button"
				onClick={() =>
					onSubmit(info).then(onBack, (e) => {
						document.body.dataset.saveError = String(e);
					})
				}
			>
				Save
			</button>
		</div>
	)
}));

function renderAt(path: string, element: React.ReactNode) {
	const router = createMemoryRouter(
		[
			{ path: '/workspace/models/edit', element },
			{ path: '/workspace/models/create', element },
			{ path: '/workspace/models', element: <p>The list</p> }
		],
		{ initialEntries: [path] }
	);
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	);
	return router;
}

beforeEach(() => {
	vi.clearAllMocks();
	delete document.body.dataset.saveError;
	useAuthStore.setState({ token: 'jwt', user: { id: 'u1', role: 'admin' } } as never);
});

describe('ModelCreatePage', () => {
	it('creates the model with no stored picture and only the written suggestions, then says so by name', async () => {
		vi.mocked(createNewModel).mockResolvedValue({ id: 'tutor' } as never);
		const router = renderAt('/workspace/models/create', <ModelCreatePage />);
		fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
		await waitFor(() => expect(router.state.location.pathname).toBe('/workspace/models'));
		expect(vi.mocked(createNewModel).mock.calls[0][1]).toMatchObject({
			meta: { profile_image_url: null, suggestion_prompts: [{ content: 'Hi' }] }
		});
		expect(toast.success).toHaveBeenCalledWith('Created “Tutor”');
	});

	it('starts from a clone left in sessionStorage, once', async () => {
		sessionStorage.model = JSON.stringify({ id: 'a-clone', name: 'A (Clone)', meta: {}, params: {} });
		renderAt('/workspace/models/create', <ModelCreatePage />);
		expect(await screen.findByText('Editing A (Clone)')).toBeInTheDocument();
		expect(sessionStorage.model).toBeUndefined();
	});

	it('hands a refused create back to the editor, and stays', async () => {
		vi.mocked(createNewModel).mockResolvedValue(null as never);
		const router = renderAt('/workspace/models/create', <ModelCreatePage />);
		fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
		await waitFor(() => expect(document.body.dataset.saveError).toBe('Error: The server did not save it.'));
		expect(router.state.location.pathname).toBe('/workspace/models/create');
		expect(toast.success).not.toHaveBeenCalled();
	});
});

describe('ModelEditPage', () => {
	it('loads the model by id and saves it back', async () => {
		vi.mocked(getModelById).mockResolvedValue({ id: 'tutor', name: 'Tutor', write_access: true } as never);
		vi.mocked(updateModelById).mockResolvedValue({ id: 'tutor' } as never);
		const router = renderAt('/workspace/models/edit?id=tutor', <ModelEditPage />);
		fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
		await waitFor(() => expect(router.state.location.pathname).toBe('/workspace/models'));
		expect(updateModelById).toHaveBeenCalledWith('jwt', 'tutor', info);
		expect(toast.success).toHaveBeenCalledWith('Saved “Tutor”');
	});

	it('says in place that a missing model does not exist, with a way back (NAV-3)', async () => {
		vi.mocked(getModelById).mockRejectedValue(NOT_FOUND_DETAIL);
		const router = renderAt('/workspace/models/edit?id=nope', <ModelEditPage />);
		expect(await screen.findByRole('heading', { level: 2, name: "This model doesn't exist." })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Go to Models' }));
		await waitFor(() => expect(router.state.location.pathname).toBe('/workspace/models'));
	});

	it('offers to try again when the load fails for another reason (STA-4)', async () => {
		vi.mocked(getModelById).mockRejectedValueOnce('Internal error');
		renderAt('/workspace/models/edit?id=tutor', <ModelEditPage />);
		expect(await screen.findByText("Couldn't load the model")).toBeInTheDocument();
		vi.mocked(getModelById).mockResolvedValue({ id: 'tutor', name: 'Tutor', write_access: true } as never);
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByText('Editing Tutor')).toBeInTheDocument();
	});

	it('sends a model this user may only read back to the list, saying why', async () => {
		vi.mocked(getModelById).mockResolvedValue({ id: 'tutor', name: 'Tutor', write_access: false } as never);
		const router = renderAt('/workspace/models/edit?id=tutor', <ModelEditPage />);
		await waitFor(() => expect(router.state.location.pathname).toBe('/workspace/models'));
		expect(toast.error).toHaveBeenCalledWith("You can't edit “Tutor”: it is shared with you to use, not to change.");
	});

	it('goes back to the list without an id', async () => {
		const router = renderAt('/workspace/models/edit', <ModelEditPage />);
		await waitFor(() => expect(router.state.location.pathname).toBe('/workspace/models'));
	});
});
