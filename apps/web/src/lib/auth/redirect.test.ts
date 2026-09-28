import { describe, expect, it } from 'vitest';
import { safeRedirect } from './redirect';

describe('safeRedirect', () => {
	it('keeps a path on this app', () => {
		expect(safeRedirect('/notes')).toBe('/notes');
		expect(safeRedirect('/c/abc?x=1#m')).toBe('/c/abc?x=1#m');
	});
	it('drops anything that would leave the app', () => {
		for (const t of ['https://evil.example/', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', 'notes', '', null, undefined]) expect(safeRedirect(t)).toBeNull();
	});
});
