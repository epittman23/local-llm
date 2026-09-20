import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Download, Search, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { SortHeaderButton } from '@/components/common/ListChrome';
import { PagePagination } from '@/components/common/PagePagination';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { addUserToGroup, removeUserFromGroup } from '@/lib/apis/groups';
import { getUsers } from '@/lib/apis/users';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { useAuthStore } from '@/lib/stores/authStore';
import { dayjs } from '@/lib/utils/dates';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';
import { chunk, parseGroupCsv } from './groupCsv';

type GroupUser = { id: string; name: string; email: string; role: string; last_active_at: number; group_ids?: string[] };
type GroupUpdate = { member_count?: number };

const BATCH_SIZE = 10;
const PER_PAGE = 30;

const roleClass = (role: string) =>
	role === 'admin'
		? 'text-[#4f6f93] dark:text-[#8ba6c6]'
		: role === 'user'
			? 'text-[#4f7a5a] dark:text-[#8db395]'
			: 'text-muted-foreground';

/**
 * Ports admin/Users/Groups/Users.svelte: tick users in or out of a group, with
 * a CSV importer (Name, Email -- matched on email, exactly). Membership changes
 * go to the server one click at a time and the server's answer (the updated
 * group, with its new member_count) is handed up so the parent list stays live.
 */
export function GroupUsers({
	groupId,
	userCount,
	onUserCountChange,
	onMemberChange
}: {
	groupId: string;
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
		queryFn: () => getUsers(token, debouncedQuery, orderBy, direction, page) as Promise<{ users: GroupUser[]; total: number }>,
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

	const toggleMember = async (userId: string, checked: boolean) => {
		const call = checked ? addUserToGroup : removeUserFromGroup;
		const res = await call(token, groupId, [userId]).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
		if (res) {
			onUserCountChange(res.member_count ?? userCount);
			onMemberChange(res);
		}
		await refetch();
	};

	const importCsv = async (file: File) => {
		if (!groupId || importing) return;
		setImporting(true);
		try {
			const { validRows, invalidRows } = parseGroupCsv(await file.text());
			invalidRows.forEach((idx) => toast.error(`Row ${idx + 1}: Invalid format.`));

			// Resolve each email to an exact user, ten lookups at a time.
			const ids: string[] = [];
			for (const batch of chunk(validRows, BATCH_SIZE)) {
				const resolved = await Promise.all(
					batch.map(({ idx, email }) =>
						getUsers(token, email)
							.then((res) => {
								const found = ((res?.users ?? []) as { id?: string; email?: string }[]).find((u) => u.email?.toLowerCase() === email);
								if (found?.id) return found.id;
								toast.error(`Row ${idx + 1}: User not found.`);
								return null;
							})
							.catch((error) => {
								toast.error(`Row ${idx + 1}: ${error}`);
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
					toast.error(`${error}`);
					return null;
				});
				if (!group) continue;
				count = group.member_count ?? count;
				last = group;
			}
			onUserCountChange(count);
			if (last) onMemberChange(last);
			if (count - initialCount > 0) toast.success(`Successfully imported ${count - initialCount} users.`);
			await refetch();
		} catch (error) {
			toast.error(`${error}`);
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
	const th = 'cursor-pointer px-2.5 py-1.5 select-none';
	const thInner = 'flex items-center gap-1.5';

	return (
		<div className="flex h-full max-h-full w-full flex-col overflow-y-hidden">
			<div className="mb-1.5 h-fit w-full">
				<input
					ref={fileInput}
					hidden
					type="file"
					accept=".csv"
					aria-label="Import CSV file"
					disabled={importing}
					onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0])}
				/>
				<div className="flex h-fit flex-1 items-center gap-2">
					<div className="flex min-w-0 flex-1 items-center">
						<Search className="mr-3 size-4 self-center" />
						<input
							className="w-full rounded-r-xl bg-transparent pr-4 text-sm outline-hidden"
							value={query}
							onChange={(e) => {
								setQuery(e.target.value);
								setPage(1);
							}}
							aria-label="Search"
							placeholder="Search"
						/>
					</div>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<button
								type="button"
								className="text-muted-foreground hover:text-foreground ml-1 flex shrink-0 items-center gap-0.5 rounded-lg px-1 py-0.5 text-xs font-normal transition disabled:cursor-not-allowed disabled:opacity-60"
								disabled={importing || !groupId}
								aria-label="Import CSV"
							>
								{importing ? (
									<>
										<Spinner className="size-3" />
										<span className="truncate">Importing...</span>
									</>
								) : (
									<>
										<span className="truncate">Import</span>
										<ChevronDown className="size-2.5" strokeWidth={2.5} />
									</>
								)}
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="min-w-[12rem]">
							<DropdownMenuItem onSelect={() => fileInput.current?.click()}>
								<Upload />
								Import CSV
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={downloadTemplate}>
								<Download />
								Download CSV Template
							</DropdownMenuItem>
							<div className="text-muted-foreground px-2 py-0.5 text-[0.625rem] leading-3">CSV: Name,Email</div>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>

			{users === null || total === null ? (
				<div className="my-10 flex justify-center">
					<Spinner />
				</div>
			) : (
				<>
					{users.length > 0 ? (
						<div className="relative max-w-full overflow-x-auto whitespace-nowrap">
							<table className="text-muted-foreground w-full max-w-full table-auto text-left text-sm">
								<thead className="text-foreground bg-transparent text-xs uppercase">
									<tr className="border-b">
										<th scope="col" className={`${th} w-8`}>
											<SortHeaderButton label="MBR" active={orderBy === `group_id:${groupId}`} direction={direction} className={thInner} onClick={() => setSortKey(`group_id:${groupId}`)} />
										</th>
										{(
											[
												['name', 'Name'],
												['role', 'Role'],
												['last_active_at', 'Last Active']
											] as const
										).map(([key, label]) => (
											<th key={key} scope="col" className={th}>
												<SortHeaderButton label={label} active={orderBy === key} direction={direction} className={thInner} onClick={() => setSortKey(key)} />
											</th>
										))}
									</tr>
								</thead>
								<tbody>
									{users.map((user) => (
										<tr key={user.id} className="text-xs">
											<td className="w-8 px-3 py-1">
												<div className="flex w-full justify-center">
													<Checkbox
														aria-label={user.name}
														checked={(user.group_ids ?? []).includes(groupId)}
														onCheckedChange={(checked) => toggleMember(user.id, checked === true)}
													/>
												</div>
											</td>
											<td className="text-foreground max-w-48 px-3 py-1 font-normal">
												<Tip content={user.email} side="top">
													<div className="flex items-center gap-2">
														<img className="size-6 shrink-0 rounded-full object-cover" src={`${WEBUI_API_BASE_URL}/users/${user.id}/profile/image`} alt="user" />
														<div className="truncate font-normal">{user.name}</div>
													</div>
												</Tip>
											</td>
											<td className="w-20 min-w-[5rem] px-3 py-1">
												<span className={`text-xs leading-4 font-normal capitalize ${roleClass(user.role)}`}>{user.role}</span>
											</td>
											<td className="px-3 py-1">{dayjs(user.last_active_at * 1000).fromNow()}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					) : (
						<div className="text-muted-foreground px-10 py-2 text-center text-xs">No users were found.</div>
					)}
					{total > PER_PAGE && <PagePagination page={page} count={total} perPage={PER_PAGE} onPageChange={setPage} />}
				</>
			)}
		</div>
	);
}
