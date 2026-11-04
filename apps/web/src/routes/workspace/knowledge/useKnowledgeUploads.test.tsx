import { act, renderHook } from '@testing-library/react';
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
		toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() }
	};
});
vi.mock('@/lib/apis/knowledge', () => kb);
vi.mock('@/lib/apis/files', () => files);
vi.mock('@/lib/apis/retrieval', () => ({ processUrl: vi.fn() }));
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
	const { result } = renderHook(() =>
		useKnowledgeUploads({ knowledgeId: 'kb1', directoryId: null, breadcrumbs: [], refresh: vi.fn() })
	);
	await act(() => result.current.syncDirectory(entries));
};

beforeEach(() => {
	calls.length = 0;
	vi.clearAllMocks();
	kb.syncKnowledgeDiff.mockResolvedValue(diff);
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
			'upload new.md',
			'upload edit.md',
			'upload broken.md',
			// Only the replaced copy: broken.md keeps its old version.
			'cleanup old-edit | '
		]);
		expect(toast.error).toHaveBeenCalledWith('Upload failed for 1 of 3 files.');
		expect(toast.success).not.toHaveBeenCalled();
	});

	it('removes every replaced copy when all uploads succeed, and reports the sync', async () => {
		await sync();

		expect(calls.at(-1)).toBe('cleanup old-edit,old-broken | ');
		expect(toast.success).toHaveBeenCalledWith('Sync complete: 1 added, 2 modified, 1 deleted, 1 unmodified');
	});

	it('makes no second cleanup when nothing was modified', async () => {
		kb.syncKnowledgeDiff.mockResolvedValue({ ...diff, modified: [] });

		await sync();

		expect(calls.filter((c) => c.startsWith('cleanup'))).toEqual(['cleanup gone | dir-gone']);
	});
});
