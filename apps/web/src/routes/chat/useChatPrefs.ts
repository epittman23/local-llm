import { useMemo } from 'react';
import { chatPrefs } from '@/lib/chat/prefs';
import { useUserSettings } from '@/lib/settings/userSettings';

/** The user's chat display settings (lib/chat/prefs.ts), with their defaults until settings load. */
export function useChatPrefs() {
	const { settings } = useUserSettings();
	return useMemo(() => chatPrefs(settings as Record<string, unknown> | null), [settings]);
}
