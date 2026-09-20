import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { getGroups } from '@/lib/apis/groups';
import { getUsers } from '@/lib/apis/users';
import { useAdminStore } from '@/lib/stores/adminStore';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { formatNumber } from '@/lib/utils';
import { routePaths } from '@/routes/routePaths';
import { SubTabs } from '../AdminLayout';
import { tabFromPath } from '../adminAccess';
import { GroupsPanel } from './GroupsPanel';
import { UserList } from './UserList';

const TABS = ['overview', 'groups'] as const;

/**
 * Ports admin/Users.svelte: the Overview / Groups sub-tabs with their counts.
 * With a licence seat limit the user count reads "12 of 10" and turns red once
 * it is exceeded.
 */
export function UsersPage() {
	const { pathname } = useLocation();
	const token = useAuthStore((s) => s.token) ?? '';
	const config = useConfigStore((s) => s.config);
	const counts = useAdminStore((s) => s.counts);
	const setCount = useAdminStore((s) => s.setCount);
	const tab = tabFromPath(pathname, TABS);

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

	const seats = config?.license_metadata?.seats ?? null;
	const exceeded = seats !== null && (counts.users ?? 0) > seats;
	const userCount =
		counts.users === null ? null : seats !== null ? `${formatNumber(counts.users)} of ${formatNumber(seats)}` : formatNumber(counts.users);

	return (
		<div className="flex h-full w-full flex-col pb-2 lg:flex-row">
			<SubTabs
				active={tab}
				tabs={[
					{
						id: 'overview',
						to: routePaths.adminUsersOverview,
						label: 'Overview',
						count: userCount,
						countClassName: exceeded ? `text-red-500 ${tab === 'overview' ? '' : 'opacity-50'}` : undefined
					},
					{
						id: 'groups',
						to: routePaths.adminUsersGroups,
						label: 'Groups',
						count: counts.groups === null ? null : formatNumber(counts.groups)
					}
				]}
			/>
			<div className="flex-1 overflow-y-scroll px-3.5 lg:pr-4 lg:pl-0">{tab === 'overview' ? <UserList /> : <GroupsPanel />}</div>
		</div>
	);
}
