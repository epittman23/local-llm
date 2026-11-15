import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	applyTheme,
	DEFAULT_THEME,
	getTheme,
	installSystemThemeListener,
	isThemeId,
	subscribeTheme,
	THEMES,
	themeClasses
} from './theme';

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

describe('installSystemThemeListener', () => {
	/** A matchMedia stand-in whose OS preference the test can flip. */
	function fakeOs(prefersDark: boolean) {
		const listeners = new Set<() => void>();
		const query = {
			get matches() {
				return prefersDark;
			},
			addEventListener: vi.fn((_: string, fn: () => void) => listeners.add(fn)),
			removeEventListener: vi.fn((_: string, fn: () => void) => listeners.delete(fn))
		};
		vi.stubGlobal(
			'matchMedia',
			vi.fn(() => query)
		);
		return {
			query,
			listeners,
			flip(dark: boolean) {
				prefersDark = dark;
				for (const fn of listeners) fn();
			}
		};
	}

	afterEach(() => {
		vi.unstubAllGlobals();
		localStorage.removeItem('theme');
		document.documentElement.className = '';
	});

	it('follows the OS without a reload while the theme is System (COL-6)', () => {
		const os = fakeOs(true);
		applyTheme('system');
		expect(document.documentElement.classList.contains('dark')).toBe(true);
		const remove = installSystemThemeListener();
		os.flip(false);
		expect(document.documentElement.classList.contains('light')).toBe(true);
		expect(document.documentElement.classList.contains('dark')).toBe(false);
		os.flip(true);
		expect(document.documentElement.classList.contains('dark')).toBe(true);
		remove();
		expect(os.listeners.size).toBe(0);
	});

	it('leaves a chosen theme alone when the OS changes', () => {
		const os = fakeOs(true);
		applyTheme('dark');
		const remove = installSystemThemeListener();
		os.flip(false);
		expect(document.documentElement.className).toBe('dark');
		remove();
	});

	it('installs one listener however many times it is asked', () => {
		const os = fakeOs(false);
		const remove = installSystemThemeListener();
		const again = installSystemThemeListener();
		expect(os.query.addEventListener).toHaveBeenCalledTimes(1);
		again();
		expect(os.listeners.size).toBe(1);
		remove();
		expect(os.listeners.size).toBe(0);
	});
});

describe('THEMES (#1089, WRD-6)', () => {
	it('names the four themes in words, Black stored as oled-dark', () => {
		expect(THEMES.map((t) => [t.id, t.label])).toEqual([
			['system', 'System'],
			['dark', 'Dark'],
			['oled-dark', 'Black'],
			['light', 'Light']
		]);
		for (const t of THEMES) expect(t.label).toMatch(/^[A-Za-z]+$/);
	});
	it('gives each theme a line icon, and knows its ids from anything else', () => {
		for (const t of THEMES) expect(t.icon).toBeTruthy();
		expect(isThemeId('oled-dark')).toBe(true);
		expect(isThemeId('her')).toBe(false);
		expect(isThemeId(undefined)).toBe(false);
	});
});

describe('subscribeTheme', () => {
	it('calls a listener after every applyTheme until it unsubscribes', () => {
		const listener = vi.fn();
		const stop = subscribeTheme(listener);
		applyTheme('light');
		expect(listener).toHaveBeenCalledTimes(1);
		stop();
		applyTheme('dark');
		expect(listener).toHaveBeenCalledTimes(1);
		localStorage.removeItem('theme');
	});
});
