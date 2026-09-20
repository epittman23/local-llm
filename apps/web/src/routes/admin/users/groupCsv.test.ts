import { describe, expect, it } from 'vitest';
import { chunk, parseGroupCsv } from './groupCsv';

describe('parseGroupCsv', () => {
	it('reads Name,Email rows after the header, lowercasing the email', () => {
		expect(parseGroupCsv('Name,Email\nAda,ADA@X.io\r\nBob,b@x.io').validRows).toEqual([
			{ idx: 1, email: 'ada@x.io' },
			{ idx: 2, email: 'b@x.io' }
		]);
	});
	it('skips blank lines and flags rows without exactly two columns or without an email', () => {
		const { validRows, invalidRows } = parseGroupCsv('h\n\nAda\nBob,\nCy,c@x.io,extra\nDee,d@x.io');
		expect(validRows.map((r) => r.email)).toEqual(['d@x.io']);
		expect(invalidRows).toEqual([2, 3, 4]);
	});
});

describe('chunk', () => {
	it('splits into fixed-size batches, keeping the remainder', () => {
		expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
		expect(chunk([], 3)).toEqual([]);
	});
});
