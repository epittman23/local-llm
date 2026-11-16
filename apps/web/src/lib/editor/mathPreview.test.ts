// @vitest-environment jsdom
// jsdom, as markdown.test.ts: loading the Markdown sanitizes with DOMPurify.
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { markdownToHtml } from './markdown';
import { findInlineMath, MathPreview, mathRanges } from './mathPreview';

const editors: Editor[] = [];
afterEach(() => {
	for (const e of editors.splice(0)) e.destroy();
});

function editorWith(md: string, editable = true) {
	const element = document.createElement('div');
	document.body.append(element);
	const editor = new Editor({
		element,
		editable,
		extensions: [StarterKit, MathPreview],
		content: markdownToHtml(md)
	});
	editors.push(editor);
	return editor;
}

const sources = (e: Editor) => [...e.view.dom.querySelectorAll('.math-source')].map((s) => s.textContent);
const rendered = (e: Editor) => e.view.dom.querySelectorAll('.math-render .katex').length;

describe('findInlineMath', () => {
	it('finds the chat’s inline delimiters, and leaves prices and words alone', () => {
		expect(findInlineMath('The mean $\\mu$ and \\(x^2\\) here')).toEqual([
			{ start: 9, end: 14, latex: '\\mu', display: false },
			{ start: 19, end: 26, latex: 'x^2', display: false }
		]);
		expect(findInlineMath('It costs $5 and $10 today')).toEqual([]);
		expect(findInlineMath('a$x$')).toEqual([]);
		expect(findInlineMath('inline $$a+b$$ display')).toEqual([{ start: 7, end: 14, latex: 'a+b', display: true }]);
		expect(findInlineMath('no math')).toEqual([]);
	});
});

describe('MathPreview', () => {
	it('typesets every formula of an opened note, and keeps the text as written', () => {
		const md = 'Posterior $p(\\theta|x)$ here.\n\n$$\n\\int_0^1 x\\,dx\n$$';
		const editor = editorWith(md);
		expect(rendered(editor)).toBe(2);
		// The source is hidden text node by text node: a display block's lines are separate nodes.
		expect(sources(editor).join('')).toBe('$p(\\theta|x)$$$\\int_0^1 x\\,dx$$');
		expect(editor.view.dom.querySelector('.math-block')).not.toBeNull();
		// The document holds the source, not a math node.
		expect(editor.getText()).toContain('$p(\\theta|x)$');
		expect(mathRanges(editor.state.doc).map((r) => [r.latex.trim(), r.display])).toEqual([
			['p(\\theta|x)', false],
			['\\int_0^1 x\\,dx', true]
		]);
	});

	it('shows a formula’s source while the caret is in it, and only while the editor has focus', () => {
		const editor = editorWith('See $\\alpha$ now');
		const [range] = mathRanges(editor.state.doc);
		editor.commands.setTextSelection(range.from + 1);
		// Not focused: still typeset.
		expect(rendered(editor)).toBe(1);
		editor.isFocused = true;
		editor.commands.setTextSelection(range.from + 1);
		expect(rendered(editor)).toBe(0);
		editor.commands.setTextSelection(1);
		expect(rendered(editor)).toBe(1);
	});

	it('a click on a formula puts the caret in it', () => {
		const editor = editorWith('See $\\alpha$ now');
		const [range] = mathRanges(editor.state.doc);
		const math = editor.view.dom.querySelector('.math-render') as HTMLElement;
		math.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
		expect(editor.state.selection.from).toBe(range.from + 1);
	});

	it('a read-only note is typeset wherever the selection is, and a click does nothing', () => {
		const editor = editorWith('See $\\alpha$ now', false);
		editor.isFocused = true;
		editor.commands.setTextSelection(6);
		expect(rendered(editor)).toBe(1);
		const before = editor.state.selection.from;
		// Not bubbling: ProseMirror's own mousedown handler needs layout jsdom lacks.
		(editor.view.dom.querySelector('.math-render') as HTMLElement).dispatchEvent(
			new MouseEvent('mousedown', { cancelable: true })
		);
		expect(editor.state.selection.from).toBe(before);
	});

	it('typing a formula typesets it, and code is never math', () => {
		const editor = editorWith('```\n$x$\n```\n\nInline `$y$` too.');
		expect(rendered(editor)).toBe(0);
		editor.commands.insertContentAt(editor.state.doc.content.size, '<p>Then $y$.</p>');
		expect(rendered(editor)).toBe(1);
	});
});
