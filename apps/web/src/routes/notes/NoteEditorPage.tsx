import { useQuery, useQueryClient } from '@tanstack/react-query';
import saveAs from 'file-saver';
import { ChevronLeft, Copy, Download, Link2, Lock, MoreHorizontal, Pin, PinOff, Sparkles, Trash2 } from 'lucide-react';
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { AccessControlModal } from '@/components/common/AccessControlModal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import type { EditorContentValue } from '@/components/common/RichTextEditor';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { AccessGrant } from '@/lib/access/accessGrants';
import { generateOpenAIChatCompletion } from '@/lib/apis/openai';
import { deleteNoteById, getNoteById, toggleNotePinnedStatusById, updateNoteAccessGrants, updateNoteById } from '@/lib/apis/notes';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore, useDocumentTitle } from '@/lib/stores/configStore';
import { copyToClipboard } from '@/lib/utils';
import { FeatureGate } from '@/routes/common/FeatureGate';
import { initialModel } from '@/routes/playground/playgroundModel';
import { type NoteContent, editorContent, parseGeneratedTitle, safeFileName, titlePrompt, wordCount } from './notesModel';

// TipTap is large; only the note page loads it.
const RichTextEditor = lazy(() => import('@/components/common/RichTextEditor'));

const SAVE_DELAY = 500;
const iconButton = 'hover:bg-muted rounded-lg p-1.5 transition disabled:opacity-50';

type Note = { id: string; title: string; user_id: string; write_access?: boolean; is_pinned?: boolean; access_grants?: AccessGrant[]; data?: { content?: Partial<NoteContent> } | null };

/**
 * A debounced save of the note's title and body. Every edit restarts the
 * timer; `flush` sends a pending save at once (used when leaving the page, so
 * the last keystrokes are not lost -- the Svelte editor's timer simply died
 * with the component). Only the fields edited here are sent: the server merges
 * `data`, so attachments stay as they are. `access_grants` is deliberately
 * omitted; that leaves sharing untouched only because routers/notes.py was
 * patched to skip grants the client didn't send (docs/bug-review-2026-09-27.md
 * H1) -- before that, every autosave cleared them.
 */
function useNoteSaver(id: string) {
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	const pending = useRef<{ title: string; content: NoteContent | null } | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [saving, setSaving] = useState(false);

	const send = useCallback(async () => {
		const p = pending.current;
		pending.current = null;
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
		if (!p) return;
		setSaving(true);
		await updateNoteById(token, id, { title: p.title.trim() || 'Untitled', data: p.content ? { content: p.content } : {} }).catch((e) => toast.error(`${e}`));
		setSaving(false);
		queryClient.invalidateQueries({ queryKey: ['notes', 'list'] });
		queryClient.invalidateQueries({ queryKey: ['pinned-notes'] });
	}, [token, id, queryClient]);

	const schedule = useCallback(
		(title: string, content: NoteContent | null) => {
			pending.current = { title, content: content ?? pending.current?.content ?? null };
			if (timer.current) clearTimeout(timer.current);
			timer.current = setTimeout(send, SAVE_DELAY);
		},
		[send]
	);

	useEffect(() => () => void send(), [send]);
	return { schedule, flush: send, saving };
}

/**
 * Ports routes/(app)/notes/[id] and components/notes/NoteEditor.svelte: the
 * title (with AI title generation), the rich-text body, autosave, word and
 * character counts, and the note's menu -- download, copy, pin, access,
 * delete. Read-only for someone without write access.
 *
 * Not yet (they depend on Phase 10's chat): the note's chat panel, voice
 * recording, attachments and Enhance. Nor is live collaboration: two tabs
 * editing the same note do not merge as they type; the last save wins.
 */
function NoteEditor() {
	const { id = '' } = useParams();
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const defaults = useConfigStore((s) => s.config?.default_models as string | undefined);
	const { settings } = useUserSettings();
	const note = useQuery({ queryKey: ['notes', 'item', id], queryFn: () => getNoteById(token, id) as Promise<Note>, retry: false, staleTime: Infinity, gcTime: 0 });
	const { schedule, flush, saving } = useNoteSaver(id);
	const [title, setTitle] = useState('');
	const [text, setText] = useState('');
	const [generating, setGenerating] = useState(false);
	const [showAccess, setShowAccess] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const latest = useRef<NoteContent | null>(null);
	useDocumentTitle(title || 'Note');

	useEffect(() => {
		if (!note.data) return;
		setTitle(note.data.title ?? '');
		setText(note.data.data?.content?.md ?? '');
	}, [note.data]);
	useEffect(() => {
		if (note.isError) {
			toast.error(`${note.error}`);
			navigate('/notes', { replace: true });
		}
	}, [note.isError, note.error, navigate]);

	if (!note.data) {
		return (
			<div className="flex flex-1 items-center justify-center">
				<Spinner className="size-5" />
			</div>
		);
	}
	const n = note.data;
	const editable = n.write_access !== false;

	const onContent = (v: EditorContentValue) => {
		latest.current = v;
		setText(v.md);
		schedule(title, v);
	};
	const onTitle = (value: string) => {
		setTitle(value);
		schedule(value, null);
	};
	const md = () => latest.current?.md ?? n.data?.content?.md ?? '';

	const generateTitle = async () => {
		const model = initialModel(settings?.models, defaults);
		if (!model) return void toast.error('Please select a model.');
		setGenerating(true);
		const res = await generateOpenAIChatCompletion(token, { model, stream: false, messages: [{ role: 'user', content: titlePrompt(md()) }] }).catch((e) => void toast.error(`${e}`));
		setGenerating(false);
		const generated = parseGeneratedTitle(res?.choices?.[0]?.message?.content ?? '');
		if (generated) onTitle(generated);
		else if (res) toast.error('Failed to generate title');
	};
	const download = (ext: 'md' | 'txt') => saveAs(new Blob([md()], { type: ext === 'md' ? 'text/markdown' : 'text/plain' }), safeFileName(title, ext));
	const copy = async (value: string, ok: string) => ((await copyToClipboard(value)) ? toast.success(ok) : toast.error('Failed to copy'));
	const togglePin = async () => {
		const res = await toggleNotePinnedStatusById(token, n.id).catch((e) => void toast.error(`${e}`));
		if (res) queryClient.setQueryData(['notes', 'item', id], { ...n, is_pinned: !n.is_pinned });
		queryClient.invalidateQueries({ queryKey: ['pinned-notes'] });
	};
	const saveAccess = async (grants: AccessGrant[]) => {
		queryClient.setQueryData(['notes', 'item', id], { ...n, access_grants: grants });
		await updateNoteAccessGrants(token, n.id, grants).catch((e) => void toast.error(`${e}`));
	};
	const remove = async () => {
		const res = await deleteNoteById(token, n.id).catch((e) => void toast.error(`${e}`));
		if (res) {
			await queryClient.invalidateQueries({ queryKey: ['notes'] });
			navigate('/notes');
		}
	};

	return (
		<div className="flex h-full min-h-0 w-full flex-col">
			<ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title="Delete note?" confirmLabel="Delete" onConfirm={remove}>
				This will delete <span className="font-medium">{title}</span>.
			</ConfirmDialog>
			{editable && <AccessControlModal open={showAccess} onOpenChange={setShowAccess} accessGrants={n.access_grants ?? []} onChange={saveAccess} />}

			<div className="flex shrink-0 items-center gap-1 px-2.5 pt-2 pb-1">
				<Link to="/notes" onClick={() => void flush()} aria-label="Back to notes" className={iconButton}>
					<ChevronLeft className="size-4" />
				</Link>
				<input
					className="placeholder:text-muted-foreground/50 min-w-0 flex-1 bg-transparent text-lg outline-hidden"
					aria-label="Title"
					placeholder={generating ? 'Generating...' : 'Title'}
					value={generating ? '' : title}
					readOnly={!editable}
					onChange={(e) => onTitle(e.target.value)}
				/>
				{editable && (
					<Tip content="Generate title">
						<button type="button" aria-label="Generate title" className={iconButton} disabled={generating} onClick={generateTitle}>
							{generating ? <Spinner className="size-4" /> : <Sparkles className="size-4" />}
						</button>
					</Tip>
				)}
				<span className="text-muted-foreground hidden w-12 text-right text-[0.6875rem] sm:block" aria-live="polite">
					{saving ? 'Saving…' : ''}
				</span>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button type="button" aria-label="Note menu" className={iconButton}>
							<MoreHorizontal className="size-4" />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem onSelect={() => download('md')}>
							<Download /> Download (.md)
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => download('txt')}>
							<Download /> Download (.txt)
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => copy(`${window.location.origin}/notes/${n.id}`, 'Copied link to clipboard')}>
							<Link2 /> Copy link
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => copy(md(), 'Copied to clipboard')}>
							<Copy /> Copy to clipboard
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={togglePin}>{n.is_pinned ? <><PinOff /> Unpin</> : <><Pin /> Pin to Sidebar</>}</DropdownMenuItem>
						{editable && (
							<>
								<DropdownMenuItem onSelect={() => setShowAccess(true)}>
									<Lock /> Access
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem onSelect={() => setConfirmDelete(true)}>
									<Trash2 /> Delete
								</DropdownMenuItem>
							</>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-2 md:px-8">
				{!editable && <div className="text-muted-foreground mb-2 text-xs">Read only</div>}
				<Suspense fallback={<Spinner className="m-auto size-5" />}>
					<RichTextEditor content={editorContent(n.data?.content)} contentKey={n.id} onChange={onContent} editable={editable} ariaLabel="Note content" />
				</Suspense>
			</div>
			<div className="text-muted-foreground shrink-0 px-4 pb-2 text-right text-[0.6875rem] md:px-8">
				{wordCount(text)} words · {text.length} characters
			</div>
		</div>
	);
}

export function NoteEditorPage() {
	return (
		<FeatureGate feature="notes">
			<NoteEditor />
		</FeatureGate>
	);
}
