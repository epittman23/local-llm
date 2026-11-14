import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getGroupInfoById, getGroups } from '@/lib/apis/groups';
import { getUserInfoById } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { AccessControl } from './AccessControl';

vi.mock('@/lib/apis/groups', () => ({ getGroups: vi.fn(), getGroupInfoById: vi.fn() }));
vi.mock('@/lib/apis/users', () => ({ getUserInfoById: vi.fn(), searchUsers: vi.fn() }));
vi.mock('@/components/common/AddAccessModal', () => ({
	AddAccessModal: ({ open }: { open: boolean }) => (open ? <div role="dialog">Add Access dialog</div> : null)
}));

describe('AccessControl', () => {
	beforeEach(() => {
		useAuthStore.setState({ token: 't', user: { id: 'me' } as never });
		vi.mocked(getGroups).mockResolvedValue([{ id: 'g1', name: 'Staff', member_count: 3 }] as never);
		vi.mocked(getGroupInfoById).mockResolvedValue(null as never);
		vi.mocked(getUserInfoById).mockResolvedValue({ id: 'u1', name: 'Ada', email: 'ada@x.io' } as never);
	});

	it('opens the add-access dialog from the Add Access button', async () => {
		render(
			<TooltipProvider>
				<AccessControl accessGrants={[]} onChange={vi.fn()} />
			</TooltipProvider>
		);
		fireEvent.click(await screen.findByRole('button', { name: 'Add Access' }));
		expect(screen.getByRole('dialog')).toBeInTheDocument();
	});

	it('removes a group grant from its remove button', async () => {
		const onChange = vi.fn();
		render(
			<TooltipProvider>
				<AccessControl
					accessGrants={[{ principal_type: 'group', principal_id: 'g1', permission: 'read' }]}
					onChange={onChange}
				/>
			</TooltipProvider>
		);
		fireEvent.click(await screen.findByRole('button', { name: 'Remove Staff' }));
		expect(onChange).toHaveBeenCalledWith([]);
	});

	it('removes a user grant from its remove button', async () => {
		const onChange = vi.fn();
		render(
			<TooltipProvider>
				<AccessControl
					accessGrants={[{ principal_type: 'user', principal_id: 'u1', permission: 'read' }]}
					onChange={onChange}
				/>
			</TooltipProvider>
		);
		fireEvent.click(await screen.findByRole('button', { name: 'Remove Ada' }));
		expect(onChange).toHaveBeenCalledWith([]);
	});
});
