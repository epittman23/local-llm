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
	it('keeps a highlight as <mark> (#1132)', () => {
		expect(htmlToMarkdown('<p>the <mark>key</mark> part</p>')).toBe('the <mark>key</mark> part');
	});
	it('display math is its own block, its lines kept; a lone $$ is an ordinary line (#1132)', () => {
		expect(htmlToMarkdown('<p>Before</p><p>$$<br>a \\\\ b<br>$$</p><p>After</p>')).toBe(
			'Before\n\n$$\na \\\\ b\n$$\n\nAfter'
		);
		expect(htmlToMarkdown('<p>Before</p><p>$$</p><p>After</p>')).toBe('Before\n$$\nAfter');
	});
	it('\\[...\\] and equation environments are display math too', () => {
		expect(htmlToMarkdown('<p>a</p><p>\\[<br>x^2<br>\\]</p>')).toBe('a\n\n\\[\nx^2\n\\]');
		expect(htmlToMarkdown('<p>\\begin{equation}<br>a = b<br>\\end{equation}</p><p>c</p>')).toBe(
			'\\begin{equation}\na = b\n\\end{equation}\n\nc'
		);
	});
	it('a $$ paragraph holding formatting, or more than one formula, stays an ordinary paragraph', () => {
		const md = '$$E=mc^2$$ versus the **Newtonian** [form](https://x.y) $$E=\\tfrac12 mv^2$$';
		expect(htmlToMarkdown(markdownToHtml(md))).toBe(md);
		expect(htmlToMarkdown('<p>$$a$$ is <strong>not</strong> <mark>hi</mark> $$b$$</p>')).toBe(
			'$$a$$ is **not** <mark>hi</mark> $$b$$'
		);
		expect(htmlToMarkdown('<p>$$ <a href="http://x">l</a> $$</p>')).toBe('$$ [l](http://x) $$');
		expect(htmlToMarkdown('<p>$$a$$ and $$b$$</p>')).toBe('$$a$$ and $$b$$');
	});
});

describe('markdownToHtml', () => {
	it('renders markdown', () => {
		expect(markdownToHtml('# Hi\n\n- [ ] x')).toContain('<h1>Hi</h1>');
	});
	it('task lists as TipTap taskList markup, with their ticks; other lists stay lists (#1132)', () => {
		expect(markdownToHtml('- [ ] a\n- [x] b')).toBe(
			'<ul data-type="taskList">\n<li data-type="taskItem" data-checked="false">a</li>\n<li data-type="taskItem" data-checked="true">b</li>\n</ul>\n'
		);
		expect(markdownToHtml('- a\n- [x] b')).toBe('<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n');
		expect(markdownToHtml('1. [x] a')).toBe('<ol>\n<li>a</li>\n</ol>\n');
	});
	it('math stays as written: no emphasis or escapes inside it, display lines as breaks (#1132)', () => {
		expect(markdownToHtml('*x* $a*b*c$ and $\\{a<b\\}$')).toBe('<p><em>x</em> $a*b*c$ and $\\{a&lt;b\\}$</p>\n');
		expect(markdownToHtml('$$\na \\\\ b\n$$')).toBe('<p>$$<br>a \\\\ b<br>$$</p>\n');
	});
	it('strips script and event handlers', () => {
		const html = markdownToHtml('ok <img src=x onerror="alert(1)"><script>alert(2)</script>');
		expect(html).not.toContain('onerror');
		expect(html).not.toContain('<script');
	});
});
