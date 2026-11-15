import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { useUserSettings } from '@/lib/settings/userSettings';
import { applyTheme, DEFAULT_THEME, getTheme, subscribeTheme, type ThemeId } from '@/lib/theme';

/**
 * The theme in use and the way to choose one, for Settings and the user menu
 * (#1089). Choosing applies the theme at once, caches it in this browser
 * (localStorage, which Base.astro reads before first paint) and saves it as
 * `theme` in the account's `ui` settings, so the next load on another device
 * applies it too (AppShell). The value follows every applyTheme, wherever it
 * came from.
 */
export function useThemeChoice(): [string, (theme: ThemeId) => void] {
	const theme = useSyncExternalStore(subscribeTheme, getTheme, () => DEFAULT_THEME);
	const { update } = useUserSettings();
	const choose = (next: ThemeId) => {
		applyTheme(next);
		update({ theme: next }).catch(() =>
			toast.error('The theme changed in this browser only: it could not be saved to your account.')
		);
	};
	return [theme, choose];
}
