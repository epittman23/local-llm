// The theme picker's apply step (Settings/General.svelte's applyTheme), for
// this app's class-based tokens: `dark` for dark and black, plus `oled`
// (pure black surfaces, see styles/standard.css) for black; "system" follows
// the OS. The choice lives in localStorage.theme, which Base.astro reads
// before first paint.

/**
 * The four themes, named in words (WRD-6, #1089): "Black" is the standard's
 * own name for pure black surfaces, stored as `oled-dark` as it always was.
 */
export const THEMES = [
	{ id: 'system', label: 'System' },
	{ id: 'dark', label: 'Dark' },
	{ id: 'oled-dark', label: 'Black' },
	{ id: 'light', label: 'Light' }
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

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
