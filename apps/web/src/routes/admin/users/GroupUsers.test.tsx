import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { addUserToGroup, removeUserFromGroup } from '@/lib/apis/groups';
import { getUsers } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { GroupUsers } from './GroupUsers';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
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
				<GroupUsers groupId="g1" userCount={1} onUserCountChange={onUserCountChange} onMemberChange={onMemberChange} />
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
});
