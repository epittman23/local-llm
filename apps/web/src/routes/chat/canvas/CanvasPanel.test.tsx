import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import saveAs from 'file-saver';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasDocument } from '@/lib/chat/documents';
import { knowledgeDocument } from '@/lib/chat/documents';
import type { Message } from '@/lib/chat/history';
import { CanvasPanel } from './CanvasPanel';
import { blockDoc, content, docOf, id, output, renderWithRouter, upload } from './testing';
import type { CanvasState } from './useCanvas';

const api = vi.hoisted(() => ({
	html: vi.fn<(token: string, id: string, signal?: AbortSignal) => Promise<string>>(),
	text: vi.fn<(token: string, id: string, max: number) => Promise<{ text: string; truncated: boolean }>>()
}));
vi.mock('@/lib/apis/sandbox', () => ({ getSandboxOutputHtml: api.html, getSandboxOutputText: api.text }));
vi.mock('file-saver', () => ({ default: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const state = (doc: CanvasDocument | null, over: Partial<CanvasState> = {}): CanvasState => ({
	documents: doc ? [doc] : [],
	openId: doc?.id ?? null,
	doc,
	gone: false,
	open: vi.fn(),
	close: vi.fn(),
	...over
});

const panel = (canvas: CanvasState) => <CanvasPanel canvas={canvas} />;

async function openMenu(name: string | RegExp) {
	fireEvent.pointerDown(screen.getByRole('button', { name }), { button: 0, pointerType: 'mouse' });
	return screen.findByRole('menu');
}

beforeEach(() => {
	api.html.mockReset();
	api.text.mockReset();
	api.html.mockResolvedValue('<p>page</p>');
	api.text.mockResolvedValue({ text: 'source text', truncated: false });
	vi.mocked(saveAs).mockReset();
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('CanvasPanel header', () => {
	it('has the switch, name and kind, Copy menu, Reload, Expand and Close for a page', async () => {
		renderWithRouter(panel(state(docOf(output('e', 'report.html')))));
		const region = screen.getByRole('complementary', { name: 'Canvas' });
		expect(within(region).getByRole('heading', { name: 'report.html HTML' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true');
		expect(screen.getByRole('button', { name: 'Source' })).toHaveAttribute('aria-pressed', 'false');
		expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Reload the page' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Expand to the full width' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Close canvas' })).toBeInTheDocument();
		// One document: no file list.
		expect(screen.queryByRole('button', { name: /documents in this chat/ })).toBeNull();
		expect(await screen.findByTitle('Preview of report.html')).toBeInTheDocument();
	});

	it('hides the switch where the kind has one view, and offers Download for a file it cannot copy', () => {
		renderWithRouter(panel(state(docOf(output('a', 'plot.png')))));
		expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Source' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Reload the page' })).toBeNull();
		expect(screen.getAllByRole('link', { name: 'Download' })[0]).toHaveAttribute('href', content('a', true));
		expect(screen.getByRole('img', { name: 'plot.png' })).toHaveAttribute('src', content('a'));
	});

	it('shows only the source of code, with no switch and no Reload', async () => {
		renderWithRouter(panel(state(docOf(output('1', 'fit.py')))));
		expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
		expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
		expect(await screen.findByText(/source text/)).toBeInTheDocument();
	});

	it('shows an uploaded page as source with Download, never framed, and never asks the sandbox route', async () => {
		const doc = docOf(upload('9', 'mine.html'), 'user');
		renderWithRouter(panel(state(doc)));
		expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Reload the page' })).toBeNull();
		expect(await screen.findByText(/source text/)).toBeInTheDocument();
		expect(document.querySelector('iframe')).toBeNull();
		expect(api.html).not.toHaveBeenCalled();
		expect(api.text).toHaveBeenCalledWith('', id('9'), 256 * 1024, expect.any(AbortSignal));
		const menu = await openMenu('Copy');
		expect(within(menu).getByRole('menuitem', { name: 'Download' })).toHaveAttribute('href', content('9', true));
	});

	it('switches between Preview and Source and keeps the choice for the document', async () => {
		const doc = docOf(output('e', 'report.html'));
		const { rerender } = renderWithRouter(panel(state(doc)));
		await screen.findByTitle('Preview of report.html');
		fireEvent.click(screen.getByRole('button', { name: 'Source' }));
		expect(document.querySelector('iframe')).toBeNull();
		expect(await screen.findByText(/source text/)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Source' })).toHaveAttribute('aria-pressed', 'true');
		rerender(panel(state(doc)));
		expect(document.querySelector('iframe')).toBeNull();
	});

	it('lists the chat’s documents when there is more than one, and opens the one chosen', async () => {
		const a = docOf(output('e', 'report.html'));
		const b = docOf(output('1', 'fit.py'));
		const canvas = state(a, { documents: [a, b] });
		renderWithRouter(panel(canvas));
		const menu = await openMenu('2 documents in this chat');
		fireEvent.click(within(menu).getByRole('menuitem', { name: 'fit.py' }));
		expect(canvas.open).toHaveBeenCalledWith(b.id);
	});

	it('closes from Close, and from Escape inside it', () => {
		const canvas = state(docOf(output('a', 'plot.png')));
		renderWithRouter(panel(canvas));
		fireEvent.click(screen.getByRole('button', { name: 'Close canvas' }));
		expect(canvas.close).toHaveBeenCalledTimes(1);
		fireEvent.keyDown(screen.getByRole('heading', { name: /plot\.png/ }), { key: 'Escape' });
		expect(canvas.close).toHaveBeenCalledTimes(2);
	});

	it('Expand makes the column take all the space, and says how to undo it', () => {
		renderWithRouter(panel(state(docOf(output('a', 'plot.png')))));
		const region = screen.getByRole('complementary', { name: 'Canvas' });
		expect(region).not.toHaveAttribute('data-expanded');
		fireEvent.click(screen.getByRole('button', { name: 'Expand to the full width' }));
		expect(region).toHaveAttribute('data-expanded');
		fireEvent.click(screen.getByRole('button', { name: 'Show the chat beside it' }));
		expect(region).not.toHaveAttribute('data-expanded');
	});

	it('Reload remounts the page', async () => {
		renderWithRouter(panel(state(docOf(output('e', 'report.html')))));
		const frame = await screen.findByTitle('Preview of report.html');
		fireEvent.click(screen.getByRole('button', { name: 'Reload the page' }));
		await waitFor(() => expect(screen.getByTitle('Preview of report.html')).not.toBe(frame));
		expect(api.html).toHaveBeenCalledTimes(2);
	});

	it('folds the actions into one menu below sm, keeping the switch and Close', async () => {
		vi.stubGlobal(
			'matchMedia',
			vi.fn((query: string) => ({
				matches: query !== '(min-width: 640px)',
				addEventListener: vi.fn(),
				removeEventListener: vi.fn()
			}))
		);
		renderWithRouter(panel(state(docOf(output('e', 'report.html')))));
		expect(screen.getByRole('button', { name: 'Preview' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Close canvas' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Reload the page' })).toBeNull();
		const menu = await openMenu('More actions for this document');
		expect(
			within(menu)
				.getAllByRole('menuitem')
				.map((i) => i.textContent)
		).toEqual(['Copy', 'Download', 'Reload the page']);
	});
});

describe('CanvasPanel blocks', () => {
	it('shows a block still being written as Source filling in, with Preview unavailable, then Preview once it closes', async () => {
		const { rerender } = renderWithRouter(panel(state(blockDoc('<p>he', 'html', false))));
		expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Source' })).toHaveAttribute('aria-pressed', 'true');
		expect(document.querySelector('iframe')).toBeNull();
		expect(screen.getByRole('complementary')).toHaveTextContent('<p>he');
		rerender(panel(state(blockDoc('<p>hello</p>', 'html', true))));
		expect(screen.getByRole('button', { name: 'Preview' })).toBeEnabled();
		expect(screen.getByTitle('Preview of HTML page')).toBeInTheDocument();
		expect(api.html).not.toHaveBeenCalled();
	});

	it('keeps the view the person chose when the block closes', () => {
		const { rerender } = renderWithRouter(panel(state(blockDoc('<p>hi</p>', 'html', true))));
		fireEvent.click(screen.getByRole('button', { name: 'Source' }));
		expect(document.querySelector('iframe')).toBeNull();
		rerender(panel(state(blockDoc('<p>hi</p>', 'html', true))));
		expect(document.querySelector('iframe')).toBeNull();
	});

	it('shows a code block as source only', () => {
		renderWithRouter(panel(state({ ...blockDoc('x = 1\n'.repeat(20), 'python', true, 'python code'), kind: 'code' })));
		expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
		expect(screen.getByRole('complementary')).toHaveTextContent('x = 1');
	});

	it('downloads a block as a Blob named for its document: .html or .svg', async () => {
		renderWithRouter(panel(state(blockDoc('<svg></svg>', 'svg', true, 'SVG drawing'))));
		fireEvent.click(within(await openMenu('Copy')).getByRole('menuitem', { name: 'Download' }));
		const [blob, name] = vi.mocked(saveAs).mock.calls[0] as unknown as [Blob, string];
		expect(name).toBe('SVG drawing.svg');
		expect(await blob.text()).toBe('<svg></svg>');
		cleanup();
		renderWithRouter(panel(state(blockDoc('<p>hi</p>'))));
		fireEvent.click(within(await openMenu('Copy')).getByRole('menuitem', { name: 'Download' }));
		expect(vi.mocked(saveAs).mock.calls[1][1]).toBe('HTML page.html');
	});

	it('copies a block’s text without asking the server', async () => {
		const write = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal('navigator', { clipboard: { writeText: write } });
		renderWithRouter(panel(state(blockDoc('<p>hi</p>'))));
		fireEvent.click(within(await openMenu('Copy')).getByRole('menuitem', { name: 'Copy' }));
		await waitFor(() => expect(write).toHaveBeenCalledWith('<p>hi</p>'));
		expect(api.text).not.toHaveBeenCalled();
	});
});

describe('CanvasPanel states', () => {
	it('says a document is no longer in the chat, with a way onward (NAV-3)', async () => {
		const other = docOf(output('1', 'fit.py'));
		const canvas = state(null, { openId: 'block:m9:0', gone: true, documents: [other] });
		renderWithRouter(panel(canvas));
		expect(screen.getByText('This document is no longer in the chat')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Close the canvas' }));
		expect(canvas.close).toHaveBeenCalled();
		const menu = await openMenu('Documents in this chat');
		fireEvent.click(within(menu).getByRole('menuitem', { name: 'fit.py' }));
		expect(canvas.open).toHaveBeenCalledWith(other.id);
	});

	it('shows loading while the chat loads, and nothing when no document is open', () => {
		renderWithRouter(panel(state(null, { openId: 'x' })));
		expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
		cleanup();
		renderWithRouter(panel(state(null)));
		expect(screen.queryByRole('complementary')).toBeNull();
	});

	it('does not take focus when it opens by itself (focusOnOpen false)', () => {
		const field = document.createElement('input');
		document.body.append(field);
		field.focus();
		renderWithRouter(<CanvasPanel canvas={state(docOf(output('a', 'plot.png')))} focusOnOpen={false} />);
		expect(document.activeElement).toBe(field);
		field.remove();
	});
});

describe('CanvasPanel, a knowledge file', () => {
	const file = id('77');
	const knowledge = (name: string, extra: Record<string, unknown> = {}, passages = ['The cited passage.']) => {
		const reply = {
			id: 'a1',
			parentId: null,
			childrenIds: [],
			role: 'assistant',
			content: '',
			done: true,
			sources: [
				{
					document: passages,
					metadata: passages.map(() => ({ file_id: file, name, source: name, ...extra }))
				}
			]
		} as Message;
		return knowledgeDocument([reply], file, []) as CanvasDocument;
	};
	const noActions = () => {
		expect(screen.queryByRole('button', { name: /Edit document|Try changes/ })).toBeNull();
		expect(screen.queryByRole('button', { name: /Version/ })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Reload the page' })).toBeNull();
	};

	it('is read-only: no Edit, no versions, no Reload, and says where it is from; its passages are text above it', async () => {
		renderWithRouter(panel(state(knowledge('notes.md', {}, ['<img src=x onerror=alert(1)> passage']))));
		expect(screen.getByRole('heading', { name: 'notes.md Markdown, from a knowledge source' })).toBeInTheDocument();
		expect(await screen.findByText(/passage/, { selector: 'div' })).toBeInTheDocument();
		expect(screen.getByRole('heading', { name: 'Cited in this reply' })).toBeInTheDocument();
		expect(document.querySelector('img[src="x"]')).toBeNull();
		expect(screen.getByText('<img src=x onerror=alert(1)> passage')).toBeInTheDocument();
		noActions();
		expect(api.text).toHaveBeenCalledWith('', file, 256 * 1024, expect.any(AbortSignal));
		const menu = await openMenu('Copy');
		expect(within(menu).getByRole('menuitem', { name: 'Download' })).toHaveAttribute('href', content('77', true));
		expect(within(menu).queryByRole('menuitem', { name: 'Attach to next message' })).toBeNull();
	});

	it('shows two cited passages and the rest on request', () => {
		renderWithRouter(panel(state(knowledge('notes.md', {}, ['one', 'two', 'three', 'three']))));
		expect(screen.getByText('two')).toBeInTheDocument();
		expect(screen.queryByText('three')).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Show 1 more' }));
		expect(screen.getByText('three')).toBeInTheDocument();
	});

	it('shows an html file as source only: no frame, no Preview, no sandbox route', async () => {
		renderWithRouter(panel(state(knowledge('page.html'))));
		expect(await screen.findByText(/source text/)).toBeInTheDocument();
		expect(document.querySelector('iframe')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
		expect(api.html).not.toHaveBeenCalled();
		noActions();
	});

	it('offers Open at page N for a PDF, and Download', () => {
		renderWithRouter(panel(state(knowledge('paper.pdf', { page: 4 }))));
		expect(screen.getByRole('link', { name: 'Open at page 5' })).toHaveAttribute('href', `${content('77')}#page=5`);
		expect(screen.getAllByRole('link', { name: /Download/ })[0]).toHaveAttribute('href', content('77', true));
	});

	it('shows an image through the content route', () => {
		renderWithRouter(panel(state(knowledge('fig.png'))));
		expect(screen.getByRole('img', { name: 'fig.png' })).toHaveAttribute('src', content('77'));
	});

	it('says the file cannot be opened when the server answers not found, and shows no data', async () => {
		api.text.mockRejectedValue({ detail: "We could not find what you're looking for :/" });
		renderWithRouter(panel(state(knowledge('notes.md'))));
		expect(
			await screen.findByText('You can’t open this file. It may have been removed, or you may no longer have access.')
		).toBeInTheDocument();
		expect(screen.queryByText('source text')).toBeNull();
	});

	it('says what failed for any other error', async () => {
		api.text.mockRejectedValue({ detail: 'Database is locked' });
		renderWithRouter(panel(state(knowledge('notes.md'))));
		expect(await screen.findByText(/Could not show this file: Database is locked/)).toBeInTheDocument();
	});
});
