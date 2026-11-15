import { useQuery } from '@tanstack/react-query';
import { Database, File as FileIcon, FileText, Upload, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { failureCause } from '@/components/common/LoadFailed';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandLoading
} from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { errorDetail } from '@/lib/apis/errors';
import { uploadFile } from '@/lib/apis/files';
import { searchKnowledgeBases, searchKnowledgeFiles } from '@/lib/apis/knowledge';
import { searchNotes } from '@/lib/apis/notes';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';
import { routePaths } from '@/routes/routePaths';
import { groupLabel } from './EditorPickers';
import type { KnowledgeItem } from './modelEditorLogic';

const iconFor = (item: KnowledgeItem) =>
	item.status === 'uploading' ? (
		<Spinner className="size-3.5" />
	) : item.type === 'collection' ? (
		<Database aria-hidden className="size-3.5" />
	) : item.type === 'note' ? (
		<FileText aria-hidden className="size-3.5" />
	) : (
		<FileIcon aria-hidden className="size-3.5" />
	);

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

type Found = { bases: KnowledgeItem[]; files: KnowledgeItem[]; notes: KnowledgeItem[] };

/** Knowledge bases, files and notes matching `query`; also read with '' to know whether there is anything to attach. */
function useKnowledgeSearch(query: string) {
	const token = useAuthStore((s) => s.token) ?? '';
	return useQuery({
		queryKey: ['model-knowledge-search', query],
		queryFn: async (): Promise<Found> => {
			const [notes, bases, files] = await Promise.all([
				searchNotes(token, query).catch(() => null),
				searchKnowledgeBases(token, query).catch(() => null),
				searchKnowledgeFiles(token, query).catch(() => null)
			]);
			return {
				bases: (bases?.items ?? []).map((k: KnowledgeItem) => ({ ...k, type: 'collection' })),
				files: (files?.items ?? []).map((f: KnowledgeItem) => ({
					...f,
					type: 'file',
					name: f.meta?.name || f.filename,
					description: f.description || ''
				})),
				notes: (notes?.items ?? []).map((n: KnowledgeItem) => ({ ...n, type: 'note', name: n.title }))
			};
		}
	});
}

/** The muted line under a choice: how big a knowledge base is, or the item's description. */
const detailOf = (item: KnowledgeItem): string | null =>
	item.type === 'collection' && typeof item.file_count === 'number'
		? plural(item.file_count, 'file')
		: item.description || null;

/**
 * Everything a model can be given as knowledge, grouped with knowledge bases
 * first, then files, then notes (#1014). The server does the matching, so the
 * list only moves the highlight (NAV-5). A name too long for the row has a
 * tooltip (OVL-4).
 */
function KnowledgeSearch({ onPick }: { onPick: (item: KnowledgeItem) => void }) {
	const [query, setQuery] = useState('');
	const debounced = useDebouncedValue(query, 300);
	const { data, isPending } = useKnowledgeSearch(debounced);
	const groups: Array<[string, KnowledgeItem[]]> = [
		['Knowledge bases', data?.bases ?? []],
		['Files', data?.files ?? []],
		['Notes', data?.notes ?? []]
	];
	return (
		<Command shouldFilter={false} label="Attach knowledge">
			<CommandInput
				placeholder="Search knowledge"
				aria-label="Search knowledge"
				value={query}
				onValueChange={setQuery}
			/>
			<CommandList className="mt-1 max-h-80">
				{isPending ? (
					<CommandLoading>
						<p className="text-foreground-muted px-2 py-4 text-center">Searching…</p>
					</CommandLoading>
				) : (
					<CommandEmpty>{query.trim() ? `Nothing matches “${query.trim()}”.` : 'Nothing to attach yet.'}</CommandEmpty>
				)}
				{groups.map(
					([heading, items]) =>
						items.length > 0 && (
							<CommandGroup key={heading} heading={heading}>
								{items.map((item) => {
									const detail = detailOf(item);
									return (
										<CommandItem
											key={`${item.type}-${item.id}`}
											value={`${item.type}-${item.id}`}
											onSelect={() => onPick(item)}
											className="items-start"
										>
											<span className="text-foreground-muted mt-1">{iconFor(item)}</span>
											<Tip content={item.name}>
												<span className="min-w-0 flex-1 text-start">
													<span className="block truncate">{item.name}</span>
													{detail && <span className="text-foreground-muted text-dense block truncate">{detail}</span>}
												</span>
											</Tip>
										</CommandItem>
									);
								})}
							</CommandGroup>
						)
				)}
			</CommandList>
		</Command>
	);
}

/**
 * Ports Models/Knowledge.svelte: attach knowledge bases, files and notes to a
 * model. Files can also be uploaded straight from here (if the user may
 * upload); a file's or note's own dialog sets whether the whole document is
 * used rather than the passages that match.
 *
 * (The Svelte version sends the user's speech-to-text language when uploading
 * audio or video; there is no settings store here yet.)
 */
export function KnowledgePicker({
	items,
	onChange,
	error
}: {
	items: KnowledgeItem[];
	onChange: (next: KnowledgeItem[]) => void;
	/** FRM-2: why the attachments stop a save (an upload still running). */
	error?: string;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const user = useAuthStore((s) => s.user);
	const maxSizeMb = useConfigStore((s) => s.config?.file?.max_size ?? null);
	const [open, setOpen] = useState(false);
	const [editing, setEditing] = useState<number | null>(null);
	const input = useRef<HTMLInputElement>(null);
	const everything = useKnowledgeSearch('');
	const nothingToAttach =
		everything.data !== undefined &&
		everything.data.bases.length + everything.data.files.length + everything.data.notes.length === 0;
	// Uploads finish asynchronously; the latest list is read through a ref so a
	// finishing upload doesn't overwrite items added or removed in the meantime.
	const latest = useRef(items);
	latest.current = items;
	const commit = (next: KnowledgeItem[]) => {
		latest.current = next;
		onChange(next);
	};

	const canUpload =
		user?.role === 'admin' ||
		Boolean((user?.permissions as { chat?: { file_upload?: boolean } } | undefined)?.chat?.file_upload);

	const upload = async (file: File) => {
		if (file.size === 0) {
			toast.error(`“${file.name}” is empty, so it wasn't added.`);
			return;
		}
		// 0 or unset is no limit, as on the server (#238).
		if (maxSizeMb && file.size > maxSizeMb * 1024 * 1024) {
			toast.error(`“${file.name}” is larger than the ${maxSizeMb} MB limit, so it wasn't added.`);
			return;
		}
		if (file.type.startsWith('image/')) {
			toast.error(`“${file.name}” is an image. Knowledge takes documents; attach images in a chat.`);
			return;
		}
		const itemId = `upload-${Date.now()}-${Math.random()}`;
		commit([...latest.current, { type: 'file', name: file.name, status: 'uploading', size: file.size, itemId }]);
		try {
			const uploaded = await uploadFile(token, file, null);
			if (!uploaded) throw new Error('The server returned no file.');
			if (uploaded.error) toast.warning(`“${file.name}” was added, but: ${uploaded.error}`);
			commit(
				latest.current.map((it) =>
					it.itemId === itemId
						? {
								...it,
								status: 'uploaded',
								file: uploaded,
								id: uploaded.id,
								url: `${uploaded.id}`,
								collection_name: uploaded?.meta?.collection_name || uploaded?.collection_name
							}
						: it
				)
			);
		} catch (e) {
			const { cause, detail } = failureCause(errorDetail(e));
			toast.error(`Couldn't upload “${file.name}”. ${cause}`, detail ? { description: detail } : undefined);
			commit(latest.current.filter((it) => it.itemId !== itemId));
		}
	};

	const editingItem = editing !== null ? items[editing] : null;
	const editable = (item: KnowledgeItem) => item.type === 'file' || item.type === 'note';

	return (
		<div>
			<Dialog open={editingItem !== null} onOpenChange={(o) => !o && setEditing(null)}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>{editingItem?.name || editingItem?.id}</DialogTitle>
						<DialogDescription className={editingItem?.description ? undefined : 'sr-only'}>
							{editingItem?.description || 'Attached knowledge.'}
						</DialogDescription>
					</DialogHeader>
					{editingItem && editable(editingItem) && (
						<div className="flex items-start justify-between gap-3">
							<div>
								<Label htmlFor="knowledge-whole-document" className="text-body">
									Use the whole document
								</Label>
								<p id="knowledge-whole-document-help" className="text-foreground-muted text-dense mt-1">
									When off, only the passages that match the question are used.
								</p>
							</div>
							<Switch
								id="knowledge-whole-document"
								aria-describedby="knowledge-whole-document-help"
								checked={editingItem.context === 'full'}
								onCheckedChange={(on) =>
									commit(items.map((it, i) => (i === editing ? { ...it, context: on ? 'full' : undefined } : it)))
								}
							/>
						</div>
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
					for (const file of chosen) upload(file);
				}}
			/>

			<div className="flex min-h-8 w-full flex-wrap items-center gap-x-3 gap-y-1">
				<h4 className={groupLabel}>Knowledge</h4>
				{!nothingToAttach && (
					<Popover open={open} onOpenChange={setOpen}>
						<PopoverTrigger asChild>
							<Button variant="outline" size="sm" type="button">
								Choose knowledge
							</Button>
						</PopoverTrigger>
						<PopoverContent align="start" aria-label="Attach knowledge" className="w-[min(24rem,calc(100vw-2rem))] p-1">
							<KnowledgeSearch
								onPick={(item) => {
									if (!items.find((k) => k.id === item.id)) commit([...items, { ...item }]);
									setOpen(false);
								}}
							/>
						</PopoverContent>
					</Popover>
				)}
				{canUpload && (
					<Button variant="ghost" size="sm" type="button" onClick={() => input.current?.click()}>
						<Upload aria-hidden />
						Upload files
					</Button>
				)}
			</div>

			{items.length > 0 && (
				<div className="mt-1 flex flex-wrap items-center gap-1.5">
					{items.map((file, i) => {
						const name = file.name || file.id;
						return (
							<div
								key={file.itemId ?? `${file.id}-${i}`}
								className="bg-surface-2 flex min-w-0 max-w-full items-center gap-1 rounded-lg ps-1"
							>
								<Button
									variant="ghost"
									size="sm"
									className="min-w-0 gap-1.5 shrink"
									type="button"
									aria-label={editable(file) ? `Edit ${name}` : `Details of ${name}`}
									onClick={() => setEditing(i)}
								>
									<span className="text-foreground-muted shrink-0">{iconFor(file)}</span>
									<span className="min-w-0 truncate">{name}</span>
								</Button>
								{file.status === 'uploading' && (
									<span className="text-foreground-muted text-dense shrink-0">Uploading</span>
								)}
								<Button
									variant="ghost"
									size="icon-sm"
									type="button"
									aria-label={`Remove ${name}`}
									onClick={() => commit(items.filter((_, idx) => idx !== i))}
								>
									<X aria-hidden />
								</Button>
							</div>
						);
					})}
					<Button type="button" variant="ghost" size="sm" onClick={() => commit([])}>
						Remove all
					</Button>
				</div>
			)}
			{error ? (
				<p role="alert" className="text-danger text-dense mt-1">
					{error}
				</p>
			) : (
				nothingToAttach &&
				items.length === 0 && (
					<p className="text-foreground-muted text-dense mt-1">
						No knowledge bases yet.{' '}
						<Link to={routePaths.workspaceKnowledge} className="text-link underline">
							Create one in Knowledge
						</Link>
						{canUpload ? ', or upload files here.' : '.'}
					</p>
				)
			)}
		</div>
	);
}
