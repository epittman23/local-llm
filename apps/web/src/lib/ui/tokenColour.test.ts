import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { colourHex, SERIES_TOKENS, seriesHexes, tokenHex } from './tokenColour';

const css = readFileSync(resolve(process.cwd(), 'src/styles/standard.css'), 'utf8');
const dark = css.slice(css.indexOf('\n.dark {'), css.indexOf('\n}', css.indexOf('\n.dark {')));
const darkValue = (token: string) => new RegExp(`${token}:\\s*([^;]+);`).exec(dark)?.[1] ?? '';

afterEach(() => document.documentElement.removeAttribute('style'));

describe('colourHex', () => {
	it('converts an oklch() token value to #rrggbb', () => {
		expect(colourHex('oklch(0.8 0.09 235)')).toBe('#82c7f0');
		expect(colourHex(' oklch(0.48 0.115 245) ')).toBe('#0e629a');
	});

	it('keeps a hex colour, lower-cased, and refuses anything else', () => {
		expect(colourHex('#3B82F6')).toBe('#3b82f6');
		expect(colourHex('')).toBeNull();
		expect(colourHex('var(--series-1)')).toBeNull();
		expect(colourHex('#fff')).toBeNull();
	});
});

describe('tokenHex', () => {
	it('reads the token on the page now, in the current theme', () => {
		document.documentElement.style.setProperty('--series-1', 'oklch(0.48 0.115 245)');
		expect(tokenHex('--series-1', '#000000')).toBe('#0e629a');
	});

	it('falls back when the page has no such token', () => {
		expect(tokenHex('--series-1', '#82c7f0')).toBe('#82c7f0');
	});
});

describe('the series tokens', () => {
	it('fall back to the dark theme’s values in standard.css, in order', () => {
		expect(SERIES_TOKENS.map(([token]) => token)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `--series-${n}`));
		for (const [token, fallback] of SERIES_TOKENS) expect(colourHex(darkValue(token)), token).toBe(fallback);
		expect(seriesHexes()).toEqual(SERIES_TOKENS.map(([, fallback]) => fallback));
	});
});
