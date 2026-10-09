import { describe, expect, it } from 'vitest';
import { citationIndex, citationsOf, sourceIdsOf, stripCitations } from './sources';

const sources = [
	{
		source: { name: 'web_search' },
		document: ['a', 'b', 'c'],
		metadata: [{ source: 'https://x.com/1' }, { source: 'https://x.com/1' }, { source: 'https://y.org/2' }],
		distances: [0.9, 0.8, 0.5]
	},
	{
		source: { name: 'Handbook', id: 'f1' },
		document: ['d'],
		metadata: [{ source: 'f1', name: 'handbook.pdf', page: 2 }]
	}
];

describe('citations', () => {
	it('groups documents by source, in first-seen order', () => {
		const c = citationsOf(sources);
		expect(c.map((x) => [x.id, x.source.name, x.document.length])).toEqual([
			['https://x.com/1', 'https://x.com/1', 2],
			['https://y.org/2', 'https://y.org/2', 1],
			['f1', 'handbook.pdf', 1]
		]);
		expect(c[0].distances).toEqual([0.9, 0.8]);
	});
	it('labels inline chips and dedupes', () => {
		expect(sourceIdsOf(sources)).toEqual(['https://x.com/1', 'https://y.org/2', 'handbook.pdf']);
		expect(sourceIdsOf(sources, false)).toEqual(['N/A']);
	});
	it('strips markers outside code and reads citation ids', () => {
		expect(stripCitations('It is so [1][2]. `[3]`')).toBe('It is so. `[3]`');
		expect(citationIndex('2#chunk')).toBe(1);
		expect(citationIndex(1)).toBe(0);
	});
});
