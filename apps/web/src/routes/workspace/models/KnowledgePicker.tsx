import { useQuery } from '@tanstack/react-query';
import { Database, File as FileIcon, FileText, Search, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { uploadFile } from '@/lib/apis/files';
import { searchKnowledgeBases, searchKnowledgeFiles } from '@/lib/apis/knowledge';
import { searchNotes } from '@/lib/apis/notes';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';
import type { KnowledgeItem } from './modelEditorLogic';

const iconFor = (item: KnowledgeItem) =>
	item.status === 'uploading' ? <Spinner className="size-3.5" /> : item.type === 'collection' ? <Database className="size-3.5" /> : item.type === 'note' ? <FileText className="size-3.5" /> : <FileIcon className="size-3.5" />;

/** Everything a model can be given as knowledge: notes, whole knowledge bases, and individual files. */
function KnowledgeSearch({ onPick }: { onPick: (item: KnowledgeItem) => void }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const [query, setQuery] = useState('');
	const debounced = useDebouncedValue(query, 300);
	const { data: items = [] } = useQuery({
		queryKey: ['model-knowledge-search', debounced],
		queryFn: async (): Promise<KnowledgeItem[]> => {
			const [notes, bases, files] = await Promise.all([
				searchNotes(token, debounced).catch(() => null),
				searchKnowledgeBases(token, debounced).catch(() => null),
				searchKnowledgeFiles(token, debounced).catch(() => null)
			]);
			return [
				...(notes?.items ?? []).map((n: KnowledgeItem) => ({ ...n, type: 'note', name: n.title })),
				...(bases?.items ?? []).map((k: KnowledgeItem) => ({ ...k, type: 'collection' })),
				...(files?.items ?? []).map((f: KnowledgeItem) => ({ ...f, type: 'file', name: f.meta?.name || f.filename, description: f.description || '' }))
			];
		}
	});
	return (
		<>
			<div className="flex items-center px-1.5 pb-0.5">
				<Search className="mr-1.5 size-3.5 shrink-0" />
				<input autoFocus className="w-full bg-transparent py-0.5 text-[0.8125rem] outline-hidden" aria-label="Search Knowledge" placeholder="Search Knowledge" value={query} onChange={(e) => setQuery(e.target.value)} />
			</div>
			<div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
				{items.length === 0 ? (
					<div className="text-muted-foreground py-4 text-center text-xs">No knowledge found</div>
				) : (
					items.map((item) => (
						<button key={`${item.type}-${item.id}`} type="button" className="hover:bg-muted/50 flex w-full items-center gap-2 rounded-xl px-2 py-1 text-left text-[0.8125rem]" onClick={() => onPick(item)}>
							{iconFor(item)}
							<span className="min-w-0 flex-1 truncate">{item.name}</span>
						</button>
					))
				)}
			</div>
		</>
	);
}

/**
 * Ports Models/Knowledge.svelte: attach notes, knowledge bases and files to a
 * model. Files can also be uploaded straight from here (if the user may upload);
 * a chip's own dialog lets a file be injected whole ("Using Entire Document")
 * rather than retrieved from.
 *
 * (The Svelte version sends the user's speech-to-text language when uploading
 * audio or video; there is no settings store here yet.)
 */
export function KnowledgePicker({ items, onChange }: { items: KnowledgeItem[]; onChange: (next: KnowledgeItem[]) => void }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const user = useAuthStore((s) => s.user);
	const maxSizeMb = useConfigStore((s) => s.config?.file?.max_size ?? null);
	const [open, setOpen] = useState(false);
	const [editing, setEditing] = useState<number | null>(null);
	const input = useRef<HTMLInputElement>(null);
	// Uploads finish asynchronously; the latest list is read through a ref so a
	// finishing upload doesn't overwrite items added or removed in the meantime.
	const latest = useRef(items);
	latest.current = items;
	const commit = (next: KnowledgeItem[]) => {
		latest.current = next;
		onChange(next);
	};

	const canUpload = user?.role === 'admin' || Boolean((user?.permissions as { chat?: { file_upload?: boolean } } | undefined)?.chat?.file_upload);

	const upload = async (file: File) => {
		if (user?.role !== 'admin' && !((user?.permissions as { chat?: { file_upload?: boolean } } | undefined)?.chat?.file_upload ?? true)) {
			toast.error('You do not have permission to upload files.');
			return;
		}
		if (file.size === 0) {
			toast.error('You cannot upload an empty file.');
			return;
		}
		if (maxSizeMb !== null && file.size > maxSizeMb * 1024 * 1024) {
			toast.error(`File size should not exceed ${maxSizeMb} MB.`);
			return;
		}
		if (file.type.startsWith('image/')) {
			toast.error('Unsupported file type.');
			return;
		}
		const itemId = `upload-${Date.now()}-${Math.random()}`;
		commit([...latest.current, { type: 'file', name: file.name, status: 'uploading', size: file.size, itemId }]);
		try {
			const uploaded = await uploadFile(token, file, null);
			if (!uploaded) throw new Error('Failed to upload file.');
			if (uploaded.error) toast.warning(uploaded.error);
			commit(
				latest.current.map((it) =>
					it.itemId === itemId ? { ...it, status: 'uploaded', file: uploaded, id: uploaded.id, url: `${uploaded.id}`, collection_name: uploaded?.meta?.collection_name || uploaded?.collection_name } : it
				)
			);
		} catch (e) {
			toast.error(`${e}`);
			commit(latest.current.filter((it) => it.itemId !== itemId));
		}
	};

	const editingItem = editing !== null ? items[editing] : null;

	return (
		<div>
			<Dialog open={editingItem !== null} onOpenChange={(o) => !o && setEditing(null)}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle className="text-sm">{editingItem?.name || editingItem?.id}</DialogTitle>
						<DialogDescription className="sr-only">Attached knowledge item.</DialogDescription>
					</DialogHeader>
					{editingItem?.description && <div className="text-muted-foreground text-sm">{editingItem.description}</div>}
					{editingItem && (editingItem.type === 'file' || editingItem.type === 'note') && (
						<label className="flex items-center justify-between gap-3 text-xs">
							<span>{editingItem.context === 'full' ? 'Using Entire Document' : 'Using Focused Retrieval'}</span>
							<Switch
								aria-label="Use entire document"
								checked={editingItem.context === 'full'}
								onCheckedChange={(on) => commit(items.map((it, i) => (i === editing ? { ...it, context: on ? 'full' : undefined } : it)))}
							/>
						</label>
					)}
				</DialogContent>
			</Dialog>

			<input
				ref={input}
				type="file"
				multiple
				hidden
				onChange={async (e) => {
					const chosen = Array.from(e.target.files ?? []);
					e.target.value = '';
					if (chosen.length === 0) {
						toast.error('File not found.');
						return;
					}
					for (const file of chosen) upload(file);
				}}
			/>

			<div className="mb-2">
				<div className="mb-1 flex w-full items-center gap-2">
					<div className="text-muted-foreground min-w-0 self-center text-xs">Knowledge</div>
					<div className="flex shrink-0 items-center gap-2">
						<Popover open={open} onOpenChange={setOpen}>
							<PopoverTrigger asChild>
								<button type="button" className="text-muted-foreground min-w-0 truncate text-xs hover:underline">
									Select Knowledge
								</button>
							</PopoverTrigger>
							<PopoverContent align="start" className="w-96 max-w-[calc(100vw-2rem)] p-0.5">
								<KnowledgeSearch
									onPick={(item) => {
										if (!items.find((k) => k.id === item.id)) commit([...items, { ...item }]);
										setOpen(false);
									}}
								/>
							</PopoverContent>
						</Popover>
						{canUpload && (
							<button type="button" className="text-muted-foreground text-xs hover:underline" aria-label="Upload Files" onClick={() => input.current?.click()}>
								Upload
							</button>
						)}
					</div>
				</div>
			</div>

			<div className="mb-1 flex flex-col">
				{items.length > 0 && (
					<div className="mb-2.5 flex flex-wrap items-center gap-1.5">
						{items.map((file, i) => (
							<Tip key={file.itemId ?? `${file.id}-${i}`} content={file.description || file.name || file.id}>
								<div className="bg-muted flex items-center gap-1 rounded-lg px-2 py-1 text-xs">
									<button type="button" aria-label="Edit" className="flex min-w-0 items-center gap-1.5" onClick={() => setEditing(i)}>
										<span className="text-muted-foreground shrink-0">{iconFor(file)}</span>
										<span className="min-w-0 truncate">{file.name || file.id}</span>
									</button>
									{file.status === 'uploading' && <span className="text-muted-foreground shrink-0">Uploading</span>}
									<button type="button" aria-label="Remove File" onClick={() => commit(items.filter((_, idx) => idx !== i))}>
										<X className="size-3" />
									</button>
								</div>
							</Tip>
						))}
						<Button type="button" variant="ghost" size="xs" onClick={() => commit([])}>
							Disable all
						</Button>
					</div>
				)}
			</div>
			<div className="text-muted-foreground/70 text-xs">To attach knowledge base here, add them to the "Knowledge" workspace first.</div>
		</div>
	);
}
