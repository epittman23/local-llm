import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatFile } from '@/lib/chat/history';
import {
	CSV_MAX_CELL,
	CSV_MAX_COLS,
	CSV_MAX_ROWS,
	HTML_MAX_BYTES,
	isSandboxOutput,
	outputRenderer,
	SandboxOutputs
} from './SandboxOutputs';

const api = vi.hoisted(() => ({
	html: vi.fn<(token: string, id: string, signal?: AbortSignal) => Promise<string>>(),
	text: vi.fn<
		(token: string, id: string, max: number, signal?: AbortSignal) => Promise<{ text: string; truncated: boolean }>
	>()
}));
vi.mock('@/lib/apis/sandbox', () => ({ getSandboxOutputHtml: api.html, getSandboxOutputText: api.text }));

/** A file id as the server makes them (a UUID), from a short hex key. */
const id = (key: string) => `00000000-0000-4000-8000-${key.padStart(12, '0')}`;
const content = (key: string, attachment = false) =>
	`/api/v1/files/${id(key)}/content${attachment ? '?attachment=true' : ''}`;

const output = (
	key: string,
	name: string,
	meta: Record<string, unknown> = {},
	extra: Partial<ChatFile> = {}
): ChatFile => ({
	type: 'file',
	id: id(key),
	name,
	url: content(key),
	size: 10,
	meta: { source: 'sandbox_output', sandbox_path: `/workspace/outputs/${name}`, ...meta },
	...extra
});

const renderOutputs = (files: unknown) =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<SandboxOutputs files={files} />
		</QueryClientProvider>
	);

const kinds = () => screen.queryAllByTestId('sandbox-output').map((e) => e.getAttribute('data-kind'));
const downloads = () => screen.getAllByRole('link', { name: /^Download / }).map((a) => a.getAttribute('href'));

beforeEach(() => {
	api.html.mockReset();
	api.text.mockReset();
});

describe('SandboxOutputs', () => {
	it('shows nothing for files that are not sandbox outputs', () => {
		const { container } = renderOutputs([
			{ type: 'image', url: '/x.png' },
			{ type: 'file', id: id('1'), name: 'up.png', meta: { source: 'upload' } },
			{ type: 'file', id: id('2'), name: 'up.txt', meta: 'not an object' }
		]);
		expect(container).toBeEmptyDOMElement();
	});

	it('skips malformed entries, never throwing on them', () => {
		const bad = [
			null,
			'x',
			5,
			{ meta: null },
			// An id that is not a UUID never goes into a URL: `..` would climb a path segment.
			output('1', 'dots.png', {}, { id: '..' }),
			output('2', 'num.png', {}, { id: 5 as never }),
			output('3', 'x.png', { source: 7 })
		];
		const { container } = renderOutputs(bad);
		expect(container).toBeEmptyDOMElement();
		expect(bad.filter(isSandboxOutput)).toEqual([]);
		// A list that is not an array shows nothing.
		expect(renderOutputs({ length: 1 }).container).toBeEmptyDOMElement();
		// Odd field types: shown as a download named "output", with meta fields of the wrong type ignored.
		renderOutputs([
			output(
				'4',
				5 as never,
				{ content_type: 9, preview_of: {}, preview_page: 'x', sandbox_path: ['a'] },
				{ size: 'big' as never }
			)
		]);
		expect(kinds()).toEqual(['download']);
		expect(screen.getByRole('link', { name: 'Download output' })).toHaveAttribute('href', content('4', true));
		expect(outputRenderer({ id: id('5'), name: 3 as never, meta: { sandbox_path: 'a.csv' } })).toEqual({ kind: 'csv' });
	});

	it('shows PNG, JPEG and SVG outputs only as <img> from the content route', () => {
		const { container } = renderOutputs([
			output('a', 'plot.png'),
			output('b', 'photo.JPEG'),
			output('c', 'chart.svg', { content_type: 'image/svg+xml' })
		]);
		expect(kinds()).toEqual(['image', 'image', 'image']);
		expect(screen.getByRole('img', { name: 'plot.png' })).toHaveAttribute('src', content('a'));
		expect(screen.getByRole('img', { name: 'chart.svg' })).toHaveAttribute('src', content('c'));
		// Never inline: no <svg> of the model's, no frame.
		expect(container.querySelector('svg:not(.lucide)')).toBeNull();
		expect(container.querySelector('iframe')).toBeNull();
		// One download link per output, each named for its file.
		expect(screen.getByRole('link', { name: 'Download photo.JPEG' })).toHaveAttribute('href', content('b', true));
	});

	it('shows the cleaned name, never the raw sandbox path', () => {
		// The server cleans `name`; `sandbox_path` keeps a right-to-left override that would make `.exe` read as `.pdf`.
		renderOutputs([output('d', 'invoice_fdp.exe', { sandbox_path: '/workspace/outputs/invoice\u202efdp.exe' })]);
		const figure = screen.getByTestId('sandbox-output');
		expect(figure).toHaveTextContent('invoice_fdp.exe');
		expect(figure.textContent).not.toContain('\u202e');
	});

	it('shows HTML in a frame sandboxed to allow-scripts only, and Enlarge reuses the frame with the same document', async () => {
		api.html.mockResolvedValue('<!doctype html><meta http-equiv="Content-Security-Policy"><p>hi</p>');
		renderOutputs([output('e', 'report.html')]);
		const frame = await screen.findByTitle('Output report.html');
		expect(frame.tagName).toBe('IFRAME');
		expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
		expect(frame.getAttribute('srcdoc')).toContain('<p>hi</p>');
		expect(frame.getAttribute('src')).toBeNull();
		expect(api.html).toHaveBeenCalledWith('', id('e'), expect.any(AbortSignal));

		fireEvent.click(screen.getByRole('button', { name: 'Enlarge: report.html' }));
		const dialog = await screen.findByRole('dialog');
		expect(within(dialog).getByRole('heading', { name: 'report.html' })).toBeInTheDocument();
		const big = within(dialog).getByTitle('Output report.html, enlarged');
		expect(big.getAttribute('sandbox')).toBe('allow-scripts');
		expect(big.getAttribute('srcdoc')).toBe(frame.getAttribute('srcdoc'));
		// The modal shows what was fetched; it does not ask again.
		expect(api.html).toHaveBeenCalledTimes(1);
	});

	it('steps the frame taller and shorter from the keyboard, within bounds, and announces the height', async () => {
		api.html.mockResolvedValue('<p>hi</p>');
		renderOutputs([output('e', 'report.html')]);
		await screen.findByTitle('Output report.html');
		const box = screen.getByTestId('sandbox-frame-box');
		const taller = screen.getByRole('button', { name: 'Taller: report.html' });
		const shorter = screen.getByRole('button', { name: 'Shorter: report.html' });
		expect(box.style.height).toBe('360px');
		fireEvent.click(taller);
		expect(box.style.height).toBe('480px');
		expect(screen.getByText('Frame height 480 pixels')).toHaveAttribute('aria-live', 'polite');
		for (let i = 0; i < 5; i++) fireEvent.click(shorter);
		expect(box.style.height).toBe('120px');
		expect(shorter).toBeDisabled();
		for (let i = 0; i < 30; i++) fireEvent.click(taller);
		expect(box.style.height).toBe('2400px');
		expect(taller).toBeDisabled();
	});

	it('steps from the height a corner drag left, even when that lands on the height it had before', async () => {
		api.html.mockResolvedValue('<p>hi</p>');
		renderOutputs([output('e', 'report.html'), output('f', 'other.html')]);
		await waitFor(() => expect(screen.getAllByTestId('sandbox-frame-box')).toHaveLength(2));
		const box = screen.getAllByTestId('sandbox-frame-box')[0];
		// A drag of the corner to 240 px: the browser writes the box's style, and React's state stays at 360.
		const drag = (px: number) => {
			box.style.height = `${px}px`;
			Object.defineProperty(box, 'offsetHeight', { configurable: true, value: px });
		};
		drag(240);
		fireEvent.click(screen.getByRole('button', { name: 'Taller: report.html' }));
		expect(box.style.height).toBe('360px');
		// A drag below the step's floor: Shorter never makes it taller than 120, and the box's own minimum is 120.
		drag(130);
		fireEvent.click(screen.getByRole('button', { name: 'Shorter: report.html' }));
		expect(box.style.height).toBe('120px');
		expect(box).toHaveClass('min-h-[120px]');
		// Each output's controls are named for its file.
		expect(screen.getByRole('button', { name: 'Enlarge: other.html' })).toBeInTheDocument();
		expect(screen.getAllByTestId('sandbox-frame-box')[1].style.height).toBe('360px');
	});

	it('says why an HTML output is not shown: refused by the server, or over the limit before asking', async () => {
		api.html.mockRejectedValue({ detail: 'The document is over the 5 MiB limit for showing it' });
		renderOutputs([output('e', 'big.html'), output('f', 'huge.htm', {}, { size: HTML_MAX_BYTES + 1 })]);
		expect(await screen.findByText(/over the 5 MiB limit/)).toBeInTheDocument();
		expect(screen.getByText(/Too large to show here/)).toBeInTheDocument();
		expect(api.html).toHaveBeenCalledTimes(1);
		expect(document.querySelector('iframe')).toBeNull();
		expect(downloads()).toEqual([content('e', true), content('f', true)]);
	});

	it('shows a PDF as its preview pages in page order, with a download link', () => {
		renderOutputs([
			output('10', 'paper.pdf'),
			output('12', 'page-2.png', {
				preview_of: id('10'),
				preview_page: 2,
				sandbox_path: '/workspace/outputs/paper.pdf'
			}),
			output('11', 'page-1.png', {
				preview_of: id('10'),
				preview_page: 1,
				sandbox_path: '/workspace/outputs/paper.pdf'
			}),
			output('13', 'page-1.png', { preview_of: id('99'), preview_page: 1, sandbox_path: '/workspace/outputs/gone.pdf' })
		]);
		// The orphan preview (its PDF is not on the list) is shown as the image it is, under its own name.
		expect(kinds()).toEqual(['pdf', 'image']);
		const [pdf, orphan] = screen.getAllByTestId('sandbox-output');
		expect(
			within(pdf)
				.getAllByRole('img')
				.map((i) => [i.getAttribute('src'), i.getAttribute('alt')])
		).toEqual([
			[content('11'), 'paper.pdf, page 1'],
			[content('12'), 'paper.pdf, page 2']
		]);
		expect(within(pdf).getByRole('link', { name: 'Download paper.pdf' })).toHaveAttribute('href', content('10', true));
		expect(orphan).toHaveTextContent('page-1.png');
		expect(orphan).not.toHaveTextContent('gone.pdf');
	});

	it('a PDF without previews is a download', () => {
		renderOutputs([output('10', 'paper.pdf')]);
		expect(screen.queryByRole('img')).toBeNull();
		expect(screen.getByRole('link', { name: 'Download paper.pdf' })).toHaveAttribute('download', 'paper.pdf');
	});

	it('shows code and text through the highlighted code block, without Run or Preview', async () => {
		api.text.mockImplementation(async (_t, file) => ({
			text: file === id('1') ? 'import numpy as np\nprint("hi")' : file === id('2') ? '\\section{Intro}' : '{"a": 1}',
			truncated: file === id('3')
		}));
		renderOutputs([output('1', 'fit.py'), output('2', 'paper.tex'), output('3', 'data.json')]);
		await waitFor(() => expect(screen.getAllByTestId('code-block')).toHaveLength(3));
		const blocks = screen.getAllByTestId('code-block');
		expect(blocks[0]).toHaveTextContent('python');
		expect(blocks[0].querySelector('.hljs-keyword')).toBeTruthy();
		expect(blocks[1]).toHaveTextContent('latex');
		expect(blocks[1].querySelector('[class^="hljs-"]')).toBeTruthy();
		expect(screen.queryByRole('button', { name: /Run|Preview/ })).toBeNull();
		expect(api.text).toHaveBeenCalledWith('', id('1'), 256 * 1024, expect.any(AbortSignal));
		expect(screen.getByText(/Showing the first 256 KiB/)).toBeInTheDocument();
	});

	it('picks the renderer by extension, then by stored type, else a download', () => {
		const r = (name: string, content_type?: string) => outputRenderer(output('1', name, { content_type }));
		expect(r('model.R')).toEqual({ kind: 'code', language: 'r' });
		expect(r('notes.txt')).toEqual({ kind: 'code', language: 'plaintext' });
		expect(r('README', 'text/plain; charset=utf-8')).toEqual({ kind: 'code', language: 'plaintext' });
		expect(r('table', 'text/csv')).toEqual({ kind: 'csv' });
		expect(r('page', 'text/html')).toEqual({ kind: 'html' });
		expect(r('.hidden')).toEqual({ kind: 'download' });
		expect(r('model.pkl', 'application/octet-stream')).toEqual({ kind: 'download' });
		expect(
			outputRenderer({ type: 'file', id: id('1'), meta: { source: 'sandbox_output', sandbox_path: 'a/b.csv' } })
		).toEqual({
			kind: 'csv'
		});
	});

	it(`shows a CSV as a table of its first ${CSV_MAX_ROWS} rows, its first row as the header`, async () => {
		const lines = ['name,"note, quoted"', ...Array.from({ length: 300 }, (_, i) => `r${i},"<b>${i}</b>"`)];
		api.text.mockResolvedValue({ text: lines.join('\n'), truncated: false });
		renderOutputs([output('c5', 'results.csv')]);
		const table = await screen.findByTestId('sandbox-csv');
		expect(
			within(table)
				.getAllByRole('columnheader')
				.map((th) => th.textContent)
		).toEqual(['name', 'note, quoted']);
		const rows = table.querySelectorAll('tr');
		expect(rows).toHaveLength(CSV_MAX_ROWS);
		// Cells are text, never markup.
		expect(rows[1].textContent).toContain('<b>0</b>');
		expect(table.querySelector('b')).toBeNull();
		expect(screen.getByText(`Showing the first ${CSV_MAX_ROWS} rows.`)).toBeInTheDocument();
		expect(screen.queryByText(/Wide rows and long cells are cut/)).toBeNull();
		expect(api.text).toHaveBeenCalledWith('', id('c5'), 1024 * 1024, expect.any(AbortSignal));
	});

	it('caps a CSV’s columns and cell length, and leaves out a row the fetch cut short', async () => {
		const wide = Array.from({ length: CSV_MAX_COLS + 10 }, (_, i) => `c${i}`).join(',');
		api.text.mockResolvedValue({ text: `${wide}\n${'x'.repeat(CSV_MAX_CELL + 5)},2\nhalf a ro`, truncated: true });
		renderOutputs([output('c6', 'wide.csv')]);
		const table = await screen.findByTestId('sandbox-csv');
		expect(within(table).getAllByRole('columnheader')).toHaveLength(CSV_MAX_COLS);
		const rows = table.querySelectorAll('tbody tr');
		expect(rows).toHaveLength(1);
		expect(rows[0].querySelector('td')?.textContent).toHaveLength(CSV_MAX_CELL);
		expect(table).not.toHaveTextContent('half a ro');
		expect(screen.getByText(/Wide rows and long cells are cut/)).toBeInTheDocument();
		expect(screen.getByText('Showing the first 2 rows.')).toBeInTheDocument();
	});

	it('says when a text output cannot be fetched', async () => {
		api.text.mockRejectedValue({ detail: 'Not found' });
		renderOutputs([output('7', 'log.txt')]);
		expect(await screen.findByText(/Could not show this file: Not found/)).toBeInTheDocument();
	});

	it('anything else is a download link that asks for an attachment', () => {
		renderOutputs([output('8', 'model.pkl', { content_type: 'application/octet-stream' })]);
		expect(kinds()).toEqual(['download']);
		expect(downloads()).toEqual([content('8', true)]);
		expect(api.text).not.toHaveBeenCalled();
		expect(api.html).not.toHaveBeenCalled();
	});
});
