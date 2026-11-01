import { describe, expect, it, vi } from 'vitest';
import {
	KB_DIR_MOVE,
	KB_FILE_MOVE,
	announceContentSaved,
	createMissingDirectories,
	filesToUpload,
	getDirectoryUploadPath,
	hasHiddenFolder,
	knowledgeMetaPreview,
	readMovePayload,
	staleFileIds,
	takeDroppedItems,
	gatherDroppedFiles,
	type DirectoryFileEntry,
	type DirectoryManifestEntry,
	type SyncDiff
} from './knowledgeFiles';

const entry = (path: string, filename: string): DirectoryManifestEntry => ({
	path,
	filename,
	file: new File(['x'], filename),
	checksum: 'h',
	size: 1
});

describe('paths', () => {
	it('flags any hidden segment', () => {
		expect(hasHiddenFolder('docs/.git/config')).toBe(true);
		expect(hasHiddenFolder('docs/a.b/c')).toBe(false);
	});
	it("prefixes a picked directory's path with the directory currently open", () => {
		const crumbs = [
			{ id: '1', name: 'Reports' },
			{ id: '2', name: '2024' }
		];
		expect(getDirectoryUploadPath(crumbs, 'q1/notes')).toBe('Reports/2024/q1/notes');
		expect(getDirectoryUploadPath(crumbs, '')).toBe('Reports/2024');
		expect(getDirectoryUploadPath([], 'q1')).toBe('q1');
	});
});

describe('sync diff', () => {
	const diff: SyncDiff = {
		added: [{ filename: 'new.md', path: 'a' }],
		modified: [{ filename: 'edit.md', path: 'a', stale_file_id: 'old1' }],
		deleted: [{ file_id: 'gone1' }],
		unmodified_count: 3,
		mkdir: [],
		rmdir: []
	};
	it('uploads exactly the added and modified files, matching on filename AND path', () => {
		const manifest = [entry('a', 'new.md'), entry('a', 'edit.md'), entry('a', 'same.md'), entry('b', 'new.md')];
		expect(filesToUpload(manifest, diff).map((e) => `${e.path}/${e.filename}`)).toEqual(['a/new.md', 'a/edit.md']);
	});
	it('removes deleted files and the stale copies of modified ones first', () => {
		expect(staleFileIds(diff)).toEqual(['gone1', 'old1']);
	});
});

describe('createMissingDirectories', () => {
	it('creates parents before children and threads their ids through', async () => {
		const create = vi.fn(async (name: string, parentId: string | null) => ({ id: `${parentId ?? 'root'}/${name}` }));
		const map = await createMissingDirectories(
			{ mkdir: ['a', 'a/b', 'a/b/c'], directory_map: { existing: 'e1' } },
			create
		);
		expect(create.mock.calls).toEqual([
			['a', null],
			['b', 'root/a'],
			['c', 'root/a/b']
		]);
		expect(map).toEqual({ existing: 'e1', a: 'root/a', 'a/b': 'root/a/b', 'a/b/c': 'root/a/b/c' });
	});
	it('uses a pre-existing parent from the server map, and skips a directory that failed to create', async () => {
		const create = vi.fn(async (name: string) => (name === 'bad' ? null : { id: `id-${name}` }));
		const map = await createMissingDirectories(
			{ mkdir: ['known/bad', 'known/ok'], directory_map: { known: 'k1' } },
			create
		);
		expect(create.mock.calls[0]).toEqual(['bad', 'k1']);
		expect(map).toEqual({ known: 'k1', 'known/ok': 'id-ok' });
	});
});

describe('readMovePayload', () => {
	const dt = (data: Record<string, string>) => ({ getData: (t: string) => data[t] ?? '' });
	it('reads file and directory moves, and rejects OS drops and malformed payloads', () => {
		expect(readMovePayload(dt({ [KB_FILE_MOVE]: '{"fileId":"f1"}' }))).toEqual({ kind: 'file', id: 'f1' });
		expect(readMovePayload(dt({ [KB_DIR_MOVE]: '{"dirId":"d1"}' }))).toEqual({ kind: 'dir', id: 'd1' });
		expect(readMovePayload(dt({}))).toBeNull();
		expect(readMovePayload(dt({ [KB_FILE_MOVE]: 'not json' }))).toBeNull();
		expect(readMovePayload(dt({ [KB_FILE_MOVE]: '{"fileId":5}' }))).toBeNull();
		expect(readMovePayload(null)).toBeNull();
	});
});

describe('knowledgeMetaPreview', () => {
	it('summarises files, description and (for local bases) scalar metadata', () => {
		expect(knowledgeMetaPreview({ file_count: 1, description: 'd' })).toBe('1 file · d');
		expect(knowledgeMetaPreview({ file_count: 4, meta: { lang: 'en', empty: '', nested: {} } })).toBe(
			'4 files · lang: en · nested'
		);
	});
	it('describes a connected source by provider and mapped source', () => {
		expect(
			knowledgeMetaPreview({
				meta: { source: 'external', external: { provider: 'Drive', source: { name: 'Docs' }, auth_mode: 'service' } },
				description: 'x'
			})
		).toBe('Drive · Docs · service · x');
	});
});

describe('announceContentSaved', () => {
	it('names the knowledge bases a saved edit did not reach (#307)', () => {
		const notify = { success: vi.fn(), warning: vi.fn() };
		announceContentSaved({ failed_knowledge: ['Research', 'Ops'] }, notify);
		expect(notify.warning).toHaveBeenCalledWith(
			'File content saved, but these knowledge bases still use the old text: Research, Ops.'
		);
		announceContentSaved({ failed_knowledge: [] }, notify);
		announceContentSaved(null, notify);
		expect(notify.success).toHaveBeenCalledTimes(2);
		expect(notify.warning).toHaveBeenCalledTimes(1);
	});
});

describe('takeDroppedItems', () => {
	it('reads every dropped item at once, folders and files alike (#231)', () => {
		const file = (name: string) => new File(['x'], name);
		const folder = { isDirectory: true, name: 'docs' };
		const items = [
			{ webkitGetAsEntry: () => ({ isDirectory: false }), getAsFile: () => file('a.txt') },
			{ webkitGetAsEntry: () => folder, getAsFile: () => null },
			{ webkitGetAsEntry: () => ({ isDirectory: false }), getAsFile: () => file('b.txt') },
			{ getAsFile: () => file('c.txt') }
		];
		const { directories, files } = takeDroppedItems(items);
		expect(directories).toEqual([folder]);
		expect(files.map((f) => f.name)).toEqual(['a.txt', 'b.txt', 'c.txt']);
	});
});

describe('gatherDroppedFiles', () => {
	/** Items that read as null once the drop handler has awaited, as a browser's DataTransfer does. */
	function dropped() {
		let isProtected = false;
		const folder = { isDirectory: true, name: 'docs' };
		const items = [
			{ webkitGetAsEntry: () => (isProtected ? null : folder), getAsFile: () => null },
			{
				webkitGetAsEntry: () => (isProtected ? null : { isDirectory: false }),
				getAsFile: () => (isProtected ? null : new File(['x'], 'after.txt'))
			}
		];
		return { items, protect: () => (isProtected = true) };
	}
	const inside: DirectoryFileEntry[] = [{ path: 'docs', filename: 'in.txt', file: new File(['y'], 'in.txt') }];

	it("keeps the files dropped after a folder, and the folder's own (#231)", async () => {
		const { items, protect } = dropped();
		const got = await gatherDroppedFiles(
			items,
			async () => {
				protect();
				return inside;
			},
			vi.fn()
		);
		expect(got?.loose.map((f) => f.name)).toEqual(['after.txt']);
		expect(got?.directoryEntries).toEqual(inside);
	});
	it('reports a folder it cannot read and gives up', async () => {
		const onError = vi.fn();
		const got = await gatherDroppedFiles(
			dropped().items,
			async () => {
				throw new Error('denied');
			},
			onError
		);
		expect(got).toBeNull();
		expect(onError).toHaveBeenCalledWith(new Error('denied'));
	});
});
