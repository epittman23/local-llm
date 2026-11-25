import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { content, docsOf, output, renderWithClient } from '../testing';
import { ImageView } from './ImageView';

describe('ImageView', () => {
	it('shows PNG, JPEG and SVG files only as <img> from the content route', () => {
		const docs = docsOf([
			output('a', 'plot.png'),
			output('b', 'photo.JPEG'),
			output('c', 'chart.svg', { content_type: 'image/svg+xml' })
		]);
		expect(docs.map((d) => d.kind)).toEqual(['image', 'image', 'image']);
		for (const doc of docs) {
			const { container, unmount } = renderWithClient(<ImageView doc={doc} />);
			expect(screen.getByRole('img', { name: doc.name })).toHaveAttribute('src', content(doc.id.slice(-1)));
			// Never inline: no <svg> of the model's, no frame.
			expect(container.querySelector('svg:not(.lucide)')).toBeNull();
			expect(container.querySelector('iframe')).toBeNull();
			unmount();
		}
	});

	it('sits on the theme’s surface and fits the canvas', () => {
		const { container } = renderWithClient(<ImageView doc={docsOf([output('a', 'plot.png')])[0]} />);
		expect(container.firstElementChild).toHaveClass('bg-surface-1');
		expect(screen.getByRole('img')).toHaveClass('max-h-full', 'max-w-full');
	});
});
