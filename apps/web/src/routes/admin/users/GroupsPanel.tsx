import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { createNewGroup, getGroups } from '@/lib/apis/groups';
import { getUserDefaultPermissions, updateUserDefaultPermissions } from '@/lib/apis/users';
import { useAdminStore } from '@/lib/stores/adminStore';
import { useAuthStore } from '@/lib/stores/authStore';
import { EditGroupModal, type Group, type GroupFormValue } from './EditGroupModal';
import { GroupItem } from './GroupItem';
import { type GroupSort, filterAndSortGroups } from './groupList';

const sortItems: { value: GroupSort; label: string }[] = [
	{ value: 'members', label: 'Members' },
	{ value: 'name', label: 'Name' }
];

/**
 * Ports admin/Users/Groups.svelte: the group list with search and sort, the
 * New Group modal, and the all-users "Default permissions" modal. The tab count
 * follows the *filtered* list, as in the original.
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

	useEffect(() => {
		if (groupsQuery.isError) toast.error(`${groupsQuery.error}`);
	}, [groupsQuery.isError, groupsQuery.error]);
	useEffect(() => {
		if (groupsQuery.data) setCount('groups', filtered.length);
	}, [groupsQuery.data, filtered.length, setCount]);

	const refetchGroups = () => queryClient.invalidateQueries({ queryKey: ['admin', 'groups'] });
	// A membership change returns the updated group, so patch it in without a round trip.
	const patchGroup = (updated: Group) =>
		queryClient.setQueryData<Group[]>(['admin', 'groups'], (prev) => prev?.map((g) => (g.id === updated.id ? updated : g)));

	const addGroup = async (value: GroupFormValue) => {
		const res = await createNewGroup(token, value).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
		if (res) {
			toast.success('Group created successfully');
			await refetchGroups();
		}
	};

	const updateDefaults = async (value: GroupFormValue) => {
		const res = await updateUserDefaultPermissions(token, value.permissions).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
		if (res) {
			toast.success('Default permissions updated successfully');
			await queryClient.invalidateQueries({ queryKey: ['admin', 'default-permissions'] });
		}
	};

	if (groupsQuery.isPending || defaultsQuery.isPending) {
		return (
			<div className="my-10 flex justify-center">
				<Spinner />
			</div>
		);
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

			<div>
				<div className="bg-background sticky top-0 z-10">
					<div className="flex h-8 w-full flex-1 items-center gap-2">
						<div className="flex min-w-0 flex-1 items-center">
							<Search className="mr-3 ml-1 size-3.5" />
							<input
								className="w-full rounded-r-xl bg-transparent py-1 pr-4 text-sm outline-hidden"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								aria-label="Search Groups"
								placeholder="Search Groups"
							/>
							{query && (
								<button type="button" className="hover:bg-muted rounded-full p-0.5 transition" aria-label="Clear search" onClick={() => setQuery('')}>
									<X className="size-3" strokeWidth={2} />
								</button>
							)}
						</div>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<button
									type="button"
									aria-label="Sort"
									className="text-foreground/80 hover:text-foreground flex h-8 shrink-0 items-center gap-1 rounded-xl bg-transparent px-1.5 py-1.5 text-[0.8125rem] font-normal transition"
								>
									<span className="truncate">{sortLabel}</span>
									<ChevronDown className="size-3.5" strokeWidth={2.5} />
								</button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuRadioGroup value={sortBy} onValueChange={(v) => setSortBy(v as GroupSort)}>
									{sortItems.map((item) => (
										<DropdownMenuRadioItem key={item.value} value={item.value}>
											{item.label}
											{item.value === sortBy && <Check className="ml-auto" />}
										</DropdownMenuRadioItem>
									))}
								</DropdownMenuRadioGroup>
							</DropdownMenuContent>
						</DropdownMenu>
						<Button variant="outline" size="sm" className="ml-1 shrink-0 text-xs" onClick={() => setShowAdd(true)}>
							New Group
						</Button>
					</div>
				</div>

				{filtered.length !== 0 ? (
					<div className="mt-1 grid grid-cols-1">
						{filtered.map((group, idx) => (
							<div key={group.id}>
								<GroupItem
									group={group}
									defaultPermissions={defaultPermissions}
									openOnMount={deepLinkId === group.id}
									onChanged={refetchGroups}
									onGroupUpdate={patchGroup}
								/>
								{idx < filtered.length - 1 && <hr className="border-border/40" />}
							</div>
						))}
					</div>
				) : (
					<div className="flex w-full flex-col items-center justify-center py-16 pb-24">
						<div className="max-w-sm text-center">
							<div className="mb-1.5 text-sm">No groups found</div>
							<div className="text-muted-foreground text-center text-xs leading-5">Use groups to organize your users and assign permissions.</div>
						</div>
					</div>
				)}

				<hr className="border-border/40 my-1" />

				<button type="button" className="group flex w-full cursor-pointer px-2.5 py-2 text-left" aria-haspopup="dialog" onClick={() => setShowDefaults(true)}>
					<div className="flex w-full items-center gap-3">
						<div className="flex min-w-0 flex-1 flex-col gap-0.5 pl-1">
							<div className="text-sm font-normal group-hover:underline">Default permissions</div>
							<div className="text-muted-foreground line-clamp-1 text-xs">applies to all users with the "user" role</div>
						</div>
						<div className="text-muted-foreground group-hover:text-foreground shrink-0 px-1.5 text-xs transition">Edit</div>
					</div>
				</button>
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
