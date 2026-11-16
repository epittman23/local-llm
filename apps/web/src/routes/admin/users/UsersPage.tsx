import { useEffect } from 'react';
import { Navigate, useLocation } from 'react-router';
import { getGroups } from '@/lib/apis/groups';
import { getUsers } from '@/lib/apis/users';
import { useAdminStore } from '@/lib/stores/adminStore';
import { useAuthStore } from '@/lib/stores/authStore';
import { formatNumber } from '@/lib/utils';
import { routePaths } from '@/routes/routePaths';
import { SubTabs } from '../AdminLayout';
import { tabFromPath } from '../adminAccess';
import { useAdminSingleUser } from '../adminVisibility';
import { GroupsPanel } from './GroupsPanel';
import { UserList } from './UserList';

const TABS = ['overview', 'groups'] as const;

/**
 * Ports admin/Users.svelte: the Overview / Groups sub-tabs with their counts.
 *
 * S5-D2 (#1022): while there is one account and sign-ups are off, Groups and
 * its Default permissions say nothing to anyone, so the sub-tabs go and the
 * Groups address opens the user list. They return with a second account.
 */
export function UsersPage() {
	const { pathname } = useLocation();
	const token = useAuthStore((s) => s.token) ?? '';
	const counts = useAdminStore((s) => s.counts);
	const setCount = useAdminStore((s) => s.setCount);
	const tab = tabFromPath(pathname, TABS);
	const singleUser = useAdminSingleUser();

	// Seeds both counts so the inactive tab is not blank; each panel then keeps its own current.
	useEffect(() => {
		let cancelled = false;
		Promise.all([
			getUsers(token, undefined, 'created_at', 'asc', 1).catch(() => null),
			getGroups(token).catch(() => null)
		]).then(([users, groups]) => {
			if (cancelled) return;
			setCount('users', users?.total ?? null);
			setCount('groups', Array.isArray(groups) ? groups.length : null);
		});
		return () => {
			cancelled = true;
		};
	}, [token, tab, setCount]);

	const userCount = counts.users === null ? null : formatNumber(counts.users);

	if (singleUser) {
		if (tab === 'groups') return <Navigate to={routePaths.adminUsersOverview} replace />;
		return (
			<div className="flex w-full min-w-0 flex-col px-4 pt-3 pb-2">
				<UserList />
			</div>
		);
	}

	return (
		<div className="flex w-full flex-col pb-2">
			<SubTabs
				active={tab}
				tabs={[
					{
						id: 'overview',
						to: routePaths.adminUsersOverview,
						label: 'Overview',
						count: userCount
					},
					{
						id: 'groups',
						to: routePaths.adminUsersGroups,
						label: 'Groups',
						count: counts.groups === null ? null : formatNumber(counts.groups)
					}
				]}
			/>
			<div className="min-w-0 flex-1 px-4 pt-3">{tab === 'overview' ? <UserList /> : <GroupsPanel />}</div>
		</div>
	);
}
