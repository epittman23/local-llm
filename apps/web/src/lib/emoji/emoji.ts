import { useQuery } from '@tanstack/react-query';

// Reactions are stored by shortcode (`thumbsup`), the name the Svelte
// EmojiPicker submits: the first shortcode listed for an emoji in
// lib/emoji-shortcodes.json, whose keys are code points (`1F44D`,
// `263A-FE0F`). The Svelte app drew each one as an SVG from the backend's
// /assets/emojis; this app renders the native character instead, so it needs
// no asset route. The two JSON files (~170 kB) are loaded on first use only.

export type EmojiIndex = {
	/** shortcode -> the emoji's characters */
	byName: Record<string, string>;
	/** Every emoji in picker order: its characters, the shortcode it submits, all its shortcodes (for search), and its group. */
	all: { char: string; name: string; names: string[]; group: string }[];
	groups: string[];
};

/** `1F44D` or `263A-FE0F` -> the characters. */
export const codeToChar = (code: string) => String.fromCodePoint(...code.split('-').map((h) => parseInt(h, 16)));

export function buildEmojiIndex(shortCodes: Record<string, string | string[]>, groups: Record<string, string[]>): EmojiIndex {
	const byName: Record<string, string> = {};
	const namesByCode: Record<string, string[]> = {};
	for (const [code, value] of Object.entries(shortCodes)) {
		const names = typeof value === 'string' ? [value] : value;
		namesByCode[code] = names;
		for (const n of names) byName[n] = codeToChar(code);
	}
	const all: EmojiIndex['all'] = [];
	for (const [group, codes] of Object.entries(groups)) {
		for (const code of codes) {
			const names = namesByCode[code];
			if (names?.length) all.push({ char: codeToChar(code), name: names[0], names, group });
		}
	}
	return { byName, all, groups: Object.keys(groups) };
}

/** Emojis whose shortcodes contain `search` (all of them for an empty search). */
export function searchEmojis(index: EmojiIndex, search: string) {
	const q = search.trim().toLowerCase();
	return q ? index.all.filter((e) => e.names.some((n) => n.includes(q))) : index.all;
}

export function useEmojiIndex() {
	return useQuery({
		queryKey: ['emoji-index'],
		staleTime: Infinity,
		gcTime: Infinity,
		queryFn: async () => {
			const [codes, groups] = await Promise.all([import('./emoji-shortcodes.json'), import('./emoji-groups.json')]);
			return buildEmojiIndex(codes.default as Record<string, string | string[]>, groups.default as Record<string, string[]>);
		}
	}).data;
}
