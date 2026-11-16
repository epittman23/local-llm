import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

beforeAll(() => {
	// Radix Select measures and captures the pointer, which jsdom does not do.
	Element.prototype.scrollIntoView = vi.fn();
	Element.prototype.hasPointerCapture = vi.fn(() => false);
	Element.prototype.releasePointerCapture = vi.fn();
});

const choose = async (combobox: string, option: string) => {
	fireEvent.keyDown(screen.getByRole('combobox', { name: combobox }), { key: 'Enter' });
	fireEvent.click(await screen.findByRole('option', { name: option }));
};

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

	it('leaves out its visibility picker when the caller asks who can open the item itself', async () => {
		render(
			<TooltipProvider>
				<AccessControl accessGrants={[]} onChange={vi.fn()} showVisibility={false} />
			</TooltipProvider>
		);
		expect(await screen.findByRole('button', { name: 'Add Access' })).toBeInTheDocument();
		expect(screen.queryByLabelText('Visibility')).not.toBeInTheDocument();
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

	it('picks visibility and a principal’s access level from the shared Select (FRM-4)', async () => {
		const onChange = vi.fn();
		render(
			<TooltipProvider>
				<AccessControl
					accessGrants={[{ principal_type: 'user', principal_id: 'u1', permission: 'read' }]}
					onChange={onChange}
					accessRoles={['read', 'write']}
					share
					sharePublic
				/>
			</TooltipProvider>
		);
		const visibility = await screen.findByRole('combobox', { name: 'Visibility' });
		expect(visibility).toHaveAttribute('data-slot', 'select-trigger');
		expect(visibility).toHaveTextContent('Private');
		await choose('Visibility', 'Public');
		expect(onChange).toHaveBeenLastCalledWith(
			expect.arrayContaining([expect.objectContaining({ principal_type: 'user', principal_id: '*' })])
		);
		await screen.findByRole('button', { name: 'Remove Ada' });
		await choose('Access level', 'Write');
		expect(onChange).toHaveBeenLastCalledWith(
			expect.arrayContaining([expect.objectContaining({ principal_id: 'u1', permission: 'write' })])
		);
	});
});
