import { describe, expect, it } from 'vitest';
import { parseUserCsv } from './userCsv';

describe('parseUserCsv', () => {
	it('skips the header and keeps four-column rows with a known role', () => {
		const { validRows, invalidRows } = parseUserCsv('Name,Email,Password,Role\nAda,a@x.io,pw,User\nBob,b@x.io,pw,admin');
		expect(validRows.map((r) => r.columns[0])).toEqual(['Ada', 'Bob']);
		expect(invalidRows).toEqual([]);
	});
	it('rejects wrong column counts and unknown roles, reporting their row index', () => {
		const { validRows, invalidRows } = parseUserCsv('h\nAda,a@x.io,pw\nBob,b@x.io,pw,root\nCy,c@x.io,pw,pending');
		expect(validRows).toHaveLength(1);
		expect(invalidRows).toEqual([1, 2]);
	});
	it('ignores blank lines, including the trailing newline', () => {
		const { validRows, invalidRows } = parseUserCsv('h\nAda,a@x.io,pw,user\n\n');
		expect(validRows).toHaveLength(1);
		expect(invalidRows).toEqual([]);
	});
});
