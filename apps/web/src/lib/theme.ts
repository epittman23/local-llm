// The theme picker's apply step (Settings/General.svelte's applyTheme), for
// this app's class-based tokens: `dark` for dark and black, plus `oled`
// (pure black surfaces, see styles/standard.css) for black; "system" follows
// the OS. The choice lives in localStorage.theme, which Base.astro reads
// before first paint; it is also saved with the account (#1089,
// lib/settings/useThemeChoice.ts), and AppShell applies the account's
// choice when it differs from this browser's.

import { Circle, Monitor, Moon, Sun } from 'lucide-react';

/**
 * The four themes, named in words with a line icon each (WRD-6, #1089), as
 * Settings and the user menu offer them: "Black" is the standard's own name
 * for pure black surfaces, stored as `oled-dark` as it always was.
 */
export const THEMES = [
	{ id: 'system', label: 'System', icon: Monitor },
	{ id: 'dark', label: 'Dark', icon: Moon },
	{ id: 'oled-dark', label: 'Black', icon: Circle },
	{ id: 'light', label: 'Light', icon: Sun }
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

/** Whether `value` (a stored setting, say) names one of the four themes. */
export function isThemeId(value: unknown): value is ThemeId {
	return THEMES.some((t) => t.id === value);
}

const themeListeners = new Set<() => void>();

/** Calls `listener` after every applyTheme; the returned function stops it (for useSyncExternalStore). */
export function subscribeTheme(listener: () => void): () => void {
	themeListeners.add(listener);
	return () => {
		themeListeners.delete(listener);
	};
}

/**
 * The theme of a browser that has never chosen one. Dark, by the owner's
 * decision (2026-11-14): it is how the app is used, and it is what the
 * interface standard is checked in first. "System" is still offered; it is
 * no longer what you get without asking. layouts/Base.astro's inline script
 * repeats this value, since it runs before any module loads.
 */
export const DEFAULT_THEME = 'dark';

/** The classes a theme puts on <html>. */
export function themeClasses(theme: string, prefersDark: boolean): string[] {
	if (theme === 'oled-dark') return ['dark', 'oled'];
	if (theme === 'dark') return ['dark'];
	if (theme === 'light') return ['light'];
	return [prefersDark ? 'dark' : 'light'];
}

export function getTheme(): string {
	try {
		return localStorage.theme || DEFAULT_THEME;
	} catch {
		return DEFAULT_THEME;
	}
}

export function applyTheme(theme: string) {
	try {
		localStorage.theme = theme;
	} catch {
		/* storage unavailable: still apply for this page */
	}
	const root = document.documentElement;
	root.classList.remove('dark', 'light', 'oled', 'oled-dark');
	root.classList.add(...themeClasses(theme, window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false));
	document.querySelector('meta[name="theme-color"]')?.setAttribute(
		'content',
		// --page in each theme (styles/standard.css).
		root.classList.contains('oled') ? '#000000' : root.classList.contains('dark') ? '#121916' : '#f8f7f2'
	);
	for (const listener of themeListeners) listener();
}

let systemThemeListenerInstalled = false;

/**
 * Keeps "System" following the OS while the page is open (COL-6): one
 * `prefers-color-scheme` change listener re-applies the theme, but only while
 * the chosen theme is still "system". Installed once, by RootLayout; the
 * returned function removes it.
 */
export function installSystemThemeListener(): () => void {
	const query = typeof window === 'undefined' ? undefined : window.matchMedia?.('(prefers-color-scheme: dark)');
	if (!query || systemThemeListenerInstalled) return () => {};
	const onChange = () => {
		if (getTheme() === 'system') applyTheme('system');
	};
	query.addEventListener('change', onChange);
	systemThemeListenerInstalled = true;
	return () => {
		query.removeEventListener('change', onChange);
		systemThemeListenerInstalled = false;
	};
}
