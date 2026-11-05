import { describe, expect, it } from 'vitest';
import { buildEmojiIndex, codeToChar, searchEmojis } from './emoji';

describe('emoji index', () => {
	const index = buildEmojiIndex(
		{ '1F44D': ['+1', 'thumbsup'], '263A-FE0F': 'relaxed', '1F600': 'grinning' },
		{ Smileys: ['1F600', '263A-FE0F', 'FFFFF'], People: ['1F44D'] }
	);

	it('turns code points into characters, including sequences', () => {
		expect(codeToChar('1F44D')).toBe('👍');
		expect(codeToChar('263A-FE0F')).toBe('☺️');
	});
	it('resolves every shortcode, and submits the first', () => {
		expect(index.byName.thumbsup).toBe('👍');
		expect(index.byName['+1']).toBe('👍');
		expect(index.all.find((e) => e.char === '👍')?.name).toBe('+1');
	});
	it('keeps group order and skips codes without a shortcode', () => {
		expect(index.all.map((e) => e.name)).toEqual(['grinning', 'relaxed', '+1']);
	});
	it('searches every shortcode', () => {
		expect(searchEmojis(index, 'thumb').map((e) => e.char)).toEqual(['👍']);
		expect(searchEmojis(index, '  ')).toHaveLength(3);
	});
});

describe('the emoji variation selector (#325)', () => {
	it('builds a character from the fully qualified form the groups list', () => {
		const index = buildEmojiIndex(
			{ '2764': 'heart', '1F441-200D-1F5E8': 'eye_speech_bubble', '1F600': 'grinning' },
			{ Smileys: ['1F600', '2764', '2764-FE0F', '1F441-FE0F-200D-1F5E8-FE0F'] }
		);

		expect(index.byName.heart).toBe('\u2764\uFE0F');
		expect(index.byName.eye_speech_bubble).toBe(codeToChar('1F441-FE0F-200D-1F5E8-FE0F'));
		expect(index.byName.grinning).toBe('😀');
		// Listed once in the picker, as the emoji.
		expect(index.all.filter((e) => e.name === 'heart').map((e) => e.char)).toEqual(['\u2764\uFE0F']);
	});

	it('gives every shortcode in the shipped data its emoji form', async () => {
		const codes = (await import('./emoji-shortcodes.json')).default as Record<string, string | string[]>;
		const groups = (await import('./emoji-groups.json')).default as Record<string, string[]>;
		const index = buildEmojiIndex(codes, groups);
		const listed = new Set(Object.values(groups).flat());
		// Every shortcode keyed by a bare code point whose fully qualified form the groups list.
		const bare = Object.entries(codes).filter(([code]) => listed.has(`${code}-FE0F`));

		expect(bare.length).toBeGreaterThan(200);
		for (const [code, value] of bare) {
			const name = typeof value === 'string' ? value : value[0];
			expect(index.byName[name], `${name} (${code})`).toBe(codeToChar(`${code}-FE0F`));
		}
		for (const name of ['heart', 'warning', 'v', 'point_up', 'heavy_check_mark']) {
			expect(index.byName[name]?.endsWith('\uFE0F'), name).toBe(true);
		}
	});
});
