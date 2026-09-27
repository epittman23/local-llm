import type { SessionUser } from '@/lib/stores/authStore';

// The chat permissions ResponseMessage/UserMessage.svelte check, each with the
// default the Svelte code uses when the permission is not set. Admins may do
// everything.

const DEFAULTS = {
	edit: true,
	tts: true,
	rate_response: true,
	continue_response: true,
	regenerate_response: true,
	/** Deleting a reply. */
	delete_message: true,
	/** Deleting a prompt defaults to off (UserMessage.svelte reads `?? false`). */
	delete_user_message: false,
	temporary: false,
	multiple_models: true
} as const;

export type ChatPermission = keyof typeof DEFAULTS;

export function canChat(user: SessionUser | null | undefined, key: ChatPermission): boolean {
	if (!user) return false;
	if (user.role === 'admin') return true;
	const chat = (user.permissions as { chat?: Record<string, boolean | undefined> } | undefined)?.chat ?? {};
	const name = key === 'delete_user_message' ? 'delete_message' : key;
	return chat[name] ?? DEFAULTS[key];
}
