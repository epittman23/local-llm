import { describe, expect, it } from 'vitest';
import { pageWindow } from './PagePagination';

describe('pageWindow', () => {
	it('lists every page when there are seven or fewer', () => {
		expect(pageWindow(1, 1)).toEqual([1]);
		expect(pageWindow(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
	});

	it('keeps first, last and the current page +/- 1, with ellipses between', () => {
		expect(pageWindow(1, 20)).toEqual([1, 2, 'ellipsis-right', 20]);
		expect(pageWindow(10, 20)).toEqual([1, 'ellipsis-left', 9, 10, 11, 'ellipsis-right', 20]);
		expect(pageWindow(20, 20)).toEqual([1, 'ellipsis-left', 19, 20]);
	});

	it('does not put an ellipsis where the gap is a single page', () => {
		expect(pageWindow(3, 8)).toEqual([1, 2, 3, 4, 'ellipsis-right', 8]);
	});
});
