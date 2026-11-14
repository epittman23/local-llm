import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The interface standard's ratchet (docs/guides/ui-standard.md, "Verifying a
// change"). It counts, per file, the patterns the standard forbids and
// compares them with ui-standard-baseline.json. A count may only fall:
//
// - more than the baseline allows fails, naming the file and the rule;
// - fewer also fails, until the baseline is lowered to match, so progress is
//   recorded and cannot be undone silently.
//
// After removing some, record the lower counts with
//   UPDATE_UI_BASELINE=1 bunx vitest run src/styles/standard.ratchet.test.ts
// which refuses to raise any count. A use the owner has accepted as a
// justified exception is listed, with its reason, under `exceptions` in the
// baseline, and is the only way a count stays above zero for good.

const PALETTE =
	'white|black|(?:gray|neutral|zinc|slate|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3}';

const PATTERNS: Record<string, { rule: string; pattern: RegExp }> = {
	'palette-colour': {
		rule: 'COL-1',
		pattern: new RegExp(
			`\\b(?:bg|text|border|ring|outline|fill|stroke|from|to|via|divide|decoration|placeholder|caret|accent|shadow)-(?:${PALETTE})\\b`,
			'g'
		)
	},
	'text-colour-opacity': { rule: 'COL-2', pattern: /\btext-(?:muted-)?foreground\/\d+/g },
	'arbitrary-text-size': { rule: 'TYP-2', pattern: /\btext-\[[\d.]+(?:px|rem|em)\]/g },
	'outline-removed': { rule: 'A11Y-1', pattern: /\boutline-(?:none|hidden)\b/g },
	'raw-button': { rule: 'ACT-6', pattern: /<button\b/g },
	'dark-one-off': { rule: 'COL-1', pattern: /\bdark:[a-z[]/g }
};

type Counts = Record<string, Record<string, number>>;
interface Baseline {
	exceptions: Array<{ file: string; pattern: string; count: number; reason: string }>;
	counts: Counts;
}

// Vitest runs from apps/web.
const SRC = resolve(process.cwd(), 'src');
const BASELINE = resolve(process.cwd(), 'ui-standard-baseline.json');

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			// components/ui is shadcn's output; the conformance layer in standard.css brings it to the standard.
			return path === join(SRC, 'components', 'ui') ? [] : sources(path);
		}
		return /\.(?:tsx|ts|astro)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
	});
}

function count(): Counts {
	const counts: Counts = {};
	for (const file of sources(SRC)) {
		const text = readFileSync(file, 'utf8');
		for (const [name, { pattern }] of Object.entries(PATTERNS)) {
			const found = text.match(pattern)?.length ?? 0;
			if (found === 0) continue;
			counts[name] ??= {};
			counts[name][relative(process.cwd(), file)] = found;
		}
	}
	return counts;
}

const sorted = (counts: Counts): Counts =>
	Object.fromEntries(
		Object.keys(counts)
			.sort()
			.map((name) => [name, Object.fromEntries(Object.entries(counts[name]).sort(([a], [b]) => a.localeCompare(b)))])
	);

describe('the interface standard’s ratchet', () => {
	const now = count();
	const baseline: Baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));

	const differences = (compare: (found: number, allowed: number) => boolean) =>
		Object.entries(PATTERNS).flatMap(([name, { rule }]) => {
			const files = new Set([...Object.keys(now[name] ?? {}), ...Object.keys(baseline.counts[name] ?? {})]);
			return [...files]
				.map((file) => ({ file, found: now[name]?.[file] ?? 0, allowed: baseline.counts[name]?.[file] ?? 0 }))
				.filter(({ found, allowed }) => compare(found, allowed))
				.map(({ file, found, allowed }) => `${file}: ${name} (${rule}) ${found}, baseline ${allowed}`);
		});

	if (process.env.UPDATE_UI_BASELINE) {
		it('records lower counts in the baseline, and refuses to raise any', () => {
			// An empty baseline is the first recording; after that a count never rises.
			const first = Object.keys(baseline.counts).length === 0;
			if (!first) expect(differences((found, allowed) => found > allowed)).toEqual([]);
			writeFileSync(
				BASELINE,
				`${JSON.stringify({ exceptions: baseline.exceptions, counts: sorted(now) }, null, '\t')}\n`
			);
		});
		return;
	}

	it('finds no file with more of a forbidden pattern than the baseline allows', () => {
		expect(differences((found, allowed) => found > allowed)).toEqual([]);
	});

	it('has a baseline as low as the code: lower it after removing some (see the top of this file)', () => {
		expect(differences((found, allowed) => found < allowed)).toEqual([]);
	});

	it('explains every count the owner has accepted as an exception', () => {
		for (const exception of baseline.exceptions) {
			expect(PATTERNS[exception.pattern], exception.pattern).toBeDefined();
			expect(exception.reason.length, `${exception.file}: a reason`).toBeGreaterThan(20);
			expect(now[exception.pattern]?.[exception.file] ?? 0, `${exception.file}: ${exception.pattern}`).toBe(
				exception.count
			);
		}
	});
});
