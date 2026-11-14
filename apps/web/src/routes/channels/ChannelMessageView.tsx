import {
	ArrowUpLeft,
	ChevronRight,
	FileText,
	MessageSquare,
	Pencil,
	Pin,
	PinOff,
	SmilePlus,
	Trash2
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Markdown } from '@/components/chat/markdown/Markdown';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Emoji, EmojiPicker } from '@/components/common/EmojiPicker';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { getMessageData } from '@/lib/apis/channels';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { useAuthStore } from '@/lib/stores/authStore';
import { cn } from '@/lib/utils';
import { dayjs, formatSecondsTimestamp } from '@/lib/utils/dates';
import { attachmentUrl, type ChannelMessage, mentionsToText, messageFiles, reactionTooltip } from './channelModel';

/** A message's author picture: the model's, a webhook's, or the user's. */
function authorImage(m: Pick<ChannelMessage, 'meta' | 'user'>) {
	if (m.meta?.model_id)
		return `${WEBUI_API_BASE_URL}/models/model/profile/image?id=${encodeURIComponent(m.meta.model_id)}`;
	if (m.user?.role === 'webhook') return `${WEBUI_API_BASE_URL}/channels/webhooks/${m.user.id}/profile/image`;
	return `${WEBUI_API_BASE_URL}/users/${m.user?.id}/profile/image`;
}
const authorName = (m: Pick<ChannelMessage, 'meta' | 'user'>) =>
	m.meta?.model_name ?? m.meta?.model_id ?? m.user?.name ?? 'Unknown User';
const fallbackImage = (e: React.SyntheticEvent<HTMLImageElement>) => {
	e.currentTarget.src = '/static/favicon.png';
};

function timeLabel(ns: number) {
	const d = dayjs(ns / 1_000_000);
	return d.isToday() ? d.format('LT') : formatSecondsTimestamp(ns / 1_000_000_000);
}

export type MessageActions = {
	onReply?: (m: ChannelMessage) => void;
	onThread?: (id: string) => void;
	onPin?: (m: ChannelMessage) => void;
	onReaction?: (m: ChannelMessage, name: string) => void;
	onEdit?: (m: ChannelMessage, content: string) => void;
	onDelete?: (m: ChannelMessage) => void;
};

/**
 * Ports channel/Messages/Message.svelte: one message with its hover toolbar
 * (react, reply, pin, thread, and edit/delete for its author or an admin),
 * the "Pinned" and reply-to lines, author and time, attachments, the Markdown
 * body with mentions, reactions, and the thread summary. An action left out
 * of `actions` hides its button, which is how the pinned-messages list shows
 * only Unpin.
 *
 * Not ported: swipe-to-reply on touch screens, the profile hover card, and the
 * structured-output renderer a model reply can carry (that renderer belongs to
 * Phase 10's chat; such a reply shows its text content).
 */
export function ChannelMessageView({
	message: initial,
	channelId,
	showAuthor,
	thread = false,
	highlighted = false,
	disabled = false,
	domPrefix = '',
	actions,
	className
}: {
	message: ChannelMessage;
	channelId: string;
	showAuthor: boolean;
	thread?: boolean;
	highlighted?: boolean;
	disabled?: boolean;
	domPrefix?: string;
	actions: MessageActions;
	className?: string;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const me = useAuthStore((s) => s.user);
	const [loadedData, setLoadedData] = useState<ChannelMessage['data']>(null);
	const [editing, setEditing] = useState<string | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [pickerOpen, setPickerOpen] = useState(false);
	const pending = Boolean(initial.temp_id);
	const message = initial.data === true && loadedData ? { ...initial, data: loadedData } : initial;

	// A message's `data` arrives as `true` when it is too large to inline; fetch it.
	useEffect(() => {
		if (initial.data !== true || !initial.id || pending) return;
		let cancelled = false;
		getMessageData(token, channelId, initial.id)
			.then((d) => !cancelled && d && setLoadedData(d))
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [initial.data, initial.id, channelId, token, pending]);

	const domId = `message-${domPrefix}${message.id}`;
	const mine = message.user_id === me?.id || me?.role === 'admin';
	const replyTo = message.reply_to_message;
	const repliesToMe = replyTo && (replyTo.meta?.model_id ?? replyTo.user_id) === me?.id;
	const files = messageFiles(message);
	const edited = message.created_at !== message.updated_at && !message.meta?.model_id;

	const jumpTo = (id: string) => {
		const el = document.getElementById(`message-${domPrefix}${id}`);
		if (!el) return;
		el.scrollIntoView({ behavior: 'smooth', block: 'center' });
		el.classList.add('bg-brand/10');
		setTimeout(() => el.classList.remove('bg-brand/10'), 2000);
	};

	const saveEdit = () => {
		if (editing !== null) actions.onEdit?.(message, editing);
		setEditing(null);
	};

	return (
		<div
			id={domId}
			data-testid="channel-message"
			className={cn(
				'group relative flex w-full flex-col px-5 transition-colors hover:bg-surface-3',
				highlighted && 'border-l-4 border-brand bg-brand/5 pl-4',
				repliesToMe && 'border-l-4 border-warning bg-warning/5 pl-4',
				message.is_pinned && 'bg-warning/10',
				showAuthor && 'pt-1.5 pb-0.5',
				className
			)}
		>
			{editing === null && !disabled && !pending && (
				<div
					className={cn(
						'absolute -top-7 right-1 z-20 hidden group-focus-within:flex group-hover:flex',
						pickerOpen && 'flex'
					)}
				>
					<div className="bg-popover flex gap-0.5 rounded-lg border p-0.5 shadow-md">
						{actions.onReaction && (
							<EmojiPicker onSubmit={(name) => actions.onReaction?.(message, name)} onOpenChange={setPickerOpen}>
								<Button type="button" variant="ghost" size="icon-sm" aria-label="Add Reaction">
									<SmilePlus className="size-4" />
								</Button>
							</EmojiPicker>
						)}
						{actions.onReply && (
							<Tip content="Reply">
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									aria-label="Reply"
									onClick={() => actions.onReply?.(message)}
								>
									<ArrowUpLeft className="size-4" />
								</Button>
							</Tip>
						)}
						{actions.onPin && (
							<Tip content={message.is_pinned ? 'Unpin' : 'Pin'}>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									aria-label={message.is_pinned ? 'Unpin' : 'Pin'}
									onClick={() => actions.onPin?.(message)}
								>
									{message.is_pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
								</Button>
							</Tip>
						)}
						{!thread && actions.onThread && (
							<Tip content="Reply in Thread">
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									aria-label="Reply in Thread"
									onClick={() => actions.onThread?.(message.id)}
								>
									<MessageSquare className="size-4" />
								</Button>
							</Tip>
						)}
						{mine && actions.onEdit && (
							<Tip content="Edit">
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									aria-label="Edit"
									onClick={() => setEditing(message.content)}
								>
									<Pencil className="size-4" />
								</Button>
							</Tip>
						)}
						{mine && actions.onDelete && (
							<Tip content="Delete">
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									aria-label="Delete"
									onClick={() => setConfirmDelete(true)}
								>
									<Trash2 className="size-4" />
								</Button>
							</Tip>
						)}
					</div>
				</div>
			)}

			{message.is_pinned && (
				<div className="ml-11 flex items-center gap-1 text-xs">
					<Pin className="size-3 text-warning" />
					<span className="text-muted-foreground">Pinned</span>
				</div>
			)}

			{replyTo?.user && (
				<Button
					type="button"
					variant="ghost"
					size="xs"
					className="mb-1 ml-12 h-auto min-w-0 justify-start gap-2 text-left font-normal"
					onClick={() => jumpTo(replyTo.id)}
				>
					<img src={authorImage(replyTo)} alt="" className="size-4 rounded-full object-cover" onError={fallbackImage} />
					<span className="shrink-0">{authorName(replyTo)}</span>
					<span className="text-muted-foreground line-clamp-1 flex-1 italic">{mentionsToText(replyTo.content)}</span>
				</Button>
			)}

			<div className="flex w-full">
				<div className="mr-1 w-9 shrink-0">
					{showAuthor ? (
						<img
							src={authorImage(message)}
							alt=""
							className="ml-0.5 size-8 translate-y-1 rounded-full object-cover"
							onError={fallbackImage}
						/>
					) : (
						message.created_at > 0 && (
							<Tip content={dayjs(message.created_at / 1_000_000).format('LLLL')}>
								<span className="text-muted-foreground mt-1.5 hidden text-caption group-hover:inline">
									{dayjs(message.created_at / 1_000_000).format('HH:mm')}
								</span>
							</Tip>
						)
					)}
				</div>

				<div className="w-0 flex-auto pl-2">
					{showAuthor && (
						<div className="flex items-baseline gap-1.5">
							<span className="truncate text-sm font-medium">{authorName(message)}</span>
							{message.created_at > 0 && (
								<Tip content={dayjs(message.created_at / 1_000_000).format('LLLL')}>
									<span className="text-muted-foreground text-xs">{timeLabel(message.created_at)}</span>
								</Tip>
							)}
						</div>
					)}

					{files.length > 0 && (
						<div className="my-2 flex flex-wrap gap-2">
							{files.map((file, i) => {
								const url = attachmentUrl(file, WEBUI_API_BASE_URL);
								const kind =
									file.type === 'image' || (file.content_type ?? '').startsWith('image/')
										? 'image'
										: file.type === 'video' || (file.content_type ?? '').startsWith('video/')
											? 'video'
											: 'file';
								return kind === 'image' ? (
									<a key={i} href={url} target="_blank" rel="noreferrer">
										<img src={url} alt={file.name ?? ''} className="max-h-96 rounded-lg" />
									</a>
								) : kind === 'video' ? (
									<video key={i} src={url} controls className="max-h-96 rounded-lg" />
								) : (
									<a
										key={i}
										href={url}
										target="_blank"
										rel="noreferrer"
										className="hover:bg-muted flex items-center gap-2 rounded-xl border px-3 py-2 text-sm"
									>
										<FileText className="size-4" />
										<span className="max-w-60 truncate">{file.name ?? 'File'}</span>
									</a>
								);
							})}
						</div>
					)}

					{editing !== null ? (
						<div className="py-2">
							<Textarea
								autoFocus
								aria-label="Edit message"
								value={editing}
								onChange={(e) => setEditing(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === 'Escape') setEditing(null);
									if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveEdit();
								}}
							/>
							<div className="mt-2 flex justify-end gap-1.5">
								<Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
									Cancel
								</Button>
								<Button size="sm" onClick={saveEdit}>
									Save
								</Button>
							</div>
						</div>
					) : (
						<>
							<div className={cn('min-w-full', pending && 'opacity-50')}>
								{message.data === true ? (
									<div className="bg-muted my-2 h-4 w-40 animate-pulse rounded" />
								) : !message.content.trim() && message.meta?.model_id ? (
									// A model reply is empty while it is under way, and "Thinking" until
									// done; one that finished with no text says so instead of spinning (#329).
									message.meta.done ? (
										files.length === 0 && <p className="text-muted-foreground my-0.5 text-sm italic">No response</p>
									) : (
										<div className="bg-muted my-1 h-4 w-24 animate-pulse rounded" aria-label="Thinking" />
									)
								) : (
									<div className="flex flex-wrap items-baseline">
										{/* The chat renderer, as the Svelte channel used: raw HTML in a message shows as text (docs/history/code-review.md H1). */}
										<Markdown
											id={`channel-${message.id}`}
											content={message.content}
											modelName={message.meta?.model_name}
											className="w-auto text-sm [&_p]:my-0.5"
										/>
										{edited && <span className="text-muted-foreground pl-1 text-caption">(edited)</span>}
									</div>
								)}
							</div>

							{(message.reactions ?? []).length > 0 && (
								<div className="mt-1 mb-2 flex flex-wrap items-center gap-1">
									{(message.reactions ?? []).map((r) => {
										const minePick = r.users.some((u) => u.id === me?.id);
										return (
											<Tip key={r.name} content={reactionTooltip(r, me?.id)}>
												<Button
													type="button"
													variant="secondary"
													size="sm"
													aria-label={`${r.name} ${r.users.length}`}
													aria-pressed={minePick}
													disabled={!actions.onReaction || disabled}
													onClick={() => actions.onReaction?.(message, r.name)}
													className={cn(
														'gap-1.5 rounded-xl',
														minePick && 'bg-brand/10 outline outline-1 outline-brand/50 hover:bg-brand/10'
													)}
												>
													<Emoji name={r.name} />
													<span className="text-muted-foreground text-xs">{r.users.length}</span>
												</Button>
											</Tip>
										);
									})}
									{actions.onReaction && !disabled && (
										<EmojiPicker onSubmit={(name) => actions.onReaction?.(message, name)}>
											<Button
												type="button"
												variant="secondary"
												size="icon-sm"
												className="rounded-xl"
												aria-label="Add another reaction"
											>
												<SmilePlus className="size-3.5" />
											</Button>
										</EmojiPicker>
									)}
								</div>
							)}

							{!thread && (message.reply_count ?? 0) > 0 && (
								<Button
									type="button"
									variant="ghost"
									size="xs"
									className="text-muted-foreground mb-1.5"
									onClick={() => actions.onThread?.(message.id)}
								>
									<span>
										{message.reply_count} {message.reply_count === 1 ? 'Reply' : 'Replies'}
									</span>
									{message.latest_reply_at ? (
										<span>- Last reply {dayjs(message.latest_reply_at / 1_000_000).fromNow()}</span>
									) : null}
									<ChevronRight className="size-3" />
								</Button>
							)}
						</>
					)}
				</div>
			</div>

			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title="Delete Message"
				confirmLabel="Delete"
				onConfirm={() => actions.onDelete?.(message)}
			>
				Are you sure you want to delete this message?
			</ConfirmDialog>
		</div>
	);
}
