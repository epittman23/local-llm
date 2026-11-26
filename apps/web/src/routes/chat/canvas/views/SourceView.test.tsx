import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blockDoc, docOf, id, output, renderWithClient, upload } from '../testing';
import { SourceView } from './SourceView';

const api = vi.hoisted(() => ({
	text: vi.fn<
		(token: string, id: string, max: number, signal?: AbortSignal) => Promise<{ text: string; truncated: boolean }>
	>()
}));
vi.mock('@/lib/apis/sandbox', () => ({ getSandboxOutputText: api.text, getSandboxOutputHtml: vi.fn() }));

beforeEach(() => {
	api.text.mockReset();
});

describe('SourceView', () => {
	it('shows code and text highlighted with line numbers, without Run or Preview', async () => {
		api.text.mockImplementation(async (_t, file) => ({
			text: file === id('1') ? 'import numpy as np\nprint("hi")' : '\\section{Intro}',
			truncated: file === id('2')
		}));
		const { container } = renderWithClient(<SourceView doc={docOf(output('1', 'fit.py'))} />);
		await waitFor(() => expect(container.querySelector('.hljs-keyword')).toBeTruthy());
		expect(container.querySelector('.code-surface')).toBeTruthy();
		// Line numbers, one per line.
		expect(screen.getByText('2')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Run|Preview/ })).toBeNull();
		expect(api.text).toHaveBeenCalledWith('', id('1'), 256 * 1024, expect.any(AbortSignal));
	});

	it('says when only the start of a file is shown', async () => {
		api.text.mockResolvedValue({ text: '\\section{Intro}', truncated: true });
		renderWithClient(<SourceView doc={docOf(output('2', 'paper.tex'))} />);
		expect(
			await screen.findByText(/Showing the first 256 KiB; download it for the rest, or to change it/)
		).toBeInTheDocument();
	});

	it('says when a file cannot be fetched', async () => {
		api.text.mockRejectedValue({ detail: 'Not found' });
		renderWithClient(<SourceView doc={docOf(output('7', 'log.txt'))} />);
		expect(await screen.findByText(/Could not show this file: Not found/)).toBeInTheDocument();
	});

	it('shows an uploaded page as source, fetched as text', async () => {
		api.text.mockResolvedValue({ text: '<p>mine</p>', truncated: false });
		const { container } = renderWithClient(<SourceView doc={docOf(upload('9', 'mine.html'), 'user')} />);
		await waitFor(() => expect(container).toHaveTextContent('<p>mine</p>'));
		expect(document.querySelector('iframe')).toBeNull();
	});

	it('shows a block from its text, filling in as the block grows, and never fetches', () => {
		const { rerender, container } = renderWithClient(<SourceView doc={blockDoc('<p>he', 'html', false)} />);
		expect(container).toHaveTextContent('<p>he');
		rerender(<SourceView doc={blockDoc('<p>hello</p>', 'html', false)} />);
		expect(container).toHaveTextContent('<p>hello</p>');
		expect(api.text).not.toHaveBeenCalled();
	});

	it('shows a very long document without per-line highlighting', () => {
		const long = Array.from({ length: 2100 }, () => 'import os').join('\n');
		const { container } = renderWithClient(<SourceView doc={{ ...blockDoc(long, 'python'), kind: 'code' }} />);
		expect(container.querySelector('.hljs-keyword')).toBeNull();
		expect(container).toHaveTextContent('import os');
	});

	describe('as an editor', () => {
		const edit = (draft: string, setDraft = vi.fn(), onSave = vi.fn()) => ({
			draft,
			setDraft,
			onSave,
			inputRef: { current: null }
		});

		it('shows the draft, not the fetched text, in a labelled textarea with its key help written under it', async () => {
			api.text.mockResolvedValue({ text: 'fetched', truncated: false });
			const setDraft = vi.fn();
			renderWithClient(<SourceView doc={docOf(output('1', 'fit.py'))} edit={edit('my draft', setDraft)} />);
			const box = await screen.findByRole('textbox', { name: 'Edit fit.py' });
			expect(box).toHaveValue('my draft');
			expect(screen.queryByText('fetched')).toBeNull();
			const hint = screen.getByText('Tab indents. Press Esc, then Tab, to leave the editor.');
			expect(hint).toBeVisible();
			expect(box).toHaveAccessibleDescription(hint.textContent ?? '');
			fireEvent.change(box, { target: { value: 'typed' } });
			expect(setDraft).toHaveBeenCalledWith('typed');
		});

		it('saves with Ctrl+S', async () => {
			api.text.mockResolvedValue({ text: 'x', truncated: false });
			const onSave = vi.fn();
			renderWithClient(<SourceView doc={docOf(output('1', 'fit.py'))} edit={edit('x', vi.fn(), onSave)} />);
			fireEvent.keyDown(await screen.findByRole('textbox'), { key: 's', ctrlKey: true });
			expect(onSave).toHaveBeenCalledTimes(1);
		});

		it('has no textarea or hint without edit', async () => {
			api.text.mockResolvedValue({ text: 'x', truncated: false });
			renderWithClient(<SourceView doc={docOf(output('1', 'fit.py'))} />);
			await screen.findByText('x');
			expect(screen.queryByRole('textbox')).toBeNull();
			expect(screen.queryByText(/Tab indents/)).toBeNull();
		});
	});

	it('says an editable file that is not UTF-8 text must be downloaded to be changed', async () => {
		api.text.mockResolvedValue({ text: 'caf\uFFFD', truncated: false });
		renderWithClient(<SourceView doc={docOf(output('1', 'notes.txt'))} />);
		expect(await screen.findByText('This file is not UTF-8 text; download it to change it.')).toBeInTheDocument();
	});

	it('says so of a table too, which is edited as text when it cannot be a table', async () => {
		api.text.mockResolvedValue({ text: 'caf\uFFFD', truncated: false });
		const { container } = renderWithClient(<SourceView doc={docOf(output('9', 'table.csv'))} />);
		await waitFor(() => expect(container).toHaveTextContent('caf'));
		expect(screen.getByText(/not UTF-8/)).toBeInTheDocument();
	});
});
