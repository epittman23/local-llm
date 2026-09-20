import { describe, expect, it } from 'vitest';
import { feedbacksToCsv, ratingOutcome } from './feedbackCsv';

describe('feedbacksToCsv', () => {
	it('spreads data into columns and joins siblings with semicolons', () => {
		const csv = feedbacksToCsv([
			{ id: 'f1', user_id: 'u', created_at: 1, updated_at: 2, data: { chat_id: 'c', model_id: 'm', sibling_model_ids: ['x', 'y'], rating: 1, reason: 'r', comment: 'ok' } }
		]);
		expect(csv.split('\n')).toEqual([
			'id,user_id,chat_id,model_id,sibling_model_ids,rating,reason,comment,created_at,updated_at',
			'f1,u,c,m,x;y,1,r,ok,1,2'
		]);
	});
	it('quotes commas, quotes and newlines', () => {
		const csv = feedbacksToCsv([{ id: 'f', data: { comment: 'a, "b"\nc' } }]);
		expect(csv.split('\n').slice(1).join('\n')).toContain('"a, ""b""\nc"');
	});
	it('does not let user-written text run as a spreadsheet formula', () => {
		const csv = feedbacksToCsv([{ id: 'f', data: { comment: '=HYPERLINK("http://evil","x")', reason: '@SUM(1)', rating: -1 } }]);
		const row = csv.split('\n')[1];
		expect(row).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
		expect(row).toContain(`'@SUM(1)`);
		// A numeric rating of -1 stays a number.
		expect(row.split(',')).toContain('-1');
	});
	it('handles missing data, and no rows', () => {
		expect(feedbacksToCsv([{ id: 'f', data: null }]).split('\n')[1]).toBe('f,,,,,,,,,');
		expect(feedbacksToCsv([])).toBe('');
	});
});

describe('ratingOutcome', () => {
	it('reads numbers and strings, including a zero draw', () => {
		expect([ratingOutcome(1), ratingOutcome('1'), ratingOutcome(0), ratingOutcome('-1'), ratingOutcome(-1)]).toEqual(['won', 'won', 'draw', 'lost', 'lost']);
		expect([ratingOutcome(undefined), ratingOutcome(null), ratingOutcome(5)]).toEqual([null, null, null]);
	});
});
