import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import saveAs from 'file-saver';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ArtifactDownload, ArtifactPanel, artifactDocument } from './ArtifactPanel';

vi.mock('file-saver', () => ({ default: vi.fn() }));
afterEach(cleanup);

describe('artifactDocument', () => {
	it('wraps a bare svg in a page and leaves html alone', () => {
		expect(artifactDocument('<svg viewBox="0 0 1 1"></svg>')).toContain('<body');
		expect(artifactDocument('<p>hi</p>')).toBe('<p>hi</p>');
	});
});

describe('ArtifactPanel', () => {
	it('is the side panel’s body: the sandboxed frame alone, scripts allowed and no same origin', () => {
		render(createElement(ArtifactPanel, { code: '<p>hi</p>' }));
		expect(screen.queryByRole('complementary')).toBeNull();
		const frame = screen.getByTitle('Artifact preview');
		expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-modals');
		expect(frame.getAttribute('srcdoc')).toBe('<p>hi</p>');
	});

	it('downloads the previewed page from the panel header', async () => {
		render(createElement(TooltipProvider, null, createElement(ArtifactDownload, { code: '<svg></svg>' })));
		fireEvent.click(screen.getByRole('button', { name: 'Download preview' }));
		const [blob, name] = vi.mocked(saveAs).mock.calls[0] as unknown as [Blob, string];
		expect(name).toBe('artifact.html');
		expect(await blob.text()).toContain('<svg></svg></body>');
	});
});
