/**
 * The letters that stand in for a picture: the first letter of the first and
 * the last word of a name ("Ada Lovelace" -> "AL", "qwen3-coder" -> "Q"),
 * upper-cased, and "?" for a blank name. A one-word name with a slash (a model
 * id with its provider) takes the first two runs of letters after the last
 * slash instead, so models of one provider differ
 * ("qwen/qwen-2.5-coder-32b-instruct" -> "QC", "qwen/qwen3.6-27b" -> "QB",
 * #990). Shared by the avatar's fallback (components/ui/avatar.tsx) and a new
 * user's generated picture (lib/utils/auth-helpers.ts), so both show the same
 * letters.
 */
export function initials(name: string | null | undefined): string {
	const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return '?';
	if (words.length === 1 && words[0].includes('/')) {
		const parts = words[0].slice(words[0].lastIndexOf('/') + 1).match(/\p{L}+/gu);
		if (parts)
			return parts
				.slice(0, 2)
				.map((p) => Array.from(p)[0])
				.join('')
				.toUpperCase();
	}
	const first = Array.from(words[0])[0];
	const last = words.length > 1 ? Array.from(words[words.length - 1])[0] : '';
	return `${first}${last}`.toUpperCase();
}
