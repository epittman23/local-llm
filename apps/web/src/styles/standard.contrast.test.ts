import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	CONTRAST_RULES,
	contrastRatio,
	luminanceRatio,
	type Oklch,
	parseOklch,
	srgb8Luminance,
	toHex
} from '@/lib/ui/contrast';

// The standard's colour promises (docs/guides/ui-standard.md, COL-2, COL-4,
// COL-5), checked against the token values in standard.css itself.

// Vitest runs from apps/web (as `bun run test:unit` and CI do). Read from disk,
// not through Vite: its CSS pipeline would hand back processed output.
const css = readFileSync(resolve(process.cwd(), 'src/styles/standard.css'), 'utf8');

/** The custom properties declared in the first block that opens with `selector {`. */
function tokens(selector: string): Record<string, string> {
	const start = css.indexOf(`\n${selector} {`);
	if (start < 0) throw new Error(`no ${selector} block in standard.css`);
	const body = css.slice(start, css.indexOf('\n}', start));
	return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const light = tokens(':root');
const dark = { ...light, ...tokens('.dark') };
// Black (OLED) changes the page and the three surfaces under the dark theme.
const black = { ...dark, ...tokens('.oled') };
const themes: Record<string, Record<string, string>> = { light, dark, black };

function color(theme: string, name: string): Oklch {
	const parsed = parseOklch(themes[theme][name] ?? '');
	if (!parsed) throw new Error(`${name} is not an oklch() colour in the ${theme} theme`);
	return parsed;
}

describe('the interface standard’s colour tokens', () => {
	it('defines every dark token the light theme defines', () => {
		const colours = Object.keys(light).filter((name) => parseOklch(light[name]));
		expect(colours.filter((name) => !(name in tokens('.dark')))).toEqual([]);
	});

	for (const theme of ['dark', 'black', 'light']) {
		it.each(CONTRAST_RULES)(`${theme}: $foreground on $background is at least $minimum:1 ($rule)`, (rule) => {
			const ratio = contrastRatio(color(theme, rule.foreground), color(theme, rule.background));
			expect(ratio, `measured ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(rule.minimum);
		});

		it(`${theme}: each surface is lighter or darker than the one below it`, () => {
			const steps = ['--page', '--surface-1', '--surface-2', '--surface-3'].map((name) => color(theme, name).l);
			// Dark raises surfaces; light's raised surfaces are white and --surface-3 is the tinted fill.
			if (theme !== 'light') expect(steps).toEqual([...steps].sort((a, b) => a - b));
			expect(new Set(steps).size).toBe(steps.length);
		});
	}
});

describe('the contrast helpers', () => {
	it('parse oklch with and without alpha, and reject anything else', () => {
		expect(parseOklch('oklch(0.5 0.1 200)')).toEqual({ l: 0.5, c: 0.1, h: 200, alpha: 1 });
		expect(parseOklch('oklch(1 0 0 / 10%)')?.alpha).toBeCloseTo(0.1);
		expect(parseOklch('oklch(1 0 0 / 0.4)')?.alpha).toBeCloseTo(0.4);
		expect(parseOklch('#fff')).toBeNull();
	});
	it('measure black on white as 21:1 and convert to hex', () => {
		const black = { l: 0, c: 0, h: 0, alpha: 1 };
		const white = { l: 1, c: 0, h: 0, alpha: 1 };
		expect(contrastRatio(black, white)).toBeCloseTo(21, 1);
		expect(toHex(white)).toBe('#ffffff');
		expect(toHex(black)).toBe('#000000');
		expect(luminanceRatio(srgb8Luminance(0, 0, 0), srgb8Luminance(255, 255, 255))).toBeCloseTo(21, 1);
		expect(srgb8Luminance(10, 10, 10)).toBeLessThan(srgb8Luminance(128, 128, 128));
	});
});
