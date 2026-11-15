import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Tip } from '@/components/common/Tip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { getTagsById, updateChatById } from '@/lib/apis/chats';
import { useAuthStore } from '@/lib/stores/authStore';
import { patchCachedChat } from './sidebar/useChatList';

/** How many tags the header shows before "+N". */
const SHOWN_TAGS = 3;

/** A saved chat's tags, refreshed whenever the chat lists are (a new tag, a rename). */
export function useChatTags(chatId: string) {
	const token = useAuthStore((s) => s.token) ?? '';
	return useQuery({
		queryKey: ['chats', 'tags', chatId],
		enabled: Boolean(token),
		queryFn: async () => {
			const res = await getTagsById(token, chatId);
			return (Array.isArray(res) ? res : []) as { name: string }[];
		}
	});
}

/** Saves a chat's new title: true when it was saved or is unchanged, false when it was empty or refused. */
function useRenameChat(chatId: string, title: string, onRenamed: (title: string) => void) {
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	return async (raw: string) => {
		const next = raw.trim();
		if (!next) {
			toast.error("A chat's title can't be empty");
			return false;
		}
		if (next === title) return true;
		try {
			await updateChatById(token, chatId, { title: next });
		} catch (e) {
			toast.error(`${e}`);
			return false;
		}
		patchCachedChat(queryClient, chatId, (c) => ({ ...c, title: next }));
		void queryClient.invalidateQueries({ queryKey: ['chats'] });
		onRenamed(next);
		toast.success('Chat renamed');
		return true;
	};
}

/**
 * The saved chat's title in its header (#928, LAY-5): a button that turns
 * into a field to rename it in place (Enter or leaving the field saves,
 * Escape cancels), followed by up to three of its tags and "+N" for the rest.
 * Focus returns to the title when editing ends.
 */
export function ChatTitle({
	chatId,
	title,
	editing,
	onEditingChange,
	onRenamed
}: {
	chatId: string;
	title: string;
	editing: boolean;
	onEditingChange: (editing: boolean) => void;
	onRenamed: (title: string) => void;
}) {
	const [draft, setDraft] = useState(title);
	const rename = useRenameChat(chatId, title, onRenamed);
	const tags = useChatTags(chatId).data ?? [];
	const button = useRef<HTMLButtonElement>(null);
	const wasEditing = useRef(editing);
	// Once per edit: the field's blur as it leaves must not save after Escape or Enter.
	const finished = useRef(false);
	useEffect(() => {
		if (editing && !wasEditing.current) {
			finished.current = false;
			setDraft(title);
		} else if (!editing && wasEditing.current) button.current?.focus();
		wasEditing.current = editing;
	}, [editing, title]);

	const finish = (save: boolean) => {
		if (finished.current) return;
		finished.current = true;
		onEditingChange(false);
		if (save) void rename(draft);
	};
	const hidden = tags.slice(SHOWN_TAGS).map((t) => t.name);

	return (
		<div className="flex min-w-0 flex-1 items-center gap-2">
			{editing ? (
				<Input
					autoFocus
					aria-label="Chat title"
					className="max-w-md"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onFocus={(e) => e.currentTarget.select()}
					onBlur={() => finish(true)}
					onKeyDown={(e) => {
						if (e.key === 'Enter') {
							// Not passed on to the title button that takes focus back, which would reopen the field.
							e.preventDefault();
							finish(true);
						}
						if (e.key === 'Escape') {
							// The chat's own Escape and the side panel's are left alone.
							e.preventDefault();
							finish(false);
						}
					}}
				/>
			) : (
				<Tip content="Rename">
					<Button
						ref={button}
						type="button"
						variant="ghost"
						size="sm"
						className="text-body font-title min-w-0 shrink justify-start"
						aria-label={`Chat title: ${title}. Rename`}
						onClick={() => onEditingChange(true)}
					>
						<span className="truncate" title={title}>
							{title}
						</span>
					</Button>
				</Tip>
			)}
			{tags.length > 0 && (
				<ul aria-label="Tags" className="flex shrink-0 items-center gap-1">
					{tags.slice(0, SHOWN_TAGS).map((t) => (
						<li key={t.name}>
							<Badge variant="secondary">{t.name}</Badge>
						</li>
					))}
					{hidden.length > 0 && (
						<li>
							<Badge
								variant="secondary"
								title={hidden.join(', ')}
								aria-label={`${hidden.length} more: ${hidden.join(', ')}`}
							>
								+{hidden.length}
							</Badge>
						</li>
					)}
				</ul>
			)}
		</div>
	);
}

/** Rename on a phone, where the header has no title of its own: a short form (OVL-1). */
export function RenameChatDialog({
	chatId,
	title,
	open,
	onOpenChange,
	onRenamed
}: {
	chatId: string;
	title: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onRenamed: (title: string) => void;
}) {
	const [draft, setDraft] = useState(title);
	const rename = useRenameChat(chatId, title, onRenamed);
	useEffect(() => {
		if (open) setDraft(title);
	}, [open, title]);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg" aria-describedby={undefined}>
				<form
					className="flex flex-col gap-4"
					onSubmit={(e) => {
						e.preventDefault();
						void rename(draft).then((saved) => saved && onOpenChange(false));
					}}
				>
					<DialogHeader>
						<DialogTitle>Rename chat</DialogTitle>
					</DialogHeader>
					<Input aria-label="Chat title" value={draft} onChange={(e) => setDraft(e.target.value)} />
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit">Rename chat</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
