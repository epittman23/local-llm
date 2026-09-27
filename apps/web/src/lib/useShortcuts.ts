import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { getUserSettings } from '@/lib/apis/users';
import { type KeybindingsMap, Shortcut, matchKeybinding, resolveKeybindings } from '@/lib/shortcuts';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useAuthStore } from '@/lib/stores/authStore';
import { useSettingsModalStore } from '@/lib/stores/settingsModalStore';
import { useUIStore } from '@/lib/stores/uiStore';

export const KEYBINDINGS_KEY = ['user-keybindings'] as const;

/** The user's shortcut bindings (saved at the top level of their settings, beside `ui`). */
export function useKeybindings(): KeybindingsMap {
	const token = useAuthStore((s) => s.token) ?? '';
	const q = useQuery({ queryKey: KEYBINDINGS_KEY, enabled: Boolean(token), staleTime: Infinity, queryFn: async () => ((await getUserSettings(token, true).catch(() => null)) as { keybindings?: Record<string, string> } | null)?.keybindings ?? null });
	return resolveKeybindings(q.data);
}

/** Shortcuts this app acts on; the Keyboard tab lists these. */
export const SUPPORTED_SHORTCUTS = new Set<Shortcut>([
	Shortcut.NEW_CHAT,
	Shortcut.NEW_TEMPORARY_CHAT,
	Shortcut.DELETE_CHAT,
	Shortcut.OPEN_MODEL_SELECTOR,
	Shortcut.NAVIGATE_CHAT_UP,
	Shortcut.NAVIGATE_CHAT_DOWN,
	Shortcut.SEARCH,
	Shortcut.OPEN_SETTINGS,
	Shortcut.SHOW_SHORTCUTS,
	Shortcut.TOGGLE_SIDEBAR,
	Shortcut.TOGGLE_CONTROLS,
	Shortcut.CLOSE_MODAL,
	Shortcut.FOCUS_INPUT,
	Shortcut.REGENERATE_RESPONSE,
	Shortcut.ALLOW_TOOL_CALL,
	Shortcut.DENY_TOOL_CALL,
	Shortcut.COPY_LAST_CODE_BLOCK,
	Shortcut.COPY_LAST_RESPONSE,
	Shortcut.ACCEPT_AUTOCOMPLETE,
	Shortcut.ATTACH_FILE,
	Shortcut.ADD_PROMPT,
	Shortcut.TALK_TO_MODEL
]);

const lastEnabled = (selector: string) => [...document.querySelectorAll<HTMLButtonElement>(selector)].reverse().find((b) => !b.disabled);

/**
 * Ports (app)/+layout.svelte's keyboard handler: each configurable shortcut
 * (as the user bound it) triggers the same control a click would, unless the
 * user turned keyboard shortcuts off. Not ported: Generate Message Pair and
 * Toggle Dictation (their features are not in this app).
 */
export function useShortcuts() {
	const navigate = useNavigate();
	const bindings = useKeybindings();
	const { settings } = useUserSettings();
	const enabled = (settings as { keyboardShortcuts?: boolean } | null)?.keyboardShortcuts !== false;

	useEffect(() => {
		if (!enabled) return;
		const onKey = (event: KeyboardEvent) => {
			const shortcut = matchKeybinding(event, bindings);
			if (!shortcut) return;
			const ui = useUIStore.getState();
			const modal = useSettingsModalStore.getState();
			const click = (selector: string) => {
				const el = lastEnabled(selector);
				if (!el) return false;
				event.preventDefault();
				el.click();
				return true;
			};
			switch (shortcut) {
				case Shortcut.SEARCH:
					event.preventDefault();
					ui.setSearchOpen(!ui.searchOpen);
					break;
				case Shortcut.NEW_CHAT:
					event.preventDefault();
					navigate('/');
					break;
				case Shortcut.NEW_TEMPORARY_CHAT:
					event.preventDefault();
					navigate('/?temporary-chat=true');
					break;
				case Shortcut.FOCUS_INPUT:
					event.preventDefault();
					document.getElementById('chat-input')?.focus();
					break;
				case Shortcut.COPY_LAST_CODE_BLOCK:
					click('.copy-code-button');
					break;
				case Shortcut.COPY_LAST_RESPONSE:
					click('.copy-response-button');
					break;
				case Shortcut.TOGGLE_SIDEBAR:
					event.preventDefault();
					ui.toggleSidebar();
					break;
				case Shortcut.TOGGLE_CONTROLS:
					event.preventDefault();
					ui.setControlsOpen(!ui.controlsOpen);
					break;
				case Shortcut.NAVIGATE_CHAT_UP:
				case Shortcut.NAVIGATE_CHAT_DOWN: {
					const links = [...document.querySelectorAll<HTMLAnchorElement>('a[data-chat-link]')];
					if (!links.length) break;
					event.preventDefault();
					const i = links.findIndex((a) => a.getAttribute('aria-current') === 'page');
					const next = links[Math.max(0, Math.min(links.length - 1, i + (shortcut === Shortcut.NAVIGATE_CHAT_UP ? -1 : 1)))];
					next?.click();
					break;
				}
				case Shortcut.DELETE_CHAT:
					click('#delete-chat-button');
					break;
				case Shortcut.OPEN_SETTINGS:
					event.preventDefault();
					if (modal.open) modal.closeSettings();
					else modal.openSettings();
					break;
				case Shortcut.SHOW_SHORTCUTS:
					event.preventDefault();
					modal.openSettings('shortcuts');
					break;
				case Shortcut.CLOSE_MODAL:
					if (modal.open) modal.closeSettings();
					break;
				case Shortcut.OPEN_MODEL_SELECTOR:
					click('#model-selector-model-button');
					break;
				case Shortcut.ALLOW_TOOL_CALL:
					click('.tool-call-allow-button');
					break;
				case Shortcut.DENY_TOOL_CALL:
					click('.tool-call-deny-button');
					break;
				case Shortcut.REGENERATE_RESPONSE:
					if (document.activeElement?.id === 'chat-input') click('.regenerate-response-button');
					break;
				default:
					break;
			}
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, [enabled, bindings, navigate]);
}
