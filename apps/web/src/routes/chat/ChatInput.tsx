import { ArrowUp, Square, X } from 'lucide-react';
import { type ReactNode, forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { Tip } from '@/components/common/Tip';
import type { ChatFile } from '@/lib/chat/history';
import { useUserSettings } from '@/lib/settings/userSettings';
import { cn } from '@/lib/utils';

export type ChatInputHandle = { focus: () => void; setText: (text: string) => void };

/**
 * The chat's message box (chat/MessageInput.svelte in its plain-text mode --
 * the one the Svelte app uses when "Rich Text Input" is off). Enter sends,
 * Shift+Enter is a new line; with "Ctrl+Enter to send" on, those swap. While a
 * reply is being written the button stops it, and anything sent meanwhile is
 * listed as queued. Attachments, commands and tools plug in through
 * `toolbar` and `files`.
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
		onClearFiles?: () => void;
		above?: ReactNode;
	}
>(function ChatInput({ onSubmit, onStop, generating, queued, onRemoveQueued, placeholder = 'Send a Message', toolbar, files = [], onClearFiles, above }, ref) {
	const [text, setText] = useState('');
	const area = useRef<HTMLTextAreaElement>(null);
	const { settings } = useUserSettings();
	const ctrlEnter = Boolean((settings as Record<string, unknown> | null)?.ctrlEnterToSend);
	useImperativeHandle(ref, () => ({ focus: () => area.current?.focus(), setText: (t) => setText(t) }));

	const uploading = files.some((f) => f.status === 'uploading');
	const submit = () => {
		if (uploading) return;
		if (onSubmit(text, files)) {
			setText('');
			onClearFiles?.();
			area.current?.focus();
		}
	};

	return (
		<div className="mx-auto w-full max-w-3xl px-2.5 pb-3">
			{queued.length > 0 && (
				<ul className="mb-1.5 flex flex-col gap-1" aria-label="Queued messages">
					{queued.map((q) => (
						<li key={q.id} className="bg-muted/50 flex items-center gap-2 rounded-xl px-3 py-1.5 text-xs">
							<span className="text-muted-foreground">Queued</span>
							<span className="truncate">{q.prompt}</span>
							<button type="button" aria-label="Remove queued message" className="ml-auto" onClick={() => onRemoveQueued(q.id)}>
								<X className="size-3" />
							</button>
						</li>
					))}
				</ul>
			)}
			{above}
			<div className="bg-background rounded-3xl border px-3 py-2 shadow-sm">
				<textarea
					ref={area}
					id="chat-input"
					aria-label="Message"
					rows={1}
					autoFocus
					value={text}
					placeholder={placeholder}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => {
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
							<button type="button" aria-label="Stop" onClick={onStop} className="bg-foreground text-background rounded-full p-1.5">
								<Square className="size-4 fill-current" />
							</button>
						</Tip>
					)}
					{(!generating || text.trim()) && (
						<Tip content="Send message">
							<button
								type="button"
								aria-label="Send message"
								disabled={uploading || (!text.trim() && !files.length)}
								onClick={submit}
								className={cn('bg-foreground text-background rounded-full p-1.5 transition disabled:opacity-30')}
							>
								<ArrowUp className="size-4" />
							</button>
						</Tip>
					)}
				</div>
			</div>
		</div>
	);
});
