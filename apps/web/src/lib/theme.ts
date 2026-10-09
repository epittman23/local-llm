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

/** The classes a theme puts on <html>. */
export function themeClasses(theme: string, prefersDark: boolean): string[] {
	if (theme === 'oled-dark') return ['dark', 'oled'];
	if (theme === 'dark') return ['dark'];
	if (theme === 'light') return ['light'];
	return [prefersDark ? 'dark' : 'light'];
}

export function getTheme(): string {
	try {
		return localStorage.theme || 'system';
	} catch {
		return 'system';
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
	document
		.querySelector('meta[name="theme-color"]')
		?.setAttribute(
			'content',
			root.classList.contains('oled') ? '#000000' : root.classList.contains('dark') ? '#171717' : '#ffffff'
		);
}
