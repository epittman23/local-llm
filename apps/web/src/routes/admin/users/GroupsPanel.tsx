import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { toastFailure } from '@/components/common/failureToast';
import { ListEmptyState, ListSearchBar } from '@/components/common/ListChrome';
import { LoadFailed } from '@/components/common/LoadFailed';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { RowButton } from '@/components/ui/row-button';
import { createNewGroup, getGroups } from '@/lib/apis/groups';
import { getUserDefaultPermissions, updateUserDefaultPermissions } from '@/lib/apis/users';
import { useAdminStore } from '@/lib/stores/adminStore';
import { useAuthStore } from '@/lib/stores/authStore';
import { TableSkeleton } from '../TableSkeleton';
import { EditGroupModal, type Group, type GroupFormValue } from './EditGroupModal';
import { GroupItem } from './GroupItem';
import { filterAndSortGroups, type GroupSort } from './groupList';

const sortItems: { value: GroupSort; label: string }[] = [
	{ value: 'members', label: 'Members' },
	{ value: 'name', label: 'Name' }
];

/**
 * Ports admin/Users/Groups.svelte: the group list with search and sort, the
 * New Group modal, and the all-users "Default permissions" modal. The tab count
 * follows the *filtered* list, as in the original.
 *
 * #1057/#987: the shared search, a Sort menu named by its text, and New group
 * in a toolbar row tall enough for it (LAY-3).
 */
export function GroupsPanel() {
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	const setCount = useAdminStore((s) => s.setCount);
	const [params] = useSearchParams();
	const deepLinkId = params.get('id');

	const [query, setQuery] = useState('');
	const [sortBy, setSortBy] = useState<GroupSort>('members');
	const [showAdd, setShowAdd] = useState(false);
	const [showDefaults, setShowDefaults] = useState(false);

	const groupsQuery = useQuery({ queryKey: ['admin', 'groups'], queryFn: () => getGroups(token) as Promise<Group[]> });
	const defaultsQuery = useQuery({
		queryKey: ['admin', 'default-permissions'],
		queryFn: () => getUserDefaultPermissions(token) as Promise<Record<string, unknown>>
	});

	const groups = groupsQuery.data ?? [];
	const filtered = filterAndSortGroups(groups, query, sortBy);

	// Both are needed: without the defaults, New Group and Default permissions
	// would start from nothing and could save that over the stored ones.
	const failedQuery = [groupsQuery, defaultsQuery].find((q) => q.isError || (q.isPaused && q.data === undefined));
	useEffect(() => {
		if (groupsQuery.data) setCount('groups', filtered.length);
	}, [groupsQuery.data, filtered.length, setCount]);

	const refetchGroups = () => queryClient.invalidateQueries({ queryKey: ['admin', 'groups'] });
	// A membership change returns the updated group, so patch it in without a round trip.
	const patchGroup = (updated: Group) =>
		queryClient.setQueryData<Group[]>(['admin', 'groups'], (prev) =>
			prev?.map((g) => (g.id === updated.id ? updated : g))
		);

	const addGroup = async (value: GroupFormValue) => {
		const res = await createNewGroup(token, value).catch((error) => {
			toastFailure("Couldn't create the group.", error);
			return null;
		});
		if (res) {
			toast.success(`Created “${value.name}”`);
			await refetchGroups();
		}
	};

	const updateDefaults = async (value: GroupFormValue) => {
		const res = await updateUserDefaultPermissions(token, value.permissions).catch((error) => {
			toastFailure("Couldn't save the default permissions.", error);
			return null;
		});
		if (res) {
			toast.success('Default permissions saved');
			await queryClient.invalidateQueries({ queryKey: ['admin', 'default-permissions'] });
		}
	};

	if (failedQuery) {
		return (
			<LoadFailed
				what="groups"
				error={failedQuery.error}
				onRetry={() => {
					groupsQuery.refetch();
					defaultsQuery.refetch();
				}}
				retrying={groupsQuery.isFetching || defaultsQuery.isFetching}
			/>
		);
	}

	if (groupsQuery.isPending || defaultsQuery.isPending) {
		return <TableSkeleton label="groups" />;
	}

	const defaultPermissions = defaultsQuery.data ?? {};
	const sortLabel = sortItems.find((i) => i.value === sortBy)?.label;

	return (
		<>
			<EditGroupModal
				open={showAdd}
				onOpenChange={setShowAdd}
				tabs={['general', 'permissions']}
				initialPermissions={defaultPermissions}
				onSubmit={addGroup}
			/>

			<div className="flex flex-col gap-2">
				<div className="flex flex-wrap items-center gap-2">
					<div className="min-w-0 flex-1">
						<ListSearchBar value={query} onChange={setQuery} placeholder="Search groups">
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button variant="ghost" type="button">
										Sort: {sortLabel}
										<ChevronDown aria-hidden data-icon="inline-end" />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuRadioGroup value={sortBy} onValueChange={(v) => setSortBy(v as GroupSort)}>
										{sortItems.map((item) => (
											<DropdownMenuRadioItem key={item.value} value={item.value}>
												{item.label}
											</DropdownMenuRadioItem>
										))}
									</DropdownMenuRadioGroup>
								</DropdownMenuContent>
							</DropdownMenu>
						</ListSearchBar>
					</div>
					<Button variant="outline" type="button" onClick={() => setShowAdd(true)}>
						<Plus aria-hidden data-icon="inline-start" />
						New group
					</Button>
				</div>

				{filtered.length !== 0 ? (
					<ul aria-label="Groups" className="flex flex-col">
						{filtered.map((group) => (
							<li key={group.id} className="border-b last:border-0">
								<GroupItem
									group={group}
									defaultPermissions={defaultPermissions}
									openOnMount={deepLinkId === group.id}
									onChanged={refetchGroups}
									onGroupUpdate={patchGroup}
								/>
							</li>
						))}
					</ul>
				) : (
					<ListEmptyState
						title="No groups yet"
						description="Groups give their members permissions beyond the defaults."
						query={query}
						onClear={() => setQuery('')}
					/>
				)}

				<div className="border-t pt-2">
					<RowButton
						className="flex items-center gap-3 px-2.5 py-2"
						aria-haspopup="dialog"
						onClick={() => setShowDefaults(true)}
					>
						<div className="flex min-w-0 flex-1 flex-col gap-0.5">
							<span className="text-foreground-strong font-strong">Default permissions</span>
							<span className="text-foreground-muted text-dense truncate">
								What every account with the User role may do
							</span>
						</div>
						<span className="text-foreground-muted shrink-0">Edit</span>
					</RowButton>
				</div>
			</div>

			{showDefaults && (
				<EditGroupModal
					open={showDefaults}
					onOpenChange={setShowDefaults}
					tabs={['permissions']}
					initialPermissions={defaultPermissions}
					custom={false}
					onSubmit={updateDefaults}
				/>
			)}
		</>
	);
}
