import { describe, expect, it } from 'vitest';
import { applyTheme, DEFAULT_THEME, getTheme, themeClasses } from './theme';

describe('themeClasses', () => {
	it('maps each theme to its classes, following the OS for system', () => {
		expect(themeClasses('oled-dark', false)).toEqual(['dark', 'oled']);
		expect(themeClasses('dark', false)).toEqual(['dark']);
		expect(themeClasses('light', true)).toEqual(['light']);
		expect(themeClasses('system', true)).toEqual(['dark']);
		expect(themeClasses('system', false)).toEqual(['light']);
	});

	it('is dark for a browser that has never chosen a theme', () => {
		localStorage.removeItem('theme');
		expect(DEFAULT_THEME).toBe('dark');
		expect(getTheme()).toBe('dark');
		localStorage.setItem('theme', 'light');
		expect(getTheme()).toBe('light');
		localStorage.removeItem('theme');
	});

	it('falls back to dark when storage cannot be read', () => {
		const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			get() {
				throw new Error('blocked');
			}
		});
		try {
			expect(getTheme()).toBe('dark');
		} finally {
			if (descriptor) Object.defineProperty(window, 'localStorage', descriptor);
		}
	});

	it('keeps the theme-color tag at the page colour of the applied theme', () => {
		const meta = document.createElement('meta');
		meta.name = 'theme-color';
		document.head.append(meta);
		applyTheme('dark');
		expect(meta.content).toBe('#121916');
		applyTheme('oled-dark');
		expect(meta.content).toBe('#000000');
		applyTheme('light');
		expect(meta.content).toBe('#f8f7f2');
		meta.remove();
		localStorage.removeItem('theme');
		document.documentElement.className = '';
	});
});
