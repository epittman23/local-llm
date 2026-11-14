/**
 * The letters that stand in for a picture: the first letter of the first and
 * the last word of a name ("Ada Lovelace" -> "AL", "qwen3-coder" -> "Q"),
 * upper-cased, and "?" for a blank name. Shared by the avatar's fallback
 * (components/ui/avatar.tsx) and a new user's generated picture
 * (lib/utils/auth-helpers.ts), so both show the same letters.
 */
export function initials(name: string | null | undefined): string {
	const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return '?';
	const first = Array.from(words[0])[0];
	const last = words.length > 1 ? Array.from(words[words.length - 1])[0] : '';
	return `${first}${last}`.toUpperCase();
}
