import { useQuery } from '@tanstack/react-query';
import { ArrowUp, BookOpen, FileText, Globe, Image as ImageIcon, Loader2, Square, X } from 'lucide-react';
import { type ReactNode, forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Tip } from '@/components/common/Tip';
import { searchKnowledgeBases, searchKnowledgeFiles } from '@/lib/apis/knowledge';
import { getPrompts } from '@/lib/apis/prompts';
import {
	commandAt,
	fillPromptVariables,
	isImageFile,
	isUrl,
	replaceCommand,
	replaceInputVariables
} from '@/lib/chat/attachments';
import type { ChatFile } from '@/lib/chat/history';
import { PASTED_TEXT_LIMIT } from '@/lib/chat/prefs';
import { promptVariables } from '@/lib/chat/request';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useAuthStore } from '@/lib/stores/authStore';
import { cn } from '@/lib/utils';
import { extractInputVariables } from '@/lib/utils/variables';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';
import { InputVariablesDialog } from './InputVariablesDialog';
import { modelImage } from './ModelSelector';
import type { ChatModel } from './useModels';

export type ChatInputHandle = { focus: () => void; setText: (text: string) => void };

type Prompt = { command: string; content: string; title?: string; name?: string };
type Suggestion =
	| { kind: 'prompt'; key: string; label: string; detail: string; prompt: Prompt }
	| { kind: 'item'; key: string; label: string; detail: string; item: ChatFile }
	| { kind: 'web'; key: string; label: string; detail: string; url: string }
	| { kind: 'model'; key: string; label: string; detail: string; model: ChatModel };

function FileChip({ file, onRemove }: { file: ChatFile; onRemove: () => void }) {
	const uploading = file.status === 'uploading';
	const image = isImageFile(file);
	const icon = uploading ? (
		<Loader2 className="size-3.5 animate-spin" />
	) : image ? (
		<ImageIcon className="size-3.5" />
	) : file.type === 'collection' ? (
		<BookOpen className="size-3.5" />
	) : file.type === 'text' && file.url ? (
		<Globe className="size-3.5" />
	) : (
		<FileText className="size-3.5" />
	);
	return (
		<div
			className="bg-muted/50 flex max-w-56 items-center gap-1.5 rounded-xl border px-2 py-1 text-xs"
			data-testid="input-file"
		>
			{icon}
			<span className="truncate">{String(file.name ?? 'File')}</span>
			<button type="button" aria-label={`Remove ${String(file.name ?? 'file')}`} onClick={onRemove}>
				<X className="size-3" />
			</button>
		</div>
	);
}

/**
 * The chat's message box (chat/MessageInput.svelte, in its plain-text mode
 * -- the one the Svelte app uses when "Rich Text Input" is off). Enter sends
 * and Shift+Enter is a new line; with "Ctrl+Enter to send" on, those swap.
 * Typing `/` at the start offers the user's prompts (their `{{variables}}`
 * filled from the user's details, or asked for), `#` knowledge and web pages,
 * `@` a model to answer just this message. While a reply is being written
 * the button stops it, and anything sent meanwhile is listed as queued.
 */
export const ChatInput = forwardRef<
	ChatInputHandle,
	{
		onSubmit: (text: string, files: ChatFile[]) => boolean;
		onStop: () => void;
		generating: boolean;
		queued: { id: string; prompt: string }[];
		onRemoveQueued: (id: string) => void;
		placeholder?: string;
		toolbar?: ReactNode;
		files?: ChatFile[];
		onRemoveFile?: (itemId: string) => void;
		onAddItem?: (item: ChatFile) => void;
		onAddWeb?: (urls: string[]) => void;
		onPasteFiles?: (files: File[]) => void;
		models?: ChatModel[];
		atModel?: ChatModel | null;
		onAtModel?: (m: ChatModel | null) => void;
		/** Widescreen mode: the input spans the page, like the messages. */
		wide?: boolean;
		/** Set when "Paste Large Text as File" is on: long pasted text arrives here as a .txt file. */
		onPasteText?: (file: File) => void;
		/** Nothing can be typed or sent (the chat is still loading). */
		disabled?: boolean;
	}
>(function ChatInput(
	{
		onSubmit,
		onStop,
		generating,
		queued,
		onRemoveQueued,
		placeholder = 'Send a Message',
		toolbar,
		files = [],
		onRemoveFile,
		onAddItem,
		onAddWeb,
		onPasteFiles,
		models = [],
		atModel,
		onAtModel,
		wide = false,
		onPasteText,
		disabled = false
	},
	ref
) {
	const token = useAuthStore((s) => s.token) ?? '';
	const user = useAuthStore((s) => s.user);
	const [text, setText] = useState('');
	const [cursor, setCursor] = useState(0);
	const [selected, setSelected] = useState(0);
	const [dismissed, setDismissed] = useState<string | null>(null);
	const [variables, setVariables] = useState<{ vars: Record<string, any>; text: string } | null>(null);
	const area = useRef<HTMLTextAreaElement>(null);
	const { settings } = useUserSettings();
	const ctrlEnter = Boolean((settings as Record<string, unknown> | null)?.ctrlEnterToSend);
	useImperativeHandle(ref, () => ({ focus: () => area.current?.focus(), setText: (t) => setText(t) }));

	const command = commandAt(text, cursor);
	const active = command && `${command.trigger}${command.start}` !== dismissed ? command : null;
	const q = useDebouncedValue(active?.query ?? '', 150);

	const prompts = useQuery({
		queryKey: ['prompts-all'],
		enabled: active?.trigger === '/',
		staleTime: 60_000,
		queryFn: async () => {
			const res = await getPrompts(token).catch(() => null);
			return (Array.isArray(res) ? res : []) as Prompt[];
		}
	});
	const knowledge = useQuery({
		queryKey: ['chat-knowledge-suggest', q],
		enabled: active?.trigger === '#' && !isUrl(q),
		staleTime: 30_000,
		queryFn: async () => {
			const [bases, fileRes] = await Promise.all([
				searchKnowledgeBases(token, q || null).catch(() => null),
				searchKnowledgeFiles(token, q || null).catch(() => null)
			]);
			return [
				...((Array.isArray(bases?.items) ? bases.items : []) as any[]).map((b) => ({ ...b, type: 'collection' })),
				...((Array.isArray(fileRes?.items) ? fileRes.items : []) as any[]).map((f) => ({
					...f,
					type: 'file',
					name: f.filename
				}))
			] as ChatFile[];
		}
	});

	const suggestions: Suggestion[] = useMemo(() => {
		if (!active) return [];
		const query = active.query.toLowerCase();
		if (active.trigger === '/')
			return (prompts.data ?? [])
				.filter(
					(p) =>
						p.command.replace(/^\//, '').toLowerCase().includes(query) ||
						(p.title ?? p.name ?? '').toLowerCase().includes(query)
				)
				.slice(0, 20)
				.map((p) => ({
					kind: 'prompt',
					key: p.command,
					label: `/${p.command.replace(/^\//, '')}`,
					detail: p.title ?? p.name ?? '',
					prompt: p
				}));
		if (active.trigger === '@')
			return models
				.filter(
					(m) => !m.info?.meta?.hidden && (m.name.toLowerCase().includes(query) || m.id.toLowerCase().includes(query))
				)
				.slice(0, 20)
				.map((m) => ({ kind: 'model', key: m.id, label: m.name, detail: 'Model', model: m }));
		if (isUrl(active.query))
			return [
				{
					kind: 'web',
					key: active.query,
					label: active.query,
					detail: /youtube\.com|youtu\.be/.test(active.query) ? 'YouTube' : 'Web page',
					url: active.query
				}
			];
		return (knowledge.data ?? []).slice(0, 20).map((item) => ({
			kind: 'item',
			key: `${item.type}-${item.id}`,
			label: String(item.name ?? ''),
			detail: item.type === 'collection' ? 'Collection' : 'File',
			item
		}));
	}, [active, prompts.data, models, knowledge.data]);

	useEffect(() => setSelected(0), [active?.trigger, active?.query]);

	const place = (next: string, pos: number) => {
		setText(next);
		requestAnimationFrame(() => {
			area.current?.focus();
			area.current?.setSelectionRange(pos, pos);
			setCursor(pos);
		});
	};

	const pick = async (s: Suggestion) => {
		if (!active) return;
		const cleared = replaceCommand(text, active.start, cursor, '');
		if (s.kind === 'prompt') {
			let content = fillPromptVariables(s.prompt.content, promptVariables(user));
			if (content.includes('{{CLIPBOARD}}')) {
				const clip = await navigator.clipboard.readText().catch(() => {
					toast.error('Failed to read clipboard contents');
					return '{{CLIPBOARD}}';
				});
				content = content.replaceAll('{{CLIPBOARD}}', clip.replaceAll('\r\n', '\n'));
			}
			const next = replaceCommand(text, active.start, cursor, content);
			place(next, active.start + content.length);
			const vars = extractInputVariables(content);
			if (Object.keys(vars).length) setVariables({ vars, text: next });
			return;
		}
		place(cleared, active.start);
		if (s.kind === 'item') onAddItem?.(s.item);
		if (s.kind === 'web') onAddWeb?.([s.url]);
		if (s.kind === 'model') onAtModel?.(s.model);
	};

	const uploading = files.some((f) => f.status === 'uploading');
	const submit = () => {
		if (uploading || disabled) return;
		if (onSubmit(text, files)) {
			setText('');
			setCursor(0);
			area.current?.focus();
		}
	};

	return (
		<div className={cn('mx-auto w-full px-2.5 pb-3', wide ? 'max-w-none' : 'max-w-3xl')}>
			{queued.length > 0 && (
				<ul className="mb-1.5 flex flex-col gap-1" aria-label="Queued messages">
					{queued.map((qd) => (
						<li key={qd.id} className="bg-muted/50 flex items-center gap-2 rounded-xl px-3 py-1.5 text-xs">
							<span className="text-muted-foreground">Queued</span>
							<span className="truncate">{qd.prompt}</span>
							<button
								type="button"
								aria-label="Remove queued message"
								className="ml-auto"
								onClick={() => onRemoveQueued(qd.id)}
							>
								<X className="size-3" />
							</button>
						</li>
					))}
				</ul>
			)}
			<div className="relative">
				{active && suggestions.length > 0 && (
					<div
						role="listbox"
						aria-label="Suggestions"
						className="bg-popover absolute bottom-full left-0 z-30 mb-2 max-h-72 w-full max-w-md overflow-y-auto rounded-xl border p-1 shadow-lg"
					>
						{suggestions.map((s, i) => (
							<button
								key={s.key}
								type="button"
								role="option"
								aria-selected={i === selected}
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => void pick(s)}
								className={cn(
									'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm',
									i === selected && 'bg-muted'
								)}
							>
								{s.kind === 'model' && (
									<img
										src={modelImage(s.model.id)}
										alt=""
										className="size-5 rounded-full object-cover"
										onError={(e) => (e.currentTarget.style.visibility = 'hidden')}
									/>
								)}
								<span className="truncate">{s.label}</span>
								<span className="text-muted-foreground ml-auto shrink-0 truncate text-xs">{s.detail}</span>
							</button>
						))}
					</div>
				)}
				<div className="bg-background rounded-3xl border px-3 py-2 shadow-sm">
					{atModel && (
						<div className="text-muted-foreground mb-1 flex items-center gap-2 px-1 text-xs">
							<img
								src={modelImage(atModel.id)}
								alt=""
								className="size-4 rounded-full"
								onError={(e) => (e.currentTarget.style.visibility = 'hidden')}
							/>
							<span>
								Talking to <span className="text-foreground font-medium">{atModel.name}</span>
							</span>
							<button
								type="button"
								aria-label="Stop talking to this model"
								className="hover:text-foreground ml-auto"
								onClick={() => onAtModel?.(null)}
							>
								<X className="size-3.5" />
							</button>
						</div>
					)}
					{files.length > 0 && (
						<div className="mb-1 flex flex-wrap gap-1.5" aria-label="Attachments">
							{files.map((f) => (
								<FileChip key={String(f.itemId ?? f.id)} file={f} onRemove={() => onRemoveFile?.(String(f.itemId))} />
							))}
						</div>
					)}
					<textarea
						ref={area}
						id="chat-input"
						aria-label="Message"
						rows={1}
						autoFocus
						disabled={disabled}
						value={text}
						placeholder={placeholder}
						onChange={(e) => {
							setText(e.target.value);
							setCursor(e.target.selectionStart ?? e.target.value.length);
						}}
						onSelect={(e) => setCursor(e.currentTarget.selectionStart ?? 0)}
						onPaste={(e) => {
							const pasted = Array.from(e.clipboardData.files ?? []);
							if (pasted.length && onPasteFiles) {
								e.preventDefault();
								onPasteFiles(pasted);
								return;
							}
							const pastedText = e.clipboardData.getData('text/plain');
							if (onPasteText && pastedText.length > PASTED_TEXT_LIMIT) {
								e.preventDefault();
								onPasteText(new File([pastedText], `Pasted_Text_${Date.now()}.txt`, { type: 'text/plain' }));
							}
						}}
						onKeyDown={(e) => {
							if (active && suggestions.length) {
								if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
									e.preventDefault();
									setSelected((i) =>
										Math.max(0, Math.min(suggestions.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))
									);
									return;
								}
								if (e.key === 'Enter' || e.key === 'Tab') {
									e.preventDefault();
									void pick(suggestions[selected]);
									return;
								}
								if (e.key === 'Escape') {
									e.preventDefault();
									setDismissed(`${active.trigger}${active.start}`);
									return;
								}
							}
							if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
							const send = ctrlEnter ? e.ctrlKey || e.metaKey : !e.shiftKey;
							if (send) {
								e.preventDefault();
								submit();
							}
						}}
						className="max-h-72 min-h-10 w-full resize-none bg-transparent px-1 py-1.5 text-[0.9375rem] outline-none [field-sizing:content]"
					/>
					<div className="flex items-center gap-1">
						<div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">{toolbar}</div>
						{generating && (
							<Tip content="Stop">
								<button
									type="button"
									aria-label="Stop"
									onClick={onStop}
									className="bg-foreground text-background rounded-full p-1.5"
								>
									<Square className="size-4 fill-current" />
								</button>
							</Tip>
						)}
						{(!generating || text.trim()) && (
							<Tip content="Send message">
								<button
									type="button"
									aria-label="Send message"
									disabled={disabled || uploading || (!text.trim() && !files.length)}
									onClick={submit}
									className="bg-foreground text-background rounded-full p-1.5 transition disabled:opacity-30"
								>
									<ArrowUp className="size-4" />
								</button>
							</Tip>
						)}
					</div>
				</div>
			</div>
			<InputVariablesDialog
				variables={variables?.vars ?? null}
				onCancel={() => {
					setVariables(null);
					place(text, cursor);
				}}
				onSubmit={(values) => {
					const filled = replaceInputVariables(variables?.text ?? text, values);
					setVariables(null);
					place(filled, filled.length);
				}}
			/>
		</div>
	);
});
