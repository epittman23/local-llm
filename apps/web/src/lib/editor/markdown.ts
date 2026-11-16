import { gfm } from '@joplin/turndown-plugin-gfm';
import DOMPurify from 'dompurify';
import { Marked, type Tokens } from 'marked';
import TurndownService from 'turndown';
import markedKatexExtension from '@/lib/markdown/extensions/katex-extension';

// The Markdown <-> HTML bridge behind the rich-text editor, ported from the
// Turndown setup at the top of common/RichTextInput.svelte. TipTap edits HTML;
// notes (and later the chat composer) also store Markdown, so every change is
// turned back into Markdown with these rules.

const turndown = new TurndownService({ codeBlockStyle: 'fenced', headingStyle: 'atx' });
// Markdown typed as text is kept as typed (no backslash-escaping of *, _, ...).
turndown.escape = (s: string) => s;

// TipTap wraps every line in <p>; the default rule puts a blank line around
// each one. One newline instead, so code blocks keep their own blank lines.
turndown.addRule('singleNewlineParagraphs', { filter: 'p', replacement: (content) => `\n${content}\n` });

turndown.use(gfm);

turndown.addRule('tableHeaders', { filter: 'th', replacement: (content) => content });

// GFM tables with the first row as the header (TipTap's tables have no <thead>).
turndown.addRule('tables', {
	filter: 'table',
	replacement: (content, node) => {
		const rows = Array.from((node as HTMLElement).querySelectorAll('tr'));
		if (rows.length === 0) return content;
		let md = '\n';
		rows.forEach((row, i) => {
			const cells = Array.from(row.querySelectorAll('th, td')).map((cell) =>
				turndown
					.turndown(cell.innerHTML)
					.trim()
					.replace(/^\n+|\n+$/g, '')
			);
			md += `| ${cells.join(' | ')} |\n`;
			if (i === 0) md += `| ${cells.map(() => '---').join(' | ')} |\n`;
		});
		return `${md}\n`;
	}
});

// After use(gfm), to override its checkbox rule: the task-item rule owns the marker.
turndown.addRule('taskItemCheckbox', {
	filter: (node) => node.nodeName === 'INPUT' && node.getAttribute('type') === 'checkbox',
	replacement: () => ''
});

turndown.addRule('taskListItems', {
	filter: (node) =>
		node.nodeName === 'LI' &&
		(node.getAttribute('data-checked') === 'true' || node.getAttribute('data-checked') === 'false'),
	replacement: (content, node) => {
		const checked = (node as HTMLElement).getAttribute('data-checked') === 'true';
		// 4-space continuation keeps nested lists and code fences inside the item.
		return `- [${checked ? 'x' : ' '}] ${content.trim().replace(/\n(?=.)/g, '\n    ')}\n`;
	}
});

turndown.addRule('underline', { filter: 'u', replacement: (content) => `<u>${content}</u>` });
// A highlight is stored as the HTML it came from: Markdown has no syntax for it.
turndown.addRule('highlight', { filter: 'mark', replacement: (content) => `<mark>${content}</mark>` });

// A paragraph that is display math alone (`$$...$$`, `\[...\]` or an equation
// environment, its lines as hard breaks, nothing but text inside) is a Markdown
// block of its own: blank lines around it, line breaks as written. Without the
// blank line before it, `$$` would join the paragraph above.
const DISPLAY_MATH = [
	['$$', '$$'],
	['\\[', '\\]'],
	['\\begin{equation}', '\\end{equation}']
];
/** The formula, when a paragraph's whole text is one display-math block; else null. */
export function displayMath(text: string): string | null {
	const t = text.trim();
	for (const [open, close] of DISPLAY_MATH) {
		const inner = t.slice(open.length, -close.length);
		if (t.length > open.length + close.length && t.startsWith(open) && t.endsWith(close) && !inner.includes(close))
			return inner;
	}
	return null;
}
turndown.addRule('displayMath', {
	filter: (node) =>
		node.nodeName === 'P' &&
		Array.from(node.childNodes).every((c) => c.nodeType === 3 || c.nodeName === 'BR') &&
		displayMath(node.textContent ?? '') !== null,
	replacement: (_content, node) =>
		`\n\n${Array.from(node.childNodes, (c) => (c.nodeName === 'BR' ? '\n' : c.textContent))
			.join('')
			.trim()}\n\n`
});

/**
 * The editor's HTML as Markdown. An empty paragraph is a line break, and runs
 * of spaces survive (Turndown would otherwise collapse them).
 */
export function htmlToMarkdown(html: string): string {
	return turndown
		.turndown(html.replace(/<p><\/p>/g, '<br/>').replace(/ {2,}/g, (m) => m.replace(/ /g, ' ')))
		.replace(/ /g, ' ')
		.trim();
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The editor's own Marked instance (the global `marked` serves other pages).
// The editor has no math nodes, so math is kept as the text it was written as:
// the chat's math tokenizers only stop emphasis and backslash escapes from
// rewriting it. A `$$` block after a blank line is a paragraph with its lines
// as hard breaks; the block tokenizer goes in without its `start`, which cut
// paragraphs at any `\b...` (`$\beta$`) and put a line break, so a space,
// into the math. Task lists come out as TipTap's own taskList markup.
const [inlineKatex, blockKatex] = markedKatexExtension().extensions;
const editorMarked = new Marked({
	extensions: [
		{ ...inlineKatex, renderer: (token) => escapeHtml(token.raw) },
		{
			name: blockKatex.name,
			level: 'block' as const,
			tokenizer: blockKatex.tokenizer,
			renderer: (token) => `<p>${escapeHtml(token.raw.trim()).replaceAll('\n', '<br>')}</p>\n`
		}
	],
	renderer: {
		checkbox: () => '',
		list(token: Tokens.List) {
			if (token.ordered || !token.items.every((item) => item.task)) return false;
			const items = token.items.map(
				(item) =>
					`<li data-type="taskItem" data-checked="${item.checked === true}">${this.parser.parse(item.tokens)}</li>\n`
			);
			return `<ul data-type="taskList">\n${items.join('')}</ul>\n`;
		}
	}
});

/**
 * Markdown as sanitized HTML, for loading into the editor. Sanitized because
 * the Markdown may come from anywhere (an imported file, a note shared by
 * someone else, a model's output) and `marked` passes raw HTML through.
 */
export function markdownToHtml(md: string): string {
	return DOMPurify.sanitize(
		editorMarked.parse(md.replaceAll('\n<br/>', '<br/>'), { breaks: false, async: false }) as string
	);
}
