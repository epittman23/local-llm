// @vitest-environment jsdom
// jsdom, not the suite's happy-dom: DOMPurify misbehaves under happy-dom (it
// drops <h1> and keeps onerror), so a sanitizer test there proves nothing.
import { describe, expect, it } from 'vitest';
import { htmlToMarkdown, markdownToHtml } from './markdown';

describe('htmlToMarkdown', () => {
	it('headings and emphasis; one newline between paragraphs (as the Svelte editor writes them)', () => {
		expect(htmlToMarkdown('<h2>Plan</h2><p>First <strong>bold</strong></p><p>Second</p>')).toBe(
			'## Plan\n\nFirst **bold**\nSecond'
		);
	});
	it('keeps typed markdown characters unescaped and runs of spaces', () => {
		expect(htmlToMarkdown('<p>a_b *c*  d</p>')).toBe('a_b *c*  d');
	});
	it('task lists, with nesting', () => {
		const html =
			'<ul data-type="taskList"><li data-checked="true"><label><input type="checkbox" checked></label><div><p>done</p></div></li><li data-checked="false"><label><input type="checkbox"></label><div><p>todo</p></div></li></ul>';
		expect(htmlToMarkdown(html)).toBe('- [x] done\n- [ ] todo');
	});
	it('tables use the first row as the header', () => {
		expect(
			htmlToMarkdown(
				'<table><tbody><tr><th><p>A</p></th><th><p>B</p></th></tr><tr><td><p>1</p></td><td><p>2</p></td></tr></tbody></table>'
			)
		).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |');
	});
	it('fenced code keeps its blank lines', () => {
		expect(htmlToMarkdown('<pre><code>a\n\nb</code></pre>')).toBe('```\na\n\nb\n```');
	});
});

describe('markdownToHtml', () => {
	it('renders markdown', () => {
		expect(markdownToHtml('# Hi\n\n- [ ] x')).toContain('<h1>Hi</h1>');
	});
	it('strips script and event handlers', () => {
		const html = markdownToHtml('ok <img src=x onerror="alert(1)"><script>alert(2)</script>');
		expect(html).not.toContain('onerror');
		expect(html).not.toContain('<script');
	});
});
