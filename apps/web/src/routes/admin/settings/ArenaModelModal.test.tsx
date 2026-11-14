import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getModels } from '@/lib/apis';
import { useAuthStore } from '@/lib/stores/authStore';
import { ArenaModelModal } from './ArenaModelModal';
import type { ArenaModel } from './arenaModels';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('@/lib/apis', () => ({ getModels: vi.fn() }));
vi.mock('@/components/common/AccessControl', () => ({ AccessControl: () => <div>access control</div> }));

const EXISTING: ArenaModel = {
	id: 'duel',
	name: 'Duel',
	meta: {
		profile_image_url: '/x.png',
		description: null,
		model_ids: ['m1'],
		filter_mode: 'include',
		access_grants: []
	}
};

beforeEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({ token: 'tok' } as never);
	vi.mocked(getModels).mockResolvedValue([
		{ id: 'm1', name: 'Model One' },
		{ id: 'm2', name: 'Model Two' }
	] as never);
});

const renderModal = (props: Partial<Parameters<typeof ArenaModelModal>[0]> = {}) => {
	const onSubmit = vi.fn();
	const onDelete = vi.fn();
	const onOpenChange = vi.fn();
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<ArenaModelModal open onOpenChange={onOpenChange} onSubmit={onSubmit} onDelete={onDelete} {...props} />
		</QueryClientProvider>
	);
	return { onSubmit, onDelete, onOpenChange };
};

describe('ArenaModelModal', () => {
	it('derives the id from the name while adding', () => {
		renderModal();
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My Arena!' } });
		expect((screen.getByLabelText('ID') as HTMLInputElement).value).toBe('my-arena');
	});

	it('toggles between Include and Exclude', () => {
		renderModal({ edit: true, model: EXISTING });
		fireEvent.click(screen.getByRole('button', { name: 'Include' }));
		expect(screen.getByRole('button', { name: 'Exclude' })).toBeTruthy();
	});

	it('adds a picked model to the list and removes it again', async () => {
		renderModal();
		const select = screen.getByLabelText('Select a model');
		await screen.findByRole('option', { name: 'Model Two' });
		fireEvent.change(select, { target: { value: 'm2' } });
		fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
		expect(screen.getByRole('button', { name: 'Remove m2' })).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Remove m2' }));
		expect(screen.queryByRole('button', { name: 'Remove m2' })).toBeNull();
	});

	it('submits the new arena model with its listed models and mode', async () => {
		const { onSubmit } = renderModal();
		await screen.findByRole('option', { name: 'Model Two' });
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Rumble' } });
		fireEvent.change(screen.getByLabelText('Select a model'), { target: { value: 'm2' } });
		fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
		fireEvent.click(screen.getByRole('button', { name: 'Include' }));
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		expect(onSubmit.mock.calls[0][0]).toMatchObject({
			id: 'rumble',
			name: 'Rumble',
			meta: { model_ids: ['m2'], filter_mode: 'exclude' }
		});
	});

	it('shows Delete only when editing, and confirms before deleting', async () => {
		const { onDelete } = renderModal({ edit: true, model: EXISTING });
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		expect(await screen.findByText('Delete arena model?')).toBeTruthy();
		expect(onDelete).not.toHaveBeenCalled();
		const confirm = screen.getAllByRole('button', { name: 'Delete' }).at(-1) as HTMLElement;
		fireEvent.click(confirm);
		await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
	});

	it('has no Delete button while adding', () => {
		renderModal();
		expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
	});
});
