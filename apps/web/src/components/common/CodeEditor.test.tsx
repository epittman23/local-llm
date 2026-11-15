import { act, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CodeEditor from './CodeEditor';

vi.mock('@/lib/apis/utils', () => ({ formatPythonCode: vi.fn() }));

/** Every CSS rule CodeMirror's style modules mounted, as text. */
function mountedCss(): string {
	const sheets = [...document.adoptedStyleSheets, ...document.styleSheets];
	return sheets
		.flatMap((sheet) => {
			try {
				return [...sheet.cssRules].map((rule) => rule.cssText);
			} catch {
				return [];
			}
		})
		.concat([...document.querySelectorAll('style')].map((style) => style.textContent ?? ''))
		.join('\n');
}

afterEach(() => document.documentElement.classList.remove('dark'));

describe('CodeEditor (CNT-2)', () => {
	it('mounts with the standard’s token theme, not a fixed palette', async () => {
		const { container } = render(<CodeEditor value="def f(x):\n    return x  # note" lang="python" />);
		await waitFor(() => expect(container.querySelector('.cm-editor')).not.toBeNull());
		const css = mountedCss();
		expect(css).toContain('var(--surface-1)');
		expect(css).toContain('var(--foreground-muted)');
		expect(css).toContain('var(--font-code)');
		expect(css).toContain('var(--series-3)');
		// One Dark's blue-grey background is gone.
		expect(css).not.toContain('#282c34');
	});

	it('fills its host and scrolls inside it instead of growing to its content', async () => {
		const { container } = render(<CodeEditor value={'x = 1\n'.repeat(200)} />);
		await waitFor(() => expect(container.querySelector('.cm-editor')).not.toBeNull());
		const rules = mountedCss()
			.split('\n')
			.filter((rule) => /\.cm-scroller|height/.test(rule));
		expect(rules.some((rule) => /height: 100%/.test(rule))).toBe(true);
		expect(rules.some((rule) => /\.cm-scroller[^{]*\{[^}]*overflow: auto/.test(rule))).toBe(true);
	});

	it('switches CodeMirror’s own light and dark base styles with the page', async () => {
		const { container } = render(<CodeEditor value="x = 1" />);
		const editor = await waitFor(() => {
			const el = container.querySelector<HTMLElement>('.cm-editor');
			expect(el).not.toBeNull();
			return el as HTMLElement;
		});
		const light = editor.className;
		await act(async () => {
			document.documentElement.classList.add('dark');
		});
		await waitFor(() => expect(editor.className).not.toBe(light));
		await act(async () => {
			document.documentElement.classList.remove('dark');
		});
		await waitFor(() => expect(editor.className).toBe(light));
	});
});
