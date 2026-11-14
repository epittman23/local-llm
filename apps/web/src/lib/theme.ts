// The theme picker's apply step (Settings/General.svelte's applyTheme), for
// this app's class-based tokens: `dark` for dark and OLED dark, plus `oled`
// (pure black surfaces, see styles/global.css) for OLED; "system" follows the
// OS. The choice lives in localStorage.theme, which Base.astro reads before
// first paint.

export const THEMES = [
	{ id: 'system', label: '⚙️ System' },
	{ id: 'dark', label: '🌑 Dark' },
	{ id: 'oled-dark', label: '🌃 OLED Dark' },
	{ id: 'light', label: '☀️ Light' }
] as const;

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
