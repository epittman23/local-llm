// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CodeSurface, TAB_HELP } from './CodeSurface';

function Editor({ initial, language = 'python', onSave }: { initial: string; language?: string; onSave?: () => void }) {
	const [code, setCode] = useState(initial);
	return <CodeSurface code={code} language={language} edit={{ label: 'Edit it', onChange: setCode, onSave }} />;
}

const box = () => screen.getByRole('textbox', { name: 'Edit it' }) as HTMLTextAreaElement;
const type = (value: string) => fireEvent.change(box(), { target: { value } });
/** Whether the key press was left to the browser (not prevented). */
const pass = (init: KeyboardEventInit) => fireEvent.keyDown(box(), init);

describe('CodeSurface', () => {
	it('shows a textarea holding the code over an aria-hidden highlighted pre', () => {
		const { container } = render(<Editor initial="x = 1" />);
		expect(box().value).toBe('x = 1');
		expect(container.querySelector('pre')?.getAttribute('aria-hidden')).toBe('true');
		expect(container.querySelector('pre .hljs-number')?.textContent).toBe('1');
	});

	it('gives the textarea and the pre one face, size and line height from the shared container', () => {
		const { container } = render(<Editor initial="x" />);
		const wrapper = container.querySelector('.text-dense') as HTMLElement;
		expect(wrapper.className).toContain('font-mono');
		expect(wrapper.className).toContain('leading-relaxed');
		expect(wrapper.contains(box())).toBe(true);
		expect(wrapper.contains(container.querySelector('pre'))).toBe(true);
		expect(box().className).not.toMatch(/font-|text-/);
	});

	it('names the Tab help with aria-describedby', () => {
		render(<Editor initial="x" />);
		const id = box().getAttribute('aria-describedby') ?? '';
		expect(document.getElementById(id)?.textContent).toBe(TAB_HELP);
	});

	it('leaves Tab to the browser until something has been typed', () => {
		render(<Editor initial="x" />);
		expect(pass({ key: 'Tab' })).toBe(true);
		expect(box().value).toBe('x');
	});

	it('indents at the caret after typing', () => {
		render(<Editor initial="" />);
		type('ab');
		box().setSelectionRange(1, 1);
		expect(pass({ key: 'Tab' })).toBe(false);
		expect(box().value).toBe('a  b');
	});

	it('indents every line of a multi-line selection, and Shift+Tab outdents them', () => {
		render(<Editor initial="" />);
		type('a\nb\nc');
		box().setSelectionRange(0, 3);
		pass({ key: 'Tab' });
		expect(box().value).toBe('  a\n  b\nc');
		pass({ key: 'Tab', shiftKey: true });
		expect(box().value).toBe('a\nb\nc');
	});

	it('outdents the caret line with Shift+Tab', () => {
		render(<Editor initial="" />);
		type('    x');
		box().setSelectionRange(5, 5);
		pass({ key: 'Tab', shiftKey: true });
		expect(box().value).toBe('  x');
		expect(box().selectionStart).toBe(3);
	});

	it('leaves Tab to the browser after Escape', () => {
		render(<Editor initial="" />);
		type('a');
		expect(pass({ key: 'Escape' })).toBe(false);
		expect(pass({ key: 'Tab' })).toBe(true);
	});

	it('takes Escape before a listener on a parent sees it, so a panel around it does not close, and says so on the textarea', () => {
		const { container } = render(<Editor initial="" />);
		const seen: boolean[] = [];
		container.addEventListener('keydown', (e) => seen.push(e.defaultPrevented));
		fireEvent.keyDown(box(), { key: 'Escape' });
		expect(seen).toEqual([false]);
		expect(box().hasAttribute('data-escape-kept')).toBe(false);
		type('a');
		expect(box().hasAttribute('data-escape-kept')).toBe(true);
		fireEvent.keyDown(box(), { key: 'Escape' });
		expect(seen).toEqual([false, true]);
		expect(box().hasAttribute('data-escape-kept')).toBe(false);
	});

	it('indents with a tab for go', () => {
		render(<Editor initial="" language="go" />);
		type('x');
		box().setSelectionRange(0, 0);
		pass({ key: 'Tab' });
		expect(box().value).toBe('\tx');
	});

	it('saves on Ctrl+S and on Cmd+S, and keeps the browser from saving the page', () => {
		const onSave = vi.fn();
		render(<Editor initial="x" onSave={onSave} />);
		expect(pass({ key: 's', ctrlKey: true })).toBe(false);
		expect(pass({ key: 's', metaKey: true })).toBe(false);
		expect(onSave).toHaveBeenCalledTimes(2);
	});

	it('keeps a last blank line after a trailing newline', () => {
		const { container } = render(<Editor initial={'a\n'} />);
		expect(container.querySelector('pre code')?.textContent).toBe('a\n ');
	});

	it('draws no per-token spans for plaintext, which is what a very long document is shown as', () => {
		const { container } = render(<CodeSurface code={'x = 1\n'.repeat(5)} language="plaintext" />);
		expect(container.querySelectorAll('pre span')).toHaveLength(0);
	});

	it('highlights latex, which the common set lacks', () => {
		const { container } = render(<CodeSurface code={'\\section{Intro}'} language="latex" />);
		expect(container.querySelectorAll('pre span').length).toBeGreaterThan(0);
	});

	it('has no textarea when not editing', () => {
		render(<CodeSurface code="x" language="python" />);
		expect(screen.queryByRole('textbox')).toBeNull();
	});
});
