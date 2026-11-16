import { useState } from 'react';
import { toast } from 'sonner';
import { errorText, toastFailure as notifyFailure } from '@/components/common/failureToast';
import { uploadFile } from '@/lib/apis/files';
import {
	addFileToKnowledgeById,
	createKnowledgeDirectory,
	syncKnowledgeCleanup,
	syncKnowledgeDiff
} from '@/lib/apis/knowledge';
import { processUrl } from '@/lib/apis/retrieval';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { blobToFile } from '@/lib/utils/files';
import {
	type Breadcrumb,
	buildDirectoryManifest,
	createMissingDirectories,
	type DirectoryFileEntry,
	type DirectoryManifestEntry,
	deletedFileIds,
	filesToUpload,
	getDirectoryUploadPath,
	hasHiddenFolder,
	type SyncDiff,
	syncUploads,
	type UploadOutcome
} from './knowledgeFiles';

/**
 * A single upload shown above the file list. It keeps its `File` (or URL) so a
 * failed one can be tried again in place, and the server's id once the POST
 * has answered, so the same file listed as pending is not shown twice (#1072).
 */
export type UploadingItem = {
	itemId: string;
	name: string;
	size: number | null;
	status: 'uploading' | 'processing' | 'failed';
	serverId?: string;
	/** Why it failed, in words for the person using the app (FBK-4). */
	reason?: string;
	/** The server's own words, shown behind "Details". */
	detail?: string | null;
	/** The content is already in the base: trying again would fail the same way. */
	duplicate?: boolean;
	file?: File;
	url?: string;
};

type Outcome = 'added' | 'failed' | 'skipped';

let itemCounter = 0;
const nextItemId = () => `upload-${Date.now()}-${itemCounter++}`;

const displayPath = (entry: DirectoryManifestEntry) =>
	entry.path ? `${entry.path}/${entry.filename}` : entry.filename;

/** The message worth showing for whatever a failed upload rejected with. */
const failureReason = (error: unknown): string => {
	if (typeof error === 'string') return error;
	const e = error as { detail?: unknown; message?: unknown } | null;
	return String(e?.detail ?? e?.message ?? 'Failed to upload file.');
};

const isDuplicate = (text: string | null) => Boolean(text && /duplicate content/i.test(text));

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * One toast for one action's uploads, however many files it held (FBK-2):
 * "Added "notes.md"", "4 files added", "3 added, 1 failed".
 */
export function announceUploads(names: string[], outcomes: Outcome[]) {
	const added = outcomes.filter((o) => o === 'added').length;
	const failedCount = outcomes.filter((o) => o === 'failed').length;
	const skipped = outcomes.filter((o) => o === 'skipped').length;
	if (outcomes.length === 0) return;
	if (outcomes.length === 1) {
		const name = names[0];
		if (added) toast.success(`Added "${name}"`);
		else if (skipped) toast.info(`"${name}" is already in this knowledge base, so it was skipped`);
		else toast.error(`Couldn't add "${name}"`, { description: 'The list shows why, with Retry.' });
		return;
	}
	const parts = [
		added ? `${added} added` : '',
		failedCount ? `${failedCount} failed` : '',
		skipped ? `${skipped} already here` : ''
	].filter(Boolean);
	const summary =
		added === outcomes.length
			? `${plural(added, 'file')} added`
			: failedCount === outcomes.length
				? `${plural(failedCount, 'file')} couldn't be added`
				: parts.join(', ');
	if (failedCount) toast.error(summary, { description: 'The list shows why each one failed, with Retry.' });
	else toast.success(summary);
}

/**
 * Everything KnowledgeBase.svelte does to get content *into* a knowledge base:
 * single files, webpages, whole directories (picked or dropped), and the
 * incremental "sync directory" (hash locally -> ask the server what changed ->
 * remove deleted files -> make missing folders -> upload what's new or
 * modified, in the order `syncUploads` gives). `uploading` is the list of
 * single uploads in flight or failed, shown above the server's own list; a
 * failed one stays, with its reason, until it is retried or dismissed, for
 * this visit only (STA-4, S4-D7=A). `syncing` is the status line for
 * directory work.
 *
 * `refresh` reloads the file list (from page 1, as the Svelte page's init()
 * did); it is called after each successful upload and sync.
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

	/** Adds a row, or puts a retried row back to uploading in place. */
	const track = (item: UploadingItem) =>
		setUploading((prev) =>
			prev.some((i) => i.itemId === item.itemId)
				? prev.map((i) => (i.itemId === item.itemId ? item : i))
				: [item, ...prev]
		);
	const patch = (itemId: string, change: Partial<UploadingItem>) =>
		setUploading((prev) => prev.map((i) => (i.itemId === itemId ? { ...i, ...change } : i)));
	const untrack = (itemId: string) => setUploading((prev) => prev.filter((i) => i.itemId !== itemId));
	const fail = (itemId: string, reason: string, detail: string | null, duplicate = false): Outcome => {
		patch(itemId, { status: 'failed', reason, detail, duplicate });
		return duplicate ? 'skipped' : 'failed';
	};

	/** What an upload came back with: added, or the row marked failed with why. */
	const settle = (itemId: string, uploaded: { error?: string } | null, rejected: unknown): Outcome => {
		if (rejected !== undefined) return fail(itemId, 'The server refused the upload.', errorText(rejected));
		if (!uploaded) return fail(itemId, "The server didn't answer. Try again.", null);
		if (uploaded.error) {
			const detail = errorText(uploaded.error);
			if (isDuplicate(detail)) return fail(itemId, 'Already in this knowledge base, so it was skipped.', null, true);
			return fail(itemId, "It was uploaded but couldn't be processed into searchable text.", detail);
		}
		untrack(itemId);
		refresh();
		return 'added';
	};

	const uploadSingleFile = async (file: File, itemId = nextItemId()): Promise<Outcome | null> => {
		if (!knowledgeId) return null;
		if (file.size === 0) {
			toast.error(`"${file.name}" is empty, so it wasn't uploaded.`);
			return null;
		}
		// 0 or unset is no limit, as on the server (#238).
		if (maxSizeMb && file.size > maxSizeMb * 1024 * 1024) {
			toast.error(`"${file.name}" is larger than the ${maxSizeMb} MB limit, so it wasn't uploaded.`);
			return null;
		}
		track({ itemId, name: file.name, size: file.size, status: 'uploading', file });
		let rejected: unknown;
		// (The Svelte version also sends the user's speech-to-text language for
		// audio/video files; there is no settings store here yet.)
		const uploaded = await uploadFile(
			token,
			file,
			{ knowledge_id: knowledgeId, directory_id: directoryId },
			undefined,
			true,
			(serverId) => patch(itemId, { serverId, status: 'processing' })
		).catch((e) => {
			rejected = e ?? 'Upload failed';
			return null;
		});
		return settle(itemId, uploaded, rejected);
	};

	const uploadFiles = async (files: File[]) => {
		const names: string[] = [];
		const outcomes: Outcome[] = [];
		for (const file of files) {
			const outcome = await uploadSingleFile(file);
			if (outcome) {
				names.push(file.name);
				outcomes.push(outcome);
			}
		}
		announceUploads(names, outcomes);
	};

	const uploadOneUrl = async (url: string, itemId = nextItemId()): Promise<Outcome> => {
		track({ itemId, name: url, size: null, status: 'uploading', url });
		const res = await processUrl(token, url).catch((e) => ({ rejected: e ?? 'Failed' }));
		if (!res || 'rejected' in res)
			return fail(itemId, "The page couldn't be fetched. Check the address and try again.", errorText(res?.rejected));
		let rejected: unknown;
		let uploaded = res.file;
		const onCreated = (serverId: string) => patch(itemId, { serverId, status: 'processing' });
		if (res.type === 'web' || res.type === 'youtube') {
			const name = url
				.replace(/[^a-z0-9]/gi, '_')
				.toLowerCase()
				.slice(0, 50);
			const file = blobToFile(new Blob([res.content ?? ''], { type: 'text/plain' }), `${name}.txt`);
			uploaded = await uploadFile(
				token,
				file,
				{ knowledge_id: knowledgeId, directory_id: directoryId, source_url: url },
				undefined,
				true,
				onCreated
			).catch((e) => {
				rejected = e ?? 'Upload failed';
				return null;
			});
		} else if (uploaded?.id) {
			const linked = await addFileToKnowledgeById(token, knowledgeId as string, uploaded.id, directoryId).catch((e) => {
				rejected = e ?? 'Failed';
				return null;
			});
			if (!linked) uploaded = null;
		}
		return settle(itemId, uploaded, rejected);
	};

	const uploadWeb = async (urls: string[]) => {
		if (!knowledgeId) return;
		const outcomes: Outcome[] = [];
		for (const url of urls) outcomes.push(await uploadOneUrl(url));
		announceUploads(urls, outcomes);
	};

	/** Tries a failed row again in place: the same row, one toast for it. */
	const retry = async (itemId: string) => {
		const item = uploading.find((i) => i.itemId === itemId);
		if (!item) return;
		const outcome = item.file
			? await uploadSingleFile(item.file, itemId)
			: item.url
				? await uploadOneUrl(item.url, itemId)
				: null;
		if (outcome) announceUploads([item.name], [outcome]);
	};

	/** Uploads one manifest entry into the base; the reason it failed, if it did. */
	const uploadEntry = async (
		entry: DirectoryManifestEntry,
		directoryIdFor: string | null | undefined
	): Promise<UploadOutcome> => {
		const file = new File([entry.file], entry.filename, { type: entry.file.type });
		const result = await uploadFile(token, file, {
			knowledge_id: knowledgeId,
			file_hash: entry.checksum,
			directory_id: directoryIdFor
		}).catch((error) => ({ error }));
		if (!result || (result as { error?: unknown }).error) {
			const reason = failureReason((result as { error?: unknown } | null)?.error);
			console.error('Upload failed:', displayPath(entry), reason);
			return { ok: false, reason };
		}
		return { ok: true };
	};

	/** Uploads each manifest entry in turn, reporting progress; returns how many failed. */
	const uploadManifestEntries = async (
		entries: DirectoryManifestEntry[],
		resolveDirectoryId: (entry: DirectoryManifestEntry) => string | null | undefined
	) => {
		let failed = 0;
		for (const [index, entry] of entries.entries()) {
			setSyncing(`Uploading ${index + 1}/${entries.length}: ${displayPath(entry)}`);
			if (!(await uploadEntry(entry, resolveDirectoryId(entry))).ok) failed++;
		}
		if (failed > 0) toast.error(`${failed} of ${plural(entries.length, 'file')} couldn't be added`);
		return failed;
	};

	const mkdirVia = (name: string, parentId: string | null) =>
		createKnowledgeDirectory(token, knowledgeId as string, name, parentId);

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
				manifest.map(({ filename, path, checksum, size }) => ({
					filename,
					path: getDirectoryUploadPath(breadcrumbs, path),
					checksum,
					size
				}))
			)) as SyncDiff | null;
			if (!diff) {
				toast.error("Couldn't compare the folder with this knowledge base. Try again.");
				return;
			}
			const idByPath = await createMissingDirectories(diff, mkdirVia);
			const failed = await uploadManifestEntries(manifest, (entry) =>
				entry.path ? idByPath[getDirectoryUploadPath(breadcrumbs, entry.path)] : directoryId
			);
			if (failed === 0) toast.success(`${plural(manifest.length, 'file')} added`);
			refresh();
		} catch (e) {
			notifyFailure("Couldn't upload the folder.", e);
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
				toast.error("Couldn't compare the folder with this knowledge base. Try again.");
				return;
			}
			// Files a cleanup left in the base because their content could not be deleted (#639).
			let kept = 0;
			const deleted = deletedFileIds(diff);
			if (deleted.length > 0 || diff.rmdir.length > 0) {
				setSyncing(`Removing ${deleted.length} deleted files...`);
				kept += (await syncKnowledgeCleanup(token, knowledgeId, deleted, diff.rmdir))?.kept?.length ?? 0;
			}
			const idByPath = await createMissingDirectories(diff, mkdirVia);
			const total = filesToUpload(manifest, diff).length;
			let started = 0;
			const { attempted, failed, removeError } = await syncUploads(
				manifest,
				diff,
				(entry, attempt) => {
					if (attempt === 'first') started++;
					setSyncing(
						attempt === 'first'
							? `Uploading ${started}/${total}: ${displayPath(entry)}`
							: `Uploading again: ${displayPath(entry)}`
					);
					return uploadEntry(entry, entry.path ? idByPath[entry.path] : null);
				},
				async (fileIds) => {
					setSyncing(`Removing ${fileIds.length} replaced files...`);
					const keptIds: string[] = (await syncKnowledgeCleanup(token, knowledgeId, fileIds, []))?.kept ?? [];
					kept += keptIds.length;
					return keptIds;
				}
			);
			if (removeError !== null)
				notifyFailure(
					"The old copies of changed files couldn't be removed. Sync again to retry.",
					failureReason(removeError)
				);
			if (kept > 0)
				toast.error(`${plural(kept, 'file')} couldn't be removed from the knowledge base. The next sync tries again.`);
			if (failed > 0) toast.error(`${failed} of ${plural(attempted, 'file')} couldn't be added`);
			if (failed === 0 && removeError === null && kept === 0) {
				toast.success(
					`Sync complete: ${diff.added.length} added, ${diff.modified.length} modified, ${diff.deleted.length} deleted, ${diff.unmodified_count} unmodified`
				);
			}
			refresh();
		} catch (e) {
			notifyFailure("Couldn't sync the folder.", e);
		} finally {
			setSyncing(null);
		}
	};

	return { uploading, syncing, uploadFiles, uploadWeb, retry, dismiss: untrack, uploadDirectoryEntries, syncDirectory };
}

// --- getting directory contents from the browser ---------------------------

const handleDirectoryError = (error: unknown) => {
	if ((error as { name?: string })?.name === 'AbortError') toast.info('No folder chosen');
	else {
		toast.error("Couldn't read that folder. Check the browser can open it, then try again.");
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
					if (entry.kind === 'file')
						collected.push({ path: dirPath, filename: entry.name, file: await entry.getFile() });
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
					const files = Array.from(input.files ?? []).filter(
						(f) => !hasHiddenFolder(f.webkitRelativePath) && !f.name.startsWith('.')
					);
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
export async function collectDroppedEntryFiles(
	entry: any,
	entryPath: string = entry.name
): Promise<DirectoryFileEntry[]> {
	if (entry.name.startsWith('.') || hasHiddenFolder(entryPath)) return [];
	if (entry.isFile) {
		const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
		const parts = entryPath.split('/');
		const filename = parts.pop() || file.name;
		return [{ path: parts.join('/'), filename, file }];
	}
	if (entry.isDirectory) {
		const children = await readAllEntries(entry.createReader());
		return (
			await Promise.all(children.map((child) => collectDroppedEntryFiles(child, `${entryPath}/${child.name}`)))
		).flat();
	}
	return [];
}

export { handleDirectoryError };
