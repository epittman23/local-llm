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
		expect(toast.error).toHaveBeenCalledWith('Upload failed for 1 of 3 files.');
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

		expect(toast.error).toHaveBeenCalledWith('The old copies of modified files could not be removed: Server error');
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
			'2 files could not be removed from the knowledge base; the next sync tries again.'
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
