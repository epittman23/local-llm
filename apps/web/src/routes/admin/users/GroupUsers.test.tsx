import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { toastFailure } from '@/components/common/failureToast';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { addUserToGroup, removeUserFromGroup } from '@/lib/apis/groups';
import { getUsers } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { GroupUsers } from './GroupUsers';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('@/components/common/failureToast', () => ({ toastFailure: vi.fn() }));
vi.mock('@/lib/apis/groups', () => ({ addUserToGroup: vi.fn(), removeUserFromGroup: vi.fn() }));
vi.mock('@/lib/apis/users', () => ({ getUsers: vi.fn() }));

const user = (id: string, name: string, role: string, groupIds: string[]) => ({
	id,
	name,
	email: `${name.toLowerCase()}@example.com`,
	role,
	last_active_at: 1700000000,
	group_ids: groupIds
});

beforeEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({ token: 'tok' } as never);
	vi.mocked(getUsers).mockResolvedValue({
		users: [user('u1', 'Ada', 'admin', ['g1']), user('u2', 'Ben', 'user', [])],
		total: 2
	} as never);
});

const renderPanel = async () => {
	const onUserCountChange = vi.fn();
	const onMemberChange = vi.fn();
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<GroupUsers
					groupId="g1"
					groupName="Analysts"
					userCount={1}
					onUserCountChange={onUserCountChange}
					onMemberChange={onMemberChange}
				/>
			</TooltipProvider>
		</QueryClientProvider>
	);
	await screen.findByText('Ben');
	return { onUserCountChange, onMemberChange };
};

describe('GroupUsers', () => {
	it('ticks the members of the group and leaves the others unticked', async () => {
		await renderPanel();
		expect(screen.getByRole('checkbox', { name: 'Ada' }).getAttribute('aria-checked')).toBe('true');
		expect(screen.getByRole('checkbox', { name: 'Ben' }).getAttribute('aria-checked')).toBe('false');
	});

	it('adds a user to the group when ticked and reports the new count', async () => {
		vi.mocked(addUserToGroup).mockResolvedValue({ id: 'g1', member_count: 2 } as never);
		const { onUserCountChange, onMemberChange } = await renderPanel();
		fireEvent.click(screen.getByRole('checkbox', { name: 'Ben' }));
		await waitFor(() => expect(addUserToGroup).toHaveBeenCalledWith('tok', 'g1', ['u2']));
		await waitFor(() => expect(onUserCountChange).toHaveBeenCalledWith(2));
		expect(onMemberChange).toHaveBeenCalledWith({ id: 'g1', member_count: 2 });
	});

	it('removes a user from the group when unticked', async () => {
		vi.mocked(removeUserFromGroup).mockResolvedValue({ id: 'g1', member_count: 0 } as never);
		await renderPanel();
		fireEvent.click(screen.getByRole('checkbox', { name: 'Ada' }));
		await waitFor(() => expect(removeUserFromGroup).toHaveBeenCalledWith('tok', 'g1', ['u1']));
	});

	it('sorts by a column from its header button', async () => {
		await renderPanel();
		fireEvent.click(screen.getByRole('button', { name: /^Name/ }));
		await waitFor(() => expect(getUsers).toHaveBeenLastCalledWith('tok', '', 'name', 'asc', 1));
	});

	it('heads the tick column "Member", names the table, and says "Never" for an account never active', async () => {
		vi.mocked(getUsers).mockResolvedValue({
			users: [{ ...user('u3', 'Cy', 'pending', []), last_active_at: 0 }],
			total: 1
		} as never);
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<TooltipProvider>
					<GroupUsers
						groupId="g1"
						groupName="Analysts"
						userCount={0}
						onUserCountChange={vi.fn()}
						onMemberChange={vi.fn()}
					/>
				</TooltipProvider>
			</QueryClientProvider>
		);
		expect(await screen.findByText('Never')).toBeTruthy();
		expect(screen.getByRole('button', { name: /^Member/ })).toBeTruthy();
		expect(screen.queryByText('MBR')).toBeNull();
		expect(screen.getByRole('table')).toBeTruthy();
		expect(screen.getByText('Pending')).toBeTruthy();
	});

	it('says who was removed, with an Undo that adds them back (ACT-3)', async () => {
		vi.mocked(removeUserFromGroup).mockResolvedValue({ id: 'g1', member_count: 0 } as never);
		vi.mocked(addUserToGroup).mockResolvedValue({ id: 'g1', member_count: 1 } as never);
		await renderPanel();
		fireEvent.click(screen.getByRole('checkbox', { name: 'Ada' }));
		expect(await screen.findByRole('status')).toHaveTextContent('Removed “Ada” from Analysts');
		fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
		await waitFor(() => expect(addUserToGroup).toHaveBeenCalledWith('tok', 'g1', ['u1']));
		await waitFor(() => expect(screen.queryByText('Removed “Ada” from Analysts')).toBeNull());
		expect(toast.success).not.toHaveBeenCalled();
	});

	it('reports a failed change through the failure toast', async () => {
		vi.mocked(addUserToGroup).mockRejectedValue('nope');
		await renderPanel();
		fireEvent.click(screen.getByRole('checkbox', { name: 'Ben' }));
		await waitFor(() => expect(toastFailure).toHaveBeenCalledWith("Couldn't add “Ben” to Analysts.", 'nope'));
	});

	it('names Import by its text (#987) and searches users', async () => {
		await renderPanel();
		expect(screen.getByRole('button', { name: 'Import CSV' })).toBeTruthy();
		fireEvent.change(screen.getByLabelText('Search users'), { target: { value: 'zz' } });
		await waitFor(() => expect(getUsers).toHaveBeenLastCalledWith('tok', 'zz', 'group_id:g1', 'desc', 1));
	});

	it('imports members from a CSV, matched on email', async () => {
		vi.mocked(addUserToGroup).mockResolvedValue({ id: 'g1', member_count: 2 } as never);
		await renderPanel();
		vi.mocked(getUsers).mockResolvedValue({ users: [{ id: 'u2', email: 'ben@example.com' }], total: 1 } as never);
		const file = new File(['Name,Email\nBen,ben@example.com\nbad\n'], 'm.csv', { type: 'text/csv' });
		fireEvent.change(screen.getByLabelText('CSV file of members'), { target: { files: [file] } });
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Added 1 member'));
		expect(toast.error).toHaveBeenCalledWith('Row 3: not a name and an email.');
	});
});
