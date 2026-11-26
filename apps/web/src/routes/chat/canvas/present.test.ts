import { describe, expect, it } from 'vitest';
import { canEditDocument, editabilityOf, hasChanges, uneditableText, versionLabel, withVersion } from './present';
import { blockDoc, docOf, id, output, upload } from './testing';

describe('canEditDocument', () => {
	it('is true for an output script and an uploaded Markdown file, and for a file of unknown size', () => {
		expect(canEditDocument(docOf(output('1', 'fit.py')))).toBe(true);
		expect(canEditDocument(docOf(upload('2', 'notes.md'), 'user'))).toBe(true);
		expect(canEditDocument(docOf(output('3', 'run.sh', {}, { size: undefined })))).toBe(true);
	});
	it('is false for a table, an SVG, an image, a PDF and a file that only downloads', () => {
		for (const name of ['table.csv', 'drawing.svg', 'plot.png', 'paper.pdf', 'data.bin'])
			expect(canEditDocument(docOf(output('1', name))), name).toBe(false);
	});
	it('is true for a page (an output or an upload) and false for a fenced block, whatever its language: a block is not saved', () => {
		expect(canEditDocument(docOf(output('1', 'page.html')))).toBe(true);
		expect(canEditDocument(docOf(upload('2', 'mine.html'), 'user'))).toBe(true);
		expect(canEditDocument(blockDoc('x = 1', 'python'))).toBe(false);
		expect(canEditDocument(blockDoc('<p>hi</p>', 'html'))).toBe(false);
	});
	it('is false past the most the canvas loads, and true at it', () => {
		expect(canEditDocument(docOf(output('1', 'big.py', {}, { size: 256 * 1024 + 1 })))).toBe(false);
		expect(canEditDocument(docOf(output('1', 'big.py', {}, { size: 256 * 1024 })))).toBe(true);
	});
});

describe('editabilityOf', () => {
	it('previews the draft of a page the model wrote, and only edits the source of an upload', () => {
		expect(editabilityOf(docOf(output('1', 'page.html')))).toEqual({ canEdit: true, draftOnly: false, preview: true });
		expect(editabilityOf(docOf(upload('2', 'mine.html'), 'user'))).toEqual({
			canEdit: true,
			draftOnly: false,
			preview: false
		});
		expect(editabilityOf(docOf(output('3', 'fit.py')))).toEqual({ canEdit: true, draftOnly: false, preview: false });
	});
	it('lets a closed html or svg block be tried, never saved', () => {
		const tried = { canEdit: true, draftOnly: true, preview: true };
		expect(editabilityOf(blockDoc('<p>hi</p>', 'html'))).toEqual(tried);
		expect(editabilityOf(blockDoc('<svg></svg>', 'svg', true, 'SVG drawing'))).toEqual(tried);
	});
	it('refuses a block still being written, any other block, one over 256 KiB, an SVG file and a non-UUID id', () => {
		const none = { canEdit: false, draftOnly: false, preview: false };
		expect(editabilityOf(blockDoc('<p>hi', 'html', false))).toEqual(none);
		expect(editabilityOf(blockDoc('x = 1', 'python'))).toEqual(none);
		expect(editabilityOf(blockDoc(`<p>${'a'.repeat(256 * 1024)}</p>`, 'html'))).toEqual(none);
		expect(editabilityOf(docOf(output('4', 'drawing.svg')))).toEqual(none);
		const page = docOf(output('5', 'page.html'));
		const loose = { ...page, source: { ...page.source, fileId: 'not-a-uuid' } } as typeof page;
		expect(editabilityOf(loose)).toEqual(none);
		expect(editabilityOf(docOf(output('6', 'big.html', {}, { size: 256 * 1024 + 1 })))).toEqual(none);
	});
});

describe('uneditableText', () => {
	it('names a cut text and a text that was not UTF-8, and passes the rest', () => {
		expect(uneditableText({ text: 'abc', truncated: true })).toBe('truncated');
		expect(uneditableText({ text: 'caf�', truncated: false })).toBe('encoding');
		expect(uneditableText({ text: 'café\r\n', truncated: false })).toBeNull();
	});
});

describe('withVersion', () => {
	it('swaps the file and its size for the version’s and leaves the rest', () => {
		const doc = docOf(output('1', 'fit.py'));
		const shown = withVersion(doc, { id: id('9'), size: 42 });
		expect(shown).toMatchObject({ id: doc.id, name: 'fit.py', bytes: 42, source: { type: 'output', fileId: id('9') } });
		expect(doc.source).toMatchObject({ fileId: id('1') });
	});
	it('keeps the document when there is no version, and never touches a block', () => {
		const doc = docOf(upload('2', 'notes.md'), 'user');
		expect(withVersion(doc, null)).toBe(doc);
		const block = blockDoc('x', 'python');
		expect(withVersion(block, { id: id('9'), size: 1 })).toBe(block);
	});
});

describe('hasChanges', () => {
	const two = [{}, {}];
	it('is true for an editable text document with more than one version', () => {
		expect(hasChanges(docOf(output('1', 'fit.py')), two)).toBe(true);
		expect(hasChanges(docOf(output('2', 'notes.md')), two)).toBe(true);
	});
	it('is false with one version or none', () => {
		expect(hasChanges(docOf(output('1', 'fit.py')), [{}])).toBe(false);
		expect(hasChanges(docOf(output('1', 'fit.py')), [])).toBe(false);
	});
	it('is false for an image, a PDF, a table and a fenced block, whatever the versions', () => {
		for (const name of ['plot.png', 'paper.pdf', 'table.csv'])
			expect(hasChanges(docOf(output('1', name)), two), name).toBe(false);
		expect(hasChanges(blockDoc('x = 1', 'python'), two)).toBe(false);
	});
});

describe('versionLabel', () => {
	it('calls the first version the original and numbers the rest', () => {
		const entry = { id: 'a', version: 1, size: 1, created_at: null, name: 'a' };
		expect(versionLabel(entry, 0)).toBe('Version 1 (original)');
		expect(versionLabel(entry, 2)).toBe('Version 3');
	});
});
