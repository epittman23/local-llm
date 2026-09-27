import { describe, expect, it } from 'vitest';
import { themeClasses } from './theme';

describe('themeClasses', () => {
	it('maps each theme to its classes, following the OS for system', () => {
		expect(themeClasses('oled-dark', false)).toEqual(['dark', 'oled']);
		expect(themeClasses('dark', false)).toEqual(['dark']);
		expect(themeClasses('light', true)).toEqual(['light']);
		expect(themeClasses('system', true)).toEqual(['dark']);
		expect(themeClasses('system', false)).toEqual(['light']);
	});
});
