import { describe, expect, it } from 'vitest';
import { safeRedirect } from './redirect';

describe('safeRedirect', () => {
	it('keeps a path on this app', () => {
		expect(safeRedirect('/notes')).toBe('/notes');
		expect(safeRedirect('/c/abc?x=1#m')).toBe('/c/abc?x=1#m');
	});
	it('drops anything that would leave the app', () => {
		for (const t of [
			'https://evil.example/',
			'//evil.example/x',
			'/\\evil.example',
			'javascript:alert(1)',
			'notes',
			'',
			null,
			undefined
		])
			expect(safeRedirect(t)).toBeNull();
	});
});

describe('safeRedirect, resolved as the router resolves it (#206)', () => {
	it('drops a target that a tab, newline or backslash turns into another host', () => {
		for (const t of [
			'/\t/evil.example/x',
			'/\n/evil.example',
			'/\r\n/evil.example',
			'/\t\\evil.example',
			'/\\/evil.example',
			'//['
		])
			expect(safeRedirect(t), JSON.stringify(t)).toBeNull();
	});
	it('drops them the way a ?redirect= link delivers them, percent-decoded', () => {
		const fromLink = new URLSearchParams('redirect=%2F%09%2Fevil.example%2Fx').get('redirect');
		expect(fromLink).toBe('/\t/evil.example/x');
		expect(safeRedirect(fromLink)).toBeNull();
	});
	it('hands back the path the router will see', () => {
		expect(safeRedirect('/no\ttes?x=1')).toBe('/notes?x=1');
		expect(safeRedirect('/c/abc?x=1#m')).toBe('/c/abc?x=1#m');
		expect(safeRedirect('/a/../notes')).toBe('/notes');
	});
});
