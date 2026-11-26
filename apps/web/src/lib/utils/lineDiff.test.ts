import { describe, expect, it } from 'vitest';
import { DIFF_MAX_LINES, type DiffLine, lineDiff } from './lineDiff';

const ok = (from: string, to: string) => {
	const result = lineDiff(from, to);
	if (result.status !== 'ok') throw new Error(`expected a diff, got ${result.status}`);
	return result;
};
const summary = (lines: DiffLine[]) =>
	lines.map((l) => `${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${l.text}`);
const numbered = (n: number, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join('\n');

describe('lineDiff', () => {
	it('has no changes for identical texts', () => {
		const result = ok('a\nb\n', 'a\nb\n');
		expect(result.added).toBe(0);
		expect(result.removed).toBe(0);
		expect(result.lines.every((l) => l.kind === 'same')).toBe(true);
	});

	it('finds a pure addition with its new line number', () => {
		const result = ok('a\nc\n', 'a\nb\nc\n');
		expect(summary(result.lines)).toEqual([' a', '+b', ' c']);
		expect(result.lines[1]).toMatchObject({ oldNo: null, newNo: 2 });
		expect(result.lines[2]).toMatchObject({ oldNo: 2, newNo: 3 });
		expect([result.added, result.removed]).toEqual([1, 0]);
	});

	it('finds a pure deletion with its old line number', () => {
		const result = ok('a\nb\nc\n', 'a\nc\n');
		expect(summary(result.lines)).toEqual([' a', '-b', ' c']);
		expect(result.lines[1]).toMatchObject({ oldNo: 2, newNo: null });
		expect([result.added, result.removed]).toEqual([0, 1]);
	});

	it('shows a replaced line as a removal and an addition', () => {
		const result = ok('x = 1\ny = 2\n', 'x = 1\ny = 3\n');
		expect(summary(result.lines)).toEqual([' x = 1', '-y = 2', '+y = 3']);
	});

	it('shows a moved block as removed in one place and added in the other', () => {
		const result = ok('a\nb\nc\nd\n', 'c\nd\na\nb\n');
		expect([result.added, result.removed]).toEqual([2, 2]);
		expect(summary(result.lines).filter((l) => l[0] !== ' ')).toHaveLength(4);
	});

	it('reports a final newline that only one text has, with no line change', () => {
		const result = ok('a\nb', 'a\nb\n');
		expect([result.added, result.removed]).toEqual([0, 0]);
		expect(result.finalNewlineDiffers).toBe(true);
		expect(ok('a\n', 'a\n').finalNewlineDiffers).toBe(false);
	});

	it('treats CRLF as LF and says the line endings differ', () => {
		const result = ok('a\r\nb\r\n', 'a\nb\n');
		expect([result.added, result.removed]).toEqual([0, 0]);
		expect(result.lineEndingsDiffer).toBe(true);
		expect(ok('a\nb\n', 'a\nb\n').lineEndingsDiffer).toBe(false);
	});

	it('handles an empty text on either side', () => {
		expect(summary(ok('', 'a\nb\n').lines)).toEqual(['+a', '+b']);
		expect(summary(ok('a\nb\n', '').lines)).toEqual(['-a', '-b']);
		expect(ok('', '').lines).toEqual([]);
	});

	it('keeps a blank line as a line', () => {
		expect(summary(ok('a\n\nb\n', 'a\nb\n').lines)).toEqual([' a', '-', ' b']);
	});

	it('rebuilds the new text from the kept and added lines, and the old from the kept and removed', () => {
		const from = 'one\ntwo\nthree\nfour\nfive\nsix\n';
		const to = 'zero\none\nthree\nfour\nFIVE\nsix\nseven\n';
		const { lines } = ok(from, to);
		expect(lines.filter((l) => l.kind !== 'del').map((l) => l.text)).toEqual(to.trimEnd().split('\n'));
		expect(lines.filter((l) => l.kind !== 'add').map((l) => l.text)).toEqual(from.trimEnd().split('\n'));
	});

	it('numbers every line of both sides in order', () => {
		const { lines } = ok('a\nb\nc\nd\n', 'a\nx\nc\ny\nz\n');
		expect(lines.map((l) => l.oldNo).filter((n) => n !== null)).toEqual([1, 2, 3, 4]);
		expect(lines.map((l) => l.newNo).filter((n) => n !== null)).toEqual([1, 2, 3, 4, 5]);
	});

	it('is too large past the line cap on either side, and fine at it', () => {
		expect(lineDiff(numbered(DIFF_MAX_LINES + 1), 'a').status).toBe('tooLarge');
		expect(lineDiff('a', numbered(DIFF_MAX_LINES + 1)).status).toBe('tooLarge');
		expect(lineDiff(numbered(DIFF_MAX_LINES), numbered(DIFF_MAX_LINES)).status).toBe('ok');
	});

	it('gives up quickly on two long texts with nothing in common', () => {
		const started = performance.now();
		const result = lineDiff(numbered(4000, 'left'), numbered(4000, 'right'));
		expect(result.status).toBe('tooDifferent');
		expect(performance.now() - started).toBeLessThan(1000);
	});

	it('still diffs a large text with a few scattered changes', () => {
		const from = numbered(4000);
		const to = from.replace('line 10\n', 'ten\n').replace('line 3000\n', '');
		const result = ok(from, to);
		expect([result.added, result.removed]).toEqual([1, 2]);
	});
});
