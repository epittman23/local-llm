import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsDialogHost } from '@/components/settings/controls';
import { getConfig, updateConfig } from '@/lib/apis/evaluations';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useSettingsModalStore } from '@/lib/stores/settingsModalStore';
import Evaluations from './Evaluations';
import type { ArenaModel } from './arenaModels';

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), toast) }));
vi.mock('@/lib/apis/evaluations', () => ({ getConfig: vi.fn(), updateConfig: vi.fn() }));
// The arena model dialog has its own tests: here it only hands back a model, or asks to delete one.
vi.mock('./ArenaModelModal', () => ({
	ArenaModelModal: ({
		open,
		edit,
		model,
		onSubmit,
		onDelete
	}: {
		open: boolean;
		edit?: boolean;
		model?: ArenaModel;
		onSubmit: (m: ArenaModel) => void;
		onDelete?: () => void;
	}) =>
		open ? (
			<div role="dialog" aria-label={edit ? `Edit ${model?.name}` : 'Add arena model'}>
				<button
					type="button"
					onClick={() => onSubmit({ id: edit ? (model?.id ?? '') : 'new', name: 'Fresh', meta: META })}
				>
					Submit
				</button>
				{edit && (
					<button type="button" onClick={onDelete}>
						Remove
					</button>
				)}
			</div>
		) : null
}));

const META: ArenaModel['meta'] = {
	profile_image_url: '',
	description: null,
	model_ids: null,
	filter_mode: null,
	access_grants: []
};
const DUEL: ArenaModel = { id: 'duel', name: 'Duel', meta: { ...META, description: 'Two at random' } };
const CONFIG = { ENABLE_EVALUATION_ARENA_MODELS: true, EVALUATION_ARENA_MODELS: [DUEL] };

const setRating = (on: boolean) =>
	useConfigStore.setState({ config: { features: { enable_message_rating: on } } } as never);

beforeEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({ token: 'tok' } as never);
	setRating(true);
	vi.mocked(getConfig).mockResolvedValue(structuredClone(CONFIG) as never);
	vi.mocked(updateConfig).mockImplementation(async (_t, body) => body as never);
});

const renderTab = async (wrap: (c: ReactNode) => ReactNode = (c) => c) => {
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<MemoryRouter>{wrap(<Evaluations />)}</MemoryRouter>
		</QueryClientProvider>
	);
	await screen.findByRole('switch', { name: /^Arena models/ });
};

describe('Evaluations: what Arena models need (#1020)', () => {
	it('says nothing about Message rating while it is on', async () => {
		await renderTab();
		expect(screen.getByText(/answers with a model chosen at random/)).toBeInTheDocument();
		expect(screen.queryByText(/need Message rating/)).toBeNull();
	});

	it('on a page, links to the Message rating switch while it is off', async () => {
		setRating(false);
		await renderTab();
		expect(screen.getByText('Arena models need Message rating, which is off.')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Turn on Message rating in General' })).toHaveAttribute(
			'href',
			'/admin/settings/general'
		);
	});

	it('in the dialog, asks the dialog to open General at the switch', async () => {
		setRating(false);
		const requestTab = vi.fn();
		useSettingsModalStore.setState({ requestTab } as never);
		await renderTab((c) => <SettingsDialogHost>{c}</SettingsDialogHost>);
		fireEvent.click(screen.getByRole('button', { name: 'Turn on Message rating in General' }));
		expect(requestTab).toHaveBeenCalledWith('admin:general', 'message-rating');
	});
});

describe('Evaluations: arena model edits join the Save (FRM-3)', () => {
	it('adds, edits and deletes in the draft, and sends the list only on Save', async () => {
		await renderTab();
		const save = screen.getByRole('button', { name: 'Save' });
		expect(save).toBeDisabled();

		fireEvent.click(screen.getByRole('button', { name: 'Add arena model' }));
		fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
		expect(screen.getByText('Fresh')).toBeInTheDocument();
		expect(updateConfig).not.toHaveBeenCalled();
		expect(save).toBeEnabled();

		fireEvent.click(screen.getByRole('button', { name: 'Edit Duel' }));
		fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
		expect(screen.queryByText('Duel')).toBeNull();

		fireEvent.click(save);
		await waitFor(() => expect(updateConfig).toHaveBeenCalledTimes(1));
		expect(vi.mocked(updateConfig).mock.calls[0][1]).toEqual({
			ENABLE_EVALUATION_ARENA_MODELS: true,
			EVALUATION_ARENA_MODELS: [{ id: 'new', name: 'Fresh', meta: META }]
		});
		await waitFor(() => expect(toast.success).toHaveBeenCalled());
		expect(save).toBeDisabled();
	});

	it('an edit replaces the model in place; with none left it says what the Arena model does', async () => {
		await renderTab();
		fireEvent.click(screen.getByRole('button', { name: 'Edit Duel' }));
		fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
		expect(screen.getByText('Fresh')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Edit Fresh' }));
		fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
		expect(screen.getByText('None yet, so the Arena model chooses among all your models.')).toBeInTheDocument();
	});

	it('a failed save says why and keeps the edits', async () => {
		vi.mocked(updateConfig).mockRejectedValue('Server said no');
		await renderTab();
		fireEvent.click(screen.getByRole('switch', { name: /^Arena models/ }));
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Server said no'));
		expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
	});
});
