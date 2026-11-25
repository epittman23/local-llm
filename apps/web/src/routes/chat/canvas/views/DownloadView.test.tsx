import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { content, docOf, output, renderWithClient } from '../testing';
import { DownloadView } from './DownloadView';

const api = vi.hoisted(() => ({ text: vi.fn(), html: vi.fn() }));
vi.mock('@/lib/apis/sandbox', () => ({ getSandboxOutputText: api.text, getSandboxOutputHtml: api.html }));

beforeEach(() => {
	api.text.mockReset();
	api.html.mockReset();
});

describe('DownloadView', () => {
	it('anything else is its name, its size and a download link that asks for an attachment', () => {
		const doc = docOf(output('8', 'model.pkl', { content_type: 'application/octet-stream' }, { size: 1536 }));
		expect(doc.kind).toBe('download');
		renderWithClient(<DownloadView doc={doc} />);
		expect(screen.getByText('model.pkl')).toBeInTheDocument();
		expect(screen.getByText('1.5 kB')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Download model.pkl' })).toHaveAttribute('href', content('8', true));
		expect(api.text).not.toHaveBeenCalled();
		expect(api.html).not.toHaveBeenCalled();
	});

	it('names an output with odd field types "output" and still downloads it', () => {
		const doc = docOf(
			output(
				'4',
				5 as never,
				{ content_type: 9, preview_of: {}, preview_page: 'x', sandbox_path: ['a'] },
				{ size: 'big' as never }
			)
		);
		expect(doc.name).toBe('output');
		renderWithClient(<DownloadView doc={doc} />);
		expect(screen.getByRole('link', { name: 'Download output' })).toHaveAttribute('href', content('4', true));
	});
});
