import { gfm } from '@joplin/turndown-plugin-gfm';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import TurndownService from 'turndown';

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
			const cells = Array.from(row.querySelectorAll('th, td')).map((cell) => turndown.turndown(cell.innerHTML).trim().replace(/^\n+|\n+$/g, ''));
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
	filter: (node) => node.nodeName === 'LI' && (node.getAttribute('data-checked') === 'true' || node.getAttribute('data-checked') === 'false'),
	replacement: (content, node) => {
		const checked = (node as HTMLElement).getAttribute('data-checked') === 'true';
		// 4-space continuation keeps nested lists and code fences inside the item.
		return `- [${checked ? 'x' : ' '}] ${content.trim().replace(/\n(?=.)/g, '\n    ')}\n`;
	}
});

turndown.addRule('underline', { filter: 'u', replacement: (content) => `<u>${content}</u>` });

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

/**
 * Markdown as sanitized HTML, for loading into the editor. Sanitized because
 * the Markdown may come from anywhere (an imported file, a note shared by
 * someone else, a model's output) and `marked` passes raw HTML through.
 */
export function markdownToHtml(md: string): string {
	return DOMPurify.sanitize(marked.parse(md.replaceAll('\n<br/>', '<br/>'), { breaks: false, async: false }) as string);
}
