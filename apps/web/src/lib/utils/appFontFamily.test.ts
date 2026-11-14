import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/styles/global.css', 'utf8');

describe('global stylesheet font', () => {
	it('reads --app-font-family, falling back to the default font stack', () => {
		expect(css).toContain('--font-sans: var(--app-font-family, var(--font-ui));');
	});

	it('applies font-sans to the root element', () => {
		expect(css).toMatch(/html\s*\{\s*@apply font-sans;/);
	});
});
