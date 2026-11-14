import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getGroups } from '@/lib/apis/groups';
import { searchUsers } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { MemberSelector } from './MemberSelector';

vi.mock('@/lib/apis/groups', () => ({ getGroups: vi.fn() }));
vi.mock('@/lib/apis/users', () => ({ getUserInfoById: vi.fn(), searchUsers: vi.fn() }));

function Harness({ onUsers, onGroups }: { onUsers: (ids: string[]) => void; onGroups: (ids: string[]) => void }) {
	const [userIds, setUserIds] = useState<string[]>([]);
	const [groupIds, setGroupIds] = useState<string[]>([]);
	return (
		<TooltipProvider>
			<MemberSelector
				accessGrants={[]}
				userIds={userIds}
				groupIds={groupIds}
				onUserIdsChange={(ids) => {
					setUserIds(ids);
					onUsers(ids);
				}}
				onGroupIdsChange={(ids) => {
					setGroupIds(ids);
					onGroups(ids);
				}}
			/>
		</TooltipProvider>
	);
}

describe('MemberSelector', () => {
	beforeEach(() => {
		useAuthStore.setState({ token: 't', user: { id: 'me' } as never });
		vi.mocked(getGroups).mockResolvedValue([{ id: 'g1', name: 'Staff', member_count: 3 }] as never);
		vi.mocked(searchUsers).mockResolvedValue({ users: [{ id: 'u1', name: 'Ada', email: 'ada@x.io' }] } as never);
	});

	it('picks a group, shows it as a chip, and unpicks it from the chip', async () => {
		const onGroups = vi.fn();
		render(<Harness onUsers={vi.fn()} onGroups={onGroups} />);
		fireEvent.click(await screen.findByRole('button', { name: /Staff/ }));
		expect(onGroups).toHaveBeenLastCalledWith(['g1']);
		expect(screen.getByText('1 groups')).toBeInTheDocument();
		const chip = screen.getAllByRole('button', { name: /Staff/ })[0];
		fireEvent.click(chip);
		expect(onGroups).toHaveBeenLastCalledWith([]);
	});

	it('picks a user, shows it as a chip, and unpicks it from the chip', async () => {
		const onUsers = vi.fn();
		render(<Harness onUsers={onUsers} onGroups={vi.fn()} />);
		fireEvent.click(await screen.findByRole('button', { name: /Ada/ }));
		expect(onUsers).toHaveBeenLastCalledWith(['u1']);
		await waitFor(() => expect(screen.getByText('1 users')).toBeInTheDocument());
		fireEvent.click(screen.getAllByRole('button', { name: /Ada/ })[0]);
		expect(onUsers).toHaveBeenLastCalledWith([]);
	});
});
