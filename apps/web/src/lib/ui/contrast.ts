// WCAG 2 contrast for the interface standard's tokens (docs/guides/ui-standard.md,
// "Colour"). The tokens are written in OKLCH, so this converts OKLCH to sRGB
// itself: the unit test that guards the token file runs without a browser,
// and /ui uses the same code to print the ratios next to its swatches.

export interface Oklch {
	l: number;
	c: number;
	h: number;
	alpha: number;
}

/** Parses `oklch(L C H)` or `oklch(L C H / A%)`; null for anything else. */
export function parseOklch(value: string): Oklch | null {
	const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+)(%?))?\s*\)$/.exec(value.trim());
	if (!match) return null;
	const [, l, c, h, a, percent] = match;
	const alpha = a === undefined ? 1 : percent ? Number(a) / 100 : Number(a);
	return { l: Number(l), c: Number(c), h: Number(h), alpha };
}

/** Linear-light sRGB channels, clipped to the gamut. */
export function oklchToLinearSrgb({ l, c, h }: Oklch): [number, number, number] {
	const a = c * Math.cos((h * Math.PI) / 180);
	const b = c * Math.sin((h * Math.PI) / 180);
	const lp = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const mp = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const sp = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const clip = (x: number) => Math.min(1, Math.max(0, x));
	return [
		clip(4.0767416621 * lp - 3.3077115913 * mp + 0.2309699292 * sp),
		clip(-1.2684380046 * lp + 2.6097574011 * mp - 0.3413193965 * sp),
		clip(-0.0041960863 * lp - 0.7034186147 * mp + 1.707614701 * sp)
	];
}

export function relativeLuminance(color: Oklch): number {
	const [r, g, b] = oklchToLinearSrgb(color);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio of two relative luminances, from 1 to 21. */
export function luminanceRatio(a: number, b: number): number {
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** The WCAG contrast ratio of two opaque colours, from 1 to 21. */
export function contrastRatio(a: Oklch, b: Oklch): number {
	return luminanceRatio(relativeLuminance(a), relativeLuminance(b));
}

/** Relative luminance of an 8-bit sRGB colour, as a canvas reports a pixel. */
export function srgb8Luminance(r: number, g: number, b: number): number {
	const linear = (v: number) => {
		const x = v / 255;
		return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** `#rrggbb` for display beside a swatch. */
export function toHex(color: Oklch): string {
	const encode = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
	return `#${oklchToLinearSrgb(color)
		.map((x) =>
			Math.round(255 * encode(x))
				.toString(16)
				.padStart(2, '0')
		)
		.join('')}`;
}

/**
 * The promises the standard makes about colour, as (foreground, background,
 * minimum) rows. COL-2: text 4.5:1. COL-4: the edge of a control and any
 * graphic that carries meaning 3:1. COL-5: a divider between surfaces 1.3:1,
 * since adjacent surfaces differ by fill as well.
 */
export const SURFACES = ['--page', '--surface-1', '--surface-2', '--surface-3'] as const;

export interface ContrastRule {
	rule: string;
	foreground: string;
	background: string;
	minimum: number;
}

const onEvery = (rule: string, foreground: string, minimum: number, surfaces: readonly string[] = SURFACES) =>
	surfaces.map((background) => ({ rule, foreground, background, minimum }));

export const CONTRAST_RULES: ContrastRule[] = [
	...onEvery('COL-2', '--foreground-strong', 7),
	...onEvery('COL-2', '--foreground-muted', 4.5),
	...onEvery('COL-2', '--brand', 4.5),
	...onEvery('COL-2', '--success', 4.5),
	...onEvery('COL-2', '--warning', 4.5),
	...onEvery('COL-2', '--danger', 4.5),
	// Disabled text is exempt from WCAG; the standard still keeps it readable
	// on the three surfaces a disabled control can sit on.
	...onEvery('COL-2', '--foreground-disabled', 3, ['--page', '--surface-1', '--surface-2']),
	{ rule: 'COL-2', foreground: '--brand-foreground', background: '--brand', minimum: 4.5 },
	{ rule: 'COL-2', foreground: '--danger-fill-foreground', background: '--danger-fill', minimum: 4.5 },
	...onEvery('COL-4', '--border-control', 3),
	...onEvery('COL-4', '--focus', 3),
	...['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6'].flatMap((series) =>
		onEvery('COL-4', series, 3, ['--page', '--surface-1', '--surface-2'])
	),
	...onEvery('COL-5', '--border-divider', 1.3, ['--page', '--surface-1', '--surface-2'])
];
