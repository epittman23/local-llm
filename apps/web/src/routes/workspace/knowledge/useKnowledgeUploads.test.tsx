import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncDiff } from './knowledgeFiles';
import { useKnowledgeUploads } from './useKnowledgeUploads';

// #317: the folder sync removed the old copy of every modified file before
// uploading the new one, so a new version that failed to upload left the
// file missing from the base until a later sync succeeded.

const { kb, files, toast, calls } = vi.hoisted(() => {
	const calls: string[] = [];
	return {
		calls,
		kb: {
			addFileToKnowledgeById: vi.fn(),
			createKnowledgeDirectory: vi.fn(),
			syncKnowledgeCleanup: vi.fn(async (_t: string, _kb: string, fileIds: string[], dirIds: string[] = []) => {
				calls.push(`cleanup ${fileIds.join(',')} | ${dirIds.join(',')}`);
				return {};
			}),
			syncKnowledgeDiff: vi.fn()
		},
		files: {
			uploadFile: vi.fn()
		},
		toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }
	};
});
vi.mock('@/lib/apis/knowledge', () => kb);
vi.mock('@/lib/apis/files', () => files);
const { processUrl } = vi.hoisted(() => ({ processUrl: vi.fn() }));
vi.mock('@/lib/apis/retrieval', () => ({ processUrl }));
vi.mock('@/lib/utils/hash', () => ({ computeFileHash: async (file: File) => `sha-${file.name}` }));
vi.mock('sonner', () => ({ toast }));

const diff: SyncDiff = {
	added: [{ filename: 'new.md', path: 'docs' }],
	modified: [
		{ filename: 'edit.md', path: 'docs', stale_file_id: 'old-edit' },
		{ filename: 'broken.md', path: 'docs', stale_file_id: 'old-broken' }
	],
	deleted: [{ file_id: 'gone' }],
	unmodified_count: 1,
	mkdir: [],
	rmdir: ['dir-gone'],
	directory_map: { docs: 'd1' }
};

const entries = ['new.md', 'edit.md', 'broken.md', 'same.md'].map((filename) => ({
	path: 'docs',
	filename,
	file: new File(['x'], filename)
}));

const sync = async () => {
	const refresh = vi.fn();
	const { result } = renderHook(() =>
		useKnowledgeUploads({ knowledgeId: 'kb1', directoryId: null, breadcrumbs: [], refresh })
	);
	await act(() => result.current.syncDirectory(entries));
	return refresh;
};

beforeEach(() => {
	calls.length = 0;
	vi.clearAllMocks();
	kb.syncKnowledgeDiff.mockResolvedValue(diff);
	kb.syncKnowledgeCleanup.mockImplementation(
		async (_t: string, _kb: string, fileIds: string[], dirIds: string[] = []) => {
			calls.push(`cleanup ${fileIds.join(',')} | ${dirIds.join(',')}`);
			return {};
		}
	);
	files.uploadFile.mockImplementation(async (_t: string, file: File) => {
		calls.push(`upload ${file.name}`);
		return { id: `new-${file.name}` };
	});
});

describe('useKnowledgeUploads syncDirectory', () => {
	it('removes a modified file’s old copy only after its new version uploaded, and keeps it when that failed', async () => {
		files.uploadFile.mockImplementation(async (_t: string, file: File) => {
			calls.push(`upload ${file.name}`);
			if (file.name === 'broken.md') throw 'Failed to process';
			return { id: `new-${file.name}` };
		});

		await sync();

		expect(calls).toEqual([
			// Deleted files and folders first, as before.
			'cleanup gone | dir-gone',
			'upload edit.md',
			'upload broken.md',
			// Only the replaced copy: broken.md keeps its old version.
			'cleanup old-edit | ',
			// Added files last.
			'upload new.md'
		]);
		expect(toast.error).toHaveBeenCalledWith("1 of 3 files couldn't be added");
		expect(toast.success).not.toHaveBeenCalled();
	});

	it('removes every replaced copy when all uploads succeed, and reports the sync', async () => {
		await sync();

		expect(calls.slice(-2)).toEqual(['cleanup old-edit,old-broken | ', 'upload new.md']);
		expect(toast.success).toHaveBeenCalledWith('Sync complete: 1 added, 2 modified, 1 deleted, 1 unmodified');
	});

	it('makes no second cleanup when nothing was modified', async () => {
		kb.syncKnowledgeDiff.mockResolvedValue({ ...diff, modified: [] });

		await sync();

		expect(calls.filter((c) => c.startsWith('cleanup'))).toEqual(['cleanup gone | dir-gone']);
	});

	it('still lists the uploads, and says so, when the old copies cannot be removed', async () => {
		kb.syncKnowledgeCleanup.mockImplementation(async (_t: string, _kb: string, fileIds: string[]) => {
			if (fileIds.includes('old-edit')) throw 'Server error';
			return {};
		});

		const refresh = await sync();

		expect(toast.error).toHaveBeenCalledWith(
			"The old copies of changed files couldn't be removed. Sync again to retry.",
			{
				description: expect.objectContaining({ props: { detail: 'Server error' } })
			}
		);
		expect(toast.success).not.toHaveBeenCalled();
		expect(refresh).toHaveBeenCalled();
	});

	it('says how many files the cleanups kept, instead of reporting the sync complete (#639)', async () => {
		kb.syncKnowledgeCleanup.mockImplementation(async (_t: string, _kb: string, fileIds: string[]) => ({
			status: true,
			kept: fileIds.filter((id) => id === 'gone' || id === 'old-edit')
		}));

		const refresh = await sync();

		expect(toast.error).toHaveBeenCalledWith(
			"2 files couldn't be removed from the knowledge base. The next sync tries again."
		);
		expect(toast.success).not.toHaveBeenCalled();
		expect(refresh).toHaveBeenCalled();
	});

	it('uploads a file refused as duplicate content again once its old copy is gone', async () => {
		files.uploadFile.mockImplementation(async (_t: string, file: File) => {
			calls.push(`upload ${file.name}`);
			// The first try of edit.md meets its own old copy, as a re-saved file with the same text does.
			if (file.name === 'edit.md' && calls.filter((c) => c === 'upload edit.md').length === 1)
				return { id: 'x', error: 'Duplicate content detected. Please provide unique content to proceed.' };
			return { id: `new-${file.name}` };
		});

		await sync();

		expect(calls.slice(1)).toEqual([
			'upload edit.md',
			'upload broken.md',
			'cleanup old-edit,old-broken | ',
			'upload edit.md',
			'upload new.md'
		]);
		expect(toast.success).toHaveBeenCalled();
	});
});

describe('useKnowledgeUploads single uploads (#907, #1072)', () => {
	const file = (name: string) => new File(['hello'], name, { type: 'text/plain' });
	const render = () => {
		const refresh = vi.fn();
		const hook = renderHook(() =>
			useKnowledgeUploads({ knowledgeId: 'kb1', directoryId: null, breadcrumbs: [], refresh })
		);
		return { hook, refresh };
	};
	beforeEach(() => {
		vi.clearAllMocks();
		files.uploadFile.mockReset();
	});

	it('gives four files one toast and leaves no rows behind', async () => {
		files.uploadFile.mockImplementation(async (_t: string, f: File) => ({ id: `id-${f.name}` }));
		const { hook, refresh } = render();
		await act(() => hook.result.current.uploadFiles(['a', 'b', 'c', 'd'].map(file)));
		expect(toast.success).toHaveBeenCalledTimes(1);
		expect(toast.success).toHaveBeenCalledWith('4 files added');
		expect(hook.result.current.uploading).toEqual([]);
		expect(refresh).toHaveBeenCalledTimes(4);
	});

	it('names a single added file', async () => {
		files.uploadFile.mockResolvedValue({ id: 'x' });
		const { hook } = render();
		await act(() => hook.result.current.uploadFiles([file('notes.md')]));
		expect(toast.success).toHaveBeenCalledWith('Added "notes.md"');
	});

	it('records the server id as soon as the POST answers, so the pending copy can be skipped', async () => {
		let finish: (v: unknown) => void = () => {};
		files.uploadFile.mockImplementation(
			(_t: string, _f: File, _m: unknown, _p: unknown, _s: unknown, onCreated: (id: string) => void) => {
				onCreated('srv-1');
				return new Promise((res) => {
					finish = res;
				});
			}
		);
		const { hook } = render();
		let done: Promise<void> = Promise.resolve();
		act(() => {
			done = hook.result.current.uploadFiles([file('a.md')]);
		});
		await waitFor(() =>
			expect(hook.result.current.uploading[0]).toMatchObject({ serverId: 'srv-1', status: 'processing' })
		);
		await act(async () => {
			finish({ id: 'srv-1' });
			await done;
		});
		expect(hook.result.current.uploading).toEqual([]);
	});

	it('keeps a refused upload as a failed row with the server text, and one summary toast', async () => {
		files.uploadFile.mockImplementation(async (_t: string, f: File) => {
			if (f.name === 'b.md') throw 'Embedding model is not available offline';
			return { id: f.name };
		});
		const { hook } = render();
		await act(() => hook.result.current.uploadFiles([file('a.md'), file('b.md')]));
		expect(hook.result.current.uploading).toEqual([
			expect.objectContaining({
				name: 'b.md',
				status: 'failed',
				reason: 'The server refused the upload.',
				detail: 'Embedding model is not available offline'
			})
		]);
		expect(toast.error).toHaveBeenCalledTimes(1);
		expect(toast.error).toHaveBeenCalledWith('1 added, 1 failed', expect.anything());
	});

	it('keeps a file that failed processing, says so, and retries it in the same row', async () => {
		files.uploadFile.mockResolvedValueOnce({ id: 'x', error: 'no embeddings' });
		const { hook, refresh } = render();
		await act(() => hook.result.current.uploadFiles([file('a.md')]));
		const [row] = hook.result.current.uploading;
		expect(row).toMatchObject({ status: 'failed', detail: 'no embeddings' });
		expect(row.reason).toMatch(/couldn't be processed/);
		expect(toast.error).toHaveBeenCalledWith('Couldn\'t add "a.md"', expect.anything());
		files.uploadFile.mockResolvedValueOnce({ id: 'y' });
		await act(() => hook.result.current.retry(row.itemId));
		expect(hook.result.current.uploading).toEqual([]);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(toast.success).toHaveBeenCalledWith('Added "a.md"');
	});

	it('marks duplicate content as skipped, with nothing to retry', async () => {
		files.uploadFile.mockResolvedValue({
			id: 'x',
			error: 'Duplicate content detected. Please provide unique content.'
		});
		const { hook } = render();
		await act(() => hook.result.current.uploadFiles([file('a.md')]));
		expect(hook.result.current.uploading[0]).toMatchObject({ duplicate: true, status: 'failed' });
		expect(toast.info).toHaveBeenCalledWith('"a.md" is already in this knowledge base, so it was skipped');
	});

	it('dismisses a failed row', async () => {
		files.uploadFile.mockResolvedValue(null);
		const { hook } = render();
		await act(() => hook.result.current.uploadFiles([file('a.md')]));
		expect(hook.result.current.uploading[0].reason).toBe("The server didn't answer. Try again.");
		act(() => hook.result.current.dismiss(hook.result.current.uploading[0].itemId));
		expect(hook.result.current.uploading).toEqual([]);
	});

	it('refuses an empty file by name without a request', async () => {
		const { hook } = render();
		await act(() => hook.result.current.uploadFiles([new File([], 'empty.md')]));
		expect(files.uploadFile).not.toHaveBeenCalled();
		expect(toast.error).toHaveBeenCalledWith('"empty.md" is empty, so it wasn\'t uploaded.');
	});

	it('adds web pages as text files and summarises them in one toast', async () => {
		processUrl.mockResolvedValue({ type: 'web', content: 'page text' });
		files.uploadFile.mockResolvedValue({ id: 'w' });
		const { hook } = render();
		await act(() => hook.result.current.uploadWeb(['https://a.example', 'https://b.example']));
		expect(files.uploadFile).toHaveBeenCalledTimes(2);
		expect(files.uploadFile.mock.calls[0][2]).toMatchObject({ source_url: 'https://a.example' });
		expect(toast.success).toHaveBeenCalledWith('2 files added');
	});

	it('keeps a page that could not be fetched as a failed row, and retries it', async () => {
		processUrl.mockRejectedValueOnce('timeout');
		const { hook } = render();
		await act(() => hook.result.current.uploadWeb(['https://a.example']));
		const [row] = hook.result.current.uploading;
		expect(row).toMatchObject({ url: 'https://a.example', status: 'failed', detail: 'timeout' });
		processUrl.mockResolvedValueOnce({ type: 'file', file: { id: 'f1' } });
		kb.addFileToKnowledgeById.mockResolvedValueOnce({ id: 'kb1' });
		await act(() => hook.result.current.retry(row.itemId));
		expect(kb.addFileToKnowledgeById).toHaveBeenCalledWith(expect.anything(), 'kb1', 'f1', null);
		expect(hook.result.current.uploading).toEqual([]);
	});

	it('fails a linked file the knowledge base refused', async () => {
		processUrl.mockResolvedValue({ type: 'file', file: { id: 'f1' } });
		kb.addFileToKnowledgeById.mockRejectedValueOnce('nope');
		const { hook } = render();
		await act(() => hook.result.current.uploadWeb(['https://a.example/doc.pdf']));
		expect(hook.result.current.uploading[0]).toMatchObject({ status: 'failed', detail: 'nope' });
	});
});
