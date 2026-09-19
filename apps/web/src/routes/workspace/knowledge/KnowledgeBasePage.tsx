import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, SlidersHorizontal, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { AccessButton } from '@/components/common/AccessButton';
import { AccessControlModal } from '@/components/common/AccessControlModal';
import { AttachWebpageDialog } from '@/components/common/AttachWebpageDialog';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { PagePagination } from '@/components/common/PagePagination';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import type { AccessGrant } from '@/lib/access/accessGrants';
import { getFileById, renameFileById, updateFileDataContentById } from '@/lib/apis/files';
import {
	createKnowledgeDirectory,
	deleteKnowledgeDirectory,
	getKnowledgeById,
	getPendingKnowledgeFiles,
	moveFileInKnowledge,
	removeFileFromKnowledgeById,
	resetKnowledgeById,
	searchKnowledgeFilesById,
	updateKnowledgeAccessGrants,
	updateKnowledgeById,
	updateKnowledgeDirectory
} from '@/lib/apis/knowledge';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { useAuthStore } from '@/lib/stores/authStore';
import { blobToFile } from '@/lib/utils/files';
import { copyToClipboard } from '@/lib/utils';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';
import { routePaths } from '@/routes/routePaths';
import { ExternalKnowledgePanel } from './ExternalKnowledgePanel';
import { AddContentMenu, AddTextDialog, NewDirectoryDialog } from './KnowledgeDialogs';
import { type KnowledgeDirectory, type KnowledgeFile, KnowledgeBreadcrumbs, KnowledgeFileList } from './KnowledgeFileList';
import { type Breadcrumb, type DirectoryFileEntry } from './knowledgeFiles';
import { collectDirectoryFiles, collectDroppedEntryFiles, handleDirectoryError, useKnowledgeUploads } from './useKnowledgeUploads';

const PER_PAGE = 30;
const PENDING_POLL_MS = 5000;

type Knowledge = {
	id: string;
	name: string;
	description: string;
	write_access?: boolean;
	access_grants?: AccessGrant[];
	meta?: Record<string, any> | null;
};
type FilesPage = {
	items: KnowledgeFile[];
	total: number;
	directories: KnowledgeDirectory[];
	breadcrumbs: Breadcrumb[];
	hasPending: boolean;
};

const selectClass = 'bg-transparent text-xs outline-none [&>option]:bg-popover [&>option]:text-popover-foreground';

/**
 * Ports workspace/Knowledge/KnowledgeBase.svelte (the 1,745-line detail page):
 * the editable name/description, access, and -- for a local base -- a
 * searchable, sortable, paginated tree of folders and files with upload (files,
 * webpages, text, whole folders, drag-and-drop), incremental folder sync, move,
 * rename, delete, reset, and a side sheet to read and edit a file's extracted
 * text. A connected (external) base shows ExternalKnowledgePanel instead.
 *
 * Structure: this component is the state and layout; the pure path/diff logic is
 * in knowledgeFiles.ts and the upload/sync flows are in useKnowledgeUploads.ts.
 *
 * Differences: the Svelte page's right-hand `Drawer` is a `Sheet`; the view/sort
 * pickers are native selects; a file's speech-to-text language is not sent on
 * upload (no settings store yet).
 */
export function KnowledgeBasePage() {
	const { id } = useParams();
	const token = useAuthStore((s) => s.token) ?? '';
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const base = useQuery({
		queryKey: ['knowledge-base', id],
		enabled: Boolean(id),
		queryFn: async () => {
			const res = (await getKnowledgeById(token, id as string)) as Knowledge | null;
			return res ? { ...res, access_grants: Array.isArray(res.access_grants) ? res.access_grants : [] } : null;
		},
		retry: false
	});

	useEffect(() => {
		if (base.isError || (base.isSuccess && !base.data)) {
			if (base.isError) toast.error(`${base.error}`);
			navigate(routePaths.workspaceKnowledge);
		}
	}, [base.isError, base.isSuccess, base.data, base.error, navigate]);

	if (!id || !base.data) {
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner />
			</div>
		);
	}
	// Keyed by id so moving between bases resets every piece of local state below.
	return <KnowledgeBaseView key={id} id={id} initial={base.data} onChanged={() => queryClient.invalidateQueries({ queryKey: ['knowledge-base', id] })} />;
}

function KnowledgeBaseView({ id, initial, onChanged }: { id: string; initial: Knowledge; onChanged: () => void }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const user = useAuthStore((s) => s.user);
	const isAdmin = user?.role === 'admin';
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const [knowledge, setKnowledge] = useState<Knowledge>(initial);
	const writeAccess = Boolean(knowledge.write_access);
	const external = knowledge.meta?.source === 'external';

	// --- what the file list shows -------------------------------------------
	const [query, setQuery] = useState('');
	const debouncedQuery = useDebouncedValue(query, 300);
	const [viewOption, setViewOption] = useState<string>(() => localStorage.workspaceViewOption || '');
	const [sortKey, setSortKey] = useState('');
	const [direction, setDirection] = useState('');
	const [includeContent, setIncludeContent] = useState(false);
	const [page, setPage] = useState(1);
	const [directoryId, setDirectoryId] = useState<string | null>(null);
	const [selectedFileId, setSelectedFileId] = useState<string | null>(null);

	const files = useQuery({
		queryKey: ['knowledge-files', id, debouncedQuery, viewOption, sortKey, direction, page, directoryId, includeContent],
		enabled: !external,
		placeholderData: keepPreviousData,
		// While anything is still being processed, poll: the list should pick up the finished file.
		refetchInterval: (q) => (q.state.data?.hasPending ? PENDING_POLL_MS : false),
		queryFn: async (): Promise<FilesPage> => {
			const res = await searchKnowledgeFilesById(
				token,
				id,
				debouncedQuery,
				viewOption,
				sortKey || null,
				sortKey ? direction || null : null,
				page,
				directoryId,
				includeContent
			);
			let items: KnowledgeFile[] = res?.items ?? [];
			let hasPending = false;
			// Files still being processed aren't linked to the base yet; show them as uploading.
			try {
				const pending = await getPendingKnowledgeFiles(token, id);
				if (pending?.length) {
					hasPending = true;
					const existing = new Set(items.map((f) => f.id));
					const extra = pending
						.filter((f: KnowledgeFile) => !existing.has(f.id))
						.map((f: KnowledgeFile & { filename?: string }) => ({ ...f, name: f.meta?.name ?? f.filename, status: 'uploading' }));
					items = [...extra, ...items];
				}
			} catch (e) {
				console.warn('Failed to fetch pending files:', e);
			}
			return { items, total: res?.total ?? 0, directories: res?.directories ?? [], breadcrumbs: res?.breadcrumbs ?? [], hasPending };
		}
	});
	const refresh = useCallback(() => queryClient.invalidateQueries({ queryKey: ['knowledge-files', id] }), [queryClient, id]);
	const listed = files.data;
	const breadcrumbs = listed?.breadcrumbs ?? [];

	const { uploading, syncing, uploadFiles, uploadWeb, uploadDirectoryEntries, syncDirectory } = useKnowledgeUploads({
		knowledgeId: id,
		directoryId,
		breadcrumbs,
		refresh
	});

	// --- name and description save themselves -------------------------------
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => () => void (saveTimer.current && clearTimeout(saveTimer.current)), []);
	const scheduleSave = (next: Knowledge) => {
		if (saveTimer.current) clearTimeout(saveTimer.current);
		saveTimer.current = setTimeout(async () => {
			if (next.name.trim() === '' || next.description.trim() === '') {
				toast.error('Please fill in all fields.');
				return;
			}
			const res = await updateKnowledgeById(token, id, {
				...next,
				name: next.name,
				description: next.description,
				access_grants: next.access_grants ?? []
			} as never).catch((e) => {
				toast.error(`${e}`);
				return null;
			});
			if (res) toast.success('Knowledge updated successfully');
		}, 1000);
	};
	const edit = (patch: Partial<Knowledge>) => {
		const next = { ...knowledge, ...patch };
		setKnowledge(next);
		scheduleSave(next);
	};

	// --- dialogs ------------------------------------------------------------
	const [showAccess, setShowAccess] = useState(false);
	const [showWeb, setShowWeb] = useState(false);
	const [showText, setShowText] = useState(false);
	const [showNewDir, setShowNewDir] = useState(false);
	const [showReset, setShowReset] = useState(false);
	const [pendingSync, setPendingSync] = useState<DirectoryFileEntry[] | null>(null);
	const [deletingDir, setDeletingDir] = useState<string | null>(null);
	const [deleteContents, setDeleteContents] = useState(true);
	const fileInput = useRef<HTMLInputElement>(null);

	// --- drag files anywhere onto the page to upload -------------------------
	const [dragged, setDragged] = useState(false);
	const uploadRefs = useRef({ uploadFiles, uploadDirectoryEntries, writeAccess });
	uploadRefs.current = { uploadFiles, uploadDirectoryEntries, writeAccess };
	useEffect(() => {
		const onDragOver = (e: DragEvent) => {
			e.preventDefault();
			setDragged(Boolean(e.dataTransfer?.types?.includes('Files')));
		};
		const onDragLeave = () => setDragged(false);
		const onDrop = async (e: DragEvent) => {
			e.preventDefault();
			setDragged(false);
			if (!e.dataTransfer?.types?.includes('Files')) return;
			if (!uploadRefs.current.writeAccess) {
				toast.error('You do not have permission to upload files to this knowledge base.');
				return;
			}
			const items = Array.from(e.dataTransfer.items ?? []);
			if (items.length === 0) {
				toast.error('File not found.');
				return;
			}
			const directoryEntries: DirectoryFileEntry[] = [];
			const loose: File[] = [];
			for (const item of items as Array<DataTransferItem & { webkitGetAsEntry?: () => any }>) {
				const entry = item.webkitGetAsEntry?.();
				if (entry?.isDirectory) {
					try {
						directoryEntries.push(...(await collectDroppedEntryFiles(entry)));
					} catch (error) {
						handleDirectoryError(error);
						return;
					}
				} else {
					const file = item.getAsFile();
					if (file) loose.push(file);
				}
			}
			await uploadRefs.current.uploadFiles(loose);
			if (directoryEntries.length > 0) await uploadRefs.current.uploadDirectoryEntries(directoryEntries);
		};
		document.body.addEventListener('dragover', onDragOver);
		document.body.addEventListener('drop', onDrop);
		document.body.addEventListener('dragleave', onDragLeave);
		return () => {
			document.body.removeEventListener('dragover', onDragOver);
			document.body.removeEventListener('drop', onDrop);
			document.body.removeEventListener('dragleave', onDragLeave);
		};
	}, []);

	// --- file / directory operations -----------------------------------------
	const report = async <T,>(work: Promise<T>, success: string): Promise<boolean> => {
		try {
			const res = await work;
			if (res) {
				toast.success(success);
				refresh();
				return true;
			}
		} catch (e) {
			toast.error(`${e}`);
		}
		return false;
	};
	const navigateToDirectory = (dirId: string | null) => {
		setDirectoryId(dirId);
		setPage(1);
		setSelectedFileId(null);
	};
	const move = (payload: { kind: 'file' | 'dir'; id: string }, target: string | null) => {
		if (payload.kind === 'file') report(moveFileInKnowledge(token, id, payload.id, target), 'File moved.');
		else if (payload.id !== target) report(updateKnowledgeDirectory(token, id, payload.id, { parent_id: target }), 'Directory moved.');
	};
	const deleteFile = async (fileId: string) => {
		setSelectedFileId(null);
		try {
			if (await removeFileFromKnowledgeById(token, id, fileId)) {
				toast.success('File removed successfully.');
				refresh();
			}
		} catch (e) {
			toast.error(`${e}`);
		}
	};

	// --- the file preview sheet ----------------------------------------------
	const selectedFile = listed?.items.find((f) => f.id === selectedFileId) ?? null;
	const [content, setContent] = useState('');
	const [loadingContent, setLoadingContent] = useState(false);
	const [saving, setSaving] = useState(false);
	const [previewName, setPreviewName] = useState('');
	useEffect(() => {
		if (!selectedFileId) return;
		const file = listed?.items.find((f) => f.id === selectedFileId);
		if (!file) {
			setSelectedFileId(null);
			return;
		}
		setPreviewName(file.meta?.name ?? '');
		const inline = (file as { data?: { content?: string } }).data?.content;
		if (inline !== undefined) {
			setContent(inline);
			setLoadingContent(false);
			return;
		}
		let cancelled = false;
		setContent('');
		setLoadingContent(true);
		getFileById(token, selectedFileId)
			.then((full) => !cancelled && setContent(full?.data?.content ?? ''))
			.catch(() => !cancelled && toast.error('Failed to load file content.'))
			.finally(() => !cancelled && setLoadingContent(false));
		return () => {
			cancelled = true;
		};
		// Re-run only when the selection changes, not on every list refresh.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selectedFileId, token]);

	const saveContent = async () => {
		if (saving || loadingContent || !selectedFileId) return;
		setSaving(true);
		try {
			const res = await updateFileDataContentById(token, selectedFileId, content).catch((e) => {
				toast.error(`${e}`);
				return null;
			});
			if (res) {
				toast.success('File content updated successfully.');
				setSelectedFileId(null);
				refresh();
			}
		} finally {
			setSaving(false);
		}
	};

	if (external) {
		return (
			<div className="flex h-full min-h-full w-full flex-col">
				<Header knowledge={knowledge} edit={edit} writeAccess={writeAccess} total={null} onBack={() => navigate(routePaths.workspaceKnowledge)} onAccess={() => setShowAccess(true)} id={id} />
				<div className="bg-background mt-1.5 mb-2 flex-1 rounded-3xl border py-1.5">
					<ExternalKnowledgePanel external={(knowledge.meta?.external ?? {}) as never} />
				</div>
				{accessModal()}
			</div>
		);
	}

	function accessModal() {
		return (
			<AccessControlModal
				open={showAccess}
				onOpenChange={setShowAccess}
				accessGrants={knowledge.access_grants ?? []}
				accessRoles={['read', 'write']}
				share={Boolean(user?.permissions?.sharing?.knowledge) || isAdmin}
				sharePublic={Boolean(user?.permissions?.sharing?.public_knowledge) || isAdmin}
				shareUsers={(user?.permissions?.access_grants?.allow_users ?? true) || isAdmin}
				onChange={async (grants) => {
					setKnowledge((k) => ({ ...k, access_grants: grants }));
					try {
						await updateKnowledgeAccessGrants(token, id, grants);
						toast.success('Saved');
						onChanged();
					} catch (error) {
						toast.error(`${error}`);
					}
				}}
			/>
		);
	}

	return (
		<div id="collection-container" className="flex h-full min-h-full w-full flex-col">
			{dragged && (
				<div className="bg-background/80 fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm">
					<div className="text-center">
						<div className="text-lg font-medium">Add Files</div>
						<div className="text-muted-foreground text-sm">Drop any files here to upload</div>
					</div>
				</div>
			)}

			{accessModal()}

			<ConfirmDialog
				open={pendingSync !== null}
				onOpenChange={(open) => !open && setPendingSync(null)}
				title="Sync directory"
				confirmLabel="Continue"
				onConfirm={() => {
					const entries = pendingSync;
					setPendingSync(null);
					if (entries) syncDirectory(entries);
				}}
			>
				{pendingSync?.length ?? 0} files selected. Only new and modified files will be uploaded. Deleted files will be removed.
				The folder structure will be mirrored. Continue?
			</ConfirmDialog>
			<ConfirmDialog
				open={deletingDir !== null}
				onOpenChange={(open) => !open && setDeletingDir(null)}
				title="Delete directory?"
				confirmLabel="Delete"
				onConfirm={async () => {
					const dirId = deletingDir;
					setDeletingDir(null);
					if (dirId) await report(deleteKnowledgeDirectory(token, id, dirId, !deleteContents), 'Directory deleted.');
				}}
			>
				<div className="mb-2 text-sm">Are you sure you want to delete this directory?</div>
				<label className="flex items-center gap-1.5">
					<Checkbox checked={deleteContents} onCheckedChange={(c) => setDeleteContents(c === true)} />
					<span className="text-muted-foreground text-xs">Delete all contents inside this directory</span>
				</label>
			</ConfirmDialog>
			<ConfirmDialog
				open={showReset}
				onOpenChange={setShowReset}
				title="Reset knowledge base?"
				confirmLabel="Confirm"
				onConfirm={async () => {
					setShowReset(false);
					try {
						await resetKnowledgeById(token, id);
						toast.success('Knowledge base has been reset');
						refresh();
					} catch (e) {
						toast.error(`${e}`);
					}
				}}
			>
				This will remove all files and directories from this knowledge base. This action cannot be undone.
			</ConfirmDialog>

			<AttachWebpageDialog open={showWeb} onOpenChange={setShowWeb} onSubmit={uploadWeb} />
			<AddTextDialog
				open={showText}
				onOpenChange={setShowText}
				onSubmit={(name, text) => uploadFiles([blobToFile(new Blob([text], { type: 'text/plain' }), `${name}.txt`)])}
			/>
			<NewDirectoryDialog
				open={showNewDir}
				onOpenChange={setShowNewDir}
				onSubmit={(name) => report(createKnowledgeDirectory(token, id, name, directoryId), 'Directory created.')}
			/>
			<input
				ref={fileInput}
				id="files-input"
				type="file"
				multiple
				hidden
				onChange={async (e) => {
					const chosen = Array.from(e.target.files ?? []);
					if (chosen.length === 0) {
						toast.error('File not found.');
						return;
					}
					await uploadFiles(chosen);
					e.target.value = '';
				}}
			/>

			<Header
				knowledge={knowledge}
				edit={edit}
				writeAccess={writeAccess}
				total={listed?.total ?? null}
				onBack={() => navigate(routePaths.workspaceKnowledge)}
				onAccess={() => setShowAccess(true)}
				id={id}
			/>

			<div className="bg-background mt-1.5 mb-2 flex-1 rounded-3xl border py-1.5">
				<div className="flex w-full flex-1 items-center space-x-1.5 px-3">
					<div className="flex flex-1 items-center">
						<Search className="text-muted-foreground mr-2 ml-1 size-3.5" />
						<input
							className="w-full rounded-r-xl bg-transparent py-1 pr-4 text-xs outline-hidden"
							value={query}
							onChange={(e) => {
								setQuery(e.target.value);
								setPage(1);
							}}
							aria-label="Search Collection"
							placeholder="Search Collection"
							onFocus={() => setSelectedFileId(null)}
						/>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="ghost" size="icon-sm" aria-label="Search options">
									<SlidersHorizontal />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="min-w-44">
								<DropdownMenuCheckboxItem
									checked={includeContent}
									onCheckedChange={(c) => {
										setIncludeContent(c === true);
										setPage(1);
									}}
								>
									File content
								</DropdownMenuCheckboxItem>
							</DropdownMenuContent>
						</DropdownMenu>
						{writeAccess && (
							<AddContentMenu
								onUpload={async (kind) => {
									if (kind === 'directory') {
										const entries = await collectDirectoryFiles();
										if (entries?.length) await uploadDirectoryEntries(entries);
									} else if (kind === 'new_directory') setShowNewDir(true);
									else if (kind === 'web') setShowWeb(true);
									else if (kind === 'text') setShowText(true);
									else fileInput.current?.click();
								}}
								onSync={async () => {
									const entries = await collectDirectoryFiles();
									if (entries?.length) setPendingSync(entries);
								}}
								onReset={() => setShowReset(true)}
							/>
						)}
					</div>
				</div>

				<div className="flex items-center gap-2 px-2.5">
					<select
						className={selectClass}
						aria-label="View"
						value={viewOption}
						onChange={(e) => {
							const value = e.target.value;
							if (value) localStorage.workspaceViewOption = value;
							else delete localStorage.workspaceViewOption;
							setViewOption(value);
							setPage(1);
						}}
					>
						<option value="">All</option>
						<option value="created">Created by you</option>
						<option value="shared">Shared with you</option>
					</select>
					<select className={selectClass} aria-label="Sort" value={sortKey} onChange={(e) => setSortKey(e.target.value)}>
						<option value="">Sort</option>
						<option value="name">Name</option>
						<option value="created_at">Created</option>
						<option value="updated_at">Updated</option>
					</select>
					{sortKey && (
						<select className={selectClass} aria-label="Direction" value={direction} onChange={(e) => setDirection(e.target.value)}>
							<option value="asc">Asc</option>
							<option value="">Desc</option>
						</select>
					)}
				</div>

				{directoryId !== null && (
					<div className="mb-1 px-4">
						<KnowledgeBreadcrumbs rootLabel={knowledge.name} breadcrumbs={breadcrumbs} onNavigate={navigateToDirectory} onMove={move} />
					</div>
				)}

				{syncing && (
					<div className="mx-2 mt-2 -mb-0.5">
						<div className="bg-muted flex items-center gap-2 rounded-xl px-2.5 py-1.5">
							<Spinner className="size-3.5 shrink-0" />
							<div className="text-muted-foreground truncate text-xs">{syncing}</div>
						</div>
					</div>
				)}

				{!listed ? (
					<div className="my-10 flex justify-center">
						<Spinner className="size-4" />
					</div>
				) : (
					<div className="flex flex-1 flex-row gap-2 px-2">
						<div className="flex min-h-full w-full flex-col">
							{listed.items.length > 0 || listed.directories.length > 0 || uploading.length > 0 ? (
								<div className="flex h-full w-full overflow-y-auto text-xs">
									<KnowledgeFileList
										files={listed.items}
										uploading={uploading}
										directories={listed.directories}
										writeAccess={writeAccess}
										selectedFileId={selectedFileId}
										onSelect={setSelectedFileId}
										onDeleteFile={deleteFile}
										onRenameFile={(fileId, name) => report(renameFileById(token, fileId, name), 'File renamed.')}
										onOpenDirectory={navigateToDirectory}
										onRenameDirectory={(dirId, name) => report(updateKnowledgeDirectory(token, id, dirId, { name }), 'Directory renamed.')}
										onDeleteDirectory={(dirId) => {
											setDeleteContents(true);
											setDeletingDir(dirId);
										}}
										onMove={move}
									/>
								</div>
							) : (
								<div className="text-muted-foreground my-3 flex flex-col justify-center text-center text-xs">
									<div>No content found</div>
								</div>
							)}
							{listed.total > PER_PAGE && <PagePagination page={page} count={listed.total} perPage={PER_PAGE} onPageChange={setPage} />}
						</div>
					</div>
				)}
			</div>

			<Sheet open={selectedFileId !== null} onOpenChange={(open) => !open && setSelectedFileId(null)}>
				<SheetContent side="right" className="w-full sm:max-w-xl">
					<SheetTitle className="sr-only">File content</SheetTitle>
					<SheetDescription className="sr-only">The text extracted from this file.</SheetDescription>
					<div className="flex h-full max-h-full flex-col">
						<div className="flex shrink-0 items-center p-2 pr-10">
							<div className="line-clamp-1 flex-1 text-sm">
								<a
									href="#"
									className="line-clamp-1 hover:underline"
									onClick={(e) => {
										e.preventDefault();
										if (selectedFile?.id) window.open(`${WEBUI_API_BASE_URL}/files/${encodeURIComponent(selectedFile.id)}/content`, '_blank');
									}}
								>
									{previewName}
								</a>
							</div>
							{writeAccess && (
								<Button variant="ghost" size="sm" disabled={saving || loadingContent} onClick={saveContent}>
									Save
									{saving && <Spinner className="size-3.5" />}
								</Button>
							)}
						</div>
						<textarea
							key={selectedFileId}
							className="h-full w-full resize-none bg-transparent px-3 py-2 text-xs outline-none"
							value={content}
							onChange={(e) => setContent(e.target.value)}
							disabled={!writeAccess || loadingContent}
							aria-label="File content"
							placeholder="Add content here"
						/>
					</div>
				</SheetContent>
			</Sheet>
		</div>
	);
}

/** The name/description block at the top; both fields save themselves after a pause. */
function Header({
	knowledge,
	edit,
	writeAccess,
	total,
	onBack,
	onAccess,
	id
}: {
	knowledge: Knowledge;
	edit: (patch: Partial<Knowledge>) => void;
	writeAccess: boolean;
	total: number | null;
	onBack: () => void;
	onAccess: () => void;
	id: string;
}) {
	return (
		<div className="w-full px-2">
			<button
				type="button"
				className="text-muted-foreground hover:text-foreground mb-1 flex h-6 w-fit items-center gap-1 rounded-md text-xs transition-colors"
				onClick={onBack}
			>
				<ChevronLeft className="size-3" strokeWidth={2} />
				<span>Back</span>
			</button>
			<div className="flex w-full">
				<div className="flex-1 px-1">
					<div className="flex w-full items-center justify-between">
						<div className="flex w-full items-center justify-between">
							<input
								type="text"
								className="w-full flex-1 bg-transparent text-left text-sm outline-hidden"
								value={knowledge.name}
								aria-label="Knowledge Name"
								placeholder="Knowledge Name"
								disabled={!writeAccess}
								onChange={(e) => edit({ name: e.target.value })}
							/>
							<div className="mr-2.5 shrink-0">
								{total ? <div className="text-muted-foreground text-xs">{total} files</div> : null}
							</div>
						</div>
						{writeAccess ? (
							<div className="shrink-0 self-center">
								<AccessButton onClick={onAccess} />
							</div>
						) : (
							<div className="text-muted-foreground shrink-0 text-xs">Read Only</div>
						)}
					</div>
					<div className="flex w-full items-center">
						<input
							type="text"
							className="text-muted-foreground w-full flex-1 bg-transparent text-left text-xs outline-hidden"
							value={knowledge.description}
							aria-label="Knowledge Description"
							placeholder="Knowledge Description"
							disabled={!writeAccess}
							onChange={(e) => edit({ description: e.target.value })}
						/>
						<div className="hidden md:block">
							<Tip content="Click to copy ID">
								<button
									type="button"
									className="text-muted-foreground shrink-0 cursor-pointer rounded-lg px-2 py-1 font-mono text-xs whitespace-nowrap transition hover:underline"
									onClick={() => {
										copyToClipboard(id);
										toast.success('ID copied to clipboard');
									}}
								>
									{id}
								</button>
							</Tip>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
