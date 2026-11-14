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
		const row = await screen.findByRole('checkbox', { name: /Staff/ });
		expect(row).toHaveAttribute('aria-checked', 'false');
		fireEvent.click(row);
		expect(onGroups).toHaveBeenLastCalledWith(['g1']);
		expect(row).toHaveAttribute('aria-checked', 'true');
		expect(screen.getByText('1 groups')).toBeInTheDocument();
		const chip = screen.getByRole('button', { name: /Staff/ });
		fireEvent.click(chip);
		expect(onGroups).toHaveBeenLastCalledWith([]);
		expect(row).toHaveAttribute('aria-checked', 'false');
	});

	it('picks a user, shows it as a chip, and unpicks it from the chip', async () => {
		const onUsers = vi.fn();
		render(<Harness onUsers={onUsers} onGroups={vi.fn()} />);
		const row = await screen.findByRole('checkbox', { name: /Ada/ });
		fireEvent.click(row);
		expect(onUsers).toHaveBeenLastCalledWith(['u1']);
		expect(row).toHaveAttribute('aria-checked', 'true');
		await waitFor(() => expect(screen.getByText('1 users')).toBeInTheDocument());
		fireEvent.click(screen.getByRole('button', { name: /Ada/ }));
		expect(onUsers).toHaveBeenLastCalledWith([]);
	});

	it('puts no control inside a row: the row is the checkbox (#1120)', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		render(<Harness onUsers={vi.fn()} onGroups={vi.fn()} />);
		const rows = [
			await screen.findByRole('checkbox', { name: /Staff/ }),
			await screen.findByRole('checkbox', { name: /Ada/ })
		];
		for (const row of rows) {
			expect(row.tagName).toBe('BUTTON');
			expect(row.querySelector('button, [role="checkbox"], input')).toBeNull();
			expect(row.querySelector('[data-slot="checkbox-mark"]')).toHaveAttribute('aria-hidden', 'true');
		}
		expect(error.mock.calls.flat().join(' ')).not.toMatch(
			/cannot be a descendant|validateDOMNesting|cannot contain a nested/
		);
		error.mockRestore();
	});
});
