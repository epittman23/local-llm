import { describe, expect, it } from 'vitest';
import { csvCell } from './csv';
import { parseCsvTable, stringifyCsvTable } from './csvTable';

const table = (text: string) => {
	const parsed = parseCsvTable(text);
	if (!('table' in parsed)) throw new Error(`not faithful: ${parsed.notFaithful}`);
	return parsed.table;
};

describe('parseCsvTable', () => {
	it('reads quoted commas, quotes and newlines', () => {
		expect(table('a,b\n"x, y","say ""hi"""\n"two\nlines",z\n').rows).toEqual([
			['a', 'b'],
			['x, y', 'say "hi"'],
			['two\nlines', 'z']
		]);
	});

	it('keeps the BOM, the line ending and the final newline', () => {
		expect(table('\uFEFFa,b\r\n1,2\r\n')).toMatchObject({ bom: true, eol: '\r\n', trailingNewline: true });
		expect(table('a,b\n1,2')).toMatchObject({ bom: false, eol: '\n', trailingNewline: false });
		// A newline inside a quoted cell is not the file's line ending.
		expect(table('a\r\n"x\ny"\r\n').eol).toBe('\r\n');
	});

	it('pads ragged rows and says so', () => {
		const ragged = table('a,b,c\n1\n1,2,3,4\n');
		expect(ragged.rows).toEqual([
			['a', 'b', 'c', ''],
			['1', '', '', ''],
			['1', '2', '3', '4']
		]);
		expect(ragged.ragged).toBe(true);
		expect(table('a,b\n1,2\n').ragged).toBe(false);
	});

	it('reads an empty file, a header only, and a column with blank lines', () => {
		expect(table('').rows).toEqual([]);
		expect(table('a,b,c').rows).toEqual([['a', 'b', 'c']]);
		expect(table('a\n\nb\n').rows).toEqual([['a'], [''], ['b']]);
	});

	it('is not faithful past 500 rows, 50 columns or a 1,000-character cell', () => {
		const rows = (n: number) => Array.from({ length: n }, (_, i) => `${i},x`).join('\n');
		expect(parseCsvTable(rows(500))).toHaveProperty('table');
		expect(parseCsvTable(rows(501))).toEqual({ notFaithful: 'size' });
		expect(parseCsvTable(Array(50).fill('c').join(','))).toHaveProperty('table');
		expect(parseCsvTable(Array(51).fill('c').join(','))).toEqual({ notFaithful: 'size' });
		expect(parseCsvTable(`a,${'x'.repeat(1000)}`)).toHaveProperty('table');
		expect(parseCsvTable(`a,${'x'.repeat(1001)}`)).toEqual({ notFaithful: 'size' });
	});

	it('is not faithful for a semicolon or tab file, which has no comma to split on', () => {
		expect(parseCsvTable('a;b;c\n1;2;3\n')).toEqual({ notFaithful: 'delimiter' });
		expect(parseCsvTable('a\tb\n1\t2\n')).toEqual({ notFaithful: 'delimiter' });
		expect(parseCsvTable('a;b,c\n1,2\n')).toHaveProperty('table');
	});

	it('is not faithful when the line endings are mixed or a bare CR', () => {
		expect(parseCsvTable('a,b\r\n1,2\n3,4\n')).toEqual({ notFaithful: 'roundtrip' });
		expect(parseCsvTable('a,b\r1,2\r')).toEqual({ notFaithful: 'roundtrip' });
	});
});

describe('stringifyCsvTable', () => {
	const write = (rows: string[][], over = {}) =>
		stringifyCsvTable({ rows, eol: '\n', trailingNewline: true, bom: false, ...over });

	it('quotes by RFC 4180: comma, quote, CR, LF, a leading or trailing space', () => {
		expect(write([['a,b', 'say "hi"', 'x\ny', 'x\ry', ' lead', 'trail ', 'plain']])).toBe(
			'"a,b","say ""hi""","x\ny","x\ry"," lead","trail ",plain\n'
		);
	});

	it('writes a cell that starts like a formula or a negative number exactly as typed', () => {
		const cells = ['=SUM(A1:A3)', '-5', '+1', '@mention', '-1,234.5'];
		const text = write([cells]);
		expect(text).toBe('=SUM(A1:A3),-5,+1,@mention,"-1,234.5"\n');
		expect(table(text).rows).toEqual([cells]);
		// csvCell is for a report opened in a spreadsheet and would change the data: it must never write here.
		expect(csvCell('=SUM(A1:A3)')).not.toBe('=SUM(A1:A3)');
	});

	it('writes the line ending, final newline and BOM it was given', () => {
		const rows = [['a', 'b']];
		expect(write(rows, { eol: '\r\n' })).toBe('a,b\r\n');
		expect(write(rows, { trailingNewline: false })).toBe('a,b');
		expect(write(rows, { bom: true })).toBe('\uFEFFa,b\n');
		expect(write([])).toBe('');
	});

	it('keeps a blank last row of a one-column table from vanishing', () => {
		expect(write([[''], ['']], { trailingNewline: false })).toBe('\n""');
		expect(write([['']], { trailingNewline: false })).toBe('""');
		expect(write([['a'], ['']], { trailingNewline: true })).toBe('a\n\n');
	});
});

const FIXTURES = [
	'',
	'\n',
	'a',
	'a,b,c',
	'a,b\n1,2\n',
	'a,b\r\n1,2\r\n',
	'\uFEFFa,b\r\n1,2',
	'a,b\n"x, y","say ""hi"""\n',
	'"two\nlines",z\n',
	'"a\r\nb",c\r\n1,2\r\n',
	'a\n\nb\n',
	'a\n\n',
	'a,b,c\n1\n1,2,3,4\n',
	'a, b ,c\n x,y \n',
	'"a",b\n"1","2"\n',
	'=SUM(A1:A3),-5\n+1,@x\n',
	'a,b\n,\n,,\n',
	'x,"""",y\n',
	'name,note\nAda,"likes ""quotes"", commas, and\nnewlines"\n',
	'n\n1\n2\n3'
];

describe('round trip', () => {
	for (const text of FIXTURES)
		it(`parse(stringify(parse(x))) is parse(x) for ${JSON.stringify(text)}`, () => {
			const first = table(text);
			const second = table(stringifyCsvTable(first));
			expect(second.rows).toEqual(first.rows);
			expect(second).toMatchObject({ eol: first.eol, trailingNewline: first.trailingNewline, bom: first.bom });
		});

	it('writes a file that is already canonical byte for byte', () => {
		for (const text of ['a,b\n1,2\n', 'a,b\r\n"x\r\ny",2\r\n', '\uFEFFa,b\n=1+1,-5', 'a\n\n', 'a,b\n"say ""hi"""," z"'])
			expect(stringifyCsvTable(table(text))).toBe(text);
	});

	it('writes edited tables so that they read back the same', () => {
		const cases: string[][][] = [
			[['']],
			[[''], ['']],
			[['a'], ['']],
			[
				['a', ''],
				['', '']
			],
			[['"', ',', '\n', ' ']],
			[['=1'], ['-x'], ['@']]
		];
		for (const rows of cases)
			for (const trailingNewline of [true, false])
				for (const eol of ['\n', '\r\n'] as const) {
					const text = stringifyCsvTable({ rows, eol, trailingNewline, bom: false });
					expect(table(text).rows, JSON.stringify({ rows, trailingNewline, eol })).toEqual(rows);
				}
	});
});
