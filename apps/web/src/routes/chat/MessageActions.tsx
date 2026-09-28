import { ChevronDown, Info, Pencil, PlayCircle, RotateCcw, Send, Sparkles, ThumbsDown, ThumbsUp, Trash2, Volume2, VolumeX, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { DISLIKE_REASONS, type FeedbackDetails, LIKE_REASONS, REASON_LABELS } from '@/lib/chat/feedback';
import { type History, type Message, canContinue, siblingsOf } from '@/lib/chat/history';
import { canChat } from '@/lib/chat/permissions';
import { isTemporaryChatId } from '@/lib/chat/request';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { cn } from '@/lib/utils';
import type { MessageHandlers } from './ChatMessages';
import { useChatPrefs } from './useChatPrefs';
import { useModels } from './useModels';
import { useReadAloud } from './useReadAloud';

const actionButton = 'text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg p-1.5 transition';

type Session = {
	chatId: string | null;
	history: History;
	editMessage: (m: Message, content: string, mode: 'save' | 'resend' | 'copy') => Promise<void>;
	removeMessage: (m: Message) => Promise<void>;
	continueReply: (m: Message) => Promise<void>;
	regenerate: (m: Message, suggestion?: string) => Promise<void>;
	rate: (m: Message, rating: number | null, details?: FeedbackDetails | null) => Promise<void>;
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
						Save As Copy
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

/** Ports RateComment.svelte: why, a 1-10 score and a comment, saved onto the rating. */
function RateComment({ message, onSave, onClose }: { message: Message; onSave: (d: FeedbackDetails) => void; onClose: () => void }) {
	const a = (message.annotation ?? {}) as { rating?: number; reason?: string; comment?: string; details?: { rating?: number | null } };
	const [reason, setReason] = useState(a.reason ?? '');
	const [score, setScore] = useState<number | null>(a.details?.rating ?? null);
	const [comment, setComment] = useState(a.comment ?? '');
	const reasons = a.rating === 1 ? LIKE_REASONS : a.rating === -1 ? DISLIKE_REASONS : [];
	return (
		<div className="my-2 rounded-2xl border p-3" data-testid="rate-comment">
			<div className="flex items-center justify-between">
				<span className="text-sm">How would you rate this response?</span>
				<button type="button" aria-label="Close feedback" className="text-muted-foreground" onClick={onClose}>
					<X className="size-4" />
				</button>
			</div>
			<div className="mt-2 flex flex-wrap gap-1" role="group" aria-label="Score">
				{Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
					<button key={n} type="button" aria-label={`Rate ${n} out of 10`} aria-pressed={score === n} className={cn('size-7 rounded-lg border text-xs', score === n && 'bg-foreground text-background')} onClick={() => setScore(n)}>
						{n}
					</button>
				))}
			</div>
			{reasons.length > 0 && (
				<>
					<div className="mt-2 text-sm">Why?</div>
					<div className="mt-1 flex flex-wrap gap-1">
						{reasons.map((r) => (
							<button key={r} type="button" aria-pressed={reason === r} className={cn('rounded-full border px-2.5 py-0.5 text-xs', reason === r && 'bg-foreground text-background')} onClick={() => setReason(r)}>
								{REASON_LABELS[r]}
							</button>
						))}
					</div>
				</>
			)}
			<Textarea className="mt-2" aria-label="Additional feedback comments" placeholder="Feel free to add specific details" value={comment} onChange={(e) => setComment(e.target.value)} />
			<div className="mt-2 flex justify-end">
				<Button size="sm" onClick={() => onSave({ reason, comment, tags: (message.annotation as { tags?: string[] } | undefined)?.tags ?? [], details: { rating: score } })}>
					Save
				</Button>
			</div>
		</div>
	);
}

function RegenerateButton({ message, session }: { message: Message; session: Session }) {
	return (
		<Tip content="Regenerate">
			<button type="button" aria-label="Regenerate" className={cn(actionButton, 'regenerate-response-button')} onClick={() => void session.regenerate(message)}>
				<RotateCcw className="size-3.5" />
			</button>
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
					<button type="button" aria-label="Regenerate options" className={cn(actionButton, 'px-0.5')}>
						<ChevronDown className="size-3" />
					</button>
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
						<Input placeholder="Suggest a change" aria-label="Suggest a change" value={suggestion} onChange={(e) => setSuggestion(e.target.value)} onKeyDown={(e) => e.stopPropagation()} className="h-8" />
					</form>
					<DropdownMenuSeparator />
					<DropdownMenuItem onSelect={() => void session.regenerate(message)}>Try Again</DropdownMenuItem>
					<DropdownMenuItem onSelect={() => void session.regenerate(message, 'Add Details')}>Add Details</DropdownMenuItem>
					<DropdownMenuItem onSelect={() => void session.regenerate(message, 'More Concise')}>More Concise</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

/**
 * Everything a message offers beyond Copy and versions, as the pieces
 * ChatMessages renders: Edit, Read Aloud, Good/Bad Response with the rating
 * form, Continue Response, the regenerate menu, and Delete, each behind the
 * chat permission the Svelte app checks.
 */
export function useMessageActions(session: Session): Pick<MessageHandlers, 'extraActions' | 'editing' | 'below' | 'regenerate'> {
	const user = useAuthStore((s) => s.user);
	const ratingOn = useConfigStore((s) => ((s.config?.features ?? {}) as Record<string, unknown>).enable_message_rating ?? true);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [ratingId, setRatingId] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<Message | null>(null);
	const { speakingId, speak, stop } = useReadAloud();
	const saved = Boolean(session.chatId) && !isTemporaryChatId(session.chatId);
	const prefs = useChatPrefs();
	const { models } = useModels();

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

	const extraActions = (m: Message, { isLast }: { isLast: boolean }) => {
		const reply = m.role === 'assistant';
		const rating = (m.annotation as { rating?: number } | undefined)?.rating;
		const canDelete = reply ? canChat(user, 'delete_message') : canChat(user, 'delete_user_message') && (m.parentId !== null || siblingsOf(session.history, m).length > 1);
		return (
			<>
				{(!reply || canChat(user, 'edit')) && (
					<Tip content="Edit">
						<button type="button" aria-label="Edit" className={actionButton} onClick={() => setEditingId(m.id)}>
							<Pencil className="size-3.5" />
						</button>
					</Tip>
				)}
				{reply && canChat(user, 'tts') && (
					<Tip content={speakingId === m.id ? 'Stop' : 'Read Aloud'}>
						<button type="button" aria-label={speakingId === m.id ? 'Stop reading' : 'Read Aloud'} className={actionButton} onClick={() => (speakingId === m.id ? stop() : void speak(m.id, m.content))}>
							{speakingId === m.id ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
						</button>
					</Tip>
				)}
				{reply && saved && ratingOn !== false && canChat(user, 'rate_response') && (
					<>
						<Tip content="Good Response">
							<button
								type="button"
								aria-label="Good Response"
								aria-pressed={rating === 1}
								className={cn(actionButton, rating === 1 && 'text-foreground bg-muted')}
								onClick={async () => {
									await session.rate(m, 1);
									setRatingId(m.id);
								}}
							>
								<ThumbsUp className="size-3.5" />
							</button>
						</Tip>
						<Tip content="Bad Response">
							<button
								type="button"
								aria-label="Bad Response"
								aria-pressed={rating === -1}
								className={cn(actionButton, rating === -1 && 'text-foreground bg-muted')}
								onClick={async () => {
									await session.rate(m, -1);
									setRatingId(m.id);
								}}
							>
								<ThumbsDown className="size-3.5" />
							</button>
						</Tip>
					</>
				)}
				{reply && m.usage && (
					<Tip content={<pre className="text-xs">{Object.entries(m.usage).filter(([, v]) => typeof v !== 'object').map(([k, v]) => `${k}: ${v}`).join('\n')}</pre>}>
						<button type="button" aria-label="Generation Info" className={actionButton}>
							<Info className="size-3.5" />
						</button>
					</Tip>
				)}
				{reply && isLast && canContinue(m) && canChat(user, 'continue_response') && (
					<Tip content="Continue Response">
						<button type="button" aria-label="Continue Response" className={actionButton} onClick={() => void session.continueReply(m)}>
							<PlayCircle className="size-3.5" />
						</button>
					</Tip>
				)}
				{/* The model's Action functions, a button each (ResponseMessage.svelte; docs/code-review.md M6). */}
				{reply &&
					(models.find((x) => x.id === m.model)?.actions ?? []).map((action) => (
						<Tip key={action.id} content={action.name}>
							<button type="button" aria-label={action.name} className={actionButton} onClick={() => void session.runAction(action.id, m)}>
								{action.icon ? <img src={action.icon} alt="" className={cn('size-3.5', action.icon.includes('data:image/svg') && 'dark:invert-[80%]')} draggable={false} /> : <Sparkles className="size-3.5" />}
							</button>
						</Tip>
					))}
				{canDelete && (
					<Tip content="Delete">
						<button type="button" aria-label="Delete" className={actionButton} onClick={() => setDeleting(m)}>
							<Trash2 className="size-3.5" />
						</button>
					</Tip>
				)}
				{deleting?.id === m.id && (
					<ConfirmDialog
						open
						onOpenChange={(o) => !o && setDeleting(null)}
						title="Delete message?"
						confirmLabel="Delete"
						onConfirm={async () => {
							setDeleting(null);
							await session.removeMessage(m);
						}}
					>
						This will delete this message and its replies.
					</ConfirmDialog>
				)}
			</>
		);
	};

	return {
		extraActions,
		editing: (m) => (m.id === editingId ? <EditBox message={m} session={session} onDone={() => setEditingId(null)} /> : null),
		below: (m) =>
			m.id === ratingId ? (
				<RateComment
					message={m}
					onClose={() => setRatingId(null)}
					onSave={async (d) => {
						setRatingId(null);
						await session.rate(m, null, d);
					}}
				/>
			) : null,
		regenerate: canChat(user, 'regenerate_response') ? (m) => (prefs.regenerateMenu ? <RegenerateMenu message={m} session={session} /> : <RegenerateButton message={m} session={session} />) : () => null
	};
}
