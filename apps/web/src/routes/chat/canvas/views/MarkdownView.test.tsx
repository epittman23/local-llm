import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { docOf, output, renderWithClient } from '../testing';
import { MarkdownView } from './MarkdownView';

const api = vi.hoisted(() => ({
	text: vi.fn<(token: string, id: string, max: number) => Promise<{ text: string; truncated: boolean }>>()
}));
vi.mock('@/lib/apis/sandbox', () => ({ getSandboxOutputText: api.text, getSandboxOutputHtml: vi.fn() }));

beforeEach(() => {
	api.text.mockReset();
});

describe('MarkdownView', () => {
	it('renders a Markdown file as formatted text through the safe renderer', async () => {
		api.text.mockResolvedValue({
			text: 'A **bold** point\n\n- one',
			truncated: false
		});
		const { container } = renderWithClient(<MarkdownView doc={docOf(output('5', 'notes.md'))} />);
		expect(await screen.findByText('bold')).toBeInTheDocument();
		expect(container.querySelector('strong')).toHaveTextContent('bold');
		expect(container.querySelector('li')).toHaveTextContent('one');
	});

	it('says when it is cut, and when it cannot be fetched', async () => {
		api.text.mockResolvedValueOnce({ text: 'hello', truncated: true });
		const { unmount } = renderWithClient(<MarkdownView doc={docOf(output('5', 'notes.md'))} />);
		expect(await screen.findByText(/Showing the first 256 KiB/)).toBeInTheDocument();
		unmount();
		api.text.mockRejectedValueOnce({ detail: 'Not found' });
		renderWithClient(<MarkdownView doc={docOf(output('6', 'other.md'))} />);
		expect(await screen.findByText(/Could not show this file: Not found/)).toBeInTheDocument();
	});
});
