import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Eye, MessageSquare, MoreHorizontal, Pencil, Trash2, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { toastFailure } from '@/components/common/failureToast';
import { ListEmptyState, ListSearchBar } from '@/components/common/ListChrome';
import { LoadFailed } from '@/components/common/LoadFailed';
import { PagePagination } from '@/components/common/PagePagination';
import { Tip } from '@/components/common/Tip';
import { ProfileAvatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Table, TableSortHead } from '@/components/ui/table';
import { deleteUserById, getUsers, updateUserById } from '@/lib/apis/users';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { useAdminStore } from '@/lib/stores/adminStore';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { cn } from '@/lib/utils';
import { dayjs } from '@/lib/utils/dates';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';
import { TableSkeleton } from '../TableSkeleton';
import { AddUserModal } from './AddUserModal';
import { type AdminUser, EditUserModal } from './EditUserModal';
import { UserChatsModal } from './UserChatsModal';
import { UserPreviewModal } from './UserPreviewModal';

const PER_PAGE = 30;

type UserRow = AdminUser & { id: string };

export const ROLES = [
	{ value: 'admin', label: 'Admin', noun: 'an admin' },
	{ value: 'user', label: 'User', noun: 'a user' },
	{ value: 'pending', label: 'Pending', noun: 'pending' }
] as const;
const roleLabel = (role: string) => ROLES.find((r) => r.value === role)?.label ?? role;

/** "Never" for an account that has not been active, not "57 years ago" from a null time (#1026). */
export function lastActive(at: number | null | undefined): string {
	return at ? dayjs(at * 1000).fromNow() : 'Never';
}

/** The columns a phone leaves out: the dates, and role and email, which move under the name (DAT-6). */
const COLUMNS = [
	{ key: 'name', label: 'Name', className: '' },
	{ key: 'role', label: 'Role', className: 'hidden w-32 sm:table-cell' },
	{ key: 'email', label: 'Email', className: 'hidden w-[30%] sm:table-cell' },
	{ key: 'last_active_at', label: 'Last active', className: 'hidden w-32 md:table-cell' },
	{ key: 'created_at', label: 'Created', className: 'hidden w-36 md:table-cell' }
] as const;

/**
 * A user's role, and the menu that changes it (#1026): Admin, User or
 * Pending, applied at once and confirmed in a toast. Your own role is shown
 * but not a control, as in Edit user: an admin cannot demote themselves.
 */
function RoleControl({
	user,
	own,
	onChange
}: {
	user: UserRow;
	own: boolean;
	onChange: (user: UserRow, role: string) => void;
}) {
	if (own) return <Badge variant="secondary">{roleLabel(user.role)}</Badge>;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="secondary" size="xs" type="button" className="rounded-full">
					<span className="sr-only">Role: </span>
					{roleLabel(user.role)}
					<ChevronDown aria-hidden data-icon="inline-end" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start">
				<DropdownMenuRadioGroup value={user.role} onValueChange={(role) => onChange(user, role)}>
					{ROLES.map((r) => (
						<DropdownMenuRadioItem key={r.value} value={r.value}>
							{r.label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * Ports admin/Users/UserList.svelte: the paginated, sortable, searchable user
 * table with add / edit / chats / access-preview / delete. Search is debounced
 * 300ms and resets to page 1; the previous page stays on screen while the next
 * loads instead of blanking.
 *
 * #1026: names and emails truncate with the whole text in their title; the
 * role is a menu of its own (not the whole Edit dialog); Edit stays on the
 * row and the rest sit in a labelled "More actions" menu, Delete last. On a
 * phone a row is two lines, the name with its role, the email below.
 *
 * Not ported: the `ProfilePreview` hover card on the avatar. It renders the
 * channel surface's `UserStatusLinkPreview`, so it arrives with channels
 * (Phase 9); the avatar is a plain image until then.
 */
export function UserList() {
	const token = useAuthStore((s) => s.token) ?? '';
	const sessionUserId = useAuthStore((s) => s.user?.id);
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
		queryFn: () =>
			getUsers(token, debouncedQuery, orderBy, direction, page) as Promise<{ users: UserRow[]; total: number }>,
		placeholderData: keepPreviousData
	});
	const users = list.data?.users ?? null;
	const total = list.data?.total ?? null;

	const failed = list.isError || (list.isPaused && list.data === undefined);
	useEffect(() => {
		// The tab keeps the whole count while a search narrows the list (DAT-2).
		if (total !== null && debouncedQuery === '') setCount('users', total);
	}, [total, debouncedQuery, setCount]);

	const refetch = () => queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
	// Adding, importing or deleting a user changes how many accounts there are: the
	// workspace's owners, View and Access (useSingleUser) and sharing read that count.
	const accountsChanged = () => {
		refetch();
		queryClient.invalidateQueries({ queryKey: ['account-count'] });
	};

	const deleteUser = async (user: UserRow) => {
		const res = await deleteUserById(token, user.id).catch((error) => {
			toastFailure(`Couldn't delete “${user.name}”.`, error);
			return null;
		});
		if (!res) return;
		toast.success(`Deleted “${user.name}”`);
		// Deleting the last row of a later page would leave that page empty.
		if (users?.length === 1 && page > 1) setPage(page - 1);
		accountsChanged();
	};

	const changeRole = async (user: UserRow, role: string) => {
		if (role === user.role) return;
		const res = await updateUserById(token, user.id, {
			role,
			name: user.name,
			email: user.email,
			profile_image_url: user.profile_image_url,
			password: ''
		}).catch((error) => {
			toastFailure(`Couldn't change the role of “${user.name}”.`, error);
			return null;
		});
		if (!res) return;
		toast.success(`“${user.name}” is now ${ROLES.find((r) => r.value === role)?.noun ?? role}`);
		refetch();
	};

	const setSortKey = (key: string) => {
		if (orderBy === key) setDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
		else {
			setOrderBy(key);
			setDirection('asc');
		}
	};
	const act = (user: UserRow, show: (open: boolean) => void) => {
		setSelected(user);
		show(true);
	};

	return (
		<>
			<ConfirmDialog
				open={showDelete}
				onOpenChange={setShowDelete}
				title={`Delete “${selected?.name ?? ''}”?`}
				confirmLabel="Delete user"
				destructive
				onConfirm={() => {
					if (selected) deleteUser(selected);
					setShowDelete(false);
				}}
			>
				Their account, chats, files, notes and memories are deleted. Models, knowledge bases and other things they made
				pass to you. This can't be undone.
			</ConfirmDialog>
			<AddUserModal open={showAdd} onOpenChange={setShowAdd} onSaved={accountsChanged} />
			<EditUserModal open={showEdit} onOpenChange={setShowEdit} selectedUser={selected} onSaved={refetch} />
			{selected && <UserChatsModal open={showChats} onOpenChange={setShowChats} user={selected} />}
			{selected && (
				<UserPreviewModal
					open={showPreview}
					onOpenChange={setShowPreview}
					userId={selected.id}
					userName={selected.name}
				/>
			)}

			<div className="flex flex-col gap-2">
				{/* LAY-3, #1057: the toolbar is as tall as its controls, so Add user is never clipped. */}
				<div className="flex flex-wrap items-center gap-2">
					<div className="min-w-0 flex-1">
						<ListSearchBar
							value={query}
							onChange={(value) => {
								setQuery(value);
								setPage(1);
							}}
							placeholder="Search users"
						/>
					</div>
					<Button variant="outline" type="button" onClick={() => setShowAdd(true)}>
						<UserPlus aria-hidden data-icon="inline-start" />
						Add user
					</Button>
				</div>

				{failed ? (
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
					<Table aria-label="Users" stickyFirstColumn className="text-dense table-fixed text-left">
						<thead>
							<tr className="border-b">
								{COLUMNS.map(({ key, label, className }) => (
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
								<th scope="col" className="w-20 px-2 py-1.5">
									<span className="sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{users.map((user) => {
								const own = user.id === sessionUserId;
								const activeNow = user.last_active_at && Date.now() / 1000 - user.last_active_at < 180;
								return (
									<tr key={user.id} className="border-b last:border-0">
										<td className="px-2 py-1.5">
											<div className="flex min-w-0 items-center gap-2">
												<ProfileAvatar
													src={`${WEBUI_API_BASE_URL}/users/${user.id}/profile/image`}
													name={user.name}
													size="sm"
												/>
												<div className="flex min-w-0 flex-1 flex-col">
													<div className="flex min-w-0 items-center gap-1.5">
														<span className="text-foreground font-strong truncate" title={user.name}>
															{user.name}
														</span>
														{own && <span className="text-foreground-muted shrink-0">(you)</span>}
														{activeNow && (
															<span className="relative flex size-1.5 shrink-0" title="Active now">
																<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
																<span className="relative inline-flex size-1.5 rounded-full bg-success" />
																<span className="sr-only">Active now</span>
															</span>
														)}
														{/* LAY-4: on a phone the role sits beside the name. */}
														<span className="shrink-0 sm:hidden">
															<RoleControl user={user} own={own} onChange={changeRole} />
														</span>
													</div>
													<span className="text-foreground-muted text-caption truncate sm:hidden" title={user.email}>
														{user.email}
													</span>
												</div>
											</div>
										</td>
										<td className="hidden px-2 py-1.5 sm:table-cell">
											<RoleControl user={user} own={own} onChange={changeRole} />
										</td>
										<td className="hidden px-2 py-1.5 sm:table-cell">
											<span className="block truncate" title={user.email}>
												{user.email}
											</span>
										</td>
										<td className="text-foreground-muted hidden px-2 py-1.5 md:table-cell">
											{user.last_active_at ? (
												<Tip content={dayjs(user.last_active_at * 1000).format('YYYY-MM-DD HH:mm')}>
													<span>{lastActive(user.last_active_at)}</span>
												</Tip>
											) : (
												lastActive(user.last_active_at)
											)}
										</td>
										<td className="text-foreground-muted hidden px-2 py-1.5 md:table-cell">
											{dayjs(user.created_at * 1000).format('YYYY-MM-DD')}
										</td>
										<td className="px-1 py-1">
											<div className="flex justify-end">
												<Tip content="Edit user">
													<Button
														variant="ghost"
														size="icon-sm"
														type="button"
														aria-label={`Edit ${user.name}`}
														onClick={() => act(user, setShowEdit)}
													>
														<Pencil className="size-3.5" />
													</Button>
												</Tip>
												{!own && user.role !== 'admin' && (
													<DropdownMenu>
														<Tip content="More actions">
															<DropdownMenuTrigger asChild>
																<Button
																	variant="ghost"
																	size="icon-sm"
																	type="button"
																	aria-label={`More actions for ${user.name}`}
																>
																	<MoreHorizontal className="size-4" />
																</Button>
															</DropdownMenuTrigger>
														</Tip>
														<DropdownMenuContent align="end">
															{config?.features?.enable_admin_chat_access && (
																<DropdownMenuItem onSelect={() => act(user, setShowChats)}>
																	<MessageSquare />
																	View chats
																</DropdownMenuItem>
															)}
															<DropdownMenuItem onSelect={() => act(user, setShowPreview)}>
																<Eye />
																Preview access
															</DropdownMenuItem>
															<DropdownMenuSeparator />
															<DropdownMenuItem variant="destructive" onSelect={() => act(user, setShowDelete)}>
																<Trash2 />
																Delete user
															</DropdownMenuItem>
														</DropdownMenuContent>
													</DropdownMenu>
												)}
											</div>
										</td>
									</tr>
								);
							})}
						</tbody>
					</Table>
				)}

				{total !== null && total > PER_PAGE && (
					<PagePagination page={page} count={total} perPage={PER_PAGE} onPageChange={setPage} />
				)}
			</div>

			{total !== null && total > 50 && <LargeTeamNotice />}
		</>
	);
}

/**
 * The one in-app reminder of the condition the changed branding relies on:
 * clause 4(i) of the Open WebUI License permits it only for deployments with no
 * more than fifty end users in any rolling thirty-day period (see NOTICE).
 */
function LargeTeamNotice() {
	return (
		<div className="mt-3 mb-3 pb-1">
			<div className="max-w-3xl text-xs leading-5">
				<div>More than 50 users</div>
				<p className="text-muted-foreground mt-2">
					This app changes the Open WebUI branding under clause 4(i) of the Open WebUI License, which permits that only
					for deployments with no more than fifty end users in any rolling thirty-day period. Above that, the branding
					has to be restored or another of clause 4&apos;s permissions obtained; see NOTICE in the repository.
				</p>
			</div>
		</div>
	);
}
