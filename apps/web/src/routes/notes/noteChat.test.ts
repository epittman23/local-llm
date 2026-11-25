import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNewNote, getNoteById, updateNoteById } from '@/lib/apis/notes';
import { askAboutNote, explainDraft, quoteMarkdown, saveReplyToNote } from './noteChat';

vi.mock('@/lib/apis/notes', () => ({
	createNewNote: vi.fn(),
	getNoteById: vi.fn(),
	updateNoteById: vi.fn(async () => ({}))
}));

beforeEach(() => vi.clearAllMocks());

describe('quoting a selection', () => {
	it('puts "> " before every line of a multi-line selection, keeping blank lines inside the quote', () => {
		expect(quoteMarkdown('one\ntwo\n\nthree')).toBe('> one\n> two\n>\n> three');
	});

	it('trims the selection, and the draft is the quote, a blank line and the request', () => {
		expect(explainDraft('\n  a $x^2$ b\nline 2\n')).toBe('> a $x^2$ b\n> line 2\n\nExplain this.');
	});
});

describe('asking about a note', () => {
	it('goes to the new chat with ?note=<id>, and carries a draft in the navigation state only', () => {
		expect(askAboutNote('n 1')).toEqual({ to: '/?note=n%201', options: { state: undefined } });
		expect(askAboutNote('n1', '> q\n\nExplain this.')).toEqual({
			to: '/?note=n1',
			options: { state: { draft: '> q\n\nExplain this.' } }
		});
	});
});

describe('saving a reply to a note', () => {
	const md = 'Here:\n\n```py\nprint(1)\n```\n\n$$x^2$$';

	it('creates a new note holding the reply as Markdown and as HTML', async () => {
		vi.mocked(createNewNote).mockResolvedValue({ id: 'n9' });
		const saved = await saveReplyToNote('t', { kind: 'new', title: '  Plan  ' }, md);
		expect(saved).toEqual({ id: 'n9', title: 'Plan' });
		const [, body] = vi.mocked(createNewNote).mock.calls[0];
		expect(body.title).toBe('Plan');
		const content = (body.data as { content: { md: string; html: string; json: unknown } }).content;
		expect(content.md).toBe(md);
		expect(content.json).toBeNull();
		expect(content.html).toContain('<pre');
		expect(content.html).toContain('print(1)');
	});

	it('titles a note with no title Untitled', async () => {
		vi.mocked(createNewNote).mockResolvedValue({ id: 'n9' });
		expect((await saveReplyToNote('t', { kind: 'new', title: ' ' }, 'hi')).title).toBe('Untitled');
	});

	it('appends to an existing note after a blank line, regenerating the HTML and dropping stale editor JSON', async () => {
		vi.mocked(getNoteById).mockResolvedValue({
			id: 'n1',
			title: 'Log',
			data: { content: { md: '# Log\n\nfirst', html: '<p>old</p>', json: { type: 'doc' } } }
		});
		const saved = await saveReplyToNote('t', { kind: 'existing', id: 'n1' }, '**second**');
		expect(saved).toEqual({ id: 'n1', title: 'Log' });
		const [, id, body] = vi.mocked(updateNoteById).mock.calls[0];
		expect(id).toBe('n1');
		expect(body.title).toBe('Log');
		const content = (body.data as { content: { md: string; html: string; json: unknown } }).content;
		expect(content.md).toBe('# Log\n\nfirst\n\n**second**');
		expect(content.json).toBeNull();
		expect(content.html).toContain('<strong>second</strong>');
		expect(content.html).toContain('first');
	});

	it('starts an empty note with the reply, not a blank gap', async () => {
		vi.mocked(getNoteById).mockResolvedValue({ id: 'n1', title: 'Empty', data: { content: { md: '' } } });
		await saveReplyToNote('t', { kind: 'existing', id: 'n1' }, 'reply');
		const content = (vi.mocked(updateNoteById).mock.calls[0][2].data as { content: { md: string } }).content;
		expect(content.md).toBe('reply');
	});

	it('fails when the note cannot be read, writing nothing', async () => {
		vi.mocked(getNoteById).mockResolvedValue(null);
		await expect(saveReplyToNote('t', { kind: 'existing', id: 'gone' }, 'x')).rejects.toThrow();
		expect(updateNoteById).not.toHaveBeenCalled();
	});
});
