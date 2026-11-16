import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getModels } from '@/lib/apis';
import { useAuthStore } from '@/lib/stores/authStore';
import { ArenaModelModal } from './ArenaModelModal';
import type { ArenaModel } from './arenaModels';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('@/lib/apis', () => ({ getModels: vi.fn() }));
vi.mock('@/components/common/AccessControl', () => ({ AccessControl: () => <div>access control</div> }));
const visibility = vi.hoisted(() => ({ single: false }));
vi.mock('../adminVisibility', () => ({ useAdminSingleUser: () => visibility.single }));

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
	visibility.single = false;
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

	it('chooses only these models or all but these, saying which (FRM-4)', () => {
		renderModal({ edit: true, model: EXISTING });
		const group = screen.getByRole('radiogroup', { name: 'Models' });
		expect(screen.getByRole('radio', { name: 'Only these' })).toBeChecked();
		expect(group).toHaveAccessibleDescription('The arena picks among these models only.');
		fireEvent.click(screen.getByRole('radio', { name: 'All but these' }));
		expect(screen.getByRole('radio', { name: 'All but these' })).toBeChecked();
		expect(group).toHaveAccessibleDescription('The arena picks among all your models except these.');
	});

	it('names the picture button with the initials it shows (WCAG 2.5.3)', () => {
		renderModal();
		expect(screen.getByRole('button', { name: '?, change picture' })).toBeTruthy();
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My Model' } });
		expect(screen.getByRole('button', { name: 'MM, change picture' })).toHaveTextContent('MM');
	});

	it('names the picture button plainly when the model has a picture of its own', () => {
		renderModal({ edit: true, model: EXISTING });
		expect(screen.getByRole('button', { name: 'Change picture' })).toBeTruthy();
	});

	it('labels its fields on the shared controls, and keeps the ID while editing', () => {
		renderModal({ edit: true, model: EXISTING });
		expect(screen.getByLabelText('Name')).toHaveAttribute('data-slot', 'input');
		expect(screen.getByLabelText('ID')).toBeDisabled();
		expect(screen.getByLabelText('ID')).toHaveAccessibleDescription("An arena model's ID can't be changed.");
		expect(screen.getByText('access control')).toBeTruthy();
	});

	it('hides who may use it while the install has one account (S5-D2)', () => {
		visibility.single = true;
		renderModal();
		expect(screen.queryByText('access control')).toBeNull();
	});

	it('says under Name what is missing or taken, without saving', async () => {
		const { onSubmit } = renderModal();
		await screen.findByRole('option', { name: 'Model Two' });
		fireEvent.click(screen.getByRole('button', { name: 'Add arena model' }));
		const name = screen.getByLabelText('Name');
		expect(name).toHaveAccessibleDescription('Enter a name for the arena model.');
		expect(document.activeElement).toBe(name);
		fireEvent.change(name, { target: { value: 'Model Two' } });
		expect(name).not.toHaveAttribute('aria-invalid', 'true');
		fireEvent.click(screen.getByRole('button', { name: 'Add arena model' }));
		expect(name).toHaveAccessibleDescription('A model already has this name. Choose another.');
		expect(name).toHaveValue('Model Two');
		fireEvent.change(screen.getByLabelText('ID'), { target: { value: '' } });
		fireEvent.change(name, { target: { value: 'Brawl' } });
		fireEvent.change(screen.getByLabelText('ID'), { target: { value: '' } });
		fireEvent.click(screen.getByRole('button', { name: 'Add arena model' }));
		expect(screen.getByLabelText('ID')).toHaveAccessibleDescription('Enter an ID.');
		expect(onSubmit).not.toHaveBeenCalled();
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
		fireEvent.click(screen.getByRole('radio', { name: 'All but these' }));
		fireEvent.click(screen.getByRole('button', { name: 'Add arena model' }));
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
		expect(await screen.findByText(`Delete "${EXISTING.name}"?`)).toBeTruthy();
		expect(onDelete).not.toHaveBeenCalled();
		const confirm = screen.getByRole('button', { name: 'Delete arena model' });
		expect(confirm.getAttribute('data-variant')).toBe('destructive');
		fireEvent.click(confirm);
		await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
	});

	it('has no Delete button while adding', () => {
		renderModal();
		expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
	});
});

describe('Closing the arena model dialog with unsaved changes (FRM-3)', () => {
	it('closes at once while untouched; after an edit Escape asks, Keep editing returns to the field', async () => {
		const onOpenChange = vi.fn();
		renderModal({ edit: true, model: EXISTING, onOpenChange });
		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		onOpenChange.mockClear();

		const name = screen.getByLabelText('Name');
		fireEvent.change(name, { target: { value: 'Duel two' } });
		name.focus();
		fireEvent.keyDown(name, { key: 'Escape' });
		const ask = await screen.findByRole('alertdialog', { name: 'Discard changes?' });
		expect(ask).toHaveTextContent('The changes to this arena model are not saved.');
		fireEvent.click(within(ask).getByRole('button', { name: 'Keep editing' }));
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Name')));
		expect(onOpenChange).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it('counts a model picked but not added, while adding', async () => {
		const onOpenChange = vi.fn();
		renderModal({ onOpenChange });
		await screen.findByRole('option', { name: 'Model Two' });
		fireEvent.change(screen.getByLabelText('Select a model'), { target: { value: 'm2' } });
		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		const ask = await screen.findByRole('alertdialog', { name: 'Discard changes?' });
		expect(ask).toHaveTextContent('This arena model is not added yet.');
		expect(onOpenChange).not.toHaveBeenCalled();
	});

	it('closes without asking once it is saved', async () => {
		const onOpenChange = vi.fn();
		const onSubmit = vi.fn().mockResolvedValue(undefined);
		renderModal({ edit: true, model: EXISTING, onOpenChange, onSubmit });
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Duel two' } });
		fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(screen.queryByRole('alertdialog')).toBeNull();
	});
});
