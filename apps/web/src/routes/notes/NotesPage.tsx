import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import saveAs from 'file-saver';
import { ChevronDown, Download, Link2, MoreHorizontal, Pin, PinOff, Trash2 } from 'lucide-react';
import { type DragEvent, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { InfiniteLoader } from '@/components/common/InfiniteLoader';
import { ListSearchBar, SortHeaderButton } from '@/components/common/ListChrome';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { createNewNote, deleteNoteById, getNoteById, searchNotes, toggleNotePinnedStatusById } from '@/lib/apis/notes';
import { useAuthStore } from '@/lib/stores/authStore';
import { useDocumentTitle } from '@/lib/stores/configStore';
import { copyToClipboard } from '@/lib/utils';
import { dayjs } from '@/lib/utils/dates';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';
import { FeatureGate } from '@/routes/common/FeatureGate';
import { type NoteListItem, contentFromMarkdown, groupNotes, importableNote, nextSort, safeFileName } from './notesModel';

const filterSelect = 'bg-transparent px-1.5 text-[0.8125rem] outline-hidden [&>option]:bg-popover';

/** Creates a note and returns its id (title defaults to today's date, as in the original). */
export async function createNote(token: string, title = dayjs().format('YYYY-MM-DD'), md = '') {
	const res = await createNewNote(token, { title, data: { content: contentFromMarkdown(md) }, meta: null, access_grants: [] });
	return res?.id as string | undefined;
}

/**
 * Ports routes/(app)/notes and components/notes/Notes.svelte: search, filters
 * (whose notes, what access, list or grid), sorting, the notes grouped by
 * when they changed and loaded a page at a time, and per-note download /
 * copy link / pin / delete. Creating, importing .md/.txt (the button or a
 * drop) and `?title=&content=` (a link that makes a note) are all here.
 */
function Notes() {
	useDocumentTitle('Notes');
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [params] = useSearchParams();
	const importInput = useRef<HTMLInputElement>(null);
	const [search, setSearch] = useState('');
	const [viewOption, setViewOption] = useState('');
	const [permission, setPermission] = useState('');
	const [display, setDisplay] = useState<'list' | 'grid'>('list');
	const [sort, setSort] = useState<{ key: string; direction: 'asc' | 'desc' }>({ key: 'updated_at', direction: 'desc' });
	const [deleting, setDeleting] = useState<NoteListItem | null>(null);
	const [dragging, setDragging] = useState(false);
	const query = useDebouncedValue(search, 300);

	// A `?title=`/`?content=` link creates that note and opens it.
	const creating = params.has('title') || params.has('content');
	useEffect(() => {
		if (!creating) return;
		createNote(token, params.get('title') ?? undefined, params.get('content') ?? '').then((id) => id && navigate(`/notes/${id}`, { replace: true }));
		// Once, for the link that brought us here.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const perm = viewOption === 'created' ? null : permission || null;
	const list = useInfiniteQuery({
		queryKey: ['notes', 'list', query, viewOption, perm, sort.key, sort.direction],
		queryFn: async ({ pageParam }) => (await searchNotes(token, query, viewOption || null, perm, sort.key, pageParam, sort.direction).catch(() => null)) ?? { items: [], total: 0 },
		initialPageParam: 1,
		getNextPageParam: (last, pages) => ((last.items ?? []).length === 0 ? undefined : pages.length + 1),
		enabled: !creating
	});
	const seen = new Set<string>();
	const items: NoteListItem[] = (list.data?.pages ?? []).flatMap((p) => p.items ?? []).filter((n: NoteListItem) => !seen.has(n.id) && seen.add(n.id));
	const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['notes'] }), queryClient.invalidateQueries({ queryKey: ['pinned-notes'] })]);

	const importFiles = async (files: File[]) => {
		let imported = 0;
		for (const file of files) {
			const meta = importableNote(file);
			if (!meta) return void toast.error('Only txt and md files are allowed');
			const id = await createNote(token, meta.title, await file.text()).catch((err) => void toast.error(`${err}`));
			if (id) imported++;
		}
		if (imported) {
			toast.success('Imported notes successfully');
			await refresh();
		}
	};
	const download = async (n: NoteListItem, type: 'md' | 'txt') => {
		// The list may not carry the full body.
		const note = await getNoteById(token, n.id).catch((err) => void toast.error(`${err}`));
		if (!note) return;
		saveAs(new Blob([note.data?.content?.md ?? ''], { type: type === 'md' ? 'text/markdown' : 'text/plain' }), safeFileName(note.title, type));
	};
	const copyLink = async (n: NoteListItem) => {
		const ok = await copyToClipboard(`${window.location.origin}/notes/${n.id}`);
		if (ok) toast.success('Copied link to clipboard');
		else toast.error('Failed to copy link');
	};
	const togglePin = async (n: NoteListItem) => {
		await toggleNotePinnedStatusById(token, n.id).catch((err) => void toast.error(`${err}`));
		await refresh();
	};
	const remove = async () => {
		if (!deleting) return;
		const res = await deleteNoteById(token, deleting.id).catch((err) => void toast.error(`${err}`));
		setDeleting(null);
		if (res) await refresh();
	};
	const onDrop = async (e: DragEvent) => {
		e.preventDefault();
		setDragging(false);
		const files = Array.from(e.dataTransfer?.files ?? []);
		if (files.length) await importFiles(files);
	};

	if (creating) {
		return (
			<div className="flex flex-1 items-center justify-center">
				<Spinner className="size-5" />
			</div>
		);
	}

	const menu = (n: NoteListItem) => (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button type="button" aria-label={`Note menu for ${n.title}`} className="hover:bg-muted rounded-lg p-1" onClick={(e) => e.stopPropagation()}>
					<MoreHorizontal className="size-4" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem onSelect={() => download(n, 'md')}>
					<Download /> Download (.md)
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => download(n, 'txt')}>
					<Download /> Download (.txt)
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => copyLink(n)}>
					<Link2 /> Copy link
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => togglePin(n)}>{n.is_pinned ? <><PinOff /> Unpin</> : <><Pin /> Pin to Sidebar</>}</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => setDeleting(n)}>
					<Trash2 /> Delete
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
	const author = (n: NoteListItem) => n.user?.name ?? n.user?.email ?? 'Deleted User';

	return (
		// A drop target for importing files; the Import button is the keyboard path.
		<div
			className="relative flex h-full min-h-0 w-full flex-col"
			onDragOver={(e) => {
				e.preventDefault();
				setDragging(e.dataTransfer?.types?.includes('Files') ?? false);
			}}
			onDragLeave={() => setDragging(false)}
			onDrop={onDrop}
		>
			{dragging && <div className="bg-background/80 pointer-events-none absolute inset-0 z-20 flex items-center justify-center border-2 border-dashed text-sm">Drop .md or .txt files to import</div>}
			<ConfirmDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)} title="Delete note?" confirmLabel="Delete" onConfirm={remove}>
				This will delete <span className="font-medium">{deleting?.title}</span>.
			</ConfirmDialog>
			<input
				ref={importInput}
				type="file"
				accept=".md,.txt,text/markdown,text/plain"
				multiple
				hidden
				aria-label="Import note files"
				onChange={(e) => {
					importFiles(Array.from(e.target.files ?? []));
					e.target.value = '';
				}}
			/>

			<div className="flex shrink-0 items-center gap-1 px-2.5 pt-2 pb-1">
				<h1 className="flex-1 px-1 text-sm">Notes</h1>
				<Button
					type="button"
					size="sm"
					className="rounded-r-none"
					onClick={async () => {
						const id = await createNote(token).catch((err) => void toast.error(`${err}`));
						if (id) navigate(`/notes/${id}`);
					}}
				>
					Create
				</Button>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button type="button" size="sm" className="rounded-l-none border-l px-1.5" aria-label="More create options">
							<ChevronDown className="size-3.5" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem onSelect={() => importInput.current?.click()}>Import txt/md</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">
				<ListSearchBar value={search} onChange={setSearch} placeholder="Search Notes">
					<select aria-label="Whose notes" className={filterSelect} value={viewOption} onChange={(e) => setViewOption(e.target.value)}>
						<option value="">All</option>
						<option value="created">Created by you</option>
						<option value="shared">Shared with you</option>
					</select>
					{viewOption !== 'created' && (
						<select aria-label="Access" className={filterSelect} value={permission} onChange={(e) => setPermission(e.target.value)}>
							<option value="">Write</option>
							<option value="read_only">Read Only</option>
						</select>
					)}
					<select aria-label="Display" className={filterSelect} value={display} onChange={(e) => setDisplay(e.target.value as 'list' | 'grid')}>
						<option value="list">List</option>
						<option value="grid">Grid</option>
					</select>
				</ListSearchBar>

				{list.isLoading ? (
					<div className="flex min-h-[50vh] items-center justify-center">
						<Spinner className="size-5" />
					</div>
				) : items.length === 0 ? (
					<div className="flex min-h-[50vh] flex-col items-center justify-center text-center">
						<div className="mb-1.5 text-sm">{query ? 'No results found' : 'No Notes'}</div>
						<div className="text-muted-foreground max-w-sm text-xs">{query ? 'Try adjusting your search or filter to find what you are looking for.' : 'Create your first note by clicking on the plus button below.'}</div>
					</div>
				) : (
					<>
						{display === 'list' && (
							<div className="text-muted-foreground mt-2 flex px-3 text-xs">
								<SortHeaderButton label="Title" active={sort.key === 'name'} direction={sort.direction} onClick={() => setSort(nextSort(sort, 'name'))} className="flex flex-1 items-center gap-1" />
								<SortHeaderButton label="Updated at" active={sort.key === 'updated_at'} direction={sort.direction} onClick={() => setSort(nextSort(sort, 'updated_at'))} className="flex w-32 items-center gap-1" />
							</div>
						)}
						{groupNotes(items).map(([range, notes]) => (
							<section key={range} aria-label={range} className="mt-3">
								<h2 className="text-muted-foreground px-3 pb-1 text-xs">{range}</h2>
								{display === 'list' ? (
									<ul>
										{notes.map((n) => (
											<li key={n.id} className="hover:bg-muted/50 flex items-center gap-2 rounded-xl px-3 py-1.5 transition">
												<Link to={`/notes/${n.id}`} className="flex min-w-0 flex-1 items-center gap-2">
													<span className="min-w-0 flex-1 truncate text-sm">{n.title}</span>
													<span className="text-muted-foreground hidden w-28 truncate text-xs sm:block">{author(n)}</span>
													<span className="text-muted-foreground w-24 shrink-0 text-xs">{dayjs(n.updated_at / 1_000_000).fromNow()}</span>
												</Link>
												{menu(n)}
											</li>
										))}
									</ul>
								) : (
									<div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
										{notes.map((n) => (
											<div key={n.id} className="hover:bg-muted/40 flex flex-col rounded-2xl border p-3 transition">
												<div className="flex items-start gap-2">
													<Link to={`/notes/${n.id}`} className="min-w-0 flex-1 truncate text-sm font-medium">
														{n.title}
													</Link>
													{menu(n)}
												</div>
												<p className="text-muted-foreground mt-1 line-clamp-4 min-h-[4rem] text-xs whitespace-pre-wrap">{n.data?.content?.md || 'No content'}</p>
												<div className="text-muted-foreground mt-2 flex justify-between text-[0.6875rem]">
													<span className="truncate">{author(n)}</span>
													<span>{dayjs(n.updated_at / 1_000_000).fromNow()}</span>
												</div>
											</div>
										))}
									</div>
								)}
							</section>
						))}
						{list.hasNextPage && (
							<InfiniteLoader onVisible={() => !list.isFetchingNextPage && list.fetchNextPage()}>
								<div className="flex justify-center py-4">{list.isFetchingNextPage && <Spinner className="size-4" />}</div>
							</InfiniteLoader>
						)}
					</>
				)}
			</div>
		</div>
	);
}

export function NotesPage() {
	return (
		<FeatureGate feature="notes">
			<Notes />
		</FeatureGate>
	);
}

/** Ports routes/(app)/notes/new: create a note (from `?title=`/`?content=` if given) and open it. */
function NewNote() {
	const token = useAuthStore((s) => s.token) ?? '';
	const navigate = useNavigate();
	const [params] = useSearchParams();
	useEffect(() => {
		createNote(token, params.get('title') ?? undefined, params.get('content') ?? '')
			.then((id) => navigate(id ? `/notes/${id}` : '/notes', { replace: true }))
			.catch((err) => {
				toast.error(`${err}`);
				navigate('/notes', { replace: true });
			});
		// Once.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	return (
		<div className="flex flex-1 items-center justify-center">
			<Spinner className="size-5" />
		</div>
	);
}

export function NewNotePage() {
	return (
		<FeatureGate feature="notes">
			<NewNote />
		</FeatureGate>
	);
}
