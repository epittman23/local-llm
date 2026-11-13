import { describe, expect, it } from 'vitest';
import { csvCell, neutralizeFormula, parseCsvRows } from './csv';

describe('neutralizeFormula', () => {
	it.each(['=1+1', '+cmd|" /c calc"!A1', '-2+3', '@SUM(A1)', '\t=1', '\r=1'])(
		'prefixes %j so a spreadsheet reads it as text',
		(s) => {
			expect(neutralizeFormula(s)).toBe(`'${s}`);
		}
	);
	it('leaves ordinary text and plain numbers alone', () => {
		for (const s of ['hello', 'a=b', '1+1', '-1', '0', '12.5', '-3.75', '']) expect(neutralizeFormula(s)).toBe(s);
	});
});

describe('csvCell', () => {
	it('writes nullish as empty and numbers as they are (including negatives)', () => {
		expect([csvCell(null), csvCell(undefined), csvCell(42), csvCell(-1), csvCell(0)]).toEqual([
			'',
			'',
			'42',
			'-1',
			'0'
		]);
	});
	it('neutralizes a formula string, then quotes if it also needs quoting', () => {
		expect(csvCell('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
		expect(csvCell('=1+1')).toBe(`'=1+1`);
	});
	it('quotes commas, quotes and newlines', () => {
		expect(csvCell('a,b')).toBe('"a,b"');
		expect(csvCell('say "hi"')).toBe('"say ""hi"""');
		expect(csvCell('l1\nl2')).toBe('"l1\nl2"');
	});
});

describe('parseCsvRows', () => {
	it('reads quoted fields with commas, newlines and doubled quotes, over CRLF, LF and CR', () => {
		expect(parseCsvRows('a,b\r\n"x, y","say ""hi""\nthere"\r1,\n', 10)).toEqual({
			rows: [
				['a', 'b'],
				['x, y', 'say "hi"\nthere'],
				['1', '']
			],
			more: false,
			clipped: false
		});
	});
	it('keeps a blank line and a quoted empty record as rows of one empty value', () => {
		expect(parseCsvRows('x\n1\n\n""\n3\n', 10).rows).toEqual([['x'], ['1'], [''], [''], ['3']]);
		expect(parseCsvRows('', 10).rows).toEqual([]);
	});
	it('keeps a stray quote and a last line without its newline', () => {
		expect(parseCsvRows('5" pipe,"open', 10).rows).toEqual([['5" pipe', 'open']]);
		expect(parseCsvRows('"a"b"c",d', 10).rows).toEqual([['ab"c"', 'd']]);
	});
	it('stops after maxRows and says more followed', () => {
		expect(parseCsvRows('1\n2\n3\n4\n', 2)).toMatchObject({ rows: [['1'], ['2']], more: true });
		expect(parseCsvRows('1\n2', 2)).toMatchObject({ rows: [['1'], ['2']], more: false });
		expect(parseCsvRows('1\n2\n3', 2)).toMatchObject({ rows: [['1'], ['2']], more: true });
	});
	it('caps the fields in a record and the characters in a field, and says so', () => {
		const wide = parseCsvRows(`${','.repeat(100_000)}\nabcdef,"ghijkl"`, 10, { maxCols: 3, maxCell: 4 });
		expect(wide).toEqual({
			rows: [
				['', '', ''],
				['abcd', 'ghij']
			],
			more: false,
			clipped: true
		});
		expect(parseCsvRows('ab,cd', 10, { maxCols: 2, maxCell: 2 }).clipped).toBe(false);
	});
});
