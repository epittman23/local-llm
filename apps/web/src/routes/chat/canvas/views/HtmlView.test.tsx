import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HTML_POLICY_META } from '@/lib/chat/htmlPolicy';
import { HTML_MAX_BYTES } from '../limits';
import { blockDoc, docOf, id, output, renderWithClient, upload } from '../testing';
import { HtmlView } from './HtmlView';

const api = vi.hoisted(() => ({
	html: vi.fn<(token: string, id: string, signal?: AbortSignal) => Promise<string>>()
}));
vi.mock('@/lib/apis/sandbox', () => ({ getSandboxOutputHtml: api.html, getSandboxOutputText: vi.fn() }));

beforeEach(() => {
	api.html.mockReset();
});

describe('HtmlView', () => {
	it('shows an output in a frame sandboxed to allow-scripts only, filled through srcdoc from the server route', async () => {
		api.html.mockResolvedValue('<!doctype html><meta http-equiv="Content-Security-Policy"><p>hi</p>');
		renderWithClient(<HtmlView doc={docOf(output('e', 'report.html'))} />);
		const frame = await screen.findByTitle('Preview of report.html');
		expect(frame.tagName).toBe('IFRAME');
		expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
		expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
		expect(frame.getAttribute('srcdoc')).toContain('<p>hi</p>');
		expect(frame.getAttribute('src')).toBeNull();
		expect(api.html).toHaveBeenCalledWith('', id('e'), expect.any(AbortSignal));
	});

	it('shows a fenced block with the policy first, sandboxed to allow-scripts alone, without asking the server', () => {
		renderWithClient(<HtmlView doc={blockDoc('<p>hi</p>')} />);
		const frame = screen.getByTitle('Preview of HTML page');
		const sandbox = frame.getAttribute('sandbox');
		expect(sandbox).toBe('allow-scripts');
		for (const flag of ['allow-same-origin', 'allow-forms', 'allow-modals']) expect(sandbox).not.toContain(flag);
		expect(frame.getAttribute('srcdoc')?.startsWith(HTML_POLICY_META)).toBe(true);
		expect(frame.getAttribute('srcdoc')).toContain('<p>hi</p>');
		expect(frame.getAttribute('src')).toBeNull();
		expect(api.html).not.toHaveBeenCalled();
	});

	it('puts the policy after a leading doctype, and centres a bare svg on a page with the policy in front of the markup', () => {
		const { unmount } = renderWithClient(<HtmlView doc={blockDoc('<!doctype html><p>x</p>')} />);
		expect(screen.getByTitle('Preview of HTML page').getAttribute('srcdoc')).toBe(
			`<!doctype html>${HTML_POLICY_META}<p>x</p>`
		);
		unmount();
		renderWithClient(<HtmlView doc={blockDoc('<svg viewBox="0 0 1 1"></svg>', 'svg', true, 'SVG drawing')} />);
		const srcdoc = screen.getByTitle('Preview of SVG drawing').getAttribute('srcdoc') ?? '';
		expect(srcdoc.startsWith(`<!doctype html>${HTML_POLICY_META}<html><body`)).toBe(true);
		expect(srcdoc).toContain('<svg viewBox="0 0 1 1"></svg>');
	});

	it('fills the canvas on the theme’s surface and has no height buttons', async () => {
		api.html.mockResolvedValue('<p>hi</p>');
		renderWithClient(<HtmlView doc={docOf(output('e', 'report.html'))} />);
		const frame = await screen.findByTitle('Preview of report.html');
		expect(frame.className).toContain('size-full');
		expect(frame.className).toContain('bg-surface-1');
		expect(frame.parentElement?.className).toContain('bg-surface-1');
		expect(screen.queryByRole('button')).toBeNull();
	});

	it('remounts the frame and refetches the page when Reload is pressed', async () => {
		api.html.mockResolvedValueOnce('<p>one</p>').mockResolvedValueOnce('<p>two</p>');
		const doc = docOf(output('e', 'report.html'));
		const { rerender } = renderWithClient(<HtmlView doc={doc} reloads={0} />);
		const first = await screen.findByTitle('Preview of report.html');
		expect(first.getAttribute('srcdoc')).toContain('one');
		rerender(<HtmlView doc={doc} reloads={1} />);
		await waitFor(() => expect(screen.getByTitle('Preview of report.html').getAttribute('srcdoc')).toContain('two'));
		expect(screen.getByTitle('Preview of report.html')).not.toBe(first);
		expect(api.html).toHaveBeenCalledTimes(2);
	});

	it('says why a page is not shown: refused by the server, or over the limit before asking', async () => {
		api.html.mockRejectedValue({ detail: 'The document is over the 5 MiB limit for showing it' });
		renderWithClient(<HtmlView doc={docOf(output('e', 'big.html'))} />);
		expect(await screen.findByText(/over the 5 MiB limit/)).toBeInTheDocument();
		expect(document.querySelector('iframe')).toBeNull();
		expect(api.html).toHaveBeenCalledTimes(1);
		renderWithClient(<HtmlView doc={docOf(output('f', 'huge.htm', {}, { size: HTML_MAX_BYTES + 1 }))} />);
		expect(screen.getByText(/Too large to show here/)).toBeInTheDocument();
		expect(api.html).toHaveBeenCalledTimes(1);
	});

	it('never frames an uploaded page, nor asks the sandbox route for it', () => {
		const { container } = renderWithClient(<HtmlView doc={docOf(upload('9', 'mine.html'), 'user')} />);
		expect(container).toBeEmptyDOMElement();
		expect(api.html).not.toHaveBeenCalled();
	});
});
