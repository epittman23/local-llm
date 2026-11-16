import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import markedKatexExtension, { isMathBoundary } from '@/lib/markdown/extensions/katex-extension';
import { displayMath } from './markdown';

/**
 * CNT-3 in the note editor (#935): math written in a note is shown typeset,
 * and stays the text it was written as. The document never holds a math node:
 * the formula's source is hidden under a rendering of it (a decoration), and
 * comes back as text while the caret is in it or beside it. So nothing is
 * converted on load (no save on open, #1132), notes saved before this render
 * too, and the Markdown and HTML a note stores are exactly what they were.
 * The delimiters are the chat's: `$…$`, `$$…$$`, `\(…\)`, `\[…\]` and an
 * equation environment, with the chat's rule that `$5 and $10` is no formula.
 */

/** A formula in a line of text: where its source starts and ends, and what to typeset. */
export type MathSpan = { start: number; end: number; latex: string; display: boolean };

const [inlineKatex] = markedKatexExtension().extensions as {
	start: (src: string) => number | undefined;
	tokenizer: (src: string, tokens: unknown[]) => { raw: string; text?: string; displayMode: boolean } | undefined;
}[];

/** The formulas written inline in `text`, as the chat's tokenizer finds them. */
export function findInlineMath(text: string): MathSpan[] {
	const found: MathSpan[] = [];
	let offset = 0;
	while (offset < text.length) {
		const next = inlineKatex.start(text.slice(offset));
		if (next === undefined || next < 0) break;
		const at = offset + next;
		const token = at > 0 && !isMathBoundary(text[at - 1]) ? undefined : inlineKatex.tokenizer(text.slice(at), []);
		if (token?.raw && token.text?.trim()) {
			found.push({ start: at, end: at + token.raw.length, latex: token.text, display: token.displayMode });
			offset = at + token.raw.length;
		} else offset = at + 1;
	}
	return found;
}

/** A formula in the document, by position; `block` when it is a whole paragraph. */
type MathRange = { from: number; to: number; latex: string; display: boolean; block?: { pos: number; end: number } };

// A hard break counts as the newline it was written as; any other inline leaf (an image) as one character.
const leafText = (leaf: PMNode) => (leaf.type.name === 'hardBreak' ? '\n' : '￼');

export function mathRanges(doc: PMNode): MathRange[] {
	const ranges: MathRange[] = [];
	doc.descendants((node, pos) => {
		if (!node.isTextblock) return true;
		if (node.type.spec.code) return false;
		const text = node.textBetween(0, node.content.size, undefined, leafText);
		// Inline code is code: its characters stand for themselves, so it never holds a formula.
		const code: [number, number][] = [];
		node.forEach((child, offset) => {
			if (child.marks.some((m) => m.type.spec.code)) code.push([offset, offset + child.nodeSize]);
		});
		const base = pos + 1;
		let plain = true;
		node.forEach((child) => {
			plain &&= child.isText || child.type.name === 'hardBreak';
		});
		const block = node.type.name === 'paragraph' && plain ? displayMath(text) : null;
		if (block !== null)
			ranges.push({
				from: base,
				to: base + node.content.size,
				latex: block,
				display: true,
				block: { pos, end: pos + node.nodeSize }
			});
		else
			for (const m of findInlineMath(text))
				if (!code.some(([a, b]) => m.start < b && m.end > a))
					ranges.push({ from: base + m.start, to: base + m.end, latex: m.latex, display: m.display });
		return false;
	});
	return ranges;
}

function typeset(latex: string, display: boolean, onPick: (() => void) | null): HTMLElement {
	const el = document.createElement('span');
	el.className = display ? 'math-render math-render-display scroll-region' : 'math-render';
	el.contentEditable = 'false';
	el.innerHTML = katex.renderToString(latex, {
		displayMode: display,
		throwOnError: false,
		output: 'htmlAndMathml',
		trust: false
	});
	if (onPick) {
		// A click puts the caret in the formula, which shows its source to edit.
		el.addEventListener('mousedown', (e) => {
			e.preventDefault();
			onPick();
		});
	}
	return el;
}

const key = new PluginKey<MathRange[]>('mathPreview');

/** Decorations for every formula the selection does not touch (all of them with no selection to show). */
export function mathDecorations(
	doc: PMNode,
	ranges: MathRange[],
	selection: { from: number; to: number } | null
): DecorationSet {
	const decorations: Decoration[] = [];
	for (const r of ranges) {
		if (selection && selection.from <= r.to && selection.to >= r.from) continue;
		const pick = (view: EditorView) => () => {
			view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, r.from + 1)));
			view.focus();
		};
		if (r.block) decorations.push(Decoration.node(r.block.pos, r.block.end, { class: 'math-block' }));
		decorations.push(Decoration.inline(r.from, r.to, { class: 'math-source' }));
		decorations.push(
			Decoration.widget(r.from, (view) => typeset(r.latex, r.display, view.editable ? pick(view) : null), {
				side: -1,
				ignoreSelection: true,
				key: `${r.display ? 'd' : 'i'}:${r.latex}`
			})
		);
	}
	return DecorationSet.create(doc, decorations);
}

export const MathPreview = Extension.create({
	name: 'mathPreview',
	addProseMirrorPlugins() {
		const editor = this.editor;
		return [
			new Plugin<MathRange[]>({
				key,
				state: {
					init: (_, state) => mathRanges(state.doc),
					apply: (tr, ranges) => (tr.docChanged ? mathRanges(tr.doc) : ranges)
				},
				props: {
					decorations(state) {
						const ranges = key.getState(state) ?? [];
						if (ranges.length === 0) return DecorationSet.empty;
						// The caret shows a formula's source only while someone is typing here: a note opens with every formula typeset.
						return mathDecorations(state.doc, ranges, editor.isEditable && editor.isFocused ? state.selection : null);
					}
				}
			})
		];
	}
});
