import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { content, docsOf, id, output, renderWithClient } from '../testing';
import { PdfView } from './PdfView';

const pdfFiles = () => [
	output('10', 'paper.pdf'),
	output('12', 'page-2.png', { preview_of: id('10'), preview_page: 2, sandbox_path: '/workspace/outputs/paper.pdf' }),
	output('11', 'page-1.png', { preview_of: id('10'), preview_page: 1, sandbox_path: '/workspace/outputs/paper.pdf' }),
	output('13', 'page-1.png', { preview_of: id('99'), preview_page: 1, sandbox_path: '/workspace/outputs/gone.pdf' })
];

describe('PdfView', () => {
	it('shows a PDF as its preview pages in page order', () => {
		const docs = docsOf(pdfFiles());
		// The orphan preview (its PDF is not on the list) is a document of its own, an image.
		expect(docs.map((d) => d.kind)).toEqual(['pdf', 'image']);
		renderWithClient(<PdfView doc={docs[0]} />);
		expect(screen.getAllByRole('img').map((i) => [i.getAttribute('src'), i.getAttribute('alt')])).toEqual([
			[content('11'), 'paper.pdf, page 1'],
			[content('12'), 'paper.pdf, page 2']
		]);
	});

	it('is a download when it has no previews', () => {
		renderWithClient(<PdfView doc={docsOf([output('10', 'paper.pdf')])[0]} />);
		expect(screen.queryByRole('img')).toBeNull();
		expect(screen.getByRole('link', { name: 'Download paper.pdf' })).toHaveAttribute('download', 'paper.pdf');
	});
});
