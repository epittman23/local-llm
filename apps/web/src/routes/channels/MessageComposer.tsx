import { useQuery } from '@tanstack/react-query';
import { ArrowUp, FileText, Hash, Paperclip, X } from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Spinner } from '@/components/common/Spinner';
import { getModels } from '@/lib/apis';
import { getChannelMembersById } from '@/lib/apis/channels';
import { uploadFile } from '@/lib/apis/files';
import { searchUsers } from '@/lib/apis/users';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { cn } from '@/lib/utils';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';
import { type Channel, type ChannelMessage, type ChannelUser, type Mention, encodeMentions, mentionQuery, mentionText } from './channelModel';
import { useChannelList } from './useChannels';

export type ComposerFile = {
	itemId: string;
	type: 'file';
	id: string | null;
	url: string;
	name: string;
	size: number;
	status: 'uploading' | 'uploaded';
	content_type?: string;
	collection_name?: string;
	file?: unknown;
};
export type ComposerSubmit = { content: string; data: { files: ComposerFile[] } };
export type ComposerHandle = { focus: () => void; addFiles: (files: File[]) => void };

type Suggestion = Mention & { image?: string };
const TYPING_EVERY_MS = 1000;

/**
 * Ports channel/MessageInput.svelte for a channel or a thread: a text box that
 * sends on Enter (Shift+Enter for a new line), `@` suggestions for people and
 * models and `#` for channels (a mentioned model replies in the channel),
 * attachments by button or drop, the message being replied to, and who is
 * typing. `onTyping` is called at most once a second while typing.
 *
 * Deliberately smaller than the original, whose editor is the chat's rich-text
 * input: no formatting toolbar, `/` commands, `:` emoji completion, prompt
 * variables, voice recording or screen capture (all Phase 10 chat pieces), and
 * images are uploaded as they are, without the optional client-side
 * compression or HEIC conversion.
 */
export const MessageComposer = forwardRef<
	ComposerHandle,
	{
		channel: Channel;
		disabled?: boolean;
		placeholder: string;
		typingUsers: ChannelUser[];
		replyTo: ChannelMessage | null;
		onCancelReply: () => void;
		onTyping: () => void;
		onSubmit: (value: ComposerSubmit) => void;
	}
>(function MessageComposer({ channel, disabled, placeholder, typingUsers, replyTo, onCancelReply, onTyping, onSubmit }, ref) {
	const token = useAuthStore((s) => s.token) ?? '';
	const maxSize = useConfigStore((s) => s.config?.file?.max_size ?? null);
	const [text, setText] = useState('');
	const [mentions, setMentions] = useState<Mention[]>([]);
	const [files, setFiles] = useState<ComposerFile[]>([]);
	const [cursor, setCursor] = useState(0);
	const [selected, setSelected] = useState(0);
	const [dismissed, setDismissed] = useState<number | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const lastTyping = useRef(0);

	const query = useMemo(() => mentionQuery(text, cursor), [text, cursor]);
	const active = query && query.start !== dismissed ? query : null;
	const debounced = useDebouncedValue(active?.trigger === '@' ? active.query : null, 200);

	const users = useQuery({
		queryKey: ['channel-mention-users', channel.id, debounced],
		enabled: debounced !== null,
		staleTime: 30_000,
		queryFn: async () => {
			const [members, found] = await Promise.all([
				getChannelMembersById(token, channel.id, debounced ?? '', 'name', 'asc', 1).catch(() => null),
				searchUsers(token, debounced ?? '', undefined, undefined, 1).catch(() => null)
			]);
			const memberRows = ((members?.users ?? []) as ChannelUser[]).sort((a, b) => a.name.localeCompare(b.name));
			const ids = new Set(memberRows.map((u) => u.id));
			const others = ((found?.users ?? []) as ChannelUser[]).filter((u) => !ids.has(u.id)).sort((a, b) => a.name.localeCompare(b.name));
			return [...memberRows, ...others];
		}
	});
	const models = useQuery({ queryKey: ['models-all'], enabled: active?.trigger === '@', queryFn: async () => ((await getModels(token)) ?? []) as { id: string; name: string }[] });
	const channels = useChannelList();

	const suggestions: Suggestion[] = useMemo(() => {
		if (!active) return [];
		const q = active.query.toLowerCase();
		const match = (s: Suggestion) => s.label.toLowerCase().includes(q) || s.id.toLowerCase().includes(q);
		if (active.trigger === '#') {
			return (channels.data ?? []).filter((c) => c.type !== 'dm' && c.name).map((c): Suggestion => ({ kind: 'channel', id: c.id, label: c.name })).filter(match).slice(0, 20);
		}
		const u = (users.data ?? []).map((x): Suggestion => ({ kind: 'user', id: x.id, label: x.name, image: `${WEBUI_API_BASE_URL}/users/${x.id}/profile/image` }));
		const m = (models.data ?? []).map((x): Suggestion => ({ kind: 'model', id: x.id, label: x.name || x.id, image: `${WEBUI_API_BASE_URL}/models/model/profile/image?id=${encodeURIComponent(x.id)}` }));
		return [...u, ...m].filter(match).slice(0, 30);
	}, [active, users.data, models.data, channels.data]);

	useEffect(() => setSelected(0), [active?.query, active?.trigger]);

	const pick = (s: Suggestion) => {
		if (!active) return;
		const insert = `${mentionText(s)} `;
		const next = text.slice(0, active.start) + insert + text.slice(cursor);
		const pos = active.start + insert.length;
		setText(next);
		// One entry per insertion, in order: encodeMentions gives same-label mentions their occurrences in this order.
		setMentions((ms) => [...ms, { kind: s.kind, id: s.id, label: s.label }]);
		requestAnimationFrame(() => {
			textareaRef.current?.setSelectionRange(pos, pos);
			setCursor(pos);
		});
	};

	const addFiles = (list: File[]) => {
		for (const file of list) {
			if (maxSize !== null && file.size > maxSize * 1024 * 1024) {
				toast.error(`File size should not exceed ${maxSize} MB.`);
				continue;
			}
			if (file.size === 0) {
				toast.error('You cannot upload an empty file.');
				continue;
			}
			const itemId = crypto.randomUUID();
			setFiles((fs) => [...fs, { itemId, type: 'file', id: null, url: '', name: file.name, size: file.size, status: 'uploading' }]);
			const process = !file.type.startsWith('image/');
			uploadFile(token, file, { channel_id: channel.id }, process)
				.then((uploaded) => {
					if (!uploaded) throw new Error('Upload failed');
					if (uploaded.error) toast.warning(`${uploaded.error}`);
					setFiles((fs) =>
						fs.map((f) =>
							f.itemId === itemId
								? { ...f, status: 'uploaded', file: uploaded, id: uploaded.id, url: `${uploaded.id}`, content_type: uploaded.meta?.content_type ?? uploaded.content_type, collection_name: uploaded.meta?.collection_name ?? uploaded.collection_name }
								: f
						)
					);
				})
				.catch((e) => {
					toast.error(`${e}`);
					setFiles((fs) => fs.filter((f) => f.itemId !== itemId));
				});
		}
	};

	useImperativeHandle(ref, () => ({ focus: () => textareaRef.current?.focus(), addFiles }));

	const uploading = files.some((f) => f.status === 'uploading');
	const submit = () => {
		if (disabled || uploading) return;
		const content = encodeMentions(text.trim(), mentions);
		if (!content && files.length === 0) return;
		onSubmit({ content, data: { files } });
		setText('');
		setMentions([]);
		setFiles([]);
		setDismissed(null);
		textareaRef.current?.focus();
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (active && suggestions.length > 0) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				setSelected((i) => Math.min(i + 1, suggestions.length - 1));
				return;
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				setSelected((i) => Math.max(i - 1, 0));
				return;
			}
			if (e.key === 'Enter' || e.key === 'Tab') {
				e.preventDefault();
				pick(suggestions[selected]);
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				setDismissed(active.start);
				return;
			}
		}
		if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			submit();
		}
	};

	return (
		<div className="relative">
			{typingUsers.length > 0 && (
				<div className="text-muted-foreground absolute -top-5 left-3 text-xs" aria-live="polite">
					<span className="font-medium">{typingUsers.map((u) => u.name).join(', ')}</span> {typingUsers.length === 1 ? 'is' : 'are'} typing...
				</div>
			)}

			{active && suggestions.length > 0 && (
				<div role="listbox" aria-label="Mention suggestions" className="bg-popover absolute bottom-full left-0 z-30 mb-2 max-h-60 w-72 overflow-y-auto rounded-xl border p-1 shadow-lg">
					{suggestions.map((s, i) => (
						<button
							key={`${s.kind}-${s.id}`}
							type="button"
							role="option"
							aria-selected={i === selected}
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => pick(s)}
							className={cn('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm', i === selected && 'bg-muted')}
						>
							{s.kind === 'channel' ? <Hash className="size-4" /> : <img src={s.image} alt="" className="size-5 rounded-full object-cover" />}
							<span className="truncate">{s.label}</span>
							<span className="text-muted-foreground ml-auto text-xs">{s.kind === 'model' ? 'Model' : s.kind === 'user' ? '' : 'Channel'}</span>
						</button>
					))}
				</div>
			)}

			<div className="bg-background rounded-3xl border px-3 py-2 shadow-sm">
				{replyTo && (
					<div className="text-muted-foreground mb-1 flex items-center gap-2 px-1 text-xs">
						<span className="truncate">
							Replying to <span className="text-foreground font-medium">{replyTo.meta?.model_name ?? replyTo.user?.name ?? 'Unknown User'}</span>
						</span>
						<button type="button" aria-label="Cancel reply" className="hover:text-foreground ml-auto" onClick={onCancelReply}>
							<X className="size-3.5" />
						</button>
					</div>
				)}

				{files.length > 0 && (
					<div className="mb-1 flex flex-wrap gap-2">
						{files.map((f) => (
							<div key={f.itemId} className="flex items-center gap-2 rounded-xl border px-2 py-1 text-xs">
								{f.status === 'uploading' ? <Spinner className="size-3.5" /> : <FileText className="size-3.5" />}
								<span className="max-w-40 truncate">{f.name}</span>
								<button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((fs) => fs.filter((x) => x.itemId !== f.itemId))}>
									<X className="size-3" />
								</button>
							</div>
						))}
					</div>
				)}

				<div className="flex items-end gap-2">
					<input
						ref={fileInputRef}
						type="file"
						multiple
						hidden
						onChange={(e) => {
							addFiles(Array.from(e.target.files ?? []));
							e.target.value = '';
						}}
					/>
					<button type="button" aria-label="Attach files" disabled={disabled} className="text-muted-foreground hover:bg-muted mb-0.5 rounded-full p-1.5 disabled:opacity-50" onClick={() => fileInputRef.current?.click()}>
						<Paperclip className="size-4" />
					</button>
					<textarea
						ref={textareaRef}
						aria-label="Message"
						rows={1}
						disabled={disabled}
						placeholder={placeholder}
						value={text}
						onChange={(e) => {
							setText(e.target.value);
							setCursor(e.target.selectionStart ?? e.target.value.length);
							if (Date.now() - lastTyping.current > TYPING_EVERY_MS) {
								lastTyping.current = Date.now();
								onTyping();
							}
						}}
						onSelect={(e) => setCursor(e.currentTarget.selectionStart ?? 0)}
						onKeyDown={onKeyDown}
						onPaste={(e) => {
							const pasted = Array.from(e.clipboardData.files ?? []);
							if (pasted.length) {
								e.preventDefault();
								addFiles(pasted);
							}
						}}
						className="max-h-60 min-h-8 flex-1 resize-none bg-transparent py-1.5 text-sm outline-none [field-sizing:content] disabled:cursor-not-allowed"
					/>
					<button
						type="button"
						aria-label="Send message"
						disabled={disabled || uploading || (!text.trim() && files.length === 0)}
						onClick={submit}
						className="bg-foreground text-background mb-0.5 rounded-full p-1.5 transition disabled:opacity-30"
					>
						<ArrowUp className="size-4" />
					</button>
				</div>
			</div>
		</div>
	);
});
