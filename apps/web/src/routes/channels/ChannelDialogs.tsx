import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Copy, Plus, Search, Trash2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { AccessControl } from '@/components/common/AccessControl';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { toastFailure } from '@/components/common/failureToast';
import { InfiniteLoader } from '@/components/common/InfiniteLoader';
import { MemberSelector } from '@/components/common/MemberSelector';
import { PagePagination } from '@/components/common/PagePagination';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { ProfileAvatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle
} from '@/components/ui/dialog';
import { FieldMessage, fieldProps } from '@/components/ui/field-message';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RowButton } from '@/components/ui/row-button';
import { SegmentedControl, type SegmentedOption } from '@/components/ui/segmented-control';
import type { AccessGrant } from '@/lib/access/accessGrants';
import {
	addMembersById,
	createChannelWebhook,
	deleteChannelById,
	deleteChannelWebhook,
	getChannelMembersById,
	getChannelWebhooks,
	removeMembersById,
	updateChannelWebhook
} from '@/lib/apis/channels';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { useAuthStore } from '@/lib/stores/authStore';
import { useFieldErrors } from '@/lib/ui/useFieldErrors';
import { copyToClipboard } from '@/lib/utils';
import { dayjs } from '@/lib/utils/dates';
import { resizeToDataUrl } from '@/lib/utils/image';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';
import { ChannelMessageView } from './ChannelMessageView';
import {
	CHANNEL_NAME_MAX,
	type Channel,
	type ChannelFormValue,
	channelPayload,
	channelProblems,
	isPublicChannel
} from './channelModel';
import { usePinnedMessages } from './usePinnedMessages';

type DialogProps = { open: boolean; onOpenChange: (open: boolean) => void };
const MEMBERS_PER_PAGE = 30;

/**
 * Ports channel/PinnedMessagesModal.svelte: the channel's pinned messages,
 * paged as they scroll into view, each with an Unpin button and nothing else.
 */
export function PinnedMessagesDialog({
	open,
	onOpenChange,
	channel,
	onPinChange
}: DialogProps & { channel: Channel; onPinChange: (id: string, pinned: boolean) => void }) {
	const { messages, done, failed, load, unpin } = usePinnedMessages(channel.id, open, onPinChange);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Pinned Messages</DialogTitle>
				</DialogHeader>
				<div className="-mx-2 max-h-[28rem] overflow-y-auto pt-6">
					{failed && messages === null ? (
						<div className="text-muted-foreground flex flex-col items-center gap-2 py-6 text-sm">
							<p>Pinned messages could not be loaded.</p>
							<Button variant="outline" size="sm" onClick={() => void load(true)}>
								Retry
							</Button>
						</div>
					) : messages === null ? (
						<div className="flex justify-center py-6">
							<Spinner className="size-5" />
						</div>
					) : messages.length === 0 ? (
						<p className="text-muted-foreground py-6 text-center text-sm">No pinned messages</p>
					) : (
						<>
							{messages.map((m) => (
								<ChannelMessageView
									key={m.id}
									message={m}
									channelId={channel.id}
									showAuthor
									domPrefix="pinned-"
									className="rounded-xl px-2"
									actions={{ onPin: unpin }}
								/>
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
export function ChannelInfoDialog({
	open,
	onOpenChange,
	channel,
	onUpdate
}: DialogProps & { channel: Channel; onUpdate: () => void }) {
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
		queryFn: async () =>
			(await getChannelMembersById(token, channel.id, debounced, 'name', direction, page)) as {
				users: Member[];
				total: number;
			}
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
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-1.5">
						{dm ? 'Direct Message' : `${isPublicChannel(channel) ? '#' : ''}${channel.name}`}
					</DialogTitle>
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
							<Input
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder="Search"
								aria-label="Search members"
								className="pl-8"
							/>
						</div>
						<Button
							size="sm"
							variant="ghost"
							aria-label="Sort by name"
							onClick={() => setDirection((d) => (d === 'asc' ? 'desc' : 'asc'))}
						>
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
								<ProfileAvatar src={`${WEBUI_API_BASE_URL}/users/${u.id}/profile/image`} name={u.name} size="sm" />
								<Tip content={u.email}>
									<span className="truncate">{u.name}</span>
								</Tip>
								{u.is_active && <span className="size-2 rounded-full bg-success" aria-label="Active" />}
								{u.role && (
									<Badge variant={u.role === 'admin' ? 'default' : 'secondary'} className="ml-auto">
										{u.role}
									</Badge>
								)}
								{manager && (
									<Button
										type="button"
										variant="ghost"
										size="icon-xs"
										aria-label={`Remove ${u.name}`}
										onClick={() => void remove(u.id)}
									>
										<X className="size-3.5" />
									</Button>
								)}
							</li>
						))}
					</ul>
				)}
				{(members.data?.total ?? 0) > MEMBERS_PER_PAGE && (
					<PagePagination
						page={page}
						count={members.data?.total ?? 0}
						perPage={MEMBERS_PER_PAGE}
						onPageChange={setPage}
					/>
				)}
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
function AddMembersDialog({
	open,
	onOpenChange,
	channel,
	onAdded
}: DialogProps & { channel: Channel; onAdded: () => void }) {
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
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Add Members</DialogTitle>
					<DialogDescription className="sr-only">Choose users and groups to add to the channel</DialogDescription>
				</DialogHeader>
				<MemberSelector
					accessGrants={[]}
					userIds={userIds}
					groupIds={groupIds}
					onUserIdsChange={setUserIds}
					onGroupIdsChange={setGroupIds}
					includeGroups
				/>
				<DialogFooter>
					<Button onClick={submit} disabled={saving || (userIds.length === 0 && groupIds.length === 0)}>
						Add {saving && <Spinner className="size-3.5" />}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

type Webhook = {
	id: string;
	name: string;
	profile_image_url?: string | null;
	token?: string;
	created_at: number;
	user?: { name?: string } | null;
};

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

	const load = async () =>
		setWebhooks(((await getChannelWebhooks(token, channel.id).catch(() => [])) ?? []) as Webhook[]);

	useEffect(() => {
		if (!open) return;
		setWebhooks(null);
		setExpanded(null);
		setEdits({});
		void load();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, channel.id]);

	const current = (w: Webhook) => edits[w.id] ?? { name: w.name, profile_image_url: w.profile_image_url ?? '' };
	const edit = (w: Webhook, change: Partial<{ name: string; profile_image_url: string }>) =>
		setEdits((e) => ({ ...e, [w.id]: { ...current(w), ...change } }));

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
				await updateChannelWebhook(token, channel.id, id, {
					name: change.name.trim() || original?.name || 'Webhook',
					profile_image_url: change.profile_image_url
				} as never);
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
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-3">
						Webhooks
						<Button size="sm" variant="outline" onClick={create} disabled={saving}>
							<Plus className="size-3.5" /> New Webhook
						</Button>
					</DialogTitle>
					<DialogDescription className="sr-only">Incoming webhooks that post to this channel</DialogDescription>
				</DialogHeader>
				<input
					ref={fileInput}
					type="file"
					accept="image/*"
					hidden
					onChange={(e) =>
						expandedHook && void pickImage(expandedHook, e.target.files?.[0]).then(() => (e.target.value = ''))
					}
				/>
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
							return (
								<li key={w.id} className="rounded-xl border">
									<RowButton
										className="flex items-center justify-start gap-3 px-3 py-2"
										aria-expanded={expanded === w.id}
										onClick={() => setExpanded((x) => (x === w.id ? null : w.id))}
									>
										<ProfileAvatar src={v.profile_image_url} name={v.name} />
										<div className="min-w-0 flex-1">
											<div className="truncate text-sm">{v.name}</div>
											<div className="text-muted-foreground text-xs">
												Created on {dayjs(w.created_at / 1_000_000).format('MMM D, YYYY')}
												{w.user?.name ? ` by ${w.user.name}` : ''}
											</div>
										</div>
										<ChevronDown className={`size-3.5 transition-transform ${expanded === w.id ? 'rotate-180' : ''}`} />
									</RowButton>
									{expanded === w.id && (
										<div className="flex items-center gap-2 border-t px-3 py-2">
											<Button
												type="button"
												variant="ghost"
												size="icon"
												aria-label="Change picture"
												onClick={() => fileInput.current?.click()}
											>
												<ProfileAvatar src={v.profile_image_url} name={v.name} />
											</Button>
											<Input
												value={v.name}
												onChange={(e) => edit(w, { name: e.target.value })}
												placeholder="Webhook Name"
												aria-label="Webhook Name"
												className="h-8"
											/>
											<Tip content="Copy URL">
												<Button
													type="button"
													variant="ghost"
													size="icon-sm"
													aria-label="Copy URL"
													onClick={async () => {
														if (await copyToClipboard(`${WEBUI_API_BASE_URL}/channels/webhooks/${w.id}/${w.token}`))
															toast.success('Copied');
													}}
												>
													<Copy className="size-4" />
												</Button>
											</Tip>
											<Tip content="Delete">
												<Button
													type="button"
													variant="ghost"
													size="icon-sm"
													aria-label="Delete webhook"
													onClick={() => setConfirmDelete(w.id)}
												>
													<Trash2 className="size-4" />
												</Button>
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
				<ConfirmDialog
					open={confirmDelete !== null}
					onOpenChange={(o) => !o && setConfirmDelete(null)}
					title="Delete webhook?"
					confirmLabel="Delete"
					onConfirm={async () => {
						if (confirmDelete) await remove(confirmDelete);
					}}
				>
					Anything posting to this webhook's URL will stop working.
				</ConfirmDialog>
			</DialogContent>
		</Dialog>
	);
}

const TYPE_HELP: Record<ChannelFormValue['type'], string> = {
	'': 'Whoever you give access, by group or by person, can read and write in it.',
	group: 'People join it as members. A public one anyone can find and join.',
	dm: 'A private conversation with the people you choose.'
};
const TYPE_OPTIONS: SegmentedOption<ChannelFormValue['type']>[] = [
	{ value: '', label: 'Channel' },
	{ value: 'group', label: 'Group' },
	{ value: 'dm', label: 'Direct message' }
];

/**
 * Ports layout/Sidebar/ChannelModal.svelte: create a channel (an admin may
 * also create a standard, permission-based one; everyone may create a group
 * channel or a DM), or edit one, with its webhooks and delete. `onSubmit` gets
 * the payload the API takes and returns whether it saved. A group channel can
 * be made Public only with `sharing.public_channels` (admins always), and
 * turning a private one public asks first, since its whole history becomes
 * readable to everyone who may use channels (#331). The name is kept as typed
 * (S6-D2), and a missing name or member is said under its field (#1109).
 */
export function ChannelFormDialog({
	open,
	onOpenChange,
	channel,
	onSubmit,
	onDeleted
}: DialogProps & {
	channel?: Channel | null;
	onSubmit: (payload: Record<string, unknown>) => Promise<boolean>;
	onDeleted?: () => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{/* OVL-1: a short form is 32 rem; its fields shorten rather than widen it (#967). */}
			<DialogContent className="sm:max-w-lg">
				{/* Remounted per open, so the form starts from the channel it was opened on. */}
				{open && (
					<ChannelForm channel={channel} onOpenChange={onOpenChange} onSubmit={onSubmit} onDeleted={onDeleted} />
				)}
			</DialogContent>
		</Dialog>
	);
}

function ChannelForm({
	onOpenChange,
	channel,
	onSubmit,
	onDeleted
}: {
	onOpenChange: (open: boolean) => void;
	channel?: Channel | null;
	onSubmit: (payload: Record<string, unknown>) => Promise<boolean>;
	onDeleted?: () => void;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
	const sharePublic = useAuthStore((s) => Boolean(s.user?.permissions?.sharing?.public_channels));
	const canMakePublic = isAdmin || sharePublic;
	const navigate = useNavigate();
	const location = useLocation();
	const edit = Boolean(channel);
	const types = TYPE_OPTIONS.filter((t) => isAdmin || t.value !== '');
	const [value, setValue] = useState<ChannelFormValue>(() => {
		const type = ((channel?.type ?? types[0].value) || '') as ChannelFormValue['type'];
		return {
			type,
			name: channel?.name ?? '',
			isPrivate: type === 'group' ? (typeof channel?.is_private === 'boolean' ? channel.is_private : true) : true,
			accessGrants: channel?.access_grants ?? [],
			userIds: channel?.user_ids ?? []
		};
	});
	const [saving, setSaving] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [confirmPublic, setConfirmPublic] = useState(false);
	const [showWebhooks, setShowWebhooks] = useState(false);
	const ids = { name: useId(), nameMsg: useId(), visibility: useId(), visibilityMsg: useId(), membersMsg: useId() };
	const {
		errors,
		field,
		submit: checkFields
	} = useFieldErrors(channelProblems(value), ['name', 'members'] as const, {
		inDialog: true
	});

	const save = async () => {
		const result = channelPayload(value);
		if (!('payload' in result)) return;
		setSaving(true);
		const ok = await onSubmit(result.payload);
		setSaving(false);
		if (ok) onOpenChange(false);
	};

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!checkFields()) return;
		if (edit && value.type === 'group' && !value.isPrivate && channel?.is_private !== false) {
			setConfirmPublic(true);
			return;
		}
		await save();
	};

	const remove = async () => {
		if (!channel) return;
		const res = await deleteChannelById(token, channel.id).catch((e) => {
			toastFailure("Couldn't delete the channel", e);
			return null;
		});
		if (res) {
			toast.success(`Deleted ${channel.name}`);
			onDeleted?.();
			if (location.pathname === `/channels/${channel.id}`) navigate('/');
		}
		onOpenChange(false);
	};

	const visibilityHelp = !canMakePublic
		? value.isPrivate
			? 'Making a channel public needs the Public channels permission.'
			: 'You may not keep this channel public: saving makes it private.'
		: value.isPrivate
			? 'Only the people you invite can open it.'
			: 'Anyone who may use channels can find and join it.';

	return (
		<>
			<DialogHeader>
				<DialogTitle>{edit ? 'Edit channel' : 'New channel'}</DialogTitle>
				<DialogDescription>{TYPE_HELP[value.type]}</DialogDescription>
			</DialogHeader>
			<form onSubmit={submit} noValidate className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
				{/* OVL-1: a long member list scrolls here; the title and the buttons stay in view. */}
				<DialogBody>
					{!edit && types.length > 1 && (
						<SegmentedControl
							aria-label="Kind of channel"
							value={value.type}
							options={types}
							onValueChange={(type) => setValue((v) => ({ ...v, type }))}
						/>
					)}
					<div className="flex min-w-0 flex-col gap-1.5">
						<Label htmlFor={ids.name}>
							Name {value.type === 'dm' && <span className="text-foreground-muted font-normal">(optional)</span>}
						</Label>
						<Input
							id={ids.name}
							autoComplete="off"
							placeholder="e.g. Reading group"
							maxLength={CHANNEL_NAME_MAX}
							value={value.name}
							{...field('name')}
							{...fieldProps(ids.nameMsg, { error: errors.name })}
							onChange={(e) => setValue((v) => ({ ...v, name: e.target.value }))}
						/>
						<FieldMessage id={ids.nameMsg} error={errors.name} />
					</div>

					{value.type === '' && (
						<AccessControl
							accessGrants={value.accessGrants as AccessGrant[]}
							onChange={(g) => setValue((v) => ({ ...v, accessGrants: g }))}
							accessRoles={['read', 'write']}
						/>
					)}
					{value.type === 'group' && (
						<div className="flex min-w-0 flex-col gap-1.5">
							<Label id={ids.visibility}>Who can join</Label>
							<SegmentedControl
								aria-labelledby={ids.visibility}
								aria-describedby={ids.visibilityMsg}
								value={value.isPrivate ? 'private' : 'public'}
								options={[
									{ value: 'private', label: 'Invited people' },
									{ value: 'public', label: 'Anyone', disabled: !canMakePublic }
								]}
								onValueChange={(v) => setValue((prev) => ({ ...prev, isPrivate: v === 'private' }))}
							/>
							<FieldMessage id={ids.visibilityMsg} help={visibilityHelp} />
						</div>
					)}
					{value.type === 'dm' && (
						<div className="flex min-w-0 flex-col gap-1.5">
							<MemberSelector
								accessGrants={[]}
								userIds={value.userIds}
								groupIds={[]}
								onUserIdsChange={(userIds) => setValue((v) => ({ ...v, userIds }))}
								onGroupIdsChange={() => {}}
								includeGroups={false}
							/>
							<FieldMessage id={ids.membersMsg} error={errors.members} />
						</div>
					)}

					{edit && (
						<div className="flex items-center justify-between gap-2">
							<span>Webhooks</span>
							<Button type="button" size="sm" variant="outline" onClick={() => setShowWebhooks(true)}>
								Manage webhooks
							</Button>
						</div>
					)}
				</DialogBody>
				<DialogFooter className="gap-2">
					{edit && (
						<Button type="button" variant="ghost" className="sm:me-auto" onClick={() => setConfirmDelete(true)}>
							<Trash2 data-icon="inline-start" />
							Delete channel
						</Button>
					)}
					<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button type="submit" disabled={saving} aria-busy={saving || undefined}>
						{saving && <Spinner className="size-3.5" />}
						{edit ? 'Save changes' : 'Create channel'}
					</Button>
				</DialogFooter>
			</form>
			<ConfirmDialog
				open={confirmPublic}
				onOpenChange={setConfirmPublic}
				title="Make channel public?"
				confirmLabel="Make public"
				onConfirm={save}
			>
				Everyone who may use channels will be able to find this channel and read its whole history, and join it.
			</ConfirmDialog>
			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title="Delete channel?"
				confirmLabel="Delete channel"
				destructive
				onConfirm={remove}
			>
				<span className="font-medium">{channel?.name}</span> and all its messages are deleted for everyone in it.
			</ConfirmDialog>
			{channel && <WebhooksDialog open={showWebhooks} onOpenChange={setShowWebhooks} channel={channel} />}
		</>
	);
}
