import { Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { getGroups } from '@/lib/apis/groups';
import { getUserInfoById, searchUsers } from '@/lib/apis/users';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { useAuthStore } from '@/lib/stores/authStore';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';

type Grantish = { principal_type: string; principal_id: string };
type GroupRow = { id: string; name: string; member_count?: number };
type UserRow = { id: string; name: string; email?: string; is_active?: boolean };

/**
 * Ports workspace/common/MemberSelector.svelte: search users and groups, tick
 * the ones to add, with the picks summarised as removable chips above the
 * list. Anyone already holding a grant is filtered out, so the list is "who
 * could still be added". Like the original it shows the first page of search
 * results only (its `pagination` prop is never set and its template renders no
 * pager) -- a search narrows it, there is no page two.
 */
export function MemberSelector({
	includeGroups = true,
	includeUsers = true,
	includeSessionUser = false,
	accessGrants,
	userIds,
	groupIds,
	onUserIdsChange,
	onGroupIdsChange
}: {
	includeGroups?: boolean;
	includeUsers?: boolean;
	includeSessionUser?: boolean;
	accessGrants: Grantish[];
	userIds: string[];
	groupIds: string[];
	onUserIdsChange: (ids: string[]) => void;
	onGroupIdsChange: (ids: string[]) => void;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const sessionUserId = useAuthStore((s) => s.user?.id);
	const [query, setQuery] = useState('');
	const debouncedQuery = useDebouncedValue(query, 300);
	const [groups, setGroups] = useState<GroupRow[] | null>(null);
	const [users, setUsers] = useState<UserRow[] | null>(null);
	// Chips need the picked principal's name, which the id alone doesn't carry.
	// Remembered as rows are ticked, so a pick survives the search box changing.
	const [pickedGroups, setPickedGroups] = useState<Record<string, GroupRow>>({});
	const [pickedUsers, setPickedUsers] = useState<Record<string, UserRow>>({});

	useEffect(() => {
		let cancelled = false;
		getGroups(token, true)
			.catch((error) => {
				console.error(error);
				return [];
			})
			.then((res) => !cancelled && setGroups(res ?? []));
		return () => {
			cancelled = true;
		};
	}, [token]);

	// Resolve names for ids handed in already selected (none, from AddAccessModal,
	// which always starts empty -- kept because the Svelte component does it).
	useEffect(() => {
		for (const id of userIds) {
			if (pickedUsers[id]) continue;
			getUserInfoById(token, id)
				.then((res) => res && setPickedUsers((prev) => ({ ...prev, [id]: res })))
				.catch((error) => console.error(error));
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		let cancelled = false;
		searchUsers(token, debouncedQuery, 'name', 'asc', 1)
			.then((res) => !cancelled && res && setUsers(res.users ?? []))
			.catch((error) => {
				toast.error(`${error}`);
				if (!cancelled) setUsers((prev) => prev ?? []);
			});
		return () => {
			cancelled = true;
		};
	}, [token, debouncedQuery]);

	const hasGrant = (type: string, id: string) =>
		accessGrants.some((g) => g.principal_type === type && g.principal_id === id);

	const filteredGroups = useMemo(
		() =>
			(groups ?? []).filter(
				(g) => g.name.toLowerCase().includes(query.toLowerCase()) && !hasGrant('group', g.id)
			),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[groups, query, accessGrants]
	);
	const filteredUsers = useMemo(
		() =>
			(users ?? []).filter(
				(u) => !hasGrant('user', u.id) && (includeSessionUser || u.id !== sessionUserId)
			),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[users, accessGrants, includeSessionUser, sessionUserId]
	);

	if (users === null || groups === null) {
		return (
			<div className="my-10 flex justify-center">
				<Spinner />
			</div>
		);
	}

	const toggleGroup = (group: GroupRow) => {
		if (groupIds.includes(group.id)) {
			onGroupIdsChange(groupIds.filter((id) => id !== group.id));
		} else {
			onGroupIdsChange([...groupIds, group.id]);
			setPickedGroups((prev) => ({ ...prev, [group.id]: group }));
		}
	};
	const toggleUser = (user: UserRow) => {
		if (userIds.includes(user.id)) {
			onUserIdsChange(userIds.filter((id) => id !== user.id));
		} else {
			onUserIdsChange([...userIds, user.id]);
			setPickedUsers((prev) => ({ ...prev, [user.id]: user }));
		}
	};

	const chip = (key: string, label: string, extra: string | undefined, onRemove: () => void) => (
		<button
			key={key}
			type="button"
			className="bg-muted inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs"
			onClick={onRemove}
		>
			<span>
				{label} {extra && <span className="text-muted-foreground">{extra}</span>}
			</span>
			<X className="size-3" />
		</button>
	);

	const nothingToShow = filteredUsers.length === 0 && filteredGroups.length === 0;

	return (
		<div>
			{groupIds.length > 0 && (
				<div className="mx-1 mb-1.5">
					<div className="text-muted-foreground mx-0.5 mb-1 text-xs">{groupIds.length} groups</div>
					<div className="flex flex-wrap gap-1">
						{groupIds.map(
							(id) =>
								pickedGroups[id] &&
								chip(id, pickedGroups[id].name, String(pickedGroups[id].member_count ?? ''), () =>
									onGroupIdsChange(groupIds.filter((gid) => gid !== id))
								)
						)}
					</div>
				</div>
			)}
			{userIds.length > 0 && (
				<div className="mx-1 mb-1.5">
					<div className="text-muted-foreground mx-0.5 mb-1 text-xs">{userIds.length} users</div>
					<div className="flex flex-wrap gap-1">
						{userIds.map(
							(id) =>
								pickedUsers[id] &&
								chip(id, pickedUsers[id].name, undefined, () =>
									onUserIdsChange(userIds.filter((uid) => uid !== id))
								)
						)}
					</div>
				</div>
			)}

			<div className="relative mb-1 flex items-center">
				<Search className="text-muted-foreground absolute left-2 size-4" />
				<Input
					className="pl-8"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Search"
					aria-label="Search"
				/>
			</div>

			{nothingToShow ? (
				<div className="text-muted-foreground px-10 py-5 text-center text-xs">No users were found.</div>
			) : (
				<div className="max-h-96 w-full overflow-y-auto rounded-lg">
					{includeGroups && filteredGroups.length > 0 && (
						<>
							<div className="text-muted-foreground mx-1 mb-1 text-xs">Groups</div>
							<div className="mb-3">
								{filteredGroups.map((group) => (
									<button
										key={group.id}
										type="button"
										className="flex w-full items-center justify-between text-xs"
										onClick={() => toggleGroup(group)}
									>
										<span className="flex flex-1 items-center gap-1 px-3 py-1.5 font-normal">
											<span className="truncate">{group.name}</span>
											<span className="text-muted-foreground">{group.member_count}</span>
										</span>
										<span className="px-3 py-1">
											<Checkbox checked={groupIds.includes(group.id)} tabIndex={-1} aria-label={group.name} />
										</span>
									</button>
								))}
							</div>
						</>
					)}
					{includeUsers && filteredUsers.length > 0 && (
						<>
							<div className="text-muted-foreground mx-1 mb-1 text-xs">Users</div>
							<div>
								{filteredUsers.map((user) => (
									<button
										key={user.id}
										type="button"
										className="flex w-full items-center justify-between text-xs"
										onClick={() => toggleUser(user)}
									>
										<span className="flex flex-1 items-center gap-2 px-3 py-1.5 font-normal">
											<img
												className="size-6 shrink-0 rounded-2xl object-cover"
												src={`${WEBUI_API_BASE_URL}/users/${user.id}/profile/image`}
												alt=""
											/>
											<Tip content={user.email} side="top">
												<span className="truncate">{user.name}</span>
											</Tip>
											{user.is_active && (
												<span className="relative flex size-1.5">
													<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
													<span className="relative inline-flex size-1.5 rounded-full bg-green-500" />
												</span>
											)}
										</span>
										<span className="px-3 py-1">
											<Checkbox checked={userIds.includes(user.id)} tabIndex={-1} aria-label={user.name} />
										</span>
									</button>
								))}
							</div>
						</>
					)}
				</div>
			)}
		</div>
	);
}
