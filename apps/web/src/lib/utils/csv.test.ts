import { describe, expect, it } from 'vitest';
import { csvCell, neutralizeFormula } from './csv';

describe('neutralizeFormula', () => {
	it.each(['=1+1', '+cmd|" /c calc"!A1', '-2+3', '@SUM(A1)', '\t=1', '\r=1'])('prefixes %j so a spreadsheet reads it as text', (s) => {
		expect(neutralizeFormula(s)).toBe(`'${s}`);
	});
	it('leaves ordinary text and plain numbers alone', () => {
		for (const s of ['hello', 'a=b', '1+1', '-1', '0', '12.5', '-3.75', '']) expect(neutralizeFormula(s)).toBe(s);
	});
});

describe('csvCell', () => {
	it('writes nullish as empty and numbers as they are (including negatives)', () => {
		expect([csvCell(null), csvCell(undefined), csvCell(42), csvCell(-1), csvCell(0)]).toEqual(['', '', '42', '-1', '0']);
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
