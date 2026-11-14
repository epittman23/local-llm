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
//
// The baseline lists the patterns it has counted (`patterns`). A pattern added
// here and not yet listed there is new: the update records its counts as they
// stand, the one time a count may start above zero, so adding a pattern needs
// the owner's acceptance of its starting counts (docs/guides/ui-standard.md,
// "The ratchet"). A listed pattern is never recorded from scratch again.

const PALETTE =
	'white|black|(?:gray|neutral|zinc|slate|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3}';

/**
 * The whole JSX opening tag that starts at `start` (`<input ... />`): up to the
 * first `>` outside braces and quotes, so `onChange={(e) => ...}` does not end it.
 */
function tagAt(text: string, start: number): string {
	let depth = 0;
	let quote = '';
	for (let i = start + 1; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === quote) quote = '';
		} else if (c === '"' || c === "'" || c === '`') {
			quote = c;
		} else if (c === '{') {
			depth++;
		} else if (c === '}') {
			depth--;
		} else if (c === '>' && depth === 0) {
			return text.slice(start, i + 1);
		}
	}
	return text.slice(start);
}

/** A file input and a hidden input: nothing in components/ui replaces them (FRM-4). */
const SHARED_CANNOT_REPLACE = /\stype=(?:["'](?:file|hidden)["']|\{\s*["'](?:file|hidden)["']\s*\})/;

const PATTERNS: Record<string, { rule: string; pattern: RegExp; skip?: (tag: string) => boolean }> = {
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
	'dark-one-off': { rule: 'COL-1', pattern: /\bdark:[a-z[]/g },
	// Partial opacity (5 to 95, or an arbitrary value) under any variant; 0 and 100 (show, hide) are not counted.
	// Whether the element holds text cannot be read from the source, so this counts every use: on text it breaks
	// COL-2; on a picture or a decoration it is still counted, and the count records it.
	'text-opacity': { rule: 'COL-2', pattern: /(?<![\w-])opacity-(?:[1-9]\d?|\[[^\]\s]+\])(?![\w-])/g },
	'native-select': { rule: 'FRM-4', pattern: /<select\b/g },
	'raw-input': { rule: 'FRM-4', pattern: /<input\b/g, skip: (tag) => SHARED_CANNOT_REPLACE.test(tag) }
};

/** How many times `name`'s pattern occurs in `text`. */
function occurrences(name: string, text: string): number {
	const { pattern, skip } = PATTERNS[name];
	return [...text.matchAll(pattern)].filter((m) => !skip?.(tagAt(text, m.index ?? 0))).length;
}

type Counts = Record<string, Record<string, number>>;
interface Baseline {
	patterns: string[];
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
		for (const name of Object.keys(PATTERNS)) {
			const found = occurrences(name, text);
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

	const differences = (compare: (found: number, allowed: number) => boolean, names = Object.keys(PATTERNS)) =>
		names.flatMap((name) => {
			const { rule } = PATTERNS[name];
			const files = new Set([...Object.keys(now[name] ?? {}), ...Object.keys(baseline.counts[name] ?? {})]);
			return [...files]
				.map((file) => ({ file, found: now[name]?.[file] ?? 0, allowed: baseline.counts[name]?.[file] ?? 0 }))
				.filter(({ found, allowed }) => compare(found, allowed))
				.map(({ file, found, allowed }) => `${file}: ${name} (${rule}) ${found}, baseline ${allowed}`);
		});

	if (process.env.UPDATE_UI_BASELINE) {
		it('records lower counts in the baseline, and refuses to raise any', () => {
			// An empty baseline is the first recording; after that a count never rises, except
			// under a pattern the baseline has not counted before (see the top of this file).
			const first = Object.keys(baseline.counts).length === 0;
			const known = Object.keys(PATTERNS).filter((name) => (baseline.patterns ?? []).includes(name));
			if (!first) expect(differences((found, allowed) => found > allowed, known)).toEqual([]);
			const patterns = Object.keys(PATTERNS).sort();
			writeFileSync(
				BASELINE,
				`${JSON.stringify({ patterns, exceptions: baseline.exceptions, counts: sorted(now) }, null, '\t')}\n`
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

	it('has counted every pattern: a new one is recorded once, with the owner’s acceptance of its counts', () => {
		expect([...baseline.patterns].sort()).toEqual(Object.keys(PATTERNS).sort());
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

describe('the ratchet’s patterns', () => {
	it('text-opacity counts partial opacity under any variant, and not show, hide or other utilities', () => {
		const counted = [
			'<span className="opacity-50">(optional)</span>',
			'className="disabled:opacity-60"',
			"cn('text-sm', !on && 'opacity-5')",
			'className="group-hover:opacity-95"',
			'className="opacity-[0.6]"'
		];
		for (const text of counted) expect(occurrences('text-opacity', text), text).toBe(1);
		const ignored = [
			'className="opacity-0 group-hover:opacity-100"',
			'className="bg-success/50 text-foreground"',
			'className="hover:opacity-100"',
			'style={{ opacity: 0.25 }}',
			'className="myopacity-50 opacity-50x"'
		];
		for (const text of ignored) expect(occurrences('text-opacity', text), text).toBe(0);
		expect(occurrences('text-opacity', 'className="opacity-40 disabled:opacity-50"')).toBe(2);
	});

	it('native-select counts a native select, not the shared Select or a word', () => {
		expect(occurrences('native-select', '<select value={v} onChange={(e) => set(e.target.value)}>')).toBe(1);
		expect(occurrences('native-select', '<Select value={v}><SelectTrigger /></Select>')).toBe(0);
		expect(occurrences('native-select', 'const selected = <selection />;')).toBe(0);
	});

	it('raw-input counts a native input the shared ones can replace, wherever its type is written', () => {
		const counted = [
			'<input value={q} />',
			'<input type="checkbox" checked={on} />',
			'<input type="color" value={c} />',
			'<input onChange={(e) => pick(e.target.value)} type="range" />',
			'<input\n\tclassName="w-full"\n\tplaceholder="Search"\n/>'
		];
		for (const text of counted) expect(occurrences('raw-input', text), text).toBe(1);
		const ignored = [
			'<input type="file" hidden />',
			'<input ref={ref} onChange={(e) => pick(e.target.files)} type="file" accept="image/*" />',
			'<input type={\'hidden\'} name="csrf" />',
			'<input name="x" type="hidden" value={token} />',
			'<Input value={q} />',
			'<inputs />'
		];
		for (const text of ignored) expect(occurrences('raw-input', text), text).toBe(0);
		expect(occurrences('raw-input', '<input data-type="file" />')).toBe(1);
	});

	it('reads a whole JSX tag, past arrows and quoted angle brackets', () => {
		const text = 'a <input onChange={(e) => go(e)} title="x > y" type="file" /> b';
		expect(tagAt(text, text.indexOf('<input'))).toBe('<input onChange={(e) => go(e)} title="x > y" type="file" />');
	});
});
