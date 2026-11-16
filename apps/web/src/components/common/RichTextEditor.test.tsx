// @vitest-environment jsdom
// jsdom, as lib/editor/markdown.test.ts: the Markdown -> HTML step sanitizes
// with DOMPurify, which misbehaves under happy-dom.

import { act, render, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { describe, expect, it, vi } from 'vitest';
import { htmlToMarkdown } from '@/lib/editor/markdown';
import { contentFromMarkdown, editorContent } from '@/routes/notes/notesModel';
import { RichTextEditor } from './RichTextEditor';

// A note with everything the editor used to lose on the way back to Markdown
// (#1132): a highlight, inline math, display math after a blank line, and a
// task list with a checked and an unchecked item.
const NOTE = [
	'# Diagnostics',
	'',
	'$(\\beta_0 + \\beta_1 x)$ is the line; $\\beta$ and $\\frac{1}{\\bar x}$ follow. The posterior is $p(\\theta|x) \\propto p(x|\\theta)p(\\theta)$, and the <mark>highlighted</mark> part is the prior.',
	'',
	'$$\\int_0^1 \\theta^{a-1}(1-\\theta)^{b-1} d\\theta$$',
	'',
	'$$',
	'\\hat\\beta = (X^TX)^{-1}X^Ty \\\\ a*b*c',
	'$$',
	'',
	'\\[',
	'x^2 + y^2',
	'\\]',
	'',
	'\\begin{equation}',
	'a = b',
	'\\end{equation}',
	'',
	'- [ ] residual plot',
	'- [x] QQ plot'
].join('\n');

async function mount(content: unknown, editable = true) {
	const onChange = vi.fn();
	let editor: Editor | undefined;
	const view = render(
		<RichTextEditor
			content={content}
			contentKey="n1"
			editable={editable}
			onChange={onChange}
			onReady={(e) => (editor = e)}
		/>
	);
	await waitFor(() => expect(editor).toBeDefined());
	return { onChange, editor: editor as Editor, view };
}

describe('RichTextEditor', () => {
	it('reports nothing when a note is opened, or made read-only and editable again (#1132)', async () => {
		const table = '\n\n| arm | conv |\n|---|---|\n| A | 0.12 |';
		const { onChange, editor, view } = await mount(editorContent({ md: NOTE + table }));
		const rerender = (editable: boolean) =>
			view.rerender(<RichTextEditor content={null} contentKey="n1" editable={editable} onChange={onChange} />);
		// TipTap's own update event, under RichTextEditor's edits-only filter: making the editor
		// read-only and editable again must not announce an update at all.
		const updates = vi.fn();
		editor.on('update', updates);
		rerender(false);
		expect(editor.isEditable).toBe(false);
		rerender(true);
		expect(editor.isEditable).toBe(true);
		expect(updates).not.toHaveBeenCalled();
		// The first click into it: TipTap appends a trailing paragraph after the table, which is no edit either.
		const before = editor.state.doc.childCount;
		act(() => {
			editor.commands.setTextSelection(1);
		});
		expect(editor.state.doc.childCount).toBe(before + 1);
		expect(onChange).not.toHaveBeenCalled();

		// An edit is still reported, as Markdown.
		act(() => {
			editor.commands.insertContentAt(editor.state.doc.content.size, '<p>done</p>');
		});
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange.mock.calls[0][0].md).toContain('done');
	});

	it('round-trips a note through the editor byte for byte: highlight, math and task ticks', async () => {
		const { editor } = await mount(editorContent({ md: NOTE }));
		expect(editor.getJSON().content?.some((n) => n.type === 'taskList')).toBe(true);
		expect(htmlToMarkdown(editor.getHTML())).toBe(NOTE);
	});

	it('keeps task lists for a note made by Import or a ?content= link', async () => {
		const md = '- [ ] residual plot\n- [x] QQ plot\n- [ ] leverage';
		const { editor } = await mount(editorContent(contentFromMarkdown(md)));
		const items = editor.$nodes('taskItem') ?? [];
		expect(items.map((i) => i.attributes.checked)).toEqual([false, true, false]);
		expect(htmlToMarkdown(editor.getHTML())).toBe(md);
	});
});
