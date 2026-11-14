import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getUserDefaultPermissions } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { EditGroupModal } from './EditGroupModal';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
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

describe('EditGroupModal', () => {
	it('titles the modal by what it is doing', () => {
		renderModal({ edit: true, group: GROUP });
		expect(screen.getByText('Edit User Group', { selector: 'h2' })).toBeTruthy();
	});

	it('shows only the General and Permissions tabs when adding', () => {
		renderModal({ tabs: ['general', 'permissions'] });
		expect(screen.getByRole('button', { name: 'General' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Permissions' })).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Users' })).toBeNull();
	});

	it('switches panels from the tab buttons', () => {
		renderModal({ edit: true, group: GROUP, tabs: ['general', 'permissions', 'users', 'preview'] });
		fireEvent.click(screen.getByRole('button', { name: 'Users' }));
		expect(screen.getByText('group users panel')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
		expect(screen.getByText('group preview panel')).toBeTruthy();
	});

	it('offers Reset to Defaults only on the Permissions tab', () => {
		renderModal({ group: GROUP });
		expect(screen.queryByRole('button', { name: 'Reset to Defaults' })).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Permissions' }));
		expect(screen.getByRole('button', { name: 'Reset to Defaults' })).toBeTruthy();
	});

	it('asks before resetting, then loads the current default permissions', async () => {
		vi.mocked(getUserDefaultPermissions).mockResolvedValue({} as never);
		renderModal({ group: GROUP });
		fireEvent.click(screen.getByRole('button', { name: 'Permissions' }));
		fireEvent.click(screen.getByRole('button', { name: 'Reset to Defaults' }));
		expect(getUserDefaultPermissions).not.toHaveBeenCalled();
		const dialog = await screen.findByText(/Are you sure you want to reset all permissions/);
		expect(dialog).toBeTruthy();
		const confirm = screen
			.getAllByRole('button', { name: /Confirm|Reset/ })
			.find((b) => b.textContent !== 'Reset to Defaults');
		fireEvent.click(confirm as HTMLElement);
		await waitFor(() => expect(getUserDefaultPermissions).toHaveBeenCalledWith('tok'));
	});

	it('submits the group name and description', async () => {
		const onSubmit = renderModal({ edit: true, group: GROUP });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		expect(onSubmit.mock.calls[0][0]).toMatchObject({ name: 'Research', description: 'd' });
	});
});
