import { screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
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
	it('renders a Markdown file as the chat does, headings included', async () => {
		api.text.mockResolvedValue({
			text: '## A heading\n\nA **bold** point\n\n- one',
			truncated: false
		});
		const { container } = renderWithClient(
			<MemoryRouter>
				<MarkdownView doc={docOf(output('5', 'notes.md'))} />
			</MemoryRouter>
		);
		expect(await screen.findByRole('heading', { level: 2, name: 'A heading' })).toBeInTheDocument();
		expect(container.querySelector('strong')).toHaveTextContent('bold');
		expect(container.querySelector('li')).toHaveTextContent('one');
	});

	it('renders the first heading of a file that starts with a byte-order mark', async () => {
		api.text.mockResolvedValue({ text: '\uFEFF# Title\n\nBody', truncated: false });
		renderWithClient(
			<MemoryRouter>
				<MarkdownView doc={docOf(output('6', 'bom.md'))} />
			</MemoryRouter>
		);
		expect(await screen.findByRole('heading', { level: 1, name: 'Title' })).toBeInTheDocument();
	});

	it('says when it is cut, and when it cannot be fetched', async () => {
		api.text.mockResolvedValueOnce({ text: 'hello', truncated: true });
		const { unmount } = renderWithClient(
			<MemoryRouter>
				<MarkdownView doc={docOf(output('5', 'notes.md'))} />
			</MemoryRouter>
		);
		expect(await screen.findByText(/Showing the first 256 KiB/)).toBeInTheDocument();
		unmount();
		api.text.mockRejectedValueOnce({ detail: 'Not found' });
		renderWithClient(
			<MemoryRouter>
				<MarkdownView doc={docOf(output('6', 'other.md'))} />
			</MemoryRouter>
		);
		expect(await screen.findByText(/Could not show this file: Not found/)).toBeInTheDocument();
	});
});
