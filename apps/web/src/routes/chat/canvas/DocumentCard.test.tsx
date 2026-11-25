import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CanvasContext } from './CanvasContext';
import { DocumentCard } from './DocumentCard';
import { blockDoc, content, docOf, output } from './testing';

const card = (doc: ReturnType<typeof docOf>, ctx: { openId: string | null; open: (id: string) => void } | null) =>
	render(
		<CanvasContext.Provider value={ctx}>
			<DocumentCard document={doc} />
		</CanvasContext.Provider>
	);

describe('DocumentCard', () => {
	it('is a button with the name, kind and size, that opens its document', () => {
		const open = vi.fn();
		const doc = docOf(output('e', 'report.html', {}, { size: 2048 }));
		card(doc, { openId: null, open });
		const button = screen.getByRole('button', { name: /report\.html/ });
		expect(button).toHaveTextContent('HTML, 2.0 kB');
		expect(button).not.toHaveAttribute('aria-current');
		fireEvent.click(button);
		expect(open).toHaveBeenCalledWith(doc.id);
	});

	it('shows the cleaned name, never the raw sandbox path', () => {
		card(docOf(output('d', 'invoice_fdp.exe', { sandbox_path: '/workspace/outputs/invoice‮fdp.exe' })), null);
		expect(screen.getByRole('button')).toHaveTextContent('invoice_fdp.exe');
		expect(screen.getByRole('button').textContent).not.toContain('‮');
	});

	it('marks the open document’s card', () => {
		const doc = docOf(output('e', 'report.html'));
		card(doc, { openId: doc.id, open: vi.fn() });
		expect(screen.getByRole('button')).toHaveAttribute('aria-current', 'true');
	});

	it('keeps a thumbnail for an image, as an <img> and never inline', () => {
		const { container } = card(docOf(output('a', 'chart.svg')), null);
		expect(container.querySelector('img')).toHaveAttribute('src', content('a'));
		expect(container.querySelector('svg:not(.lucide)')).toBeNull();
	});

	it('reads "Writing…" for a block that is not closed yet', () => {
		card(blockDoc('<p>he', 'html', false), null);
		expect(screen.getByRole('button')).toHaveTextContent('Writing…');
		expect(screen.getByRole('button')).not.toHaveTextContent('HTML,');
	});
});
