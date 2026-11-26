import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HTML_POLICY_META, withHtmlPolicy } from '@/lib/chat/htmlPolicy';
import { blockDoc, docOf, output, renderWithClient } from '../testing';
import { HtmlEditView, LIVE_DELAY_MS } from './HtmlEditView';

const api = vi.hoisted(() => ({
	text: vi.fn<(token: string, id: string, max: number) => Promise<{ text: string; truncated: boolean }>>()
}));
vi.mock('@/lib/apis/sandbox', () => ({ getSandboxOutputHtml: vi.fn(), getSandboxOutputText: api.text }));

const START = '<p>one</p>';

function Harness({ doc, mode = 'source' }: { doc: ReturnType<typeof blockDoc>; mode?: 'preview' | 'source' }) {
	const [draft, setDraft] = useState(START);
	return (
		<HtmlEditView doc={doc} mode={mode} edit={{ draft, setDraft, inputRef: { current: null }, onSave: vi.fn() }} />
	);
}

const frame = () => screen.getByTitle(/^Preview of /) as HTMLIFrameElement;
const editor = () => screen.getByRole('textbox') as HTMLTextAreaElement;
const type = (value: string) => fireEvent.change(editor(), { target: { value } });

beforeEach(() => api.text.mockReset());
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe('HtmlEditView', () => {
	it('shows the starting text in the frame, and the draft only after Update preview', () => {
		renderWithClient(<Harness doc={blockDoc(START)} />);
		expect(frame().getAttribute('srcdoc')).toBe(withHtmlPolicy(START));
		type('<p>two</p>');
		expect(frame().getAttribute('srcdoc')).toBe(withHtmlPolicy(START));
		fireEvent.click(screen.getByRole('button', { name: 'Update preview' }));
		expect(frame().getAttribute('srcdoc')).toBe(withHtmlPolicy('<p>two</p>'));
		expect(frame().getAttribute('srcdoc')?.startsWith(HTML_POLICY_META)).toBe(true);
	});

	it('says Out of date while the draft differs from the frame, and stops once it is updated or typed back', () => {
		renderWithClient(<Harness doc={blockDoc(START)} />);
		expect(screen.queryByText('Out of date')).toBeNull();
		type('<p>two</p>');
		expect(screen.getByText('Out of date')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Update preview' }));
		expect(screen.queryByText('Out of date')).toBeNull();
		type('<p>three</p>');
		expect(screen.getByText('Out of date')).toBeInTheDocument();
		type('<p>two</p>');
		expect(screen.queryByText('Out of date')).toBeNull();
	});

	it('updates on Ctrl+Enter and on Cmd+Enter in the editor, without typing a newline', () => {
		renderWithClient(<Harness doc={blockDoc(START)} />);
		type('<p>two</p>');
		const ctrl = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true });
		act(() => {
			editor().dispatchEvent(ctrl);
		});
		expect(ctrl.defaultPrevented).toBe(true);
		expect(frame().getAttribute('srcdoc')).toBe(withHtmlPolicy('<p>two</p>'));
		type('<p>three</p>');
		fireEvent.keyDown(editor(), { key: 'Enter', metaKey: true });
		expect(frame().getAttribute('srcdoc')).toBe(withHtmlPolicy('<p>three</p>'));
		type('<p>four</p>');
		fireEvent.keyDown(editor(), { key: 'Enter' });
		expect(frame().getAttribute('srcdoc')).toBe(withHtmlPolicy('<p>three</p>'));
	});

	it('does not update as you type unless that is switched on, and then waits 800 ms after the last keystroke', () => {
		vi.useFakeTimers();
		renderWithClient(<Harness doc={blockDoc(START)} />);
		const toggle = screen.getByRole('switch', { name: 'Update as I type' });
		expect(toggle).toHaveAttribute('aria-checked', 'false');
		type('<p>two</p>');
		act(() => {
			vi.advanceTimersByTime(LIVE_DELAY_MS * 3);
		});
		expect(frame().getAttribute('srcdoc')).toBe(withHtmlPolicy(START));
		fireEvent.click(toggle);
		expect(toggle).toHaveAttribute('aria-checked', 'true');
		act(() => {
			vi.advanceTimersByTime(LIVE_DELAY_MS - 1);
		});
		type('<p>three</p>');
		act(() => {
			vi.advanceTimersByTime(LIVE_DELAY_MS - 1);
		});
		expect(frame().getAttribute('srcdoc')).toBe(withHtmlPolicy(START));
		act(() => {
			vi.advanceTimersByTime(1);
		});
		expect(frame().getAttribute('srcdoc')).toBe(withHtmlPolicy('<p>three</p>'));
		expect(screen.queryByText('Out of date')).toBeNull();
	});

	it('frames the draft sandboxed to allow-scripts alone, through srcdoc, never src', () => {
		renderWithClient(<Harness doc={blockDoc(START)} />);
		const sandbox = frame().getAttribute('sandbox');
		expect(sandbox).toBe('allow-scripts');
		for (const flag of ['allow-same-origin', 'allow-forms', 'allow-modals', 'allow-popups', 'allow-top-navigation'])
			expect(sandbox).not.toContain(flag);
		expect(frame().getAttribute('src')).toBeNull();
		expect(frame().getAttribute('referrerpolicy')).toBe('no-referrer');
	});

	it('never puts a draft script into the app’s DOM: it is only inside the frame’s srcdoc attribute', () => {
		renderWithClient(<Harness doc={blockDoc(START)} />);
		type('<script id="evil">window.top.x = 1</script><img src=x onerror="alert(1)">');
		fireEvent.click(screen.getByRole('button', { name: 'Update preview' }));
		expect(document.querySelector('script#evil')).toBeNull();
		expect(document.querySelector('img[onerror]')).toBeNull();
		expect(document.querySelectorAll('iframe')).toHaveLength(1);
		expect(frame().getAttribute('srcdoc')).toContain('<script id="evil">');
		expect(frame().innerHTML).toBe('');
	});

	it('centres an svg block on a page, with the policy in front of the markup', () => {
		renderWithClient(<Harness doc={blockDoc(START, 'svg', true, 'SVG drawing')} />);
		type('<svg viewBox="0 0 1 1"></svg>');
		fireEvent.click(screen.getByRole('button', { name: 'Update preview' }));
		expect(frame().getAttribute('srcdoc')?.startsWith(`<!doctype html>${HTML_POLICY_META}<html><body`)).toBe(true);
	});

	it('edits the source of a sandbox output: the fetched text first, then the draft', async () => {
		api.text.mockResolvedValue({ text: START, truncated: false });
		renderWithClient(<Harness doc={docOf(output('1', 'page.html'))} />);
		await waitFor(() => expect(editor()).toBeInTheDocument());
		expect(frame().getAttribute('srcdoc')).toBe(withHtmlPolicy(START));
		expect(frame().getAttribute('sandbox')).toBe('allow-scripts');
	});

	it('shows one pane by the View switch below the split width, and both beside each other from 44 rem', () => {
		const { container, rerender } = renderWithClient(<Harness doc={blockDoc(START)} mode="source" />);
		const panes = () =>
			Array.from(container.querySelectorAll('[data-testid="html-edit-panes"] > div')) as HTMLElement[];
		expect(panes()[0].className).toContain('block');
		expect(panes()[1].className).toContain('hidden');
		rerender(<Harness doc={blockDoc(START)} mode="preview" />);
		expect(panes()[0].className).toContain('hidden');
		expect(panes()[1].className).toContain('block');
		for (const pane of panes()) expect(pane.className).toContain('@min-[44rem]:block');
		expect(container.querySelector('[data-testid="html-edit-panes"]')?.className).toContain('@min-[44rem]:grid-cols-2');
	});
});
