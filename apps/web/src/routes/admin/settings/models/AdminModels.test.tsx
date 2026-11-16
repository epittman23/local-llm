import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import saveAs from 'file-saver';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toastFailure } from '@/components/common/failureToast';
import { SettingsDialogHost } from '@/components/settings/controls';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getModels } from '@/lib/apis';
import { getModelsConfig, setModelsConfig } from '@/lib/apis/configs';
import {
	createNewModel,
	deleteAllModels,
	getBaseModels,
	getModelById,
	toggleModelById,
	updateModelAccessGrants,
	updateModelById
} from '@/lib/apis/models';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useSettingsModalStore } from '@/lib/stores/settingsModalStore';
import { copyToClipboard } from '@/lib/utils';
import { importModelFile } from '@/routes/workspace/models/modelImport';
import { useSingleUser } from '@/routes/workspace/workspaceAccess';
import AdminModels from './AdminModels';
import type { DefaultsState } from './adminModels';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn() }) }));
vi.mock('@/components/common/failureToast', () => ({ toastFailure: vi.fn() }));
vi.mock('file-saver', () => ({ default: vi.fn() }));
vi.mock('@/lib/utils', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/utils')>()),
	copyToClipboard: vi.fn(async () => true)
}));
vi.mock('@/lib/apis', () => ({ getModels: vi.fn(), getBackendConfig: vi.fn(async () => null) }));
vi.mock('@/lib/apis/configs', () => ({
	getModelsConfig: vi.fn(),
	setModelsConfig: vi.fn(),
	setDefaultPromptSuggestions: vi.fn()
}));
vi.mock('@/lib/apis/models', () => ({
	createNewModel: vi.fn(),
	deleteAllModels: vi.fn(),
	getBaseModels: vi.fn(),
	getBaseModelTags: vi.fn(async () => []),
	getModelById: vi.fn(),
	toggleModelById: vi.fn(),
	updateModelAccessGrants: vi.fn(),
	updateModelById: vi.fn()
}));
vi.mock('@/lib/settings/userSettings', () => ({
	useUserSettings: () => ({ pinnedModels: [], togglePinned: vi.fn() })
}));
vi.mock('@/routes/workspace/workspaceAccess', () => ({ useSingleUser: vi.fn(() => false) }));
vi.mock('@/routes/workspace/models/modelImport', () => ({ importModelFile: vi.fn() }));
vi.mock('./ManageModelsModal', () => ({ ManageModelsModal: () => null }));
// The panel has its own tests; here it is one button that changes the defaults.
vi.mock('./ModelDefaultsPanel', () => ({
	ModelDefaultsPanel: ({ value, onChange }: { value: DefaultsState; onChange: (d: DefaultsState) => void }) => (
		<button type="button" onClick={() => onChange({ ...value, defaultFeatureIds: ['web_search'] })}>
			Change defaults
		</button>
	)
}));
// The editor has its own tests; here it reports dirty and goes back.
vi.mock('@/routes/workspace/models/ModelEditor', () => ({
	ModelEditor: ({
		model,
		onDirtyChange,
		onBack,
		onSubmit
	}: {
		model: { id: string; name: string } | null;
		onDirtyChange: (d: boolean) => void;
		onBack: () => void;
		onSubmit: (info: unknown) => Promise<void>;
	}) => (
		<div>
			<p>Editing {model?.name}</p>
			<button
				type="button"
				onClick={() => void onSubmit({ ...model, name: 'Renamed' }).catch((e: Error) => toastFailure(e.message))}
			>
				Editor save
			</button>
			<button type="button" onClick={() => onDirtyChange(true)}>
				Edit something
			</button>
			<button type="button" onClick={onBack}>
				Editor back
			</button>
		</div>
	)
}));

const SERVED = [
	{ id: 'alpha', name: 'Alpha' },
	{ id: 'beta', name: 'Beta' },
	{ id: 'stats', name: 'Stats helper', base_model_id: 'alpha', preset: true }
];
const RECORDS = [{ id: 'stats', name: 'Stats helper', base_model_id: 'alpha', is_active: true, meta: {} }];
const CONFIG = {
	DEFAULT_MODELS: 'alpha',
	DEFAULT_PINNED_MODELS: '',
	MODEL_ORDER_LIST: ['alpha', 'beta', 'stats'],
	DEFAULT_MODEL_METADATA: null,
	DEFAULT_MODEL_PARAMS: null
};

function renderTab() {
	const router = createMemoryRouter(
		[
			{
				path: '/',
				element: (
					<SettingsDialogHost>
						<AdminModels />
					</SettingsDialogHost>
				)
			},
			{ path: '*', element: <p>Elsewhere</p> }
		],
		{ initialEntries: ['/'] }
	);
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</QueryClientProvider>
	);
	return router;
}

const openMenu = async (name: string) => {
	fireEvent.keyDown(screen.getByRole('button', { name: `More actions for ${name}` }), { key: 'Enter' });
	return screen.findByRole('menu');
};
const pick = async (row: string, item: string) => fireEvent.click(within(await openMenu(row)).getByText(item));

beforeEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({ token: 'tok' } as never);
	useConfigStore.setState({ config: { default_prompt_suggestions: [] } } as never);
	useSettingsModalStore.setState({ dirty: false } as never);
	vi.mocked(useSingleUser).mockReturnValue(false);
	vi.mocked(getModelsConfig).mockResolvedValue(CONFIG as never);
	vi.mocked(getBaseModels).mockResolvedValue(RECORDS as never);
	vi.mocked(getModels).mockImplementation((async (_token: string, _c?: unknown, provider?: boolean) =>
		provider ? [] : SERVED) as never);
	vi.mocked(getModelById).mockImplementation(
		(async (_t: string, id: string) => RECORDS.find((r) => r.id === id) ?? null) as never
	);
	vi.mocked(setModelsConfig).mockImplementation((async (_t: string, body: unknown) => body) as never);
});

describe('AdminModels', () => {
	it('lists the models in two headed groups (S5-D9)', async () => {
		renderTab();
		const connections = await screen.findByRole('region', { name: /From connections/ });
		const workspace = screen.getByRole('region', { name: /Workspace models/ });
		expect(within(connections).getByText('Alpha')).toBeTruthy();
		expect(within(connections).getByText('Beta')).toBeTruthy();
		expect(within(connections).queryByText('Stats helper')).toBeNull();
		expect(within(workspace).getByText('Stats helper')).toBeTruthy();
		expect(within(connections).getByText('Default')).toBeTruthy();
	});

	it('says how many of the whole a search shows, and offers Clear search when nothing matches', async () => {
		renderTab();
		const search = await screen.findByPlaceholderText('Search models');
		fireEvent.change(search, { target: { value: 'alp' } });
		expect(screen.getByText('1 of 3 models')).toBeTruthy();
		fireEvent.change(search, { target: { value: 'zzz' } });
		expect(screen.getByText('Nothing matches “zzz”')).toBeTruthy();
		fireEvent.click(within(screen.getByTestId('model-list')).getByRole('button', { name: 'Clear search' }));
		expect(await screen.findByText('Alpha')).toBeTruthy();
	});

	it('moves a row within its group, then saves the order from the SaveBar', async () => {
		renderTab();
		await screen.findByText('Alpha');
		await pick('Alpha', 'Move down');
		expect(await screen.findByText('Unsaved changes')).toBeTruthy();
		expect(useSettingsModalStore.getState().dirty).toBe(true);
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(setModelsConfig).toHaveBeenCalledTimes(1));
		expect(vi.mocked(setModelsConfig).mock.calls[0][1]).toMatchObject({
			MODEL_ORDER_LIST: ['beta', 'alpha', 'stats'],
			DEFAULT_MODELS: 'alpha'
		});
		await waitFor(() => expect(screen.getByText('All changes saved')).toBeTruthy());
		expect(toast.success).toHaveBeenCalledWith('Model settings saved');
	});

	it('puts the saved order and defaults back on Discard changes', async () => {
		renderTab();
		await screen.findByText('Alpha');
		await pick('Alpha', 'Move down');
		fireEvent.click(screen.getByRole('button', { name: 'Change defaults' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Discard changes' }));
		expect(await screen.findByText('All changes saved')).toBeTruthy();
		const names = within(screen.getByRole('region', { name: /From connections/ }))
			.getAllByRole('button', { name: /^Edit / })
			.map((b) => b.getAttribute('aria-label'));
		expect(names).toEqual(['Edit Alpha', 'Edit Beta']);
		expect(setModelsConfig).not.toHaveBeenCalled();
	});

	it('saves changed Model Defaults with the order', async () => {
		renderTab();
		fireEvent.click(await screen.findByRole('button', { name: 'Change defaults' }));
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(setModelsConfig).toHaveBeenCalledTimes(1));
		expect(vi.mocked(setModelsConfig).mock.calls[0][1]).toMatchObject({
			DEFAULT_MODEL_METADATA: expect.objectContaining({ defaultFeatureIds: ['web_search'] })
		});
	});

	it('says a failed save through toastFailure and stays dirty', async () => {
		vi.mocked(setModelsConfig).mockRejectedValueOnce(new Error('boom'));
		renderTab();
		await screen.findByText('Alpha');
		await pick('Alpha', 'Move down');
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() =>
			expect(toastFailure).toHaveBeenCalledWith("Couldn't save the model settings.", expect.any(Error))
		);
		expect(screen.getByText('Unsaved changes')).toBeTruthy();
	});

	it('asks "Reset all models?", counting the workspace models, destructive', async () => {
		vi.mocked(deleteAllModels).mockResolvedValue(true as never);
		renderTab();
		await screen.findByText('Alpha');
		fireEvent.keyDown(screen.getByRole('button', { name: 'Actions' }), { key: 'Enter' });
		const menu = await screen.findByRole('menu');
		const items = within(menu).getAllByRole('menuitem');
		expect(items.at(-1)?.textContent).toBe('Reset models');
		fireEvent.click(items.at(-1) as HTMLElement);
		const ask = await screen.findByRole('alertdialog', { name: 'Reset all models?' });
		expect(ask.textContent).toContain('All 1 workspace model and every model setting are deleted');
		fireEvent.click(within(ask).getByRole('button', { name: 'Reset models' }));
		await waitFor(() => expect(deleteAllModels).toHaveBeenCalledWith('tok'));
		expect(toast.success).toHaveBeenCalledWith('Models reset');
	});

	it('hides a model and says so by name', async () => {
		vi.mocked(updateModelById).mockResolvedValue({} as never);
		renderTab();
		await screen.findByText('Stats helper');
		await pick('Stats helper', 'Hide model');
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('“Stats helper” is hidden'));
		expect(vi.mocked(updateModelById).mock.calls[0][2]).toMatchObject({ meta: { hidden: true } });
		expect(await screen.findByText('Hidden')).toBeTruthy();
	});

	it('shows a first load that fails in place, and Try again loads it', async () => {
		vi.mocked(getModelsConfig).mockRejectedValueOnce(new Error('down'));
		renderTab();
		expect(await screen.findByText("Couldn't load models")).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByText('Alpha')).toBeTruthy();
	});

	it('tells the host about the list and the editor while a model is open, and keeps an unsaved reorder', async () => {
		renderTab();
		await screen.findByText('Alpha');
		fireEvent.click(screen.getByRole('button', { name: 'Edit Beta' }));
		expect(await screen.findByText('Editing Beta')).toBeTruthy();
		expect(useSettingsModalStore.getState().dirty).toBe(false);
		fireEvent.click(screen.getByRole('button', { name: 'Edit something' }));
		await waitFor(() => expect(useSettingsModalStore.getState().dirty).toBe(true));
		fireEvent.click(screen.getByRole('button', { name: 'Editor back' }));
		expect(await screen.findByText('Alpha')).toBeTruthy();
		await waitFor(() => expect(useSettingsModalStore.getState().dirty).toBe(false));

		await pick('Alpha', 'Move down');
		fireEvent.click(screen.getByRole('button', { name: 'Edit Alpha' }));
		await screen.findByText('Editing Alpha');
		await waitFor(() => expect(useSettingsModalStore.getState().dirty).toBe(true));
		fireEvent.click(screen.getByRole('button', { name: 'Editor back' }));
		await screen.findByText('Unsaved changes');
		const names = within(screen.getByRole('region', { name: /From connections/ }))
			.getAllByRole('button', { name: /^Edit / })
			.map((b) => b.getAttribute('aria-label'));
		expect(names).toEqual(['Edit Beta', 'Edit Alpha']);
	});

	it('opens a workspace model in Workspace, asking first while the order is unsaved', async () => {
		const router = renderTab();
		await screen.findByText('Alpha');
		await pick('Alpha', 'Move down');
		fireEvent.click(screen.getByRole('button', { name: 'Edit Stats helper' }));
		const ask = await screen.findByRole('alertdialog', { name: 'Discard changes?' });
		expect(ask.textContent).toContain('The model order and defaults are not saved.');
		fireEvent.click(within(ask).getByRole('button', { name: 'Discard changes' }));
		await waitFor(() => expect(router.state.location.pathname).toBe('/workspace/models/edit'));
		expect(router.state.location.search).toBe('?id=stats');
	});

	it('leaves out the access and Pinned by default views with one account (S4-D1, S5-D12)', async () => {
		vi.mocked(useSingleUser).mockReturnValue(true);
		renderTab();
		await screen.findByText('Alpha');
		fireEvent.keyDown(screen.getByRole('button', { name: 'Show: All' }), { key: 'Enter' });
		const menu = await screen.findByRole('menu');
		expect(within(menu).queryByText('Public')).toBeNull();
		expect(within(menu).queryByText('Pinned by default')).toBeNull();
		expect(within(menu).getByText('Default for new chats')).toBeTruthy();
		fireEvent.keyDown(menu, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
		expect(within(await openMenu('Alpha')).queryByText('Pin by default')).toBeNull();
	});

	it('keeps Pin by default with one account while sign-ups are on (S5-D2)', async () => {
		vi.mocked(useSingleUser).mockReturnValue(true);
		useConfigStore.setState({ config: { default_prompt_suggestions: [], features: { enable_signup: true } } } as never);
		renderTab();
		await screen.findByText('Alpha');
		const menu = await openMenu('Alpha');
		expect(within(menu).getByText('Pin by default')).toBeTruthy();
		expect(within(menu).queryByText('Make public')).toBeNull();
	});

	it('turns a model with no record on or off by creating one, and one with a record by toggling it', async () => {
		vi.mocked(createNewModel).mockResolvedValue({} as never);
		vi.mocked(toggleModelById).mockResolvedValue({} as never);
		renderTab();
		await screen.findByText('Alpha');
		fireEvent.click(screen.getByRole('switch', { name: 'Enable Alpha' }));
		await waitFor(() => expect(createNewModel).toHaveBeenCalledTimes(1));
		expect(vi.mocked(createNewModel).mock.calls[0][1]).toMatchObject({ id: 'alpha', is_active: false });
		fireEvent.click(screen.getByRole('switch', { name: 'Enable Stats helper' }));
		await waitFor(() => expect(toggleModelById).toHaveBeenCalledWith('tok', 'stats'));
	});

	it('puts the switch back and says so when turning a model off fails', async () => {
		vi.mocked(toggleModelById).mockRejectedValue(new Error('no'));
		renderTab();
		await screen.findByText('Alpha');
		const sw = screen.getByRole('switch', { name: 'Enable Stats helper' });
		fireEvent.click(sw);
		await waitFor(() =>
			expect(toastFailure).toHaveBeenCalledWith("Couldn't turn off “Stats helper”.", expect.any(Error))
		);
		expect(sw.getAttribute('data-state')).toBe('checked');
	});

	it('says a failed hide by name', async () => {
		vi.mocked(updateModelById).mockRejectedValue(new Error('no'));
		renderTab();
		await screen.findByText('Stats helper');
		await pick('Stats helper', 'Hide model');
		await waitFor(() => expect(toastFailure).toHaveBeenCalledWith("Couldn't hide “Stats helper”."));
	});

	it('makes a model public, and says why when that fails', async () => {
		vi.mocked(updateModelAccessGrants).mockImplementation((async (
			_t: string,
			_id: string,
			_n: string,
			grants: unknown[]
		) => ({ access_grants: grants })) as never);
		renderTab();
		await screen.findByText('Beta');
		await pick('Beta', 'Make public');
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Model is now public'));
		expect(await screen.findByText('Public')).toBeTruthy();
		vi.mocked(updateModelAccessGrants).mockRejectedValueOnce(new Error('no'));
		await pick('Alpha', 'Make public');
		await waitFor(() =>
			expect(toastFailure).toHaveBeenCalledWith("Couldn't change who can use “Alpha”.", expect.any(Error))
		);
	});

	it('saves the default and pinned selections at once, and undoes one the server refused', async () => {
		renderTab();
		await screen.findByText('Beta');
		await pick('Beta', 'Default for new chats');
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('“Beta” is a default for new chats'));
		expect(vi.mocked(setModelsConfig).mock.calls[0][1]).toMatchObject({ DEFAULT_MODELS: 'alpha,beta' });
		await pick('Alpha', 'Default for new chats');
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('“Alpha” is no longer a default for new chats'));
		await pick('Beta', 'Pin by default');
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('“Beta” is pinned by default'));
		await pick('Beta', 'Pin by default');
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('“Beta” is no longer pinned by default'));
		vi.mocked(setModelsConfig).mockResolvedValueOnce(null as never);
		await pick('Alpha', 'Pin by default');
		await waitFor(() => expect(toastFailure).toHaveBeenCalledWith("Couldn't save the change.", expect.any(Error)));
		await openMenu('Alpha');
		const pin = screen.getByRole('menuitemcheckbox', { name: /Pin by default/ });
		expect(pin.getAttribute('aria-checked')).toBe('false');
	});

	it('runs the bulk actions with one toast each, counting failures', async () => {
		vi.mocked(updateModelById).mockResolvedValue({} as never);
		vi.mocked(createNewModel).mockResolvedValue({} as never);
		renderTab();
		await screen.findByText('Alpha');
		const actions = async (item: string) => {
			fireEvent.keyDown(screen.getByRole('button', { name: 'Actions' }), { key: 'Enter' });
			fireEvent.click(within(await screen.findByRole('menu')).getByText(item));
		};
		await actions('Turn all off');
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('All models turned off'));
		await actions('Turn all on');
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('All models turned on'));
		await actions('Show all');
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('All models shown'));
		vi.mocked(updateModelById).mockRejectedValueOnce(new Error('no'));
		await actions('Hide all');
		await waitFor(() =>
			expect(toastFailure).toHaveBeenCalledWith(expect.stringMatching(/^1 of \d+ models couldn't be changed/))
		);
	});

	it('copies a link, exports a model and the list, and clones into Workspace', async () => {
		const router = renderTab();
		await screen.findByText('Alpha');
		await pick('Alpha', 'Copy link');
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Link copied'));
		expect(vi.mocked(copyToClipboard).mock.calls[0][0]).toMatch(/\/\?model=alpha$/);
		vi.mocked(copyToClipboard).mockResolvedValueOnce(false);
		await pick('Alpha', 'Copy link');
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't copy the link. Your browser refused it."));
		await pick('Alpha', 'Export');
		await waitFor(() => expect(saveAs).toHaveBeenCalledTimes(1));
		fireEvent.keyDown(screen.getByRole('button', { name: 'Actions' }), { key: 'Enter' });
		fireEvent.click(within(await screen.findByRole('menu')).getByText('Export models'));
		await waitFor(() => expect(saveAs).toHaveBeenCalledTimes(2));
		expect(vi.mocked(saveAs).mock.calls[1][1]).toMatch(/^models-export-\d+\.json$/);
		await pick('Alpha', 'Clone');
		await waitFor(() => expect(router.state.location.pathname).toBe('/workspace/models/create'));
		expect(JSON.parse(sessionStorage.model)).toMatchObject({ id: 'alpha-clone', name: 'Alpha (Clone)' });
	});

	it('imports a models file and says what it took, or why it could not', async () => {
		vi.mocked(importModelFile).mockResolvedValue({ imported: ['a', 'b'], skipped: [] } as never);
		renderTab();
		await screen.findByText('Alpha');
		const input = screen.getByLabelText('Import models file') as HTMLInputElement;
		const file = (text: string) => new File([text], 'models.json', { type: 'application/json' });
		fireEvent.change(input, { target: { files: [file('[]')] } });
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Imported 2 models'));
		vi.mocked(importModelFile).mockRejectedValueOnce(new SyntaxError('bad'));
		fireEvent.change(input, { target: { files: [file('{')] } });
		await waitFor(() =>
			expect(toastFailure).toHaveBeenCalledWith("Couldn't import “models.json”. It isn't a JSON file.")
		);
		vi.mocked(importModelFile).mockResolvedValueOnce(null as never);
		fireEvent.change(input, { target: { files: [file('[]')] } });
		await waitFor(() =>
			expect(toastFailure).toHaveBeenCalledWith("Couldn't import the models. The server took none of them.")
		);
	});

	it('reorders by drag within a group, and not across groups', async () => {
		renderTab();
		await screen.findByText('Alpha');
		const grip = (name: string) => screen.getByRole('img', { name: `Drag ${name} to reorder` });
		const row = (id: string) => document.querySelector(`[data-model-row="${id}"]`) as HTMLElement;
		const dataTransfer = { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: '' };
		fireEvent.dragStart(grip('Alpha'), { dataTransfer });
		fireEvent.dragOver(row('stats'), { dataTransfer });
		fireEvent.drop(row('stats'), { dataTransfer });
		expect(screen.queryByText('Unsaved changes')).toBeNull();
		fireEvent.dragStart(grip('Alpha'), { dataTransfer });
		fireEvent.dragOver(row('beta'), { dataTransfer });
		fireEvent.drop(row('beta'), { dataTransfer });
		fireEvent.dragEnd(grip('Alpha'));
		expect(await screen.findByText('Unsaved changes')).toBeTruthy();
		const names = within(screen.getByRole('region', { name: /From connections/ }))
			.getAllByRole('button', { name: /^Edit / })
			.map((b) => b.getAttribute('aria-label'));
		expect(names).toEqual(['Edit Beta', 'Edit Alpha']);
	});

	it('opens the model a link names, and saves from the editor with a toast', async () => {
		vi.mocked(createNewModel).mockResolvedValue({} as never);
		useSettingsModalStore.setState({ tabState: { id: 'beta' } } as never);
		renderTab();
		expect(await screen.findByText('Editing Beta')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Editor save' }));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('“Renamed” saved'));
		// A record exists after the first save, so the second one is an update.
		vi.mocked(updateModelById).mockRejectedValueOnce(new Error('no'));
		fireEvent.click(screen.getByRole('button', { name: 'Editor save' }));
		await waitFor(() => expect(toastFailure).toHaveBeenCalledWith("Couldn't save “Renamed”. Try again."));
	});

	it('keeps the list when a refresh fails, and says so', async () => {
		vi.mocked(createNewModel).mockResolvedValue({} as never);
		vi.mocked(toggleModelById).mockResolvedValue({} as never);
		renderTab();
		await screen.findByText('Alpha');
		vi.mocked(getModelsConfig).mockRejectedValueOnce(new Error('down'));
		fireEvent.click(screen.getByRole('switch', { name: 'Enable Alpha' }));
		await waitFor(() =>
			expect(toastFailure).toHaveBeenCalledWith("Couldn't refresh the model list.", expect.any(Error))
		);
		expect(screen.getByText('Alpha')).toBeTruthy();
	});
});
