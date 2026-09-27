import { describe, expect, it } from 'vitest';
import { artifactDocument } from './ArtifactPanel';

describe('artifactDocument', () => {
	it('wraps a bare svg in a page and leaves html alone', () => {
		expect(artifactDocument('<svg viewBox="0 0 1 1"></svg>')).toContain('<body');
		expect(artifactDocument('<p>hi</p>')).toBe('<p>hi</p>');
	});
});
