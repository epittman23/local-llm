import { ChevronLeft, ChevronRight, Copy, FileText, RotateCcw } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Markdown } from '@/components/chat/markdown/Markdown';
import { Tip } from '@/components/common/Tip';
import { type History, type Message, messagesList, replyColumns, showBranch, siblingsOf } from '@/lib/chat/history';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { removeAllDetails } from '@/lib/markdown/content';
import { useAuthStore } from '@/lib/stores/authStore';
import { cn, copyToClipboard } from '@/lib/utils';
import { formatSecondsTimestamp } from '@/lib/utils/dates';
import { citationsOf, sourceIdsOf, stripCitations } from '@/lib/chat/sources';
import { modelImage } from './ModelSelector';

export type MessageHandlers = {
	onBranch: (history: History) => void;
	onRegenerate: (m: Message) => void;
	onFollowUp: (text: string) => void;
	onSourceClick?: (m: Message, id: string | number) => void;
	onToolCallResolved?: () => void;
	/** Extra per-message actions (edit, rate, delete, ...), see MessageActions.tsx. */
	extraActions?: (m: Message, ctx: { isLast: boolean }) => ReactNode;
	/** Shown under a message's actions (the rating form). */
	below?: (m: Message) => ReactNode;
	/** Whether a model cites its sources (its `citations` capability); `[n]` markers are removed when not. */
	citationsFor?: (modelId: string | undefined) => boolean;
	/** Replaces the Regenerate button (the regenerate menu). */
	regenerate?: (m: Message) => ReactNode;
	/** Replaces a message's body while it is being edited. */
	editing?: (m: Message) => ReactNode | null;
	/** An html/svg code block's Preview button (the artifacts panel). */
	onPreview?: (code: string) => void;
};

const actionButton = 'text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg p-1.5 transition';

/** "‹ 2/3 ›" between regenerations or edits of a message. */
function SiblingNav({ history, message, onBranch }: { history: History; message: Message; onBranch: (h: History) => void }) {
	const siblings = siblingsOf(history, message);
	if (siblings.length < 2) return null;
	const i = siblings.indexOf(message.id);
	const go = (j: number) => onBranch(showBranch(history, siblings[Math.max(0, Math.min(siblings.length - 1, j))]));
	return (
		<div className="text-muted-foreground flex items-center text-xs" aria-label="Versions">
			<button type="button" aria-label="Previous version" className={actionButton} disabled={i <= 0} onClick={() => go(i - 1)}>
				<ChevronLeft className="size-3.5" />
			</button>
			<span>
				{i + 1}/{siblings.length}
			</span>
			<button type="button" aria-label="Next version" className={actionButton} disabled={i >= siblings.length - 1} onClick={() => go(i + 1)}>
				<ChevronRight className="size-3.5" />
			</button>
		</div>
	);
}

function CopyButton({ text, className }: { text: string; className?: string }) {
	return (
		<Tip content="Copy">
			<button type="button" aria-label="Copy" className={cn(actionButton, className)} onClick={() => void copyToClipboard(text)}>
				<Copy className="size-3.5" />
			</button>
		</Tip>
	);
}

function Attachments({ files }: { files: NonNullable<Message['files']> }) {
	return (
		<div className="flex flex-wrap justify-end gap-2">
			{files.map((f, i) =>
				f.type === 'image' || (f.content_type ?? '').startsWith('image/') ? (
					<img key={i} src={f.url?.startsWith('data') || f.url?.startsWith('http') ? f.url : `${WEBUI_API_BASE_URL}/files/${f.id}/content`} alt={f.name ?? ''} className="max-h-60 rounded-xl" />
				) : (
					<div key={i} className="flex items-center gap-2 rounded-xl border px-3 py-2 text-sm">
						<FileText className="size-4" />
						<span className="max-w-60 truncate">{f.name ?? 'File'}</span>
					</div>
				)
			)}
		</div>
	);
}

/** Ports chat/Messages/UserMessage.svelte: the prompt as a bubble, its attachments, versions and actions. */
function UserMessage({ history, message, h }: { history: History; message: Message; h: MessageHandlers }) {
	const edit = h.editing?.(message);
	return (
		<div className="group flex w-full flex-col items-end gap-1" data-testid="user-message" id={`message-${message.id}`}>
			{message.files?.length ? <Attachments files={message.files} /> : null}
			{edit ?? (
				<div className="bg-muted max-w-[90%] rounded-3xl px-4 py-2 whitespace-pre-wrap" dir="auto">
					{message.content}
				</div>
			)}
			{!edit && (
				<div className="flex items-center gap-0.5 opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100">
					<SiblingNav history={history} message={message} onBranch={h.onBranch} />
					{h.extraActions?.(message, { isLast: false })}
					<CopyButton text={message.content} />
				</div>
			)}
		</div>
	);
}

function StatusLine({ message }: { message: Message }) {
	const [open, setOpen] = useState(false);
	const shown = (message.statusHistory ?? []).filter((s) => !s.hidden);
	const last = shown.at(-1);
	if (!last) return null;
	return (
		<div className="mb-1 text-sm">
			<button type="button" className={cn('text-muted-foreground', !last.done && 'animate-pulse')} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
				{String(last.description ?? '')}
			</button>
			{open && shown.length > 1 && (
				<ul className="text-muted-foreground mt-1 border-l-2 pl-3 text-xs">
					{shown.map((s, i) => (
						<li key={i}>{String(s.description ?? '')}</li>
					))}
				</ul>
			)}
		</div>
	);
}

/** Ports Citations.svelte's list: "N Sources", expanding to one numbered button per source. */
function Sources({ message, onOpen }: { message: Message; onOpen: (n: number) => void }) {
	const [open, setOpen] = useState(false);
	const citations = citationsOf(message.sources);
	if (!citations.length) return null;
	return (
		<div className="my-1">
			<button type="button" className="text-muted-foreground hover:text-foreground text-xs" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
				{citations.length === 1 ? '1 Source' : `${citations.length} Sources`}
			</button>
			{open && (
				<div className="mt-1 flex flex-wrap gap-1" aria-label="Sources">
					{citations.map((c, i) => (
						<button key={c.id} type="button" className="bg-muted hover:bg-muted/70 max-w-60 truncate rounded-xl px-2 py-0.5 text-xs" onClick={() => onOpen(i + 1)}>
							<span className="text-muted-foreground mr-1">{i + 1}</span>
							{String(c.source?.name ?? c.id)}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

/**
 * Ports chat/Messages/ResponseMessage.svelte (the parts every reply needs):
 * model name and time, live status, the Markdown body, an error, its sources,
 * suggested follow-ups, versions, Copy and Regenerate.
 */
export function ResponseMessage({ history, message, h, isLast, chatId, compact = false, citationsEnabled = true }: { history: History; message: Message; h: MessageHandlers; isLast: boolean; chatId: string | null; compact?: boolean; citationsEnabled?: boolean }) {
	const userId = useAuthStore((s) => s.user?.id);
	const sourceIds = sourceIdsOf(message.sources, citationsEnabled);
	const edit = h.editing?.(message);
	const empty = !message.content && !message.error && !message.output?.length;
	return (
		<div className="group flex w-full gap-3" data-testid="response-message" id={`message-${message.id}`}>
			{!compact && <img src={modelImage(message.model ?? '')} alt="" className="mt-1 size-7 shrink-0 rounded-full object-cover" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />}
			<div className="min-w-0 flex-1">
				<div className="flex items-baseline gap-2">
					<span className="text-sm font-medium">{message.modelName ?? message.model}</span>
					{message.timestamp ? <span className="text-muted-foreground invisible text-xs group-hover:visible">{formatSecondsTimestamp(message.timestamp)}</span> : null}
				</div>
				<StatusLine message={message} />
				{edit ??
					(empty && !message.done ? (
						<div className="flex gap-1 py-3" aria-label="Loading">
							<span className="bg-muted-foreground/40 size-2 animate-bounce rounded-full" />
							<span className="bg-muted-foreground/40 size-2 animate-bounce rounded-full [animation-delay:150ms]" />
							<span className="bg-muted-foreground/40 size-2 animate-bounce rounded-full [animation-delay:300ms]" />
						</div>
					) : (
						<Markdown
							id={message.id}
							content={citationsEnabled ? message.content : stripCitations(message.content)}
							done={message.done !== false}
							modelName={message.modelName}
							chatId={chatId ?? undefined}
							messageId={message.id}
							resolvable={Boolean(chatId) && message.role === 'assistant' && userId !== undefined}
							sourceIds={sourceIds}
							onSourceClick={(id) => h.onSourceClick?.(message, id)}
							onToolCallResolved={h.onToolCallResolved}
							onPreview={message.role === 'assistant' ? h.onPreview : undefined}
						/>
					))}
				{message.error ? (
					<div className="border-destructive/40 bg-destructive/5 text-destructive my-2 rounded-xl border px-3 py-2 text-sm whitespace-pre-wrap" role="alert">
						{typeof message.error.content === 'string' ? message.error.content : 'Uh-oh! There was an issue with the response.'}
					</div>
				) : null}
				<Sources message={message} onOpen={(n) => h.onSourceClick?.(message, n)} />
				{message.done !== false && !edit && (
					<div className={cn('flex flex-wrap items-center gap-0.5', !isLast && 'opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100')}>
						<SiblingNav history={history} message={message} onBranch={h.onBranch} />
						<CopyButton text={removeAllDetails(message.content)} className="copy-response-button" />
						{h.extraActions?.(message, { isLast })}
						{h.regenerate ? (
							h.regenerate(message)
						) : (
							<Tip content="Regenerate">
								<button type="button" aria-label="Regenerate" className={cn(actionButton, 'regenerate-response-button')} onClick={() => h.onRegenerate(message)}>
									<RotateCcw className="size-3.5" />
								</button>
							</Tip>
						)}
					</div>
				)}
				{h.below?.(message)}
				{isLast && message.done && message.followUps?.length ? (
					<div className="mt-2 flex flex-col items-start gap-1" aria-label="Follow-ups">
						<span className="text-muted-foreground text-xs">Follow up</span>
						{message.followUps.map((f, i) => (
							<button key={i} type="button" className="text-muted-foreground hover:text-foreground text-left text-sm" onClick={() => h.onFollowUp(f)}>
								{f}
							</button>
						))}
					</div>
				) : null}
			</div>
		</div>
	);
}

/** Ports MultiResponseMessages.svelte: one column per model, each with its own versions; clicking a column continues from it. */
function MultiResponse({ history, parentId, h, chatId, isLast }: { history: History; parentId: string; h: MessageHandlers; chatId: string | null; isLast: boolean }) {
	const columns = replyColumns(history, parentId);
	const currentPath = new Set(messagesList(history, history.currentId).map((m) => m.id));
	return (
		<div className="flex w-full snap-x gap-3 overflow-x-auto pb-1" data-testid="multi-response">
			{columns.map((col) => {
				const id = col.messageIds[col.selected];
				const m = history.messages[id];
				const active = currentPath.has(id);
				return (
					<div
						key={col.modelIdx}
						className={cn('min-w-80 flex-1 snap-center rounded-2xl border p-3 transition', active ? 'border-foreground/30' : 'cursor-pointer opacity-80 hover:opacity-100')}
						onClick={() => !active && h.onBranch(showBranch(history, id))}
					>
						<ResponseMessage history={history} message={m} h={h} chatId={chatId} isLast={isLast && active} compact citationsEnabled={h.citationsFor?.(m.model) ?? true} />
					</div>
				);
			})}
		</div>
	);
}

/** Ports chat/Messages.svelte: the current path through the conversation. */
export function ChatMessages({ history, h, chatId }: { history: History; h: MessageHandlers; chatId: string | null }) {
	const path = messagesList(history, history.currentId);
	const rendered = new Set<string>();
	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
			{path.map((m, i) => {
				const isLast = i === path.length - 1;
				if (m.role === 'user') return <UserMessage key={m.id} history={history} message={m} h={h} />;
				const parent = m.parentId ? history.messages[m.parentId] : null;
				if (parent && (parent.models?.length ?? 0) > 1) {
					if (rendered.has(parent.id)) return null;
					rendered.add(parent.id);
					return <MultiResponse key={`multi-${parent.id}`} history={history} parentId={parent.id} h={h} chatId={chatId} isLast={isLast} />;
				}
				return <ResponseMessage key={m.id} history={history} message={m} h={h} chatId={chatId} isLast={isLast} citationsEnabled={h.citationsFor?.(m.model) ?? true} />;
			})}
		</div>
	);
}
