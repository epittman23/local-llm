/** The most lines either side of a comparison may have; more is `tooLarge`. */
export const DIFF_MAX_LINES = 5000;
/** The most edits (added plus removed lines) searched for; a comparison needing more is `tooDifferent`. */
export const DIFF_MAX_EDITS = 2000;

export type DiffLine = {
	kind: 'same' | 'add' | 'del';
	text: string;
	/** 1-based line number in the "from" text; null for an added line. */
	oldNo: number | null;
	/** 1-based line number in the "to" text; null for a removed line. */
	newNo: number | null;
};

export type LineDiff =
	| {
			status: 'ok';
			lines: DiffLine[];
			added: number;
			removed: number;
			/** One text has CRLF line ends and the other does not. */
			lineEndingsDiffer: boolean;
			/** Exactly one text ends with a line end. */
			finalNewlineDiffers: boolean;
	  }
	| { status: 'tooLarge' }
	| { status: 'tooDifferent' };

/** A text's lines as a person counts them: CRLF is LF, and a final line end does not start another line. */
function linesOf(text: string): string[] {
	if (text === '') return [];
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	if (lines[lines.length - 1] === '') lines.pop();
	return lines;
}

type Op = { kind: 'same' | 'add' | 'del'; text: string };

/**
 * Myers' O(ND) shortest edit script between two line lists, in order, or null
 * when it needs more than `DIFF_MAX_EDITS` edits. Each step keeps only the
 * furthest-reaching points it can still be asked about, so memory is O(D^2).
 */
function edits(a: string[], b: string[]): Op[] | null {
	const n = a.length;
	const m = b.length;
	const dMax = Math.min(DIFF_MAX_EDITS, n + m);
	const off = dMax + 1;
	const v = new Int32Array(2 * dMax + 3);
	const trace: Int32Array[] = [];
	for (let d = 0; d <= dMax; d++) {
		// What step d reads: the points step d - 1 reached, for k from -d - 1 to d + 1.
		trace.push(v.slice(off - d - 1, off + d + 2));
		for (let k = -d; k <= d; k += 2) {
			let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[off + k] = x;
			if (x >= n && y >= m) return script(a, b, trace);
		}
	}
	return null;
}

/** Walks the saved steps back from the end to the start. */
function script(a: string[], b: string[], trace: Int32Array[]): Op[] {
	const ops: Op[] = [];
	let x = a.length;
	let y = b.length;
	for (let d = trace.length - 1; d >= 0; d--) {
		const at = (k: number) => trace[d][k + d + 1];
		const k = x - y;
		const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
		const prevX = d === 0 ? 0 : at(prevK);
		const prevY = d === 0 ? 0 : prevX - prevK;
		while (x > prevX && y > prevY) {
			ops.push({ kind: 'same', text: a[x - 1] });
			x--;
			y--;
		}
		if (d > 0) ops.push(x === prevX ? { kind: 'add', text: b[y - 1] } : { kind: 'del', text: a[x - 1] });
		x = prevX;
		y = prevY;
	}
	return ops.reverse();
}

/**
 * A line diff of two texts (CNV-9): the lines of `to` in order, each kept,
 * added, or with the removed lines of `from` among them, numbered in both.
 * Pure, with two bounds so a hostile or huge input cannot hold the page:
 * more than `DIFF_MAX_LINES` lines on a side is `tooLarge`, and more than
 * `DIFF_MAX_EDITS` changed lines is `tooDifferent`.
 */
export function lineDiff(from: string, to: string): LineDiff {
	const a = linesOf(from);
	const b = linesOf(to);
	if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) return { status: 'tooLarge' };

	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const middle = edits(a.slice(start, endA), b.slice(start, endB));
	if (middle === null) return { status: 'tooDifferent' };

	const ops: Op[] = [
		...a.slice(0, start).map((text): Op => ({ kind: 'same', text })),
		...middle,
		...a.slice(endA).map((text): Op => ({ kind: 'same', text }))
	];
	let oldNo = 0;
	let newNo = 0;
	let added = 0;
	let removed = 0;
	const lines = ops.map((op): DiffLine => {
		if (op.kind !== 'add') oldNo++;
		if (op.kind !== 'del') newNo++;
		if (op.kind === 'add') added++;
		if (op.kind === 'del') removed++;
		return { ...op, oldNo: op.kind === 'add' ? null : oldNo, newNo: op.kind === 'del' ? null : newNo };
	});
	return {
		status: 'ok',
		lines,
		added,
		removed,
		lineEndingsDiffer: from.includes('\r\n') !== to.includes('\r\n'),
		finalNewlineDiffers: from !== '' && to !== '' && from.endsWith('\n') !== to.endsWith('\n')
	};
}
