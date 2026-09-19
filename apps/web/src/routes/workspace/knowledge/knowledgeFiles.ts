import { computeFileHash } from '@/lib/utils/hash';

// The pure parts of KnowledgeBase.svelte's upload / sync machinery, separated
// from the component so the path arithmetic and the diff bookkeeping -- where a
// slip silently misfiles or deletes documents -- can be unit-tested.

export type DirectoryFileEntry = { path: string; filename: string; file: File };
export type DirectoryManifestEntry = DirectoryFileEntry & { checksum: string; size: number };
export type Breadcrumb = { id: string; name: string };

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
	Promise.all(entries.map(async (entry) => ({ ...entry, checksum: await computeFileHash(entry.file), size: entry.file.size })));

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

/** Ids to remove before uploading: deleted files plus the stale copies of modified ones. */
export const staleFileIds = (diff: SyncDiff): string[] => [
	...diff.deleted.map((d) => d.file_id),
	...diff.modified.map((m) => m.stale_file_id)
];

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
	const fileCount = item.file_count !== undefined ? (item.file_count === 1 ? '1 file' : `${item.file_count} files`) : null;
	if (!item.meta) return [fileCount, item.description].filter(Boolean).join(' · ');
	if (item.meta.source === 'external') {
		return [fileCount, item.meta.external?.provider, item.meta.external?.source?.name, item.meta.external?.auth_mode, item.description]
			.filter(Boolean)
			.join(' · ');
	}
	const metadata = Object.entries(item.meta)
		.filter(([, value]) => value !== null && value !== undefined && value !== '')
		.map(([key, value]) => (['string', 'number', 'boolean'].includes(typeof value) ? `${key}: ${value}` : key))
		.join(' · ');
	return [fileCount, metadata, item.description].filter(Boolean).join(' · ');
}
