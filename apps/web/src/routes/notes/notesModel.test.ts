// @vitest-environment jsdom
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { updateNoteAccessGrants } from '@/lib/apis/notes';
import type { SessionUser, UserPermissions } from '@/lib/stores/authStore';
import {
	contentFromMarkdown,
	editorContent,
	groupNotes,
	importableNote,
	nextSort,
	noteAccessProps,
	openLinkedNote,
	parseGeneratedTitle,
	safeFileName,
	saveNoteAccess,
	withServerGrants,
	wordCount
} from './notesModel';

vi.mock('@/lib/apis/notes', () => ({ updateNoteAccessGrants: vi.fn() }));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const ns = (d: Date) => d.getTime() * 1_000_000;

describe('notes list', () => {
	it('groups by time range in order', () => {
		const now = new Date(2026, 9, 1, 12);
		const groups = groupNotes(
			[
				{ id: 'a', updated_at: ns(new Date(2026, 9, 1, 8)) },
				{ id: 'b', updated_at: ns(new Date(2026, 8, 30)) },
				{ id: 'c', updated_at: ns(new Date(2026, 9, 1, 7)) }
			],
			now
		);
		expect(groups.map(([k, v]) => [k, v.map((n) => n.id)])).toEqual([
			['Today', ['a', 'c']],
			['Yesterday', ['b']]
		]);
	});
	it('sorting: flip the active column; dates start newest first, titles A-Z', () => {
		expect(nextSort({ key: 'updated_at', direction: 'desc' }, 'updated_at')).toEqual({
			key: 'updated_at',
			direction: 'asc'
		});
		expect(nextSort({ key: 'updated_at', direction: 'desc' }, 'name')).toEqual({ key: 'name', direction: 'asc' });
	});
});

describe('content', () => {
	it('a new note from markdown carries html and md', () => {
		expect(contentFromMarkdown('# T')).toMatchObject({
			json: null,
			md: '# T',
			html: expect.stringContaining('<h1>T</h1>')
		});
		expect(contentFromMarkdown()).toEqual({ json: null, html: '', md: '' });
	});
	it('the editor loads json, else html, else rendered markdown', () => {
		expect(editorContent({ json: { type: 'doc' }, html: '<p>x</p>' })).toEqual({ type: 'doc' });
		expect(editorContent({ html: '<p>x</p>', md: 'y' })).toBe('<p>x</p>');
		expect(editorContent({ md: '**y**' })).toContain('<strong>y</strong>');
		expect(editorContent(null)).toBe('');
	});
	it('imports only md/txt; names files safely; counts words', () => {
		expect(importableNote({ name: 'Plan.MD', type: '' })).toEqual({ title: 'Plan' });
		expect(importableNote({ name: 'a.pdf', type: 'application/pdf' })).toBeNull();
		expect(safeFileName('a/b: c?', 'md')).toBe('a-b- c-.md');
		expect(safeFileName('', 'txt')).toBe('Untitled.txt');
		expect(wordCount('  one two\nthree ')).toBe(3);
		expect(wordCount('')).toBe(0);
	});
	it('reads a generated title out of a chatty reply', () => {
		expect(parseGeneratedTitle('Sure! {"title": " Weekly Plan "} done')).toBe('Weekly Plan');
		expect(parseGeneratedTitle('no json')).toBeNull();
		expect(parseGeneratedTitle('{"title": ""}')).toBeNull();
		expect(parseGeneratedTitle('{bad}')).toBeNull();
	});
});

describe('access', () => {
	const user = (role: string, permissions?: UserPermissions): SessionUser => ({
		id: 'u',
		email: 'u@x',
		name: 'U',
		role,
		profile_image_url: '',
		permissions
	});
	it('grants read and write, gated by the sharing permissions; admins get every option', () => {
		expect(noteAccessProps(user('admin', { access_grants: { allow_users: false } }))).toEqual({
			accessRoles: ['read', 'write'],
			share: true,
			sharePublic: true,
			shareUsers: true
		});
		expect(noteAccessProps(user('user'))).toEqual({
			accessRoles: ['read', 'write'],
			share: false,
			sharePublic: false,
			shareUsers: true
		});
		expect(noteAccessProps(null)).toMatchObject({ share: false, sharePublic: false, shareUsers: true });
	});
	it('each permission opens only its own option', () => {
		expect(noteAccessProps(user('user', { sharing: { public_notes: true } }))).toMatchObject({
			share: false,
			sharePublic: true
		});
		expect(noteAccessProps(user('user', { sharing: { notes: true } }))).toMatchObject({
			share: true,
			sharePublic: false
		});
		expect(noteAccessProps(user('user', { access_grants: { allow_users: false } })).shareUsers).toBe(false);
	});
	it('caches the grants the server stored, not the ones sent, and nothing else', () => {
		const note = { id: 'n', title: 'Unsaved edit', is_pinned: true, access_grants: [] };
		// Sent `user:*` (Public); the server dropped it for lack of sharing.public_notes.
		const res = {
			id: 'n',
			title: 'Last saved',
			is_pinned: false,
			access_grants: [{ id: 'g', principal_type: 'group' as const, principal_id: 'g1', permission: 'write' as const }]
		};
		expect(withServerGrants(note, res)).toEqual({ ...note, access_grants: res.access_grants });
		expect(withServerGrants(note, { ...res, access_grants: [] }).access_grants).toEqual([]);
		expect(withServerGrants(note, null)).toBe(note);
	});
});

describe('saving access', () => {
	beforeEach(() => vi.clearAllMocks());
	const publicRead = [{ principal_type: 'user' as const, principal_id: '*', permission: 'read' as const }];
	const setup = () => {
		const client = new QueryClient();
		client.setQueryData(['notes', 'item', 'n'], { id: 'n', title: 'T', access_grants: [] });
		return client;
	};
	const cached = (client: QueryClient) => client.getQueryData<{ access_grants: unknown[] }>(['notes', 'item', 'n']);

	it('shows what the server stored: a Public grant it dropped stays off', async () => {
		const client = setup();
		vi.mocked(updateNoteAccessGrants).mockResolvedValueOnce({ id: 'n', access_grants: [] });
		await saveNoteAccess(client, 'tok', 'n', publicRead);
		expect(updateNoteAccessGrants).toHaveBeenLastCalledWith('tok', 'n', publicRead);
		expect(cached(client)).toEqual({ id: 'n', title: 'T', access_grants: [] });
		expect(toast.warning).toHaveBeenCalledWith(
			'Some access settings were not saved: you are not allowed to share this way.'
		);
		expect(toast.success).not.toHaveBeenCalled();
	});
	it('keeps the old grants when the update fails', async () => {
		const client = setup();
		vi.mocked(updateNoteAccessGrants).mockRejectedValueOnce('Not allowed');
		await saveNoteAccess(client, 'tok', 'n', publicRead);
		expect(cached(client)?.access_grants).toEqual([]);
		expect(toast.error).toHaveBeenCalledWith('Not allowed');
		expect(toast.success).not.toHaveBeenCalled();
	});
	it('caches a grant the server kept and says Saved', async () => {
		const client = setup();
		// The stored rows carry ids and resource fields; they match the sent grants by principal and permission.
		const stored = [{ ...publicRead[0], id: 'g1', resource_type: 'note', resource_id: 'n' }];
		vi.mocked(updateNoteAccessGrants).mockResolvedValueOnce({ id: 'n', access_grants: stored });
		await saveNoteAccess(client, 'tok', 'n', publicRead);
		expect(cached(client)?.access_grants).toEqual(stored);
		expect(toast.success).toHaveBeenCalledWith('Saved');
		expect(toast.warning).not.toHaveBeenCalled();
	});

	const deferred = () => {
		let resolve!: (v: unknown) => void;
		let reject!: (e: unknown) => void;
		const promise = new Promise((res, rej) => {
			resolve = res;
			reject = rej;
		});
		return { promise, resolve, reject };
	};
	const group = { principal_type: 'group' as const, principal_id: 'g', permission: 'read' as const };

	it('shows the sent grants at once, so the next edit builds on them', async () => {
		const client = setup();
		const a = deferred();
		vi.mocked(updateNoteAccessGrants).mockReturnValueOnce(a.promise);
		const saving = saveNoteAccess(client, 'tok', 'n', [group]);
		expect(cached(client)?.access_grants).toEqual([group]);
		a.resolve({ id: 'n', access_grants: [group] });
		await saving;
		expect(cached(client)?.access_grants).toEqual([group]);
	});
	it('overlapping saves: only the latest response lands in the cache', async () => {
		const client = setup();
		const a = deferred();
		const b = deferred();
		vi.mocked(updateNoteAccessGrants).mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
		const saveA = saveNoteAccess(client, 'tok', 'n', [group]);
		const saveB = saveNoteAccess(client, 'tok', 'n', [group, ...publicRead]);
		expect(cached(client)?.access_grants).toEqual([group, ...publicRead]);
		// B answers first, then the older A: A's reply must not overwrite B's.
		b.resolve({ id: 'n', access_grants: [group, ...publicRead] });
		await saveB;
		a.resolve({ id: 'n', access_grants: [group] });
		await saveA;
		expect(cached(client)?.access_grants).toEqual([group, ...publicRead]);
	});
	it('a failed save restores the previous grants', async () => {
		const client = setup();
		const a = deferred();
		vi.mocked(updateNoteAccessGrants).mockReturnValueOnce(a.promise);
		const saving = saveNoteAccess(client, 'tok', 'n', [group]);
		expect(cached(client)?.access_grants).toEqual([group]);
		a.reject('Server error');
		await saving;
		expect(cached(client)?.access_grants).toEqual([]);
		expect(toast.error).toHaveBeenCalledWith('Server error');
	});
	it('an older save failing does not undo a newer one', async () => {
		const client = setup();
		const a = deferred();
		const b = deferred();
		vi.mocked(updateNoteAccessGrants).mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
		const saveA = saveNoteAccess(client, 'tok', 'n', [group]);
		const saveB = saveNoteAccess(client, 'tok', 'n', [group, ...publicRead]);
		a.reject('Server error');
		await saveA;
		expect(cached(client)?.access_grants).toEqual([group, ...publicRead]);
		b.resolve({ id: 'n', access_grants: [group, ...publicRead] });
		await saveB;
		expect(cached(client)?.access_grants).toEqual([group, ...publicRead]);
	});
});

describe('openLinkedNote (#210)', () => {
	beforeEach(() => vi.clearAllMocks());
	const run = async (create: () => Promise<string | null | undefined>) => {
		const open = vi.fn();
		await openLinkedNote(create, open);
		return open.mock.calls;
	};

	it('opens the created note', async () => {
		expect(await run(async () => 'n1')).toEqual([['/notes/n1']]);
		expect(toast.error).not.toHaveBeenCalled();
	});
	it('says why when the create fails, and opens the list', async () => {
		expect(await run(() => Promise.reject('Notes are not allowed'))).toEqual([['/notes']]);
		expect(toast.error.mock.calls).toEqual([['Notes are not allowed']]);
	});
	it('says so when the create returns no note, and opens the list', async () => {
		for (const id of [undefined, null, '']) {
			vi.clearAllMocks();
			expect(await run(async () => id)).toEqual([['/notes']]);
			expect(toast.error.mock.calls).toEqual([['The note could not be created']]);
		}
	});
});
