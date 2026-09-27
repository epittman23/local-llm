import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Copy, Plus, Search, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { AccessControl } from '@/components/common/AccessControl';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { InfiniteLoader } from '@/components/common/InfiniteLoader';
import { MemberSelector } from '@/components/common/MemberSelector';
import { PagePagination } from '@/components/common/PagePagination';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { AccessGrant } from '@/lib/access/accessGrants';
import {
	addMembersById,
	createChannelWebhook,
	deleteChannelById,
	deleteChannelWebhook,
	getChannelMembersById,
	getChannelPinnedMessages,
	getChannelWebhooks,
	pinMessage,
	removeMembersById,
	updateChannelWebhook
} from '@/lib/apis/channels';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { useAuthStore } from '@/lib/stores/authStore';
import { copyToClipboard } from '@/lib/utils';
import { dayjs } from '@/lib/utils/dates';
import { resizeToDataUrl } from '@/lib/utils/image';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';
import { type Channel, type ChannelFormValue, type ChannelMessage, channelPayload, isPublicChannel, normalizeChannelName } from './channelModel';
import { ChannelMessageView } from './ChannelMessageView';

type DialogProps = { open: boolean; onOpenChange: (open: boolean) => void };
const MEMBERS_PER_PAGE = 30;
const nativeSelect = 'border-input bg-transparent h-9 w-full rounded-md border px-2 text-sm outline-none [&>option]:bg-popover';

/**
 * Ports channel/PinnedMessagesModal.svelte: the channel's pinned messages,
 * paged as they scroll into view, each with an Unpin button and nothing else.
 */
export function PinnedMessagesDialog({ open, onOpenChange, channel, onPinChange }: DialogProps & { channel: Channel; onPinChange: (id: string, pinned: boolean) => void }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const [messages, setMessages] = useState<ChannelMessage[] | null>(null);
	const [done, setDone] = useState(false);
	const page = useRef(1);
	const loading = useRef(false);

	const load = async (reset = false) => {
		if (loading.current || (done && !reset)) return;
		loading.current = true;
		if (reset) page.current = 1;
		const res = (await getChannelPinnedMessages(token, channel.id, page.current).catch((e) => {
			toast.error(`${e}`);
			return null;
		})) as ChannelMessage[] | null;
		if (res) {
			setMessages((ms) => [...(reset ? [] : (ms ?? [])), ...res]);
			setDone(res.length === 0);
			page.current += 1;
		} else if (reset) setMessages([]);
		loading.current = false;
	};

	useEffect(() => {
		if (!open) return;
		setMessages(null);
		setDone(false);
		void load(true);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, channel.id]);

	const unpin = async (m: ChannelMessage) => {
		setMessages((ms) => ms?.filter((x) => x.id !== m.id) ?? ms);
		onPinChange(m.id, false);
		await pinMessage(token, channel.id, m.id, false).catch((e) => toast.error(`${e}`));
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>Pinned Messages</DialogTitle>
				</DialogHeader>
				<div className="-mx-2 max-h-[28rem] overflow-y-auto pt-6">
					{messages === null ? (
						<div className="flex justify-center py-6">
							<Spinner className="size-5" />
						</div>
					) : messages.length === 0 ? (
						<p className="text-muted-foreground py-6 text-center text-sm">No pinned messages</p>
					) : (
						<>
							{messages.map((m) => (
								<ChannelMessageView key={m.id} message={m} channelId={channel.id} showAuthor domPrefix="pinned-" className="rounded-xl px-2" actions={{ onPin: unpin }} />
							))}
							{!done && (
								<InfiniteLoader onVisible={() => void load()}>
									<div className="flex justify-center py-2">
										<Spinner className="size-4" />
									</div>
								</InfiniteLoader>
							)}
						</>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

type Member = { id: string; name: string; email?: string; role?: string; is_active?: boolean };

/**
 * Ports channel/ChannelInfoModal.svelte and its UserList: who is in the
 * channel, searchable and sortable by name (not in a DM), thirty to a page.
 * A group channel's managers can add and remove members here.
 */
export function ChannelInfoDialog({ open, onOpenChange, channel, onUpdate }: DialogProps & { channel: Channel; onUpdate: () => void }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const [query, setQuery] = useState('');
	const [page, setPage] = useState(1);
	const [direction, setDirection] = useState<'asc' | 'desc'>('asc');
	const [showAdd, setShowAdd] = useState(false);
	const debounced = useDebouncedValue(query, 300);
	const dm = channel.type === 'dm';
	const manager = channel.type === 'group' && Boolean(channel.is_manager);

	useEffect(() => setPage(1), [debounced]);

	const members = useQuery({
		queryKey: ['channel-members', channel.id, debounced, direction, page],
		enabled: open,
		queryFn: async () => (await getChannelMembersById(token, channel.id, debounced, 'name', direction, page)) as { users: Member[]; total: number }
	});

	const remove = async (userId: string) => {
		const res = await removeMembersById(token, channel.id, { user_ids: [userId] }).catch((e) => {
			toast.error(`${e}`);
			return null;
		});
		if (res) {
			toast.success('Member removed successfully');
			void members.refetch();
			onUpdate();
		} else toast.error('Failed to remove member');
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-1.5">{dm ? 'Direct Message' : `${isPublicChannel(channel) ? '#' : ''}${channel.name}`}</DialogTitle>
					<DialogDescription className="sr-only">Channel members</DialogDescription>
				</DialogHeader>
				<div className="flex items-center justify-between">
					<span className="text-sm font-medium">
						Members {members.data ? <span className="text-muted-foreground">{members.data.total}</span> : null}
					</span>
					{manager && (
						<Button size="sm" variant="outline" onClick={() => setShowAdd(true)}>
							<Plus className="size-3.5" /> Add Member
						</Button>
					)}
				</div>
				{!dm && (
					<div className="flex items-center gap-2">
						<div className="relative flex-1">
							<Search className="text-muted-foreground absolute top-2.5 left-2 size-4" />
							<Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search members" className="pl-8" />
						</div>
						<Button size="sm" variant="ghost" aria-label="Sort by name" onClick={() => setDirection((d) => (d === 'asc' ? 'desc' : 'asc'))}>
							Name {direction === 'asc' ? '↑' : '↓'}
						</Button>
					</div>
				)}
				{!members.data ? (
					<div className="flex justify-center py-6">
						<Spinner className="size-5" />
					</div>
				) : (
					<ul className="max-h-80 overflow-y-auto" aria-label="Members">
						{members.data.users.map((u) => (
							<li key={u.id} className="flex items-center gap-2 py-1.5 text-sm">
								<img src={`${WEBUI_API_BASE_URL}/users/${u.id}/profile/image`} alt="" className="size-6 rounded-full object-cover" />
								<Tip content={u.email}>
									<span className="truncate">{u.name}</span>
								</Tip>
								{u.is_active && <span className="size-2 rounded-full bg-green-500" aria-label="Active" />}
								{u.role && (
									<Badge variant={u.role === 'admin' ? 'default' : 'secondary'} className="ml-auto">
										{u.role}
									</Badge>
								)}
								{manager && (
									<button type="button" aria-label={`Remove ${u.name}`} className="text-muted-foreground hover:text-foreground" onClick={() => void remove(u.id)}>
										<X className="size-3.5" />
									</button>
								)}
							</li>
						))}
					</ul>
				)}
				{(members.data?.total ?? 0) > MEMBERS_PER_PAGE && <PagePagination page={page} count={members.data?.total ?? 0} perPage={MEMBERS_PER_PAGE} onPageChange={setPage} />}
				<AddMembersDialog
					open={showAdd}
					onOpenChange={setShowAdd}
					channel={channel}
					onAdded={() => {
						void members.refetch();
						onUpdate();
					}}
				/>
			</DialogContent>
		</Dialog>
	);
}

/** Ports ChannelInfoModal/AddMembersModal.svelte: pick users and groups to add. */
function AddMembersDialog({ open, onOpenChange, channel, onAdded }: DialogProps & { channel: Channel; onAdded: () => void }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const [userIds, setUserIds] = useState<string[]>([]);
	const [groupIds, setGroupIds] = useState<string[]>([]);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!open) {
			setUserIds([]);
			setGroupIds([]);
		}
	}, [open]);

	const submit = async () => {
		setSaving(true);
		const res = await addMembersById(token, channel.id, { user_ids: userIds, group_ids: groupIds }).catch((e) => {
			toast.error(`${e}`);
			return null;
		});
		setSaving(false);
		if (res) {
			toast.success('Members added successfully');
			onAdded();
			onOpenChange(false);
		} else toast.error('Failed to add members');
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Add Members</DialogTitle>
					<DialogDescription className="sr-only">Choose users and groups to add to the channel</DialogDescription>
				</DialogHeader>
				<MemberSelector accessGrants={[]} userIds={userIds} groupIds={groupIds} onUserIdsChange={setUserIds} onGroupIdsChange={setGroupIds} includeGroups />
				<DialogFooter>
					<Button onClick={submit} disabled={saving || (userIds.length === 0 && groupIds.length === 0)}>
						Add {saving && <Spinner className="size-3.5" />}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

type Webhook = { id: string; name: string; profile_image_url?: string | null; token?: string; created_at: number; user?: { name?: string } | null };

/**
 * Ports channel/WebhooksModal.svelte and WebhookItem.svelte: the channel's
 * incoming webhooks. New Webhook creates one at once; a row expands to rename
 * it, change its picture, copy its URL or delete it; Save sends every renamed
 * or re-pictured webhook.
 */
export function WebhooksDialog({ open, onOpenChange, channel }: DialogProps & { channel: Channel }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const [webhooks, setWebhooks] = useState<Webhook[] | null>(null);
	const [expanded, setExpanded] = useState<string | null>(null);
	const [edits, setEdits] = useState<Record<string, { name: string; profile_image_url: string }>>({});
	const [saving, setSaving] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);

	const load = async () => setWebhooks(((await getChannelWebhooks(token, channel.id).catch(() => [])) ?? []) as Webhook[]);

	useEffect(() => {
		if (!open) return;
		setWebhooks(null);
		setExpanded(null);
		setEdits({});
		void load();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, channel.id]);

	const current = (w: Webhook) => edits[w.id] ?? { name: w.name, profile_image_url: w.profile_image_url ?? '' };
	const edit = (w: Webhook, change: Partial<{ name: string; profile_image_url: string }>) => setEdits((e) => ({ ...e, [w.id]: { ...current(w), ...change } }));

	const create = async () => {
		setSaving(true);
		const created = (await createChannelWebhook(token, channel.id, { name: 'New Webhook' } as never).catch((e) => {
			toast.error(`${e}`);
			return null;
		})) as Webhook | null;
		setSaving(false);
		if (created) {
			setWebhooks((ws) => [...(ws ?? []), created]);
			setExpanded(created.id);
		}
	};

	const save = async () => {
		setSaving(true);
		try {
			for (const [id, change] of Object.entries(edits)) {
				const original = webhooks?.find((w) => w.id === id);
				await updateChannelWebhook(token, channel.id, id, { name: change.name.trim() || original?.name || 'Webhook', profile_image_url: change.profile_image_url } as never);
			}
			setEdits({});
			await load();
			toast.success('Saved');
		} catch (e) {
			toast.error(`${e}`);
		}
		setSaving(false);
	};

	const remove = async (id: string) => {
		await deleteChannelWebhook(token, channel.id, id)
			.then(() => {
				setWebhooks((ws) => ws?.filter((w) => w.id !== id) ?? ws);
				toast.success('Deleted');
			})
			.catch((e) => toast.error(`${e}`));
		setExpanded(null);
	};

	const pickImage = async (w: Webhook, file: File | undefined) => {
		if (!file) return;
		if (['image/gif', 'image/webp'].includes(file.type)) {
			const reader = new FileReader();
			reader.onload = () => edit(w, { profile_image_url: String(reader.result) });
			reader.readAsDataURL(file);
		} else {
			edit(w, { profile_image_url: await resizeToDataUrl(file, 100).catch(() => current(w).profile_image_url) });
		}
	};

	const expandedHook = webhooks?.find((w) => w.id === expanded);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-3">
						Webhooks
						<Button size="sm" variant="outline" onClick={create} disabled={saving}>
							<Plus className="size-3.5" /> New Webhook
						</Button>
					</DialogTitle>
					<DialogDescription className="sr-only">Incoming webhooks that post to this channel</DialogDescription>
				</DialogHeader>
				<input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => expandedHook && void pickImage(expandedHook, e.target.files?.[0]).then(() => (e.target.value = ''))} />
				{webhooks === null ? (
					<div className="flex justify-center py-6">
						<Spinner className="size-5" />
					</div>
				) : webhooks.length === 0 ? (
					<p className="text-muted-foreground py-6 text-center text-sm">No webhooks yet</p>
				) : (
					<ul className="flex max-h-96 flex-col gap-1 overflow-y-auto">
						{webhooks.map((w) => {
							const v = current(w);
							const image = v.profile_image_url || '/static/favicon.png';
							return (
								<li key={w.id} className="rounded-xl border">
									<button type="button" className="flex w-full items-center gap-3 px-3 py-2 text-left" aria-expanded={expanded === w.id} onClick={() => setExpanded((x) => (x === w.id ? null : w.id))}>
										<img src={image} alt="" className="size-8 rounded-full object-cover" />
										<div className="min-w-0 flex-1">
											<div className="truncate text-sm">{v.name}</div>
											<div className="text-muted-foreground text-xs">
												Created on {dayjs(w.created_at / 1_000_000).format('MMM D, YYYY')}
												{w.user?.name ? ` by ${w.user.name}` : ''}
											</div>
										</div>
										<ChevronDown className={`size-3.5 transition-transform ${expanded === w.id ? 'rotate-180' : ''}`} />
									</button>
									{expanded === w.id && (
										<div className="flex items-center gap-2 border-t px-3 py-2">
											<button type="button" aria-label="Change picture" onClick={() => fileInput.current?.click()}>
												<img src={image} alt="" className="size-8 rounded-full object-cover" />
											</button>
											<Input value={v.name} onChange={(e) => edit(w, { name: e.target.value })} placeholder="Webhook Name" aria-label="Webhook Name" className="h-8" />
											<Tip content="Copy URL">
												<button
													type="button"
													aria-label="Copy URL"
													className="hover:bg-muted rounded-md p-1.5"
													onClick={async () => {
														if (await copyToClipboard(`${WEBUI_API_BASE_URL}/channels/webhooks/${w.id}/${w.token}`)) toast.success('Copied');
													}}
												>
													<Copy className="size-4" />
												</button>
											</Tip>
											<Tip content="Delete">
												<button type="button" aria-label="Delete webhook" className="hover:bg-muted rounded-md p-1.5" onClick={() => setConfirmDelete(w.id)}>
													<Trash2 className="size-4" />
												</button>
											</Tip>
										</div>
									)}
								</li>
							);
						})}
					</ul>
				)}
				<DialogFooter>
					<Button onClick={save} disabled={saving || Object.keys(edits).length === 0}>
						Save {saving && <Spinner className="size-3.5" />}
					</Button>
				</DialogFooter>
				<ConfirmDialog open={confirmDelete !== null} onOpenChange={(o) => !o && setConfirmDelete(null)} title="Delete webhook?" confirmLabel="Delete" onConfirm={async () => {
						if (confirmDelete) await remove(confirmDelete);
					}}>
					Anything posting to this webhook's URL will stop working.
				</ConfirmDialog>
			</DialogContent>
		</Dialog>
	);
}

const TYPE_HELP: Record<ChannelFormValue['type'], string> = {
	'': 'Discussion channel where access is based on groups and permissions',
	group: 'Collaboration channel where people join as members',
	dm: 'Private conversation between selected users'
};
const TYPE_LABEL: Record<ChannelFormValue['type'], string> = { '': 'Channel', group: 'Group Channel', dm: 'Direct Message' };

/**
 * Ports layout/Sidebar/ChannelModal.svelte: create a channel (an admin may
 * also create a standard, permission-based one; everyone may create a group
 * channel or a DM), or edit one, with its webhooks and delete. `onSubmit` gets
 * the payload the API takes and returns whether it saved.
 */
export function ChannelFormDialog({
	open,
	onOpenChange,
	channel,
	onSubmit,
	onDeleted
}: DialogProps & { channel?: Channel | null; onSubmit: (payload: Record<string, unknown>) => Promise<boolean>; onDeleted?: () => void }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
	const navigate = useNavigate();
	const location = useLocation();
	const edit = Boolean(channel);
	const types: ChannelFormValue['type'][] = isAdmin ? ['', 'group', 'dm'] : ['group', 'dm'];
	const [value, setValue] = useState<ChannelFormValue>({ type: types[0], name: '', isPrivate: true, accessGrants: [], userIds: [] });
	const [saving, setSaving] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [showWebhooks, setShowWebhooks] = useState(false);

	useEffect(() => {
		if (!open) return;
		const type = ((channel?.type ?? types[0]) || '') as ChannelFormValue['type'];
		setValue({
			type,
			name: channel?.name ?? '',
			isPrivate: type === 'group' ? (typeof channel?.is_private === 'boolean' ? channel.is_private : true) : true,
			accessGrants: channel?.access_grants ?? [],
			userIds: channel?.user_ids ?? []
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, channel]);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		const result = channelPayload(value);
		if ('error' in result) {
			toast.error(result.error);
			return;
		}
		setSaving(true);
		const ok = await onSubmit(result.payload);
		setSaving(false);
		if (ok) onOpenChange(false);
	};

	const remove = async () => {
		if (!channel) return;
		const res = await deleteChannelById(token, channel.id).catch((e) => {
			toast.error(`${e}`);
			return null;
		});
		if (res) {
			toast.success('Channel deleted successfully');
			onDeleted?.();
			if (location.pathname === `/channels/${channel.id}`) navigate('/');
		}
		onOpenChange(false);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>{edit ? 'Edit Channel' : 'Create Channel'}</DialogTitle>
					<DialogDescription>{TYPE_HELP[value.type]}</DialogDescription>
				</DialogHeader>
				<form onSubmit={submit} className="flex flex-col gap-4">
					{!edit && (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="channel-type">Channel Type</Label>
							<select id="channel-type" className={nativeSelect} value={value.type} onChange={(e) => setValue((v) => ({ ...v, type: e.target.value as ChannelFormValue['type'] }))}>
								{types.map((t) => (
									<option key={t || 'standard'} value={t}>
										{TYPE_LABEL[t]}
									</option>
								))}
							</select>
						</div>
					)}
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="channel-name">
							Channel Name {value.type === 'dm' && <span className="text-muted-foreground text-xs">Optional</span>}
						</Label>
						<Input id="channel-name" autoComplete="off" placeholder="new-channel" maxLength={128} required={value.type !== 'dm'} value={value.name} onChange={(e) => setValue((v) => ({ ...v, name: normalizeChannelName(e.target.value) }))} />
					</div>

					{value.type === '' && <AccessControl accessGrants={value.accessGrants as AccessGrant[]} onChange={(g) => setValue((v) => ({ ...v, accessGrants: g }))} accessRoles={['read', 'write']} />}
					{value.type === 'group' && (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="channel-visibility">Visibility</Label>
							<select id="channel-visibility" className={nativeSelect} value={value.isPrivate ? 'private' : 'public'} onChange={(e) => setValue((v) => ({ ...v, isPrivate: e.target.value === 'private' }))}>
								<option value="private">Private</option>
								<option value="public">Public</option>
							</select>
							<p className="text-muted-foreground text-xs">{value.isPrivate ? 'Only invited users can access' : 'Visible to all users'}</p>
						</div>
					)}
					{value.type === 'dm' && (
						<MemberSelector accessGrants={[]} userIds={value.userIds} groupIds={[]} onUserIdsChange={(ids) => setValue((v) => ({ ...v, userIds: ids }))} onGroupIdsChange={() => {}} includeGroups={false} />
					)}

					{edit && (
						<div className="flex items-center justify-between text-sm">
							<span>Webhooks</span>
							<Button type="button" size="sm" variant="outline" onClick={() => setShowWebhooks(true)}>
								Manage
							</Button>
						</div>
					)}

					<DialogFooter className="gap-2">
						{edit && (
							<Button type="button" variant="ghost" onClick={() => setConfirmDelete(true)}>
								Delete
							</Button>
						)}
						<Button type="submit" disabled={saving}>
							{edit ? 'Update' : 'Create'} {saving && <Spinner className="size-3.5" />}
						</Button>
					</DialogFooter>
				</form>
				<ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title="Delete channel?" confirmLabel="Delete" onConfirm={remove}>
					Are you sure you want to delete this channel?
				</ConfirmDialog>
				{channel && <WebhooksDialog open={showWebhooks} onOpenChange={setShowWebhooks} channel={channel} />}
			</DialogContent>
		</Dialog>
	);
}
