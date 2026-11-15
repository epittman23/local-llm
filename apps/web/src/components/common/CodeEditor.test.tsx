import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { EditorView } from 'codemirror';
import { createRef, type ReactElement } from 'react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatPythonCode } from '@/lib/apis/utils';
import { useAuthStore } from '@/lib/stores/authStore';
import { CONTRAST_RULES } from '@/lib/ui/contrast';
import CodeEditor, { type CodeEditorHandle, PARSE_ERROR_GUTTER, parseBlackError } from './CodeEditor';

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

describe('CodeEditor as a field (#987, #910)', () => {
	const mount = async (ui: ReactElement) => {
		const { container } = render(ui);
		return waitFor(() => {
			const content = container.querySelector<HTMLElement>('.cm-content');
			expect(content).not.toBeNull();
			return { container, content: content as HTMLElement };
		});
	};

	it('names its editable content and ties it to the caller’s help line', async () => {
		const { content } = await mount(<CodeEditor value="x = 1" ariaLabel="Tool code" describedBy="help" />);
		expect(content).toHaveAttribute('aria-label', 'Tool code');
		expect(content).toHaveAttribute('aria-describedby', 'help');
		// Focusable for checkers, without a second Tab stop: it is the contenteditable itself.
		expect(content).toHaveAttribute('tabindex', '0');
	});

	it('shows the placeholder it is given, or none', async () => {
		const first = await mount(<CodeEditor placeholder="def run(): ..." />);
		expect(first.container.querySelector('.cm-placeholder')).toHaveTextContent('def run(): ...');
		const second = await mount(<CodeEditor placeholder="" />);
		expect(second.container.querySelector('.cm-placeholder')).toBeNull();
	});

	it('saves on Ctrl+S only while the editor has focus, not from anywhere on the page', async () => {
		const onSave = vi.fn();
		const { content } = await mount(<CodeEditor value="x = 1" onSave={onSave} />);
		fireEvent.keyDown(document.body, { key: 's', ctrlKey: true });
		expect(onSave).not.toHaveBeenCalled();
		fireEvent.keyDown(content, { key: 's', code: 'KeyS', keyCode: 83, ctrlKey: true });
		expect(onSave).toHaveBeenCalledTimes(1);
	});
});

describe('CodeEditor parse errors (#1015)', () => {
	const black = 'cannot parse: 2:7\n    x = (\n       ^\nParseError: bad input';

	it('reads Black’s line and column, and nothing else as a parse error', () => {
		expect(parseBlackError(black)).toEqual({ line: 2, column: 7, detail: black });
		expect(parseBlackError('Cannot parse for target version Python 3.13: 4:1: x')).toMatchObject({
			line: 4,
			column: 1
		});
		expect(parseBlackError('Network error')).toBeNull();
		expect(parseBlackError(undefined)).toBeNull();
	});

	it('returns a parse error instead of toasting it, marks the line, and clears it on the next edit', async () => {
		useAuthStore.setState({ token: 't', user: { role: 'admin' } } as never);
		vi.mocked(formatPythonCode).mockRejectedValue(black);
		const error = vi.spyOn(toast, 'error');
		const onParseError = vi.fn();
		const ref = createRef<CodeEditorHandle>();
		const { container } = render(<CodeEditor ref={ref} value={'a = 1\nx = (\n'} onParseError={onParseError} />);
		const content = await waitFor(() => container.querySelector('.cm-content') as HTMLElement);

		let outcome: string | undefined;
		await act(async () => {
			outcome = await ref.current?.formatPython();
		});
		expect(outcome).toBe('invalid');
		expect(onParseError).toHaveBeenLastCalledWith({ line: 2, column: 7, detail: black });
		expect(error).not.toHaveBeenCalled();
		expect(container.querySelectorAll('.cm-parse-error')).toHaveLength(1);
		expect(container.querySelector('.cm-parse-error')).toHaveTextContent('x = (');
		expect(container.querySelector('.cm-parse-error-gutter')).toHaveTextContent('2');
		expect(content).toHaveAttribute('aria-invalid', 'true');

		const view = EditorView.findFromDOM(content);
		act(() => view?.dispatch({ changes: { from: 0, insert: '#' } }));
		expect(container.querySelector('.cm-parse-error')).toBeNull();
		expect(content).not.toHaveAttribute('aria-invalid');
		expect(onParseError).toHaveBeenLastCalledWith(null);
	});

	it('formats valid code, and saves code it could not format as it is', async () => {
		useAuthStore.setState({ token: 't', user: { role: 'admin' } } as never);
		vi.mocked(formatPythonCode).mockResolvedValue({ code: 'x = 1\n' });
		const onChange = vi.fn();
		const ref = createRef<CodeEditorHandle>();
		const { container } = render(<CodeEditor ref={ref} value="x=1" onChange={onChange} />);
		await waitFor(() => expect(container.querySelector('.cm-content')).not.toBeNull());
		await act(async () => expect(await ref.current?.formatPython()).toBe('formatted'));
		expect(onChange).toHaveBeenLastCalledWith('x = 1\n');

		vi.mocked(formatPythonCode).mockRejectedValue('Server unreachable');
		await act(async () => expect(await ref.current?.formatPython()).toBe('unformatted'));
		useAuthStore.setState({ token: 't', user: { role: 'user' } } as never);
	});
});

describe('the parse error mark (COL-2)', () => {
	it('draws the line number in a token pair the contrast test holds at 4.5:1', () => {
		const rule = CONTRAST_RULES.find(
			(r) =>
				`var(${r.foreground})` === PARSE_ERROR_GUTTER.color &&
				`var(${r.background})` === PARSE_ERROR_GUTTER.backgroundColor
		);
		expect(rule?.minimum).toBeGreaterThanOrEqual(4.5);
	});
});
