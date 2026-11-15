import {
	ChevronDown,
	MoreHorizontal,
	NotebookPen,
	Pencil,
	PlayCircle,
	RotateCcw,
	Send,
	Sparkles,
	ThumbsDown,
	ThumbsUp,
	Trash2,
	Volume2,
	VolumeX,
	X
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { FeedbackDetails } from '@/lib/chat/feedback';
import { canContinue, type History, type Message, siblingsOf } from '@/lib/chat/history';
import { canChat } from '@/lib/chat/permissions';
import { isTemporaryChatId } from '@/lib/chat/request';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { cn } from '@/lib/utils';
import type { ExtraActionsContext, MessageHandlers } from './ChatMessages';
import { GenerationInfo } from './GenerationInfo';
import { useChatPrefs } from './useChatPrefs';
import { useModels } from './useModels';
import { useReadAloud } from './useReadAloud';

type Session = {
	chatId: string | null;
	history: History;
	editMessage: (m: Message, content: string, mode: 'save' | 'resend' | 'copy') => Promise<void>;
	removeMessage: (m: Message) => Promise<void>;
	continueReply: (m: Message) => Promise<void>;
	regenerate: (m: Message, suggestion?: string) => Promise<void>;
	rate: (m: Message, rating: number | null, details?: FeedbackDetails | null) => Promise<void>;
	unrate: (m: Message) => Promise<void>;
	/** Replies whose rating is being saved or removed. */
	ratingIds: ReadonlySet<string>;
	runAction: (actionId: string, m: Message) => Promise<void>;
};

/** An inline editor for a message (UserMessage/ResponseMessage.svelte's edit mode). */
function EditBox({ message, onDone, session }: { message: Message; onDone: () => void; session: Session }) {
	const [text, setText] = useState(message.content);
	const user = message.role === 'user';
	const run = async (mode: 'save' | 'resend' | 'copy') => {
		onDone();
		await session.editMessage(message, text, mode);
	};
	return (
		<div className="bg-muted/40 w-full rounded-2xl p-3" data-testid="message-editor">
			<Textarea
				autoFocus
				aria-label="Edit message"
				value={text}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Escape') onDone();
					if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void run(user ? 'resend' : 'save');
				}}
				className="min-h-24 border-0 bg-transparent shadow-none focus-visible:ring-0"
			/>
			<div className="mt-2 flex items-center justify-between gap-2">
				{!user ? (
					<Button size="sm" variant="ghost" onClick={() => void run('copy')}>
						Save as copy
					</Button>
				) : (
					<span />
				)}
				<div className="flex gap-1.5">
					<Button size="sm" variant="ghost" onClick={onDone}>
						Cancel
					</Button>
					{user ? (
						<>
							<Button size="sm" variant="outline" onClick={() => void run('save')}>
								Save
							</Button>
							<Button size="sm" onClick={() => void run('resend')} disabled={!text.trim() && !message.files?.length}>
								<Send className="size-3.5" /> Send
							</Button>
						</>
					) : (
						<Button size="sm" onClick={() => void run('save')}>
							Save
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}

/**
 * The note on a rating (S3-D2): a comment box and nothing else. Ports what is
 * left of RateComment.svelte; the 1-10 score and the canned reasons are no
 * longer asked, and what a stored rating already holds is kept.
 */
function RateNote({
	message,
	busy,
	onSave,
	onClose
}: {
	message: Message;
	/** The rating is being saved or removed: the note waits for it (ACT-5). */
	busy: boolean;
	onSave: (comment: string) => void;
	onClose: () => void;
}) {
	const [comment, setComment] = useState(((message.annotation ?? {}) as { comment?: string }).comment ?? '');
	return (
		<div
			className="border-border-divider bg-surface-1 my-2 flex flex-col gap-2 rounded-panel border p-3"
			data-testid="rate-note"
		>
			<div className="flex items-center justify-between gap-2">
				<label htmlFor={`note-${message.id}`} className="text-body font-strong">
					Note on your rating
				</label>
				<Tip content="Close note">
					<Button type="button" aria-label="Close note" variant="ghost" size="icon-xs" onClick={onClose}>
						<X className="size-4" aria-hidden />
					</Button>
				</Tip>
			</div>
			<Textarea
				id={`note-${message.id}`}
				autoFocus
				placeholder="What was good or bad about it"
				value={comment}
				onChange={(e) => setComment(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Escape') onClose();
				}}
			/>
			<div className="flex justify-end">
				<Button size="sm" variant="outline" disabled={busy} onClick={() => onSave(comment)}>
					Save note
				</Button>
			</div>
		</div>
	);
}

function RegenerateButton({ message, session }: { message: Message; session: Session }) {
	return (
		<Tip content="Regenerate">
			<Button
				type="button"
				aria-label="Regenerate"
				variant="ghost"
				size="icon-sm"
				className="regenerate-response-button"
				onClick={() => void session.regenerate(message)}
			>
				<RotateCcw className="size-3.5" />
			</Button>
		</Tip>
	);
}

/** Ports ResponseMessage/RegenerateMenu.svelte: Try Again, Add Details, More Concise, or a suggestion of your own. */
function RegenerateMenu({ message, session }: { message: Message; session: Session }) {
	const [suggestion, setSuggestion] = useState('');
	return (
		<div className="flex items-center">
			<RegenerateButton message={message} session={session} />
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button type="button" aria-label="Regenerate options" variant="ghost" size="icon-xs">
						<ChevronDown className="size-3" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="w-60">
					<form
						className="p-1"
						onSubmit={(e) => {
							e.preventDefault();
							if (!suggestion.trim()) return;
							void session.regenerate(message, suggestion.trim());
							setSuggestion('');
						}}
					>
						<Input
							placeholder="Suggest a change"
							aria-label="Suggest a change"
							value={suggestion}
							onChange={(e) => setSuggestion(e.target.value)}
							onKeyDown={(e) => e.stopPropagation()}
							className="h-8"
						/>
					</form>
					<DropdownMenuSeparator />
					<DropdownMenuItem onSelect={() => void session.regenerate(message)}>Try again</DropdownMenuItem>
					{/* The suggestion is sent to the model as written: only the label is sentence case. */}
					<DropdownMenuItem onSelect={() => void session.regenerate(message, 'Add Details')}>
						Add details
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={() => void session.regenerate(message, 'More Concise')}>
						More concise
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

/**
 * Everything a message offers beyond Copy, Regenerate and versions, as the
 * pieces ChatMessages renders, each behind the chat permission the Svelte app
 * checks. A reply shows its thumbs (when rating is on), their note and
 * Generation info; Edit, Read aloud, Continue, the model's own actions and
 * Delete are in its "More actions" menu (#995, OVL-3, ACT-3). A prompt shows
 * Edit and Delete.
 */
export function useMessageActions(
	session: Session
): Pick<MessageHandlers, 'extraActions' | 'editing' | 'below' | 'regenerate' | 'onRetry' | 'onContinue'> {
	const user = useAuthStore((s) => s.user);
	const ratingOn = useConfigStore(
		(s) => ((s.config?.features ?? {}) as Record<string, unknown>).enable_message_rating ?? true
	);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [noteId, setNoteId] = useState<string | null>(null);
	// The thumb last pressed: it shows the spinner while its reply's rating is saved (ACT-5).
	const [pressedThumb, setPressedThumb] = useState<{ id: string; value: 1 | -1 } | null>(null);
	const [deleting, setDeleting] = useState<Message | null>(null);
	const { speakingId, speak, stop } = useReadAloud();
	const saved = Boolean(session.chatId) && !isTemporaryChatId(session.chatId);
	const prefs = useChatPrefs();
	const { models } = useModels();
	// Edit, chosen in the menu, puts focus in the editor: the menu must not take it back to its (removed) button.
	const keepFocus = useRef(false);

	// "Auto-Playback Response": a reply that finishes streaming in this session
	// is read aloud (Chat.svelte clicked its speak button on `done`); one that
	// was already done when the chat loaded is not.
	const streamingId = useRef<string | null>(null);
	const current = session.history.currentId ? session.history.messages[session.history.currentId] : null;
	useEffect(() => {
		if (current?.role !== 'assistant') return;
		if (!current.done) {
			streamingId.current = current.id;
			return;
		}
		if (streamingId.current !== current.id) return;
		streamingId.current = null;
		if (prefs.autoPlayback && canChat(user, 'tts')) void speak(current.id, current.content);
		// Only when the current reply or its done flag changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [current?.id, current?.done]);

	const deleteDialog = (m: Message) =>
		deleting?.id === m.id && (
			<ConfirmDialog
				open
				onOpenChange={(o) => !o && setDeleting(null)}
				title="Delete message?"
				confirmLabel="Delete message"
				destructive
				onConfirm={async () => {
					setDeleting(null);
					await session.removeMessage(m);
				}}
			>
				{m.role === 'assistant'
					? 'This reply and everything after it are deleted.'
					: 'This message and the replies under it are deleted.'}
			</ConfirmDialog>
		);

	const extraActions = (m: Message, { isLast, errorOnly = false, cutOff = false }: ExtraActionsContext) => {
		const reply = m.role === 'assistant';
		const rating = (m.annotation as { rating?: number } | undefined)?.rating;
		const canDelete = reply
			? canChat(user, 'delete_message')
			: canChat(user, 'delete_user_message') && (m.parentId !== null || siblingsOf(session.history, m).length > 1);
		const canEdit = (!reply || canChat(user, 'edit')) && !errorOnly;
		if (!reply)
			return (
				<>
					{canEdit && (
						<Tip content="Edit">
							<Button type="button" aria-label="Edit" variant="ghost" size="icon-sm" onClick={() => setEditingId(m.id)}>
								<Pencil className="size-3.5" />
							</Button>
						</Tip>
					)}
					{canDelete && (
						<Tip content="Delete">
							<Button type="button" aria-label="Delete" variant="ghost" size="icon-sm" onClick={() => setDeleting(m)}>
								<Trash2 className="size-3.5" />
							</Button>
						</Tip>
					)}
					{deleteDialog(m)}
				</>
			);

		const rates = !errorOnly && saved && ratingOn !== false && canChat(user, 'rate_response');
		// S3-D2: a thumb saves at once and says so; the other thumb switches the rating, and
		// pressing the given one again removes it, with its note (S3-D2b). While either call is
		// pending both thumbs wait, so a second press cannot add a second rating (ACT-5).
		const busy = session.ratingIds.has(m.id);
		const thumb = (value: 1 | -1) => {
			const given = rating === value;
			const spinning = busy && pressedThumb?.id === m.id && pressedThumb.value === value;
			const name = spinning
				? given
					? 'Removing rating…'
					: 'Saving rating…'
				: value === 1
					? given
						? 'Rated good'
						: 'Good response'
					: given
						? 'Rated bad'
						: 'Bad response';
			return (
				<Tip content={name}>
					<Button
						type="button"
						aria-label={name}
						aria-pressed={given}
						aria-busy={spinning || undefined}
						disabled={busy}
						variant="ghost"
						size="icon-sm"
						className={cn(given && 'text-foreground bg-muted')}
						onClick={() => {
							setPressedThumb({ id: m.id, value });
							if (!given) return void session.rate(m, value);
							if (noteId === m.id) setNoteId(null);
							void session.unrate(m);
						}}
					>
						{spinning ? (
							<Spinner className="size-3.5" />
						) : value === 1 ? (
							<ThumbsUp className="size-3.5" />
						) : (
							<ThumbsDown className="size-3.5" />
						)}
					</Button>
				</Tip>
			);
		};
		const hasNote = Boolean((m.annotation as { comment?: string } | undefined)?.comment);
		const tts = !errorOnly && canChat(user, 'tts');
		const canContinueHere = isLast && !cutOff && canContinue(m) && canChat(user, 'continue_response');
		const actions = models.find((x) => x.id === m.model)?.actions ?? [];
		const menu = canEdit || tts || canContinueHere || actions.length > 0 || canDelete;
		return (
			<>
				{rates && (
					<>
						{thumb(1)}
						{thumb(-1)}
						{(rating === 1 || rating === -1) && (
							<Button
								type="button"
								variant="ghost"
								size="xs"
								aria-expanded={noteId === m.id}
								onClick={() => setNoteId(m.id)}
							>
								<NotebookPen data-icon="inline-start" aria-hidden />
								{/* On a phone the icon alone, so the row stays one line; the words still name it. */}
								<span className="max-sm:sr-only">{hasNote ? 'Edit note' : 'Add a note'}</span>
							</Button>
						)}
					</>
				)}
				{m.usage && <GenerationInfo usage={m.usage} />}
				{menu && (
					<DropdownMenu>
						<Tip content="More actions">
							<DropdownMenuTrigger asChild>
								<Button type="button" aria-label="More actions" variant="ghost" size="icon-sm">
									<MoreHorizontal className="size-3.5" aria-hidden />
								</Button>
							</DropdownMenuTrigger>
						</Tip>
						<DropdownMenuContent
							align="start"
							className="w-auto min-w-44"
							onCloseAutoFocus={(e) => {
								if (keepFocus.current) e.preventDefault();
								keepFocus.current = false;
							}}
						>
							{canEdit && (
								<DropdownMenuItem
									onSelect={() => {
										keepFocus.current = true;
										setEditingId(m.id);
									}}
								>
									<Pencil aria-hidden />
									Edit
								</DropdownMenuItem>
							)}
							{tts && (
								<DropdownMenuItem onSelect={() => (speakingId === m.id ? stop() : void speak(m.id, m.content))}>
									{speakingId === m.id ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}
									{speakingId === m.id ? 'Stop reading' : 'Read aloud'}
								</DropdownMenuItem>
							)}
							{canContinueHere && (
								<DropdownMenuItem onSelect={() => void session.continueReply(m)}>
									<PlayCircle aria-hidden />
									Continue
								</DropdownMenuItem>
							)}
							{/* The model's Action functions (ResponseMessage.svelte; docs/history/code-review.md M6). */}
							{actions.map((action) => (
								<DropdownMenuItem key={action.id} onSelect={() => void session.runAction(action.id, m)}>
									{action.icon ? (
										<img
											src={action.icon}
											alt=""
											className={cn('size-4', action.icon.includes('data:image/svg') && 'dark:invert-[80%]')}
											draggable={false}
										/>
									) : (
										<Sparkles aria-hidden />
									)}
									{action.name}
								</DropdownMenuItem>
							))}
							{canDelete && (canEdit || tts || canContinueHere || actions.length > 0) && <DropdownMenuSeparator />}
							{canDelete && (
								<DropdownMenuItem variant="destructive" onSelect={() => setDeleting(m)}>
									<Trash2 aria-hidden />
									Delete
								</DropdownMenuItem>
							)}
						</DropdownMenuContent>
					</DropdownMenu>
				)}
				{deleteDialog(m)}
			</>
		);
	};

	return {
		extraActions,
		editing: (m) =>
			m.id === editingId ? <EditBox message={m} session={session} onDone={() => setEditingId(null)} /> : null,
		below: (m) =>
			m.id === noteId ? (
				<RateNote
					message={m}
					busy={session.ratingIds.has(m.id)}
					onClose={() => setNoteId(null)}
					onSave={async (comment) => {
						setNoteId(null);
						await session.rate(m, null, { comment });
					}}
				/>
			) : null,
		regenerate: canChat(user, 'regenerate_response')
			? (m) =>
					prefs.regenerateMenu ? (
						<RegenerateMenu message={m} session={session} />
					) : (
						<RegenerateButton message={m} session={session} />
					)
			: () => null,
		onRetry: canChat(user, 'regenerate_response') ? (m) => void session.regenerate(m) : undefined,
		onContinue: canChat(user, 'continue_response') ? (m) => void session.continueReply(m) : undefined
	};
}
