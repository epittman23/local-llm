import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, Copy, ExternalLink, MoreHorizontal, Pencil, SlidersHorizontal } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { AccessButton } from '@/components/common/AccessButton';
import { AccessControlModal } from '@/components/common/AccessControlModal';
import { AttachWebpageDialog } from '@/components/common/AttachWebpageDialog';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { FilterMenu, ViewSelector } from '@/components/common/FilterSelects';
import { toastFailure } from '@/components/common/failureToast';
import { Gone, isNotFound } from '@/components/common/Gone';
import { ListSearchBar } from '@/components/common/ListChrome';
import { LoadFailed } from '@/components/common/LoadFailed';
import { PagePagination } from '@/components/common/PagePagination';
import { SafeMarkdown } from '@/components/common/SafeMarkdown';
import { Spinner } from '@/components/common/Spinner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { PageHeader } from '@/components/ui/page-header';
import { SaveBar } from '@/components/ui/save-bar';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { type AccessGrant, DROPPED_GRANTS_WARNING, grantsDropped } from '@/lib/access/accessGrants';
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
import { useCopy } from '@/lib/ui/useCopy';
import { blobToFile } from '@/lib/utils/files';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';
import { routePaths } from '@/routes/routePaths';
import { useSingleUser } from '@/routes/workspace/workspaceAccess';
import { ExternalKnowledgePanel } from './ExternalKnowledgePanel';
import { AddContentMenu, AddTextDialog, EditDetailsDialog, NewDirectoryDialog } from './KnowledgeDialogs';
import {
	KnowledgeBreadcrumbs,
	type KnowledgeDirectory,
	type KnowledgeFile,
	KnowledgeFileList
} from './KnowledgeFileList';
import {
	announceContentSaved,
	type Breadcrumb,
	clampPage,
	type DirectoryFileEntry,
	gatherDroppedFiles
} from './knowledgeFiles';
import {
	collectDirectoryFiles,
	collectDroppedEntryFiles,
	handleDirectoryError,
	useKnowledgeUploads
} from './useKnowledgeUploads';

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

// One menu for the order, over the server's sort key and direction ('' is newest first, its default).
const SORTS = [
	{ value: '', label: 'Recently updated' },
	{ value: 'created_at:', label: 'Recently added' },
	{ value: 'created_at:asc', label: 'Oldest first' },
	{ value: 'name:asc', label: 'Name, A to Z' },
	{ value: 'name:', label: 'Name, Z to A' }
];

const filesLabel = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

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

	// A base that no longer exists says so in place, with the way back (NAV-3).
	if (base.isSuccess && !base.data) return <KnowledgeGone onBack={() => navigate(routePaths.workspaceKnowledge)} />;
	if (base.isError) {
		if (isNotFound(base.error)) return <KnowledgeGone onBack={() => navigate(routePaths.workspaceKnowledge)} />;
		return (
			<LoadFailed
				what="this knowledge base"
				error={base.error}
				onRetry={() => base.refetch()}
				retrying={base.isFetching}
			/>
		);
	}
	if (!id || !base.data) {
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner />
			</div>
		);
	}
	// Keyed by id so moving between bases resets every piece of local state below.
	return (
		<KnowledgeBaseView
			key={id}
			id={id}
			initial={base.data}
			onChanged={() => queryClient.invalidateQueries({ queryKey: ['knowledge-base', id] })}
		/>
	);
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
	// Unfiltered at first, as in the Svelte page: `workspaceViewOption` is the
	// workspace lists' setting, and read here it hid a shared base's files (#230).
	const [viewOption, setViewOption] = useState<string>('');
	const [sortKey, setSortKey] = useState('');
	const [direction, setDirection] = useState('');
	const sortValue = sortKey ? `${sortKey}:${direction}` : '';
	const [includeContent, setIncludeContent] = useState(false);
	const [page, setPage] = useState(1);
	const [directoryId, setDirectoryId] = useState<string | null>(null);
	const [selectedFileId, setSelectedFileId] = useState<string | null>(null);

	const files = useQuery({
		queryKey: [
			'knowledge-files',
			id,
			debouncedQuery,
			viewOption,
			sortKey,
			direction,
			page,
			directoryId,
			includeContent
		],
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
						.map((f: KnowledgeFile & { filename?: string }) => ({
							...f,
							name: f.meta?.name ?? f.filename,
							status: 'uploading'
						}));
					items = [...extra, ...items];
				}
			} catch (e) {
				console.warn('Failed to fetch pending files:', e);
			}
			return {
				items,
				total: res?.total ?? 0,
				directories: res?.directories ?? [],
				breadcrumbs: res?.breadcrumbs ?? [],
				hasPending
			};
		}
	});
	const refresh = useCallback(
		() => queryClient.invalidateQueries({ queryKey: ['knowledge-files', id] }),
		[queryClient, id]
	);
	// KnowledgeBase.svelte's init(): back to page 1, then reload. It follows a
	// delete, reset, upload, sync or saved edit; refresh alone keeps the page.
	const reload = useCallback(() => {
		setPage(1);
		refresh();
	}, [refresh]);
	const listed = files.data;
	// A list that comes back shorter than the page shown (a file moved into a
	// folder, files deleted elsewhere since the last load) moves back to its
	// last page. Only settled data counts: a page's stale cache entry, shown
	// while it refetches, may hold a total that is out of date.
	useEffect(() => {
		if (listed && !files.isPlaceholderData && !files.isFetching) setPage((p) => clampPage(p, listed.total, PER_PAGE));
	}, [listed, files.isPlaceholderData, files.isFetching]);
	const breadcrumbs = listed?.breadcrumbs ?? [];

	const { uploading, syncing, uploadFiles, uploadWeb, retry, dismiss, uploadDirectoryEntries, syncDirectory } =
		useKnowledgeUploads({
			knowledgeId: id,
			directoryId,
			breadcrumbs,
			refresh: reload
		});

	// A file the server lists as pending while this page uploads it is already
	// shown by its upload row, failed ones included: one row per file (#1072).
	const inFlight = new Set(uploading.map((i) => i.serverId).filter(Boolean));
	const shownFiles = (listed?.items ?? []).filter((f) => !f.id || !inFlight.has(f.id));

	// --- name and description: saved from their dialog, never after a pause (FRM-3) ---
	const singleUser = useSingleUser();
	const [showDetails, setShowDetails] = useState(false);
	const saveDetails = async (next: { name: string; description: string }): Promise<boolean> => {
		// Name and description only: the grants are the access dialog's to save,
		// and these could be older than one it saved meanwhile (#522).
		const res = await updateKnowledgeById(token, id, next).catch((e) => {
			toastFailure("Couldn't save the name and description. Try again.", e);
			return null;
		});
		if (!res) return false;
		setKnowledge((k) => ({ ...k, ...next }));
		// A page opened again from the cache must start from what was saved, and
		// so must the list of knowledge bases.
		queryClient.setQueryData<Knowledge | null>(['knowledge-base', id], (old) => old && { ...old, ...next });
		queryClient.invalidateQueries({ queryKey: ['knowledge'] });
		toast.success(`Saved "${next.name}"`);
		return true;
	};

	// --- access -------------------------------------------------------------
	// Shown at once, so a second edit made before the reply builds on the first.
	// Only the latest save's reply is applied: the server replaces the grants
	// wholesale, so it alone says what is stored. That reply has the grants left
	// after the server drops those this user may not set (#522, as #482 for notes).
	const accessSaves = useRef(0);
	const saveAccess = async (grants: AccessGrant[]) => {
		const seq = ++accessSaves.current;
		const previous = knowledge.access_grants ?? [];
		setKnowledge((k) => ({ ...k, access_grants: grants }));
		const res: { access_grants?: unknown } | null | undefined = await updateKnowledgeAccessGrants(
			token,
			id,
			grants
		).catch((e) => void toastFailure("Couldn't save who has access. The previous access is back.", e));
		const latest = accessSaves.current === seq;
		if (!res) {
			if (latest) setKnowledge((k) => ({ ...k, access_grants: previous }));
			return;
		}
		const stored = res.access_grants;
		if (latest && Array.isArray(stored)) setKnowledge((k) => ({ ...k, access_grants: stored as AccessGrant[] }));
		if (grantsDropped(grants, stored)) toast.warning(DROPPED_GRANTS_WARNING);
		else toast.success('Access saved');
		onChanged();
	};

	// --- dialogs ------------------------------------------------------------
	const [showAccess, setShowAccess] = useState(false);
	const [showWeb, setShowWeb] = useState(false);
	const [showText, setShowText] = useState(false);
	const [showNewDir, setShowNewDir] = useState(false);
	const [showReset, setShowReset] = useState(false);
	const [pendingSync, setPendingSync] = useState<DirectoryFileEntry[] | null>(null);
	const [deletingDir, setDeletingDir] = useState<string | null>(null);
	// Off at first: deleting a folder's files deletes their extracted text and embeddings too (#1012).
	// The owner kept deleting a folder's files with it by default (2026-11-15); unticking keeps them.
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
				toast.error('You can read this knowledge base but not add to it. Ask its owner for write access.');
				return;
			}
			const items = Array.from(e.dataTransfer.items ?? []);
			if (items.length === 0) {
				toast.error('No file was chosen.');
				return;
			}
			const dropped = await gatherDroppedFiles(items, collectDroppedEntryFiles, handleDirectoryError);
			if (!dropped) return;
			const { loose, directoryEntries } = dropped;
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
	const report = async <T,>(work: Promise<T>, success: string, failure: string): Promise<boolean> => {
		try {
			const res = await work;
			if (res) {
				toast.success(success);
				refresh();
				return true;
			}
		} catch (e) {
			toastFailure(failure, e);
		}
		return false;
	};
	const deletingDirName = listed?.directories.find((d) => d.id === deletingDir)?.name ?? '';
	const navigateToDirectory = (dirId: string | null) => {
		setDirectoryId(dirId);
		setPage(1);
		setSelectedFileId(null);
	};
	const move = (payload: { kind: 'file' | 'dir'; id: string }, target: string | null) => {
		if (payload.kind === 'file')
			report(moveFileInKnowledge(token, id, payload.id, target), 'File moved', "Couldn't move the file.");
		else if (payload.id !== target)
			report(
				updateKnowledgeDirectory(token, id, payload.id, { parent_id: target }),
				'Folder moved',
				"Couldn't move the folder."
			);
	};
	// Removing deletes the file's extracted text and embeddings at once, so it confirms first (ACT-3, #906).
	const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
	const deleteFile = async ({ id: fileId, name }: { id: string; name: string }) => {
		setSelectedFileId(null);
		try {
			if (await removeFileFromKnowledgeById(token, id, fileId)) {
				toast.success(`Removed "${name}"`);
				reload();
			}
		} catch (e) {
			toastFailure(`Couldn't remove "${name}".`, e);
		}
	};

	// --- the file preview sheet ----------------------------------------------
	const selectedFile = listed?.items.find((f) => f.id === selectedFileId) ?? null;
	const [content, setContent] = useState('');
	const [original, setOriginal] = useState('');
	// The sheet opens on the rendered text; editing is a deliberate switch (CNT-1, #1096).
	const [editingText, setEditingText] = useState(false);
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
		setEditingText(false);
		if (inline !== undefined) {
			setContent(inline);
			setOriginal(inline);
			setLoadingContent(false);
			return;
		}
		let cancelled = false;
		setContent('');
		setLoadingContent(true);
		getFileById(token, selectedFileId)
			.then((full) => {
				if (cancelled) return;
				setContent(full?.data?.content ?? '');
				setOriginal(full?.data?.content ?? '');
			})
			.catch((e) => !cancelled && toastFailure("Couldn't load the file's text. Close it and open it again.", e))
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
				toastFailure("Couldn't save the text. Try again.", e);
				return null;
			});
			if (res) {
				announceContentSaved(res);
				setSelectedFileId(null);
				reload();
			}
		} finally {
			setSaving(false);
		}
	};

	if (external) {
		return (
			<div className="flex h-full min-h-full w-full flex-col">
				<Header
					knowledge={knowledge}
					onEditDetails={() => setShowDetails(true)}
					showAccess={!singleUser}
					writeAccess={writeAccess}
					total={null}
					onBack={() => navigate(routePaths.workspaceKnowledge)}
					onAccess={() => setShowAccess(true)}
					id={id}
				/>
				{detailsDialog()}
				<div className="bg-background mt-1.5 mb-2 flex-1 rounded-3xl border py-1.5">
					<ExternalKnowledgePanel external={(knowledge.meta?.external ?? {}) as never} />
				</div>
				{accessModal()}
			</div>
		);
	}

	function detailsDialog() {
		return (
			<EditDetailsDialog
				open={showDetails}
				onOpenChange={setShowDetails}
				name={knowledge.name}
				description={knowledge.description}
				onSave={saveDetails}
			/>
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
				onChange={saveAccess}
			/>
		);
	}

	return (
		<div id="collection-container" className="flex h-full min-h-full w-full flex-col">
			{dragged && (
				<div className="bg-background/80 fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm">
					<div className="text-center">
						<div className="text-title font-title">Add files</div>
						<div className="text-foreground-muted">Drop them anywhere on the page</div>
					</div>
				</div>
			)}

			{accessModal()}
			{detailsDialog()}

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
				{pendingSync?.length ?? 0} files selected. Only new and modified files will be uploaded. Deleted files will be
				removed. The folder structure will be mirrored. Continue?
			</ConfirmDialog>
			<ConfirmDialog
				open={removing !== null}
				onOpenChange={(open) => !open && setRemoving(null)}
				title={`Remove "${removing?.name ?? ''}"?`}
				confirmLabel="Remove file"
				destructive
				onConfirm={() => {
					const file = removing;
					setRemoving(null);
					if (file) deleteFile(file);
				}}
			>
				Its extracted text and embeddings are deleted. Adding it again processes it from the start.
			</ConfirmDialog>
			<ConfirmDialog
				open={deletingDir !== null}
				onOpenChange={(open) => !open && setDeletingDir(null)}
				title={`Delete the folder "${deletingDirName}"?`}
				confirmLabel="Delete folder"
				destructive
				onConfirm={async () => {
					const dirId = deletingDir;
					setDeletingDir(null);
					if (!dirId) return;
					try {
						if (await deleteKnowledgeDirectory(token, id, dirId, !deleteContents)) {
							toast.success(`Deleted the folder "${deletingDirName}"`);
							refresh();
						}
					} catch (e) {
						toastFailure(`Couldn't delete the folder "${deletingDirName}".`, e);
					}
				}}
			>
				<p>
					{deleteContents
						? 'The folder, its subfolders and every file in them are deleted, with their extracted text and embeddings.'
						: 'The folder and its subfolders are deleted. The files in them move up to the folder above.'}
				</p>
				<label className="mt-3 flex items-start gap-2">
					<Checkbox
						className="mt-0.5"
						checked={deleteContents}
						onCheckedChange={(c) => setDeleteContents(c === true)}
					/>
					<span>Also delete the files inside</span>
				</label>
			</ConfirmDialog>
			<ConfirmDialog
				open={showReset}
				onOpenChange={setShowReset}
				title={`Reset "${knowledge.name}"?`}
				confirmLabel="Reset knowledge base"
				destructive
				onConfirm={async () => {
					setShowReset(false);
					try {
						await resetKnowledgeById(token, id);
						toast.success(`Reset "${knowledge.name}"`);
						reload();
					} catch (e) {
						toastFailure(`Couldn't reset "${knowledge.name}".`, e);
					}
				}}
			>
				Every file and folder is removed from it, with their extracted text and embeddings. This can't be undone.
			</ConfirmDialog>

			<AttachWebpageDialog
				open={showWeb}
				onOpenChange={setShowWeb}
				onSubmit={uploadWeb}
				title="Add a web page"
				submitLabel="Add web page"
			/>
			<AddTextDialog
				open={showText}
				onOpenChange={setShowText}
				onSubmit={(name, text) => uploadFiles([blobToFile(new Blob([text], { type: 'text/plain' }), `${name}.txt`)])}
			/>
			<NewDirectoryDialog
				open={showNewDir}
				onOpenChange={setShowNewDir}
				onSubmit={(name) =>
					report(
						createKnowledgeDirectory(token, id, name, directoryId),
						`Created the folder "${name}"`,
						`Couldn't create the folder "${name}".`
					)
				}
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
						toast.error('No file was chosen.');
						return;
					}
					await uploadFiles(chosen);
					e.target.value = '';
				}}
			/>

			<Header
				knowledge={knowledge}
				onEditDetails={() => setShowDetails(true)}
				showAccess={!singleUser}
				writeAccess={writeAccess}
				total={listed?.total ?? null}
				onBack={() => navigate(routePaths.workspaceKnowledge)}
				onAccess={() => setShowAccess(true)}
				id={id}
			/>

			<div className="mt-4 flex flex-1 flex-col gap-2">
				<ListSearchBar
					value={query}
					onChange={(value) => {
						setQuery(value);
						setPage(1);
					}}
					placeholder="Search files"
				>
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
								Search file contents too
							</DropdownMenuCheckboxItem>
						</DropdownMenuContent>
					</DropdownMenu>
					{!singleUser && (
						<ViewSelector
							value={viewOption}
							onChange={(value) => {
								if (value) localStorage.workspaceViewOption = value;
								else delete localStorage.workspaceViewOption;
								setViewOption(value);
								setPage(1);
							}}
						/>
					)}
					<FilterMenu
						value={sortValue}
						items={SORTS}
						onChange={(value) => {
							const [key, dir = ''] = value.split(':');
							setSortKey(key);
							setDirection(dir);
							setPage(1);
						}}
						trigger={
							<Button variant="ghost" size="sm">
								<span className="sr-only">Sort: </span>
								<span className="truncate">{SORTS.find((o) => o.value === sortValue)?.label}</span>
								<ChevronDown />
							</Button>
						}
					/>
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
				</ListSearchBar>

				{directoryId !== null && (
					<div className="mb-1 px-4">
						<KnowledgeBreadcrumbs
							rootLabel={knowledge.name}
							breadcrumbs={breadcrumbs}
							onNavigate={navigateToDirectory}
							onMove={move}
						/>
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
								<div className="flex h-full w-full overflow-y-auto">
									<KnowledgeFileList
										files={shownFiles}
										uploading={uploading}
										directories={listed.directories}
										writeAccess={writeAccess}
										selectedFileId={selectedFileId}
										onSelect={setSelectedFileId}
										onDeleteFile={(fileId) =>
											setRemoving({
												id: fileId,
												name: listed.items.find((f) => f.id === fileId)?.meta?.name ?? 'this file'
											})
										}
										onRenameFile={(fileId, name) =>
											report(renameFileById(token, fileId, name), `Renamed to "${name}"`, "Couldn't rename the file.")
										}
										onOpenDirectory={navigateToDirectory}
										onRenameDirectory={(dirId, name) =>
											report(
												updateKnowledgeDirectory(token, id, dirId, { name }),
												`Renamed to "${name}"`,
												"Couldn't rename the folder."
											)
										}
										onDeleteDirectory={(dirId) => {
											setDeleteContents(true);
											setDeletingDir(dirId);
										}}
										onMove={move}
										showOwner={!singleUser}
										onRetryUpload={retry}
										onDismissUpload={dismiss}
									/>
								</div>
							) : (
								<div className="text-foreground-muted my-6 flex flex-col items-center gap-3 text-center">
									{debouncedQuery ? (
										<>
											<p>Nothing matches "{debouncedQuery}".</p>
											<Button
												variant="outline"
												onClick={() => {
													setQuery('');
													setPage(1);
												}}
											>
												Clear search
											</Button>
										</>
									) : (
										<>
											<p>No files yet. Files added here are searched when a chat uses this knowledge base.</p>
											{writeAccess && <Button onClick={() => fileInput.current?.click()}>Upload files</Button>}
										</>
									)}
								</div>
							)}
							{listed.total > PER_PAGE && (
								<PagePagination page={page} count={listed.total} perPage={PER_PAGE} onPageChange={setPage} />
							)}
						</div>
					</div>
				)}
			</div>

			<Sheet open={selectedFileId !== null} onOpenChange={(open) => !open && setSelectedFileId(null)}>
				<SheetContent side="right" className="w-full sm:max-w-xl">
					<div className="flex h-full max-h-full flex-col gap-3 p-4">
						<div className="flex shrink-0 items-start gap-2 pe-8">
							<div className="min-w-0 flex-1">
								<SheetTitle className="text-title font-title truncate">{previewName}</SheetTitle>
								<SheetDescription>The text extracted from this file, which chats search.</SheetDescription>
							</div>
						</div>
						<div className="flex shrink-0 flex-wrap items-center gap-2">
							<Button
								variant="outline"
								size="sm"
								onClick={() => {
									if (selectedFile?.id)
										window.open(`${WEBUI_API_BASE_URL}/files/${encodeURIComponent(selectedFile.id)}/content`, '_blank');
								}}
							>
								<ExternalLink aria-hidden />
								Open original
							</Button>
							{writeAccess && !editingText && (
								<Button variant="outline" size="sm" disabled={loadingContent} onClick={() => setEditingText(true)}>
									<Pencil aria-hidden />
									Edit text
								</Button>
							)}
						</div>
						{loadingContent ? (
							<div className="flex flex-1 items-center justify-center">
								<Spinner />
							</div>
						) : editingText ? (
							<>
								<Textarea
									key={selectedFileId}
									className="min-h-0 flex-1 resize-none field-sizing-fixed"
									value={content}
									onChange={(e) => setContent(e.target.value)}
									aria-label="File text"
								/>
								<SaveBar
									dirty={content !== original}
									saving={saving}
									saveLabel="Save text"
									onSave={saveContent}
									onDiscard={() => {
										setContent(original);
										setEditingText(false);
									}}
								/>
							</>
						) : content.trim() ? (
							<div className="min-h-0 flex-1 overflow-y-auto">
								<SafeMarkdown text={content} className="rich-text text-sm" />
							</div>
						) : (
							<p className="text-foreground-muted">No text was extracted from this file.</p>
						)}
					</div>
				</SheetContent>
			</Sheet>
		</div>
	);
}

/** A knowledge base that no longer exists, said in place (NAV-3, #1095). */
function KnowledgeGone({ onBack }: { onBack: () => void }) {
	return (
		<Gone
			level={2}
			title="Knowledge base not found"
			description="It may have been deleted, or the link is wrong."
			actions={<Button onClick={onBack}>Back to Knowledge</Button>}
		/>
	);
}

/**
 * The page's own header (#1017): the name as its heading, the description and
 * file count under it, Access, and a menu with Edit name and description and
 * Copy ID. The id is not shown: it is a detail only some need (DAT-4).
 */
function Header({
	knowledge,
	onEditDetails,
	showAccess,
	writeAccess,
	total,
	onBack,
	onAccess,
	id
}: {
	knowledge: Knowledge;
	onEditDetails: () => void;
	showAccess: boolean;
	writeAccess: boolean;
	total: number | null;
	onBack: () => void;
	onAccess: () => void;
	id: string;
}) {
	const { copied, copy } = useCopy();
	const description = [knowledge.description, total === null ? '' : filesLabel(total)].filter(Boolean).join(' · ');
	return (
		<div className="w-full">
			<Button variant="ghost" size="sm" className="mb-2 -ms-2 w-fit" type="button" onClick={onBack}>
				<ChevronLeft aria-hidden />
				<span>Back</span>
			</Button>
			<PageHeader
				as="h2"
				title={knowledge.name}
				description={description}
				action={
					<div className="ms-auto flex items-center gap-2">
						{!writeAccess && <Badge variant="secondary">Read only</Badge>}
						{writeAccess && showAccess && <AccessButton onClick={onAccess} />}
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="ghost" size="icon-sm" type="button" aria-label="More actions">
									<MoreHorizontal />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-max min-w-48">
								{writeAccess && (
									<DropdownMenuItem onSelect={onEditDetails}>
										<Pencil />
										Edit name and description
									</DropdownMenuItem>
								)}
								<DropdownMenuItem
									onSelect={() => {
										copy(id, 'ID').then((ok) => ok && toast.success('ID copied'));
									}}
								>
									<Copy />
									{copied ? 'Copied' : 'Copy ID'}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				}
			/>
		</div>
	);
}
