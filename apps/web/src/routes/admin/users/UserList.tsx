import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, MessageSquare, Pencil, Search, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { SortHeaderButton } from '@/components/common/ListChrome';
import { PagePagination } from '@/components/common/PagePagination';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import { deleteUserById, getUsers } from '@/lib/apis/users';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { useAdminStore } from '@/lib/stores/adminStore';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { dayjs } from '@/lib/utils/dates';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';
import { AddUserModal } from './AddUserModal';
import { type AdminUser, EditUserModal } from './EditUserModal';
import { UserChatsModal } from './UserChatsModal';
import { UserPreviewModal } from './UserPreviewModal';

const PER_PAGE = 30;

const roleClass = (role: string) =>
	role === 'admin'
		? 'text-[#4f6f93] dark:text-[#8ba6c6]'
		: role === 'user'
			? 'text-[#4f7a5a] dark:text-[#8db395]'
			: 'text-muted-foreground';

type UserRow = AdminUser & { id: string };

/**
 * Ports admin/Users/UserList.svelte: the paginated, sortable, searchable user
 * table with add / edit / chats / access-preview / delete. Search is debounced
 * 300ms and resets to page 1; the previous page stays on screen while the next
 * loads instead of blanking to a spinner.
 *
 * Not ported: the `ProfilePreview` hover card on the avatar. It renders the
 * channel surface's `UserStatusLinkPreview`, so it arrives with channels
 * (Phase 9); the avatar is a plain image until then.
 */
export function UserList() {
	const token = useAuthStore((s) => s.token) ?? '';
	const config = useConfigStore((s) => s.config);
	const queryClient = useQueryClient();
	const setCount = useAdminStore((s) => s.setCount);

	const [page, setPage] = useState(1);
	const [query, setQuery] = useState('');
	const debouncedQuery = useDebouncedValue(query, 300);
	const [orderBy, setOrderBy] = useState('created_at');
	const [direction, setDirection] = useState<'asc' | 'desc'>('asc');
	const [selected, setSelected] = useState<UserRow | null>(null);
	const [showAdd, setShowAdd] = useState(false);
	const [showEdit, setShowEdit] = useState(false);
	const [showChats, setShowChats] = useState(false);
	const [showPreview, setShowPreview] = useState(false);
	const [showDelete, setShowDelete] = useState(false);

	const list = useQuery({
		queryKey: ['admin', 'users', { query: debouncedQuery, orderBy, direction, page }],
		queryFn: () => getUsers(token, debouncedQuery, orderBy, direction, page) as Promise<{ users: UserRow[]; total: number }>,
		placeholderData: keepPreviousData
	});
	const users = list.data?.users ?? null;
	const total = list.data?.total ?? null;

	useEffect(() => {
		if (list.isError) toast.error(`${list.error}`);
	}, [list.isError, list.error]);
	useEffect(() => {
		if (total !== null) setCount('users', total);
	}, [total, setCount]);

	const refetch = () => queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });

	const deleteUser = async (id: string) => {
		const res = await deleteUserById(token, id).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
		// Deleting the last row of a later page would leave that page empty.
		if (users?.length === 1 && page > 1) setPage(page - 1);
		if (res) refetch();
	};

	const setSortKey = (key: string) => {
		if (orderBy === key) setDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
		else {
			setOrderBy(key);
			setDirection('asc');
		}
	};
	const sortState = (key: string) => (orderBy === key ? (direction === 'asc' ? 'ascending' : 'descending') : 'none');

	const seats = config?.license_metadata?.seats ?? null;
	const iconButton = 'hover:bg-muted w-fit self-center rounded-lg p-1.5';
	const th = 'font-normal select-none';
	const thButton = 'flex w-full items-center gap-1.5 px-2.5 py-1.5';

	return (
		<>
			<ConfirmDialog
				open={showDelete}
				onOpenChange={setShowDelete}
				title="Delete user?"
				confirmLabel="Delete"
				onConfirm={() => {
					if (selected) deleteUser(selected.id);
					setShowDelete(false);
				}}
			>
				This will permanently delete <span className="font-normal">{selected?.name}</span> and their data.
			</ConfirmDialog>
			<AddUserModal open={showAdd} onOpenChange={setShowAdd} onSaved={refetch} />
			<EditUserModal open={showEdit} onOpenChange={setShowEdit} selectedUser={selected} onSaved={refetch} />
			{selected && <UserChatsModal open={showChats} onOpenChange={setShowChats} user={selected} />}
			{selected && <UserPreviewModal open={showPreview} onOpenChange={setShowPreview} userId={selected.id} userName={selected.name} />}

			{seats !== null && total !== null && total > seats && (
				<div role="alert" className="mt-1 mb-2 rounded-lg bg-red-500/15 px-3 py-1.5 text-xs text-red-700 dark:text-red-200">
					<span className="font-medium">License Error</span>{' '}
					Exceeded the number of seats in your license. Please contact support to increase the number of seats.
				</div>
			)}

			{users === null || total === null ? (
				<div className="my-10 flex justify-center">
					<Spinner />
				</div>
			) : (
				<>
					<div className="bg-background sticky top-0 z-10">
						<div className="flex h-8 w-full flex-1 items-center gap-2">
							<div className="flex min-w-0 flex-1 items-center">
								<Search className="mr-3 ml-1 size-3.5" />
								<input
									className="w-full rounded-r-xl bg-transparent py-1 pr-4 text-sm outline-hidden"
									value={query}
									onChange={(e) => {
										setQuery(e.target.value);
										setPage(1);
									}}
									aria-label="Search"
									placeholder="Search"
								/>
								{query && (
									<button
										type="button"
										className="hover:bg-muted rounded-full p-0.5 transition"
										aria-label="Clear search"
										onClick={() => {
											setQuery('');
											setPage(1);
										}}
									>
										<X className="size-3" strokeWidth={2} />
									</button>
								)}
							</div>
							<Button variant="outline" size="sm" className="ml-1 shrink-0 text-xs" onClick={() => setShowAdd(true)}>
								Add User
							</Button>
						</div>
					</div>

					<div className="relative max-w-full overflow-x-auto whitespace-nowrap">
						<table className="text-muted-foreground w-full max-w-full table-auto text-left text-sm">
							<thead className="text-foreground bg-transparent text-xs uppercase">
								<tr className="border-b">
									{(
										[
											['name', 'Name'],
											['role', 'Role'],
											['email', 'Email'],
											['last_active_at', 'Last Active'],
											['created_at', 'Created at']
										] as const
									).map(([key, label]) => (
										<th key={key} scope="col" className={th} aria-sort={sortState(key)}>
											<SortHeaderButton label={label} active={orderBy === key} direction={direction} className={thButton} onClick={() => setSortKey(key)} />
										</th>
									))}
									<th scope="col" className="px-2.5 py-1.5 text-right font-normal" />
								</tr>
							</thead>
							<tbody>
								{users.map((user) => (
									<tr key={user.id} className="text-xs">
										<td className="text-foreground max-w-48 px-3 py-1 font-normal">
											<div className="flex items-center gap-2">
												<img
													className="size-5.5 shrink-0 rounded-full object-cover"
													src={`${WEBUI_API_BASE_URL}/users/${user.id}/profile/image`}
													alt="user"
													onError={(e) => {
														// LICENSE covers this Open WebUI fallback logo.
														// Do not alter, remove, obscure, or replace it except as LICENSE permits:
														// https://docs.openwebui.com/license.
														e.currentTarget.src = '/favicon.png';
													}}
												/>
												<div className="truncate font-normal">{user.name}</div>
												{user.last_active_at && Date.now() / 1000 - user.last_active_at < 180 && (
													<span className="relative flex size-1.5" title="Active now">
														<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
														<span className="relative inline-flex size-1.5 rounded-full bg-green-500" />
													</span>
												)}
											</div>
										</td>
										<td className="w-20 min-w-[5rem] px-3 py-1">
											<button
												type="button"
												className={`text-xs leading-4 font-normal capitalize transition ${roleClass(user.role)}`}
												aria-label="Change User Role"
												onClick={() => {
													setSelected(user);
													setShowEdit(true);
												}}
											>
												{user.role}
											</button>
										</td>
										<td className="max-w-48 truncate px-3 py-1">{user.email}</td>
										<td className="px-3 py-1">{dayjs(user.last_active_at * 1000).fromNow()}</td>
										<td className="px-3 py-1">{dayjs(user.created_at * 1000).format('LL')}</td>
										<td className="px-3 py-1 text-right">
											<div className="flex w-full justify-end">
												{config?.features?.enable_admin_chat_access && user.role !== 'admin' && (
													<Tip content="Chats">
														<button
															type="button"
															className={iconButton}
															aria-label="Chats"
															onClick={() => {
																setSelected(user);
																setShowChats(true);
															}}
														>
															<MessageSquare className="size-3.5" />
														</button>
													</Tip>
												)}
												{user.role !== 'admin' && (
													<Tip content="Preview Access">
														<button
															type="button"
															className={iconButton}
															aria-label="Preview Access"
															onClick={() => {
																setSelected(user);
																setShowPreview(true);
															}}
														>
															<Eye className="size-3.5" />
														</button>
													</Tip>
												)}
												<Tip content="Edit User">
													<button
														type="button"
														className={iconButton}
														aria-label="Edit User"
														onClick={() => {
															setSelected(user);
															setShowEdit(true);
														}}
													>
														<Pencil className="size-3.5" />
													</button>
												</Tip>
												{user.role !== 'admin' && (
													<Tip content="Delete User">
														<button
															type="button"
															className={iconButton}
															aria-label="Delete User"
															onClick={() => {
																setSelected(user);
																setShowDelete(true);
															}}
														>
															<Trash2 className="size-3.5" />
														</button>
													</Tip>
												)}
											</div>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>

					<div className="text-muted-foreground mt-1.5 text-right text-xs">ⓘ Click on the user role button to change a user's role.</div>

					{total > PER_PAGE && <PagePagination page={page} count={total} perPage={PER_PAGE} onPageChange={setPage} />}
				</>
			)}

			{!config?.license_metadata && total !== null && total > 50 && <LargeTeamNotice />}
		</>
	);
}

// LICENSE covers the Open WebUI branding narrative below.
// Do not alter, remove, obscure, or replace it except as LICENSE permits:
// https://docs.openwebui.com/license.
function LargeTeamNotice() {
	return (
		<div className="mt-3 mb-3 pb-1">
			<div className="max-w-3xl text-xs leading-5">
				<div>Running Open WebUI for a team?</div>
				<div className="mt-2 space-y-2">
					<p>
						You have more than 50 users, which often means this workspace is supporting organizational use. Open WebUI is free to use
						as-is, with no restrictions or hidden limits, and we want to keep it that way.
					</p>
					<p className="text-muted-foreground">
						By supporting the project through sponsorship or an enterprise license, you help us stay independent, ship new features
						faster, improve stability, and grow Open WebUI for the long haul.
					</p>
					<p className="text-muted-foreground">
						Enterprise licenses also include dedicated support, customization options, and more, at a fraction of the cost of building
						and maintaining this stack internally.
					</p>
				</div>
				<div className="mt-2 flex items-center gap-3">
					<a className="text-xs underline transition" href="https://docs.openwebui.com/enterprise" target="_blank" rel="noreferrer">
						Enterprise licensing
					</a>
					<a className="text-muted-foreground text-xs underline transition" href="https://github.com/sponsors/open-webui" target="_blank" rel="noreferrer">
						Sponsor on GitHub
					</a>
				</div>
			</div>
		</div>
	);
}
