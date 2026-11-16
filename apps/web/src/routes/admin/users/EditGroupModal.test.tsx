import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { toastFailure } from '@/components/common/failureToast';
import { getUserDefaultPermissions, getUserDefaultPermissionsDefaults } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { EditGroupModal } from './EditGroupModal';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('@/components/common/failureToast', () => ({ toastFailure: vi.fn() }));
vi.mock('@/lib/apis/users', () => ({
	getUserDefaultPermissions: vi.fn(),
	getUserDefaultPermissionsDefaults: vi.fn()
}));
vi.mock('./GroupUsers', () => ({ GroupUsers: () => <div>group users panel</div> }));
vi.mock('./GroupPreviewPanel', () => ({ GroupPreviewPanel: () => <div>group preview panel</div> }));

const GROUP = { id: 'g1', name: 'Research', description: 'd', permissions: {}, data: {}, member_count: 3 };

beforeEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({ token: 'tok' } as never);
});

const renderModal = (props: Partial<Parameters<typeof EditGroupModal>[0]> = {}) => {
	const onSubmit = vi.fn();
	render(
		<TooltipProvider>
			<EditGroupModal open onOpenChange={vi.fn()} onSubmit={onSubmit} {...props} />
		</TooltipProvider>
	);
	return onSubmit;
};

// Radix tabs choose on mouse down.
const selectTab = (name: string) =>
	fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0, ctrlKey: false });

describe('EditGroupModal', () => {
	it('titles the modal by what it is doing', () => {
		renderModal({ edit: true, group: GROUP });
		expect(screen.getByRole('heading', { name: 'Edit group' })).toBeTruthy();
	});

	it('titles the default permissions and shows no tab strip for their one tab', () => {
		renderModal({ custom: false, tabs: ['permissions'] });
		expect(screen.getByRole('heading', { name: 'Default permissions' })).toBeTruthy();
		expect(screen.queryByRole('tablist')).toBeNull();
		expect(screen.getByRole('button', { name: 'Save permissions' })).toBeTruthy();
	});

	it('shows only the General and Permissions tabs when adding', () => {
		renderModal({ tabs: ['general', 'permissions'] });
		expect(screen.getByRole('heading', { name: 'New group' })).toBeTruthy();
		expect(screen.getByRole('tab', { name: 'General' })).toBeTruthy();
		expect(screen.getByRole('tab', { name: 'Permissions' })).toBeTruthy();
		expect(screen.queryByRole('tab', { name: 'Members' })).toBeNull();
	});

	it('switches panels from the tabs', () => {
		renderModal({ edit: true, group: GROUP, tabs: ['general', 'permissions', 'users', 'preview'] });
		selectTab('Members');
		expect(screen.getByText('group users panel')).toBeTruthy();
		selectTab('Preview');
		expect(screen.getByText('group preview panel')).toBeTruthy();
	});

	it('offers Reset to defaults only on the Permissions tab', () => {
		renderModal({ group: GROUP });
		expect(screen.queryByRole('button', { name: 'Reset to defaults' })).toBeNull();
		selectTab('Permissions');
		expect(screen.getByRole('button', { name: 'Reset to defaults' })).toBeTruthy();
	});

	it('asks before resetting, then loads the current default permissions', async () => {
		vi.mocked(getUserDefaultPermissions).mockResolvedValue({} as never);
		renderModal({ edit: true, group: GROUP });
		selectTab('Permissions');
		fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
		expect(getUserDefaultPermissions).not.toHaveBeenCalled();
		const confirm = await screen.findByRole('alertdialog', { name: 'Reset permissions to defaults?' });
		expect(confirm).toHaveTextContent('Nothing changes until you press Save group.');
		fireEvent.click(within(confirm).getByRole('button', { name: 'Reset permissions' }));
		await waitFor(() => expect(getUserDefaultPermissions).toHaveBeenCalledWith('tok'));
		expect(toast.success).toHaveBeenCalledWith('Permissions reset to defaults. Save to keep them.');
	});

	it('resets the default permissions to the stock configuration', async () => {
		vi.mocked(getUserDefaultPermissionsDefaults).mockResolvedValue({} as never);
		renderModal({ custom: false, tabs: ['permissions'] });
		fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
		const confirm = await screen.findByRole('alertdialog');
		expect(confirm).toHaveTextContent("the server's starting configuration");
		fireEvent.click(within(confirm).getByRole('button', { name: 'Reset permissions' }));
		await waitFor(() => expect(getUserDefaultPermissionsDefaults).toHaveBeenCalledWith('tok'));
	});

	it('reports a failed reset through the failure toast', async () => {
		vi.mocked(getUserDefaultPermissions).mockRejectedValue('nope');
		renderModal({ group: GROUP });
		selectTab('Permissions');
		fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
		fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Reset permissions' }));
		await waitFor(() => expect(toastFailure).toHaveBeenCalledWith("Couldn't load the default permissions.", 'nope'));
	});

	it('submits the group name and description', async () => {
		const onSubmit = renderModal({ edit: true, group: GROUP });
		fireEvent.click(screen.getByRole('button', { name: 'Save group' }));
		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		expect(onSubmit.mock.calls[0][0]).toMatchObject({ name: 'Research', description: 'd' });
	});

	it('asks for a name under Name instead of saving a group without one', async () => {
		const onSubmit = renderModal({ tabs: ['general', 'permissions'] });
		selectTab('Permissions');
		fireEvent.click(screen.getByRole('button', { name: 'Create group' }));
		expect(await screen.findByText('Enter a name for the group.')).toBeTruthy();
		expect(screen.getByLabelText('Name').getAttribute('aria-invalid')).toBe('true');
		expect(onSubmit).not.toHaveBeenCalled();
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Analysts' } });
		expect(screen.queryByText('Enter a name for the group.')).toBeNull();
	});

	it('confirms a delete, saying the members keep their accounts (ACT-3)', async () => {
		const onDelete = vi.fn();
		const onOpenChange = vi.fn();
		render(
			<TooltipProvider>
				<EditGroupModal open onOpenChange={onOpenChange} edit group={GROUP} onSubmit={vi.fn()} onDelete={onDelete} />
			</TooltipProvider>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Delete group' }));
		const confirm = await screen.findByRole('alertdialog', { name: 'Delete “Research”?' });
		expect(confirm).toHaveTextContent('Its members keep their accounts');
		fireEvent.click(within(confirm).getByRole('button', { name: 'Delete group' }));
		await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it('sets who can share with the group', async () => {
		const onSubmit = renderModal({ edit: true, group: GROUP });
		const share = screen.getByRole('combobox', { name: 'Who can share with this group' });
		expect(share).toHaveTextContent('Its members');
		fireEvent.click(screen.getByRole('button', { name: 'Save group' }));
		await waitFor(() => expect(onSubmit).toHaveBeenCalled());
	});
});
