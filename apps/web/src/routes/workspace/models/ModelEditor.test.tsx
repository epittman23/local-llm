import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getModels } from '@/lib/apis';
import { getFunctions } from '@/lib/apis/functions';
import { getTerminalServers } from '@/lib/apis/terminal';
import { searchUsers } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { ModelEditor } from './ModelEditor';
import type { ModelInfo } from './modelEditorLogic';

vi.mock('@/lib/apis', () => ({ getModels: vi.fn(async () => []) }));
vi.mock('@/lib/apis/audio', () => ({ getVoices: vi.fn(async () => ({ voices: [] })) }));
vi.mock('@/lib/apis/configs', () => ({ getModelsDefaults: vi.fn(async () => ({})) }));
vi.mock('@/lib/apis/functions', () => ({ getFunctions: vi.fn(async () => []) }));
vi.mock('@/lib/apis/models', () => ({ getModelTags: vi.fn(async () => []), getBaseModelTags: vi.fn(async () => []) }));
vi.mock('@/lib/apis/skills', () => ({ getSkills: vi.fn(async () => []) }));
vi.mock('@/lib/apis/terminal', () => ({ getTerminalServers: vi.fn(async () => []) }));
vi.mock('@/lib/apis/tools', () => ({ getTools: vi.fn(async () => []) }));
vi.mock('@/lib/apis/users', () => ({ searchUsers: vi.fn(async () => ({ total: 1 })) }));
vi.mock('@/lib/apis/knowledge', () => ({
	searchKnowledgeBases: vi.fn(async () => ({ items: [] })),
	searchKnowledgeFiles: vi.fn(async () => ({ items: [] }))
}));
vi.mock('@/lib/apis/notes', () => ({ searchNotes: vi.fn(async () => ({ items: [] })) }));
vi.mock('@/lib/apis/files', () => ({ uploadFile: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

type Model = NonNullable<Parameters<typeof ModelEditor>[0]['model']>;
const existing: Model = {
	id: 'm1',
	name: 'My model',
	base_model_id: 'base',
	meta: { description: 'Explains statistics', suggestion_prompts: [{ content: 'Hi', title: ['Hello', ''] }] },
	params: { system: 'Be brief.', temperature: 0.5, stop: ['END'] }
};

function renderEditor({
	model = existing as Model | null,
	edit = true,
	onSubmit = vi.fn(async (_: ModelInfo) => {}),
	onBack
}: {
	model?: Model | null;
	edit?: boolean;
	onSubmit?: (info: ModelInfo) => Promise<void>;
	onBack?: () => void;
} = {}) {
	const router = createMemoryRouter(
		[
			{
				path: '/editor',
				element: (
					<ModelEditor
						model={model}
						edit={edit}
						onSubmit={onSubmit}
						onBack={onBack ?? (() => router.navigate('/list'))}
					/>
				)
			},
			{ path: '/list', element: <p>The list</p> }
		],
		{ initialEntries: ['/list', '/editor'], initialIndex: 1 }
	);
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</QueryClientProvider>
	);
	return { router, onSubmit };
}

const status = () => screen.getByRole('status');
const save = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

beforeEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({ token: 'jwt', user: { id: 'u1', role: 'admin' } } as never);
	useConfigStore.setState({ config: null });
	vi.mocked(getModels).mockResolvedValue([
		{ id: 'base', name: 'Base' },
		{ id: 'taken', name: 'Taken' }
	] as never);
	vi.mocked(searchUsers).mockResolvedValue({ total: 1 } as never);
});

describe('ModelEditor layout (#1009)', () => {
	it('heads the page "Edit model" or "New model", in sections, with Advanced closed', async () => {
		renderEditor();
		expect(await screen.findByRole('heading', { level: 2, name: 'Edit model' })).toBeInTheDocument();
		const sections = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
		expect(sections).toEqual(['Identity', 'Behaviour', 'Knowledge and tools', 'Capabilities', 'Advanced']);
		const advanced = screen.getByRole('button', { name: 'Builtin tools, voice and parameters' });
		expect(advanced).toHaveAttribute('aria-expanded', 'false');
		expect(screen.queryByRole('group', { name: 'Builtin tools' })).toBeNull();
		fireEvent.click(advanced);
		expect(advanced).toHaveAttribute('aria-expanded', 'true');
		expect(screen.getByRole('group', { name: 'Builtin tools' })).toBeInTheDocument();
		expect(screen.getByLabelText(/Voice for reading aloud/)).toHaveAccessibleDescription(
			'Empty uses the voice set in Admin Settings > Audio.'
		);
		fireEvent.click(screen.getByRole('button', { name: 'JSON preview' }));
		expect(document.querySelector('pre')?.textContent).toContain('"id": "m1"');
	});

	it('labels its fields visibly on the shared fields, the optional ones marked (FRM-1, FRM-6)', async () => {
		renderEditor({ model: null, edit: false });
		expect(await screen.findByRole('heading', { level: 2, name: 'New model' })).toBeInTheDocument();
		expect(screen.getByLabelText('Model name')).toHaveAttribute('data-slot', 'input');
		expect(screen.getByLabelText('Model ID')).toHaveClass('font-mono');
		expect(screen.getByLabelText(/Description/)).toHaveAttribute('data-slot', 'textarea');
		expect(screen.getByText('Description').closest('label')?.textContent).toBe('Description(optional)');
		const system = screen.getByLabelText(/System prompt/);
		expect(system).toHaveAttribute('rows', '8');
		expect(system).toHaveClass('resize-y');
		expect(screen.getByLabelText(/Tags/)).toHaveAttribute('data-slot', 'input');
		expect(
			screen.getByRole('button', { name: 'Base model Choose a model, e.g. qwen/qwen3.6-27b' })
		).toBeInTheDocument();
	});

	it('keeps the description field always there; an empty one saves as no description', async () => {
		const { onSubmit } = renderEditor();
		const description = await screen.findByLabelText(/Description/);
		expect(description).toHaveValue('Explains statistics');
		fireEvent.change(description, { target: { value: '' } });
		save('Save changes');
		await waitFor(() => expect(onSubmit).toHaveBeenCalled());
		expect(vi.mocked(onSubmit).mock.calls[0][0].meta.description).toBeNull();
	});

	it('switches prompt suggestions to Default and back without losing what was written', async () => {
		renderEditor();
		expect(await screen.findByDisplayValue('Hello')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('radio', { name: 'Default' }));
		expect(screen.queryByDisplayValue('Hello')).toBeNull();
		expect(screen.getByText("A new chat with this model shows the app's suggestions.")).toBeInTheDocument();
		fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
		expect(screen.getByDisplayValue('Hello')).toBeInTheDocument();
	});

	it('offers Remove picture visibly while there is one, which then shows the initials', async () => {
		renderEditor({ model: { ...existing, meta: { profile_image_url: 'data:image/png;base64,AAAA' } } });
		fireEvent.click(await screen.findByRole('button', { name: 'Remove picture' }));
		expect(screen.queryByRole('button', { name: 'Remove picture' })).toBeNull();
		expect(status()).toHaveTextContent('Unsaved changes');
	});

	it('takes a GIF as the picture, as it is, and offers to remove it', async () => {
		renderEditor();
		await screen.findByRole('button', { name: 'Upload a picture' });
		const input = document.querySelector('input[type="file"][accept="image/*"]') as HTMLInputElement;
		fireEvent.change(input, { target: { files: [new File(['GIF89a'], 'a.gif', { type: 'image/gif' })] } });
		expect(await screen.findByRole('button', { name: 'Remove picture' })).toBeInTheDocument();
		expect(status()).toHaveTextContent('Unsaved changes');
	});

	it('refuses a picture of another type in words (#1095)', async () => {
		renderEditor();
		await screen.findByRole('button', { name: 'Upload a picture' });
		const input = document.querySelector('input[type="file"][accept="image/*"]') as HTMLInputElement;
		fireEvent.change(input, { target: { files: [new File(['x'], 'a.bmp', { type: 'image/bmp' })] } });
		expect(toast.error).toHaveBeenCalledWith('Use a PNG, JPEG, WebP or GIF image.');
	});

	it('hides Access while the install has one account, and offers it with two (S4-D1)', async () => {
		renderEditor();
		await screen.findByRole('heading', { name: 'Edit model' });
		expect(screen.queryByRole('button', { name: /Access/ })).toBeNull();
	});

	it('offers Access once the install has a second account', async () => {
		vi.mocked(searchUsers).mockResolvedValue({ total: 2 } as never);
		renderEditor();
		expect(await screen.findByRole('button', { name: /Access/ })).toBeInTheDocument();
	});

	it('shows features switched off on this install as disabled rows that say where to turn them on (S4-D3)', async () => {
		useConfigStore.setState({
			config: { name: 'x', version: '1', features: { enable_web_search: true, enable_code_interpreter: true } }
		});
		renderEditor({ model: null, edit: false });
		const images = await screen.findByRole('checkbox', { name: 'Image generation' });
		expect(images).toBeDisabled();
		expect(images).toHaveAccessibleDescription('Image generation is off in Admin Settings > Images.');
		for (const box of screen.getAllByRole('checkbox', { name: 'Web search' })) expect(box).toBeEnabled();
	});
});

describe('ModelEditor: a new model starts with what this install uses (S4-D2)', () => {
	it('ticks memory, web search and the code interpreter, not vision, image generation or the terminal', async () => {
		renderEditor({ model: null, edit: false });
		const box = async (name: string) => (await screen.findAllByRole('checkbox', { name }))[0];
		expect(await box('Memory')).toBeChecked();
		expect(await box('Web search')).toBeChecked();
		expect(await box('Code interpreter')).toBeChecked();
		expect(await box('Vision')).not.toBeChecked();
		expect(await box('Image generation')).not.toBeChecked();
		expect(await box('Terminal')).not.toBeChecked();
	});
});

describe('ModelEditor unsaved changes (#905, FRM-3)', () => {
	it.each([
		['a new model', { model: null, edit: false }],
		['an edited model with parameters and suggestions', {}]
	])('reads "All changes saved" when %s opens', async (_, opts) => {
		renderEditor(opts);
		await screen.findByRole('heading', { level: 2 });
		expect(status()).toHaveTextContent('All changes saved');
	});

	it('lets an unchanged clone be created as it is, and leaving it does not ask', async () => {
		const { router, onSubmit } = renderEditor({ model: { ...existing, id: 'm1-clone' }, edit: false });
		await screen.findByRole('heading', { level: 2, name: 'New model' });
		expect(screen.getByRole('button', { name: 'Create model' })).toBeEnabled();
		save('Create model');
		await waitFor(() => expect(onSubmit).toHaveBeenCalled());
		await waitFor(() => expect(router.state.location.pathname).toBe('/list'));
	});

	it('counts a box switched off and on again as unchanged', async () => {
		renderEditor();
		const vision = await screen.findByRole('checkbox', { name: 'Vision' });
		fireEvent.click(vision);
		expect(status()).toHaveTextContent('Unsaved changes');
		fireEvent.click(vision);
		expect(status()).toHaveTextContent('All changes saved');
	});

	it('asks before Back loses changes, and Discard changes in the bar puts them back', async () => {
		const { router } = renderEditor();
		const name = await screen.findByLabelText('Model name');
		fireEvent.change(name, { target: { value: 'Renamed' } });
		fireEvent.click(screen.getByRole('button', { name: 'Back' }));
		const ask = await screen.findByRole('alertdialog', { name: 'Discard changes?' });
		expect(ask).toHaveTextContent('Your changes to “My model” are not saved.');
		fireEvent.click(within(ask).getByRole('button', { name: 'Keep editing' }));
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		expect(router.state.location.pathname).toBe('/editor');
		fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
		expect(screen.getByLabelText('Model name')).toHaveValue('My model');
		expect(status()).toHaveTextContent('All changes saved');
	});

	it('asks once before a Back that navigates, then leaves on Discard changes', async () => {
		const { router } = renderEditor();
		fireEvent.change(await screen.findByLabelText('Model name'), { target: { value: 'Renamed' } });
		fireEvent.click(screen.getByRole('button', { name: 'Back' }));
		fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
		await waitFor(() => expect(router.state.location.pathname).toBe('/list'));
		expect(screen.queryByRole('alertdialog')).toBeNull();
	});

	it('guards a Back that swaps the editor out in place (Admin > Models), and leaves at once when clean', async () => {
		const onBack = vi.fn();
		renderEditor({ onBack });
		const name = await screen.findByLabelText('Model name');
		fireEvent.click(screen.getByRole('button', { name: 'Back' }));
		expect(onBack).toHaveBeenCalledTimes(1);
		fireEvent.change(name, { target: { value: 'Renamed' } });
		fireEvent.click(screen.getByRole('button', { name: 'Back' }));
		const ask = await screen.findByRole('alertdialog', { name: 'Discard changes?' });
		expect(onBack).toHaveBeenCalledTimes(1);
		fireEvent.click(within(ask).getByRole('button', { name: 'Discard changes' }));
		expect(onBack).toHaveBeenCalledTimes(2);
	});

	it('leaves after a save without asking, and the save carries the change', async () => {
		const { router, onSubmit } = renderEditor();
		fireEvent.change(await screen.findByLabelText('Model name'), { target: { value: 'Renamed' } });
		save('Save changes');
		await waitFor(() => expect(router.state.location.pathname).toBe('/list'));
		expect(screen.queryByRole('alertdialog')).toBeNull();
		expect(vi.mocked(onSubmit).mock.calls[0][0]).toMatchObject({ id: 'm1', name: 'Renamed' });
	});

	it('says a failed save above the bar, with the server’s words behind Details, and stays', async () => {
		const { router } = renderEditor({ onSubmit: vi.fn(async () => Promise.reject('Model id is invalid')) });
		fireEvent.change(await screen.findByLabelText('Model name'), { target: { value: 'Renamed' } });
		save('Save changes');
		const alert = await screen.findByRole('alert');
		expect(alert).toHaveTextContent("Couldn't save the model. The server answered with an error.");
		expect(within(alert).getByText('Details')).toBeInTheDocument();
		expect(within(alert).getByText('Model id is invalid')).toBeInTheDocument();
		expect(router.state.location.pathname).toBe('/editor');
		fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
		expect(screen.queryByRole('alert')).toBeNull();
	});
});

describe('ModelEditor validation (#1010, FRM-2)', () => {
	it('puts each error under its field, ties it there, and focuses the first; nothing is sent', async () => {
		const { onSubmit } = renderEditor({ model: null, edit: false });
		const name = await screen.findByLabelText('Model name');
		fireEvent.change(name, { target: { value: 'x' } });
		fireEvent.change(name, { target: { value: '' } });
		save('Create model');
		expect(name).toHaveAttribute('aria-invalid', 'true');
		expect(name).toHaveAccessibleDescription('Enter a name for this model.');
		expect(document.activeElement).toBe(name);
		const base = screen.getByRole('button', { name: /^Base model/ });
		expect(base).toHaveAttribute('aria-invalid', 'true');
		expect(base).toHaveAccessibleDescription('Choose the model this one is built on.');
		expect(onSubmit).not.toHaveBeenCalled();
		expect(toast.error).not.toHaveBeenCalled();
	});

	it('focuses the base model when it is the only thing missing, and clears the error once one is chosen', async () => {
		renderEditor({ model: null, edit: false });
		fireEvent.change(await screen.findByLabelText('Model name'), { target: { value: 'Tutor' } });
		save('Create model');
		const base = screen.getByRole('button', { name: /^Base model/ });
		expect(document.activeElement).toBe(base);
		fireEvent.click(base);
		fireEvent.click(await screen.findByRole('option', { name: 'Base' }));
		expect(screen.getByRole('button', { name: 'Base model Base' })).not.toHaveAttribute('aria-invalid');
	});

	it('judges a field when it is left, and refuses an ID another model uses, under the ID field', async () => {
		renderEditor({ model: null, edit: false });
		const name = await screen.findByLabelText('Model name');
		fireEvent.blur(name);
		expect(name).toHaveAccessibleDescription('Enter a name for this model.');
		fireEvent.change(name, { target: { value: 'Taken' } });
		expect(name).not.toHaveAttribute('aria-invalid');
		const id = screen.getByLabelText('Model ID');
		expect(id).toHaveValue('taken');
		fireEvent.blur(id);
		expect(id).toHaveAccessibleDescription('Another model already uses the ID “taken”. Choose a different ID.');
		fireEvent.change(id, { target: { value: '' } });
		fireEvent.blur(id);
		expect(id).toHaveAccessibleDescription('Enter an ID: it names the model in the API.');
		fireEvent.change(id, { target: { value: 'fresh' } });
		expect(id).toHaveAccessibleDescription("Names the model in the API. It can't be changed later.");
	});

	it('says uploads still running stop a save, at the knowledge list', async () => {
		renderEditor({
			model: { ...existing, meta: { knowledge: [{ id: 'f', name: 'big.pdf', type: 'file', status: 'uploading' }] } }
		});
		fireEvent.change(await screen.findByLabelText('Model name'), { target: { value: 'Renamed' } });
		await act(async () => save('Save changes'));
		expect(screen.getByRole('alert')).toHaveTextContent('Wait for the files to finish uploading, then save.');
	});
});

describe('ModelEditor attachments and capabilities', () => {
	it('says where to make tools and skills when there are none (#956)', async () => {
		renderEditor();
		expect(await screen.findByRole('link', { name: 'Create one in Tools' })).toHaveAttribute(
			'href',
			'/workspace/tools'
		);
		expect(screen.getByRole('link', { name: 'Create one in Skills' })).toHaveAttribute('href', '/workspace/skills');
	});

	it('offers filters, filters on by default and actions when there are some, and saves what is picked', async () => {
		vi.mocked(getFunctions).mockResolvedValue([
			{ id: 'f1', name: 'Redact', type: 'filter', meta: { toggle: true } },
			{ id: 'a1', name: 'Explain', type: 'action' }
		] as never);
		const { onSubmit } = renderEditor({ model: { ...existing, meta: { ...existing.meta, filterIds: ['f1'] } } });
		fireEvent.click(await screen.findByRole('button', { name: 'Choose filters on by default' }));
		fireEvent.click(await screen.findByRole('option', { name: 'Redact' }));
		fireEvent.click(screen.getByRole('button', { name: 'Choose actions' }));
		fireEvent.click(await screen.findByRole('option', { name: 'Explain' }));
		fireEvent.click(screen.getByRole('button', { name: 'Choose filters' }));
		fireEvent.click(await screen.findByRole('option', { name: /Redact/ }));
		save('Save changes');
		await waitFor(() => expect(onSubmit).toHaveBeenCalled());
		expect(vi.mocked(onSubmit).mock.calls[0][0].meta).toMatchObject({ defaultFilterIds: ['f1'], actionIds: ['a1'] });
		expect(vi.mocked(onSubmit).mock.calls[0][0].meta).not.toHaveProperty('filterIds');
	});

	it('chooses a terminal server once the terminal capability is on', async () => {
		vi.mocked(getTerminalServers).mockResolvedValue([{ id: 't1', name: 'Lab box' }] as never);
		const { onSubmit } = renderEditor({
			model: { ...existing, meta: { capabilities: { terminal: true }, terminalId: 't1' } }
		});
		expect(await screen.findByRole('combobox', { name: 'Terminal server' })).toHaveTextContent('Lab box');
		fireEvent.change(screen.getByLabelText(/Description/), { target: { value: 'x' } });
		save('Save changes');
		await waitFor(() => expect(onSubmit).toHaveBeenCalled());
		expect(vi.mocked(onSubmit).mock.calls[0][0].meta.terminalId).toBe('t1');
	});

	it('turns a builtin tool off and a default feature on, and stores a voice', async () => {
		const { onSubmit } = renderEditor();
		fireEvent.click(await screen.findByRole('button', { name: 'Builtin tools, voice and parameters' }));
		const notes = within(screen.getByRole('group', { name: 'Builtin tools' })).getByRole('checkbox', { name: 'Notes' });
		expect(notes).toBeChecked();
		fireEvent.click(notes);
		fireEvent.change(screen.getByLabelText(/Voice for reading aloud/), { target: { value: 'nova' } });
		const defaults = screen.getByRole('group', { name: 'On by default in a new chat' });
		fireEvent.click(within(defaults).getAllByRole('checkbox')[0]);
		save('Save changes');
		await waitFor(() => expect(onSubmit).toHaveBeenCalled());
		const meta = vi.mocked(onSubmit).mock.calls[0][0].meta;
		expect(meta.builtinTools).toEqual({ notes: false });
		expect(meta.tts).toEqual({ voice: 'nova' });
		expect(meta.defaultFeatureIds).toHaveLength(1);
	});

	it('says builtin tools are off when the capability is, and lists the variables a prompt asks for', async () => {
		renderEditor({ model: { ...existing, meta: { capabilities: { builtin_tools: false } } } });
		fireEvent.click(await screen.findByRole('button', { name: 'Builtin tools, voice and parameters' }));
		expect(screen.getByText(/Builtin tools are off for this model/)).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText(/System prompt/), {
			target: { value: 'Hi {{chat.variables.Topic | text}} from {{user.variables.city}}' }
		});
		expect(screen.getByText('Detected variables')).toBeInTheDocument();
		expect(screen.getByText('Topic must be lowercase snake case')).toBeInTheDocument();
		expect(screen.getByText('city')).toBeInTheDocument();
	});
});
