import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Citation } from '@/lib/chat/sources';
import { CitationDialog } from './CitationDialog';

const citation = (text: string): Citation => ({
	id: 'https://a.example/doc',
	source: { name: 'A doc', url: 'https://a.example/doc' },
	document: [text],
	metadata: [{ source: 'https://a.example/doc' }],
	distances: [0.5]
});

afterEach(cleanup);

describe('CitationDialog', () => {
	it('shows a long excerpt cut, with a button to show all of it', () => {
		render(<CitationDialog source={citation('y'.repeat(1600))} onClose={vi.fn()} />);
		const excerpt = () => screen.getByText(/^y+/);
		expect(excerpt().textContent?.startsWith('y'.repeat(1500))).toBe(true);
		expect(excerpt().textContent).not.toContain('y'.repeat(1501));
		fireEvent.click(screen.getByRole('button', { name: 'Show all (1600 characters)' }));
		expect(excerpt().textContent).toContain('y'.repeat(1600));
		expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
	});

	it('shows a short excerpt whole, without the button', () => {
		render(<CitationDialog source={citation('short text')} onClose={vi.fn()} />);
		expect(screen.getByText('short text')).toBeTruthy();
		expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
	});
});

describe('CitationDialog, Open in canvas', () => {
	const file = '00000000-0000-4000-8000-000000000077';
	const of = (metadata: Record<string, unknown>): Citation => ({
		id: 'x',
		source: { name: 'x' },
		document: ['passage'],
		metadata: [metadata],
		distances: []
	});

	it('is offered for a passage from a knowledge file, closes the dialog and opens that file', () => {
		const onClose = vi.fn();
		const onOpenFile = vi.fn();
		render(
			<CitationDialog
				source={of({ file_id: file, name: 'notes.md', source: 'notes.md' })}
				onClose={onClose}
				onOpenFile={onOpenFile}
			/>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Open in canvas' }));
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onOpenFile).toHaveBeenCalledWith(file);
		// The link to the file stays.
		expect(screen.getByRole('link', { name: /notes\.md/ })).toHaveAttribute('href', `/api/v1/files/${file}/content`);
	});

	it('is not offered for a web page, a note, a chat or an id that is not a UUID, nor without a handler', () => {
		const none = (metadata: Record<string, unknown>) => {
			render(<CitationDialog source={of(metadata)} onClose={vi.fn()} onOpenFile={vi.fn()} />);
			expect(screen.queryByRole('button', { name: 'Open in canvas' })).toBeNull();
			cleanup();
		};
		none({ source: 'https://a.example/doc' });
		none({ file_id: file, name: 'A note' });
		none({ file_id: 'external-123', source: 'a.md' });
		render(<CitationDialog source={of({ file_id: file, source: 'a.md' })} onClose={vi.fn()} />);
		expect(screen.queryByRole('button', { name: 'Open in canvas' })).toBeNull();
	});
});
