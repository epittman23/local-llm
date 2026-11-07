import { describe, expect, it, vi } from 'vitest';
import {
	KB_DIR_MOVE,
	KB_FILE_MOVE,
	announceContentSaved,
	clampPage,
	createMissingDirectories,
	deletedFileIds,
	filesToUpload,
	getDirectoryUploadPath,
	hasHiddenFolder,
	knowledgeMetaPreview,
	readMovePayload,
	replacedFileIds,
	syncUploads,
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
	it('removes deleted files before uploading, and not the old copies of modified ones', () => {
		expect(deletedFileIds(diff)).toEqual(['gone1']);
	});
	it('names the old copies of the given modified files', () => {
		expect(replacedFileIds(diff, [entry('a', 'new.md'), entry('a', 'edit.md')])).toEqual(['old1']);
		expect(replacedFileIds(diff, [entry('a', 'new.md')])).toEqual([]);
		// Same name in another folder is another file.
		expect(replacedFileIds(diff, [entry('b', 'edit.md')])).toEqual([]);
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

describe('clampPage', () => {
	it('keeps a page the list still reaches', () => {
		expect(clampPage(2, 31, 30)).toBe(2);
		expect(clampPage(1, 31, 30)).toBe(1);
	});
	it('pulls a page past the end back to the last page', () => {
		expect(clampPage(2, 30, 30)).toBe(1);
		expect(clampPage(5, 61, 30)).toBe(3);
	});
	it('falls back to page 1 for an empty list', () => {
		expect(clampPage(3, 0, 30)).toBe(1);
	});
});

/**
 * A knowledge base as the server keeps it for a sync: copies by id, each with
 * its path and text. An upload is refused as duplicate content when any copy
 * already holds its text, as the server's vector save does; `failing` names
 * paths whose upload fails for another reason.
 */
function fakeBase(copies: Record<string, { key: string; text: string }>, failing: string[] = []) {
	const base = { ...copies };
	let next = 0;
	const texts: Record<string, string> = {};
	return {
		base,
		texts,
		upload: async (e: DirectoryManifestEntry) => {
			const key = `${e.path}/${e.filename}`;
			if (failing.includes(key)) return { ok: false as const, reason: 'Failed to process' };
			if (Object.values(base).some((c) => c.text === texts[key]))
				return { ok: false as const, reason: 'Duplicate content detected. Please provide unique content to proceed.' };
			base[`new${next++}`] = { key, text: texts[key] };
			return { ok: true as const };
		},
		remove: async (ids: string[]) => {
			for (const id of ids) delete base[id];
		},
		/** What the base holds now: path -> text, one entry per copy, sorted. */
		holds: () =>
			Object.values(base)
				.map((c) => `${c.key}=${c.text}`)
				.sort()
	};
}

const syncDiff = (changes: Partial<SyncDiff>): SyncDiff => ({
	added: [],
	modified: [],
	deleted: [],
	unmodified_count: 0,
	mkdir: [],
	rmdir: [],
	...changes
});

describe('syncUploads (#317)', () => {
	it('keeps the old copy of a modified file whose new version fails to upload', async () => {
		const fake = fakeBase({ oldA: { key: 'd/a.txt', text: 'X' } }, ['d/a.txt']);
		fake.texts['d/a.txt'] = 'Y';
		const d = syncDiff({ modified: [{ filename: 'a.txt', path: 'd', stale_file_id: 'oldA' }] });

		const result = await syncUploads([entry('d', 'a.txt')], d, fake.upload, fake.remove);

		expect(result).toEqual({ attempted: 1, failed: 1, removeError: null });
		expect(fake.holds()).toEqual(['d/a.txt=X']);
	});

	it('replaces a modified file whose new version uploads', async () => {
		const fake = fakeBase({ oldA: { key: 'd/a.txt', text: 'X' } });
		fake.texts['d/a.txt'] = 'Y';
		const d = syncDiff({ modified: [{ filename: 'a.txt', path: 'd', stale_file_id: 'oldA' }] });

		expect((await syncUploads([entry('d', 'a.txt')], d, fake.upload, fake.remove)).failed).toBe(0);
		expect(fake.holds()).toEqual(['d/a.txt=Y']);
	});

	it('uploads a copy of a modified file\u2019s old text after the old copy is gone (copy, then edit)', async () => {
		const fake = fakeBase({ oldA: { key: 'd/a.txt', text: 'X' } });
		Object.assign(fake.texts, { 'd/a.txt': 'Y', 'd/b.txt': 'X' });
		const d = syncDiff({
			modified: [{ filename: 'a.txt', path: 'd', stale_file_id: 'oldA' }],
			added: [{ filename: 'b.txt', path: 'd' }]
		});

		const result = await syncUploads([entry('d', 'a.txt'), entry('d', 'b.txt')], d, fake.upload, fake.remove);

		expect(result.failed).toBe(0);
		expect(fake.holds()).toEqual(['d/a.txt=Y', 'd/b.txt=X']);
	});

	it('replaces a file re-saved with the same text, which its own old copy refuses at first', async () => {
		const fake = fakeBase({ oldA: { key: 'd/a.docx', text: 'X' } });
		fake.texts['d/a.docx'] = 'X';
		const d = syncDiff({ modified: [{ filename: 'a.docx', path: 'd', stale_file_id: 'oldA' }] });
		const attempts: string[] = [];
		const upload = (e: DirectoryManifestEntry, attempt: 'first' | 'again') => {
			attempts.push(attempt);
			return fake.upload(e);
		};

		const result = await syncUploads([entry('d', 'a.docx')], d, upload, fake.remove);

		expect(result.failed).toBe(0);
		expect(attempts).toEqual(['first', 'again']);
		expect(fake.holds()).toEqual(['d/a.docx=X']);
	});

	it('replaces two files that swapped contents', async () => {
		const fake = fakeBase({ oldA: { key: 'd/a.txt', text: 'X' }, oldB: { key: 'd/b.txt', text: 'Y' } });
		Object.assign(fake.texts, { 'd/a.txt': 'Y', 'd/b.txt': 'X' });
		const d = syncDiff({
			modified: [
				{ filename: 'a.txt', path: 'd', stale_file_id: 'oldA' },
				{ filename: 'b.txt', path: 'd', stale_file_id: 'oldB' }
			]
		});

		const result = await syncUploads([entry('d', 'a.txt'), entry('d', 'b.txt')], d, fake.upload, fake.remove);

		expect(result.failed).toBe(0);
		expect(fake.holds()).toEqual(['d/a.txt=Y', 'd/b.txt=X']);
	});

	it('counts a duplicate as failed, without retrying it, when the old copies cannot be removed', async () => {
		const fake = fakeBase({ oldA: { key: 'd/a.docx', text: 'X' } });
		fake.texts['d/a.docx'] = 'X';
		const d = syncDiff({ modified: [{ filename: 'a.docx', path: 'd', stale_file_id: 'oldA' }] });
		const upload = vi.fn(fake.upload);
		const refused = new Error('cleanup refused');

		const result = await syncUploads([entry('d', 'a.docx')], d, upload, async () => {
			throw refused;
		});

		expect(result).toEqual({ attempted: 1, failed: 1, removeError: refused });
		expect(upload).toHaveBeenCalledTimes(1);
		expect(fake.holds()).toEqual(['d/a.docx=X']);
	});

	it('does not upload a duplicate again when the cleanup kept its old copy (#639)', async () => {
		const fake = fakeBase({ oldA: { key: 'd/a.docx', text: 'X' } });
		fake.texts['d/a.docx'] = 'X';
		const d = syncDiff({ modified: [{ filename: 'a.docx', path: 'd', stale_file_id: 'oldA' }] });
		const upload = vi.fn(fake.upload);

		const result = await syncUploads([entry('d', 'a.docx')], d, upload, async (ids) => ids);

		expect(result.failed).toBe(1);
		expect(upload).toHaveBeenCalledTimes(1);
		expect(fake.holds()).toEqual(['d/a.docx=X']);
	});

	it('still uploads a duplicate again when the cleanup kept only another file\u2019s old copy (#639)', async () => {
		const fake = fakeBase({ oldA: { key: 'd/a.docx', text: 'X' }, oldB: { key: 'd/b.txt', text: 'Y' } });
		Object.assign(fake.texts, { 'd/a.docx': 'X', 'd/b.txt': 'Z' });
		const d = syncDiff({
			modified: [
				{ filename: 'a.docx', path: 'd', stale_file_id: 'oldA' },
				{ filename: 'b.txt', path: 'd', stale_file_id: 'oldB' }
			]
		});
		const keepB = async (ids: string[]) => {
			await fake.remove(ids.filter((id) => id !== 'oldB'));
			return ids.filter((id) => id === 'oldB');
		};

		const result = await syncUploads([entry('d', 'a.docx'), entry('d', 'b.txt')], d, fake.upload, keepB);

		expect(result.failed).toBe(0);
		expect(fake.holds()).toEqual(['d/a.docx=X', 'd/b.txt=Y', 'd/b.txt=Z']);
	});
});
