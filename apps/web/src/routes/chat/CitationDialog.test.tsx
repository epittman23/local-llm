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
