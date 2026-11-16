// @vitest-environment jsdom
// jsdom, as lib/editor/markdown.test.ts: the Markdown -> HTML step sanitizes
// with DOMPurify, which misbehaves under happy-dom.

import { act, fireEvent, render as renderUi, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { htmlToMarkdown } from '@/lib/editor/markdown';
import { copyToClipboard } from '@/lib/utils';
import { contentFromMarkdown, editorContent } from '@/routes/notes/notesModel';
import { codeLanguageLabel } from './RichTextCodeBlock';
import { insertFormula, RichTextEditor, toolHint } from './RichTextEditor';

vi.mock('@/lib/utils', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/utils')>()),
	copyToClipboard: vi.fn(async () => true)
}));

const render = (ui: ReactElement) => renderUi(ui, { wrapper: TooltipProvider });

// Layout jsdom lacks, which Radix's popovers and ProseMirror's caret scrolling ask for.
globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
} as unknown as typeof ResizeObserver;
const noRects = () =>
	({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Element.prototype.getClientRects ??= noRects;
Range.prototype.getClientRects ??= noRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

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
	'- [x] QQ plot',
	'',
	'```python',
	'import numpy as np',
	'```'
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

const tools = () => screen.getAllByRole('button').filter((b) => b.closest('[role="toolbar"]'));

describe('the formatting toolbar (#1038)', () => {
	it('names each tool with its shortcut, and offers link, table, highlight, H3, inline code, formula and history', async () => {
		await mount('<p>x</p>');
		const names = tools().map((b) => b.getAttribute('aria-label'));
		for (const name of ['Undo', 'Redo', 'Heading 3', 'Highlight', 'Inline code', 'Formula', 'Link', 'Table'])
			expect(names).toContain(name);
		expect(toolHint('Bold', 'Cmd+B')).toMatch(/^Bold, (Ctrl\+B|⌘B)$/);
		expect(toolHint('Formula')).toBe('Formula');
		// No native title tooltips: Tip carries the name.
		expect(tools().some((b) => b.hasAttribute('title'))).toBe(false);
	});

	it('is one tab stop; the arrow keys, Home and End move along it, and Escape goes back to the text (NAV-5)', async () => {
		const { editor } = await mount('<p>x</p>');
		const list = tools();
		expect(list.filter((b) => b.tabIndex === 0)).toEqual([list[0]]);
		list[0].focus();
		fireEvent.keyDown(list[0], { key: 'ArrowRight' });
		expect(document.activeElement).toBe(list[1]);
		await waitFor(() => expect(list[1].tabIndex).toBe(0));
		expect(list[0].tabIndex).toBe(-1);
		fireEvent.keyDown(list[1], { key: 'End' });
		expect(document.activeElement).toBe(list[list.length - 1]);
		fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' });
		expect(document.activeElement).toBe(list[0]);
		fireEvent.keyDown(list[0], { key: 'ArrowLeft' });
		expect(document.activeElement).toBe(list[list.length - 1]);
		fireEvent.keyDown(document.activeElement as Element, { key: 'Home' });
		expect(document.activeElement).toBe(list[0]);
		fireEvent.keyDown(list[0], { key: 'a' });
		expect(document.activeElement).toBe(list[0]);
		fireEvent.keyDown(list[0], { key: 'Escape' });
		await waitFor(() => expect(document.activeElement).toBe(editor.view.dom));
	});

	it('keeps Undo reachable but inert with nothing to undo, then undoes an edit', async () => {
		const { editor } = await mount('<p>x</p>');
		const undo = screen.getByRole('button', { name: 'Undo' });
		expect(undo).toHaveAttribute('aria-disabled', 'true');
		fireEvent.click(undo);
		expect(editor.getText()).toBe('x');
		act(() => {
			editor.commands.insertContentAt(editor.state.doc.content.size - 1, 'y');
		});
		await waitFor(() => expect(undo).not.toHaveAttribute('aria-disabled'));
		fireEvent.click(undo);
		expect(editor.getText()).toBe('x');
		fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
		expect(editor.getText()).toBe('xy');
	});

	it('formats the selection and marks the format as on', async () => {
		const { editor } = await mount('<p>alpha</p>');
		act(() => {
			editor.commands.setTextSelection({ from: 1, to: 6 });
		});
		for (const [name, mark] of [
			['Bold', 'bold'],
			['Italic', 'italic'],
			['Strikethrough', 'strike'],
			['Highlight', 'highlight'],
			['Inline code', 'code']
		]) {
			fireEvent.click(screen.getByRole('button', { name }));
			expect(editor.isActive(mark)).toBe(true);
			await waitFor(() => expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true'));
			fireEvent.click(screen.getByRole('button', { name }));
		}
		for (const [name, node, attrs] of [
			['Heading 1', 'heading', { level: 1 }],
			['Heading 2', 'heading', { level: 2 }],
			['Heading 3', 'heading', { level: 3 }],
			['Bullet list', 'bulletList', undefined],
			['Numbered list', 'orderedList', undefined],
			['Task list', 'taskList', undefined],
			['Quote', 'blockquote', undefined],
			['Code block', 'codeBlock', undefined]
		] as const) {
			fireEvent.click(screen.getByRole('button', { name }));
			expect(editor.isActive(node, attrs)).toBe(true);
			fireEvent.click(screen.getByRole('button', { name }));
		}
	});

	it('writes the selection, or a placeholder, as a formula with the formula selected', async () => {
		const { editor } = await mount('<p>a&lt;b</p>');
		act(() => {
			editor.commands.setTextSelection({ from: 1, to: 4 });
			insertFormula(editor);
		});
		// An inequality stays text: a string would be read as HTML, and `<b` as a tag.
		expect(editor.getText()).toBe('$a<b$');
		expect(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)).toBe('a<b');
		act(() => {
			editor.commands.setTextSelection(editor.state.doc.content.size - 1);
		});
		fireEvent.click(screen.getByRole('button', { name: 'Formula' }));
		expect(editor.getText()).toBe('$a<b$$x$');
	});

	const linkPopover = async (value: string, submit: string) => {
		fireEvent.click(screen.getByRole('button', { name: 'Link' }));
		const field = await screen.findByRole('textbox', { name: 'Link address' });
		fireEvent.change(field, { target: { value } });
		fireEvent.click(screen.getByRole('button', { name: submit }));
	};

	it('leaves Escape in the Link popover to the popover, not the text', async () => {
		const { editor } = await mount('<p>docs</p>');
		fireEvent.click(screen.getByRole('button', { name: 'Link' }));
		const field = await screen.findByRole('textbox', { name: 'Link address' });
		fireEvent.keyDown(field, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Link address' })).toBeNull());
		expect(document.activeElement).not.toBe(editor.view.dom);
	});

	it('links the selection to the address given', async () => {
		const { editor } = await mount('<p>docs</p>');
		act(() => {
			editor.commands.setTextSelection({ from: 1, to: 5 });
		});
		await linkPopover('https://example.org', 'Add link');
		expect(editor.getHTML()).toContain(
			'<a target="_blank" rel="noopener noreferrer nofollow" href="https://example.org">docs</a>'
		);
	});

	it('with no selection, writes the address as its own link', async () => {
		const { editor } = await mount('<p>see:</p>');
		act(() => {
			editor.commands.setTextSelection(5);
		});
		await linkPopover('https://example.com', 'Add link');
		expect(editor.getText()).toBe('see:https://example.com');
		expect(editor.getHTML()).toContain('href="https://example.com"');
	});

	it('opens on the link at the caret, and removes it', async () => {
		const { editor } = await mount('<p><a href="https://example.org">docs</a></p>');
		act(() => {
			editor.commands.setTextSelection(2);
		});
		await waitFor(() => expect(screen.getByRole('button', { name: 'Link' })).toHaveAttribute('aria-pressed', 'true'));
		fireEvent.click(screen.getByRole('button', { name: 'Link' }));
		expect(await screen.findByRole('textbox', { name: 'Link address' })).toHaveValue('https://example.org');
		fireEvent.click(screen.getByRole('button', { name: 'Remove link' }));
		expect(editor.getHTML()).not.toContain('href=');
	});

	it('an empty address removes the link at the caret', async () => {
		const { editor } = await mount('<p><a href="https://example.org">docs</a></p>');
		act(() => {
			editor.commands.setTextSelection(2);
		});
		await waitFor(() => expect(screen.getByRole('button', { name: 'Link' })).toHaveAttribute('aria-pressed', 'true'));
		await linkPopover(' ', 'Update link');
		expect(editor.getHTML()).not.toContain('href=');
		expect(editor.getText()).toBe('docs');
	});

	it('inserts a table, then offers its row, column and delete actions', async () => {
		const { editor } = await mount('<p>x</p>');
		fireEvent.click(screen.getByRole('button', { name: 'Table' }));
		expect(editor.isActive('table')).toBe(true);
		const count = (type: string) => {
			let n = 0;
			editor.state.doc.descendants((node) => {
				if (node.type.name === type) n++;
			});
			return n;
		};
		const rows = () => count('tableRow');
		const cols = () => {
			let n = 0;
			editor.state.doc.descendants((node) => {
				if (node.type.name === 'tableRow' && n === 0) n = node.childCount;
			});
			return n;
		};
		expect([rows(), cols()]).toEqual([3, 3]);
		const pick = async (item: string) => {
			const table = await screen.findByRole('button', { name: 'Table', pressed: true });
			fireEvent.pointerDown(table, { button: 0, ctrlKey: false, pointerType: 'mouse' });
			fireEvent.click(await screen.findByRole('menuitem', { name: item }));
		};
		await pick('Add row below');
		expect(rows()).toBe(4);
		await pick('Add column right');
		expect(cols()).toBe(4);
		await pick('Delete row');
		expect(rows()).toBe(3);
		await pick('Delete column');
		expect(cols()).toBe(3);
		await pick('Delete table');
		expect(editor.isActive('table')).toBe(false);
	});

	it('is not shown on a read-only note', async () => {
		await mount('<p>x</p>', false);
		expect(screen.queryByRole('toolbar')).toBeNull();
	});
});

describe('a code block in a note (#935)', () => {
	it('shows its language and copies its code', async () => {
		await mount(editorContent({ md: '```python\nimport numpy as np\n```' }));
		expect(await screen.findByText('python')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
		await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith('import numpy as np'));
		expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
		expect(codeLanguageLabel(null)).toBe('text');
		expect(codeLanguageLabel(' r  extra')).toBe('r');
	});
});
