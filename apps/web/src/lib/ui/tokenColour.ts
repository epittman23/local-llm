// A token's colour as `#rrggbb`, for the few places that must store or draw a
// fixed colour instead of styling with the token: a new user's generated
// picture (drawn to a canvas and saved as an image) and a new calendar's
// colour (saved as a string, and edited in an `<input type="color">`, which
// only takes hex). Decision D1b of 2026-11-14 (#989): new ones take the
// current theme's token values; stored ones are left as they are.

import { parseOklch, toHex } from './contrast';

/** `oklch(L C H)` as `#rrggbb`; a hex colour as it is (lower-cased); null for anything else. */
export function colourHex(value: string): string | null {
	const text = value.trim().toLowerCase();
	if (/^#[0-9a-f]{6}$/.test(text)) return text;
	const oklch = parseOklch(text);
	return oklch ? toHex(oklch) : null;
}

/**
 * The value of the custom property `name` (such as `--series-1`) on the page
 * now, in the current theme, as `#rrggbb`; `fallback` when the page has no
 * such token or it is not a colour this can read (a test without the styles).
 */
export function tokenHex(name: string, fallback: string): string {
	const value = getComputedStyle(document.documentElement).getPropertyValue(name);
	return colourHex(value) ?? fallback;
}

/** The six chart-series tokens, in order, with the dark theme's values as the fallback. */
export const SERIES_TOKENS: ReadonlyArray<readonly [token: string, fallback: string]> = [
	['--series-1', '#82c7f0'],
	['--series-2', '#e4c062'],
	['--series-3', '#e492c9'],
	['--series-4', '#83d494'],
	['--series-5', '#eb9a75'],
	['--series-6', '#b5a4ea']
];

/** The series tokens' current values, `--series-1` first. */
export const seriesHexes = (): string[] => SERIES_TOKENS.map(([token, fallback]) => tokenHex(token, fallback));
