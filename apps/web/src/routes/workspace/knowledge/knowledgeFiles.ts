import { toast } from 'sonner';
import { computeFileHash } from '@/lib/utils/hash';

// The pure parts of KnowledgeBase.svelte's upload / sync machinery, separated
// from the component so the path arithmetic and the diff bookkeeping -- where a
// slip silently misfiles or deletes documents -- can be unit-tested. Also the
// toast for a saved file's content, so its choice of message is tested too.

export type DirectoryFileEntry = { path: string; filename: string; file: File };
export type DirectoryManifestEntry = DirectoryFileEntry & { checksum: string; size: number };
export type Breadcrumb = { id: string; name: string };

/**
 * `page` pulled back to the last page a list of `total` items fills at
 * `perPage` a page (page 1 when the list is empty), so a list that shrank
 * under it never leaves an empty page with no pagination shown to leave by.
 */
export const clampPage = (page: number, total: number, perPage: number): number =>
	Math.min(page, Math.max(1, Math.ceil(total / perPage)));

/** Hidden files and folders (any path segment starting with ".") are never uploaded. */
export const hasHiddenFolder = (path: string): boolean => path.split('/').some((part) => part.startsWith('.'));

/**
 * The path a file from a picked directory has *inside the knowledge base*: the
 * directory currently open (its breadcrumb names joined) followed by the file's
 * path relative to what was picked.
 */
export const getDirectoryUploadPath = (breadcrumbs: Breadcrumb[], path: string): string => {
	const current = breadcrumbs.map((crumb) => crumb.name).join('/');
	return current && path ? `${current}/${path}` : current || path;
};

/** Hashes every file (SHA-256) so the server can tell what actually changed. */
export const buildDirectoryManifest = (entries: DirectoryFileEntry[]): Promise<DirectoryManifestEntry[]> =>
	Promise.all(
		entries.map(async (entry) => ({ ...entry, checksum: await computeFileHash(entry.file), size: entry.file.size }))
	);

/** The shape of the server's answer to "what would syncing this manifest change?". */
export type SyncDiff = {
	added: Array<{ filename: string; path: string }>;
	modified: Array<{ filename: string; path: string; stale_file_id: string }>;
	deleted: Array<{ file_id: string }>;
	unmodified_count: number;
	mkdir: string[];
	rmdir: string[];
	directory_map?: Record<string, string>;
};

/** Files the sync must upload: those the server reports as added or modified. */
export const filesToUpload = (manifest: DirectoryManifestEntry[], diff: SyncDiff): DirectoryManifestEntry[] =>
	manifest.filter(
		(entry) =>
			diff.added.some((a) => a.filename === entry.filename && a.path === entry.path) ||
			diff.modified.some((m) => m.filename === entry.filename && m.path === entry.path)
	);

/** Ids to remove before uploading: the files gone from the folder. */
export const deletedFileIds = (diff: SyncDiff): string[] => diff.deleted.map((d) => d.file_id);

/** The old copies of these modified files: their `stale_file_id`s. */
export const replacedFileIds = (
	diff: SyncDiff,
	entries: Pick<DirectoryManifestEntry, 'filename' | 'path'>[]
): string[] =>
	diff.modified
		.filter((m) => entries.some((entry) => entry.filename === m.filename && entry.path === m.path))
		.map((m) => m.stale_file_id);

/** Whether an upload failed because the base already holds its text (the server's DUPLICATE_CONTENT). */
export const isDuplicateContent = (reason: string): boolean => /duplicate content/i.test(reason);

export type UploadOutcome = { ok: true } | { ok: false; reason: string };

/**
 * The upload half of a folder sync, after deleted files and folders are gone:
 *
 * 1. Modified files first, each while its old copy is still in the base, so a
 *    new version that fails to upload leaves the old one in place instead of
 *    the file missing until a later sync (#317).
 * 2. Then the old copies of those that uploaded are removed, with the old
 *    copies of those refused as duplicate content: the base checks a new
 *    version's text against every copy it holds, so a file re-saved with the
 *    same text, or two files that swapped contents, is refused while an old
 *    copy is there. Those are uploaded again once it is gone, as before #317.
 * 3. Added files last, so a copy of a modified file's old text (copy, then
 *    edit) is not refused because of the copy it replaces.
 *
 * If removing the old copies fails, the files refused as duplicates are
 * counted as failed and not retried: they would be refused again.
 */
export async function syncUploads(
	manifest: DirectoryManifestEntry[],
	diff: SyncDiff,
	upload: (entry: DirectoryManifestEntry, attempt: 'first' | 'again') => Promise<UploadOutcome>,
	removeFiles: (fileIds: string[]) => Promise<unknown>
): Promise<{ attempted: number; failed: number; removeError: unknown }> {
	const modified = filesToUpload(manifest, { ...diff, added: [] });
	const added = filesToUpload(manifest, { ...diff, modified: [] });
	let failed = 0;

	const uploaded: DirectoryManifestEntry[] = [];
	const refusedAsDuplicate: DirectoryManifestEntry[] = [];
	for (const entry of modified) {
		const outcome = await upload(entry, 'first');
		if (outcome.ok) uploaded.push(entry);
		else if (isDuplicateContent(outcome.reason)) refusedAsDuplicate.push(entry);
		else failed++;
	}

	let removeError: unknown = null;
	const oldCopies = replacedFileIds(diff, [...uploaded, ...refusedAsDuplicate]);
	if (oldCopies.length > 0) {
		try {
			await removeFiles(oldCopies);
		} catch (error) {
			removeError = error;
		}
	}
	for (const entry of refusedAsDuplicate) {
		if (removeError !== null || !(await upload(entry, 'again')).ok) failed++;
	}

	for (const entry of added) if (!(await upload(entry, 'first')).ok) failed++;

	return { attempted: modified.length + added.length, failed, removeError };
}

/**
 * Creates each directory in `diff.mkdir` (the server lists parents before
 * children), returning path -> directory id for every directory that now exists.
 * A directory whose creation returns nothing is left out, and its children fall
 * back to no parent -- which is what the Svelte version does too.
 */
export async function createMissingDirectories(
	diff: Pick<SyncDiff, 'mkdir' | 'directory_map'>,
	create: (name: string, parentId: string | null) => Promise<{ id: string } | null | undefined>
): Promise<Record<string, string>> {
	const idByPath: Record<string, string> = { ...(diff.directory_map ?? {}) };
	for (const dirPath of diff.mkdir) {
		const segments = dirPath.split('/');
		const name = segments[segments.length - 1];
		const parentPath = segments.slice(0, -1).join('/');
		const parentId = parentPath ? (idByPath[parentPath] ?? null) : null;
		const directory = await create(name, parentId);
		if (directory) idByPath[dirPath] = directory.id;
	}
	return idByPath;
}

/** Drag-and-drop payloads for moving files/directories between folders. */
export const KB_FILE_MOVE = 'application/x-kb-file-move';
export const KB_DIR_MOVE = 'application/x-kb-dir-move';

export type DropPayload = { kind: 'file'; id: string } | { kind: 'dir'; id: string };

/** Reads a move payload off a drop event's dataTransfer; null for anything else (an OS file drop, malformed JSON). */
export function readMovePayload(dt: Pick<DataTransfer, 'getData'> | null | undefined): DropPayload | null {
	if (!dt) return null;
	const fileRaw = dt.getData(KB_FILE_MOVE);
	if (fileRaw) {
		try {
			const data = JSON.parse(fileRaw);
			return typeof data?.fileId === 'string' && data.fileId ? { kind: 'file', id: data.fileId } : null;
		} catch {
			return null;
		}
	}
	const dirRaw = dt.getData(KB_DIR_MOVE);
	if (dirRaw) {
		try {
			const data = JSON.parse(dirRaw);
			return typeof data?.dirId === 'string' && data.dirId ? { kind: 'dir', id: data.dirId } : null;
		} catch {
			return null;
		}
	}
	return null;
}

/** The grey line under a knowledge base's name in the list: file count, source/metadata, description. */
export function knowledgeMetaPreview(item: {
	file_count?: number;
	description?: string;
	meta?: Record<string, any> | null;
}): string {
	const fileCount =
		item.file_count !== undefined ? (item.file_count === 1 ? '1 file' : `${item.file_count} files`) : null;
	if (!item.meta) return [fileCount, item.description].filter(Boolean).join(' · ');
	if (item.meta.source === 'external') {
		return [
			fileCount,
			item.meta.external?.provider,
			item.meta.external?.source?.name,
			item.meta.external?.auth_mode,
			item.description
		]
			.filter(Boolean)
			.join(' · ');
	}
	const metadata = Object.entries(item.meta)
		.filter(([, value]) => value !== null && value !== undefined && value !== '')
		.map(([key, value]) => (['string', 'number', 'boolean'].includes(typeof value) ? `${key}: ${value}` : key))
		.join(' · ');
	return [fileCount, metadata, item.description].filter(Boolean).join(' · ');
}

/**
 * Toasts the outcome of saving a file's content. The save succeeds even when
 * a knowledge base holding the file could not take the new text; those bases
 * still answer from the old one, so name them rather than report plain
 * success (#307).
 */
export function announceContentSaved(
	res: { failed_knowledge?: string[] } | null | undefined,
	notify: Pick<typeof toast, 'success' | 'warning'> = toast
): void {
	const stale = res?.failed_knowledge ?? [];
	if (stale.length)
		notify.warning(`File content saved, but these knowledge bases still use the old text: ${stale.join(', ')}.`);
	else notify.success('File content updated successfully.');
}

type DroppedItem = { webkitGetAsEntry?: () => { isDirectory?: boolean } | null; getAsFile: () => File | null };

/**
 * Every dropped item's directory entry or file, read at once. Once the drop
 * handler awaits, the DataTransfer is protected and every later item reads
 * as null, so a folder dropped with other items lost all that came after it
 * (#231).
 */
export function takeDroppedItems<E extends { isDirectory?: boolean }>(
	items: Iterable<DroppedItem>
): { directories: E[]; files: File[] } {
	const directories: E[] = [];
	const files: File[] = [];
	for (const item of items) {
		const entry = item.webkitGetAsEntry?.();
		if (entry?.isDirectory) directories.push(entry as E);
		else {
			const file = item.getAsFile();
			if (file) files.push(file);
		}
	}
	return { directories, files };
}

/**
 * The dropped files: loose ones, and those inside dropped folders (walked by
 * `collect` after every item is read; see takeDroppedItems). Null when a
 * folder cannot be read, after `onError` has reported it.
 */
export async function gatherDroppedFiles<E extends { isDirectory?: boolean }>(
	items: Iterable<DroppedItem>,
	collect: (entry: E) => Promise<DirectoryFileEntry[]>,
	onError: (error: unknown) => void
): Promise<{ loose: File[]; directoryEntries: DirectoryFileEntry[] } | null> {
	const { directories, files } = takeDroppedItems<E>(items);
	const directoryEntries: DirectoryFileEntry[] = [];
	for (const entry of directories) {
		try {
			directoryEntries.push(...(await collect(entry)));
		} catch (error) {
			onError(error);
			return null;
		}
	}
	return { loose: files, directoryEntries };
}
