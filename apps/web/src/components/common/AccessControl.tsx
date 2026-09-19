import { Globe, Lock, Plus, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AddAccessModal } from '@/components/common/AddAccessModal';
import { Tip } from '@/components/common/Tip';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { getGroupInfoById, getGroups } from '@/lib/apis/groups';
import { getUserInfoById } from '@/lib/apis/users';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import {
	type AccessGrant,
	type Permission,
	type Principal,
	type Visibility,
	addAccess,
	getVisibility,
	hasAnyoneReadGrant,
	hasPublicReadGrant,
	hasPublicWriteGrant,
	normalizeInputToGrants,
	principalIdsByPermission,
	removePrincipal,
	setVisibility,
	togglePrincipalWrite,
	togglePublicWrite
} from '@/lib/access/accessGrants';
import { useAuthStore } from '@/lib/stores/authStore';

type Group = { id: string; name: string; member_count?: number };
type UserInfo = { id: string; name: string; email?: string };

const nativeSelectClass =
	'bg-transparent text-sm outline-none [&>option]:bg-popover [&>option]:text-popover-foreground';

/**
 * Ports workspace/common/AccessControl.svelte: the visibility picker
 * (private / public / open), the "allow public write" switch, and the list of
 * named users and groups with a read/write picker each. Controlled -- the
 * grant list lives in the parent (`accessGrants`) and every edit goes back
 * through `onChange`, computed by the pure functions in lib/access.
 *
 * The Svelte version normalises `accessGrants` in place from a reactive block
 * (a null or legacy-shaped value is rewritten into a grants array under the
 * parent's feet). Here the value is normalised on read instead, which shows the
 * same list without mutating anything the parent didn't ask to change.
 */
export function AccessControl({
	accessGrants: rawGrants,
	onChange,
	accessRoles = ['read'],
	share = true,
	sharePublic = true,
	shareOpen = false,
	shareUsers = true,
	allowGroups = true,
	defaultPermission = 'read'
}: {
	accessGrants: AccessGrant[] | null | undefined;
	onChange: (grants: AccessGrant[]) => void;
	accessRoles?: Permission[] | string[];
	share?: boolean;
	sharePublic?: boolean;
	shareOpen?: boolean;
	shareUsers?: boolean;
	allowGroups?: boolean;
	defaultPermission?: Permission;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const grants = useMemo(() => normalizeInputToGrants(rawGrants ?? []), [rawGrants]);
	const [groups, setGroups] = useState<Group[]>([]);
	const [userById, setUserById] = useState<Record<string, UserInfo>>({});
	const [showAdd, setShowAdd] = useState(false);

	const readGroupIds = principalIdsByPermission(grants, 'group', 'read');
	const writeGroupIds = principalIdsByPermission(grants, 'group', 'write');
	const readUserIds = principalIdsByPermission(grants, 'user', 'read').filter((id) => id !== '*');
	const writeUserIds = principalIdsByPermission(grants, 'user', 'write').filter((id) => id !== '*');
	const selectedUserIds = Array.from(new Set([...readUserIds, ...writeUserIds]));
	const grantedGroupIds = Array.from(new Set([...readGroupIds, ...writeGroupIds]));

	useEffect(() => {
		let cancelled = false;
		getGroups(token, true)
			.catch((error) => {
				console.error(error);
				return [];
			})
			.then((res) => {
				if (cancelled) return;
				setGroups((prev) => dedupeById([...prev, ...(res ?? [])]));
			});
		return () => {
			cancelled = true;
		};
	}, [token]);

	// A group the list call didn't return (e.g. one this user can see a grant
	// for but not share to) is looked up by id, as `ensureGroupsByIds` does.
	useEffect(() => {
		const missing = grantedGroupIds.filter((id) => !groups.some((g) => g.id === id));
		if (missing.length === 0) return;
		let cancelled = false;
		Promise.all(
			missing.map((id) =>
				getGroupInfoById(token, id).catch((error) => {
					console.error(error);
					return null;
				})
			)
		).then((found) => {
			if (cancelled) return;
			const rows = found.filter(Boolean) as Group[];
			if (rows.length) setGroups((prev) => dedupeById([...prev, ...rows]));
		});
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [grantedGroupIds.join(','), groups.length, token]);

	useEffect(() => {
		const missing = selectedUserIds.filter((id) => !userById[id]);
		if (missing.length === 0) return;
		let cancelled = false;
		Promise.all(
			missing.map(async (id) => ({
				id,
				user: await getUserInfoById(token, id).catch((error) => {
					console.error(error);
					return null;
				})
			}))
		).then((fetched) => {
			if (cancelled) return;
			setUserById((prev) => {
				const next = { ...prev };
				for (const { id, user } of fetched) if (user?.id) next[id] = user;
				return next;
			});
		});
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selectedUserIds.join(','), token]);

	const visibility = getVisibility(grants);
	const canWrite = accessRoles.includes('write');
	const selectedUsers = selectedUserIds
		.map((id) => userById[id] ?? { id, name: id, email: '' })
		.sort((a, b) => a.name.localeCompare(b.name));
	const accessGroups = groups
		.filter((g) => grantedGroupIds.includes(g.id))
		.sort((a, b) => a.name.localeCompare(b.name));

	const accessLevelPicker = (type: Principal, id: string, isWrite: boolean) =>
		canWrite ? (
			<select
				aria-label="Access level"
				className={nativeSelectClass}
				value={isWrite ? 'write' : 'read'}
				onChange={(e) => {
					if ((e.target.value === 'write') !== isWrite) onChange(togglePrincipalWrite(grants, type, id));
				}}
			>
				<option value="read">Read</option>
				<option value="write">Write</option>
			</select>
		) : (
			<Badge variant="secondary">Read</Badge>
		);

	const removeButton = (type: Principal, id: string, label: string) => (
		<button
			type="button"
			aria-label={`Remove ${label}`}
			className="hover:bg-muted rounded-full p-1 transition"
			onClick={() => onChange(removePrincipal(grants, type, id))}
		>
			<X className="size-4" />
		</button>
	);

	const visibilityBlocked = !(share && sharePublic) && visibility === 'private';

	return (
		<div className="flex flex-col gap-1 rounded-lg">
			<AddAccessModal
				open={showAdd}
				onOpenChange={setShowAdd}
				shareUsers={shareUsers}
				allowGroups={allowGroups}
				accessGrants={grants}
				onAdd={(picked) => onChange(addAccess(grants, picked, defaultPermission))}
			/>

			<div className="py-1.5">
				<div className="flex items-center gap-2">
					<div className="bg-muted rounded-full p-2">
						{visibility === 'private' ? <Lock className="size-5" /> : <Globe className="size-5" />}
					</div>
					<div>
						<Tip content={visibilityBlocked ? 'You do not have permission to make this public' : ''}>
							<select
								aria-label="Visibility"
								className={`${nativeSelectClass} block w-fit max-w-full pr-8`}
								value={visibility}
								onChange={(e) => onChange(setVisibility(grants, e.target.value as Visibility))}
							>
								<option value="private">Private</option>
								{((share && sharePublic) || hasPublicReadGrant(grants)) && (
									<option value="public">Public</option>
								)}
								{((share && shareOpen) || hasAnyoneReadGrant(grants)) && (
									<option value="open">Open</option>
								)}
							</select>
						</Tip>
						<div className="text-muted-foreground text-xs">
							{visibility === 'private'
								? 'Only select users and groups with permission can access'
								: visibility === 'public'
									? 'Accessible to all users'
									: 'Anyone with the link can view'}
						</div>
					</div>
				</div>

				{hasPublicReadGrant(grants) && !hasAnyoneReadGrant(grants) && canWrite && (
					<div className="mt-1.5 ml-0.5 flex w-full items-center justify-between">
						<span className="text-xs">Allow public write access</span>
						<Switch
							aria-label="Allow public write access"
							checked={hasPublicWriteGrant(grants)}
							onCheckedChange={() => onChange(togglePublicWrite(grants))}
						/>
					</div>
				)}
			</div>

			{share && (
				<>
					<div className="text-muted-foreground my-0.5 flex items-center justify-between text-xs">
						<span>Access List</span>
						<button
							type="button"
							className="hover:bg-muted flex items-center gap-1 rounded-lg px-2 py-1 text-xs transition"
							onClick={() => setShowAdd(true)}
						>
							<Plus className="size-3" />
							Add Access
						</button>
					</div>

					<div className="flex flex-col gap-1">
						{accessGroups.map((group) => (
							<div key={group.id} className="flex w-full items-center justify-between gap-2 pb-1 text-sm">
								<div className="flex min-w-0 flex-1 items-center gap-2">
									<div className="bg-muted flex size-5 items-center justify-center rounded-full text-xs">
										{group.name.charAt(0).toUpperCase()}
									</div>
									<div className="flex items-center gap-2 truncate">
										{group.name}
										<span className="text-muted-foreground text-xs">{group.member_count} members</span>
									</div>
								</div>
								<div className="flex shrink-0 items-center justify-end gap-1.5">
									{accessLevelPicker('group', group.id, writeGroupIds.includes(group.id))}
									{removeButton('group', group.id, group.name)}
								</div>
							</div>
						))}

						{shareUsers &&
							selectedUsers.map((user) => (
								<div
									key={user.id}
									className="flex w-full items-center justify-between gap-2 border-b pb-1.5 text-sm last:border-0"
								>
									<div className="flex min-w-0 flex-1 items-center gap-2">
										<img
											className="size-5 rounded-full object-cover"
											src={`${WEBUI_API_BASE_URL}/users/${user.id}/profile/image`}
											alt={user.name ?? user.id}
										/>
										<Tip content={user.email} side="top">
											<div className="truncate text-sm">{user.name ?? user.id}</div>
										</Tip>
									</div>
									<div className="flex shrink-0 items-center justify-end gap-1.5">
										{accessLevelPicker('user', user.id, writeUserIds.includes(user.id))}
										{removeButton('user', user.id, user.name ?? user.id)}
									</div>
								</div>
							))}

						{visibility === 'private' && accessGroups.length === 0 && selectedUsers.length === 0 && (
							<div className="text-muted-foreground py-3 text-center text-xs">
								No access grants. Private to you.
							</div>
						)}
					</div>
				</>
			)}
		</div>
	);
}

function dedupeById<T extends { id: string }>(rows: T[]): T[] {
	return rows.filter((row, index) => index === rows.findIndex((r) => r.id === row.id));
}
