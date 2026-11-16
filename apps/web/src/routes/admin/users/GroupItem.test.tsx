import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toastFailure } from '@/components/common/failureToast';
import { TooltipProvider } from '@/components/ui/tooltip';
import { deleteGroupById, updateGroupById } from '@/lib/apis/groups';
import { useAuthStore } from '@/lib/stores/authStore';
import { GroupItem } from './GroupItem';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('@/components/common/failureToast', () => ({ toastFailure: vi.fn() }));
vi.mock('@/lib/apis/groups', () => ({ deleteGroupById: vi.fn(), updateGroupById: vi.fn() }));
vi.mock('@/lib/apis/users', () => ({ getUserDefaultPermissions: vi.fn(), getUserDefaultPermissionsDefaults: vi.fn() }));
vi.mock('./GroupUsers', () => ({ GroupUsers: () => <div>group users panel</div> }));
vi.mock('./GroupPreviewPanel', () => ({ GroupPreviewPanel: () => <div>group preview panel</div> }));

const GROUP = { id: 'g1', name: 'Analysts', description: '', permissions: {}, member_count: 1 };

beforeEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({ token: 'tok' } as never);
});

const renderItem = () => {
	const onChanged = vi.fn();
	render(
		<TooltipProvider>
			<GroupItem
				group={GROUP}
				defaultPermissions={{}}
				openOnMount={false}
				onChanged={onChanged}
				onGroupUpdate={vi.fn()}
			/>
		</TooltipProvider>
	);
	return onChanged;
};

const confirmDelete = async () => {
	fireEvent.click(screen.getByRole('button', { name: /Analysts/ }));
	fireEvent.click(await screen.findByRole('button', { name: 'Delete group' }));
	const dialog = await screen.findByRole('alertdialog');
	fireEvent.click(within(dialog).getByRole('button', { name: 'Delete group' }));
};

describe('GroupItem', () => {
	it('reads "1 member", not "1 members"', () => {
		renderItem();
		expect(screen.getByText('1 member')).toBeTruthy();
	});

	it('saves the group and says so', async () => {
		vi.mocked(updateGroupById).mockResolvedValue({ id: 'g1' } as never);
		const onChanged = renderItem();
		fireEvent.click(screen.getByRole('button', { name: /Analysts/ }));
		fireEvent.click(await screen.findByRole('button', { name: 'Save group' }));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Saved “Analysts”'));
		expect(onChanged).toHaveBeenCalled();
	});

	it('reports a failed save', async () => {
		vi.mocked(updateGroupById).mockRejectedValue('nope');
		renderItem();
		fireEvent.click(screen.getByRole('button', { name: /Analysts/ }));
		fireEvent.click(await screen.findByRole('button', { name: 'Save group' }));
		await waitFor(() => expect(toastFailure).toHaveBeenCalledWith("Couldn't save the group.", 'nope'));
	});

	it('deletes the group after the confirm, and says so', async () => {
		vi.mocked(deleteGroupById).mockResolvedValue(true as never);
		const onChanged = renderItem();
		await confirmDelete();
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Deleted “Analysts”'));
		expect(onChanged).toHaveBeenCalled();
	});

	it('reports a failed delete', async () => {
		vi.mocked(deleteGroupById).mockRejectedValue('nope');
		renderItem();
		await confirmDelete();
		await waitFor(() => expect(toastFailure).toHaveBeenCalledWith("Couldn't delete “Analysts”.", 'nope'));
	});
});
