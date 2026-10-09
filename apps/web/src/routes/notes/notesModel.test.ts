// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
	contentFromMarkdown,
	editorContent,
	groupNotes,
	importableNote,
	nextSort,
	parseGeneratedTitle,
	safeFileName,
	wordCount
} from './notesModel';

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
