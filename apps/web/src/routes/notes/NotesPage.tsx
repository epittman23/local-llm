import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import saveAs from 'file-saver';
import { Download, LayoutGrid, Link2, List, MessageSquare, MoreHorizontal, Pin, PinOff, Trash2 } from 'lucide-react';
import { type DragEvent, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { FilterMenu, ViewSelector } from '@/components/common/FilterSelects';
import { toastFailure } from '@/components/common/failureToast';
import { InfiniteLoader } from '@/components/common/InfiniteLoader';
import { ListEmptyState, ListSearchBar, SortHeaderButton } from '@/components/common/ListChrome';
import { LoadFailed } from '@/components/common/LoadFailed';
import { Spinner } from '@/components/common/Spinner';
import { SplitCreateButton } from '@/components/common/SplitCreateButton';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { PageHeader } from '@/components/ui/page-header';
import { RowButton } from '@/components/ui/row-button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import {
	createNewNote,
	deleteNoteById,
	getNoteById,
	getPinnedNoteList,
	searchNotes,
	toggleNotePinnedStatusById
} from '@/lib/apis/notes';
import { useAuthStore } from '@/lib/stores/authStore';
import { useDocumentTitle } from '@/lib/stores/configStore';
import { copyToClipboard } from '@/lib/utils';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';
import { FeatureGate } from '@/routes/common/FeatureGate';
import { useSingleUser } from '@/routes/workspace/workspaceAccess';
import { askAboutNote } from './noteChat';
import {
	contentFromMarkdown,
	fullTime,
	groupNotes,
	importableNote,
	NEW_NOTE_TITLE,
	type NoteListItem,
	type NoteOpenState,
	nextSort,
	notePreview,
	openLinkedNote,
	PINNED_NOTES_KEY,
	pinnedList,
	safeFileName,
	shortTime
} from './notesModel';

/** Creates a note and returns its id. */
export async function createNote(token: string, title = NEW_NOTE_TITLE, md = '') {
	const res = await createNewNote(token, {
		title,
		data: { content: contentFromMarkdown(md) },
		meta: null,
		access_grants: []
	});
	return res?.id as string | undefined;
}

const accessItems = [
	{ value: '', label: 'Can edit' },
	{ value: 'read_only', label: 'Read only' }
];

/**
 * Ports routes/(app)/notes and components/notes/Notes.svelte: search, sorting,
 * list or grid, the notes grouped by when they changed and loaded a page at a
 * time, pinned notes first, and per-note download / copy link / pin / delete.
 * Creating, importing .md/.txt (the menu or a drop) and `?title=&content=` (a
 * link that makes a note) are all here. With one account there is nobody to
 * share with, so whose notes, access and the author say nothing and are
 * hidden (WRD-4, S2-D2).
 */
function Notes() {
	useDocumentTitle('Notes');
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [params] = useSearchParams();
	const importInput = useRef<HTMLInputElement>(null);
	const singleUser = useSingleUser();
	const [search, setSearch] = useState('');
	const [storedView, setViewOption] = useState('');
	const [storedPermission, setPermission] = useState('');
	// With one account a stored filter would narrow the list by nothing a user can see.
	const viewOption = singleUser ? '' : storedView;
	const permission = singleUser ? '' : storedPermission;
	const [display, setDisplay] = useState<'list' | 'grid'>('list');
	const [sort, setSort] = useState<{ key: string; direction: 'asc' | 'desc' }>({
		key: 'updated_at',
		direction: 'desc'
	});
	const [deleting, setDeleting] = useState<NoteListItem | null>(null);
	const [dragging, setDragging] = useState(false);
	const query = useDebouncedValue(search, 300);

	// A `?title=`/`?content=` link creates that note and opens it.
	const creating = params.has('title') || params.has('content');
	useEffect(() => {
		if (!creating) return;
		void openLinkedNote(
			() => createNote(token, params.get('title') ?? undefined, params.get('content') ?? ''),
			(to) => navigate(to, { replace: true })
		);
		// Once, for the link that brought us here.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const perm = viewOption === 'created' ? null : permission || null;
	const list = useInfiniteQuery({
		queryKey: ['notes', 'list', query, viewOption, perm, sort.key, sort.direction],
		queryFn: async ({ pageParam }) =>
			(await searchNotes(token, query, viewOption || null, perm, sort.key, pageParam, sort.direction)) ?? {
				items: [],
				total: 0
			},
		initialPageParam: 1,
		getNextPageParam: (last, pages) => ((last.items ?? []).length === 0 ? undefined : pages.length + 1),
		enabled: !creating
	});
	const narrowed = query.trim() !== '' || viewOption !== '' || permission !== '';
	// #963: pinned notes lead the list while nothing narrows it (the server pages by date, so they are fetched apart).
	const pinned = useQuery({
		queryKey: PINNED_NOTES_KEY,
		queryFn: async () => pinnedList(await getPinnedNoteList(token)),
		enabled: !creating && !narrowed
	});
	const pinnedItems = narrowed ? [] : (pinned.data ?? []);
	const pinnedIds = new Set(pinnedItems.map((n) => n.id));
	// A failed first page is shown in place of the list (STA-4); a failed later
	// page leaves the notes already shown alone.
	const failed = list.data === undefined && (list.isError || list.isPaused);
	const seen = new Set<string>();
	const items: NoteListItem[] = (list.data?.pages ?? [])
		.flatMap((p) => p.items ?? [])
		.filter((n: NoteListItem) => !seen.has(n.id) && seen.add(n.id));
	const groups: [string, NoteListItem[]][] = [
		...(pinnedItems.length ? [['Pinned', pinnedItems] as [string, NoteListItem[]]] : []),
		...groupNotes(items.filter((n) => !pinnedIds.has(n.id)))
	];
	const refresh = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: ['notes'] }),
			queryClient.invalidateQueries({ queryKey: PINNED_NOTES_KEY })
		]);

	const newNote = async () => {
		try {
			const id = await createNote(token);
			if (id) navigate(`/notes/${id}`, { state: { fresh: true } satisfies NoteOpenState });
			else toastFailure("Couldn't create the note.");
		} catch (error) {
			toastFailure("Couldn't create the note.", error);
		}
	};
	const importFiles = async (files: File[]) => {
		let imported = 0;
		for (const file of files) {
			const meta = importableNote(file);
			if (!meta) return void toast.error(`“${file.name}” is not a .md or .txt file, so it wasn't imported.`);
			const id = await createNote(token, meta.title, await file.text()).catch(
				(error) => void toastFailure(`Couldn't import “${file.name}”.`, error)
			);
			if (id) imported++;
		}
		if (imported) {
			toast.success(imported === 1 ? 'Imported 1 note' : `Imported ${imported} notes`);
			await refresh();
		}
	};
	const download = async (n: NoteListItem, type: 'md' | 'txt') => {
		// The list may not carry the full body.
		const note = await getNoteById(token, n.id).catch(
			(error) => void toastFailure(`Couldn't download “${n.title}”.`, error)
		);
		if (!note) return;
		saveAs(
			new Blob([note.data?.content?.md ?? ''], { type: type === 'md' ? 'text/markdown' : 'text/plain' }),
			safeFileName(note.title, type)
		);
	};
	const copyLink = async (n: NoteListItem) => {
		const ok = await copyToClipboard(`${window.location.origin}/notes/${n.id}`);
		if (ok) toast.success('Copied link to clipboard');
		else toast.error("Couldn't copy the link: the browser blocked clipboard access");
	};
	const togglePin = async (n: NoteListItem, isPinned: boolean) => {
		try {
			await toggleNotePinnedStatusById(token, n.id);
			toast.success(isPinned ? 'Note unpinned' : 'Note pinned');
		} catch (error) {
			toastFailure(isPinned ? `Couldn't unpin “${n.title}”.` : `Couldn't pin “${n.title}”.`, error);
		}
		await refresh();
	};
	const remove = async () => {
		if (!deleting) return;
		const target = deleting;
		setDeleting(null);
		try {
			await deleteNoteById(token, target.id);
			toast.success('Note deleted');
		} catch (error) {
			toastFailure(`Couldn't delete “${target.title}”.`, error);
		}
		await refresh();
	};
	const onDrop = async (e: DragEvent) => {
		e.preventDefault();
		setDragging(false);
		const files = Array.from(e.dataTransfer?.files ?? []);
		if (files.length) await importFiles(files);
	};
	const clearFilters = () => {
		setSearch('');
		setViewOption('');
		setPermission('');
	};

	if (creating) {
		return (
			<div className="flex flex-1 items-center justify-center">
				<Spinner className="size-5" />
			</div>
		);
	}

	const menu = (n: NoteListItem) => {
		const isPinned = Boolean(n.is_pinned) || pinnedIds.has(n.id);
		return (
			<DropdownMenu>
				<Tip content="More">
					<DropdownMenuTrigger asChild>
						<Button type="button" variant="ghost" size="icon-sm" aria-label={`More for ${n.title}`}>
							<MoreHorizontal className="size-4" />
						</Button>
					</DropdownMenuTrigger>
				</Tip>
				<DropdownMenuContent align="end" className="min-w-52">
					<DropdownMenuItem onSelect={() => navigate(askAboutNote(n.id).to)}>
						<MessageSquare /> Ask in a new chat
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem onSelect={() => download(n, 'md')}>
						<Download /> Download (.md)
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={() => download(n, 'txt')}>
						<Download /> Download (.txt)
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={() => copyLink(n)}>
						<Link2 /> Copy link
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={() => togglePin(n, isPinned)}>
						{isPinned ? (
							<>
								<PinOff /> Unpin
							</>
						) : (
							<>
								<Pin /> Pin to sidebar
							</>
						)}
					</DropdownMenuItem>
					{n.write_access !== false && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem variant="destructive" onSelect={() => setDeleting(n)}>
								<Trash2 /> Delete
							</DropdownMenuItem>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		);
	};
	const author = (n: NoteListItem) => n.user?.name ?? n.user?.email ?? 'Deleted User';
	const pinMark = (n: NoteListItem) =>
		(n.is_pinned || pinnedIds.has(n.id)) && (
			<Pin aria-label="Pinned" role="img" className="text-foreground-muted size-3.5 shrink-0" />
		);
	const when = (n: NoteListItem) => (
		<Tip content={fullTime(n.updated_at)}>
			<span className="text-foreground-muted shrink-0 text-caption whitespace-nowrap tabular-nums">
				{shortTime(n.updated_at)}
			</span>
		</Tip>
	);
	const open = (n: NoteListItem) => navigate(`/notes/${n.id}`);

	return (
		// A drop target for importing files; the New note menu's Import is the keyboard path.
		<div
			className="relative flex h-full min-h-0 w-full flex-col"
			onDragOver={(e) => {
				e.preventDefault();
				setDragging(e.dataTransfer?.types?.includes('Files') ?? false);
			}}
			onDragLeave={() => setDragging(false)}
			onDrop={onDrop}
		>
			{dragging && (
				<div className="bg-background/80 pointer-events-none absolute inset-0 z-20 flex items-center justify-center border-2 border-dashed text-body">
					Drop .md or .txt files to import them as notes
				</div>
			)}
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={`Delete “${deleting?.title ?? ''}”?`}
				confirmLabel="Delete note"
				destructive
				onConfirm={remove}
			>
				The note and its text are deleted. It can't be undone.
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

			<div className="shrink-0 px-4 pt-4 pb-3">
				<div className="ps-[var(--shell-menu-inset,0px)]">
					<PageHeader
						title="Notes"
						description="Derivations, snippets and results you keep, written in Markdown."
						action={
							<SplitCreateButton
								filled
								label="New note"
								actions={[
									{ id: 'note-new', label: 'New note', onClick: newNote },
									{ id: 'note-import', label: 'Import .md or .txt', onClick: () => importInput.current?.click() }
								]}
							/>
						}
					/>
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
				<ListSearchBar value={search} onChange={setSearch} placeholder="Search notes">
					{!singleUser && <ViewSelector value={viewOption} onChange={setViewOption} />}
					{!singleUser && viewOption !== 'created' && (
						<FilterMenu
							value={permission}
							items={accessItems}
							onChange={setPermission}
							trigger={
								<Button variant="ghost" size="sm">
									<span className="truncate">Access: {accessItems.find((i) => i.value === permission)?.label}</span>
								</Button>
							}
						/>
					)}
					<SegmentedControl
						aria-label="Display"
						value={display}
						onValueChange={setDisplay}
						options={[
							{ value: 'list', label: 'List', icon: List },
							{ value: 'grid', label: 'Grid', icon: LayoutGrid }
						]}
						className="max-sm:w-auto max-sm:grid-cols-none max-sm:inline-flex"
					/>
				</ListSearchBar>

				{failed ? (
					<LoadFailed what="notes" error={list.error} onRetry={() => list.refetch()} retrying={list.isFetching} />
				) : list.isLoading ? (
					<div className="flex min-h-[50vh] items-center justify-center">
						<Spinner className="size-5" />
					</div>
				) : groups.length === 0 ? (
					<ListEmptyState
						title="No notes yet"
						description="Keep derivations, snippets and results here. A note is Markdown, with math and code."
						action={
							<div className="flex flex-wrap justify-center gap-2">
								<Button type="button" size="sm" onClick={newNote}>
									New note
								</Button>
								<Button type="button" size="sm" variant="outline" onClick={() => importInput.current?.click()}>
									Import .md or .txt
								</Button>
							</div>
						}
						query={query}
						filtered={viewOption !== '' || permission !== ''}
						onClear={clearFilters}
					/>
				) : (
					<>
						{display === 'list' && (
							<div className="text-muted-foreground mt-2 flex items-center gap-2 px-1.5 text-caption">
								<SortHeaderButton
									label="Title"
									active={sort.key === 'name'}
									direction={sort.direction}
									onClick={() => setSort(nextSort(sort, 'name'))}
									className="flex min-w-0 flex-1 items-center gap-1"
								/>
								<SortHeaderButton
									label="Updated"
									active={sort.key === 'updated_at'}
									direction={sort.direction}
									onClick={() => setSort(nextSort(sort, 'updated_at'))}
									className="flex shrink-0 items-center justify-end gap-1"
								/>
								{/* The menu's column. */}
								<div aria-hidden className="w-7 shrink-0" />
							</div>
						)}
						{groups.map(([range, notes]) => (
							<section key={range} aria-label={range} className="mt-3">
								<h2 className="text-foreground-muted flex items-center gap-1.5 px-2 pb-1 text-caption font-strong">
									{range === 'Pinned' && <Pin aria-hidden className="size-3" />}
									{range}
								</h2>
								{display === 'list' ? (
									<ul className="grid gap-y-0.5">
										{notes.map((n) => {
											const preview = notePreview(n.data?.content?.md).replace(/\n/g, ' · ');
											return (
												// The row's menu sits beside the button that opens it, not inside it (ACT-7).
												<li key={n.id} className="hover:bg-surface-3 flex min-w-0 items-center gap-1 rounded-lg pe-1">
													<RowButton
														className="flex min-h-11 min-w-0 flex-1 flex-col justify-center px-2 py-1.5 hover:bg-transparent"
														onClick={() => open(n)}
													>
														<span className="flex w-full min-w-0 items-center gap-2">
															<span className="min-w-0 truncate">{n.title}</span>
															{pinMark(n)}
															{!singleUser && (
																<span className="text-foreground-muted ms-auto hidden max-w-40 shrink-0 truncate text-caption md:block">
																	{author(n)}
																</span>
															)}
															<span className={singleUser ? 'ms-auto flex' : 'flex md:ms-0 ms-auto'}>{when(n)}</span>
														</span>
														{preview && (
															<span className="text-foreground-muted block w-full truncate text-caption">
																{preview}
															</span>
														)}
													</RowButton>
													{menu(n)}
												</li>
											);
										})}
									</ul>
								) : (
									<ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
										{notes.map((n) => (
											<li key={n.id} className="hover:bg-surface-3 flex flex-col rounded-lg border">
												<div className="flex items-start gap-1 pe-1 pt-1">
													<RowButton
														className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 font-strong hover:bg-transparent"
														onClick={() => open(n)}
													>
														<span className="min-w-0 truncate">{n.title}</span>
														{pinMark(n)}
													</RowButton>
													{menu(n)}
												</div>
												<p className="text-foreground-muted line-clamp-4 min-h-16 px-3 text-dense whitespace-pre-line">
													{notePreview(n.data?.content?.md) || 'No text yet'}
												</p>
												<div className="text-foreground-muted mt-auto flex items-center justify-between gap-2 px-3 pt-2 pb-2.5 text-caption">
													{!singleUser && <span className="min-w-0 truncate">{author(n)}</span>}
													<span className="ms-auto">{when(n)}</span>
												</div>
											</li>
										))}
									</ul>
								)}
							</section>
						))}
						{list.hasNextPage && (
							<InfiniteLoader onVisible={() => !list.isFetchingNextPage && list.fetchNextPage()}>
								<div className="flex justify-center py-4">
									{list.isFetchingNextPage && <Spinner className="size-4" />}
								</div>
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
	// Without a title or text from the link, this is a new note like the list's.
	const fresh = useRef(!params.has('title') && !params.has('content'));
	useEffect(() => {
		void openLinkedNote(
			() => createNote(token, params.get('title') ?? undefined, params.get('content') ?? ''),
			(to) =>
				navigate(to, { replace: true, state: fresh.current ? ({ fresh: true } satisfies NoteOpenState) : undefined })
		);
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
