import { useState } from 'react';
import { toast } from 'sonner';
import {
	addFileToKnowledgeById,
	createKnowledgeDirectory,
	syncKnowledgeCleanup,
	syncKnowledgeDiff
} from '@/lib/apis/knowledge';
import { uploadFile } from '@/lib/apis/files';
import { processUrl } from '@/lib/apis/retrieval';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { blobToFile } from '@/lib/utils/files';
import {
	type Breadcrumb,
	type DirectoryFileEntry,
	type DirectoryManifestEntry,
	type SyncDiff,
	buildDirectoryManifest,
	createMissingDirectories,
	filesToUpload,
	getDirectoryUploadPath,
	hasHiddenFolder,
	staleFileIds
} from './knowledgeFiles';

export type UploadingItem = { itemId: string; name: string; size: number | null };

let itemCounter = 0;
const nextItemId = () => `upload-${Date.now()}-${itemCounter++}`;

/** The message worth showing for whatever a failed upload rejected with. */
const failureReason = (error: unknown): string => {
	if (typeof error === 'string') return error;
	const e = error as { detail?: unknown; message?: unknown } | null;
	return String(e?.detail ?? e?.message ?? 'Failed to upload file.');
};

/**
 * Everything KnowledgeBase.svelte does to get content *into* a knowledge base:
 * single files, webpages, whole directories (picked or dropped), and the
 * incremental "sync directory" (hash locally -> ask the server what changed ->
 * remove stale files -> make missing folders -> upload only what's new or
 * modified). `uploading` is the list of in-flight single uploads, shown above
 * the server's own list; `syncing` is the status line for directory work.
 *
 * `refresh` reloads the file list; it is called after each successful upload.
 */
export function useKnowledgeUploads({
	knowledgeId,
	directoryId,
	breadcrumbs,
	refresh
}: {
	knowledgeId: string | null;
	directoryId: string | null;
	breadcrumbs: Breadcrumb[];
	refresh: () => void;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const maxSizeMb = useConfigStore((s) => s.config?.file?.max_size ?? null);
	const [uploading, setUploading] = useState<UploadingItem[]>([]);
	const [syncing, setSyncing] = useState<string | null>(null);

	const track = (item: UploadingItem) => setUploading((prev) => [item, ...prev]);
	const untrack = (itemId: string) => setUploading((prev) => prev.filter((i) => i.itemId !== itemId));

	/** Reports what an upload came back with; true when the file was accepted. */
	const settle = (uploaded: { error?: string } | null): boolean => {
		if (!uploaded) {
			toast.error('Failed to upload file.');
			return false;
		}
		if (uploaded.error) {
			console.warn('File upload warning:', uploaded.error);
			toast.warning(uploaded.error);
			return false;
		}
		toast.success('File added successfully.');
		refresh();
		return true;
	};

	const uploadSingleFile = async (file: File) => {
		if (!knowledgeId) return;
		if (file.size === 0) {
			toast.error('You cannot upload an empty file.');
			return;
		}
		if (maxSizeMb !== null && file.size > maxSizeMb * 1024 * 1024) {
			toast.error(`File size should not exceed ${maxSizeMb} MB.`);
			return;
		}
		const item = { itemId: nextItemId(), name: file.name, size: file.size };
		track(item);
		try {
			// (The Svelte version also sends the user's speech-to-text language for
			// audio/video files; there is no settings store here yet.)
			const uploaded = await uploadFile(token, file, { knowledge_id: knowledgeId, directory_id: directoryId }).catch((e) => {
				toast.error(`${e}`);
				return null;
			});
			settle(uploaded);
		} catch (e) {
			toast.error(`${e}`);
		} finally {
			untrack(item.itemId);
		}
	};

	const uploadFiles = async (files: File[]) => {
		for (const file of files) await uploadSingleFile(file);
	};

	const uploadWeb = async (urls: string[]) => {
		if (!knowledgeId) {
			toast.error('Knowledge base not found.');
			return;
		}
		for (const url of urls) {
			const item = { itemId: nextItemId(), name: url, size: null };
			track(item);
			try {
				const res = await processUrl(token, url).catch((e) => {
					console.error('Error processing URL:', e);
					return null;
				});
				if (!res) {
					toast.error(`Failed to process URL: ${url}`);
					continue;
				}
				let uploaded = res.file;
				if (res.type === 'web' || res.type === 'youtube') {
					const name = url.replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 50);
					const file = blobToFile(new Blob([res.content ?? ''], { type: 'text/plain' }), `${name}.txt`);
					uploaded = await uploadFile(token, file, { knowledge_id: knowledgeId, directory_id: directoryId, source_url: url }).catch((e) => {
						toast.error(`${e}`);
						return null;
					});
				} else if (uploaded?.id) {
					const linked = await addFileToKnowledgeById(token, knowledgeId, uploaded.id, directoryId).catch((e) => {
						toast.error(`${e}`);
						return null;
					});
					if (!linked) uploaded = null;
				}
				settle(uploaded);
			} catch (e) {
				toast.error(`${e}`);
			} finally {
				untrack(item.itemId);
			}
		}
	};

	/** Uploads each manifest entry in turn, reporting progress; returns how many failed. */
	const uploadManifestEntries = async (
		entries: DirectoryManifestEntry[],
		resolveDirectoryId: (entry: DirectoryManifestEntry) => string | null | undefined
	) => {
		let failed = 0;
		for (const [index, entry] of entries.entries()) {
			const displayPath = entry.path ? `${entry.path}/${entry.filename}` : entry.filename;
			setSyncing(`Uploading ${index + 1}/${entries.length}: ${displayPath}`);
			const file = new File([entry.file], entry.filename, { type: entry.file.type });
			const uploaded = await uploadFile(token, file, {
				knowledge_id: knowledgeId,
				file_hash: entry.checksum,
				directory_id: resolveDirectoryId(entry)
			}).catch((error) => ({ error }));
			if (!uploaded || (uploaded as { error?: unknown }).error) {
				failed++;
				console.error('Upload failed:', displayPath, failureReason((uploaded as { error?: unknown } | null)?.error));
			}
		}
		if (failed > 0) toast.error(`Upload failed for ${failed} of ${entries.length} files.`);
		return failed;
	};

	const mkdirVia = (name: string, parentId: string | null) => createKnowledgeDirectory(token, knowledgeId as string, name, parentId);

	/** Upload a picked/dropped directory: hash it, diff against the base, create folders, upload everything. */
	const uploadDirectoryEntries = async (entries: DirectoryFileEntry[]) => {
		if (!knowledgeId) return;
		try {
			setSyncing(`Computing checksums (${entries.length} files)`);
			const manifest = await buildDirectoryManifest(entries);
			setSyncing('Comparing with knowledge base...');
			const diff = (await syncKnowledgeDiff(
				token,
				knowledgeId,
				manifest.map(({ filename, path, checksum, size }) => ({ filename, path: getDirectoryUploadPath(breadcrumbs, path), checksum, size }))
			)) as SyncDiff | null;
			if (!diff) {
				toast.error('Failed to compare files.');
				return;
			}
			const idByPath = await createMissingDirectories(diff, mkdirVia);
			const failed = await uploadManifestEntries(manifest, (entry) =>
				entry.path ? idByPath[getDirectoryUploadPath(breadcrumbs, entry.path)] : directoryId
			);
			if (failed === 0) toast.success('File uploaded successfully');
			refresh();
		} catch (e) {
			toast.error(`${e}`);
		} finally {
			setSyncing(null);
		}
	};

	/** Incremental sync: mirrors the picked folder -- new and changed files go up, vanished ones are removed. */
	const syncDirectory = async (entries: DirectoryFileEntry[]) => {
		if (!knowledgeId || entries.length === 0) return;
		try {
			setSyncing(`Computing checksums (${entries.length} files)`);
			const manifest = await buildDirectoryManifest(entries);
			setSyncing('Comparing with knowledge base...');
			const diff = (await syncKnowledgeDiff(
				token,
				knowledgeId,
				manifest.map(({ filename, path, checksum, size }) => ({ filename, path, checksum, size }))
			)) as SyncDiff | null;
			if (!diff) {
				toast.error('Failed to compare files.');
				return;
			}
			const stale = staleFileIds(diff);
			if (stale.length > 0 || diff.rmdir.length > 0) {
				setSyncing(`Removing ${stale.length} stale files...`);
				await syncKnowledgeCleanup(token, knowledgeId, stale, diff.rmdir);
			}
			const idByPath = await createMissingDirectories(diff, mkdirVia);
			const failed = await uploadManifestEntries(filesToUpload(manifest, diff), (entry) => (entry.path ? idByPath[entry.path] : null));
			if (failed === 0) {
				toast.success(
					`Sync complete: ${diff.added.length} added, ${diff.modified.length} modified, ${diff.deleted.length} deleted, ${diff.unmodified_count} unmodified`
				);
			}
			refresh();
		} catch (e) {
			toast.error(`${e}`);
		} finally {
			setSyncing(null);
		}
	};

	return { uploading, syncing, uploadFiles, uploadWeb, uploadDirectoryEntries, syncDirectory };
}

// --- getting directory contents from the browser ---------------------------

const handleDirectoryError = (error: unknown) => {
	if ((error as { name?: string })?.name === 'AbortError') toast.info('Directory selection was cancelled');
	else {
		toast.error('Error accessing directory');
		console.error('Directory access error:', error);
	}
};

/**
 * Opens a directory picker and returns every non-hidden file beneath it, with
 * its path relative to the picked folder's parent. Uses the File System Access
 * API where there is one and an `<input webkitdirectory>` otherwise (Firefox).
 * Null on cancel or error (already reported to the user).
 */
export async function collectDirectoryFiles(): Promise<DirectoryFileEntry[] | null> {
	try {
		if ('showDirectoryPicker' in window) {
			const dirHandle = await (window as any).showDirectoryPicker();
			const collected: DirectoryFileEntry[] = [];
			const traverse = async (handle: any, dirPath = '') => {
				for await (const entry of handle.values()) {
					if (entry.name.startsWith('.')) continue;
					const entryPath = dirPath ? `${dirPath}/${entry.name}` : entry.name;
					if (hasHiddenFolder(entryPath)) continue;
					if (entry.kind === 'file') collected.push({ path: dirPath, filename: entry.name, file: await entry.getFile() });
					else if (entry.kind === 'directory') await traverse(entry, entryPath);
				}
			};
			await traverse(dirHandle, dirHandle.name);
			return collected;
		}
		return await new Promise<DirectoryFileEntry[]>((resolve, reject) => {
			const input = document.createElement('input');
			input.type = 'file';
			(input as any).webkitdirectory = true;
			input.multiple = true;
			input.style.display = 'none';
			document.body.appendChild(input);
			input.onchange = () => {
				try {
					const files = Array.from(input.files ?? []).filter((f) => !hasHiddenFolder(f.webkitRelativePath) && !f.name.startsWith('.'));
					resolve(
						files.map((file) => {
							const parts = file.webkitRelativePath.split('/');
							const filename = parts.pop() || file.name;
							return { path: parts.join('/'), filename, file };
						})
					);
				} catch (error) {
					reject(error);
				} finally {
					document.body.removeChild(input);
				}
			};
			input.click();
		});
	} catch (error) {
		handleDirectoryError(error);
		return null;
	}
}

const readAllEntries = async (reader: any): Promise<any[]> => {
	const all: any[] = [];
	for (;;) {
		const batch = await new Promise<any[]>((resolve, reject) => reader.readEntries(resolve, reject));
		if (batch.length === 0) return all;
		all.push(...batch);
	}
};

/** Flattens a dropped directory (a `FileSystemEntry`) into its non-hidden files. */
export async function collectDroppedEntryFiles(entry: any, entryPath: string = entry.name): Promise<DirectoryFileEntry[]> {
	if (entry.name.startsWith('.') || hasHiddenFolder(entryPath)) return [];
	if (entry.isFile) {
		const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
		const parts = entryPath.split('/');
		const filename = parts.pop() || file.name;
		return [{ path: parts.join('/'), filename, file }];
	}
	if (entry.isDirectory) {
		const children = await readAllEntries(entry.createReader());
		return (await Promise.all(children.map((child) => collectDroppedEntryFiles(child, `${entryPath}/${child.name}`)))).flat();
	}
	return [];
}

export { handleDirectoryError };
