import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Download, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { toastFailure } from '@/components/common/failureToast';
import { ListEmptyState, ListSearchBar } from '@/components/common/ListChrome';
import { LoadFailed } from '@/components/common/LoadFailed';
import { PagePagination } from '@/components/common/PagePagination';
import { Spinner } from '@/components/common/Spinner';
import { TableSkeleton } from '@/components/common/TableSkeleton';
import { ProfileAvatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Table, TableSortHead } from '@/components/ui/table';
import { addUserToGroup, removeUserFromGroup } from '@/lib/apis/groups';
import { getUsers } from '@/lib/apis/users';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { useAuthStore } from '@/lib/stores/authStore';
import { cn } from '@/lib/utils';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';
import { chunk, parseGroupCsv } from './groupCsv';
import { lastActive } from './UserList';

type GroupUser = {
	id: string;
	name: string;
	email: string;
	role: string;
	last_active_at: number;
	group_ids?: string[];
};
type GroupUpdate = { member_count?: number };

const BATCH_SIZE = 10;
const PER_PAGE = 30;

const ROLE_NAMES: Record<string, string> = { admin: 'Admin', user: 'User', pending: 'Pending' };

/**
 * Ports admin/Users/Groups/Users.svelte: tick users in or out of a group, with
 * a CSV importer (Name, Email -- matched on email, exactly). Membership changes
 * go to the server one click at a time and the server's answer (the updated
 * group, with its new member_count) is handed up so the parent list stays live.
 *
 * #1099: the shared table and search, "Member" for the tick column, Import
 * named by its text (#987), "Never" for an account never active, and removing
 * someone says so above the table, with Undo (ACT-3).
 */
export function GroupUsers({
	groupId,
	groupName,
	userCount,
	onUserCountChange,
	onMemberChange
}: {
	groupId: string;
	groupName: string;
	userCount: number;
	onUserCountChange: (count: number) => void;
	onMemberChange: (group: GroupUpdate & { id?: string }) => void;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	const fileInput = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState('');
	const debouncedQuery = useDebouncedValue(query, 300);
	const [orderBy, setOrderBy] = useState(groupId ? `group_id:${groupId}` : 'last_active_at');
	const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
	const [page, setPage] = useState(1);
	const [importing, setImporting] = useState(false);

	const listKey = ['admin', 'group-users', groupId, { query: debouncedQuery, orderBy, direction, page }];
	const list = useQuery({
		queryKey: listKey,
		queryFn: () =>
			getUsers(token, debouncedQuery, orderBy, direction, page) as Promise<{ users: GroupUser[]; total: number }>,
		placeholderData: keepPreviousData
	});
	const refetch = () => queryClient.invalidateQueries({ queryKey: ['admin', 'group-users', groupId] });

	const setSortKey = (key: string) => {
		if (orderBy === key) setDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
		else {
			setOrderBy(key);
			setDirection('asc');
		}
		setPage(1);
	};

	const [removed, setRemoved] = useState<GroupUser | null>(null);
	const toggleMember = async (user: GroupUser, checked: boolean, undo = false) => {
		const call = checked ? addUserToGroup : removeUserFromGroup;
		const res = await call(token, groupId, [user.id]).catch((error) => {
			toastFailure(
				checked ? `Couldn't add “${user.name}” to ${groupName}.` : `Couldn't remove “${user.name}” from ${groupName}.`,
				error
			);
			return null;
		});
		if (res) {
			onUserCountChange(res.member_count ?? userCount);
			onMemberChange(res);
			// Said in the panel, not a toast: a toast sits under the dialog's overlay, so its Undo can't be pressed.
			setRemoved(!checked && !undo ? user : null);
		}
		await refetch();
	};

	const importCsv = async (file: File) => {
		if (!groupId || importing) return;
		setImporting(true);
		try {
			const { validRows, invalidRows } = parseGroupCsv(await file.text());
			invalidRows.forEach((idx) => toast.error(`Row ${idx + 1}: not a name and an email.`));

			// Resolve each email to an exact user, ten lookups at a time.
			const ids: string[] = [];
			for (const batch of chunk(validRows, BATCH_SIZE)) {
				const resolved = await Promise.all(
					batch.map(({ idx, email }) =>
						getUsers(token, email)
							.then((res) => {
								const found = ((res?.users ?? []) as { id?: string; email?: string }[]).find(
									(u) => u.email?.toLowerCase() === email
								);
								if (found?.id) return found.id;
								toast.error(`Row ${idx + 1}: no account with ${email}.`);
								return null;
							})
							.catch((error) => {
								toastFailure(`Row ${idx + 1}: couldn't look up ${email}.`, error);
								return null;
							})
					)
				);
				ids.push(...resolved.filter((id): id is string => id !== null));
			}

			// Added one by one, so each server answer can update the running count.
			const initialCount = userCount;
			let count = userCount;
			let last: GroupUpdate | null = null;
			for (const id of new Set(ids)) {
				const group = await addUserToGroup(token, groupId, [id]).catch((error) => {
					toastFailure(`Couldn't add an account to ${groupName}.`, error);
					return null;
				});
				if (!group) continue;
				count = group.member_count ?? count;
				last = group;
			}
			onUserCountChange(count);
			if (last) onMemberChange(last);
			const added = count - initialCount;
			if (added > 0) toast.success(added === 1 ? 'Added 1 member' : `Added ${added} members`);
			await refetch();
		} catch (error) {
			toastFailure(`Couldn't import ${file.name}.`, error);
		} finally {
			if (fileInput.current) fileInput.current.value = '';
			setImporting(false);
		}
	};

	const downloadTemplate = () => {
		const url = URL.createObjectURL(new Blob(['Name,Email\n'], { type: 'text/csv;charset=utf-8' }));
		const a = document.createElement('a');
		a.href = url;
		a.download = 'group-import.csv';
		a.click();
		URL.revokeObjectURL(url);
	};

	const users = list.data?.users ?? null;
	const total = list.data?.total ?? null;
	const columns = [
		{ key: `group_id:${groupId}`, label: 'Member', className: 'w-24' },
		{ key: 'name', label: 'Name', className: '' },
		{ key: 'role', label: 'Role', className: 'w-24 max-sm:hidden' },
		{ key: 'last_active_at', label: 'Last active', className: 'w-32 max-sm:hidden' }
	];

	return (
		<div className="flex w-full flex-col gap-2">
			<input
				ref={fileInput}
				hidden
				type="file"
				accept=".csv"
				aria-label="CSV file of members"
				disabled={importing}
				onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0])}
			/>
			<ListSearchBar
				value={query}
				onChange={(value) => {
					setQuery(value);
					setPage(1);
				}}
				placeholder="Search users"
			>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="outline" type="button" disabled={importing || !groupId}>
							{importing ? <Spinner className="size-3.5" /> : <Upload aria-hidden data-icon="inline-start" />}
							{importing ? 'Importing…' : 'Import CSV'}
							<ChevronDown aria-hidden data-icon="inline-end" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuLabel className="text-foreground-muted font-normal">
							Two columns: name, email
						</DropdownMenuLabel>
						<DropdownMenuItem onSelect={() => fileInput.current?.click()}>
							<Upload />
							Choose CSV file
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={downloadTemplate}>
							<Download />
							Download template
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</ListSearchBar>

			{removed && (
				<div
					role="status"
					className="bg-surface-2 flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-1.5"
				>
					<span className="min-w-0">
						Removed “{removed.name}” from {groupName}
					</span>
					<Button variant="outline" size="sm" type="button" onClick={() => toggleMember(removed, true, true)}>
						Undo
					</Button>
				</div>
			)}

			{list.isError && !list.data ? (
				<LoadFailed what="users" error={list.error} onRetry={() => list.refetch()} retrying={list.isFetching} />
			) : users === null || total === null ? (
				<TableSkeleton label="users" />
			) : users.length === 0 ? (
				<ListEmptyState
					title="No users yet"
					query={debouncedQuery}
					onClear={() => {
						setQuery('');
						setPage(1);
					}}
				/>
			) : (
				<>
					<Table aria-label={`Members of ${groupName}`} className="text-dense table-fixed text-left">
						<thead>
							<tr className="border-b">
								{columns.map(({ key, label, className }) => (
									<TableSortHead
										key={key}
										label={label}
										active={orderBy === key}
										direction={direction}
										onSort={() => setSortKey(key)}
										className={cn('h-auto py-1 font-normal', className)}
										buttonClassName="text-foreground-muted"
									/>
								))}
							</tr>
						</thead>
						<tbody>
							{users.map((user) => (
								<tr key={user.id} className="border-b last:border-0">
									<td className="px-2 py-1.5">
										<Checkbox
											aria-label={user.name}
											checked={(user.group_ids ?? []).includes(groupId)}
											onCheckedChange={(checked) => toggleMember(user, checked === true)}
										/>
									</td>
									<td className="px-2 py-1.5">
										<div className="flex min-w-0 items-center gap-2">
											<ProfileAvatar
												src={`${WEBUI_API_BASE_URL}/users/${user.id}/profile/image`}
												name={user.name}
												size="sm"
											/>
											<div className="flex min-w-0 flex-col">
												<span className="text-foreground font-strong truncate" title={user.name}>
													{user.name}
												</span>
												<span className="text-foreground-muted text-caption truncate" title={user.email}>
													{user.email}
												</span>
											</div>
										</div>
									</td>
									<td className="text-foreground-muted px-2 py-1.5 max-sm:hidden">
										{ROLE_NAMES[user.role] ?? user.role}
									</td>
									<td className="text-foreground-muted px-2 py-1.5 max-sm:hidden">{lastActive(user.last_active_at)}</td>
								</tr>
							))}
						</tbody>
					</Table>
					{total > PER_PAGE && <PagePagination page={page} count={total} perPage={PER_PAGE} onPageChange={setPage} />}
				</>
			)}
		</div>
	);
}
